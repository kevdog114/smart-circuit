import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

import type {
  CircuitDocument,
  ComponentDefinition,
  Component,
  PinDefinition,
  PinInstance,
  SymbolGraphic,
  Sheet,
  Wire,
  Net,
  PCBLayout,
  PCBComponent,
  PCBTrace,
  PCBVia,
  PCBLayer,
} from '../core/types';

import { createPCBLayout } from '../core/pcb-document';
import type { FootprintDefinition, PadDefinition } from '../library/easyeda-parser';

// Simple UUID generator
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

import { inflate } from 'pako';

function decompressGzip(base64Str: string): string {
  const b64 = base64Str.replace(/^base64/, '');
  const binaryString = atob(b64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const decompressed = inflate(bytes);
  return new TextDecoder().decode(decompressed);
}

// Parse NDJSON lines (each line is a JSON array)
function parseNDJSON(data: string): unknown[][] {
  const results: unknown[][] = [];
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    try {
      const node = JSON.parse(line);
      if (Array.isArray(node)) results.push(node);
    } catch(e) { /* skip non-JSON lines */ }
  }
  return results;
}

// Collect ATTRs by parent element ID
interface AttrEntry { key: string; value: string; x?: number; y?: number }

function collectAttrs(nodes: unknown[][]): Map<string, AttrEntry[]> {
  const map = new Map<string, AttrEntry[]>();
  for (const node of nodes) {
    if (node[0] !== 'ATTR') continue;
    // ["ATTR", id, parentId, key, value, vis1, vis2, x, y, rot, style, ...]
    const parentId = node[2] as string;
    const key = node[3] as string;
    const value = node[4];
    const x = typeof node[7] === 'number' ? node[7] : undefined;
    const y = typeof node[8] === 'number' ? node[8] : undefined;
    if (!map.has(parentId)) map.set(parentId, []);
    map.get(parentId)!.push({ key, value: String(value ?? ''), x, y });
  }
  return map;
}

// ─── EasyEDA Pro Footprint Layer ID → our PCBLayer ───
const FP_LAYER_MAP: Record<number, PCBLayer> = {
  1: 'F.Cu',
  2: 'B.Cu',
  3: 'F.SilkS',
  4: 'B.SilkS',
  11: 'Edge.Cuts',
  12: 'F.Cu',   // MULTI → default to F.Cu
};

// ─── Agent A: Parse Footprint Definitions (docType=4) ───

function parseProFootprints(db: any): Map<string, FootprintDefinition> {
  const fpMap = new Map<string, FootprintDefinition>();

  try {
    const res = db.exec("SELECT uuid, title, dataStr FROM components WHERE docType = 4");
    if (res.length === 0) return fpMap;

    for (const row of res[0].values) {
      const uuid = row[0] as string;
      const title = row[1] as string;
      const dataStr = row[2] as string;
      if (!dataStr || !dataStr.startsWith('base64')) continue;

      try {
        const decompressed = decompressGzip(dataStr);
        const nodes = parseNDJSON(decompressed);

        const pads: PadDefinition[] = [];
        const silkscreen: FootprintDefinition['silkscreen'] = [];

        // EasyEDA Pro footprint unit: 1 unit = 10 mils = 0.254 mm
        const UNIT_TO_MM = 0.254;

        for (const node of nodes) {
          if (!Array.isArray(node) || node.length === 0) continue;
          const type = node[0];

          if (type === 'PAD') {
            // ["PAD", id, 0, net, layerId, padNumber, x, y, rotation, null,
            //  [shape, width, height, ...], holes, holeW, holeH, padRotation, plated, ...]
            const padNumber = String(node[5] ?? '');
            const px = (typeof node[6] === 'number' ? node[6] : 0) * UNIT_TO_MM;
            const py = (typeof node[7] === 'number' ? node[7] : 0) * UNIT_TO_MM;
            const layerId = typeof node[4] === 'number' ? node[4] : 1;
            const padRotation = typeof node[8] === 'number' ? node[8] : 0;

            // Shape info is in the array at index 10
            const shapeArr = Array.isArray(node[10]) ? node[10] : [];
            const shapeType = typeof shapeArr[0] === 'string' ? shapeArr[0] : 'RECT';
            const shapeW = (typeof shapeArr[1] === 'number' ? shapeArr[1] : 10) * UNIT_TO_MM;
            const shapeH = (typeof shapeArr[2] === 'number' ? shapeArr[2] : shapeArr[1] ?? 10) * UNIT_TO_MM;

            // Drill info — holeW at index 12, holeH at index 13
            const holeW = typeof node[12] === 'number' ? Math.abs(node[12]) * UNIT_TO_MM : 0;

            let shape: 'rect' | 'circle' | 'oval' = 'rect';
            if (shapeType === 'ELLIPSE' || shapeType === 'CIRCLE') shape = 'circle';
            else if (shapeType === 'OVAL') shape = 'oval';
            else if (shapeType === 'RECT') shape = 'rect';

            const layer = FP_LAYER_MAP[layerId] ?? 'F.Cu';

            pads.push({
              id: `pad_${padNumber}`,
              pinId: padNumber,
              x: px,
              y: py,
              width: shapeW,
              height: shapeH,
              shape,
              layer: layer as any,
              drill: holeW * 2, // diameter
              rotation: padRotation,
            });
          } else if (type === 'POLY') {
            // ["POLY", id, 0, net, layerId, strokeWidth, [points...], flags]
            const layerId = typeof node[4] === 'number' ? node[4] : 0;
            const layer = FP_LAYER_MAP[layerId];
            if (layer !== 'F.SilkS' && layer !== 'B.SilkS') continue;

            const strokeWidth = (typeof node[5] === 'number' ? node[5] : 1) * UNIT_TO_MM;
            const rawPts = node[6];
            if (!Array.isArray(rawPts)) continue;

            // rawPts can be [x1,y1,x2,y2,...] or [{"CIRCLE",...}] — skip non-numeric
            const points: { x: number; y: number }[] = [];
            const nums = rawPts.filter((v: unknown) => typeof v === 'number') as number[];
            for (let i = 0; i < nums.length - 1; i += 2) {
              points.push({ x: nums[i] * UNIT_TO_MM, y: nums[i + 1] * UNIT_TO_MM });
            }
            if (points.length >= 2) {
              silkscreen.push({ type: 'line', points, layer: layer as any, strokeWidth });
            }
          }
        }

        if (pads.length === 0) continue;

        // Compute courtyard bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pad of pads) {
          const hw = pad.width / 2;
          const hh = pad.height / 2;
          minX = Math.min(minX, pad.x - hw);
          minY = Math.min(minY, pad.y - hh);
          maxX = Math.max(maxX, pad.x + hw);
          maxY = Math.max(maxY, pad.y + hh);
        }
        const margin = 0.25;

        fpMap.set(uuid, {
          id: `fp_pro_${uuid}`,
          name: title,
          packageUuid: uuid,
          pads,
          courtyard: {
            x: minX - margin,
            y: minY - margin,
            width: (maxX - minX) + 2 * margin,
            height: (maxY - minY) + 2 * margin,
          },
          silkscreen,
        });
      } catch (e) {
        console.warn('Failed to parse footprint:', title, e);
      }
    }
  } catch (e) {
    console.warn('No footprint components found:', e);
  }

  return fpMap;
}

