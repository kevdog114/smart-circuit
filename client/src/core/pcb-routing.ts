import type {
  CircuitDocument, PCBLayout, PCBTrace, PCBVia, PCBLayer, Point, TraceSettings
} from './types';
import { generateId } from './document';

// ----- Trace Presets -----

export const TRACE_PRESETS: Record<string, TraceSettings> = {
  'signal': {
    width: 0.2,
    clearance: 0.15,
    preset: 'signal',
  },
  'power': {
    width: 0.5,
    clearance: 0.2,
    preset: 'power',
  },
  'ground': {
    width: 0.6,
    clearance: 0.15,
    preset: 'ground',
  },
  'high-speed': {
    width: 0.15,
    clearance: 0.2,
    maxLength: 150,
    impedance: 50,
    preset: 'high-speed',
  },
  'diff-pair': {
    width: 0.15,
    clearance: 0.2,
    maxLength: 150,
    minLength: 10,
    impedance: 100,
    preset: 'diff-pair',
  },
  'custom': {
    width: 0.2,
    clearance: 0.15,
    preset: 'custom',
  },
};

// ----- Routing Helper Functions -----

/**
 * Calculate the length of a trace from its points.
 */
export function calculateTraceLength(points: Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length;
}

/**
 * Find the nearest pad for a given net at a given position.
 */
export function findNearestPadForNet(
  pcbLayout: PCBLayout,
  _netId: string,
  position: Point,
  footprintMap: Map<string, any>
): Point | null {
  let nearest: Point | null = null;
  let nearestDist = Infinity;

  for (const comp of pcbLayout.components) {
    if (!comp.isPlaced) continue;

    const fp = footprintMap.get(comp.footprintId);
    if (!fp) continue;

    // Check if this component belongs to the target net
    // (we'll need to map schematic nets to pads)
    for (const pad of fp.pads) {
      // Transform pad position to board coordinates
      const dx = pad.x;
      const dy = pad.y;
      const rad = (comp.rotation || 0) * Math.PI / 180;
      const boardX = comp.position.x + (dx * Math.cos(rad) - dy * Math.sin(rad));
      const boardY = comp.position.y + (dx * Math.sin(rad) + dy * Math.cos(rad));

      const dist = Math.sqrt(
        (boardX - position.x) ** 2 + (boardY - position.y) ** 2
      );

      if (dist < nearestDist && dist < 5) { // Within 5mm snap range
        nearestDist = dist;
        nearest = { x: boardX, y: boardY };
      }
    }
  }

  return nearest;
}

/**
 * Check if two traces would overlap (DRC check).
 */
