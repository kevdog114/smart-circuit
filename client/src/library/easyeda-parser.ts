// ============================================================
// Smart Circuit — EasyEDA Resolved Component → ComponentDefinition
// Converts server /api/components/resolve response into a
// ComponentDefinition that the canvas renderer can draw.
// ============================================================

import type { ComponentDefinition, PinDefinition, SymbolGraphic, PinType, Direction } from '../core/types';

// ----- Footprint response types (mirrors server FootprintPad / FootprintData) -----

export interface FootprintPadResponse {
  number: string;
  x: number; y: number;
  width: number; height: number;
  shape: 'rect' | 'circle' | 'oval';
  layerId: number;
  drill: number;
  rotation: number;
}

export interface FootprintResponse {
  name: string;
  packageUuid?: string;  // EasyEDA footprint library UUID
  pads: FootprintPadResponse[];
  tracks: { layerId: number; strokeWidth: number; points: string }[];
}

// Shape of the /api/components/resolve response
export interface ResolvedComponentResponse {
  lcsc: string;
  mpn: string;
  componentUuid?: string;  // EasyEDA schematic symbol UUID
  packageName: string;
  manufacturer: string;
  pinCount: number;
  pins: { number: string; name: string; type: string; x: number; y: number; rotation: number }[];
  stock: number;
  price: number;
  basic?: boolean;
  footprint?: FootprintResponse;
}

/**
 * Convert a resolved component from the server into a renderable ComponentDefinition.
 * Arranges pins in a DIP-style layout: left side and right side.
 */
export function resolvedToComponentDef(
  resolved: ResolvedComponentResponse,
  value?: string
): ComponentDefinition {
  const pins = resolved.pins;
  const pinCount = pins.length;
  if (pinCount === 0) {
    return createFallbackIC(resolved.mpn, value ?? resolved.mpn, []);
  }

  // Split pins into left and right sides
  // Convention: first half on left, second half on right
  const halfCount = Math.ceil(pinCount / 2);
  const leftPins = pins.slice(0, halfCount);
  const rightPins = pins.slice(halfCount);

  // Calculate symbol dimensions
  const pinSpacing = 20;
  const bodyWidth = 80;
  const bodyHeight = Math.max(halfCount, rightPins.length) * pinSpacing + 20;
  const halfW = bodyWidth / 2;
  const halfH = bodyHeight / 2;
  const leadLength = 20;

  // Build pin definitions
  const pinDefs: PinDefinition[] = [];

  leftPins.forEach((p, i) => {
    const y = -halfH + 20 + i * pinSpacing;
    pinDefs.push({
      id: p.number,
      name: p.name,
      type: mapPinType(p.type),
      position: { x: -(halfW + leadLength), y },
      orientation: 'left' as Direction,
      length: leadLength,
    });
  });

  rightPins.forEach((p, i) => {
    const y = -halfH + 20 + i * pinSpacing;
    pinDefs.push({
      id: p.number,
      name: p.name,
      type: mapPinType(p.type),
      position: { x: halfW + leadLength, y },
      orientation: 'right' as Direction,
      length: leadLength,
    });
  });

  // Build graphics
  const graphics: SymbolGraphic[] = [
    // IC body rectangle
    { type: 'rect', properties: { x: 0, y: 0, width: bodyWidth, height: bodyHeight, fill: '#2d2d44' } },
    // Pin 1 dot indicator
    { type: 'circle', properties: { cx: -halfW + 8, cy: -halfH + 8, r: 3 } },
  ];

  // Lead wires and pin labels
  leftPins.forEach((p, i) => {
    const y = -halfH + 20 + i * pinSpacing;
    // Lead wire
    graphics.push({
      type: 'line',
      properties: { x1: -(halfW + leadLength), y1: y, x2: -halfW, y2: y },
    });
    // Pin name inside body
    graphics.push({
      type: 'text',
      properties: { x: -halfW + 6, y: y + 3, text: p.name, fontSize: 7, textAlign: 'left' },
    });
    // Pin number outside body
    graphics.push({
      type: 'text',
      properties: { x: -(halfW + leadLength + 2), y: y + 3, text: p.number, fontSize: 6, textAlign: 'right' },
    });
  });

  rightPins.forEach((p, i) => {
    const y = -halfH + 20 + i * pinSpacing;
    // Lead wire
    graphics.push({
      type: 'line',
      properties: { x1: halfW, y1: y, x2: halfW + leadLength, y2: y },
    });
    // Pin name inside body
    graphics.push({
      type: 'text',
      properties: { x: halfW - 6, y: y + 3, text: p.name, fontSize: 7, textAlign: 'right' },
    });
    // Pin number outside body
    graphics.push({
      type: 'text',
      properties: { x: halfW + leadLength + 2, y: y + 3, text: p.number, fontSize: 6, textAlign: 'left' },
    });
  });

  const totalWidth = bodyWidth + leadLength * 2;
  const totalHeight = bodyHeight;

  return {
    id: `easyeda_${resolved.lcsc}`,
    name: resolved.mpn,
    description: `${resolved.mpn} (${resolved.packageName})`,
    category: 'ics_resolved',
    designatorPrefix: 'U',
    defaultValue: value ?? resolved.mpn,
    properties: {
      lcsc: resolved.lcsc,
      mpn: resolved.mpn,
      package: resolved.packageName,
      manufacturer: resolved.manufacturer,
      stock: String(resolved.stock ?? 0),
      price: String(resolved.price ?? 0),
      basic: String(resolved.basic ?? false),
    },
    tags: ['ic', 'resolved'],
    symbol: {
      id: `sym_${resolved.lcsc}`,
      name: resolved.mpn,
      width: totalWidth,
      height: totalHeight,
      origin: { x: 0, y: 0 },
      pins: pinDefs,
      graphics,
      designatorPosition: { x: 0, y: -(halfH + 12) },
      valuePosition: { x: 0, y: halfH + 12 },
    },
  };
}

