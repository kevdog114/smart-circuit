// ============================================================
// EasyEDA Standard JSON Serializer
// Converts CircuitDocument → EasyEDA Standard (.json) format
// Matches official format: https://docs.easyeda.com/en/DocumentFormat/2-EasyEDA-Schematic-File-Format/
// ============================================================

import type {
  CircuitDocument,
  Component,
  ComponentDefinition,
  Junction,
  Net,
  NetLabel,
  PinDefinition,
  PinType,
  Point,
  Sheet,
  SymbolGraphic,
  Wire,
} from '../core/types';
import type { FootprintDefinition, PadDefinition } from '../library/easyeda-parser';
import { createIdGenerator, type IdGenerator } from './easyeda-id-gen';

// ----- Public Types -----

export interface EasyEDADocument {
  docType: string;
  head: EasyEDAHead;
  canvas: string;
  shape: string[];
  title: string;
  BBox: { x: number; y: number; width: number; height: number };
  colors: Record<string, unknown>;
  routerRule: Record<string, unknown>;
  netColors: Record<string, unknown>;
  /** Embedded footprint documents (docType '4'), keyed by package name */
  packageDetails?: EasyEDAFootprintDoc[];
}

interface EasyEDAHead {
  docType: string;
  editorVersion: string;
  title: string;
  description: string;
  c_para: Record<string, unknown>;
  x: string;
  y: string;
  hasId498: boolean;
}

export interface EasyEDAFootprintDoc {
  docType: '4';
  head: EasyEDAHead;
  canvas: string;
  shape: string[];
  title: string;
  BBox: { x: number; y: number; width: number; height: number };
}

// ----- Pin Type Mapping -----

const PIN_TYPE_MAP: Record<PinType, number> = {
  unspecified: 0,
  input: 1,
  output: 2,
  bidirectional: 3,
  passive: 4,
  power: 5,
  open_collector: 6,
  open_emitter: 7,
};

// ----- Default Colors -----

const WIRE_COLOR = '#008800';
const PIN_COLOR = '#880000';
const STROKE_COLOR = '#A00000';
const TEXT_COLOR = '#000080';
const JUNCTION_COLOR = '#CC0000';

// ----- Main Export Function -----

/**
 * Serialize a CircuitDocument to EasyEDA Standard JSON format.
 * Embeds footprint definitions as `packageDetails` when a footprintMap is provided.
 * If a `sheet` is provided, serializes that sheet; otherwise defaults to the first sheet.
 */
export function serializeToEasyEDA(
  doc: CircuitDocument,
  libraryMap: Map<string, ComponentDefinition>,
  footprintMap?: Map<string, FootprintDefinition>,
  sheet?: Sheet
): EasyEDADocument {
  const nextId = createIdGenerator();
  const targetSheet = sheet ?? doc.sheets[0];
  if (!targetSheet) {
    throw new Error('Document has no sheets');
  }

  const shapes: string[] = [];

  // Build a net lookup for wire/junction net names
  const netMap = new Map<string, Net>();
  for (const net of targetSheet.nets) {
    netMap.set(net.id, net);
  }

  // --- Components ---
  for (const comp of targetSheet.components) {
    const def = libraryMap.get(comp.libraryId);
    if (!def) continue;

    // Power symbols → F shape
    if (comp.designator.startsWith('#PWR')) {
      shapes.push(powerFlagToShape(comp, def, nextId));
    } else {
      shapes.push(componentToShape(comp, def, nextId, footprintMap));
    }
  }

  // --- Wires ---
  for (const wire of targetSheet.wires) {
    shapes.push(wireToShape(wire, nextId));
  }

  // --- Net Labels ---
  for (const label of targetSheet.labels) {
    shapes.push(netLabelToShape(label, nextId));
  }

  // --- Junctions ---
  for (const junction of targetSheet.junctions) {
    shapes.push(junctionToShape(junction, nextId));
  }

  // --- BBox ---
  const bbox = computeBBox(targetSheet.components, targetSheet.wires);

  // --- Footprint documents (embedded as packageDetails) ---
  const packageDetails: EasyEDAFootprintDoc[] = [];
  if (footprintMap && footprintMap.size > 0) {
    const emittedFootprints = new Set<string>();

    for (const comp of targetSheet.components) {
      const def = libraryMap.get(comp.libraryId);
      if (!def) continue;

      // Look up footprint by LCSC number, then by library ID
      const lcsc = comp.properties?.lcsc || def.properties?.lcsc || '';
      const fpKey = lcsc || comp.libraryId;
      const fp = footprintMap.get(fpKey) || footprintMap.get(comp.libraryId);
      if (!fp || emittedFootprints.has(fp.id)) continue;

      emittedFootprints.add(fp.id);
      packageDetails.push(footprintToDocument(fp, nextId));
    }
  }

  const result: EasyEDADocument = {
    docType: '1',
    head: {
      docType: '1',
      editorVersion: '6.5.40',
      title: doc.name,
      description: doc.metadata.description || '',
      c_para: {},
      x: '0',
      y: '0',
      hasId498: true,
    },
    canvas: buildCanvasString(),
    shape: shapes,
    title: doc.name,
    BBox: bbox,
    colors: {},
    routerRule: {},
    netColors: {},
  };

  if (packageDetails.length > 0) {
    result.packageDetails = packageDetails;
  }

  return result;
}

