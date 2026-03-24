// ============================================================
// EasyEDA PCB Serializer
// Converts PCBLayout → EasyEDA PCB JSON (docType '3')
// Spec: https://docs.easyeda.com/en/DocumentFormat/3-EasyEDA-PCB-File-Format/
// ============================================================

import type {
  CircuitDocument,
  Component,
  ComponentDefinition,
  PCBComponent,
  PCBLayer,
} from '../core/types';
import type { FootprintDefinition, PadDefinition } from '../library/easyeda-parser';
import { createIdGenerator, type IdGenerator } from './easyeda-id-gen';

// ----- Unit Conversion -----
// EasyEDA PCB uses 10x mil units: 1 unit = 10 mil = 0.254 mm
const MM_TO_UNITS = 1 / 0.254; // ≈ 3.937 units per mm

function u(mm: number): number {
  return Math.round(mm * MM_TO_UNITS * 100) / 100;
}

// ----- Layer Mapping -----
// Our PCBLayer → EasyEDA layer ID
const LAYER_TO_ID: Record<PCBLayer, number> = {
  'F.Cu': 1,    // TopLayer
  'B.Cu': 2,    // BottomLayer
  'In1.Cu': 21, // Inner1
  'In2.Cu': 22, // Inner2
  'F.SilkS': 3, // TopSilkLayer
  'B.SilkS': 4, // BottomSilkLayer
  'Edge.Cuts': 10, // BoardOutline
};

// ----- Default Layer Config -----
const DEFAULT_LAYERS = [
  '1~TopLayer~#FF0000~true~true~true',
  '2~BottomLayer~#0000FF~true~false~true',
  '3~TopSilkLayer~#FFFF00~true~false~true',
  '4~BottomSilkLayer~#808000~true~false~true',
  '5~TopPasterLayer~#808080~false~false~false',
  '6~BottomPasterLayer~#800000~false~false~false',
  '7~TopSolderLayer~#800080~false~false~false',
  '8~BottomSolderLayer~#AA00FF~false~false~false',
  '9~Ratlines~#6464FF~true~false~true',
  '10~BoardOutline~#FF00FF~true~false~true',
  '11~Multi-Layer~#C0C0C0~true~false~true',
  '12~Document~#FFFFFF~true~false~true',
];

// ----- Public Types -----

export interface EasyEDAPCBDocument {
  docType: string;
  head: string;
  canvas: string;
  layers: string[];
  objects: string[];
  BBox: { x: number; y: number; width: number; height: number };
  preference: Record<string, string>;
  DRCRULE?: Record<string, unknown>;
  systemColor?: string;
  shape: string[];
}

// ----- Main Export Function -----

/**
 * Serialize a CircuitDocument's PCB layout to EasyEDA PCB JSON (docType '3').
 */
export function serializeToEasyEDAPCB(
  doc: CircuitDocument,
  libraryMap: Map<string, ComponentDefinition>,
  footprintMap: Map<string, FootprintDefinition>
): EasyEDAPCBDocument {
  const nextId = createIdGenerator();
  const pcb = doc.pcbLayout;

  if (!pcb) {
    throw new Error('Document has no PCB layout');
  }

  if (doc.sheets.length === 0) {
    throw new Error('Document has no sheets');
  }

  // Gather components and nets from all sheets
  const allComponents = doc.sheets.flatMap(s => s.components);
  const allNets = doc.sheets.flatMap(s => s.nets);

  // Build net name lookup
  const netNameMap = new Map<string, string>();
  for (const net of allNets) {
    netNameMap.set(net.id, net.name || net.id);
  }

  const shapes: string[] = [];

  // ── Board Outline (RECT on layer 10) ──
  const bx = u(0);
  const by = u(0);
  const bw = u(pcb.board.width);
  const bh = u(pcb.board.height);
  shapes.push(`RECT~${bx}~${by}~${bw}~${bh}~10~${nextId()}`);

  // ── Placed Footprints (LIB shapes) ──
  for (const pcbComp of pcb.components) {
    if (!pcbComp.isPlaced) continue;

    const schComp = allComponents.find(c => c.id === pcbComp.schematicComponentId);
    if (!schComp) continue;

    const def = libraryMap.get(schComp.libraryId);
    if (!def) continue;

    // Find footprint — look up by LCSC, then by footprintId, then by libraryId
    const lcsc = schComp.properties?.lcsc || def.properties?.lcsc || '';
    const fp = footprintMap.get(lcsc) ||
               footprintMap.get(pcbComp.footprintId) ||
               footprintMap.get(schComp.libraryId);

    const shape = pcbComponentToLib(pcbComp, schComp, def, fp, nextId);
    shapes.push(shape);
  }

  // ── Traces (TRACK shapes) ──
  for (const trace of pcb.traces) {
    const netName = netNameMap.get(trace.netId) || '';
    const layerId = LAYER_TO_ID[trace.layer] || 1;
    const width = u(trace.width);

    // Convert trace polyline to segments
    if (trace.points.length >= 2) {
      const pts = trace.points.map(p => `${u(p.x)} ${u(p.y)}`).join(' ');
      shapes.push(`TRACK~${width}~${layerId}~${netName}~${pts}~${nextId()}`);
    }
  }

  // ── Vias ──
  for (const via of pcb.vias) {
    const netName = netNameMap.get(via.netId) || '';
    const cx = u(via.position.x);
    const cy = u(via.position.y);
    const diameter = u(via.outerDiameter);
    const holeRadius = u(via.drill / 2);
    shapes.push(`VIA~${cx}~${cy}~${diameter}~${netName}~${holeRadius}~${nextId()}`);
  }

  // ── BBox ──
  const bbox = {
    x: bx,
    y: by,
    width: bw,
    height: bh,
  };

  // ── Canvas ──
  // Format: CA~viewW~viewH~bg~gridVisible~gridColor~gridSize~canvasW~canvasH~gridStyle~snapSize~unit~routeWidth~routeAngle~copperArea~altSnap~originX~originY
  const canvasW = Math.max(bw * 2, 2400);
  const canvasH = Math.max(bh * 2, 2400);
  const canvas = `CA~${canvasW}~${canvasH}~#000000~yes~#FFFFFF~10~${Math.round(canvasW / 2)}~${Math.round(canvasH / 2)}~line~1~mil~1~45~visible~0.5~${bx}~${by}`;

  return {
    docType: '3',
    head: `3~6.5.40~Author\`smart-circuit\``,
    canvas,
    layers: DEFAULT_LAYERS,
    objects: [],
    BBox: bbox,
    preference: {},
    systemColor: '#000000~#FFFFFF~#FFFFFF~#000000~#FFFFFF',
    shape: shapes,
  };
}

