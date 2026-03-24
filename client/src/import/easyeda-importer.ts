import type {
  CircuitDocument,
  Component,
  ComponentDefinition,
  PinDefinition,
  PinInstance,
  PinType,
  Point,
  SymbolGraphic,
  Wire,
  NetLabel,
  Junction,
  Net,
  Sheet,
} from '../core/types';
import type { EasyEDADocument } from '../export/easyeda-serializer';

// Simple UUID generator since we might not have access to an internal one easily
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const ELECTRIC_CODE_TO_PIN_TYPE: Record<number, PinType> = {
  0: 'unspecified',
  1: 'input',
  2: 'output',
  3: 'bidirectional',
  4: 'passive',
  5: 'power',
  6: 'open_collector',
  7: 'open_emitter',
};

export function importFromEasyEDA(
  easyEdaDoc: EasyEDADocument
): { doc: CircuitDocument; library: Map<string, ComponentDefinition> } {
  const library = new Map<string, ComponentDefinition>();

  const sheet: Sheet = {
    id: uuidv4(),
    name: 'Sheet 1',
    gridSize: 10,
    bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
    components: [],
    wires: [],
    labels: [],
    junctions: [],
    nets: [],
    annotations: [],
  };

  const doc: CircuitDocument = {
    id: uuidv4(),
    name: easyEdaDoc.head?.title || 'Imported Circuit',
    version: '1.0',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sheets: [sheet],
    metadata: {
      description: easyEdaDoc.head?.description || 'Imported from EasyEDA',
      author: '',
      revision: '1.0',
      tags: [],
    },
  };

  const netsByName = new Map<string, Net>();

  function getOrAddNet(name: string): Net {
    if (!name) name = `Net_${uuidv4().substring(0, 6)}`;
    if (!netsByName.has(name)) {
      const net: Net = { id: uuidv4(), name, pinIds: [], wireIds: [] };
      netsByName.set(name, net);
      sheet.nets.push(net);
    }
    return netsByName.get(name)!;
  }

  // Parse Shapes
  const shapes = easyEdaDoc.shape || [];

  for (const shapeGroupStr of shapes) {
    const lines = shapeGroupStr.split(/#@\$|\n/).filter((l) => l.trim().length > 0);
    const primaryLine = lines[0];
    const parts = primaryLine.split('~');
    const shapeType = parts[0];

    try {
      if (shapeType === 'LIB') {
        const comp = parseLibraryShape(lines, library);
        if (comp) sheet.components.push(comp);
      } else if (shapeType === 'W') {
        const wire = parseWireShape(parts, getOrAddNet);
        if (wire) sheet.wires.push(wire);
      } else if (shapeType === 'N') {
        const label = parseNetLabelShape(parts);
        if (label) sheet.labels.push(label);
      } else if (shapeType === 'F') {
        // Power flags use ^^ delimiters, pass the raw primary line
        const pwrFlagMap = parsePowerFlagShape(primaryLine);
        if (pwrFlagMap) {
          sheet.components.push(pwrFlagMap.comp);
          if (pwrFlagMap.def) library.set(pwrFlagMap.def.id, pwrFlagMap.def);
        }
      } else if (shapeType === 'J') {
        const junction = parseJunctionShape(parts);
        if (junction) sheet.junctions.push(junction);
      }
    } catch (err) {
      console.warn('Failed to parse shape:', primaryLine, err);
    }
  }

  // ─── Post-import connectivity resolution ───
  // Build spatial index of pin positions
  const pinMap = new Map<string, { comp: Component; pinIdx: number }[]>();
  for (const comp of sheet.components) {
    for (let pi = 0; pi < comp.pins.length; pi++) {
      const p = comp.pins[pi];
      const key = `${p.absolutePosition.x},${p.absolutePosition.y}`;
      if (!pinMap.has(key)) pinMap.set(key, []);
      pinMap.get(key)!.push({ comp, pinIdx: pi });
    }
  }

  // Connect wires to pins by matching endpoints
  const netMerges = new Map<string, string>();
  function resolveNet(netId: string): string {
    let resolved = netId;
    while (netMerges.has(resolved)) resolved = netMerges.get(resolved)!;
    return resolved;
  }

  for (const wire of sheet.wires) {
    for (const seg of wire.segments) {
      for (const pt of [seg.start, seg.end]) {
        const key = `${pt.x},${pt.y}`;
        const pinsAtPos = pinMap.get(key);
        if (pinsAtPos) {
          for (const { comp: c, pinIdx } of pinsAtPos) {
            const pin = c.pins[pinIdx];
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
        }
      }
    }

    // Check if any pin lies ON a wire segment (not just at endpoints).
    // Collect ALL split points on each segment, sort by position along the
    // segment, then split in order — this produces correctly ordered sub-segments.
    const EPSILON = 1.5;
    const newSegments: typeof wire.segments = [];
    for (const seg of wire.segments) {
      const dx = seg.end.x - seg.start.x, dy = seg.end.y - seg.start.y;
      const lenSq = dx * dx + dy * dy;

      // Collect pins that lie on this segment (but not at its endpoints)
      const splitPoints: { t: number; px: number; py: number; pin: typeof sheet.components[0]['pins'][0] }[] = [];
      for (const comp of sheet.components) {
        for (const pin of comp.pins) {
          const px = pin.absolutePosition.x, py = pin.absolutePosition.y;
          const atStart = Math.abs(px - seg.start.x) <= EPSILON && Math.abs(py - seg.start.y) <= EPSILON;
          const atEnd   = Math.abs(px - seg.end.x) <= EPSILON && Math.abs(py - seg.end.y) <= EPSILON;
          if (atStart || atEnd) continue;
          if (lenSq < 0.001) continue;
          const t = ((px - seg.start.x) * dx + (py - seg.start.y) * dy) / lenSq;
          if (t < -0.01 || t > 1.01) continue;
          const cx = seg.start.x + t * dx, cy = seg.start.y + t * dy;
          const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
          if (dist > EPSILON) continue;
          splitPoints.push({ t, px, py, pin });
        }
      }

      if (splitPoints.length === 0) {
        newSegments.push(seg);
      } else {
        // Sort by position along segment direction
        splitPoints.sort((a, b) => a.t - b.t);
        // Connect pins and build ordered sub-segments
        let prev = { ...seg.start };
        for (const sp of splitPoints) {
          const resolvedWireNet = resolveNet(wire.netId);
          if (sp.pin.netId && sp.pin.netId !== resolvedWireNet) {
            const resolvedPinNet = resolveNet(sp.pin.netId);
            if (resolvedPinNet !== resolvedWireNet) {
              netMerges.set(resolvedWireNet, resolvedPinNet);
            }
          } else {
            sp.pin.netId = resolvedWireNet;
          }
          newSegments.push({ start: prev, end: { x: sp.px, y: sp.py } });
          prev = { x: sp.px, y: sp.py };
        }
        newSegments.push({ start: prev, end: { ...seg.end } });
      }
    }
    wire.segments = newSegments;
  }

  // Merge wires sharing endpoints into same net
  const endpointToNetId = new Map<string, string>();
  for (const wire of sheet.wires) {
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
  for (const wire of sheet.wires) wire.netId = resolveNet(wire.netId);
  for (const comp of sheet.components) {
    for (const pin of comp.pins) {
      if (pin.netId) pin.netId = resolveNet(pin.netId);
    }
  }

  // Propagate net names from labels to connected nets
  for (const label of sheet.labels) {
    const key = `${label.position.x},${label.position.y}`;
    const pinsAtPos = pinMap.get(key);
    if (pinsAtPos) {
      for (const { comp: c, pinIdx } of pinsAtPos) {
        const pin = c.pins[pinIdx];
        if (pin.netId) {
          const net = sheet.nets.find(n => n.id === pin.netId);
          if (net && (!net.name || net.name.startsWith('Net_'))) net.name = label.netName;
        } else {
          const net = getOrAddNet(label.netName);
          pin.netId = net.id;
        }
      }
    }
  }

  return { doc, library };
}

/**
 * Import multiple EasyEDA schematic pages into a single CircuitDocument with
 * one Sheet per page. Accepts an array of EasyEDADocument objects (each with
 * docType '1'). Library definitions from all pages are merged.
 */
export function importMultipleFromEasyEDA(
  easyEdaDocs: EasyEDADocument[]
): { doc: CircuitDocument; library: Map<string, ComponentDefinition> } {
  if (easyEdaDocs.length === 0) {
    throw new Error('No schematic documents to import');
  }

  // Single page — delegate to existing function
  if (easyEdaDocs.length === 1) {
    return importFromEasyEDA(easyEdaDocs[0]);
  }

  const mergedLibrary = new Map<string, ComponentDefinition>();
  const sheets: Sheet[] = [];

  for (let i = 0; i < easyEdaDocs.length; i++) {
    const pageDoc = easyEdaDocs[i];
    const { doc: pageResult, library: pageLib } = importFromEasyEDA(pageDoc);

    // Merge library entries
    for (const [id, def] of pageLib.entries()) {
      mergedLibrary.set(id, def);
    }

    // Rename each sheet to reflect its page number / title
    const pageSheet = pageResult.sheets[0];
    const pageTitle = pageDoc.head?.title;
    pageSheet.name = pageTitle && pageTitle !== 'Imported Circuit'
      ? pageTitle
      : `Sheet ${i + 1}`;

    sheets.push(pageSheet);
  }

  // Use the first page's title for the overall document name
  const firstTitle = easyEdaDocs[0].head?.title;

  const doc: CircuitDocument = {
    id: uuidv4(),
    name: firstTitle || 'Imported Circuit',
    version: '1.0',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sheets,
    metadata: {
      description: easyEdaDocs[0].head?.description || 'Imported from EasyEDA (multi-page)',
      author: '',
      revision: '1.0',
      tags: [],
    },
  };

  return { doc, library: mergedLibrary };
}

function parseLibraryShape(
  lines: string[],
  library: Map<string, ComponentDefinition>
): Component | null {
  const header = lines[0];
  const parts = header.split('~');
  // Old format: LIB~x~y~package~rotation~importFlag~id~locked~mirror~designator~...
  // New format: LIB~x~y~package`name`nameAlias`...`~~rotation~id~locked
  const x = parseFloat(parts[1] || '0');
  const y = parseFloat(parts[2] || '0');

  // Parse package name from field 3 — may contain backtick-delimited properties
  let packageName = parts[3] || 'Unknown';
  let designator = 'U?';
  let rotation = 0;
  let easyEdaId = '';
  let mirror = false;

  if (packageName.includes('`')) {
    // New backtick format: package`C1`nameAlias`Value(F)`Value(F)`1u`spicePre`C`...
    // Official format: LIB~x~y~package`...`~~rotation~id~locked
    // After ~ split: [0]=LIB [1]=x [2]=y [3]=backtickProps [4]='' (from ~~) [5]=rotation [6]=id [7]=locked
    const backtickParts = packageName.split('`');
    // backtickParts[0]='package', [1]='C1' (designator), [2]='nameAlias', [3]=name ...
    packageName = backtickParts[1] || backtickParts[0] || 'Unknown';
    rotation = parseFloat(parts[5] || '0');
    easyEdaId = parts[6] || uuidv4();
    // The designator is often extracted from T~P text shapes below,
    // but also available as backtickParts[1] in component-type symbols
  } else {
    // Old format: LIB~x~y~package~rotation~importFlag~id~locked~mirror~designator
    rotation = parseFloat(parts[4] || '0');
    easyEdaId = parts[6] || uuidv4();
    mirror = parts[8] === '1';
    designator = parts[9] || 'U?';
  }

  let value = packageName;

  const pins: PinDefinition[] = [];
  const graphics: SymbolGraphic[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Check if this is a pin with ^^ sub-parts (new format)
    if (line.startsWith('P~') && line.includes('^^')) {
      const pin = parsePinWithSubParts(line, x, y);
      if (pin) pins.push(pin);
      continue;
    }

    const subParts = line.split('~');
    const t = subParts[0];

    if (t === 'P') {
      const pin = parsePin(subParts, x, y);
      if (pin) pins.push(pin);
    } else if (t === 'PL' || t === 'R' || t === 'E' || t === 'A' || t === 'T') {
      if (t === 'T') {
        // Official text format: T~mark~x~y~rotation~color~fontFamily~fontSize~fontWeight~fontStyle~dominantBaseline~textType~string~visible~textAnchor~id
        // mark: P=prefix/designator, N=name/value, L=label
        const mark = subParts[1];
        // String is at index 12 in the official format
        const textVal = subParts[12] || subParts[11] || '';
        if (mark === 'P' && textVal) {
          designator = textVal;
        } else if (mark === 'N' && textVal) {
          value = textVal;
        } else if (mark === 'L') {
          const oldTextVal = subParts[12] || subParts[11] || '';
          if (oldTextVal && oldTextVal !== designator && oldTextVal !== 'U?') {
            value = oldTextVal;
          }
        }
      } else {
        const g = parseGraphic(subParts, x, y);
        if (g) graphics.push(g);
      }
    }
  }

  // Compute bounding box from pins and graphics for proper symbol dimensions
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const p of pins) {
    if (p.position.x < minX) minX = p.position.x;
    if (p.position.x > maxX) maxX = p.position.x;
    if (p.position.y < minY) minY = p.position.y;
    if (p.position.y > maxY) maxY = p.position.y;
  }
  for (const g of graphics) {
    const gp = g.properties as Record<string, unknown>;
    if (g.type === 'line') {
      for (const k of ['x1', 'x2']) { const v = gp[k] as number; if (v < minX) minX = v; if (v > maxX) maxX = v; }
      for (const k of ['y1', 'y2']) { const v = gp[k] as number; if (v < minY) minY = v; if (v > maxY) maxY = v; }
    } else if (g.type === 'rect') {
      const rx = (gp['x'] as number) || 0, ry = (gp['y'] as number) || 0;
      const rw = (gp['width'] as number) || 0, rh = (gp['height'] as number) || 0;
      if (rx - rw/2 < minX) minX = rx - rw/2;
      if (rx + rw/2 > maxX) maxX = rx + rw/2;
      if (ry - rh/2 < minY) minY = ry - rh/2;
      if (ry + rh/2 > maxY) maxY = ry + rh/2;
    }
  }
  const symWidth = Math.max(20, maxX - minX + 10);
  const symHeight = Math.max(20, maxY - minY + 10);

  const defId = `lib_${uuidv4()}`;
  const def: ComponentDefinition = {
    id: defId,
    name: packageName,
    description: `Imported EasyEDA Component (${packageName})`,
    category: 'imported',
    designatorPrefix: designator.replace(/[\d]+$/, '') || 'U',
    defaultValue: value,
    properties: {},
    tags: ['imported'],
    symbol: {
      id: `sym_${defId}`,
      name: packageName,
      width: symWidth,
      height: symHeight,
      origin: { x: 0, y: 0 },
      pins,
      graphics,
      designatorPosition: { x: 0, y: minY - 10 },
      valuePosition: { x: 0, y: maxY + 10 },
    },
  };

  library.set(defId, def);

  // Build PinInstance entries (critical for rendering and wire connectivity)
  const rotRad = rotation * Math.PI / 180;
  const pinInstances: PinInstance[] = pins.map(p => {
    // Apply rotation to the pin's local position
    const rx = rotation
      ? p.position.x * Math.cos(rotRad) - p.position.y * Math.sin(rotRad)
      : p.position.x;
    const ry = rotation
      ? p.position.x * Math.sin(rotRad) + p.position.y * Math.cos(rotRad)
      : p.position.y;
    return {
      definitionId: p.id,
      componentId: easyEdaId,
      absolutePosition: {
        x: Math.round(x + rx),
        y: Math.round(y + ry),
      },
      netId: null,
    };
  });

  const comp: Component = {
    id: easyEdaId,
    libraryId: defId,
    position: { x, y },
    rotation: (rotation % 360) as 0 | 90 | 180 | 270,
    mirror,
    designator,
    value,
    pins: pinInstances,
    properties: {},
  };

  return comp;
}

function parsePinWithSubParts(line: string, offsetX: number, offsetY: number): PinDefinition | null {
  // Official format (7 ^^ sections):
  // P~show~electric~spicePinNum~posX~posY~rotation~id^^dotX~dotY^^path~color^^vis~nameX~nameY~nameRot~name~anchor~fontFamily~fontSize^^vis~numX~numY~numRot~number~anchor~fontFamily~fontSize^^dotVis~dotX~dotY^^clockVis~clockPath
  const sections = line.split('^^');
  if (sections.length < 2) return null;

  const configureParts = sections[0].split('~');
  const eCode = parseInt(configureParts[2] || '0', 10);
  const pinNum = configureParts[3] || '';
  // posX/posY in the configure section are the body-side position
  // The pin dot (connection point) is in section[1]
  let px: number, py: number;
  if (sections.length > 1 && sections[1]) {
    const dotParts = sections[1].split('~');
    px = parseFloat(dotParts[0] || '0') - offsetX;
    py = parseFloat(dotParts[1] || '0') - offsetY;
  } else {
    px = parseFloat(configureParts[4] || '0') - offsetX;
    py = parseFloat(configureParts[5] || '0') - offsetY;
  }

  // Extract pin name from section[3] (name text section)
  // Format: vis~nameX~nameY~nameRot~name~anchor~fontFamily~fontSize
  let pinName = pinNum;
  if (sections.length > 3 && sections[3]) {
    const nameParts = sections[3].split('~');
    pinName = nameParts[4] || pinNum;
  }

  // Extract pin number from section[4] (number text section)
  let pinId = pinNum;
  if (sections.length > 4 && sections[4]) {
    const numParts = sections[4].split('~');
    pinId = numParts[4] || pinNum;
  }

  return {
    id: pinId,
    name: pinName,
    type: ELECTRIC_CODE_TO_PIN_TYPE[eCode] || 'passive',
    position: { x: px, y: py },
    orientation: 'left', // Simplified
    length: 10,
  };
}

function parsePin(parts: string[], offsetX: number, offsetY: number): PinDefinition | null {
  // Official old format: P~show~electric~spicePinNum~posX~posY~x2~y2~color~pinName~pinNumber~...~id~locked
  // Index:                 0    1       2         3         4    5   6  7    8      9         10
  const eCode = parseInt(parts[2] || '0', 10);
  const px = parseFloat(parts[4] || '0') - offsetX;
  const py = parseFloat(parts[5] || '0') - offsetY;
  const name = parts[8] || '';
  const idStr = parts[9] || name;

  return {
    id: idStr,
    name,
    type: ELECTRIC_CODE_TO_PIN_TYPE[eCode] || 'passive',
    position: { x: px, y: py },
    orientation: 'left', // Simplified
    length: 10,
  };
}

function parseGraphic(parts: string[], offsetX: number, offsetY: number): SymbolGraphic | null {
  const type = parts[0];
  if (type === 'PL') {
    const ptsStr = parts[1].split(' ');
    if (ptsStr.length === 4) {
      return {
        type: 'line',
        properties: {
          x1: parseFloat(ptsStr[0]) - offsetX,
          y1: parseFloat(ptsStr[1]) - offsetY,
          x2: parseFloat(ptsStr[2]) - offsetX,
          y2: parseFloat(ptsStr[3]) - offsetY,
        },
      };
    } else {
      const points: Point[] = [];
      for (let i = 0; i < ptsStr.length; i += 2) {
        points.push({
          x: parseFloat(ptsStr[i]) - offsetX,
          y: parseFloat(ptsStr[i + 1]) - offsetY,
        });
      }
      return { type: 'polyline', properties: { points } };
    }
  } else if (type === 'R') {
    // R~x~y~rx~ry~width~height~fillColor...
    const rx = parseFloat(parts[1]) - offsetX;
    const ry = parseFloat(parts[2]) - offsetY;
    const w = parseFloat(parts[5]);
    const h = parseFloat(parts[6]);
    return {
      type: 'rect',
      properties: { x: rx + w / 2, y: ry + h / 2, width: w, height: h, fill: parts[7] || 'transparent' },
    };
  } else if (type === 'E') {
    // E~cx~cy~rx~ry...
    const cx = parseFloat(parts[1]) - offsetX;
    const cy = parseFloat(parts[2]) - offsetY;
    const r = parseFloat(parts[3]);
    return { type: 'circle', properties: { cx, cy, r } };
  } else if (type === 'T') {
    const tx = parseFloat(parts[2]) - offsetX;
    const ty = parseFloat(parts[3]) - offsetY;
    const text = parts[11] || '';
    const fontSize = parts[7] || '10px';
    const numSize = parseFloat(fontSize) || 10;
    return { type: 'text', properties: { x: tx, y: ty, text, fontSize: numSize, textAlign: 'left' } };
  }
  return null;
}

function parseWireShape(
  parts: string[],
  getOrAddNet: (n: string) => Net
): Wire | null {
  // Official format: W~points~strokeColor~strokeWidth~strokeStyle~fillColor~id
  // Index:            0  1        2          3            4          5     6
  // Note: wires don't carry net names in the official format;
  // net assignment is resolved by junction/position connectivity.
  const pointsStr = parts[1].split(' ');
  const easyEdaId = parts[6] || uuidv4();

  // Create an anonymous net for this wire; the app resolves connectivity later
  const net = getOrAddNet('');
  const segments = [];

  for (let i = 0; i < pointsStr.length - 3; i += 2) {
    segments.push({
      start: { x: parseFloat(pointsStr[i]), y: parseFloat(pointsStr[i + 1]) },
      end: { x: parseFloat(pointsStr[i + 2]), y: parseFloat(pointsStr[i + 3]) },
    });
  }

  if (segments.length === 0) return null;

  return {
    id: easyEdaId,
    netId: net.id,
    segments,
  };
}

function parseNetLabelShape(parts: string[]): NetLabel | null {
  // Official format: N~pinDotX~pinDotY~rotation~color~name~id~textAnchor~textX~textY~fontFamily~fontSize
  // Index:            0    1       2       3      4     5   6
  const x = parseFloat(parts[1]);
  const y = parseFloat(parts[2]);
  const rotation = parseFloat(parts[3]);
  const netName = parts[5];

  if (!netName) return null;

  return {
    id: parts[6] || uuidv4(),
    netName,
    position: { x, y },
    rotation,
  };
}

function parsePowerFlagShape(
  rawLine: string
): { comp: Component; def: ComponentDefinition } | null {
  // Official format uses ^^ delimiters:
  // F~partId~x~y~rotation~id^^dotX~dotY^^name~color~textX~textY~rot~anchor~vis~fontFamily~fontSize^^shapes...
  const sections = rawLine.split('^^');
  if (sections.length < 3) return null;

  // Section 0: configure — F~partId~x~y~rotation~id
  const configParts = sections[0].split('~');
  const x = parseFloat(configParts[2] || '0');
  const y = parseFloat(configParts[3] || '0');
  const rotation = parseFloat(configParts[4] || '0');
  const easyEdaId = configParts[5] || uuidv4();

  // Section 2: mark string — netName~color~textX~textY~...
  const markParts = sections[2].split('~');
  const netName = markParts[0] || '';
  if (!netName) return null;

  // Parse any nested graphics from remaining ^^ sections
  const symbolGraphics: SymbolGraphic[] = [
    { type: 'line', properties: { x1: 0, y1: 0, x2: 0, y2: -10 } },
    { type: 'line', properties: { x1: -5, y1: -10, x2: 0, y2: -15 } },
    { type: 'line', properties: { x1: 5, y1: -10, x2: 0, y2: -15 } },
    { type: 'line', properties: { x1: -5, y1: -10, x2: 5, y2: -10 } },
  ];

  const defId = 'power_sym_' + netName;
  const def: ComponentDefinition = {
    id: defId,
    name: netName,
    description: 'Power Symbol',
    category: 'power',
    designatorPrefix: '#PWR',
    defaultValue: netName,
    properties: {},
    tags: ['power'],
    symbol: {
      id: `sym_pwr_${netName}`,
      name: netName,
      width: 20,
      height: 20,
      origin: { x: 0, y: 0 },
      pins: [{ id: '1', name: 'PWR', type: 'power', position: { x: 0, y: 0 }, orientation: 'down', length: 5 }],
      graphics: symbolGraphics,
      designatorPosition: { x: 0, y: -25 },
      valuePosition: { x: 0, y: -20 },
    },
  };

  const comp: Component = {
    id: easyEdaId,
    libraryId: defId,
    position: { x, y },
    rotation: (rotation % 360) as 0 | 90 | 180 | 270,
    mirror: false,
    designator: '#PWR_' + uuidv4().substring(0, 6),
    value: netName,
    pins: [{
      definitionId: '1',
      componentId: easyEdaId,
      absolutePosition: { x, y },
      netId: null,
    }],
    properties: {},
  };

  return { comp, def };
}

function parseJunctionShape(parts: string[]): Junction | null {
  // Official format: J~x~y~radius~fillColor~id
  // Index:            0 1   2   3       4      5
  const x = parseFloat(parts[1]);
  const y = parseFloat(parts[2]);
  const id = parts[5] || uuidv4();

  return {
    id,
    position: { x, y },
    netId: '', // To be resolved later if needed
  };
}