/**
 * Serialize all sheets in a CircuitDocument to an array of EasyEDA documents (one per sheet).
 */
export function serializeAllSheetsToEasyEDA(
  doc: CircuitDocument,
  libraryMap: Map<string, ComponentDefinition>,
  footprintMap?: Map<string, FootprintDefinition>
): EasyEDADocument[] {
  return doc.sheets.map(sheet => serializeToEasyEDA(doc, libraryMap, footprintMap, sheet));
}

// ----- Canvas -----

function buildCanvasString(): string {
  // CA~viewBoxW~viewBoxH~bgColor~gridVisible~gridColor~gridSize~canvasW~canvasH~gridStyle~snapSize~unit~altSnap~originX~originY
  return 'CA~1200~1200~#FFFFFF~yes~#CCCCCC~10~1200~1200~line~10~pixel~5~400~300';
}

// ----- Component → LIB Shape -----

function componentToShape(
  comp: Component,
  def: ComponentDefinition,
  nextId: IdGenerator,
  footprintMap?: Map<string, FootprintDefinition>
): string {
  const libId = nextId();
  const rotation = comp.rotation || 0;
  const cx = comp.position.x;
  const cy = comp.position.y;

  // LIB header with backtick-delimited properties
  // Format: LIB~x~y~c_para~~rotation~id~locked
  // The `package` c_para field is how EasyEDA links to footprints in its library.
  // EasyEDA uses naming convention: prefix + package size (e.g., R0805, C0402, U_SOIC-8)
  const lcsc = comp.properties?.lcsc || def.properties?.lcsc || '';
  const mpn = comp.properties?.mpn || def.properties?.mpn || def.mpn || '';
  const pkg = comp.properties?.package || def.properties?.package || '';
  // Try to get the real EasyEDA package name from the footprint definition
  const fpKey = lcsc || comp.libraryId;
  const fp = footprintMap?.get(fpKey) || footprintMap?.get(comp.libraryId);
  const fpName = (fp?.name && !fp.name.startsWith('Generic-')) ? fp.name : '';
  // Build EasyEDA-compatible package name: prefer footprint name, then prefix + package
  const prefix = def.designatorPrefix || comp.designator.replace(/[0-9]+$/, '') || '';
  const easyedaPkg = fpName || (pkg ? `${prefix}${pkg}` : '');
  const packageField = easyedaPkg || pkg || def.name;
  let propsStr = `package\`${packageField}\`nameAlias\`${def.name}\`${def.name}\`${comp.value}\``;
  // Footprint property: EasyEDA reads this from the `package` field, but also
  // looks for an explicit `Footprint` c_para key as a fallback
  propsStr += `Footprint\`${packageField}\``;
  // Supplier fields — EasyEDA uses these to resolve components from its JLCPCB library
  if (lcsc) {
    propsStr += `Supplier\`LCSC\``;
    propsStr += `Supplier Part\`${lcsc}\``;
    propsStr += `BOM_JLCPCB Part Class\`${lcsc}\``;
  }
  if (mpn) propsStr += `BOM_Manufacturer Part\`${mpn}\``;
  const header = `LIB~${cx}~${cy}~${propsStr}~~${rotation}~${libId}`;

  // Nested shapes (all use absolute coordinates)
  const nestedShapes: string[] = [];

  // Designator text (T~P prefix for component prefix/designator)
  const desPos = def.symbol.designatorPosition;
  nestedShapes.push(
    `T~P~${cx + desPos.x}~${cy + desPos.y}~0~${TEXT_COLOR}~Arial~~~~~comment~${comp.designator}~1~start~${nextId()}`
  );

  // Value text (T~N prefix for name/value)
  const valPos = def.symbol.valuePosition;
  nestedShapes.push(
    `T~N~${cx + valPos.x}~${cy + valPos.y}~0~${TEXT_COLOR}~Arial~~~~~comment~${comp.value}~1~start~${nextId()}`
  );

  // Symbol graphics (lines, rects, circles, etc.) — offset to absolute coords
  for (const graphic of def.symbol.graphics) {
    const shape = symbolGraphicToShape(graphic, cx, cy, nextId);
    if (shape) nestedShapes.push(shape);
  }

  // Pins — offset to absolute coords
  for (const pin of def.symbol.pins) {
    nestedShapes.push(pinToShape(pin, cx, cy, nextId));
  }

  // Join nested shapes with #@$ delimiter (EasyEDA LIB format)
  return header + '#@$' + nestedShapes.join('#@$');
}

