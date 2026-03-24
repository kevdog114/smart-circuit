#!/usr/bin/env npx tsx
// ============================================================
// EasyEDA Import Debug Tool
// Usage: npx tsx tools/easyeda-debug.ts <file> [options]
//
// Supports:
//   .json  → EasyEDA Standard format
//   .eprj  → EasyEDA Pro format (SQLite + gzip)
//
// Options:
//   --json                 Dump full parsed document as JSON
//   --component <desig>    Show detailed info for a specific component
//   --library              Show all library definitions
//   --nets                 Show detailed net connectivity
//   --raw                  Show raw EasyEDA shapes (standard format only)
// ============================================================

import fs from 'fs';
import path from 'path';
import { inflate } from 'pako';
import initSqlJs from 'sql.js';

// ─── Import standard format importer (pure logic, no DOM deps) ───
import { importFromEasyEDA, importMultipleFromEasyEDA } from '../src/import/easyeda-importer.js';
import type { EasyEDADocument } from '../src/export/easyeda-serializer.js';
import type {
  CircuitDocument,
  ComponentDefinition,
  Component,
  Sheet,
  PinInstance,
} from '../src/core/types.js';

// ─── Colors for terminal output ───
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
};

// ─── CLI Argument Parsing ───
const args = process.argv.slice(2);
const flags = {
  json: args.includes('--json'),
  library: args.includes('--library'),
  nets: args.includes('--nets'),
  raw: args.includes('--raw'),
  component: '',
};

// Extract --component value
const compIdx = args.indexOf('--component');
if (compIdx !== -1 && args[compIdx + 1]) {
  flags.component = args[compIdx + 1];
}

// Get file path (first non-flag argument)
const filePath = args.find(a => !a.startsWith('--') && (compIdx === -1 || a !== args[compIdx + 1]));

if (!filePath) {
  console.log(`
${C.bold}${C.cyan}EasyEDA Import Debug Tool${C.reset}

${C.bold}Usage:${C.reset}
  npx tsx tools/easyeda-debug.ts <file> [options]

${C.bold}Supported formats:${C.reset}
  .json   EasyEDA Standard schematic
  .eprj   EasyEDA Pro project (SQLite)

${C.bold}Options:${C.reset}
  --json                 Dump full parsed CircuitDocument as JSON
  --component <desig>    Show detailed info for a component (e.g. --component U1)
  --library              Show all imported library definitions
  --nets                 Show detailed net connectivity map
  --raw                  Show raw EasyEDA shape strings (standard format only)

${C.bold}Examples:${C.reset}
  npx tsx tools/easyeda-debug.ts ../my_circuit.json
  npx tsx tools/easyeda-debug.ts ../my_project.eprj --nets
  npx tsx tools/easyeda-debug.ts ../my_project.eprj --component U1
`);
  process.exit(1);
}

// ─── Helpers ───

function decompressGzip(base64Str: string): string {
  const b64 = base64Str.replace(/^base64/, '');
  const binaryString = Buffer.from(b64, 'base64');
  const decompressed = inflate(binaryString);
  return new TextDecoder().decode(decompressed);
}

function parseNDJSON(data: string): unknown[][] {
  const results: unknown[][] = [];
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    try {
      const node = JSON.parse(line);
      if (Array.isArray(node)) results.push(node);
    } catch { /* skip non-JSON lines */ }
  }
  return results;
}

function truncateList(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  return items.slice(0, max).join(', ') + `, ... +${items.length - max} more`;
}

function pct(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return (n / total * 100).toFixed(1) + '%';
}

// ─── Report Printing ───

