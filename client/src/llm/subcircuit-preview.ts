// ============================================================
// Smart Circuit — Subcircuit Preview Renderer
//
// Renders a mini schematic preview of a subcircuit into a
// <canvas> element for display inside tool-call confirmation cards.
// ============================================================

import type { ComponentDefinition, Point } from '../core/types';
import type { SubcircuitComponentInput } from '../core/document';
import { layoutSubcircuit } from './subcircuit-layout';

// Colors matching the main schematic editor theme
const COLORS = {
  background: '#1a1a2e',
  component: '#e2e2e2',
  componentBody: '#2d2d44',
  wire: '#00c9a7',
  pin: '#e94560',
  text: '#e2e2e2',
  textDim: '#8888aa',
  designator: '#c084fc',
};

const CANVAS_WIDTH = 340;
const CANVAS_HEIGHT = 200;
const PADDING = 30; // px padding inside the canvas

interface LayoutComponent {
  designator: string;
  value: string;
  libraryId?: string;
  mpn?: string;
  x?: number;
  y?: number;
  rotation?: number;
}

interface LayoutConnection {
  fromDesignator: string;
  fromPin: string;
  toDesignator: string;
  toPin: string;
  netName?: string;
}

/**
 * Render a mini schematic preview of a subcircuit.
 *
 * @returns A `<canvas>` element showing the laid-out circuit.
 */
export function renderSubcircuitPreview(
  components: LayoutComponent[],
  connections: LayoutConnection[],
  resolvedDefs: ComponentDefinition[],
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = CANVAS_WIDTH * dpr;
  canvas.height = CANVAS_HEIGHT * dpr;
  canvas.style.width = `${CANVAS_WIDTH}px`;
  canvas.style.height = `${CANVAS_HEIGHT}px`;
  canvas.className = 'subcircuit-preview-canvas';

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Compute layout positions (use 0,0 as base — we'll transform to fit)
  const layoutResults = layoutSubcircuit(components, connections, resolvedDefs, { x: 0, y: 0 });

  if (layoutResults.length === 0) {
    drawEmpty(ctx);
    return canvas;
  }

  // Calculate bounding box of all laid-out components
  const bounds = computeBounds(layoutResults);

  // Compute transform to fit everything into the canvas with padding
  const contentW = bounds.maxX - bounds.minX || 1;
  const contentH = bounds.maxY - bounds.minY || 1;
  const availW = CANVAS_WIDTH - PADDING * 2;
  const availH = CANVAS_HEIGHT - PADDING * 2;
  const scale = Math.min(availW / contentW, availH / contentH, 2.5); // cap at 2.5x
  const offsetX = PADDING + (availW - contentW * scale) / 2 - bounds.minX * scale;
  const offsetY = PADDING + (availH - contentH * scale) / 2 - bounds.minY * scale;

  // Fill background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Apply transform
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  // Build a position map for connection drawing
  const posMap = new Map<string, Point>();
  layoutResults.forEach(r => posMap.set(r.designator, r.position));

  // Draw connections first (behind components)
  drawConnections(ctx, connections, layoutResults);

  // Draw each component
  for (const comp of layoutResults) {
    ctx.save();
    ctx.translate(comp.position.x, comp.position.y);

    drawSymbol(ctx, comp.def);
    drawDesignatorAndValue(ctx, comp.designator, comp.value, comp.def);
    drawPins(ctx, comp.def);

    ctx.restore();
  }

  ctx.restore();

  return canvas;
}

/**
 * Create a placeholder element while defs are being resolved.
 */
export function createPreviewPlaceholder(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'subcircuit-preview-loading';
  el.textContent = '⏳ Generating preview…';
  return el;
}

// ---- Internal Drawing Functions ----

function drawEmpty(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '12px "Inter", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('No components', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
}

function drawSymbol(ctx: CanvasRenderingContext2D, def: ComponentDefinition): void {
  for (const graphic of def.symbol.graphics) {
    ctx.strokeStyle = COLORS.component;
    ctx.lineWidth = 1.5;
    ctx.fillStyle = COLORS.componentBody;

    const p = graphic.properties as Record<string, number | string>;

    switch (graphic.type) {
      case 'rect': {
        const x = (p['x'] as number) || 0;
        const y = (p['y'] as number) || 0;
        const w = (p['width'] as number) || 60;
        const h = (p['height'] as number) || 40;
        const fill = (p['fill'] as string) || COLORS.componentBody;
        ctx.fillStyle = fill;
        ctx.fillRect(x - w / 2, y - h / 2, w, h);
        ctx.strokeRect(x - w / 2, y - h / 2, w, h);
        break;
      }
      case 'line': {
        ctx.beginPath();
        ctx.moveTo(p['x1'] as number, p['y1'] as number);
        ctx.lineTo(p['x2'] as number, p['y2'] as number);
        ctx.stroke();
        break;
      }
      case 'circle': {
        ctx.beginPath();
        ctx.arc(p['cx'] as number, p['cy'] as number, p['r'] as number, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'polyline': {
        const points = p['points'] as unknown as Point[];
        if (points?.length > 1) {
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
          }
          ctx.stroke();
        }
        break;
      }
      case 'polygon': {
        const pts = p['points'] as unknown as Point[];
        if (pts?.length > 2) {
          const fill = (p['fill'] as string) || COLORS.componentBody;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x, pts[i].y);
          }
          ctx.closePath();
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.stroke();
        }
        break;
      }
      case 'arc': {
        const cx = (p['cx'] as number) || 0;
        const cy = (p['cy'] as number) || 0;
        const r = (p['r'] as number) || 5;
        const startAngle = (p['startAngle'] as number) ?? 0;
        const endAngle = (p['endAngle'] as number) ?? Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, startAngle, endAngle);
        ctx.stroke();
        break;
      }
      case 'text': {
        ctx.fillStyle = COLORS.component;
        ctx.font = `${p['fontSize'] || 9}px "JetBrains Mono", monospace`;
        ctx.textAlign = (p['textAlign'] as CanvasTextAlign) || 'center';
        ctx.fillText(String(p['text'] || ''), p['x'] as number || 0, p['y'] as number || 0);
        ctx.textAlign = 'center';
        break;
      }
    }
  }
}