// ─── Agent B: Parse PCB Layout Document (docType=3) ───

// PCB ATTRs have a different structure than schematic ATTRs
interface PCBAttrEntry { key: string; value: string; x?: number; y?: number }

function collectPCBAttrs(nodes: unknown[][]): Map<string, PCBAttrEntry[]> {
  const map = new Map<string, PCBAttrEntry[]>();
  for (const node of nodes) {
    if (node[0] !== 'ATTR') continue;
    // ["ATTR", attrId, 0, parentId, 3, x, y, key, value, ...]
    const parentId = node[3] as string;
    const key = node[7] as string;
    const value = node[8];
    if (typeof key !== 'string') continue;
    const x = typeof node[5] === 'number' ? node[5] : undefined;
    const y = typeof node[6] === 'number' ? node[6] : undefined;
    if (!map.has(parentId)) map.set(parentId, []);
    map.get(parentId)!.push({ key, value: String(value ?? ''), x, y });
  }
  return map;
}

// PCB layer ID → our PCBLayer
const PCB_LAYER_MAP: Record<number, PCBLayer> = {
  1: 'F.Cu',
  2: 'B.Cu',
  3: 'F.SilkS',
  4: 'B.SilkS',
  11: 'Edge.Cuts',
};

// Mils → mm
const MILS_TO_MM = 0.0254;

