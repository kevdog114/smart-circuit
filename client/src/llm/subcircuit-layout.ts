// ============================================================
// Smart Circuit — Subcircuit Auto-Layout
//
// Arranges subcircuit components in a schematic-friendly layout
// rather than a simple vertical column.
// ============================================================

import type { ComponentDefinition, Point } from '../core/types';
import type { SubcircuitComponentInput } from '../core/document';

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

interface ComponentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const GRID = 10;
const PADDING_X = 160;   // Horizontal gap between components
const PADDING_Y = 120;   // Vertical gap between components
const MIN_SPACING = 80;  // Minimum clear space between symbols

/**
 * Snap a value to the nearest grid point.
 */
function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

/**
 * Get the bounding box dimensions for a component definition.
 * Falls back to reasonable defaults if symbol data is missing.
 */
function getSymbolSize(def: ComponentDefinition): { w: number; h: number } {
  const w = def.symbol?.width ?? 60;
  const h = def.symbol?.height ?? 40;
  // Symbol width/height describe the body, but we need to account for pin stubs.
  // Add generous padding so wires have room.
  return { w: Math.max(w, 40), h: Math.max(h, 30) };
}

/**
 * Check if two axis-aligned bounding boxes overlap.
 */
function overlaps(a: ComponentBounds, b: ComponentBounds): boolean {
  return !(
    a.x + a.width / 2 + MIN_SPACING / 2 <= b.x - b.width / 2 - MIN_SPACING / 2 ||
    b.x + b.width / 2 + MIN_SPACING / 2 <= a.x - a.width / 2 - MIN_SPACING / 2 ||
    a.y + a.height / 2 + MIN_SPACING / 2 <= b.y - b.height / 2 - MIN_SPACING / 2 ||
    b.y + b.height / 2 + MIN_SPACING / 2 <= a.y - a.height / 2 - MIN_SPACING / 2
  );
}

/**
 * Build an adjacency map: designator → set of connected designators.
 */
function buildAdjacency(
  components: LayoutComponent[],
  connections: LayoutConnection[]
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const c of components) {
    adj.set(c.designator, new Set());
  }
  for (const conn of connections) {
    adj.get(conn.fromDesignator)?.add(conn.toDesignator);
    adj.get(conn.toDesignator)?.add(conn.fromDesignator);
  }
  return adj;
}

/**
 * Determine the traversal order via BFS from the main component.
 * Returns designators in BFS order.
 */
function bfsOrder(adj: Map<string, Set<string>>, start: string): string[] {
  const visited = new Set<string>();
  const queue: string[] = [start];
  const order: string[] = [];
  visited.add(start);

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    const neighbors = adj.get(current);
    if (neighbors) {
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
  }
  return order;
}

/**
 * Pick the "main" component — ICs first, then most-connected.
 */
function pickMainComponent(
  components: LayoutComponent[],
  adj: Map<string, Set<string>>
): string {
  // Prefer ICs (U prefix)
  const ics = components.filter(c => c.designator.match(/^U\d/i));
  if (ics.length > 0) {
    // Among ICs, pick the one with the most connections
    return ics.reduce((best, c) => {
      const bestConns = adj.get(best.designator)?.size ?? 0;
      const currConns = adj.get(c.designator)?.size ?? 0;
      return currConns > bestConns ? c : best;
    }).designator;
  }

  // Otherwise, pick the component with the most connections
  let bestDes = components[0].designator;
  let bestCount = 0;
  for (const c of components) {
    const count = adj.get(c.designator)?.size ?? 0;
    if (count > bestCount) {
      bestCount = count;
      bestDes = c.designator;
    }
  }
  return bestDes;
}

/**
 * Classify a component's likely role from its designator prefix.
 */