// ----- Power Flag → F Shape -----

function powerFlagToShape(
  comp: Component,
  def: ComponentDefinition,
  nextId: IdGenerator
): string {
  const netName = comp.value || def.name;
  const cx = comp.position.x;
  const cy = comp.position.y;
  const rotation = comp.rotation || 0;
  const flagId = nextId();

  // F header using ^^ sub-parts (like official format)
  // F~part_id~x~y~rotation~id^^pinDotX~pinDotY^^label~color~textX~textY~rotation~textAnchor~visible~fontFamily~fontSize^^shapes...
  const partId = `part_netLabel_${netName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

  // Build the graphics for the power symbol
  const graphicParts: string[] = [];
  for (const graphic of def.symbol.graphics) {
    const shape = symbolGraphicToShape(graphic, cx, cy, nextId);
    if (shape) graphicParts.push(shape);
  }

  return [
    `F~${partId}~${cx}~${cy}~${rotation}~${flagId}`,
    `${cx}~${cy}`, // pin dot
    `${netName}~${TEXT_COLOR}~${cx - 11}~${cy - 13}~0~start~0~Times New Roman~9pt`, // label
    ...graphicParts, // symbol graphics
  ].join('^^');
}

// ----- Wire → W Shape -----

function wireToShape(wire: Wire, nextId: IdGenerator): string {
  if (wire.segments.length === 0) {
    return `W~0 0~${WIRE_COLOR}~1~0~none~${nextId()}`;
  }

  // Deduplicate consecutive points
  const points: Point[] = [wire.segments[0].start];
  for (const seg of wire.segments) {
    const last = points[points.length - 1];
    if (seg.start.x !== last.x || seg.start.y !== last.y) {
      points.push(seg.start);
    }
    points.push(seg.end);
  }

  const pointStr = points.map(p => `${p.x} ${p.y}`).join(' ');

  // W~points~color~strokeWidth~strokeStyle~fillColor~id
  return `W~${pointStr}~${WIRE_COLOR}~1~0~none~${nextId()}`;
}

// ----- Net Label → N Shape -----

function netLabelToShape(label: NetLabel, nextId: IdGenerator): string {
  const x = label.position.x;
  const y = label.position.y;
  const rot = label.rotation || 0;
  const id = nextId();

  // N~pinDotX~pinDotY~rotation~color~name~id~textAnchor~textX~textY~fontFamily~fontSize
  return `N~${x}~${y}~${rot}~#0000FF~${label.netName}~${id}~start~${x + 2}~${y}~Times New Roman~`;
}

// ----- Junction → J Shape -----

function junctionToShape(junction: Junction, nextId: IdGenerator): string {
  // J~x~y~radius~fillColor~id
  return `J~${junction.position.x}~${junction.position.y}~2.5~${JUNCTION_COLOR}~${nextId()}`;
}