/**
 * Create a fallback IC definition from LLM-provided pin names/types.
 */
export function createFallbackIC(
  name: string,
  value: string,
  pins: { name: string; type: string }[]
): ComponentDefinition {
  const pinCount = pins.length || 3;
  const halfCount = Math.ceil(pinCount / 2);
  const rightCount = pinCount - halfCount;

  const pinSpacing = 20;
  const bodyWidth = 80;
  const bodyHeight = Math.max(halfCount, rightCount) * pinSpacing + 20;
  const halfW = bodyWidth / 2;
  const halfH = bodyHeight / 2;
  const leadLength = 20;

  const pinDefs: PinDefinition[] = [];
  const graphics: SymbolGraphic[] = [
    { type: 'rect', properties: { x: 0, y: 0, width: bodyWidth, height: bodyHeight, fill: '#2d2d44' } },
    { type: 'circle', properties: { cx: -halfW + 8, cy: -halfH + 8, r: 3 } },
  ];

  // Left side pins
  for (let i = 0; i < halfCount; i++) {
    const p = pins[i] ?? { name: `${i + 1}`, type: 'passive' };
    const y = -halfH + 20 + i * pinSpacing;
    pinDefs.push({
      id: `${i + 1}`,
      name: p.name,
      type: mapPinType(p.type),
      position: { x: -(halfW + leadLength), y },
      orientation: 'left' as Direction,
      length: leadLength,
    });
    graphics.push(
      { type: 'line', properties: { x1: -(halfW + leadLength), y1: y, x2: -halfW, y2: y } },
      { type: 'text', properties: { x: -halfW + 6, y: y + 3, text: p.name, fontSize: 7, textAlign: 'left' } }
    );
  }

  // Right side pins
  for (let i = 0; i < rightCount; i++) {
    const p = pins[halfCount + i] ?? { name: `${halfCount + i + 1}`, type: 'passive' };
    const y = -halfH + 20 + i * pinSpacing;
    pinDefs.push({
      id: `${halfCount + i + 1}`,
      name: p.name,
      type: mapPinType(p.type),
      position: { x: halfW + leadLength, y },
      orientation: 'right' as Direction,
      length: leadLength,
    });
    graphics.push(
      { type: 'line', properties: { x1: halfW, y1: y, x2: halfW + leadLength, y2: y } },
      { type: 'text', properties: { x: halfW - 6, y: y + 3, text: p.name, fontSize: 7, textAlign: 'right' } }
    );
  }

  const totalWidth = bodyWidth + leadLength * 2;

  return {
    id: `ic_dynamic_${name.replace(/\W/g, '_').toLowerCase()}`,
    name,
    description: `${name} (LLM-generated)`,
    category: 'ics_dynamic',
    designatorPrefix: 'U',
    defaultValue: value,
    properties: {},
    tags: ['ic', 'dynamic'],
    symbol: {
      id: `sym_dyn_${name.replace(/\W/g, '_').toLowerCase()}`,
      name,
      width: totalWidth,
      height: bodyHeight,
      origin: { x: 0, y: 0 },
      pins: pinDefs,
      graphics,
      designatorPosition: { x: 0, y: -(halfH + 12) },
      valuePosition: { x: 0, y: halfH + 12 },
    },
  };
}

