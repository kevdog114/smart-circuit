// ============================================================
// KiCad Schematic Serializer
// Converts CircuitDocument → KiCad .kicad_sch S-expression format
// Spec: https://dev-docs.kicad.org/en/file-formats/sexpr-schematic/
// ============================================================

import type {
  CircuitDocument,
  Component,
  ComponentDefinition,
  Junction,
  NetLabel,
  PinDefinition,
  PinType,
  SymbolGraphic,
  Wire,
} from '../core/types';

// ----- Coordinate Conversion -----
// Our canvas: 1 unit = 10 mils. KiCad schematic: mm.
const PX_TO_MM = 0.254; // 10 mils = 0.254mm

function mm(px: number): number {
  return Math.round(px * PX_TO_MM * 1000) / 1000;
}

// ----- UUID Generation -----

let uuidCounter = 0;
function resetUuids() { uuidCounter = 0; }
function uuid(): string {
  uuidCounter++;
  const hex = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-0000-0000-${hex}`;
}

// ----- Pin Type Mapping -----

const PIN_TYPE_MAP: Record<PinType, string> = {
  unspecified: 'unspecified',
  input: 'input',
  output: 'output',
  bidirectional: 'bidirectional',
  passive: 'passive',
  power: 'power_in',
  open_collector: 'open_collector',
  open_emitter: 'open_emitter',
};

// ----- Pin Orientation Mapping -----
// Our orientation = direction pin faces outward from symbol
// KiCad rotation = direction from connection point TOWARD symbol body
// left→0°, right→180°, up→270°, down→90°
const PIN_ANGLE: Record<string, number> = {
  left: 0,
  right: 180,
  up: 270,
  down: 90,
};

// ----- Footprint Name Mapping -----

const IMPERIAL_TO_METRIC: Record<string, string> = {
  '0201': '0603',
  '0402': '1005',
  '0603': '1608',
  '0805': '2012',
  '1206': '3216',
  '1210': '3225',
  '1812': '4532',
  '2010': '5025',
  '2512': '6332',
};

const PREFIX_TO_LIBRARY: Record<string, string> = {
  R: 'Resistor_SMD',
  C: 'Capacitor_SMD',
  L: 'Inductor_SMD',
};

/**
 * Map designator prefix + package size to footprint name.
 * Uses EasyEDA-compatible names (e.g., "R0805", "C0402") since the primary
 * import target is EasyEDA, which recognizes these names from its own library.
 * For pure KiCad usage, these would be "Resistor_SMD:R_0805_2012Metric" etc.,
 * but EasyEDA's KiCad importer strips library references it can't resolve.
 */
export function toKiCadFootprint(prefix: string, pkg: string): string {
  if (!pkg) return '';

  // Standard SMD passives: prefix + imperial size (e.g., R0805, C0402, L1206)
  if (PREFIX_TO_LIBRARY[prefix] && IMPERIAL_TO_METRIC[pkg]) {
    return `${prefix}${pkg}`;
  }

  // Diodes — use EasyEDA package names directly
  if (prefix === 'D') {
    const known = ['SOD-123', 'SOD-323', 'SMA', 'SMB', 'SMC'];
    if (known.includes(pkg)) return pkg;
  }

  // Transistors
  if (prefix === 'Q') {
    const known = ['SOT-23', 'SOT-23-3', 'SOT-223', 'TO-92', 'TO-220'];
    if (known.includes(pkg)) return pkg;
  }

  // Connectors — pin headers
  if (prefix === 'J') {
    const headerMatch = pkg.match(/1[x×](\d+)/i);
    if (headerMatch) return `HDR-${headerMatch[1]}`;
  }

  // ICs — pass through package name directly
  if (prefix === 'U' && pkg) {
    return pkg;
  }

  // Fallback: prefix + package
  return `${prefix}${pkg}`;
}

// ----- S-expression Helpers -----

function indent(level: number): string {
  return '  '.repeat(level);
}

function sxProperty(name: string, value: string, x: number, y: number, level: number, hide = false): string {
  const hideStr = hide ? ' hide' : '';
  return `${indent(level)}(property "${name}" "${escSx(value)}" (at ${mm(x)} ${mm(y)} 0)\n` +
    `${indent(level + 1)}(effects (font (size 1.27 1.27))${hideStr})\n` +
    `${indent(level)})`;
}

function escSx(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ----- Symbol Library Definition -----

function symbolLibDef(def: ComponentDefinition, level: number): string {
  const libName = `smart-circuit:${def.id}`;
  const lines: string[] = [];

  lines.push(`${indent(level)}(symbol "${libName}" (in_bom yes) (on_board yes)`);

  // Default properties (overridden per-instance)
  const desPos = def.symbol.designatorPosition;
  const valPos = def.symbol.valuePosition;
  lines.push(sxProperty('Reference', def.designatorPrefix || 'U', desPos.x, desPos.y, level + 1));
  lines.push(sxProperty('Value', def.name, valPos.x, valPos.y, level + 1));
  lines.push(sxProperty('Footprint', '', 0, 0, level + 1, true));

  // Sub-symbol for graphics: SymbolName_0_1
  lines.push(`${indent(level + 1)}(symbol "${libName}_0_1"`);
  for (const g of def.symbol.graphics) {
    const shape = graphicToSx(g, level + 2);
    if (shape) lines.push(shape);
  }
  lines.push(`${indent(level + 1)})`);

  // Sub-symbol for pins: SymbolName_1_1
  lines.push(`${indent(level + 1)}(symbol "${libName}_1_1"`);
  for (const pin of def.symbol.pins) {
    lines.push(pinToSx(pin, level + 2));
  }
  lines.push(`${indent(level + 1)})`);

  lines.push(`${indent(level)})`);
  return lines.join('\n');
}

function graphicToSx(g: SymbolGraphic, level: number): string | null {
  const ind = indent(level);
  const stroke = `(stroke (width 0) (type default))`;
  const fill = g.properties.fill
    ? `(fill (type outline))`
    : `(fill (type none))`;
  const p = g.properties as Record<string, any>;

  switch (g.type) {
    case 'rect': {
      const cx = (p.x as number) ?? 0;
      const cy = (p.y as number) ?? 0;
      const w = (p.width as number) ?? 0;
      const h = (p.height as number) ?? 0;
      return `${ind}(rectangle (start ${mm(cx - w / 2)} ${mm(cy - h / 2)}) (end ${mm(cx + w / 2)} ${mm(cy + h / 2)})\n` +
        `${ind}  ${stroke}\n${ind}  ${fill}\n${ind})`;
    }
    case 'line': {
      return `${ind}(polyline (pts (xy ${mm(p.x1 as number)} ${mm(p.y1 as number)}) (xy ${mm(p.x2 as number)} ${mm(p.y2 as number)}))\n` +
        `${ind}  ${stroke}\n${ind}  ${fill}\n${ind})`;
    }
    case 'circle': {
      return `${ind}(circle (center ${mm(p.cx as number)} ${mm(p.cy as number)}) (radius ${mm(p.r as number)})\n` +
        `${ind}  ${stroke}\n${ind}  ${fill}\n${ind})`;
    }
    case 'polygon': {
      const pts = (p.points as { x: number; y: number }[])
        .map(pt => `(xy ${mm(pt.x)} ${mm(pt.y)})`).join(' ');
      const polyFill = p.fill ? `(fill (type outline))` : `(fill (type none))`;
      return `${ind}(polyline (pts ${pts})\n` +
        `${ind}  ${stroke}\n${ind}  ${polyFill}\n${ind})`;
    }
    case 'polyline': {
      const pts = (p.points as { x: number; y: number }[])
        .map(pt => `(xy ${mm(pt.x)} ${mm(pt.y)})`).join(' ');
      return `${ind}(polyline (pts ${pts})\n` +
        `${ind}  ${stroke}\n${ind}  ${fill}\n${ind})`;
    }
    case 'arc': {
      const cx = (p.cx as number) ?? 0;
      const cy = (p.cy as number) ?? 0;
      const r = (p.r as number) ?? 5;
      const startAngle = (p.startAngle as number) ?? 0;
      const endAngle = (p.endAngle as number) ?? Math.PI;
      const sx = cx + r * Math.cos(startAngle);
      const sy = cy + r * Math.sin(startAngle);
      const ex = cx + r * Math.cos(endAngle);
      const ey = cy + r * Math.sin(endAngle);
      const midAngle = (startAngle + endAngle) / 2;
      const mx = cx + r * Math.cos(midAngle);
      const my = cy + r * Math.sin(midAngle);
      return `${ind}(arc (start ${mm(sx)} ${mm(sy)}) (mid ${mm(mx)} ${mm(my)}) (end ${mm(ex)} ${mm(ey)})\n` +
        `${ind}  ${stroke}\n${ind}  ${fill}\n${ind})`;
    }
    case 'text': {
      return `${ind}(text "${escSx(String(p.text || ''))}" (at ${mm(p.x as number)} ${mm(p.y as number)} 0)\n` +
        `${ind}  (effects (font (size 1.27 1.27)))\n${ind})`;
    }
    default:
      return null;
  }
}

function pinToSx(pin: PinDefinition, level: number): string {
  const ind = indent(level);
  const elecType = PIN_TYPE_MAP[pin.type] || 'passive';
  const angle = PIN_ANGLE[pin.orientation] ?? 0;
  const len = mm(pin.length || 10);

  return `${ind}(pin ${elecType} line (at ${mm(pin.position.x)} ${mm(pin.position.y)} ${angle}) (length ${len})\n` +
    `${ind}  (name "${escSx(pin.name)}" (effects (font (size 1.27 1.27))))\n` +
    `${ind}  (number "${escSx(pin.id)}" (effects (font (size 1.27 1.27))))\n` +
    `${ind})`;
}

// ----- Placed Symbol Instance -----

function symbolInstance(
  comp: Component,
  def: ComponentDefinition,
  footprint: string,
  level: number
): string {
  const libId = `smart-circuit:${def.id}`;
  const ind = indent(level);
  const lines: string[] = [];
  const id = uuid();

  lines.push(`${ind}(symbol (lib_id "${libId}") (at ${mm(comp.position.x)} ${mm(comp.position.y)} ${comp.rotation || 0}) (unit 1)`);
  lines.push(`${indent(level + 1)}(in_bom yes) (on_board yes)`);
  lines.push(`${indent(level + 1)}(uuid "${id}")`);

  // Properties
  const desPos = def.symbol.designatorPosition;
  const valPos = def.symbol.valuePosition;
  lines.push(sxProperty('Reference', comp.designator, comp.position.x + desPos.x, comp.position.y + desPos.y, level + 1));
  lines.push(sxProperty('Value', comp.value, comp.position.x + valPos.x, comp.position.y + valPos.y, level + 1));
  lines.push(sxProperty('Footprint', footprint, comp.position.x, comp.position.y, level + 1, true));

  // LCSC and MPN as custom properties (preserved on EasyEDA import)
  const lcsc = comp.properties?.lcsc || def.properties?.lcsc || '';
  const mpn = comp.properties?.mpn || def.properties?.mpn || def.mpn || '';
  if (lcsc) lines.push(sxProperty('LCSC', lcsc, comp.position.x, comp.position.y, level + 1, true));
  if (mpn) lines.push(sxProperty('MPN', mpn, comp.position.x, comp.position.y, level + 1, true));

  // Pin UUIDs
  for (const pin of def.symbol.pins) {
    lines.push(`${indent(level + 1)}(pin "${escSx(pin.id)}" (uuid "${uuid()}"))`);
  }

  lines.push(`${ind})`);
  return lines.join('\n');
}

// ----- Wire -----

function wireToSx(wire: Wire, level: number): string {
  const ind = indent(level);
  const segments: string[] = [];

  for (const seg of wire.segments) {
    segments.push(
      `${ind}(wire (pts (xy ${mm(seg.start.x)} ${mm(seg.start.y)}) (xy ${mm(seg.end.x)} ${mm(seg.end.y)}))\n` +
      `${indent(level + 1)}(stroke (width 0) (type default))\n` +
      `${indent(level + 1)}(uuid "${uuid()}")\n` +
      `${ind})`
    );
  }

  return segments.join('\n');
}

// ----- Label -----

function labelToSx(label: NetLabel, level: number): string {
  const ind = indent(level);
  const rotation = label.rotation || 0;
  return `${ind}(label "${escSx(label.netName)}" (at ${mm(label.position.x)} ${mm(label.position.y)} ${rotation}) (fields_autoplaced yes)\n` +
    `${indent(level + 1)}(effects (font (size 1.27 1.27)) (justify left bottom))\n` +
    `${indent(level + 1)}(uuid "${uuid()}")\n` +
    `${ind})`;
}

// ----- Junction -----

function junctionToSx(junction: Junction, level: number): string {
  const ind = indent(level);
  return `${ind}(junction (at ${mm(junction.position.x)} ${mm(junction.position.y)}) (diameter 0) (color 0 0 0 0)\n` +
    `${indent(level + 1)}(uuid "${uuid()}")\n` +
    `${ind})`;
}

// ----- Main Export Function -----

/**
 * Serialize a CircuitDocument to KiCad .kicad_sch S-expression format.
 */
export function serializeToKiCad(
  doc: CircuitDocument,
  libraryMap: Map<string, ComponentDefinition>
): string {
  resetUuids();

  if (doc.sheets.length === 0) {
    throw new Error('Document has no sheets');
  }

  // Gather data from all sheets
  const allComponents = doc.sheets.flatMap(s => s.components);
  const allWires = doc.sheets.flatMap(s => s.wires);
  const allLabels = doc.sheets.flatMap(s => s.labels);
  const allJunctions = doc.sheets.flatMap(s => s.junctions);

  const lines: string[] = [];

  // ── Header ──
  lines.push('(kicad_sch (version 20231120) (generator "smart-circuit") (generator_version "1.0")');
  lines.push(`  (uuid "${uuid()}")`);
  lines.push('  (paper "A4")');
  lines.push('');

  // ── lib_symbols ──
  lines.push('  (lib_symbols');

  // Collect unique definitions used
  const usedDefs = new Map<string, ComponentDefinition>();
  for (const comp of allComponents) {
    if (comp.designator.startsWith('#PWR')) continue; // skip power symbols
    const def = libraryMap.get(comp.libraryId);
    if (def && !usedDefs.has(def.id)) {
      usedDefs.set(def.id, def);
    }
  }

  for (const def of usedDefs.values()) {
    lines.push(symbolLibDef(def, 2));
  }

  lines.push('  )');
  lines.push('');

  // ── Junctions ──
  for (const junction of allJunctions) {
    lines.push(junctionToSx(junction, 1));
  }

  // ── Wires ──
  for (const wire of allWires) {
    lines.push(wireToSx(wire, 1));
  }

  // ── Labels ──
  for (const label of allLabels) {
    lines.push(labelToSx(label, 1));
  }

  lines.push('');

  // ── Symbol Instances ──
  for (const comp of allComponents) {
    if (comp.designator.startsWith('#PWR')) continue;
    const def = libraryMap.get(comp.libraryId);
    if (!def) continue;

    // Resolve KiCad footprint name
    const pkg = comp.properties?.package || def.properties?.package || '';
    const prefix = def.designatorPrefix || comp.designator.replace(/[0-9]+$/, '') || '';
    const footprint = toKiCadFootprint(prefix, pkg);

    lines.push(symbolInstance(comp, def, footprint, 1));
  }

  lines.push('');

  // ── Sheet Instances (required by KiCad) ──
  lines.push('  (sheet_instances');
  lines.push('    (path "/" (page "1"))');
  lines.push('  )');

  lines.push(')');
  lines.push('');

  return lines.join('\n');
}