function drawDesignatorAndValue(
  ctx: CanvasRenderingContext2D,
  designator: string,
  value: string,
  def: ComponentDefinition,
): void {
  ctx.textAlign = 'center';

  // Designator (purple, above)
  ctx.fillStyle = COLORS.designator;
  ctx.font = '9px "JetBrains Mono", monospace';
  const desY = def.symbol.designatorPosition?.y ?? -(def.symbol.height / 2 + 8);
  ctx.fillText(designator, 0, desY);

  // Value (dim, below)
  ctx.fillStyle = COLORS.textDim;
  ctx.font = '8px "JetBrains Mono", monospace';
  const valY = def.symbol.valuePosition?.y ?? (def.symbol.height / 2 + 12);
  ctx.fillText(value, 0, valY);
}

function drawPins(ctx: CanvasRenderingContext2D, def: ComponentDefinition): void {
  ctx.fillStyle = COLORS.pin;
  for (const pin of def.symbol.pins) {
    ctx.beginPath();
    ctx.arc(pin.position.x, pin.position.y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawConnections(
  ctx: CanvasRenderingContext2D,
  connections: LayoutConnection[],
  layoutResults: SubcircuitComponentInput[],
): void {
  if (connections.length === 0) return;

  // Build pin position lookup: designator → pinName → absolute position
  const pinPosMap = new Map<string, Map<string, Point>>();
  for (const comp of layoutResults) {
    const pins = new Map<string, Point>();
    for (const pin of comp.def.symbol.pins) {
      pins.set(pin.name, {
        x: comp.position.x + pin.position.x,
        y: comp.position.y + pin.position.y,
      });
      // Also map by pin ID for flexibility
      pins.set(pin.id, {
        x: comp.position.x + pin.position.x,
        y: comp.position.y + pin.position.y,
      });
    }
    pinPosMap.set(comp.designator, pins);
  }

  ctx.strokeStyle = COLORS.wire;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  for (const conn of connections) {
    const fromPins = pinPosMap.get(conn.fromDesignator);
    const toPins = pinPosMap.get(conn.toDesignator);
    if (!fromPins || !toPins) continue;

    const from = fromPins.get(conn.fromPin);
    const to = toPins.get(conn.toPin);
    if (!from || !to) continue;

    // Draw an orthogonal route (horizontal then vertical)
    const midX = (from.x + to.x) / 2;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(midX, from.y);
    ctx.lineTo(midX, to.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
}

/**
 * Compute the bounding box of all laid-out components including their symbol sizes.
 */
function computeBounds(results: SubcircuitComponentInput[]): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const comp of results) {
    const w = comp.def.symbol?.width ?? 60;
    const h = comp.def.symbol?.height ?? 40;

    // Include some extra space for designator/value text
    const extraV = 20;

    minX = Math.min(minX, comp.position.x - w / 2 - 10);
    minY = Math.min(minY, comp.position.y - h / 2 - extraV);
    maxX = Math.max(maxX, comp.position.x + w / 2 + 10);
    maxY = Math.max(maxY, comp.position.y + h / 2 + extraV);
  }

  return { minX, minY, maxX, maxY };
}