export function checkTraceOverlap(
  newTrace: { points: Point[]; width: number; layer: PCBLayer },
  existingTraces: PCBTrace[],
  clearance: number
): boolean {
  const totalClearance = newTrace.width / 2 + clearance;

  for (const existing of existingTraces) {
    if (existing.layer !== newTrace.layer) continue;

    const existingClearance = existing.width / 2 + clearance;
    const minGap = Math.min(totalClearance, existingClearance);

    // Check each segment pair
    for (let i = 0; i < newTrace.points.length - 1; i++) {
      for (let j = 0; j < existing.points.length - 1; j++) {
        if (segmentsTooClose(
          newTrace.points[i], newTrace.points[i + 1],
          existing.points[j], existing.points[j + 1],
          minGap
        )) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if two line segments are too close.
 */
function segmentsTooClose(
  a1: Point, a2: Point,
  b1: Point, b2: Point,
  minGap: number
): boolean {
  // Simple bounding box check first
  const aMinX = Math.min(a1.x, a2.x) - minGap;
  const aMaxX = Math.max(a1.x, a2.x) + minGap;
  const aMinY = Math.min(a1.y, a2.y) - minGap;
  const aMaxY = Math.max(a1.y, a2.y) + minGap;

  if (b1.x > aMaxX || b1.x < aMinX || b1.y > aMaxY || b1.y < aMinY) return false;
  if (b2.x > aMaxX || b2.x < aMinX || b2.y > aMaxY || b2.y < aMinY) return false;

  // More precise: point-to-segment distance
  const dist1 = pointToSegmentDist(b1, a1, a2);
  const dist2 = pointToSegmentDist(b2, a1, a2);
  const dist3 = pointToSegmentDist(a1, b1, b2);
  const dist4 = pointToSegmentDist(a2, b1, b2);

  return Math.min(dist1, dist2, dist3, dist4) < minGap;
}

/**
 * Distance from point to line segment.
 */
function pointToSegmentDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  }

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = a.x + t * dx;
  const projY = a.y + t * dy;

  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}

// ----- PCB Routing Commands -----

/**
 * Starts a new trace route for a net.
 */
export class StartPCBTraceCommand {
  type = 'START_PCB_TRACE';
  description: string;
  private netId: string;
  private startPoint: Point;

  constructor(netId: string, _layer: PCBLayer, startPoint: Point, settings?: Partial<TraceSettings>) {
    void settings;
    this.netId = netId;
    this.startPoint = startPoint;
    this.description = `Start trace for net ${netId}`;
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    doc.pcbLayout.routingNetId = this.netId;
    doc.pcbLayout.routingPoints = [{ ...this.startPoint }];
    doc.pcbLayout.activeTool = 'route';
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    doc.pcbLayout.routingNetId = undefined;
    doc.pcbLayout.routingPoints = undefined;
    doc.pcbLayout.activeTool = 'select';
    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Adds a via at the current routing point.
 */
export class AddPCBViaCommand {
  type = 'ADD_PCB_VIA';
  description: string;
  private via: PCBVia;

  constructor(netId: string, position: Point, fromLayer: PCBLayer, toLayer: PCBLayer) {
    this.via = {
      id: generateId(),
      netId,
      position: { ...position },
      drill: 0.3,
      outerDiameter: 0.6,
      fromLayer,
      toLayer,
    };
    this.description = `Add via at (${position.x.toFixed(2)}, ${position.y.toFixed(2)})mm`;
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    doc.pcbLayout.vias.push({ ...this.via });
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    doc.pcbLayout.vias = doc.pcbLayout.vias.filter(v => v.id !== this.via.id);
    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Completes a trace route.
 */
export class CompletePCBTraceCommand {
  type = 'COMPLETE_PCB_TRACE';
  description: string;
  private trace: PCBTrace;
  private settings: TraceSettings;

  constructor(
    netId: string,
    layer: PCBLayer,
    points: Point[],
    settings?: Partial<TraceSettings>
  ) {
    this.settings = { ...TRACE_PRESETS['signal'], ...settings };
    const length = calculateTraceLength(points);

    this.trace = {
      id: generateId(),
      netId,
      layer,
      width: this.settings.width,
      points: points.map(p => ({ ...p })),
      length,
      settings: { ...this.settings },
    };
    this.description = `Route trace for net ${netId} (${length.toFixed(2)}mm)`;
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    doc.pcbLayout.traces.push({ ...this.trace });
    doc.pcbLayout.routingNetId = undefined;
    doc.pcbLayout.routingPoints = undefined;
    doc.pcbLayout.activeTool = 'select';
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    doc.pcbLayout.traces = doc.pcbLayout.traces.filter(t => t.id !== this.trace.id);
    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Adds a point to the in-progress trace route.
 */
export class AddTracePointCommand {
  type = 'ADD_TRACE_POINT';
  description: string;
  private point: Point;
  private hadPoints: boolean;

  constructor(point: Point) {
    this.point = { ...point };
    this.description = `Add trace point at (${point.x.toFixed(2)}, ${point.y.toFixed(2)})mm`;
    this.hadPoints = false;
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout || !doc.pcbLayout.routingPoints) return;

    this.hadPoints = doc.pcbLayout.routingPoints.length > 0;
    doc.pcbLayout.routingPoints.push({ ...this.point });
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout || !doc.pcbLayout.routingPoints) return;

    doc.pcbLayout.routingPoints.pop();
    if (!this.hadPoints && doc.pcbLayout.routingPoints!.length === 0) {
      doc.pcbLayout.routingNetId = undefined;
      doc.pcbLayout.routingPoints = undefined;
      doc.pcbLayout.activeTool = 'select';
    }
    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Removes the last point from the in-progress trace.
 */
export class RemoveTracePointCommand {
  type = 'REMOVE_TRACE_POINT';
  description = 'Remove trace point';
  private removedPoint: Point | null = null;
  private hadNetId: string | undefined;

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout || !doc.pcbLayout.routingPoints) return;

    this.removedPoint = doc.pcbLayout.routingPoints.pop() || null;
    this.hadNetId = doc.pcbLayout.routingNetId;

    if (doc.pcbLayout.routingPoints.length === 0) {
      doc.pcbLayout.routingNetId = undefined;
      doc.pcbLayout.routingPoints = undefined;
      doc.pcbLayout.activeTool = 'select';
    }
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout || !this.removedPoint) return;

    if (!doc.pcbLayout.routingPoints) {
      doc.pcbLayout.routingPoints = [];
      doc.pcbLayout.routingNetId = this.hadNetId;
      doc.pcbLayout.activeTool = 'route';
    }

    doc.pcbLayout.routingPoints.push({ ...this.removedPoint });
    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Deletes a completed trace.
 */
export class DeletePCBTraceCommand {
  type = 'DELETE_PCB_TRACE';
  description: string;
  private traceId: string;
  private removedTrace: PCBTrace | null = null;

  constructor(traceId: string) {
    this.traceId = traceId;
    this.description = 'Delete PCB trace';
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    const idx = doc.pcbLayout.traces.findIndex(t => t.id === this.traceId);
    if (idx >= 0) {
      this.removedTrace = doc.pcbLayout.traces[idx];
      doc.pcbLayout.traces.splice(idx, 1);
    }

    // Also remove associated vias
    if (this.removedTrace) {
      doc.pcbLayout.vias = doc.pcbLayout.vias.filter(
        v => !this.removedTrace!.points.some(p =>
          Math.abs(p.x - v.position.x) < 0.01 && Math.abs(p.y - v.position.y) < 0.01
        )
      );
    }

    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout || !this.removedTrace) return;

    doc.pcbLayout.traces.push({ ...this.removedTrace });
    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Modifies trace settings (width, clearance, etc).
 */
export class ModifyTraceSettingsCommand {
  type = 'MODIFY_TRACE_SETTINGS';
  description: string;
  private traceId: string;
  private newSettings: TraceSettings;
  private oldSettings: TraceSettings | undefined;

  constructor(traceId: string, newSettings: Partial<TraceSettings>) {
    this.traceId = traceId;
    this.newSettings = { ...TRACE_PRESETS['signal'], ...newSettings };
    this.description = `Modify trace settings for ${traceId}`;
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    const trace = doc.pcbLayout.traces.find(t => t.id === this.traceId);
    if (!trace) return;

    this.oldSettings = trace.settings;
    trace.settings = { ...this.newSettings };
    trace.width = this.newSettings.width;

    // If diff pair partner exists, update it too
    if (trace.diffPairId) {
      const partner = doc.pcbLayout.traces.find(t => t.id === trace.diffPairId);
      if (partner) {
        partner.settings = { ...this.newSettings };
        partner.width = this.newSettings.width;
      }
    }

    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout || !this.oldSettings) return;

    const trace = doc.pcbLayout.traces.find(t => t.id === this.traceId);
    if (!trace) return;

    trace.settings = { ...this.oldSettings };
    trace.width = this.oldSettings.width;

    if (trace.diffPairId) {
      const partner = doc.pcbLayout.traces.find(t => t.id === trace.diffPairId);
      if (partner) {
        partner.settings = { ...this.oldSettings };
        partner.width = this.oldSettings.width;
      }
    }

    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Associates two traces as a differential pair.
 */
export class AssociateDiffPairCommand {
  type = 'ASSOCIATE_DIFF_PAIR';
  description: string;
  private trace1Id: string;
  private trace2Id: string;
  private prevTrace1Partner: string | undefined;
  private prevTrace2Partner: string | undefined;

  constructor(trace1Id: string, trace2Id: string) {
    this.trace1Id = trace1Id;
    this.trace2Id = trace2Id;
    this.description = `Associate differential pair: ${trace1Id} <-> ${trace2Id}`;
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    const t1 = doc.pcbLayout.traces.find(t => t.id === this.trace1Id);
    const t2 = doc.pcbLayout.traces.find(t => t.id === this.trace2Id);
    if (!t1 || !t2) return;

    this.prevTrace1Partner = t1.diffPairId;
    this.prevTrace2Partner = t2.diffPairId;

    t1.diffPairId = t2.id;
    t2.diffPairId = t1.id;

    // Apply diff-pair settings
    const diffSettings = TRACE_PRESETS['diff-pair'];
    t1.settings = { ...t1.settings, ...diffSettings };
    t2.settings = { ...t2.settings, ...diffSettings };
    t1.width = diffSettings.width;
    t2.width = diffSettings.width;

    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    const t1 = doc.pcbLayout.traces.find(t => t.id === this.trace1Id);
    const t2 = doc.pcbLayout.traces.find(t => t.id === this.trace2Id);
    if (!t1 || !t2) return;

    t1.diffPairId = this.prevTrace1Partner;
    t2.diffPairId = this.prevTrace2Partner;

    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Deletes a via.
 */
export class DeletePCBViaCommand {
  type = 'DELETE_PCB_VIA';
  description: string;
  private viaId: string;
  private removedVia: PCBVia | null = null;

  constructor(viaId: string) {
    this.viaId = viaId;
    this.description = 'Delete PCB via';
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    const idx = doc.pcbLayout.vias.findIndex(v => v.id === this.viaId);
    if (idx >= 0) {
      this.removedVia = doc.pcbLayout.vias[idx];
      doc.pcbLayout.vias.splice(idx, 1);
    }

    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout || !this.removedVia) return;

    doc.pcbLayout.vias.push({ ...this.removedVia });
    doc.updatedAt = new Date().toISOString();
  }
}
