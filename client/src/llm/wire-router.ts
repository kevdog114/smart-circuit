// ============================================================
// Smart Circuit — Hybrid Wire Router
//
// Routes connections between component pins using:
// 1. Orthogonal (right-angle) wires for nearby/unobstructed pins
// 2. Net labels for complex/distant connections
// ============================================================

import type { Point, WireSegment, BoundingBox } from '../core/types';

// ----- Types -----

export interface WireRoute {
  type: 'wire';
  segments: WireSegment[];
}

export interface LabelRoute {
  type: 'label';
  netName: string;
}

export type RouteResult = WireRoute | LabelRoute;

// ----- Configuration -----

/** Max Manhattan distance (in grid units) before we switch to net labels */
const MAX_WIRE_DISTANCE = 400;

/** Padding around component bounding boxes for obstacle detection */
const OBSTACLE_PADDING = 10;

// ----- Public API -----

/**
 * Route a connection between two pin positions, deciding between
 * an orthogonal wire or a net label based on complexity.
 *
 * @param from            Start pin position
 * @param to              End pin position
 * @param obstacles       Bounding boxes of other components (exclude the two being connected)
 * @param netName         LLM-provided net name, or auto-generated fallback
 * @param gridSize        Grid spacing for snapping (default 10)
 * @param otherPins       Optional pin positions to avoid (converted to mini obstacles)
 * @param occupiedSegs    Optional already-routed segments to avoid overlapping
 */
export function routeConnection(
  from: Point,
  to: Point,
  obstacles: BoundingBox[],
  netName: string,
  gridSize = 10,
  otherPins?: Point[],
  occupiedSegs?: WireSegment[],
): RouteResult {
  const manhattan = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);

  // If pins are very far apart, use net labels
  if (manhattan > MAX_WIRE_DISTANCE) {
    return { type: 'label', netName };
  }

  // Build the full obstacle list: component BBs + pin mini-boxes + occupied wire segments
  const allObstacles = [
    ...obstacles,
    ...pinObstacles(from, to, otherPins, gridSize),
    ...segmentsToObstacles(occupiedSegs, gridSize),
  ];

  // Try L-shaped routing
  const lRoute = routeLShaped(from, to, gridSize);

  // Check if the L-route crosses any obstacle
  if (lRouteIntersectsObstacles(lRoute, allObstacles)) {
    // Try the alternate L-path (swap horizontal/vertical order)
    const altRoute = routeLShapedAlt(from, to, gridSize);
    if (!lRouteIntersectsObstacles(altRoute, allObstacles)) {
      return { type: 'wire', segments: altRoute };
    }
    // Both L-paths blocked → try A* pathfinding
    const aStarRoute = findAStarPath(from, to, allObstacles, gridSize, occupiedSegs);
    if (aStarRoute) {
      return { type: 'wire', segments: aStarRoute };
    }

    // A* also failed — retry without occupied-segment obstacles (soft constraint)
    if (occupiedSegs && occupiedSegs.length > 0) {
      const hardObstacles = [
        ...obstacles,
        ...pinObstacles(from, to, otherPins, gridSize),
      ];
      const fallbackL = routeLShaped(from, to, gridSize);
      if (!lRouteIntersectsObstacles(fallbackL, hardObstacles)) {
        return { type: 'wire', segments: fallbackL };
      }
      const fallbackAlt = routeLShapedAlt(from, to, gridSize);
      if (!lRouteIntersectsObstacles(fallbackAlt, hardObstacles)) {
        return { type: 'wire', segments: fallbackAlt };
      }
      const fallbackAStar = findAStarPath(from, to, hardObstacles, gridSize);
      if (fallbackAStar) {
        return { type: 'wire', segments: fallbackAStar };
      }
    }

    // Everything failed → use net labels
    return { type: 'label', netName };
  }

  return { type: 'wire', segments: lRoute };
}

/**
 * Route multiple connections in sequence so that later wires avoid overlapping
 * earlier ones. Each successfully routed wire's segments are added to an
 * "occupied" accumulator that subsequent routes treat as obstacles.
 */
export function routeConnectionBatch(
  connections: { from: Point; to: Point; netName: string }[],
  obstacles: BoundingBox[],
  otherPins: Point[],
  gridSize = 10,
): RouteResult[] {
  const occupied: WireSegment[] = [];
  const results: RouteResult[] = [];

  for (const conn of connections) {
    const result = routeConnection(
      conn.from, conn.to, obstacles, conn.netName, gridSize, otherPins, occupied,
    );
    if (result.type === 'wire') {
      for (const seg of result.segments) {
        occupied.push(seg);
      }
    }
    results.push(result);
  }

  return results;
}