// ----- Pin → P Shape (with ^^ sub-parts) -----

function pinToShape(pin: PinDefinition, cx: number, cy: number, nextId: IdGenerator): string {
  const electricCode = PIN_TYPE_MAP[pin.type] ?? 0;
  const pinId = nextId();

  // In our app, pin.position IS the connection point (where wires attach).
  // The pin dot in EasyEDA must be exactly at this position so wires connect.
  const dotX = cx + pin.position.x;
  const dotY = cy + pin.position.y;

  // Calculate body-side position and pin rotation
  // In EasyEDA format: configure position = body-side, pin dot = connection point
  const len = pin.length || 10;
  let bodyX = dotX;
  let bodyY = dotY;
  let pinRotation = 0; // EasyEDA rotation: 0=right, 90=down, 180=left, 270=up
  let pathStr = '';

  switch (pin.orientation) {
    case 'left':
      // Pin extends left: dot at left end, body at right end
      bodyX = dotX + len;
      pinRotation = 180;
      pathStr = `M ${bodyX} ${bodyY} h -${len}`;
      break;
    case 'right':
      // Pin extends right: dot at right end, body at left end
      bodyX = dotX - len;
      pinRotation = 0;
      pathStr = `M ${bodyX} ${bodyY} h ${len}`;
      break;
    case 'up':
      // Pin extends up: dot at top, body at bottom
      bodyY = dotY + len;
      pinRotation = 270;
      pathStr = `M ${bodyX} ${bodyY} v -${len}`;
      break;
    case 'down':
      // Pin extends down: dot at bottom, body at top
      bodyY = dotY - len;
      pinRotation = 90;
      pathStr = `M ${bodyX} ${bodyY} v ${len}`;
      break;
    default:
      bodyX = dotX - len;
      pinRotation = 0;
      pathStr = `M ${bodyX} ${bodyY} h ${len}`;
      break;
  }

  // EasyEDA pin format (official: 7 ^^ sections):
  // 1. P~show~electric~spicePinNum~posX~posY~rotation~id~locked
  //    posX/posY = body-side position, rotation = pin direction
  // 2. pinDotX~pinDotY  (connection point where wires attach)
  // 3. pathStr~#color   (SVG path from body to dot)
  // 4. nameVisible~nameX~nameY~nameRotation~nameText~nameAnchor~nameFontFamily~nameFontSize
  // 5. numVisible~numX~numY~numRotation~numText~numAnchor~numFontFamily~numFontSize
  // 6. dotVisible~dotCx~dotCy
  // 7. clockVisible~clockPath

  // Name/number positioned between dot and body
  const nameX = Math.round((dotX + bodyX) / 2);
  const nameY = dotY - 3;
  const numX = Math.round((dotX + bodyX) / 2);
  const numY = dotY + 3;

  return [
    `P~show~${electricCode}~${pin.id}~${bodyX}~${bodyY}~${pinRotation}~${pinId}`,  // 1: configure (body-side pos + rotation)
    `${dotX}~${dotY}`,                                                               // 2: pin dot (connection point)
    `${pathStr}~${PIN_COLOR}`,                                                       // 3: path from body to dot
    `0~${nameX}~${nameY}~0~${pin.name}~start~~`,                                    // 4: name
    `0~${numX}~${numY}~0~${pin.id}~start~~`,                                        // 5: number
    `0~${dotX}~${dotY}`,                                                             // 6: dot (not-circle)
    `0~`,                                                                            // 7: clock
  ].join('^^');
}

// ----- Symbol Graphics (absolute coords) -----