function parseProPCBLayout(
  db: any,
  schematicDoc: CircuitDocument,
  footprintMap: Map<string, FootprintDefinition>
): PCBLayout | null {
  try {
    const res = db.exec("SELECT dataStr FROM documents WHERE docType = 3 LIMIT 1");
    if (res.length === 0 || res[0].values.length === 0) return null;

    const dataStr = res[0].values[0][0] as string;
    if (!dataStr || !dataStr.startsWith('base64')) return null;

    const decompressed = decompressGzip(dataStr);
    const nodes = parseNDJSON(decompressed);
    const pcbAttrs = collectPCBAttrs(nodes);

    // Build designator → schematic component lookup (across all sheets)
    const designatorToSchComp = new Map<string, Component>();
    for (const sheet of schematicDoc.sheets) {
      for (const comp of sheet.components) {
        if (comp.designator) {
          designatorToSchComp.set(comp.designator, comp);
        }
      }
    }

    // Build net name → net ID lookup
    const netNameToId = new Map<string, string>();
    for (const sheet of schematicDoc.sheets) {
      for (const net of sheet.nets) {
        if (net.name) netNameToId.set(net.name, net.id);
      }
    }

    const pcbComponents: PCBComponent[] = [];
    const traces: PCBTrace[] = [];
    const vias: PCBVia[] = [];

    // Track board bounds for sizing
    let boardMinX = Infinity, boardMinY = Infinity;
    let boardMaxX = -Infinity, boardMaxY = -Infinity;

    function expandBounds(x: number, y: number) {
      if (x < boardMinX) boardMinX = x;
      if (x > boardMaxX) boardMaxX = x;
      if (y < boardMinY) boardMinY = y;
      if (y > boardMaxY) boardMaxY = y;
    }

    for (const node of nodes) {
      if (!Array.isArray(node) || node.length === 0) continue;
      const type = node[0];

      if (type === 'COMPONENT') {
        // ["COMPONENT", elementId, 0, 1, x, y, rotation, {metadata}, 0]
        const elementId = node[1] as string;
        const xMils = typeof node[4] === 'number' ? node[4] : 0;
        const yMils = typeof node[5] === 'number' ? node[5] : 0;
        const rotation = typeof node[6] === 'number' ? node[6] : 0;

        const xMm = xMils * MILS_TO_MM;
        const yMm = yMils * MILS_TO_MM;

        // Get designator and footprint UUID from ATTRs
        const compAttrs = pcbAttrs.get(elementId) || [];
        const designatorAttr = compAttrs.find(a => a.key === 'Designator');
        const footprintAttr = compAttrs.find(a => a.key === 'Footprint');

        const designator = designatorAttr?.value || '';
        const footprintUuid = footprintAttr?.value || '';

        // Match to schematic component by designator
        const schComp = designator ? designatorToSchComp.get(designator) : undefined;

        // Determine footprint ID
        let fpId = '';
        if (footprintUuid && footprintMap.has(footprintUuid)) {
          fpId = `fp_pro_${footprintUuid}`;
        } else if (schComp) {
          fpId = schComp.libraryId; // fallback to library ID
        }

        pcbComponents.push({
          id: `pcb_${elementId}`,
          schematicComponentId: schComp?.id || elementId,
          footprintId: fpId,
          position: { x: xMm, y: yMm },
          rotation: rotation,
          layer: 'F.Cu',
          isPlaced: true,
        });

        expandBounds(xMm, yMm);

      } else if (type === 'LINE') {
        // ["LINE", id, 0, netName, layerId, x1, y1, x2, y2, width, 0]
        const lineId = node[1] as string;
        const netName = node[3] as string;
        const layerId = typeof node[4] === 'number' ? node[4] : 1;
        const x1 = (typeof node[5] === 'number' ? node[5] : 0) * MILS_TO_MM;
        const y1 = (typeof node[6] === 'number' ? node[6] : 0) * MILS_TO_MM;
        const x2 = (typeof node[7] === 'number' ? node[7] : 0) * MILS_TO_MM;
        const y2 = (typeof node[8] === 'number' ? node[8] : 0) * MILS_TO_MM;
        const width = (typeof node[9] === 'number' ? node[9] : 10) * MILS_TO_MM;

        const layer = PCB_LAYER_MAP[layerId];
        if (!layer || layer === 'Edge.Cuts') continue; // skip non-copper layers

        const netId = netName ? (netNameToId.get(netName) || netName) : '';

        traces.push({
          id: `trace_${lineId}`,
          netId,
          layer,
          width,
          points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
        });

        expandBounds(x1, y1);
        expandBounds(x2, y2);

      } else if (type === 'VIA') {
        // ["VIA", id, 0, netName, "", x, y, drill, outerDiam, ...]
        const viaId = node[1] as string;
        const netName = node[3] as string;
        const xMm = (typeof node[5] === 'number' ? node[5] : 0) * MILS_TO_MM;
        const yMm = (typeof node[6] === 'number' ? node[6] : 0) * MILS_TO_MM;
        const drill = (typeof node[7] === 'number' ? node[7] : 12) * MILS_TO_MM;
        const outerDiam = (typeof node[8] === 'number' ? node[8] : 24) * MILS_TO_MM;

        const netId = netName ? (netNameToId.get(netName) || netName) : '';

        vias.push({
          id: `via_${viaId}`,
          netId,
          position: { x: xMm, y: yMm },
          drill,
          outerDiameter: outerDiam,
          fromLayer: 'F.Cu',
          toLayer: 'B.Cu',
        });

        expandBounds(xMm, yMm);
      }
    }

    // Calculate board dimensions from bounds (with margin)
    const boardMargin = 5; // 5mm margin
    const boardWidth = boardMaxX === -Infinity ? 100 :
      Math.ceil((boardMaxX - boardMinX) + boardMargin * 2);
    const boardHeight = boardMaxY === -Infinity ? 80 :
      Math.ceil((boardMaxY - boardMinY) + boardMargin * 2);

    // Offset all positions so board starts near origin
    const offsetX = boardMinX === Infinity ? 0 : boardMinX - boardMargin;
    const offsetY = boardMinY === Infinity ? 0 : boardMinY - boardMargin;

    for (const comp of pcbComponents) {
      comp.position.x -= offsetX;
      comp.position.y -= offsetY;
    }
    for (const trace of traces) {
      for (const pt of trace.points) {
        pt.x -= offsetX;
        pt.y -= offsetY;
      }
    }
    for (const via of vias) {
      via.position.x -= offsetX;
      via.position.y -= offsetY;
    }

    const layout = createPCBLayout(boardWidth, boardHeight);
    layout.components = pcbComponents;
    layout.traces = traces;
    layout.vias = vias;

    console.log(`[PCB Import] ${pcbComponents.length} components, ${traces.length} traces, ${vias.length} vias, board ${boardWidth}×${boardHeight}mm`);

    return layout;
  } catch (e) {
    console.warn('Failed to parse PCB layout:', e);
    return null;
  }
}