// ----- Footprint → LIB Shape -----

function pcbComponentToLib(
  pcbComp: PCBComponent,
  schComp: Component,
  def: ComponentDefinition,
  fp: FootprintDefinition | undefined,
  nextId: IdGenerator
): string {
  const cx = u(pcbComp.position.x);
  const cy = u(pcbComp.position.y);
  const rotation = pcbComp.rotation || 0;
  const libId = nextId();

  // Package name for c_para
  const pkg = fp?.name || def.properties?.package || def.name;
  const lcsc = schComp.properties?.lcsc || def.properties?.lcsc || '';

  // LIB header: LIB~x~y~package`name`~rotation~~id~locked
  let cPara = `package\`${pkg}\``;
  if (lcsc) {
    cPara += `Supplier\`LCSC\`Supplier Part\`${lcsc}\``;
  }
  const header = `LIB~${cx}~${cy}~${cPara}~${rotation}~~${libId}~0`;

  const childShapes: string[] = [];

  // Designator text on silk layer
  const silkLayerId = pcbComp.layer === 'B.Cu' ? 4 : 3;
  childShapes.push(
    `TEXT~P~${cx}~${cy - u(2)}~0.6~0~none~${silkLayerId}~~4~${schComp.designator}~~${nextId()}`
  );

  if (fp) {
    // Use real footprint data — emit pads and silkscreen
    for (const pad of fp.pads) {
      childShapes.push(padToShape(pad, cx, cy, rotation, nextId));
    }

    // Silkscreen tracks
    for (const silk of fp.silkscreen) {
      if (silk.points.length < 2) continue;
      const layerId = silk.layer === 'B.SilkS' ? 4 : 3;
      const sw = u(silk.strokeWidth || 0.12);
      const pts = silk.points
        .map(p => {
          const { rx, ry } = rotatePoint(p.x, p.y, rotation);
          return `${cx + u(rx)} ${cy + u(ry)}`;
        })
        .join(' ');
      childShapes.push(`TRACK~${sw}~${layerId}~~${pts}~${nextId()}`);
    }
  } else {
    // Fallback: generate generic 2-pad footprint
    const padSize = u(0.6);
    const padSpacing = u(0.8);
    childShapes.push(
      `PAD~RECT~${cx - padSpacing}~${cy}~${padSize}~${padSize}~1~~1~0~~0~${nextId()}`
    );
    childShapes.push(
      `PAD~RECT~${cx + padSpacing}~${cy}~${padSize}~${padSize}~1~~2~0~~0~${nextId()}`
    );
  }

  return header + '#@$' + childShapes.join('#@$');
}

// ----- Pad Conversion -----

function padToShape(
  pad: PadDefinition,
  compX: number,
  compY: number,
  compRotation: number,
  nextId: IdGenerator
): string {
  // Rotate pad position by component rotation
  const { rx, ry } = rotatePoint(pad.x, pad.y, compRotation);
  const cx = compX + u(rx);
  const cy = compY + u(ry);
  const w = u(pad.width);
  const h = u(pad.height);
  const padRotation = (pad.rotation + compRotation) % 360;

  // Layer: through-hole pads use 11 (Multi-Layer), SMD pads use copper layer
  let layerId: number;
  if (pad.drill && pad.drill > 0) {
    layerId = 11; // Multi-Layer (through-hole)
  } else {
    layerId = LAYER_TO_ID[pad.layer] || 1;
  }

  const holeRadius = pad.drill ? u(pad.drill / 2) : 0;

  let shapeStr: string;
  switch (pad.shape) {
    case 'circle': shapeStr = 'ELLIPSE'; break;
    case 'oval': shapeStr = 'OVAL'; break;
    default: shapeStr = 'RECT'; break;
  }

  // PAD~shape~cx~cy~w~h~layer~net~number~holeR~points~rot~id~locked
  return `PAD~${shapeStr}~${cx}~${cy}~${w}~${h}~${layerId}~~${pad.pinId}~${holeRadius}~~${padRotation}~${nextId()}~0`;
}

// ----- Rotation Helper -----

function rotatePoint(x: number, y: number, degrees: number): { rx: number; ry: number } {
  if (degrees === 0) return { rx: x, ry: y };
  const rad = degrees * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    rx: x * cos - y * sin,
    ry: x * sin + y * cos,
  };
}