function classifyRole(designator: string): 'ic' | 'passive' | 'power' | 'connector' | 'other' {
  const prefix = (designator || '').replace(/\d+$/i, '').toUpperCase();
  if (prefix === 'U') return 'ic';
  if (['R', 'C', 'L', 'D', 'Q'].includes(prefix)) return 'passive';
  if (prefix.startsWith('#PWR')) return 'power';
  if (['J', 'P', 'X'].includes(prefix)) return 'connector';
  return 'other';
}

/**
 * Lay out subcircuit components using a connection-aware algorithm.
 *
 * For circuits with a central IC:
 *   - The IC is placed at center
 *   - Connected passives are arranged around it in a fan pattern
 *
 * For linear circuits (no IC):
 *   - Components follow the signal path left-to-right
 *
 * For unconnected components:
 *   - Laid out in a vertical column (current fallback behavior)
 */
export function layoutSubcircuit(
  components: LayoutComponent[],
  connections: LayoutConnection[],
  resolvedDefs: ComponentDefinition[],
  basePosition: Point
): SubcircuitComponentInput[] {
  if (components.length === 0) return [];

  // Single component — just place it at base
  if (components.length === 1) {
    const c = components[0];
    const pos = (c.x != null && c.y != null)
      ? { x: snap(basePosition.x + c.x), y: snap(basePosition.y + c.y) }
      : { x: snap(basePosition.x), y: snap(basePosition.y) };
    return [{
      def: resolvedDefs[0],
      position: pos,
      value: c.value,
      designator: c.designator,
    }];
  }

  // If ALL components have Gemini-provided positions, use them directly
  const allHavePositions = components.every(c => c.x != null && c.y != null);
  if (allHavePositions) {
    return layoutFromHints(components, resolvedDefs, basePosition);
  }

  const defMap = new Map<string, ComponentDefinition>();
  components.forEach((c, i) => defMap.set(c.designator, resolvedDefs[i]));

  const adj = buildAdjacency(components, connections);
  const hasConnections = connections.length > 0;

  if (!hasConnections) {
    // No connections: arrange in a compact grid
    return layoutGrid(components, resolvedDefs, basePosition);
  }

  // Pick the main component and do BFS traversal
  const mainDes = pickMainComponent(components, adj);
  const mainRole = classifyRole(mainDes);
  const order = bfsOrder(adj, mainDes);

  // Add any components not reached by BFS (disconnected)
  for (const c of components) {
    if (!order.includes(c.designator)) {
      order.push(c.designator);
    }
  }

  if (mainRole === 'ic') {
    return layoutICCentric(order, components, defMap, adj, basePosition);
  } else {
    return layoutLinear(order, components, defMap, basePosition);
  }
}

/**
 * IC-centric layout: IC in the center, neighbors arranged around it.
 */