function printHeader(filePath: string, format: string) {
  const line = '═'.repeat(50);
  console.log(`\n${C.bold}${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  EasyEDA Import Debug${C.reset}`);
  console.log(`${C.bold}${C.cyan}${line}${C.reset}`);
  console.log(`  ${C.dim}File:${C.reset}   ${path.basename(filePath)}`);
  console.log(`  ${C.dim}Path:${C.reset}   ${path.resolve(filePath)}`);
  console.log(`  ${C.dim}Format:${C.reset} ${format}`);
  console.log(`  ${C.dim}Size:${C.reset}   ${(fs.statSync(filePath).size / 1024).toFixed(1)} KB`);
}

function printSheetReport(sheet: Sheet, library: Map<string, ComponentDefinition>, sheetIdx: number) {
  const divider = '─'.repeat(45);
  console.log(`\n${C.bold}${C.blue}${divider}${C.reset}`);
  console.log(`${C.bold}${C.blue}  Sheet ${sheetIdx + 1}: "${sheet.name}"${C.reset}`);
  console.log(`${C.bold}${C.blue}${divider}${C.reset}`);

  // Components
  const designators = sheet.components.map(c => c.designator).sort();
  const totalSegments = sheet.wires.reduce((sum, w) => sum + w.segments.length, 0);
  const namedNets = sheet.nets.filter(n => n.name && !n.name.startsWith('Net_'));
  const unnamedNets = sheet.nets.filter(n => !n.name || n.name.startsWith('Net_'));

  console.log(`\n  ${C.bold}Components:${C.reset} ${C.green}${sheet.components.length}${C.reset}`);
  if (sheet.components.length > 0) {
    console.log(`    ${C.dim}${truncateList(designators, 20)}${C.reset}`);
  }

  // Categorize components
  const categories = new Map<string, number>();
  for (const comp of sheet.components) {
    const def = library.get(comp.libraryId);
    const cat = def?.category || 'unknown';
    categories.set(cat, (categories.get(cat) || 0) + 1);
  }
  if (categories.size > 1) {
    const catStr = Array.from(categories.entries())
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    console.log(`    ${C.dim}Categories: ${catStr}${C.reset}`);
  }

  console.log(`  ${C.bold}Wires:${C.reset}      ${C.green}${sheet.wires.length}${C.reset} (${totalSegments} segments)`);
  console.log(`  ${C.bold}Nets:${C.reset}       ${C.green}${sheet.nets.length}${C.reset} (${namedNets.length} named, ${unnamedNets.length} anonymous)`);
  if (namedNets.length > 0) {
    console.log(`    ${C.dim}${truncateList(namedNets.map(n => n.name), 15)}${C.reset}`);
  }
  console.log(`  ${C.bold}Labels:${C.reset}     ${C.green}${sheet.labels.length}${C.reset}`);
  console.log(`  ${C.bold}Junctions:${C.reset}  ${C.green}${sheet.junctions.length}${C.reset}`);

  // Connectivity analysis
  let totalPins = 0;
  let connectedPins = 0;
  const disconnectedComps: { designator: string; connectedCount: number; totalCount: number; pins: PinInstance[] }[] = [];

  for (const comp of sheet.components) {
    let compConnected = 0;
    for (const pin of comp.pins) {
      totalPins++;
      if (pin.netId) {
        connectedPins++;
        compConnected++;
      }
    }
    if (compConnected < comp.pins.length && comp.pins.length > 0) {
      disconnectedComps.push({
        designator: comp.designator,
        connectedCount: compConnected,
        totalCount: comp.pins.length,
        pins: comp.pins.filter(p => !p.netId),
      });
    }
  }

  const connPct = pct(connectedPins, totalPins);
  const connColor = connectedPins === totalPins ? C.green : (connectedPins / totalPins > 0.8 ? C.yellow : C.red);
  console.log(`\n  ${C.bold}Connectivity:${C.reset} ${connColor}${connectedPins}/${totalPins} pins connected (${connPct})${C.reset}`);

  if (disconnectedComps.length > 0) {
    console.log(`  ${C.yellow}⚠ ${disconnectedComps.length} components with disconnected pins:${C.reset}`);
    const show = disconnectedComps.slice(0, 15);
    for (const dc of show) {
      const def = library.get(sheet.components.find(c => c.designator === dc.designator)!.libraryId);
      const pinNames = dc.pins.map(p => {
        const pinDef = def?.symbol.pins.find(pd => pd.id === p.definitionId);
        return pinDef ? `${p.definitionId}(${pinDef.name})` : p.definitionId;
      });
      console.log(`    ${C.red}${dc.designator}${C.reset}: ${dc.connectedCount}/${dc.totalCount} connected — missing: ${truncateList(pinNames, 5)}`);
      // Show pin positions for debugging
      for (const pin of dc.pins.slice(0, 3)) {
        console.log(`      ${C.dim}pin ${pin.definitionId} at (${pin.absolutePosition.x}, ${pin.absolutePosition.y})${C.reset}`);
      }
    }
    if (disconnectedComps.length > 15) {
      console.log(`    ${C.dim}... +${disconnectedComps.length - 15} more${C.reset}`);
    }
  }
}