/**
 * Simple L-shaped route for the wire drawing preview.
 * No obstacle awareness — just orthogonal segments.
 */
export function routeSimple(from: Point, to: Point, gridSize = 10): WireSegment[] {
  return routeLShaped(from, to, gridSize);
}

/**
 * Generate a unique, descriptive net name for a connection.
 * Used when the LLM doesn't provide one.
 *
 * Checks existing net names on the sheet to avoid collisions.
 */
export function generateNetName(
  fromDesignator: string,
  fromPin: string,
  toDesignator: string,
  toPin: string,
  existingNames: Set<string>,
): string {
  // Try a clean descriptive name first
  const base = `${fromDesignator}_${fromPin}-${toDesignator}_${toPin}`;
  if (!existingNames.has(base)) return base;

  // Append a numeric suffix if collision
  let suffix = 2;
  while (existingNames.has(`${base}_${suffix}`)) {
    suffix++;
  }
  return `${base}_${suffix}`;
}

/**
 * Build bounding boxes for all components on a sheet, excluding specific component IDs.
 * The bounding boxes include padding for wire clearance.
 */
export function getComponentObstacles(
  components: { id: string; position: Point; libraryId: string; rotation?: number }[],
  symbolSizes: Map<string, { width: number; height: number }>,
  excludeIds: string[],
  padding: number = OBSTACLE_PADDING
): BoundingBox[] {
  const boxes: BoundingBox[] = [];

  for (const comp of components) {
    if (excludeIds.includes(comp.id)) continue;

    const size = symbolSizes.get(comp.libraryId) || { width: 60, height: 40 };
    let w = size.width;
    let h = size.height;
    if (comp.rotation === 90 || comp.rotation === 270) {
      w = size.height;
      h = size.width;
    }

    const hw = w / 2 + padding;
    const hh = h / 2 + padding;

    boxes.push({
      minX: comp.position.x - hw,
      minY: comp.position.y - hh,
      maxX: comp.position.x + hw,
      maxY: comp.position.y + hh,
    });
  }

  return boxes;
}

// ----- Internal Routing Logic -----

/**
 * Route an L-shaped path: horizontal-first, then vertical.
 * If pins are axis-aligned, returns a single segment.
 */
function routeLShaped(from: Point, to: Point, gridSize: number): WireSegment[] {
  const snappedFrom = snap(from, gridSize);
  const snappedTo = snap(to, gridSize);

  // Axis-aligned: single straight segment
  if (snappedFrom.x === snappedTo.x || snappedFrom.y === snappedTo.y) {
    return [{ start: snappedFrom, end: snappedTo }];
  }

  // L-shape: horizontal first, then vertical
  const bend: Point = { x: snappedTo.x, y: snappedFrom.y };
  return [
    { start: snappedFrom, end: bend },
    { start: { ...bend }, end: snappedTo },
  ];
}

/**
 * Alternate L-shaped path: vertical-first, then horizontal.
 */
function routeLShapedAlt(from: Point, to: Point, gridSize: number): WireSegment[] {
  const snappedFrom = snap(from, gridSize);
  const snappedTo = snap(to, gridSize);

  // Axis-aligned: single straight segment
  if (snappedFrom.x === snappedTo.x || snappedFrom.y === snappedTo.y) {
    return [{ start: snappedFrom, end: snappedTo }];
  }

  // L-shape: vertical first, then horizontal
  const bend: Point = { x: snappedFrom.x, y: snappedTo.y };
  return [
    { start: snappedFrom, end: bend },
    { start: { ...bend }, end: snappedTo },
  ];
}

/**
 * Check if any segment of an L-route intersects any obstacle bounding box.
 */