function layoutICCentric(
  order: string[],
  components: LayoutComponent[],
  defMap: Map<string, ComponentDefinition>,
  adj: Map<string, Set<string>>,
  base: Point
): SubcircuitComponentInput[] {
  const placed = new Map<string, ComponentBounds>();
  const result: SubcircuitComponentInput[] = [];

  const mainDes = order[0];
  const mainDef = defMap.get(mainDes)!;
  const mainSize = getSymbolSize(mainDef);

  // Place main IC at center
  const mainPos: Point = { x: snap(base.x), y: snap(base.y) };
  placed.set(mainDes, { x: mainPos.x, y: mainPos.y, width: mainSize.w, height: mainSize.h });

  const compIdx = new Map<string, number>();
  components.forEach((c, i) => compIdx.set(c.designator, i));

  result.push({
    def: mainDef,
    position: mainPos,
    value: components[compIdx.get(mainDes)!].value,
    designator: mainDes,
  });

  // Partition neighbors into left/right/top/bottom slots
  const neighbors = adj.get(mainDes) ?? new Set<string>();
  const leftSlots: string[] = [];
  const rightSlots: string[] = [];
  const otherSlots: string[] = [];

  for (const des of order.slice(1)) {
    if (!neighbors.has(des)) {
      otherSlots.push(des);
      continue;
    }

    const role = classifyRole(des);
    const prefix = (des || '').replace(/\d+$/i, '').toUpperCase();

    // Heuristic: input-side components go left, output-side go right
    // Decoupling caps (C*) split based on their index position
    if (prefix === 'C') {
      // Alternate decoupling caps between top-left and top-right
      if (leftSlots.filter(d => d.startsWith('C')).length <=
          rightSlots.filter(d => d.startsWith('C')).length) {
        leftSlots.push(des);
      } else {
        rightSlots.push(des);
      }
    } else if (role === 'connector' || prefix === 'J') {
      leftSlots.push(des);
    } else {
      rightSlots.push(des);
    }
  }

  // Place left-side components
  placeColumn(leftSlots, defMap, compIdx, components, placed, result,
    mainPos.x - PADDING_X, mainPos.y, -1);

  // Place right-side components
  placeColumn(rightSlots, defMap, compIdx, components, placed, result,
    mainPos.x + PADDING_X, mainPos.y, 1);

  // Place remaining unconnected components below
  let belowY = mainPos.y + mainSize.h / 2 + PADDING_Y;
  for (const des of otherSlots) {
    const def = defMap.get(des)!;
    const size = getSymbolSize(def);
    const pos: Point = { x: snap(mainPos.x), y: snap(belowY) };

    const bounds: ComponentBounds = { x: pos.x, y: pos.y, width: size.w, height: size.h };
    resolveCollisions(bounds, placed);
    pos.x = snap(bounds.x);
    pos.y = snap(bounds.y);
    placed.set(des, bounds);

    result.push({
      def,
      position: pos,
      value: components[compIdx.get(des)!].value,
      designator: des,
    });
    belowY = pos.y + size.h / 2 + PADDING_Y;
  }

  return result;
}

/**
 * Place a column of components at a given x position, centered around centerY.
 */
function placeColumn(
  designators: string[],
  defMap: Map<string, ComponentDefinition>,
  compIdx: Map<string, number>,
  components: LayoutComponent[],
  placed: Map<string, ComponentBounds>,
  result: SubcircuitComponentInput[],
  x: number,
  centerY: number,
  _side: number // -1 = left, 1 = right (for future orientation)
): void {
  if (designators.length === 0) return;

  // Calculate total height needed
  const sizes = designators.map(des => getSymbolSize(defMap.get(des)!));
  const totalHeight = sizes.reduce((sum, s) => sum + s.h, 0) +
    (designators.length - 1) * (PADDING_Y * 0.6);
  let startY = centerY - totalHeight / 2;

  for (let i = 0; i < designators.length; i++) {
    const des = designators[i];
    const def = defMap.get(des)!;
    const size = sizes[i];
    const pos: Point = { x: snap(x), y: snap(startY + size.h / 2) };

    const bounds: ComponentBounds = { x: pos.x, y: pos.y, width: size.w, height: size.h };
    resolveCollisions(bounds, placed);
    pos.x = snap(bounds.x);
    pos.y = snap(bounds.y);
    placed.set(des, bounds);

    result.push({
      def,
      position: pos,
      value: components[compIdx.get(des)!].value,
      designator: des,
    });

    startY = pos.y + size.h / 2 + PADDING_Y * 0.6;
  }
}

/**
 * Linear layout: components placed left-to-right following signal path.
 */