export async function importFromEasyEDAPro(
  fileBuffer: ArrayBuffer
): Promise<{ doc: CircuitDocument; library: Map<string, ComponentDefinition>; footprintMap: Map<string, FootprintDefinition> }> {
  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
  const db = new SQL.Database(new Uint8Array(fileBuffer));

  const library = new Map<string, ComponentDefinition>();

  // Maps for symbol UUID → library entry
  const symbolUuidToDefId = new Map<string, string>();


  const doc: CircuitDocument = {
    id: uuidv4(),
    name: 'Imported Pro Circuit',
    version: '1.0',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sheets: [],
    metadata: {
      description: 'Imported from EasyEDA Pro',
      author: '',
      revision: '1.0',
      tags: [],
    },
  };

  // ─── 1. Process Library Symbols (docType=2 for symbols, docType=18 for power symbols) ───

  try {
    const compRes = db.exec("SELECT uuid, title, docType, dataStr FROM components WHERE docType IN (2, 18, 19)");
    if (compRes.length > 0) {
      for (const row of compRes[0].values) {
        const uuid = row[0] as string;
        const title = row[1] as string;
        const docType = row[2] as number;
        const dataStr = row[3] as string;
        if (!dataStr || !dataStr.startsWith('base64')) continue;

        try {
          const decompressed = decompressGzip(dataStr);
          const nodes = parseNDJSON(decompressed);
          const attrs = collectAttrs(nodes);

          const pins: PinDefinition[] = [];
          const graphics: SymbolGraphic[] = [];
          let isPower = docType === 18;
          let isPort = docType === 19;
          let globalNetName = '';

          for (const node of nodes) {
            const type = node[0];

            if (type === 'PIN') {
              // ["PIN", "e5", pinNum, null, x, y, length, rotation, null, dot, clk, show]
              const pinId = node[1] as string;
              const pinNum = node[2] as number;
              const px = (typeof node[4] === 'number') ? node[4] : 0;
              const py = (typeof node[5] === 'number') ? node[5] : 0;
              const pinLength = (typeof node[6] === 'number') ? node[6] : 10;
              const pinRotation = (typeof node[7] === 'number') ? node[7] : 0;

              // Get pin name and number from ATTRs
              const pinAttrs = attrs.get(pinId) || [];
              const nameAttr = pinAttrs.find(a => a.key === 'NAME');
              const numAttr = pinAttrs.find(a => a.key === 'NUMBER');
              const pinTypeAttr = pinAttrs.find(a => a.key === 'Pin Type');

              const name = nameAttr?.value || String(pinNum);
              const number = numAttr?.value || String(pinNum);
              
              // Map EasyEDA Pro pin type to our types
              let pinType: 'input' | 'output' | 'bidirectional' | 'passive' | 'power' | 'unspecified' = 'unspecified';
              const ptStr = (pinTypeAttr?.value || '').toLowerCase();
              if (ptStr === 'in' || ptStr === 'input') pinType = 'input';
              else if (ptStr === 'out' || ptStr === 'output') pinType = 'output';
              else if (ptStr === 'i/o' || ptStr === 'bidirectional') pinType = 'bidirectional';
              else if (ptStr === 'passive') pinType = 'passive';
              else if (ptStr === 'power') pinType = 'power';

              // Determine orientation from rotation
              let orientation: 'left' | 'right' | 'up' | 'down' = 'left';
              if (pinRotation === 0) orientation = 'right';
              else if (pinRotation === 90) orientation = 'down';
              else if (pinRotation === 180) orientation = 'left';
              else if (pinRotation === 270) orientation = 'up';

              pins.push({
                id: number,
                name,
                type: pinType,
                position: { x: px, y: -py }, // Invert Y for rendering/bounding box
                orientation,
                length: pinLength,
              } as any);
              // Attach raw Y for correct rotation during placement (not part of PinDefinition type)
              (pins[pins.length - 1] as any)._rawY = py;
            } else if (type === 'RECT') {
              // ["RECT", id, x1, y1, x2, y2, ...]
              const x1 = node[2] as number;
              const y1 = -(node[3] as number);
              const x2 = node[4] as number;
              const y2 = -(node[5] as number);
              const w = Math.abs(x2 - x1);
              const h = Math.abs(y2 - y1);
              graphics.push({
                type: 'rect',
                properties: {
                  x: (x1 + x2) / 2,
                  y: (y1 + y2) / 2,
                  width: w,
                  height: h,
                  fill: 'transparent',
                },
              });
            } else if (type === 'POLY') {
              // ["POLY", id, [x1,y1,x2,y2,...], fill, style, ...]
              const pts = node[2] as number[];
              if (Array.isArray(pts) && pts.length >= 4) {
                for (let i = 0; i < pts.length - 2; i += 2) {
                  graphics.push({
                    type: 'line',
                    properties: {
                      x1: pts[i],
                      y1: -pts[i + 1],
                      x2: pts[i + 2],
                      y2: -pts[i + 3],
                    },
                  });
                }
              }
            } else if (type === 'ARC') {
              // ["ARC", id, cx, cy, rx, ry, ...]
              const cx = node[2] as number;
              const cy = -(node[3] as number);
              const r = node[4] as number;
              graphics.push({ type: 'circle', properties: { cx, cy, r } });
            } else if (type === 'ELLIPSE') {
              const cx = node[2] as number;
              const cy = -(node[3] as number);
              const r = node[4] as number;
              graphics.push({ type: 'circle', properties: { cx, cy, r } });
            }
          }

          // Get global net name for power symbols
          const topAttrs = attrs.get('') || [];
          const gnAttr = topAttrs.find(a => a.key === 'Global Net Name');
          if (gnAttr) globalNetName = gnAttr.value;

          // Compute bounding box for symbol dimensions
          let minX = 0, maxX = 0, minY = 0, maxY = 0;
          for (const p of pins) {
            if (p.position.x < minX) minX = p.position.x;
            if (p.position.x > maxX) maxX = p.position.x;
            if (p.position.y < minY) minY = p.position.y;
            if (p.position.y > maxY) maxY = p.position.y;
          }
          for (const g of graphics) {
            const gp = g.properties as Record<string, unknown>;
            if (g.type === 'rect') {
              const rx = (gp['x'] as number) || 0, ry = (gp['y'] as number) || 0;
              const rw = (gp['width'] as number) || 0, rh = (gp['height'] as number) || 0;
              if (rx - rw/2 < minX) minX = rx - rw/2;
              if (rx + rw/2 > maxX) maxX = rx + rw/2;
              if (ry - rh/2 < minY) minY = ry - rh/2;
              if (ry + rh/2 > maxY) maxY = ry + rh/2;
            } else if (g.type === 'line') {
              for (const k of ['x1', 'x2']) { const v = gp[k] as number; if (v < minX) minX = v; if (v > maxX) maxX = v; }
              for (const k of ['y1', 'y2']) { const v = gp[k] as number; if (v < minY) minY = v; if (v > maxY) maxY = v; }
            }
          }
          const symWidth = Math.max(20, maxX - minX + 10);
          const symHeight = Math.max(20, maxY - minY + 10);

          // If no explicit graphics were found, create a default box
          if (graphics.length === 0 && !isPower && !isPort) {
            graphics.push({
              type: 'rect',
              properties: {
                x: 0, y: 0,
                width: Math.max(40, symWidth - 10),
                height: Math.max(40, symHeight - 10),
                fill: 'transparent',
              },
            });
          }

          const defId = `pro_${uuid}`;
          const category = isPower ? 'power' : isPort ? 'port' : 'imported';
          const prefix = isPower ? '#PWR' : (title.match(/^[A-Z]+/)?.[0]?.charAt(0) || 'U');

          library.set(defId, {
            id: defId,
            name: title,
            description: isPower ? `Power Symbol (${title})` : `Imported Pro Component (${title})`,
            category,
            designatorPrefix: prefix,
            defaultValue: globalNetName || title,
            properties: {},
            tags: ['pro'],
            symbol: {
              id: `sym_${defId}`,
              name: title,
              width: symWidth,
              height: symHeight,
              origin: { x: 0, y: 0 },
              pins,
              graphics,
              designatorPosition: { x: 0, y: minY - 10 },
              valuePosition: { x: 0, y: maxY + 10 },
            },
          });

          // Map both the UUID and the title to this defId
          symbolUuidToDefId.set(uuid, defId);
          symbolUuidToDefId.set(title, defId);
          // Also map lowercase title for case-insensitive matching
          symbolUuidToDefId.set(title.toLowerCase(), defId);
        } catch(e) {
          console.warn('Failed to decompress library component:', title, e);
        }
      }
    }
  } catch(e) {
    console.warn('No components table or failed to read it:', e);
  }

  // ─── 2. Process Schematics (all pages) ───

  try {
    const schRes = db.exec("SELECT title, display_title, dataStr FROM documents WHERE docType = 1");
    if (schRes.length > 0 && schRes[0].values.length > 0) {
      for (let pageIdx = 0; pageIdx < schRes[0].values.length; pageIdx++) {
        const row = schRes[0].values[pageIdx];
        const pageTitle = (row[1] as string) || (row[0] as string) || `Sheet ${pageIdx + 1}`;
        const dataStr = row[2] as string;
        if (!dataStr || !dataStr.startsWith('base64')) continue;

        const pageSheet: Sheet = {
          id: uuidv4(),
          name: pageTitle,
          gridSize: 10,
          bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
          components: [],
          wires: [],
          labels: [],
          junctions: [],
          nets: [],
          annotations: [],
        };

        const decompressed = decompressGzip(dataStr);
        const nodes = parseNDJSON(decompressed);
        const attrs = collectAttrs(nodes);

        // Helper to create nets
        function getOrAddNet(name: string): Net {
          let net = pageSheet.nets.find(n => n.name === name);
          if (!net) {
            net = { id: uuidv4(), name: name || `Net_${pageSheet.nets.length}`, pinIds: [], wireIds: [] };
            pageSheet.nets.push(net);
          }
          return net;
        }

        for (const node of nodes) {
          try {
            const type = node[0];

            if (type === 'COMPONENT') {
              // ["COMPONENT", "e61", "RP2354B_C39843328.1", x, y, rotation, mirror, {}, flags]
              const compId = node[1] as string;
              const partRef = node[2] as string; // e.g., "RP2354B_C39843328.1"
              const x = (typeof node[3] === 'number') ? node[3] : 0;
              const y = (typeof node[4] === 'number') ? -(node[4] as number) : 0; // Invert Y
              const rotation = (typeof node[5] === 'number') ? (node[5] as number) : 0;

              // Get component attributes
              const compAttrs = attrs.get(compId) || [];
              const symbolAttr = compAttrs.find(a => a.key === 'Symbol');
              const desigAttr = compAttrs.find(a => a.key === 'Designator');
              const nameAttr = compAttrs.find(a => a.key === 'Name');
              const gnAttr = compAttrs.find(a => a.key === 'Global Net Name');

              const symbolUuid = symbolAttr?.value || '';
              const designator = desigAttr?.value || nameAttr?.value || compId;
              const value = gnAttr?.value || nameAttr?.value || '';

              // Skip the first component if it's a title block (pos=0,0 with no designator)
              if (x === 0 && y === 0 && !desigAttr && partRef === '') continue;

              // Resolve library definition
              let defId = symbolUuidToDefId.get(symbolUuid);
              if (!defId) {
                // Try matching by partRef (strip .N suffix and lowercase)
                const basePart = (partRef || '').replace(/\.\d+$/, '').toLowerCase();
                defId = symbolUuidToDefId.get(basePart);
              }
              if (!defId) {
                // Create a fallback definition
                defId = `pro_fallback_${compId}`;
                const fallbackDef: ComponentDefinition = {
                  id: defId,
                  name: partRef || compId,
                  description: 'Unknown Pro Component',
                  category: 'imported',
                  designatorPrefix: designator.replace(/[\d]+$/, '') || 'U',
                  defaultValue: value || partRef,
                  properties: {},
                  tags: ['pro'],
                  symbol: {
                    id: 'sym_' + defId,
                    name: partRef || compId,
                    width: 60, height: 40,
                    origin: { x: 0, y: 0 },
                    pins: [],
                    graphics: [
                      { type: 'rect', properties: { x: 0, y: 0, width: 60, height: 40, fill: 'transparent' } },
                    ],
                    designatorPosition: { x: 0, y: -25 },
                    valuePosition: { x: 0, y: 25 },
                  },
                };
                library.set(defId, fallbackDef);
              }

              // Look up the def to build PinInstances
              const def = library.get(defId)!;
              const rotRad = rotation * Math.PI / 180;
              // Component raw Y (before our Y-inversion): y was set to -(node[4])
              // so rawCompY = node[4] = -y
              const rawCompY = -y;
              const pinInstances: PinInstance[] = def.symbol.pins.map((p: any) => {
                // Use raw (non-Y-inverted) pin coordinates for rotation.
                // p._rawY is the original EasyEDA Y; p.position.x is unchanged.
                const rawPinX = p.position.x;
                const rawPinY = (p as any)._rawY ?? (-p.position.y); // fallback: un-invert
                // Rotate in raw coordinate space
                const rx = rotation
                  ? rawPinX * Math.cos(rotRad) - rawPinY * Math.sin(rotRad)
                  : rawPinX;
                const ry = rotation
                  ? rawPinX * Math.sin(rotRad) + rawPinY * Math.cos(rotRad)
                  : rawPinY;
                // Compute absolute position in raw coords, then Y-invert
                const absRawX = (-y === rawCompY ? x : x) + rx; // x is already correct
                const absRawY = rawCompY + ry;
                return {
                  definitionId: p.id,
                  componentId: compId,
                  absolutePosition: {
                    x: Math.round(absRawX),
                    y: Math.round(-absRawY), // Y-invert the final result
                  },
                  netId: null,
                };
              });

              const comp: Component = {
                id: compId,
                libraryId: defId,
                position: { x, y },
                rotation: ((rotation % 360 + 360) % 360) as 0 | 90 | 180 | 270,
                mirror: false,
                designator,
                value: value || def.defaultValue || '',
                pins: pinInstances,
                properties: {},
              };

              pageSheet.components.push(comp);

            } else if (type === 'WIRE') {
              // ["WIRE", "e709", [[x1,y1,x2,y2], [x3,y3,x4,y4]], style, flags]
              const wireId = node[1] as string;
              const segs = node[2] as number[][];
              
              if (Array.isArray(segs) && segs.length > 0) {
                // Check ATTR for NET name
                const wireAttrs = attrs.get(wireId) || [];
                const netAttr = wireAttrs.find(a => a.key === 'NET');
                const netName = netAttr?.value || '';

                const net = getOrAddNet(netName);
                const segments = segs.map(s => ({
                  start: { x: s[0], y: -s[1] },
                  end: { x: s[2], y: -s[3] },
                }));

                if (segments.length > 0) {
                  const wire: Wire = { id: wireId, netId: net.id, segments };
                  pageSheet.wires.push(wire);
                  net.wireIds.push(wireId);

                  // Create a visible NetLabel for named wires (not power-like names
                  // which are already handled by power components)
                  if (netName && netName !== 'GND' && !netName.startsWith('+')) {
                    // Place label at the last segment's endpoint
                    const lastSeg = segments[segments.length - 1];
                    pageSheet.labels.push({
                      id: uuidv4(),
                      position: { ...lastSeg.end },
                      netName,
                      rotation: 0,
                    });
                  }
                }
              }
            }
          } catch(e) {
            // Skip unparseable nodes
          }
        }

        // Add net labels for power/ground components
        for (const comp of pageSheet.components) {
          const def = library.get(comp.libraryId);
          if (def && (def.category === 'power' || def.category === 'port') && comp.value) {
            // Create a net label at the component's position
            pageSheet.labels.push({
              id: uuidv4(),
              position: { ...comp.position },
              netName: comp.value,
              rotation: 0,
            });
          }
        }

        // ─── Post-import connectivity resolution ───
        // Build a flat list of pin positions for tolerance-based matching
        const EPSILON = 1.5; // pixels tolerance for pin-wire matching
        const allPins: { x: number; y: number; comp: Component; pinIdx: number }[] = [];
        for (const comp of pageSheet.components) {
          for (let pi = 0; pi < comp.pins.length; pi++) {
            const p = comp.pins[pi];
            allPins.push({ x: p.absolutePosition.x, y: p.absolutePosition.y, comp, pinIdx: pi });
          }
        }

        /** Find pins within EPSILON of a given point */
        function findPinsAt(x: number, y: number) {
          return allPins.filter(p => Math.abs(p.x - x) <= EPSILON && Math.abs(p.y - y) <= EPSILON);
        }



        // For each wire, check if its endpoints or segments touch any pins
        // If so, assign the wire's netId to those pins
        // Also merge wires that share endpoints into the same net
        const netMerges = new Map<string, string>(); // old netId → canonical netId

        function resolveNet(netId: string): string {
          let resolved = netId;
          while (netMerges.has(resolved)) resolved = netMerges.get(resolved)!;
          return resolved;
        }

        /** Check if point (px, py) lies on the line segment from (ax, ay) to (bx, by) within tolerance */
        function pointOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
          const dx = bx - ax, dy = by - ay;
          const lenSq = dx * dx + dy * dy;
          if (lenSq < 0.001) {
            // Degenerate segment (zero-length)
            return Math.abs(px - ax) <= EPSILON && Math.abs(py - ay) <= EPSILON;
          }
          // Project point onto the line: t = dot(AP, AB) / |AB|^2
          const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
          if (t < -0.01 || t > 1.01) return false; // Outside segment
          // Distance from point to nearest point on segment
          const closestX = ax + t * dx;
          const closestY = ay + t * dy;
          const dist = Math.sqrt((px - closestX) ** 2 + (py - closestY) ** 2);
          return dist <= EPSILON;
        }

        /** Connect a pin to a wire's net */
        function connectPinToWire(pin: PinInstance, wire: Wire) {
          const resolvedWireNet = resolveNet(wire.netId);
          if (pin.netId && pin.netId !== resolvedWireNet) {
            const resolvedPinNet = resolveNet(pin.netId);
            if (resolvedPinNet !== resolvedWireNet) {
              netMerges.set(resolvedWireNet, resolvedPinNet);
            }
          } else {
            pin.netId = resolvedWireNet;
          }
        }

        // First pass: connect wires to pins
        // Check endpoints AND pins lying along wire segments
        for (const wire of pageSheet.wires) {
          // Check all segment endpoints
          for (const seg of wire.segments) {
            for (const ep of [seg.start, seg.end]) {
              const pinsAtPos = findPinsAt(ep.x, ep.y);
              for (const { comp, pinIdx } of pinsAtPos) {
                connectPinToWire(comp.pins[pinIdx], wire);
              }
            }
          }

          // Check if any pin lies ON a wire segment (not just at endpoints).
          // Collect ALL split points on each segment, sort by position along the
          // segment, then split in order — this produces correctly ordered sub-segments.
          const newSegments: typeof wire.segments = [];
          for (const seg of wire.segments) {
            const dx = seg.end.x - seg.start.x, dy = seg.end.y - seg.start.y;
            const lenSq = dx * dx + dy * dy;

            // Collect pins that lie on this segment (but not at its endpoints)
            const splitPoints: { t: number; x: number; y: number; pinEntry: typeof allPins[0] }[] = [];
            for (const pinEntry of allPins) {
              const atStart = Math.abs(pinEntry.x - seg.start.x) <= EPSILON && Math.abs(pinEntry.y - seg.start.y) <= EPSILON;
              const atEnd   = Math.abs(pinEntry.x - seg.end.x) <= EPSILON && Math.abs(pinEntry.y - seg.end.y) <= EPSILON;
              if (atStart || atEnd) continue;
              if (!pointOnSegment(pinEntry.x, pinEntry.y, seg.start.x, seg.start.y, seg.end.x, seg.end.y)) continue;

              // Compute t (position along segment, 0 = start, 1 = end)
              const t = lenSq > 0.001
                ? ((pinEntry.x - seg.start.x) * dx + (pinEntry.y - seg.start.y) * dy) / lenSq
                : 0;
              splitPoints.push({ t, x: pinEntry.x, y: pinEntry.y, pinEntry });
            }

            if (splitPoints.length === 0) {
              newSegments.push(seg);
            } else {
              // Sort by position along segment direction
              splitPoints.sort((a, b) => a.t - b.t);
              // Connect pins and build ordered sub-segments
              let prev = { ...seg.start };
              for (const sp of splitPoints) {
                connectPinToWire(sp.pinEntry.comp.pins[sp.pinEntry.pinIdx], wire);
                newSegments.push({ start: prev, end: { x: sp.x, y: sp.y } });
                prev = { x: sp.x, y: sp.y };
              }
              newSegments.push({ start: prev, end: { ...seg.end } });
            }
          }
          wire.segments = newSegments;
        }


        // Second pass: merge wires sharing endpoints into same net
        const endpointToNetId = new Map<string, string>();
        for (const wire of pageSheet.wires) {
          for (const seg of wire.segments) {
            for (const pt of [seg.start, seg.end]) {
              const key = `${pt.x},${pt.y}`;
              const existing = endpointToNetId.get(key);
              if (existing) {
                const resolvedExisting = resolveNet(existing);
                const resolvedWire = resolveNet(wire.netId);
                if (resolvedExisting !== resolvedWire) {
                  netMerges.set(resolvedWire, resolvedExisting);
                }
              } else {
                endpointToNetId.set(key, resolveNet(wire.netId));
              }
            }
          }
        }

        // Apply net merges to all wires and pins
        for (const wire of pageSheet.wires) {
          wire.netId = resolveNet(wire.netId);
        }
        for (const comp of pageSheet.components) {
          for (const pin of comp.pins) {
            if (pin.netId) pin.netId = resolveNet(pin.netId);
          }
        }

        // Assign net names from power labels to their nets
        for (const label of pageSheet.labels) {
          // Find pins at the label position (tolerance-based)
          const pinsAtLabel = findPinsAt(label.position.x, label.position.y);
          if (pinsAtLabel.length > 0) {
            for (const { comp: c, pinIdx } of pinsAtLabel) {
              const pin = c.pins[pinIdx];
              if (pin.netId) {
                const net = pageSheet.nets.find(n => n.id === pin.netId);
                if (net && (!net.name || net.name.startsWith('Net_'))) {
                  net.name = label.netName;
                }
              } else {
                // Create a net for this power connection
                const net = getOrAddNet(label.netName);
                pin.netId = net.id;
              }
            }
          }

          // Also connect label to wires at the same position
          for (const wire of pageSheet.wires) {
            for (const seg of wire.segments) {
              for (const pt of [seg.start, seg.end]) {
                if (Math.abs(pt.x - label.position.x) <= EPSILON && Math.abs(pt.y - label.position.y) <= EPSILON) {
                  const net = pageSheet.nets.find(n => n.id === wire.netId);
                  if (net && (!net.name || net.name.startsWith('Net_'))) {
                    net.name = label.netName;
                  }
                }
              }
            }
          }
        }

        // Clean up empty/duplicate nets
        const usedNetIds = new Set<string>();
        for (const wire of pageSheet.wires) usedNetIds.add(wire.netId);
        for (const comp of pageSheet.components) {
          for (const pin of comp.pins) {
            if (pin.netId) usedNetIds.add(pin.netId);
          }
        }
        pageSheet.nets = pageSheet.nets.filter(n => usedNetIds.has(n.id));

        doc.sheets.push(pageSheet);
      }
    }
  } catch(e) {
    console.error('Failed to parse documents:', e);
  }

  // Set the document name from the first page title or project info
  if (doc.sheets.length > 0) {
    doc.name = doc.sheets[0].name || 'Imported Pro Circuit';
  }

  // Ensure at least one sheet exists
  if (doc.sheets.length === 0) {
    doc.sheets.push({
      id: uuidv4(),
      name: 'Sheet 1',
      gridSize: 10,
      bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
      components: [],
      wires: [],
      labels: [],
      junctions: [],
      nets: [],
      annotations: [],
    });
  }

  // ─── 3. Process PCB layout (if present) ───
  const footprintMap = parseProFootprints(db);
  const pcbLayout = parseProPCBLayout(db, doc, footprintMap);
  if (pcbLayout) {
    doc.pcbLayout = pcbLayout;
    console.log(`[PCB Import] Successfully imported PCB layout with ${pcbLayout.components.length} components`);
  }

  return { doc, library, footprintMap };
}