function symbolGraphicToShape(
  graphic: SymbolGraphic,
  cx: number,
  cy: number,
  nextId: IdGenerator
): string {
  const p = graphic.properties;

  switch (graphic.type) {
    case 'line': {
      const x1 = (p['x1'] as number) + cx;
      const y1 = (p['y1'] as number) + cy;
      const x2 = (p['x2'] as number) + cx;
      const y2 = (p['y2'] as number) + cy;
      // PL~points~strokeColor~strokeWidth~strokeStyle~fillColor~id
      return `PL~${x1} ${y1} ${x2} ${y2}~${STROKE_COLOR}~1~0~none~${nextId()}`;
    }

    case 'rect': {
      const x = (p['x'] as number) + cx;
      const y = (p['y'] as number) + cy;
      const w = p['width'] as number;
      const h = p['height'] as number;
      const fill = (p['fill'] as string) || 'none';
      // R~x~y~rx~ry~width~height~strokeColor~strokeWidth~strokeStyle~fillColor~id
      return `R~${x - w / 2}~${y - h / 2}~0~0~${w}~${h}~${STROKE_COLOR}~1~0~${fill}~${nextId()}`;
    }

    case 'circle': {
      const ccx = (p['cx'] as number) + cx;
      const ccy = (p['cy'] as number) + cy;
      const r = p['r'] as number;
      // E~cx~cy~rx~ry~strokeColor~strokeWidth~strokeStyle~fillColor~id
      return `E~${ccx}~${ccy}~${r}~${r}~${STROKE_COLOR}~1~0~none~${nextId()}`;
    }

    case 'polyline': {
      const pts = p['points'] as Point[];
      if (!pts || pts.length === 0) return '';
      const ptStr = pts.map(pt => `${pt.x + cx} ${pt.y + cy}`).join(' ');
      return `PL~${ptStr}~${STROKE_COLOR}~1~0~none~${nextId()}`;
    }

    case 'polygon': {
      const pts = p['points'] as Point[];
      if (!pts || pts.length === 0) return '';
      const allPts = [...pts, pts[0]];
      const ptStr = allPts.map(pt => `${pt.x + cx} ${pt.y + cy}`).join(' ');
      return `PL~${ptStr}~${STROKE_COLOR}~1~0~none~${nextId()}`;
    }

    case 'arc': {
      const x1 = (p['x1'] as number) + cx;
      const y1 = (p['y1'] as number) + cy;
      const x2 = (p['x2'] as number) + cx;
      const y2 = (p['y2'] as number) + cy;
      const rx = (p['rx'] as number) || 10;
      const ry = (p['ry'] as number) || rx;
      const largeArc = (p['largeArc'] as number) || 0;
      const sweep = (p['sweep'] as number) || 0;
      const pathStr = `M ${x1} ${y1} A ${rx} ${ry} 0 ${largeArc} ${sweep} ${x2} ${y2}`;
      // A~pathString~helperDots~strokeColor~strokeWidth~strokeStyle~fillColor~id
      return `A~${pathStr}~~${STROKE_COLOR}~1~0~none~${nextId()}`;
    }

    case 'text': {
      const x = ((p['x'] as number) || 0) + cx;
      const y = ((p['y'] as number) || 0) + cy;
      const text = (p['text'] as string) || '';
      // T~L~x~y~rotation~color~fontFamily~fontSize~fontWeight~fontStyle~dominantBaseline~textType~string~visible~textAnchor~id
      return `T~L~${x}~${y}~0~${TEXT_COLOR}~Arial~~~~~comment~${text}~1~start~${nextId()}`;
    }

    default:
      return '';
  }
}

// ----- BBox Computation -----