function layoutLinear(
  order: string[],
  components: LayoutComponent[],
  defMap: Map<string, ComponentDefinition>,
  base: Point
): SubcircuitComponentInput[] {
  const placed = new Map<string, ComponentBounds>();
  const result: SubcircuitComponentInput[] = [];

  const compIdx = new Map<string, number>();
  components.forEach((c, i) => compIdx.set(c.designator, i));

  let currentX = base.x;
  const rowY = base.y;

  // Place all components in a row, wrapping to a new row if we exceed 5 components
  const maxPerRow = 5;
  let rowCount = 0;
  let currentRowY = rowY;
  let rowStartX = base.x;

  for (const des of order) {
    const def = defMap.get(des)!;
    const size = getSymbolSize(def);

    if (rowCount >= maxPerRow) {
      // Wrap to next row
      rowCount = 0;
      currentRowY += PADDING_Y;
      currentX = rowStartX;
    }

    const pos: Point = { x: snap(currentX), y: snap(currentRowY) };
    const bounds: ComponentBounds = { x: pos.x, y: pos.y, width: size.w, height: size.h };
    resolveCollisions(bounds, placed);
    pos.x = snap(bounds.x);
    pos.y = snap(bounds.y);
    placed.set(des, bounds);

    result.push({
      def,
      position: pos,
      value: components[compIdx.get(des)!].value,
      designator: des,
    });

    currentX = pos.x + size.w / 2 + PADDING_X;
    rowCount++;
  }

  return result;
}

/**
 * Hint-based layout: use Gemini-provided x, y positions (relative to base),
 * snapped to grid, with collision resolution as a safety net.
 */
function layoutFromHints(
  components: LayoutComponent[],
  resolvedDefs: ComponentDefinition[],
  base: Point
): SubcircuitComponentInput[] {
  const placed = new Map<string, ComponentBounds>();
  const result: SubcircuitComponentInput[] = [];

  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    const def = resolvedDefs[i];
    const size = getSymbolSize(def);

    // Gemini positions are relative offsets; add to base
    const pos: Point = { x: snap(base.x + (c.x ?? 0)), y: snap(base.y + (c.y ?? 0)) };

    const bounds: ComponentBounds = { x: pos.x, y: pos.y, width: size.w, height: size.h };
    resolveCollisions(bounds, placed);
    pos.x = snap(bounds.x);
    pos.y = snap(bounds.y);
    placed.set(c.designator, bounds);

    result.push({
      def,
      position: pos,
      value: c.value,
      designator: c.designator,
    });
  }

  return result;
}

/**
 * Grid layout for components with no connections.
 * Arrange in rows of 3, keeping things compact.
 */
function layoutGrid(
  components: LayoutComponent[],
  resolvedDefs: ComponentDefinition[],
  base: Point
): SubcircuitComponentInput[] {
  const result: SubcircuitComponentInput[] = [];
  const placed = new Map<string, ComponentBounds>();

  const cols = Math.min(3, components.length);
  let row = 0;
  let col = 0;

  for (let i = 0; i < components.length; i++) {
    const def = resolvedDefs[i];
    const size = getSymbolSize(def);

    const x = snap(base.x + col * PADDING_X);
    const y = snap(base.y + row * PADDING_Y);
    const pos: Point = { x, y };

    const bounds: ComponentBounds = { x, y, width: size.w, height: size.h };
    resolveCollisions(bounds, placed);
    pos.x = snap(bounds.x);
    pos.y = snap(bounds.y);
    placed.set(components[i].designator, bounds);

    result.push({
      def,
      position: pos,
      value: components[i].value,
      designator: components[i].designator,
    });

    col++;
    if (col >= cols) {
      col = 0;
      row++;
    }
  }

  return result;
}

/**
 * Shift a bounding box to avoid overlapping any already-placed components.
 */
function resolveCollisions(
  bounds: ComponentBounds,
  placed: Map<string, ComponentBounds>
): void {
  let iterations = 0;
  const maxIterations = 50;

  while (iterations < maxIterations) {
    let hasCollision = false;
    for (const existing of placed.values()) {
      if (overlaps(bounds, existing)) {
        // Shift downward to clear the collision
        bounds.y = existing.y + existing.height / 2 + bounds.height / 2 + MIN_SPACING;
        hasCollision = true;
        break;
      }
    }
    if (!hasCollision) break;
    iterations++;
  }
}