function lRouteIntersectsObstacles(segments: WireSegment[], obstacles: BoundingBox[]): boolean {
  for (const seg of segments) {
    for (const box of obstacles) {
      if (segmentIntersectsBox(seg, box)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if an axis-aligned line segment intersects an AABB.
 * Since our segments are always horizontal or vertical, we can use simplified checks.
 */
function segmentIntersectsBox(seg: WireSegment, box: BoundingBox): boolean {
  const x1 = Math.min(seg.start.x, seg.end.x);
  const x2 = Math.max(seg.start.x, seg.end.x);
  const y1 = Math.min(seg.start.y, seg.end.y);
  const y2 = Math.max(seg.start.y, seg.end.y);

  // Horizontal segment (y1 === y2)
  if (y1 === y2) {
    return y1 >= box.minY && y1 <= box.maxY && x2 >= box.minX && x1 <= box.maxX;
  }

  // Vertical segment (x1 === x2)
  if (x1 === x2) {
    return x1 >= box.minX && x1 <= box.maxX && y2 >= box.minY && y1 <= box.maxY;
  }

  // General case (shouldn't happen for orthogonal routing, but handle anyway)
  // Simple AABB overlap check
  return !(x2 < box.minX || x1 > box.maxX || y2 < box.minY || y1 > box.maxY);
}

/**
 * Snap a point to the nearest grid position.
 */
function snap(p: Point, gridSize: number): Point {
  return {
    x: Math.round(p.x / gridSize) * gridSize,
    y: Math.round(p.y / gridSize) * gridSize,
  };
}

// ----- Pin & Wire Obstacle Helpers -----

/**
 * Convert pin positions into small square obstacles so wires avoid crossing them.
 * Excludes the two endpoint pins being connected.
 */
function pinObstacles(from: Point, to: Point, pins: Point[] | undefined, gridSize: number): BoundingBox[] {
  if (!pins || pins.length === 0) return [];
  const halfG = Math.max(gridSize * 0.4, 2);
  const boxes: BoundingBox[] = [];
  for (const pin of pins) {
    // Don't block the actual endpoints
    if ((pin.x === from.x && pin.y === from.y) || (pin.x === to.x && pin.y === to.y)) continue;
    boxes.push({
      minX: pin.x - halfG,
      minY: pin.y - halfG,
      maxX: pin.x + halfG,
      maxY: pin.y + halfG,
    });
  }
  return boxes;
}

/**
 * Convert already-routed wire segments into thin obstacle boxes so new wires
 * are pushed to adjacent grid lines instead of overlapping.
 */
function segmentsToObstacles(segs: WireSegment[] | undefined, gridSize: number): BoundingBox[] {
  if (!segs || segs.length === 0) return [];
  const halfW = Math.max(gridSize * 0.3, 1); // thin obstacle width
  const boxes: BoundingBox[] = [];
  for (const seg of segs) {
    const x1 = Math.min(seg.start.x, seg.end.x);
    const x2 = Math.max(seg.start.x, seg.end.x);
    const y1 = Math.min(seg.start.y, seg.end.y);
    const y2 = Math.max(seg.start.y, seg.end.y);
    // Only create obstacle for segments with length (skip zero-length points)
    if (x1 === x2 && y1 === y2) continue;
    boxes.push({
      minX: x1 - halfW,
      minY: y1 - halfW,
      maxX: x2 + halfW,
      maxY: y2 + halfW,
    });
  }
  return boxes;
}

// ----- A* Pathfinding Logic -----

interface AStarNode {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  gScore: number;
  fScore: number;
  parent: AStarNode | null;
}

/**
 * Find an orthogonal path around obstacles using A*.
 * Penalizes turns to encourage fewer segments.
 * Optionally penalizes traversing cells already used by other wires.
 */
function findAStarPath(
  from: Point, to: Point, obstacles: BoundingBox[], gridSize: number,
  occupiedSegs?: WireSegment[],
): WireSegment[] | null {
  const startX = Math.round(from.x / gridSize) * gridSize;
  const startY = Math.round(from.y / gridSize) * gridSize;
  const targetX = Math.round(to.x / gridSize) * gridSize;
  const targetY = Math.round(to.y / gridSize) * gridSize;

  const getHeuristic = (x: number, y: number) => Math.abs(x - targetX) + Math.abs(y - targetY);

  const startNode: AStarNode = {
    x: startX, y: startY,
    dirX: 0, dirY: 0,
    gScore: 0,
    fScore: getHeuristic(startX, startY),
    parent: null
  };

  const openList: AStarNode[] = [startNode];
  const closedSet = new Set<string>();
  const gScores = new Map<string, number>();

  const startKey = `${startX},${startY},0,0`;
  gScores.set(startKey, 0);

  // Confine the search space
  const minX = Math.min(startX, targetX) - 200;
  const maxX = Math.max(startX, targetX) + 200;
  const minY = Math.min(startY, targetY) - 200;
  const maxY = Math.max(startY, targetY) + 200;

  let iterations = 0;
  const MAX_ITERATIONS = 25000;

  while (openList.length > 0) {
    iterations++;
    if (iterations > MAX_ITERATIONS) return null; // Fallback to label if path is too complex

    // Pop the node with the lowest fScore
    let minIndex = 0;
    for (let i = 1; i < openList.length; i++) {
      if (openList[i].fScore < openList[minIndex].fScore) {
        minIndex = i;
      }
    }
    const current = openList[minIndex];
    openList.splice(minIndex, 1);

    if (current.x === targetX && current.y === targetY) {
      return reconstructSegments(current);
    }

    const stateKey = `${current.x},${current.y},${current.dirX},${current.dirY}`;
    closedSet.add(stateKey);

    const neighbors = [
      { dx: gridSize, dy: 0 },
      { dx: -gridSize, dy: 0 },
      { dx: 0, dy: gridSize },
      { dx: 0, dy: -gridSize }
    ];

    for (const { dx, dy } of neighbors) {
      const normalizedDx = Math.sign(dx);
      const normalizedDy = Math.sign(dy);

      // Prevent reversing direction
      if (current.dirX !== 0 && normalizedDx === -current.dirX && normalizedDy === -current.dirY) continue;
      if (current.dirY !== 0 && normalizedDx === -current.dirX && normalizedDy === -current.dirY) continue;

      const nx = current.x + dx;
      const ny = current.y + dy;

      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;

      // Check collision
      const segment: WireSegment = { start: { x: current.x, y: current.y }, end: { x: nx, y: ny } };
      if (segmentIntersectsAnyObstacle(segment, obstacles)) continue;

      // Penalize turns
      let costPenalty = 0;
      if (current.dirX !== 0 || current.dirY !== 0) {
        if (normalizedDx !== current.dirX || normalizedDy !== current.dirY) {
          costPenalty = gridSize * 2; // Equivalent to traveling 2 extra grid units
        }
      }

      // Penalize overlapping with already-routed wires (soft cost)
      if (occupiedSegs) {
        if (segmentOverlapsExisting(segment, occupiedSegs)) {
          costPenalty += gridSize * 3;
        }
      }

      const tentativeG = current.gScore + gridSize + costPenalty;

      const neighborKey = `${nx},${ny},${normalizedDx},${normalizedDy}`;
      if (closedSet.has(neighborKey)) continue;

      const existingG = gScores.get(neighborKey);
      if (existingG === undefined || tentativeG < existingG) {
        gScores.set(neighborKey, tentativeG);
        openList.push({
          x: nx, y: ny,
          dirX: normalizedDx, dirY: normalizedDy,
          gScore: tentativeG,
          fScore: tentativeG + getHeuristic(nx, ny),
          parent: current
        });
      }
    }
  }

  return null; // No path found
}

function segmentIntersectsAnyObstacle(seg: WireSegment, obstacles: BoundingBox[]): boolean {
  for (const box of obstacles) {
    if (segmentIntersectsBox(seg, box)) return true;
  }
  return false;
}

/**
 * Check if a candidate segment overlaps (runs collinearly on the same grid line)
 * with any already-routed segment.
 */
function segmentOverlapsExisting(seg: WireSegment, existing: WireSegment[]): boolean {
  const isHoriz = seg.start.y === seg.end.y;
  const isVert = seg.start.x === seg.end.x;
  if (!isHoriz && !isVert) return false;

  for (const ex of existing) {
    const exHoriz = ex.start.y === ex.end.y;
    const exVert = ex.start.x === ex.end.x;

    if (isHoriz && exHoriz && seg.start.y === ex.start.y) {
      // Both horizontal on the same Y — check X overlap
      const a1 = Math.min(seg.start.x, seg.end.x);
      const a2 = Math.max(seg.start.x, seg.end.x);
      const b1 = Math.min(ex.start.x, ex.end.x);
      const b2 = Math.max(ex.start.x, ex.end.x);
      if (a2 > b1 && a1 < b2) return true;
    }
    if (isVert && exVert && seg.start.x === ex.start.x) {
      // Both vertical on the same X — check Y overlap
      const a1 = Math.min(seg.start.y, seg.end.y);
      const a2 = Math.max(seg.start.y, seg.end.y);
      const b1 = Math.min(ex.start.y, ex.end.y);
      const b2 = Math.max(ex.start.y, ex.end.y);
      if (a2 > b1 && a1 < b2) return true;
    }
  }
  return false;
}

function reconstructSegments(endNode: AStarNode): WireSegment[] {
  const pts: Point[] = [];
  let curr: AStarNode | null = endNode;
  while (curr !== null) {
    pts.push({ x: curr.x, y: curr.y });
    curr = curr.parent;
  }
  pts.reverse();

  if (pts.length < 2) return [];

  const segments: WireSegment[] = [];
  let start = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const currPt = pts[i];
    const next = i + 1 < pts.length ? pts[i + 1] : null;

    if (next) {
      // Skip points if they continue in the same direction
      const dx1 = Math.sign(currPt.x - prev.x);
      const dy1 = Math.sign(currPt.y - prev.y);
      const dx2 = Math.sign(next.x - currPt.x);
      const dy2 = Math.sign(next.y - currPt.y);
      if (dx1 === dx2 && dy1 === dy2) {
        continue;
      }
    }
    
    segments.push({ start: { ...start }, end: { ...currPt } });
    start = currPt;
  }
  return segments;
}