function computeBBox(
  components: Component[],
  wires: Wire[]
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const expand = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const comp of components) {
    expand(comp.position.x - 50, comp.position.y - 50);
    expand(comp.position.x + 50, comp.position.y + 50);
  }

  for (const wire of wires) {
    for (const seg of wire.segments) {
      expand(seg.start.x, seg.start.y);
      expand(seg.end.x, seg.end.y);
    }
  }

  // Fallback for empty schematics
  if (minX === Infinity) {
    return { x: 0, y: 0, width: 1000, height: 1000 };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

// ----- Footprint → docType '4' -----

/** Convert mm to EasyEDA internal units (inverse of server's toMM = val * 10 * 0.0254). */
function mmToEasyEDA(mm: number): number {
  return Math.round(mm / (10 * 0.0254) * 100) / 100;
}

/**
 * Generate an EasyEDA footprint document (docType '4') from a FootprintDefinition.
 */
function footprintToDocument(
  fp: FootprintDefinition,
  nextId: IdGenerator
): EasyEDAFootprintDoc {
  const shapes: string[] = [];

  // PAD shapes
  for (const pad of fp.pads) {
    shapes.push(padToShape(pad, nextId));
  }

  // Silkscreen TRACK shapes
  for (const silk of fp.silkscreen) {
    if (silk.type === 'line' && silk.points.length >= 2) {
      const layerId = silk.layer === 'B.SilkS' ? 4 : 3;
      const sw = mmToEasyEDA(silk.strokeWidth);
      const pts = silk.points.map(p => `${mmToEasyEDA(p.x)} ${mmToEasyEDA(p.y)}`).join(' ');
      shapes.push(`TRACK~${sw}~${layerId}~~${pts}~${nextId()}~0`);
    }
  }

  // Courtyard outline as a silkscreen rectangle (layer 3 = F.SilkS)
  if (fp.courtyard && shapes.every(s => !s.startsWith('TRACK~'))) {
    const cx = mmToEasyEDA(fp.courtyard.x);
    const cy = mmToEasyEDA(fp.courtyard.y);
    const cw = mmToEasyEDA(fp.courtyard.width);
    const ch = mmToEasyEDA(fp.courtyard.height);
    const pts = [
      `${cx} ${cy}`,
      `${cx + cw} ${cy}`,
      `${cx + cw} ${cy + ch}`,
      `${cx} ${cy + ch}`,
      `${cx} ${cy}`,
    ].join(' ');
    shapes.push(`TRACK~0.6~3~~${pts}~${nextId()}~0`);
  }

  // Build c_para with package info — if we have a packageUuid, include
  // the 'pre' and 'Contributor' fields that EasyEDA expects for library footprints
  const cPara: Record<string, unknown> = { package: fp.name };
  if (fp.packageUuid) {
    cPara['Contributor'] = 'LCSC';
  }

  const fpDoc: EasyEDAFootprintDoc = {
    docType: '4' as const,
    head: {
      docType: '4',
      editorVersion: '6.5.40',
      title: fp.name,
      description: `PCB Footprint: ${fp.name}`,
      c_para: cPara,
      x: '0',
      y: '0',
      hasId498: true,
    },
    canvas: 'CA~1200~1200~#000000~yes~#191919~10~1200~1200~line~10~mil~5~400~300',
    shape: shapes,
    title: fp.name,
    BBox: {
      x: mmToEasyEDA(fp.courtyard.x),
      y: mmToEasyEDA(fp.courtyard.y),
      width: mmToEasyEDA(fp.courtyard.width),
      height: mmToEasyEDA(fp.courtyard.height),
    },
  };

  // If we have the real EasyEDA footprint UUID, embed it so EasyEDA
  // can match this to its own library on import
  if (fp.packageUuid) {
    (fpDoc as any).uuid = fp.packageUuid;
    (fpDoc.head as any).uuid = fp.packageUuid;
  }

  return fpDoc;
}

/**
 * Convert a PadDefinition to an EasyEDA PAD~ shape string.
 * Format: PAD~shape~cx~cy~width~height~layerId~net~number~holeRadius~points~rotation~id~locked
 */
function padToShape(pad: PadDefinition, nextId: IdGenerator): string {
  const cx = mmToEasyEDA(pad.x);
  const cy = mmToEasyEDA(pad.y);
  const w = mmToEasyEDA(pad.width);
  const h = mmToEasyEDA(pad.height);
  const layerId = padLayerToId(pad.layer);
  const holeRadius = pad.drill ? mmToEasyEDA(pad.drill / 2) : 0;
  const rotation = pad.rotation || 0;

  let shapeStr = 'RECT';
  if (pad.shape === 'circle') shapeStr = 'ELLIPSE';
  else if (pad.shape === 'oval') shapeStr = 'OVAL';

  // PAD~shape~cx~cy~w~h~layer~net~number~holeR~points~rot~id~locked
  return `PAD~${shapeStr}~${cx}~${cy}~${w}~${h}~${layerId}~~${pad.pinId}~${holeRadius}~~${rotation}~${nextId()}~0`;
}

function padLayerToId(layer: string): number {
  switch (layer) {
    case 'F.Cu': return 1;
    case 'B.Cu': return 2;
    case 'F.SilkS': return 3;
    case 'B.SilkS': return 4;
    case 'In1.Cu': return 11;
    case 'In2.Cu': return 12;
    default: return 1;
  }
}