function printComponentDetail(comp: Component, library: Map<string, ComponentDefinition>, sheet: Sheet) {
  const def = library.get(comp.libraryId);
  console.log(`\n${C.bold}${C.magenta}  Component: ${comp.designator}${C.reset}`);
  console.log(`    ${C.dim}ID:${C.reset}        ${comp.id}`);
  console.log(`    ${C.dim}Library:${C.reset}   ${comp.libraryId}`);
  console.log(`    ${C.dim}Name:${C.reset}      ${def?.name || 'unknown'}`);
  console.log(`    ${C.dim}Value:${C.reset}     ${comp.value}`);
  console.log(`    ${C.dim}Position:${C.reset}  (${comp.position.x}, ${comp.position.y})`);
  console.log(`    ${C.dim}Rotation:${C.reset}  ${comp.rotation}°`);
  console.log(`    ${C.dim}Mirror:${C.reset}    ${comp.mirror}`);
  console.log(`    ${C.dim}Category:${C.reset}  ${def?.category || 'unknown'}`);

  console.log(`\n    ${C.bold}Pins (${comp.pins.length}):${C.reset}`);
  for (const pin of comp.pins) {
    const pinDef = def?.symbol.pins.find(pd => pd.id === pin.definitionId);
    const netName = pin.netId ? sheet.nets.find(n => n.id === pin.netId)?.name || pin.netId : '(none)';
    const status = pin.netId ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`      ${status} ${C.bold}${pin.definitionId}${C.reset} "${pinDef?.name || '?'}" at (${pin.absolutePosition.x}, ${pin.absolutePosition.y}) → net: ${netName}`);
  }

  if (def) {
    console.log(`\n    ${C.bold}Symbol Graphics (${def.symbol.graphics.length}):${C.reset}`);
    for (const g of def.symbol.graphics) {
      console.log(`      ${C.dim}${g.type}: ${JSON.stringify(g.properties)}${C.reset}`);
    }
  }
}

function printLibrary(library: Map<string, ComponentDefinition>) {
  console.log(`\n${C.bold}${C.magenta}${'─'.repeat(45)}${C.reset}`);
  console.log(`${C.bold}${C.magenta}  Library Definitions (${library.size})${C.reset}`);
  console.log(`${C.bold}${C.magenta}${'─'.repeat(45)}${C.reset}`);

  for (const [id, def] of library.entries()) {
    console.log(`\n  ${C.bold}${def.name}${C.reset} (${def.category})`);
    console.log(`    ${C.dim}ID: ${id}${C.reset}`);
    console.log(`    ${C.dim}Prefix: ${def.designatorPrefix}, Pins: ${def.symbol.pins.length}, Graphics: ${def.symbol.graphics.length}${C.reset}`);
    console.log(`    ${C.dim}Size: ${def.symbol.width}×${def.symbol.height}${C.reset}`);
    if (def.symbol.pins.length > 0) {
      const pinList = def.symbol.pins.map(p => `${p.id}:${p.name}(${p.type})`);
      console.log(`    ${C.dim}Pins: ${truncateList(pinList, 10)}${C.reset}`);
    }
  }
}