function mapPinType(type: string): PinType {
  switch (type.toLowerCase()) {
    case 'input': return 'input';
    case 'output': return 'output';
    case 'bidirectional': return 'bidirectional';
    case 'power': return 'power';
    default: return 'passive';
  }
}

// ----- Footprint conversion -----

// TODO: import PCBLayer, PadDefinition, FootprintDefinition from '../core/types' once Agent A merges
export type PCBLayer = 'F.Cu' | 'B.Cu' | 'F.SilkS' | 'B.SilkS' | 'In1.Cu' | 'In2.Cu';

export interface PadDefinition {
  id: string;
  pinId: string;   // maps to schematic pin number
  x: number;       // mm
  y: number;       // mm
  width: number;   // mm
  height: number;  // mm
  shape: 'rect' | 'circle' | 'oval';
  layer: PCBLayer;
  drill: number;   // mm, 0 for SMD
  rotation: number;
}

export interface FootprintDefinition {
  id: string;
  name: string;
  packageUuid?: string;  // EasyEDA footprint library UUID (when resolved from JLCPCB)
  pads: PadDefinition[];
  courtyard: { x: number; y: number; width: number; height: number };
  silkscreen: { type: 'line'; points: { x: number; y: number }[]; layer: PCBLayer; strokeWidth: number }[];
}

const LAYER_MAP: Record<number, PCBLayer> = {
  1: 'F.Cu',
  2: 'B.Cu',
  3: 'F.SilkS',
  4: 'B.SilkS',
  11: 'In1.Cu',
  12: 'In2.Cu',
};

/**
 * Convert a server FootprintResponse into a local FootprintDefinition.
 * Matches pad numbers to schematic pin numbers to set `pinId`.
 */
export function resolvedFootprintToDefinition(
  footprint: FootprintResponse,
  lcsc: string,
  schematicPins: { number: string; name: string }[]
): FootprintDefinition {
  // Build pin-number → pin-number index for linking pads to schematic pins
  const pinNumberSet = new Set(schematicPins.map(p => p.number));

  // Convert pads
  const pads: PadDefinition[] = footprint.pads.map(pad => ({
    id: `pad_${pad.number}`,
    pinId: pinNumberSet.has(pad.number) ? pad.number : '',
    x: pad.x,
    y: pad.y,
    width: pad.width,
    height: pad.height,
    shape: pad.shape,
    layer: LAYER_MAP[pad.layerId] ?? 'F.Cu',
    drill: pad.drill,
    rotation: pad.rotation,
  }));

  // Calculate courtyard bounding box from pad extents
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pad of pads) {
    const hw = pad.width / 2;
    const hh = pad.height / 2;
    minX = Math.min(minX, pad.x - hw);
    minY = Math.min(minY, pad.y - hh);
    maxX = Math.max(maxX, pad.x + hw);
    maxY = Math.max(maxY, pad.y + hh);
  }
  // Add 0.25mm margin
  const margin = 0.25;
  const courtyard = pads.length > 0
    ? {
        x: minX - margin,
        y: minY - margin,
        width: (maxX - minX) + 2 * margin,
        height: (maxY - minY) + 2 * margin,
      }
    : { x: 0, y: 0, width: 1, height: 1 };

  // Parse silkscreen tracks
  const silkscreen: FootprintDefinition['silkscreen'] = [];
  for (const track of footprint.tracks) {
    const layer = LAYER_MAP[track.layerId];
    if (layer !== 'F.SilkS' && layer !== 'B.SilkS') continue;

    const coords = track.points.trim().split(/\s+/).map(Number);
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < coords.length - 1; i += 2) {
      if (!isNaN(coords[i]) && !isNaN(coords[i + 1])) {
        points.push({ x: coords[i], y: coords[i + 1] });
      }
    }
    if (points.length >= 2) {
      silkscreen.push({ type: 'line', points, layer, strokeWidth: track.strokeWidth });
    }
  }

  return {
    id: `fp_${lcsc}`,
    name: footprint.name,
    packageUuid: footprint.packageUuid,
    pads,
    courtyard,
    silkscreen,
  };
}