function printNetDetail(doc: CircuitDocument) {
  for (let si = 0; si < doc.sheets.length; si++) {
    const sheet = doc.sheets[si];
    console.log(`\n${C.bold}${C.magenta}${'─'.repeat(45)}${C.reset}`);
    console.log(`${C.bold}${C.magenta}  Net Map — Sheet "${sheet.name}"${C.reset}`);
    console.log(`${C.bold}${C.magenta}${'─'.repeat(45)}${C.reset}`);

    for (const net of sheet.nets) {
      const connectedPins: string[] = [];
      for (const comp of sheet.components) {
        for (const pin of comp.pins) {
          if (pin.netId === net.id) {
            connectedPins.push(`${comp.designator}.${pin.definitionId}`);
          }
        }
      }
      const wireCount = sheet.wires.filter(w => w.netId === net.id).length;
      const nameColor = net.name && !net.name.startsWith('Net_') ? C.green : C.dim;
      console.log(`\n  ${nameColor}${C.bold}${net.name || '(unnamed)'}${C.reset} ${C.dim}(${net.id.substring(0, 8)}...)${C.reset}`);
      console.log(`    ${C.dim}Wires: ${wireCount}, Connected pins: ${connectedPins.length}${C.reset}`);
      if (connectedPins.length > 0) {
        console.log(`    ${C.dim}${truncateList(connectedPins, 15)}${C.reset}`);
      }
    }
  }
}

// ─── Pro Format Import (Node-compatible) ───

interface AttrEntry { key: string; value: string; x?: number; y?: number }

function collectAttrs(nodes: unknown[][]): Map<string, AttrEntry[]> {
  const map = new Map<string, AttrEntry[]>();
  for (const node of nodes) {
    if (node[0] !== 'ATTR') continue;
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

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type PinType = 'input' | 'output' | 'bidirectional' | 'passive' | 'power' | 'unspecified';

async function importProFormat(fileBuffer: Buffer): Promise<{ doc: CircuitDocument; library: Map<string, ComponentDefinition> }> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(fileBuffer));

  const library = new Map<string, ComponentDefinition>();
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

  // ─── 1. Process Library Symbols ───
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

          const pins: any[] = [];
          const graphics: any[] = [];
          const isPower = docType === 18;
          const isPort = docType === 19;
          let globalNetName = '';

          for (const node of nodes) {
            const type = node[0];

            if (type === 'PIN') {
              const pinId = node[1] as string;
              const pinNum = node[2] as number;
              const px = (typeof node[4] === 'number') ? node[4] : 0;
              const py = (typeof node[5] === 'number') ? node[5] : 0;
              const pinLength = (typeof node[6] === 'number') ? node[6] : 10;
              const pinRotation = (typeof node[7] === 'number') ? node[7] : 0;

              const pinAttrs = attrs.get(pinId) || [];
              const nameAttr = pinAttrs.find(a => a.key === 'NAME');
              const numAttr = pinAttrs.find(a => a.key === 'NUMBER');
              const pinTypeAttr = pinAttrs.find(a => a.key === 'Pin Type');

              const name = nameAttr?.value || String(pinNum);
              const number = numAttr?.value || String(pinNum);

              let pinType: PinType = 'unspecified';
              const ptStr = (pinTypeAttr?.value || '').toLowerCase();
              if (ptStr === 'in' || ptStr === 'input') pinType = 'input';
              else if (ptStr === 'out' || ptStr === 'output') pinType = 'output';
              else if (ptStr === 'i/o' || ptStr === 'bidirectional') pinType = 'bidirectional';
              else if (ptStr === 'passive') pinType = 'passive';
              else if (ptStr === 'power') pinType = 'power';

              let orientation: 'left' | 'right' | 'up' | 'down' = 'left';
              if (pinRotation === 0) orientation = 'right';
              else if (pinRotation === 90) orientation = 'down';
              else if (pinRotation === 180) orientation = 'left';
              else if (pinRotation === 270) orientation = 'up';

              pins.push({
                id: number,
                name,
                type: pinType,
                position: { x: px, y: -py },
                orientation,
                length: pinLength,
                _rawY: py,
              });
            } else if (type === 'RECT') {
              const x1 = node[2] as number;
              const y1 = -(node[3] as number);
              const x2 = node[4] as number;
              const y2 = -(node[5] as number);
              const w = Math.abs(x2 - x1);
              const h = Math.abs(y2 - y1);
              graphics.push({
                type: 'rect',
                properties: { x: (x1 + x2) / 2, y: (y1 + y2) / 2, width: w, height: h, fill: 'transparent' },
              });
            } else if (type === 'POLY') {
              const pts = node[2] as number[];
              if (Array.isArray(pts) && pts.length >= 4) {
                for (let i = 0; i < pts.length - 2; i += 2) {
                  graphics.push({
                    type: 'line',
                    properties: { x1: pts[i], y1: -pts[i + 1], x2: pts[i + 2], y2: -pts[i + 3] },
                  });
                }
              }
            } else if (type === 'ARC' || type === 'ELLIPSE') {
              const cx = node[2] as number;
              const cy = -(node[3] as number);
              const r = node[4] as number;
              graphics.push({ type: 'circle', properties: { cx, cy, r } });
            }
          }

          const topAttrs = attrs.get('') || [];
          const gnAttr = topAttrs.find(a => a.key === 'Global Net Name');
          if (gnAttr) globalNetName = gnAttr.value;

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
              if (rx - rw / 2 < minX) minX = rx - rw / 2;
              if (rx + rw / 2 > maxX) maxX = rx + rw / 2;
              if (ry - rh / 2 < minY) minY = ry - rh / 2;
              if (ry + rh / 2 > maxY) maxY = ry + rh / 2;
            } else if (g.type === 'line') {
              for (const k of ['x1', 'x2']) { const v = gp[k] as number; if (v < minX) minX = v; if (v > maxX) maxX = v; }
              for (const k of ['y1', 'y2']) { const v = gp[k] as number; if (v < minY) minY = v; if (v > maxY) maxY = v; }
            }
          }
          const symWidth = Math.max(20, maxX - minX + 10);
          const symHeight = Math.max(20, maxY - minY + 10);

          if (graphics.length === 0 && !isPower && !isPort) {
            graphics.push({
              type: 'rect',
              properties: { x: 0, y: 0, width: Math.max(40, symWidth - 10), height: Math.max(40, symHeight - 10), fill: 'transparent' },
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

          symbolUuidToDefId.set(uuid, defId);
          symbolUuidToDefId.set(title, defId);
          symbolUuidToDefId.set(title.toLowerCase(), defId);
        } catch (e) {
          console.warn(`  ${C.yellow}⚠ Failed to decompress library component: ${title}${C.reset}`, e);
        }
      }
    }
  } catch (e) {
    console.warn(`${C.yellow}⚠ No components table or failed to read it${C.reset}`, e);
  }

  // ─── 2. Process Schematics ───
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

        function getOrAddNet(name: string) {
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
              const compId = node[1] as string;
              const partRef = node[2] as string;
              const x = (typeof node[3] === 'number') ? node[3] : 0;
              const y = (typeof node[4] === 'number') ? -(node[4] as number) : 0;
              const rotation = (typeof node[5] === 'number') ? (node[5] as number) : 0;

              const compAttrs = attrs.get(compId) || [];
              const symbolAttr = compAttrs.find(a => a.key === 'Symbol');
              const desigAttr = compAttrs.find(a => a.key === 'Designator');
              const nameAttr = compAttrs.find(a => a.key === 'Name');
              const gnAttr = compAttrs.find(a => a.key === 'Global Net Name');

              const symbolUuid = symbolAttr?.value || '';
              const designator = desigAttr?.value || nameAttr?.value || compId;
              const value = gnAttr?.value || nameAttr?.value || '';

              if (x === 0 && y === 0 && !desigAttr && partRef === '') continue;

              let defId = symbolUuidToDefId.get(symbolUuid);
              if (!defId) {
                const basePart = (partRef || '').replace(/\.\d+$/, '').toLowerCase();
                defId = symbolUuidToDefId.get(basePart);
              }
              if (!defId) {
                defId = `pro_fallback_${compId}`;
                library.set(defId, {
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
                });
              }

              const def = library.get(defId)!;
              const rotRad = rotation * Math.PI / 180;
              const rawCompY = -y; // raw component Y before our Y-inversion
              const pinInstances: PinInstance[] = def.symbol.pins.map((p: any) => {
                const rawPinX = p.position.x;
                const rawPinY = (p as any)._rawY ?? (-p.position.y);
                const rx = rotation
                  ? rawPinX * Math.cos(rotRad) - rawPinY * Math.sin(rotRad)
                  : rawPinX;
                const ry = rotation
                  ? rawPinX * Math.sin(rotRad) + rawPinY * Math.cos(rotRad)
                  : rawPinY;
                const absRawX = x + rx;
                const absRawY = rawCompY + ry;
                return {
                  definitionId: p.id,
                  componentId: compId,
                  absolutePosition: {
                    x: Math.round(absRawX),
                    y: Math.round(-absRawY),
                  },
                  netId: null,
                };
              });

              pageSheet.components.push({
                id: compId,
                libraryId: defId,
                position: { x, y },
                rotation: ((rotation % 360 + 360) % 360) as 0 | 90 | 180 | 270,
                mirror: false,
                designator,
                value: value || def.defaultValue || '',
                pins: pinInstances,
                properties: {},
              });

            } else if (type === 'WIRE') {
              const wireId = node[1] as string;
              const segs = node[2] as number[][];

              if (Array.isArray(segs) && segs.length > 0) {
                const wireAttrs = attrs.get(wireId) || [];
                const netAttr = wireAttrs.find(a => a.key === 'NET');
                const netName = netAttr?.value || '';

                const net = getOrAddNet(netName);
                const segments = segs.map(s => ({
                  start: { x: s[0], y: -s[1] },
                  end: { x: s[2], y: -s[3] },
                }));

                if (segments.length > 0) {
                  pageSheet.wires.push({ id: wireId, netId: net.id, segments });
                  net.wireIds.push(wireId);

                  if (netName && netName !== 'GND' && !netName.startsWith('+')) {
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
          } catch { /* skip unparseable nodes */ }
        }

        // Add net labels for power/ground components
        for (const comp of pageSheet.components) {
          const def = library.get(comp.libraryId);
          if (def && (def.category === 'power' || def.category === 'port') && comp.value) {
            pageSheet.labels.push({
              id: uuidv4(),
              position: { ...comp.position },
              netName: comp.value,
              rotation: 0,
            });
          }
        }

        // ─── Post-import connectivity resolution ───
        const EPSILON = 1.5;
        const allPins: { x: number; y: number; comp: Component; pinIdx: number }[] = [];
        for (const comp of pageSheet.components) {
          for (let pi = 0; pi < comp.pins.length; pi++) {
            const p = comp.pins[pi];
            allPins.push({ x: p.absolutePosition.x, y: p.absolutePosition.y, comp, pinIdx: pi });
          }
        }

        function findPinsAt(x: number, y: number) {
          return allPins.filter(p => Math.abs(p.x - x) <= EPSILON && Math.abs(p.y - y) <= EPSILON);
        }

        const netMerges = new Map<string, string>();

        function resolveNet(netId: string): string {
          let resolved = netId;
          while (netMerges.has(resolved)) resolved = netMerges.get(resolved)!;
          return resolved;
        }

        function pointOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
          const dx = bx - ax, dy = by - ay;
          const lenSq = dx * dx + dy * dy;
          if (lenSq < 0.001) {
            return Math.abs(px - ax) <= EPSILON && Math.abs(py - ay) <= EPSILON;
          }
          const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
          if (t < -0.01 || t > 1.01) return false;
          const closestX = ax + t * dx;
          const closestY = ay + t * dy;
          const dist = Math.sqrt((px - closestX) ** 2 + (py - closestY) ** 2);
          return dist <= EPSILON;
        }

        function connectPinToWire(pin: PinInstance, wire: { netId: string }) {
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
        for (const wire of pageSheet.wires) {
          for (const seg of wire.segments) {
            for (const ep of [seg.start, seg.end]) {
              const pinsAtPos = findPinsAt(ep.x, ep.y);
              for (const { comp, pinIdx } of pinsAtPos) {
                connectPinToWire(comp.pins[pinIdx], wire);
              }
            }
          }
          for (const seg of wire.segments) {
            for (const pinEntry of allPins) {
              if (pointOnSegment(pinEntry.x, pinEntry.y, seg.start.x, seg.start.y, seg.end.x, seg.end.y)) {
                connectPinToWire(pinEntry.comp.pins[pinEntry.pinIdx], wire);
              }
            }
          }
        }

        // Second pass: merge wires sharing endpoints
        const endpointToNetId = new Map<string, string>();
        for (const wire of pageSheet.wires) {
          for (const seg of wire.segments) {
            for (const pt of [seg.start, seg.end]) {
              const key = `${pt.x},${pt.y}`;
              const existing = endpointToNetId.get(key);
              if (existing) {
                const re = resolveNet(existing), rw = resolveNet(wire.netId);
                if (re !== rw) netMerges.set(rw, re);
              } else {
                endpointToNetId.set(key, resolveNet(wire.netId));
              }
            }
          }
        }

        // Apply net merges
        for (const wire of pageSheet.wires) wire.netId = resolveNet(wire.netId);
        for (const comp of pageSheet.components) {
          for (const pin of comp.pins) {
            if (pin.netId) pin.netId = resolveNet(pin.netId);
          }
        }

        // Assign net names from labels
        for (const label of pageSheet.labels) {
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
                const net = getOrAddNet(label.netName);
                pin.netId = net.id;
              }
            }
          }
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

        // Clean up unused nets
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
  } catch (e) {
    console.error(`${C.red}✗ Failed to parse documents:${C.reset}`, e);
  }

  if (doc.sheets.length > 0) {
    doc.name = doc.sheets[0].name || 'Imported Pro Circuit';
  }

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

  return { doc, library };
}

// ─── Main ───

async function main() {
  const resolvedPath = path.resolve(filePath!);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`${C.red}✗ File not found: ${resolvedPath}${C.reset}`);
    process.exit(1);
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  let doc: CircuitDocument;
  let library: Map<string, ComponentDefinition>;

  const startTime = Date.now();

  if (ext === '.json') {
    printHeader(resolvedPath, 'EasyEDA Standard (.json)');

    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`${C.red}✗ Invalid JSON: ${(e as Error).message}${C.reset}`);
      process.exit(1);
    }

    // Check if it's a multi-page document (array of docs or has schematics property)
    const easyEdaDoc = parsed as EasyEDADocument;

    if (flags.raw) {
      console.log(`\n${C.bold}${C.magenta}  Raw Shapes (${easyEdaDoc.shape?.length || 0}):${C.reset}`);
      for (const shape of easyEdaDoc.shape || []) {
        const type = shape.split('~')[0].split('#@$')[0];
        console.log(`\n  ${C.cyan}[${type}]${C.reset} ${C.dim}${shape.substring(0, 150)}${shape.length > 150 ? '...' : ''}${C.reset}`);
      }
    }

    const result = importFromEasyEDA(easyEdaDoc);
    doc = result.doc;
    library = result.library;

  } else if (ext === '.eprj') {
    printHeader(resolvedPath, 'EasyEDA Pro (.eprj)');

    const fileBuffer = fs.readFileSync(resolvedPath);

    // Show SQLite table info
    try {
      const SQL = await initSqlJs();
      const db = new SQL.Database(new Uint8Array(fileBuffer));

      console.log(`\n  ${C.bold}Database Tables:${C.reset}`);
      const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
      if (tables.length > 0) {
        for (const row of tables[0].values) {
          const tableName = row[0] as string;
          const count = db.exec(`SELECT COUNT(*) FROM "${tableName}"`);
          const rowCount = count[0]?.values[0]?.[0] || 0;
          console.log(`    ${C.dim}${tableName}: ${rowCount} rows${C.reset}`);
        }
      }

      // Show document types
      try {
        const docTypes = db.exec("SELECT docType, COUNT(*), GROUP_CONCAT(COALESCE(display_title, title), ', ') FROM documents GROUP BY docType");
        if (docTypes.length > 0) {
          console.log(`\n  ${C.bold}Document Types:${C.reset}`);
          const typeNames: Record<number, string> = { 1: 'Schematic', 2: 'Symbol', 3: 'PCB', 4: 'Footprint' };
          for (const row of docTypes[0].values) {
            const dt = row[0] as number;
            const count = row[1] as number;
            const titles = row[2] as string;
            console.log(`    ${C.dim}Type ${dt} (${typeNames[dt] || 'Unknown'}): ${count} — ${titles}${C.reset}`);
          }
        }
      } catch { /* documents table might not have display_title */ }

      db.close();
    } catch (e) {
      console.warn(`${C.yellow}⚠ Could not inspect database: ${(e as Error).message}${C.reset}`);
    }

    const result = await importProFormat(fileBuffer);
    doc = result.doc;
    library = result.library;

  } else {
    console.error(`${C.red}✗ Unsupported file extension: ${ext}${C.reset}`);
    console.error(`  Supported: .json (standard), .eprj (Pro)`);
    process.exit(1);
  }

  const elapsed = Date.now() - startTime;
  console.log(`\n  ${C.dim}Import completed in ${elapsed}ms${C.reset}`);
  console.log(`  ${C.dim}Document: "${doc.name}" — ${doc.sheets.length} sheet(s)${C.reset}`);
  console.log(`  ${C.dim}Library: ${library.size} definitions${C.reset}`);

  // Print sheet reports
  for (let i = 0; i < doc.sheets.length; i++) {
    printSheetReport(doc.sheets[i], library, i);
  }

  // Component detail
  if (flags.component) {
    const target = flags.component.toUpperCase();
    for (const sheet of doc.sheets) {
      const comp = sheet.components.find(c => c.designator.toUpperCase() === target);
      if (comp) {
        printComponentDetail(comp, library, sheet);
      }
    }
  }

  // Library dump
  if (flags.library) {
    printLibrary(library);
  }

  // Net detail
  if (flags.nets) {
    printNetDetail(doc);
  }

  // JSON dump
  if (flags.json) {
    console.log(`\n${C.bold}${C.magenta}${'─'.repeat(45)}${C.reset}`);
    console.log(`${C.bold}${C.magenta}  Full JSON Dump${C.reset}`);
    console.log(`${C.bold}${C.magenta}${'─'.repeat(45)}${C.reset}`);
    console.log(JSON.stringify({
      document: doc,
      library: Object.fromEntries(library),
    }, null, 2));
  }

  console.log('');
}

main().catch(err => {
  console.error(`${C.red}✗ Fatal error:${C.reset}`, err);
  process.exit(1);
});
