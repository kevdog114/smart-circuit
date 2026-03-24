import type {
  CircuitDocument, Sheet, Component, Wire, WireSegment, WireNode, Net, NetLabel,
  Point, PinInstance, PinDefinition, ComponentDefinition, BoundingBox
} from './types';
import { routeConnection, routeConnectionBatch, getComponentObstacles, generateNetName } from '../llm/wire-router';

// ----- ID Generation -----

let _idCounter = 0;
export function generateId(): string {
  return `sc_${++_idCounter}_${Date.now().toString(36)}`;
}

// ----- Layout Helpers -----

export function getPinOutwardRotation(pinPos: Point, compPos: Point): number {
  const dx = pinPos.x - compPos.x;
  const dy = pinPos.y - compPos.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx < 0 ? 180 : 0;
  } else {
    return dy < 0 ? 270 : 90;
  }
}

/** Find the position of the component that owns a pin at a given absolute position. */
function findOwnerComponentPosition(sheet: Sheet, pinPos: Point, fallback: Point): Point {
  for (const c of sheet.components) {
    for (const p of c.pins) {
      if (p.absolutePosition.x === pinPos.x && p.absolutePosition.y === pinPos.y) {
        return c.position;
      }
    }
  }
  return fallback;
}

// ----- Document Factory -----

export function createDocument(name: string = 'Untitled'): CircuitDocument {
  return {
    id: generateId(),
    name,
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sheets: [createSheet('Main')],
    metadata: { author: '', description: '', revision: 'A', tags: [] }
  };
}

export function healDocument(doc: CircuitDocument): void {
  for (const sheet of doc.sheets) {
    const validLabels = [];
    for (const label of sheet.labels) {
      // Find a matching pin exactly at this location
      let foundMatchingPin = false;
      let ownerComp = null;
      for (const comp of sheet.components) {
        if (comp.pins.some(p => p.absolutePosition.x === label.position.x && p.absolutePosition.y === label.position.y)) {
          foundMatchingPin = true;
          ownerComp = comp;
          break;
        }
      }

      if (foundMatchingPin && ownerComp) {
        // Auto-correct any backwards text alignments caused by older bugs
        label.rotation = getPinOutwardRotation(label.position, ownerComp.position);
        validLabels.push(label);
      } else {
        console.warn(`[Healing] Removed orphaned NetLabel ${label.id} at (${label.position.x}, ${label.position.y})`);
      }
    }
    sheet.labels = validLabels;
  }
}

export function createSheet(name: string): Sheet {
  return {
    id: generateId(), name,
    components: [], wires: [], nets: [], junctions: [],
    labels: [], annotations: [],
    gridSize: 10,
    bounds: { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 }
  };
}

// ----- Sheet Helper -----

function getSheet(doc: CircuitDocument, sheetId?: string): Sheet {
  if (sheetId) {
    const sheet = doc.sheets.find(s => s.id === sheetId);
    if (!sheet) throw new Error(`Sheet ${sheetId} not found`);
    return sheet;
  }
  return doc.sheets[0];
}

// ----- Designator Generation -----

export function nextDesignator(doc: CircuitDocument, prefix: string): string {
  const all = doc.sheets.flatMap(s => s.components);
  const existing = all
    .filter(c => c.designator.startsWith(prefix))
    .map(c => parseInt(c.designator.slice(prefix.length), 10))
    .filter(n => !isNaN(n));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return `${prefix}${next}`;
}

// ----- Component Commands -----

export class AddComponentCommand {
  type = 'ADD_COMPONENT';
  description: string;
  private componentId: string;
  private sheetId: string;
  private def: ComponentDefinition;
  private position: Point;
  private value: string;
  private designator: string;
  private rotation: 0 | 90 | 180 | 270;

  constructor(sheetId: string, def: ComponentDefinition, position: Point, value: string, designator: string, rotation: 0 | 90 | 180 | 270 = 0) {
    this.sheetId = sheetId;
    this.def = def;
    this.position = position;
    this.value = value;
    this.designator = designator;
    this.rotation = rotation;
    this.componentId = generateId();
    this.description = `Add ${designator} (${value})`;
  }

  execute(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const pins: PinInstance[] = this.def.symbol.pins.map(p => {
      const rotated = this.rotation ? rotatePoint(p.position, this.rotation) : p.position;
      return {
        definitionId: p.id,
        componentId: this.componentId,
        absolutePosition: {
          x: this.position.x + rotated.x,
          y: this.position.y + rotated.y
        },
        netId: null
      };
    });

    const component: Component = {
      id: this.componentId,
      libraryId: this.def.id,
      designator: this.designator,
      value: this.value,
      position: { ...this.position },
      rotation: this.rotation,
      mirror: false,
      pins,
      properties: {}
    };

    sheet.components.push(component);
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    sheet.components = sheet.components.filter(c => c.id !== this.componentId);
    doc.updatedAt = new Date().toISOString();
  }
}

export class MoveComponentCommand {
  type = 'MOVE_COMPONENT';
  description = 'Move component';
  private sheetId: string;
  private componentId: string;
  private newPosition: Point;
  private oldPosition: Point | null = null;
  // Track full wire re-routes for undo: wireId → old segments
  private wireSegmentBackups: { wireId: string; oldSegments: WireSegment[] }[] = [];
  // Track label position changes for undo
  private labelPositionBackups: { labelId: string; oldPosition: Point }[] = [];
  // Morph state
  private removedWires: { wire: Wire; netId: string }[] = [];
  private addedLabels: NetLabel[] = [];
  private removedLabels: NetLabel[] = [];
  private addedWires: { wire: Wire; netId: string }[] = [];

  constructor(sheetId: string, componentId: string, newPosition: Point) {
    this.sheetId = sheetId;
    this.componentId = componentId;
    this.newPosition = newPosition;
  }

  execute(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const comp = sheet.components.find(c => c.id === this.componentId);
    if (!comp) return;

    this.oldPosition = { ...comp.position };
    const dx = this.newPosition.x - comp.position.x;
    const dy = this.newPosition.y - comp.position.y;

    // Collect current pin positions (before moving) for wire & label matching
    const pinPositions = comp.pins.map(p => ({ x: p.absolutePosition.x, y: p.absolutePosition.y }));

    // Move component and pins
    comp.position = { ...this.newPosition };
    for (const pin of comp.pins) {
      pin.absolutePosition.x += dx;
      pin.absolutePosition.y += dy;
    }

    // Move net labels at old pin positions
    this.labelPositionBackups = [];
    for (const label of sheet.labels) {
      for (const pp of pinPositions) {
        if (label.position.x === pp.x && label.position.y === pp.y) {
          this.labelPositionBackups.push({ labelId: label.id, oldPosition: { ...label.position } });
          label.position.x += dx;
          label.position.y += dy;
          break;
        }
      }
    }

    // Prepare obstacles for re-routing
    const symbolSizes = new Map<string, { width: number; height: number }>();
    for (const c of sheet.components) {
      if (symbolSizes.has(c.libraryId)) continue;
      let minX = 0, maxX = 0, minY = 0, maxY = 0;
      for (const p of c.pins) {
        const dx = p.absolutePosition.x - c.position.x;
        const dy = p.absolutePosition.y - c.position.y;
        if (dx < minX) minX = dx;
        if (dx > maxX) maxX = dx;
        if (dy < minY) minY = dy;
        if (dy > maxY) maxY = dy;
      }
      let w = maxX - minX;
      let h = maxY - minY;
      if (c.rotation === 90 || c.rotation === 270) {
        w = maxY - minY;
        h = maxX - minX;
      }
      symbolSizes.set(c.libraryId, { width: Math.max(20, w), height: Math.max(20, h) });
    }
    const excludeIdsForDrag = [this.componentId];
    
    // Check if we can morph any moved label into a wire
    this.removedLabels = [];
    this.addedWires = [];
    for (const backup of this.labelPositionBackups) {
      const movedLabel = sheet.labels.find(l => l.id === backup.labelId);
      if (!movedLabel) continue;

      const peers = sheet.labels.filter(l => l.netName === movedLabel.netName && l.id !== movedLabel.id);
      if (peers.length === 1) {
        const peer = peers[0];
        // Build obstacles excluding both endpoint components
        const localExclude = [...excludeIdsForDrag];
        for (const c of sheet.components) {
           if (c.pins.some(p => (p.absolutePosition.x === movedLabel.position.x && p.absolutePosition.y === movedLabel.position.y) || 
                                (p.absolutePosition.x === peer.position.x && p.absolutePosition.y === peer.position.y))) {
             if (!localExclude.includes(c.id)) localExclude.push(c.id);
           }
        }
        const otherObstacles = getComponentObstacles(sheet.components, symbolSizes, localExclude);
        const excludedComponents = sheet.components.filter(c => localExclude.includes(c.id));
        const selfObstacles = getComponentObstacles(excludedComponents, symbolSizes, [], -1);
        const obstacles = [...otherObstacles, ...selfObstacles];
        const route = routeConnection(movedLabel.position, peer.position, obstacles, '', sheet.gridSize);

        // Respect connectionMode
        const relatedNet = sheet.nets.find(n => n.name === movedLabel.netName || n.id === movedLabel.netName);
        const connMode = relatedNet?.connectionMode || 'auto';
        if (connMode === 'label') continue; // Force Label — never convert to wire

        const shouldConvertToWire = route.type === 'wire' || connMode === 'wire';
        if (shouldConvertToWire) {
          // Determine segments — use routed segments if available, otherwise direct
          const wireSegments = route.type === 'wire'
            ? route.segments
            : [{ start: { ...movedLabel.position }, end: { ...peer.position } }];

          // Find or create a net for this wire
          let foundNetId = '';
          // First try to find a net via pin.netId on matching pins
          for (const c of sheet.components) {
            for (const p of c.pins) {
              if ((p.absolutePosition.x === movedLabel.position.x && p.absolutePosition.y === movedLabel.position.y) ||
                  (p.absolutePosition.x === peer.position.x && p.absolutePosition.y === peer.position.y)) {
                if (p.netId) { foundNetId = p.netId; break; }
              }
            }
            if (foundNetId) break;
          }

          // If no netId on pins, try to reuse the related net, otherwise create a new one
          if (!foundNetId) {
            if (relatedNet) {
              foundNetId = relatedNet.id;
            } else {
              foundNetId = generateId();
              const newNet: Net = { id: foundNetId, name: movedLabel.netName || `Net_${sheet.nets.length + 1}`, pinIds: [], wireIds: [], connectionMode: connMode !== 'auto' ? connMode : undefined };
              sheet.nets.push(newNet);
            }
          } else {
            // Propagate connectionMode to the existing net
            const existingNet = sheet.nets.find(n => n.id === foundNetId);
            if (existingNet && connMode !== 'auto' && !existingNet.connectionMode) {
              existingNet.connectionMode = connMode;
            }
          }

          // Assign netId to matching pins if not already assigned
          for (const c of sheet.components) {
            for (const p of c.pins) {
              if ((p.absolutePosition.x === movedLabel.position.x && p.absolutePosition.y === movedLabel.position.y) ||
                  (p.absolutePosition.x === peer.position.x && p.absolutePosition.y === peer.position.y)) {
                if (!p.netId) p.netId = foundNetId;
              }
            }
          }

          const newWire: Wire = { id: generateId(), netId: foundNetId, segments: wireSegments };
          this.removedLabels.push({ ...movedLabel }, { ...peer });
          this.addedWires.push({ wire: newWire, netId: foundNetId });

          sheet.labels = sheet.labels.filter(l => l.id !== movedLabel.id && l.id !== peer.id);
          sheet.wires.push(newWire);
          const net = sheet.nets.find(n => n.id === foundNetId);
          if (net) net.wireIds.push(newWire.id);
        }
      }
    }

    // Re-route existing wires connected to this component
    this.wireSegmentBackups = [];
    const processedWires = new Set<string>();

    // Collect all pin positions on the sheet for pin-avoidance routing
    const allPinPositions: Point[] = [];
    for (const c of sheet.components) {
      for (const p of c.pins) {
        allPinPositions.push({ x: p.absolutePosition.x, y: p.absolutePosition.y });
      }
    }

    // First pass: identify wires that need re-routing and compute their new endpoints
    type WireReRouteInfo = {
      wire: Wire;
      startMatchIdx: number;
      endMatchIdx: number;
      newStart: Point;
      newEnd: Point;
      obstacles: BoundingBox[];
      forceWire: boolean;
      forceLabel: boolean;
    };
    const wiresToReRoute: WireReRouteInfo[] = [];

    for (const wire of [...sheet.wires]) {
      if (processedWires.has(wire.id)) continue;

      const firstSeg = wire.segments[0];
      const lastSeg = wire.segments[wire.segments.length - 1];
      const wireStart = firstSeg.start;
      const wireEnd = lastSeg.end;

      // Check if any pin was at the wire's start or end (using old positions)
      let startMatchIdx = -1;
      let endMatchIdx = -1;
      for (let pi = 0; pi < pinPositions.length; pi++) {
        const pp = pinPositions[pi];
        if (wireStart.x === pp.x && wireStart.y === pp.y) startMatchIdx = pi;
        if (wireEnd.x === pp.x && wireEnd.y === pp.y) endMatchIdx = pi;
      }

      // Also check internal segment boundaries (from wire splitting at mid-segment pins).
      // If a pin sits at an internal endpoint, move those endpoints directly.
      // Back up segments BEFORE modifying them so undo can restore.
      let hasInternalMatch = false;
      const preModBackup = wire.segments.map(s => ({
        start: { ...s.start }, end: { ...s.end }
      }));
      for (let si = 0; si < wire.segments.length; si++) {
        const seg = wire.segments[si];
        for (let pi = 0; pi < pinPositions.length; pi++) {
          const pp = pinPositions[pi];
          // Skip outermost endpoints (already handled by start/endMatchIdx)
          if (si === 0 && seg.start.x === pp.x && seg.start.y === pp.y) continue;
          if (si === wire.segments.length - 1 && seg.end.x === pp.x && seg.end.y === pp.y) continue;

          // Check segment end (internal boundary)
          if (seg.end.x === pp.x && seg.end.y === pp.y) {
            // This is an internal endpoint where a pin sits (from wire splitting)
            seg.end.x = comp.pins[pi].absolutePosition.x;
            seg.end.y = comp.pins[pi].absolutePosition.y;
            // Also update the start of the next segment (shared point)
            if (si + 1 < wire.segments.length) {
              wire.segments[si + 1].start.x = comp.pins[pi].absolutePosition.x;
              wire.segments[si + 1].start.y = comp.pins[pi].absolutePosition.y;
            }
            hasInternalMatch = true;
          }
          // Check segment start (internal boundary)
          if (seg.start.x === pp.x && seg.start.y === pp.y) {
            seg.start.x = comp.pins[pi].absolutePosition.x;
            seg.start.y = comp.pins[pi].absolutePosition.y;
            // Also update the end of the previous segment (shared point)
            if (si > 0) {
              wire.segments[si - 1].end.x = comp.pins[pi].absolutePosition.x;
              wire.segments[si - 1].end.y = comp.pins[pi].absolutePosition.y;
            }
            hasInternalMatch = true;
          }
        }
      }

      // If only internal matches were found (no outer endpoint match), store backup and skip re-routing
      if (hasInternalMatch && startMatchIdx === -1 && endMatchIdx === -1) {
        this.wireSegmentBackups.push({
          wireId: wire.id,
          oldSegments: preModBackup, // original segments before modification
        });
        processedWires.add(wire.id);
        continue;
      }

      if (startMatchIdx === -1 && endMatchIdx === -1) continue; // Not connected to this component

      // Back up old segments for undo
      this.wireSegmentBackups.push({
        wireId: wire.id,
        oldSegments: wire.segments.map(s => ({ start: { ...s.start }, end: { ...s.end } })),
      });

      // For multi-segment wires (e.g. from import wire-splitting), just move
      // the matching endpoint(s) directly rather than re-routing the entire wire.
      // This prevents a long power rail with many taps from being replaced with netlabels.
      if (wire.segments.length > 1 && !(startMatchIdx >= 0 && endMatchIdx >= 0)) {
        if (startMatchIdx >= 0) {
          wire.segments[0].start = { ...comp.pins[startMatchIdx].absolutePosition };
        }
        if (endMatchIdx >= 0) {
          wire.segments[wire.segments.length - 1].end = { ...comp.pins[endMatchIdx].absolutePosition };
        }
        processedWires.add(wire.id);
        continue;
      }

      // Compute new endpoints
      const newStart = startMatchIdx >= 0
        ? { ...comp.pins[startMatchIdx].absolutePosition }
        : { ...wireStart };
      const newEnd = endMatchIdx >= 0
        ? { ...comp.pins[endMatchIdx].absolutePosition }
        : { ...wireEnd };

      // Build obstacles (exclude this component and the component at the other end)
      const excludeIds = [this.componentId];
      for (const c of sheet.components) {
        if (c.id === this.componentId) continue;
        const ownsOtherEnd = c.pins.some(p =>
          (p.absolutePosition.x === newEnd.x && p.absolutePosition.y === newEnd.y) ||
          (p.absolutePosition.x === newStart.x && p.absolutePosition.y === newStart.y)
        );
        if (ownsOtherEnd) excludeIds.push(c.id);
      }
      const otherObstacles = getComponentObstacles(sheet.components, symbolSizes, excludeIds);
      const excludedComponents = sheet.components.filter(c => excludeIds.includes(c.id));
      const selfObstacles = getComponentObstacles(excludedComponents, symbolSizes, [], -1);
      const wireObstacles = [...otherObstacles, ...selfObstacles];

      const wireNet = sheet.nets.find(n => n.id === wire.netId);
      const forceWire = wireNet?.connectionMode === 'wire';
      const forceLabel = wireNet?.connectionMode === 'label';

      wiresToReRoute.push({ wire, startMatchIdx, endMatchIdx, newStart, newEnd, obstacles: wireObstacles, forceWire, forceLabel });
      processedWires.add(wire.id);
    }

    // Second pass: batch-route using routeConnectionBatch for overlap avoidance
    // Separate force-label wires (they don't participate in batch routing)
    const batchConnections: { from: Point; to: Point; netName: string }[] = [];
    const batchInfoIndices: number[] = []; // maps batch index → wiresToReRoute index
    const commonObstacles = wiresToReRoute.length > 0 ? wiresToReRoute[0].obstacles : [];

    for (let i = 0; i < wiresToReRoute.length; i++) {
      const info = wiresToReRoute[i];

      if (info.forceLabel) {
        // Handle force-label immediately (no batch)
        const flNet = sheet.nets.find(n => n.id === info.wire.netId);
        const labelNetName = flNet?.name || `NET_${info.wire.id.substring(0, 8)}`;
        let rot1 = 0, rot2 = 0;
        if (info.startMatchIdx >= 0) rot1 = getPinOutwardRotation(info.newStart, comp.position);
        else rot1 = getPinOutwardRotation(info.newStart, findOwnerComponentPosition(sheet, info.newStart, comp.position));
        if (info.endMatchIdx >= 0) rot2 = getPinOutwardRotation(info.newEnd, comp.position);
        else rot2 = getPinOutwardRotation(info.newEnd, findOwnerComponentPosition(sheet, info.newEnd, comp.position));
        const l1: NetLabel = { id: generateId(), position: { ...info.newStart }, netName: labelNetName, rotation: rot1 };
        const l2: NetLabel = { id: generateId(), position: { ...info.newEnd }, netName: labelNetName, rotation: rot2 };
        this.removedWires.push({ wire: { ...info.wire, segments: [...info.wire.segments] }, netId: info.wire.netId });
        this.addedLabels.push(l1, l2);
        sheet.wires = sheet.wires.filter(w => w.id !== info.wire.id);
        const net = sheet.nets.find(n => n.id === info.wire.netId);
        if (net) net.wireIds = net.wireIds.filter(id => id !== info.wire.id);
        sheet.labels.push(l1, l2);
        continue;
      }

      batchConnections.push({ from: info.newStart, to: info.newEnd, netName: '' });
      batchInfoIndices.push(i);
    }

    // Run batch routing (wires avoid each other and avoid pins)
    const batchResults = batchConnections.length > 0
      ? routeConnectionBatch(batchConnections, commonObstacles, allPinPositions, sheet.gridSize)
      : [];

    for (let bi = 0; bi < batchResults.length; bi++) {
      const route = batchResults[bi];
      const info = wiresToReRoute[batchInfoIndices[bi]];

      if (route.type === 'wire') {
        info.wire.segments = route.segments;
      } else if (info.forceWire) {
        // Force wire mode: use direct point-to-point since routing couldn't find a clean path
        info.wire.segments = [{ start: { ...info.newStart }, end: { ...info.newEnd } }];
      } else {
        // Morph Wire to NetLabels
        const existingNet = sheet.nets.find(n => n.id === info.wire.netId);
        const labelNetName = existingNet?.name || `NET_${info.wire.id.substring(0, 8)}`;
        // Update net name to match label name so the label→wire path can find it
        if (existingNet && existingNet.name !== labelNetName) {
          existingNet.name = labelNetName;
        }
        
        let rot1 = 0, rot2 = 0;
        if (info.startMatchIdx >= 0) {
           rot1 = getPinOutwardRotation(info.newStart, comp.position);
        } else {
           rot1 = getPinOutwardRotation(info.newStart, findOwnerComponentPosition(sheet, info.newStart, comp.position));
        }
        if (info.endMatchIdx >= 0) {
           rot2 = getPinOutwardRotation(info.newEnd, comp.position);
        } else {
           rot2 = getPinOutwardRotation(info.newEnd, findOwnerComponentPosition(sheet, info.newEnd, comp.position));
        }
        
        const l1: NetLabel = { id: generateId(), position: { ...info.newStart }, netName: labelNetName, rotation: rot1 };
        const l2: NetLabel = { id: generateId(), position: { ...info.newEnd }, netName: labelNetName, rotation: rot2 };
        
        this.removedWires.push({ wire: { ...info.wire, segments: [...info.wire.segments] }, netId: info.wire.netId });
        this.addedLabels.push(l1, l2);
        
        sheet.wires = sheet.wires.filter(w => w.id !== info.wire.id);
        if (existingNet) existingNet.wireIds = existingNet.wireIds.filter(id => id !== info.wire.id);
        sheet.labels.push(l1, l2);
      }
    }

    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!this.oldPosition) return;
    const sheet = getSheet(doc, this.sheetId);
    const comp = sheet.components.find(c => c.id === this.componentId);
    if (!comp) return;

    const dx = this.oldPosition.x - comp.position.x;
    const dy = this.oldPosition.y - comp.position.y;
    comp.position = { ...this.oldPosition };
    for (const pin of comp.pins) {
      pin.absolutePosition.x += dx;
      pin.absolutePosition.y += dy;
    }

    // Restore wire segments
    for (const backup of this.wireSegmentBackups) {
      const wire = sheet.wires.find(w => w.id === backup.wireId);
      if (wire) {
        wire.segments = backup.oldSegments;
      }
    }

    // Revert morphed wires (labels back to wire)
    for (const hw of this.removedWires) {
      sheet.wires.push(hw.wire);
      const net = sheet.nets.find(n => n.id === hw.netId);
      if (net) net.wireIds.push(hw.wire.id);
    }
    const addedLabelIds = this.addedLabels.map(l => l.id);
    sheet.labels = sheet.labels.filter(l => !addedLabelIds.includes(l.id));

    // Restore label positions
    for (const backup of this.labelPositionBackups) {
      const label = sheet.labels.find(l => l.id === backup.labelId);
      if (label) {
        label.position = { ...backup.oldPosition };
      }
    }

    // Revert morphed labels (wire back to labels)
    for (const l of this.removedLabels) {
      sheet.labels.push(l);
    }
    for (const aw of this.addedWires) {
      sheet.wires = sheet.wires.filter(w => w.id !== aw.wire.id);
      const net = sheet.nets.find(n => n.id === aw.netId);
      if (net) net.wireIds = net.wireIds.filter(id => id !== aw.wire.id);
    }

    doc.updatedAt = new Date().toISOString();
  }
}

export class DeleteComponentCommand {
  type = 'DELETE_COMPONENT';
  description = 'Delete component';
  private sheetId: string;
  private componentId: string;
  private removedComponent: Component | null = null;
  // Cascade-deleted wires (wires touching any pin of the deleted component)
  private removedWires: Wire[] = [];
  // Cascade-deleted net labels located at component pin positions
  private removedLabels: NetLabel[] = [];
  // Cascade options
  private deleteWires: boolean;
  private deleteLabels: boolean;

  constructor(sheetId: string, componentId: string, options?: { deleteWires?: boolean; deleteLabels?: boolean }) {
    this.sheetId = sheetId;
    this.componentId = componentId;
    this.deleteWires = options?.deleteWires ?? true;
    this.deleteLabels = options?.deleteLabels ?? true;
  }

  execute(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const idx = sheet.components.findIndex(c => c.id === this.componentId);
    if (idx === -1) return;
    this.removedComponent = sheet.components[idx];
    this.description = `Delete ${this.removedComponent.designator}`;

    // Collect pin positions of the component being deleted
    const pinPositions = this.removedComponent.pins.map(p => p.absolutePosition);

    // Find and remove wires attached to any pin of this component
    this.removedWires = [];
    if (this.deleteWires) {
      const wiresToRemove: Wire[] = [];
      for (const wire of sheet.wires) {
        const firstSeg = wire.segments[0];
        const lastSeg = wire.segments[wire.segments.length - 1];
        const wireStart = firstSeg.start;
        const wireEnd = lastSeg.end;

        const touchesPin = pinPositions.some(pp =>
          (wireStart.x === pp.x && wireStart.y === pp.y) ||
          (wireEnd.x === pp.x && wireEnd.y === pp.y)
        );

        if (touchesPin) {
          wiresToRemove.push(wire);
        }
      }

      for (const wire of wiresToRemove) {
        this.removedWires.push(wire);
        sheet.wires = sheet.wires.filter(w => w.id !== wire.id);
        // Remove wire ID from its net
        const net = sheet.nets.find(n => n.id === wire.netId);
        if (net) {
          net.wireIds = net.wireIds.filter(id => id !== wire.id);
        }
      }
    }

    // Find and remove net labels at pin positions
    this.removedLabels = [];
    if (this.deleteLabels) {
      const labelsToRemove: NetLabel[] = [];
      for (const label of sheet.labels) {
        const atPin = pinPositions.some(pp =>
          label.position.x === pp.x && label.position.y === pp.y
        );
        if (atPin) {
          labelsToRemove.push(label);
        }
      }
      for (const label of labelsToRemove) {
        this.removedLabels.push(label);
        sheet.labels = sheet.labels.filter(l => l.id !== label.id);
      }
    }

    // Remove the component
    sheet.components.splice(idx, 1);
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!this.removedComponent) return;
    const sheet = getSheet(doc, this.sheetId);

    // Restore the component
    sheet.components.push(this.removedComponent);

    // Restore wires
    for (const wire of this.removedWires) {
      sheet.wires.push(wire);
      const net = sheet.nets.find(n => n.id === wire.netId);
      if (net) {
        net.wireIds.push(wire.id);
      }
    }

    // Restore labels
    for (const label of this.removedLabels) {
      sheet.labels.push(label);
    }

    doc.updatedAt = new Date().toISOString();
  }
}

export class DeleteWireCommand {
  type = 'DELETE_WIRE';
  description = 'Delete wire';
  private sheetId: string;
  private wireId: string;
  private removedWire: Wire | null = null;

  constructor(sheetId: string, wireId: string) {
    this.sheetId = sheetId;
    this.wireId = wireId;
  }

  execute(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const idx = sheet.wires.findIndex(w => w.id === this.wireId);
    if (idx === -1) return;
    this.removedWire = sheet.wires[idx];
    sheet.wires.splice(idx, 1);

    // Remove wire ID from its net
    const net = sheet.nets.find(n => n.id === this.removedWire!.netId);
    if (net) {
      net.wireIds = net.wireIds.filter(id => id !== this.wireId);
    }

    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!this.removedWire) return;
    const sheet = getSheet(doc, this.sheetId);
    sheet.wires.push(this.removedWire);

    // Re-add wire ID to its net
    const net = sheet.nets.find(n => n.id === this.removedWire!.netId);
    if (net) {
      net.wireIds.push(this.removedWire.id);
    }

    doc.updatedAt = new Date().toISOString();
  }
}

export class RotateComponentCommand {
  type = 'ROTATE_COMPONENT';
  description = 'Rotate component';
  private sheetId: string;
  private componentId: string;
  private def: ComponentDefinition;
  private oldRotation: 0 | 90 | 180 | 270 = 0;
  private oldPinPositions: Point[] = [];
  // Track full wire re-routes for undo
  private wireSegmentBackups: { wireId: string; oldSegments: WireSegment[] }[] = [];
  // Track label position changes for undo
  private labelPositionBackups: { labelId: string; oldPosition: Point; oldRotation?: number }[] = [];
  // Morph state
  private removedWires: { wire: Wire; netId: string }[] = [];
  private addedLabels: NetLabel[] = [];
  private removedLabels: NetLabel[] = [];
  private addedWires: { wire: Wire; netId: string }[] = [];

  constructor(sheetId: string, componentId: string, def: ComponentDefinition) {
    this.sheetId = sheetId;
    this.componentId = componentId;
    this.def = def;
  }

  execute(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const comp = sheet.components.find(c => c.id === this.componentId);
    if (!comp) return;

    this.oldRotation = comp.rotation;

    // Save old pin positions for wire matching
    this.oldPinPositions = comp.pins.map(p => ({ ...p.absolutePosition }));

    // Advance rotation by 90° CW
    comp.rotation = ((comp.rotation + 90) % 360) as 0 | 90 | 180 | 270;

    // Recalculate pin absolute positions from definition + new rotation
    for (const pin of comp.pins) {
      const pinDef = this.def.symbol.pins.find(p => p.id === pin.definitionId);
      if (!pinDef) continue;
      const rotated = rotatePoint(pinDef.position, comp.rotation);
      pin.absolutePosition = {
        x: comp.position.x + rotated.x,
        y: comp.position.y + rotated.y
      };
    }

    // Move net labels at old pin positions
    this.labelPositionBackups = [];
    for (const label of sheet.labels) {
      for (let pi = 0; pi < this.oldPinPositions.length; pi++) {
        const oldPP = this.oldPinPositions[pi];
        if (label.position.x === oldPP.x && label.position.y === oldPP.y) {
          this.labelPositionBackups.push({ labelId: label.id, oldPosition: { ...label.position }, oldRotation: label.rotation });
          label.position = { ...comp.pins[pi].absolutePosition };
          label.rotation = getPinOutwardRotation(label.position, comp.position);
          break;
        }
      }
    }

    // Prepare obstacles
    const symbolSizes = new Map<string, { width: number; height: number }>();
    for (const c of sheet.components) {
      if (symbolSizes.has(c.libraryId)) continue;
      let minX = 0, maxX = 0, minY = 0, maxY = 0;
      for (const p of c.pins) {
        const dx = p.absolutePosition.x - c.position.x;
        const dy = p.absolutePosition.y - c.position.y;
        if (dx < minX) minX = dx;
        if (dx > maxX) maxX = dx;
        if (dy < minY) minY = dy;
        if (dy > maxY) maxY = dy;
      }
      let w = maxX - minX;
      let h = maxY - minY;
      if (c.rotation === 90 || c.rotation === 270) {
        w = maxY - minY;
        h = maxX - minX;
      }
      symbolSizes.set(c.libraryId, { width: Math.max(20, w), height: Math.max(20, h) });
    }
    const excludeIdsForDrag = [this.componentId];

    // Check if we can morph any moved label into a wire
    this.removedLabels = [];
    this.addedWires = [];
    for (const backup of this.labelPositionBackups) {
      const movedLabel = sheet.labels.find(l => l.id === backup.labelId);
      if (!movedLabel) continue;

      const peers = sheet.labels.filter(l => l.netName === movedLabel.netName && l.id !== movedLabel.id);
      if (peers.length === 1) {
        const peer = peers[0];
        const localExclude = [...excludeIdsForDrag];
        for (const c of sheet.components) {
           if (c.pins.some(p => (p.absolutePosition.x === movedLabel.position.x && p.absolutePosition.y === movedLabel.position.y) || 
                                (p.absolutePosition.x === peer.position.x && p.absolutePosition.y === peer.position.y))) {
             if (!localExclude.includes(c.id)) localExclude.push(c.id);
           }
        }
        const otherObstacles = getComponentObstacles(sheet.components, symbolSizes, localExclude);
        const excludedComponents = sheet.components.filter(c => localExclude.includes(c.id));
        const selfObstacles = getComponentObstacles(excludedComponents, symbolSizes, [], -1);
        const obstacles = [...otherObstacles, ...selfObstacles];
        const route = routeConnection(movedLabel.position, peer.position, obstacles, '', sheet.gridSize);
        
        if (route.type === 'wire') {
          // Find or create a net for this wire
          let foundNetId = '';
          for (const c of sheet.components) {
            for (const p of c.pins) {
              if ((p.absolutePosition.x === movedLabel.position.x && p.absolutePosition.y === movedLabel.position.y) ||
                  (p.absolutePosition.x === peer.position.x && p.absolutePosition.y === peer.position.y)) {
                if (p.netId) { foundNetId = p.netId; break; }
              }
            }
            if (foundNetId) break;
          }

          if (!foundNetId) {
            foundNetId = generateId();
            const newNet = { id: foundNetId, name: movedLabel.netName || `Net_${sheet.nets.length + 1}`, pinIds: [], wireIds: [] };
            sheet.nets.push(newNet);
          }

          for (const c of sheet.components) {
            for (const p of c.pins) {
              if ((p.absolutePosition.x === movedLabel.position.x && p.absolutePosition.y === movedLabel.position.y) ||
                  (p.absolutePosition.x === peer.position.x && p.absolutePosition.y === peer.position.y)) {
                if (!p.netId) p.netId = foundNetId;
              }
            }
          }

          const newWire: Wire = { id: generateId(), netId: foundNetId, segments: route.segments };
          this.removedLabels.push({ ...movedLabel }, { ...peer });
          this.addedWires.push({ wire: newWire, netId: foundNetId });

          sheet.labels = sheet.labels.filter(l => l.id !== movedLabel.id && l.id !== peer.id);
          sheet.wires.push(newWire);
          const net = sheet.nets.find(n => n.id === foundNetId);
          if (net) net.wireIds.push(newWire.id);
        }
      }
    }

    // Re-route wires connected to this component
    this.wireSegmentBackups = [];
    this.removedWires = [];
    this.addedLabels = [];
    const processedWires = new Set<string>();

    // Collect all pin positions on the sheet for pin-avoidance routing
    const allPinPositions: Point[] = [];
    for (const c of sheet.components) {
      for (const p of c.pins) {
        allPinPositions.push({ x: p.absolutePosition.x, y: p.absolutePosition.y });
      }
    }

    // First pass: identify wires that need re-routing
    type RotWireReRouteInfo = {
      wire: Wire;
      startMatchIdx: number;
      endMatchIdx: number;
      newStart: Point;
      newEnd: Point;
      obstacles: BoundingBox[];
    };
    const wiresToReRoute: RotWireReRouteInfo[] = [];

    for (const wire of [...sheet.wires]) {
      if (processedWires.has(wire.id)) continue;

      const firstSeg = wire.segments[0];
      const lastSeg = wire.segments[wire.segments.length - 1];
      const wireStart = firstSeg.start;
      const wireEnd = lastSeg.end;

      // Check if any old pin was at the wire's start or end
      let startMatchIdx = -1;
      let endMatchIdx = -1;
      for (let pi = 0; pi < this.oldPinPositions.length; pi++) {
        const pp = this.oldPinPositions[pi];
        if (wireStart.x === pp.x && wireStart.y === pp.y) startMatchIdx = pi;
        if (wireEnd.x === pp.x && wireEnd.y === pp.y) endMatchIdx = pi;
      }

      if (startMatchIdx === -1 && endMatchIdx === -1) continue;

      // Back up old segments for undo
      this.wireSegmentBackups.push({
        wireId: wire.id,
        oldSegments: wire.segments.map(s => ({ start: { ...s.start }, end: { ...s.end } })),
      });

      // Compute new endpoints
      const newStart = startMatchIdx >= 0
        ? { ...comp.pins[startMatchIdx].absolutePosition }
        : { ...wireStart };
      const newEnd = endMatchIdx >= 0
        ? { ...comp.pins[endMatchIdx].absolutePosition }
        : { ...wireEnd };

      // Build obstacles
      const excludeIds = [this.componentId];
      for (const c of sheet.components) {
        if (c.id === this.componentId) continue;
        const ownsOtherEnd = c.pins.some(p =>
          (p.absolutePosition.x === newEnd.x && p.absolutePosition.y === newEnd.y) ||
          (p.absolutePosition.x === newStart.x && p.absolutePosition.y === newStart.y)
        );
        if (ownsOtherEnd) excludeIds.push(c.id);
      }
      const otherObstacles = getComponentObstacles(sheet.components, symbolSizes, excludeIds);
      const excludedComponents = sheet.components.filter(c => excludeIds.includes(c.id));
      const selfObstacles = getComponentObstacles(excludedComponents, symbolSizes, [], -1);
      const wireObstacles = [...otherObstacles, ...selfObstacles];

      wiresToReRoute.push({ wire, startMatchIdx, endMatchIdx, newStart, newEnd, obstacles: wireObstacles });
      processedWires.add(wire.id);
    }

    // Second pass: batch-route for overlap avoidance
    const batchConnections: { from: Point; to: Point; netName: string }[] = [];
    const batchInfoIndices: number[] = [];
    const commonObstacles = wiresToReRoute.length > 0 ? wiresToReRoute[0].obstacles : [];

    for (let i = 0; i < wiresToReRoute.length; i++) {
      batchConnections.push({ from: wiresToReRoute[i].newStart, to: wiresToReRoute[i].newEnd, netName: '' });
      batchInfoIndices.push(i);
    }

    const batchResults = batchConnections.length > 0
      ? routeConnectionBatch(batchConnections, commonObstacles, allPinPositions, sheet.gridSize)
      : [];

    for (let bi = 0; bi < batchResults.length; bi++) {
      const route = batchResults[bi];
      const info = wiresToReRoute[batchInfoIndices[bi]];

      if (route.type === 'wire') {
        info.wire.segments = route.segments;
      } else {
        // Morph Wire to NetLabels
        const labelNetName = `NET_${info.wire.id.substring(0, 8)}`;
        
        let rot1 = 0, rot2 = 0;
        if (info.startMatchIdx >= 0) {
           rot1 = getPinOutwardRotation(info.newStart, comp.position);
        } else {
           rot1 = getPinOutwardRotation(info.newStart, findOwnerComponentPosition(sheet, info.newStart, comp.position));
        }
        if (info.endMatchIdx >= 0) {
           rot2 = getPinOutwardRotation(info.newEnd, comp.position);
        } else {
           rot2 = getPinOutwardRotation(info.newEnd, findOwnerComponentPosition(sheet, info.newEnd, comp.position));
        }

        const l1: NetLabel = { id: generateId(), position: { ...info.newStart }, netName: labelNetName, rotation: rot1 };
        const l2: NetLabel = { id: generateId(), position: { ...info.newEnd }, netName: labelNetName, rotation: rot2 };
        
        this.removedWires.push({ wire: { ...info.wire, segments: [...info.wire.segments] }, netId: info.wire.netId });
        this.addedLabels.push(l1, l2);
        
        sheet.wires = sheet.wires.filter(w => w.id !== info.wire.id);
        const net = sheet.nets.find(n => n.id === info.wire.netId);
        if (net) net.wireIds = net.wireIds.filter(id => id !== info.wire.id);
        sheet.labels.push(l1, l2);
      }
    }

    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const comp = sheet.components.find(c => c.id === this.componentId);
    if (!comp) return;

    comp.rotation = this.oldRotation;

    // Restore pin positions
    for (let i = 0; i < comp.pins.length; i++) {
      if (this.oldPinPositions[i]) {
        comp.pins[i].absolutePosition = { ...this.oldPinPositions[i] };
      }
    }

    // Restore wire segments
    for (const backup of this.wireSegmentBackups) {
      const wire = sheet.wires.find(w => w.id === backup.wireId);
      if (wire) {
        wire.segments = backup.oldSegments;
      }
    }

    // Revert morphed wires (labels back to wire)
    for (const hw of this.removedWires) {
      sheet.wires.push(hw.wire);
      const net = sheet.nets.find(n => n.id === hw.netId);
      if (net) net.wireIds.push(hw.wire.id);
    }
    const addedLabelIds = this.addedLabels.map(l => l.id);
    sheet.labels = sheet.labels.filter(l => !addedLabelIds.includes(l.id));

    // Restore label positions
    for (const backup of this.labelPositionBackups) {
      const label = sheet.labels.find(l => l.id === backup.labelId);
      if (label) {
        label.position = { ...backup.oldPosition };
        if (backup.oldRotation !== undefined) {
          label.rotation = backup.oldRotation;
        }
      }
    }

    // Revert morphed labels (wire back to labels)
    for (const l of this.removedLabels) {
      sheet.labels.push(l);
    }
    for (const aw of this.addedWires) {
      sheet.wires = sheet.wires.filter(w => w.id !== aw.wire.id);
      const net = sheet.nets.find(n => n.id === aw.netId);
      if (net) net.wireIds = net.wireIds.filter(id => id !== aw.wire.id);
    }

    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Rotate a point around the origin by [angle] degrees clockwise.
 *   90° CW: (x,y) → (y, -x)
 *  180°:    (x,y) → (-x, -y)
 *  270° CW: (x,y) → (-y, x)
 */
function rotatePoint(p: Point, angleDeg: number): Point {
  switch (((angleDeg % 360) + 360) % 360) {
    case 90:  return { x:  p.y, y: -p.x };
    case 180: return { x: -p.x, y: -p.y };
    case 270: return { x: -p.y, y:  p.x };
    default:  return { x:  p.x, y:  p.y };
  }
}

// ----- Wire Commands -----

export class AddWireCommand {
  type = 'ADD_WIRE';
  description = 'Add wire';
  private sheetId: string;
  private _segments: WireSegment[];
  private wireId: string;
  private netId: string;

  constructor(sheetId: string, segments: WireSegment[]) {
    this.sheetId = sheetId;
    this._segments = segments;
    this.wireId = generateId();
    this.netId = generateId();
  }

  execute(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const wire: Wire = {
      id: this.wireId,
      netId: this.netId,
      segments: this._segments.map(s => ({ start: { ...s.start }, end: { ...s.end } }))
    };

    let net = sheet.nets.find(n => n.id === this.netId);
    if (!net) {
      net = { id: this.netId, name: `Net_${sheet.nets.length + 1}`, pinIds: [], wireIds: [] };
      sheet.nets.push(net);
    }
    net.wireIds.push(this.wireId);
    sheet.wires.push(wire);
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    sheet.wires = sheet.wires.filter(w => w.id !== this.wireId);
    const net = sheet.nets.find(n => n.id === this.netId);
    if (net) {
      net.wireIds = net.wireIds.filter(id => id !== this.wireId);
      if (net.wireIds.length === 0 && net.pinIds.length === 0) {
        sheet.nets = sheet.nets.filter(n => n.id !== this.netId);
      }
    }
    doc.updatedAt = new Date().toISOString();
  }
}

// ----- Wire Node Commands -----

export class AddWireNodeCommand {
  type = 'ADD_WIRE_NODE';
  description = 'Add wire node';
  private sheetId: string;
  private wireId: string;
  private position: Point;
  private nodeId: string;
  private segmentIndex = -1;
  private oldSegment: WireSegment | null = null;

  constructor(sheetId: string, wireId: string, position: Point) {
    this.sheetId = sheetId;
    this.wireId = wireId;
    this.position = { ...position };
    this.nodeId = generateId();
  }

  execute(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const wire = sheet.wires.find(w => w.id === this.wireId);
    if (!wire) return;

    // Find the closest segment to the click point
    let bestDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < wire.segments.length; i++) {
      const seg = wire.segments[i];
      const dist = pointToSegDist(this.position, seg.start, seg.end);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    this.segmentIndex = bestIdx;
    this.oldSegment = {
      start: { ...wire.segments[bestIdx].start },
      end: { ...wire.segments[bestIdx].end },
    };

    // Split the segment at the node position into two orthogonal segments
    const seg = wire.segments[bestIdx];
    const origStart = { ...seg.start };
    const origEnd = { ...seg.end };

    // Create two new segments routed through the node point
    const newSegs = buildOrthogonalThrough(origStart, this.position, origEnd);
    wire.segments.splice(bestIdx, 1, ...newSegs);

    // Initialize nodes array if needed
    if (!wire.nodes) wire.nodes = [];

    // Update existing node segmentIndexes that are after the insertion point
    for (const n of wire.nodes) {
      if (n.segmentIndex >= bestIdx) {
        n.segmentIndex += newSegs.length - 1;
      }
    }

    const node: WireNode = {
      id: this.nodeId,
      position: { ...this.position },
      wireId: this.wireId,
      segmentIndex: bestIdx, // sits after the first new segment
    };
    wire.nodes.push(node);
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const wire = sheet.wires.find(w => w.id === this.wireId);
    if (!wire || !this.oldSegment) return;

    // Remove the node
    wire.nodes = (wire.nodes || []).filter(n => n.id !== this.nodeId);

    // Figure out how many segments replaced the original one
    // We need to find the segments created for this node and merge them back
    const origEnd = this.oldSegment.end;

    // The new segments start at segmentIndex and we need to find how many to remove
    // We inserted newSegs in place of 1 segment, so count = newSegs.length
    // Find segs between origStart and origEnd
    let removeCount = 0;
    for (let i = this.segmentIndex; i < wire.segments.length; i++) {
      removeCount++;
      const seg = wire.segments[i];
      if (seg.end.x === origEnd.x && seg.end.y === origEnd.y) break;
    }

    wire.segments.splice(this.segmentIndex, removeCount, { ...this.oldSegment });

    // Restore node segmentIndexes
    for (const n of wire.nodes) {
      if (n.segmentIndex >= this.segmentIndex + 1) {
        n.segmentIndex -= removeCount - 1;
      }
    }

    doc.updatedAt = new Date().toISOString();
  }
}

export class MoveWireNodeCommand {
  type = 'MOVE_WIRE_NODE';
  description = 'Move wire node';
  private sheetId: string;
  private nodeId: string;
  private wireId: string;
  private newPosition: Point;
  private oldPosition: Point | null = null;
  private oldSegments: WireSegment[] = [];

  constructor(sheetId: string, nodeId: string, wireId: string, newPosition: Point) {
    this.sheetId = sheetId;
    this.nodeId = nodeId;
    this.wireId = wireId;
    this.newPosition = { ...newPosition };
  }

  execute(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const wire = sheet.wires.find(w => w.id === this.wireId);
    if (!wire || !wire.nodes) return;

    const node = wire.nodes.find(n => n.id === this.nodeId);
    if (!node) return;

    this.oldPosition = { ...node.position };
    this.oldSegments = wire.segments.map(s => ({ start: { ...s.start }, end: { ...s.end } }));

    // Update node position
    node.position = { ...this.newPosition };

    // Rebuild all segments based on the ordered waypoints (start, nodes..., end)
    rebuildWireSegments(wire);
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!this.oldPosition) return;
    const sheet = getSheet(doc, this.sheetId);
    const wire = sheet.wires.find(w => w.id === this.wireId);
    if (!wire || !wire.nodes) return;

    const node = wire.nodes.find(n => n.id === this.nodeId);
    if (!node) return;

    node.position = { ...this.oldPosition };
    wire.segments = this.oldSegments;
    doc.updatedAt = new Date().toISOString();
  }
}

export class DeleteWireNodeCommand {
  type = 'DELETE_WIRE_NODE';
  description = 'Delete wire node';
  private sheetId: string;
  private nodeId: string;
  private wireId: string;
  private removedNode: WireNode | null = null;
  private oldSegments: WireSegment[] = [];

  constructor(sheetId: string, nodeId: string, wireId: string) {
    this.sheetId = sheetId;
    this.nodeId = nodeId;
    this.wireId = wireId;
  }

  execute(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    const wire = sheet.wires.find(w => w.id === this.wireId);
    if (!wire || !wire.nodes) return;

    const nodeIdx = wire.nodes.findIndex(n => n.id === this.nodeId);
    if (nodeIdx === -1) return;

    this.removedNode = { ...wire.nodes[nodeIdx] };
    this.oldSegments = wire.segments.map(s => ({ start: { ...s.start }, end: { ...s.end } }));

    // Remove the node
    wire.nodes.splice(nodeIdx, 1);

    // Rebuild segments from remaining waypoints
    rebuildWireSegments(wire);
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!this.removedNode) return;
    const sheet = getSheet(doc, this.sheetId);
    const wire = sheet.wires.find(w => w.id === this.wireId);
    if (!wire) return;

    if (!wire.nodes) wire.nodes = [];
    wire.nodes.push({ ...this.removedNode });
    wire.segments = this.oldSegments;
    doc.updatedAt = new Date().toISOString();
  }
}

/** Build orthogonal segments from A through midpoint M to B. */
function buildOrthogonalThrough(a: Point, m: Point, b: Point): WireSegment[] {
  const segments: WireSegment[] = [];
  // A -> M
  if (a.x !== m.x && a.y !== m.y) {
    // Need an L-bend
    segments.push({ start: { ...a }, end: { x: m.x, y: a.y } });
    segments.push({ start: { x: m.x, y: a.y }, end: { ...m } });
  } else {
    segments.push({ start: { ...a }, end: { ...m } });
  }
  // M -> B
  if (m.x !== b.x && m.y !== b.y) {
    segments.push({ start: { ...m }, end: { x: b.x, y: m.y } });
    segments.push({ start: { x: b.x, y: m.y }, end: { ...b } });
  } else {
    segments.push({ start: { ...m }, end: { ...b } });
  }
  return segments;
}

/** Rebuild wire segments from ordered waypoints: wireStart → nodes (ordered by position along wire) → wireEnd. */
function rebuildWireSegments(wire: Wire): void {
  if (!wire.segments.length) return;
  const wireStart = { ...wire.segments[0].start };
  const wireEnd = { ...wire.segments[wire.segments.length - 1].end };

  // Sort nodes by their segmentIndex to get the correct order
  const sortedNodes = [...(wire.nodes || [])].sort((a, b) => a.segmentIndex - b.segmentIndex);

  // Build waypoint list: start, node positions, end
  const waypoints: Point[] = [wireStart, ...sortedNodes.map(n => n.position), wireEnd];

  // Build segments between consecutive waypoints
  const newSegments: WireSegment[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];
    if (from.x === to.x || from.y === to.y) {
      // Already aligned — single segment
      newSegments.push({ start: { ...from }, end: { ...to } });
    } else {
      // Need an L-bend
      newSegments.push({ start: { ...from }, end: { x: to.x, y: from.y } });
      newSegments.push({ start: { x: to.x, y: from.y }, end: { ...to } });
    }
  }

  wire.segments = newSegments;

  // Update segmentIndex for each node to reflect where it sits in the new segment array
  for (let ni = 0; ni < sortedNodes.length; ni++) {
    const nodePos = sortedNodes[ni].position;
    // Find the segment whose end matches this node's position
    for (let si = 0; si < wire.segments.length; si++) {
      const seg = wire.segments[si];
      if (seg.end.x === nodePos.x && seg.end.y === nodePos.y) {
        sortedNodes[ni].segmentIndex = si;
        break;
      }
    }
  }
}

/** Point-to-segment distance helper. */
function pointToSegDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ----- Fuzzy Pin Matching -----

/**
 * Find a pin definition by name/id using a multi-tier matching strategy:
 * 1. Exact match on name or id
 * 2. Case-insensitive match on name or id
 * 3. One name starts with the other (handles abbreviations like TRIG/TRIGGER)
 * 4. Pin number fallback (numeric string matches)
 */
function findPinDef(pins: PinDefinition[], ref: string): PinDefinition | undefined {
  // 1. Exact match
  const exact = pins.find(p => p.name === ref || p.id === ref);
  if (exact) return exact;

  // 2. Case-insensitive match
  const refLower = ref.toLowerCase();
  const caseMatch = pins.find(
    p => p.name.toLowerCase() === refLower || p.id.toLowerCase() === refLower
  );
  if (caseMatch) return caseMatch;

  // 3. Substring/prefix match (LLM sends "TRIGGER" but pin is "TRIG", or vice versa)
  const prefixMatch = pins.find(p => {
    const nameLower = p.name.toLowerCase();
    return nameLower.startsWith(refLower) || refLower.startsWith(nameLower);
  });
  if (prefixMatch) return prefixMatch;

  // 3.5 Alias match
  const ALIASES: Record<string, string[]> = {
    'reset': ['rst', 'res', 'clr', 'clear', 'mclr'],
    'ctrl': ['cont', 'control', 'ctl'],
    'gnd': ['vss', 'ground', '0v', 'gnda', 'gndd', 'power'],
    'vcc': ['vdd', 'vin', 'vbat', 'v+', '+5v', '+3v3', '5v', '3.3v', 'power'],
    'in': ['input', 'i'],
    'out': ['output', 'o', 'q'],
    'clk': ['clock', 'sck', 'scl']
  };

  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    const group = [canonical, ...aliases];
    if (group.includes(refLower)) {
      const aliasMatch = pins.find(p => group.includes(p.name.toLowerCase()));
      if (aliasMatch) return aliasMatch;
    }
  }

  // 4. Pin number fallback — if ref is numeric, try matching pin id numerically
  if (/^\d+$/.test(ref)) {
    const numMatch = pins.find(p => p.id === ref || p.name === ref);
    if (numMatch) return numMatch;
    // Try matching by index (1-based)
    const idx = parseInt(ref, 10) - 1;
    if (idx >= 0 && idx < pins.length) return pins[idx];
  }

  return undefined;
}

// ----- Subcircuit Command -----

export interface SubcircuitComponentInput {
  def: ComponentDefinition;
  position: Point;
  value: string;
  designator: string;
}

export interface SubcircuitConnectionInput {
  fromDesignator: string;
  fromPin: string;
  toDesignator: string;
  toPin: string;
  netName?: string;
}

export class AddSubcircuitCommand {
  type = 'ADD_SUBCIRCUIT';
  description: string;
  /** Number of connections actually created (vs requested). Set after execute(). */
  connectionsCreated = 0;
  /** Detailed error messages for failed connections. */
  failedConnections: string[] = [];

  private sheetId: string;
  private components: SubcircuitComponentInput[];
  private connections: SubcircuitConnectionInput[];

  // Track created IDs for undo
  private createdComponentIds: string[] = [];
  private createdWireIds: string[] = [];
  private createdNetIds: string[] = [];
  private createdLabelIds: string[] = [];
  // Track pin netId assignments for undo (componentId + definitionId → previous netId)
  private pinNetAssignments: { componentId: string; definitionId: string; previousNetId: string | null }[] = [];

  private existingDefs?: Record<string, ComponentDefinition>;

  constructor(
    sheetId: string,
    components: SubcircuitComponentInput[],
    connections: SubcircuitConnectionInput[],
    existingDefs?: Record<string, ComponentDefinition>
  ) {
    this.sheetId = sheetId;
    this.components = components;
    this.connections = connections;
    this.existingDefs = existingDefs;
    this.description = `Add subcircuit (${components.length} parts, ${connections.length} connections)`;
  }

  execute(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);
    this.connectionsCreated = 0;
    this.failedConnections = [];

    // 1. Add all components
    const compMap = new Map<string, Component>();  // designator → placed component
    for (const input of this.components) {
      const componentId = generateId();
      this.createdComponentIds.push(componentId);

      const pins: PinInstance[] = input.def.symbol.pins.map(p => ({
        definitionId: p.id,
        componentId,
        absolutePosition: {
          x: input.position.x + p.position.x,
          y: input.position.y + p.position.y
        },
        netId: null
      }));

      const component: Component = {
        id: componentId,
        libraryId: input.def.id,
        designator: input.designator,
        value: input.value,
        position: { ...input.position },
        rotation: 0,
        mirror: false,
        pins,
        properties: {}
      };

      sheet.components.push(component);
      compMap.set(input.designator, component);
    }

    // 2. Build obstacle map for wire routing
    const symbolSizes = new Map<string, { width: number; height: number }>();
    for (const input of this.components) {
      symbolSizes.set(input.def.id, {
        width: input.def.symbol?.width ?? 60,
        height: input.def.symbol?.height ?? 40,
      });
    }
    const existingNetNames = new Set(sheet.labels.map(l => l.netName));

    // 3. Process connections — create wires or net labels
    const netsByName = new Map<string, { id: string; name: string; pinIds: string[]; wireIds: string[] }>();

    for (const conn of this.connections) {
      let fromComp = compMap.get(conn.fromDesignator);
      let toComp = compMap.get(conn.toDesignator);
      
      let fromIsExisting = false;
      let toIsExisting = false;

      // Fallback to existing schematic components
      if (!fromComp) {
        fromComp = sheet.components.find(c => c.designator === conn.fromDesignator);
        fromIsExisting = true;
      }
      if (!toComp) {
        toComp = sheet.components.find(c => c.designator === conn.toDesignator);
        toIsExisting = true;
      }

      if (!fromComp || !toComp) {
        const msg = `Component not found (${conn.fromDesignator} → ${conn.toDesignator})`;
        console.warn(`[Subcircuit] Skipping connection: ${msg}`);
        this.failedConnections.push(msg);
        continue;
      }

      // Find the pin instances by matching pin name to definition (fuzzy)
      const fromDef = fromIsExisting 
        ? this.existingDefs?.[conn.fromDesignator] 
        : this.components.find(c => c.designator === conn.fromDesignator)?.def;
      const toDef = toIsExisting 
        ? this.existingDefs?.[conn.toDesignator] 
        : this.components.find(c => c.designator === conn.toDesignator)?.def;

      if (!fromDef || !toDef) {
        let missing = [];
        if (!fromDef) missing.push(conn.fromDesignator);
        if (!toDef) missing.push(conn.toDesignator);
        const msg = `Missing component definition for: ${missing.join(', ')}`;
        console.warn(`[Subcircuit] Skipping connection: ${msg}`);
        this.failedConnections.push(msg);
        continue;
      }

      const fromPinDef = findPinDef(fromDef.symbol.pins, conn.fromPin);
      const toPinDef = findPinDef(toDef.symbol.pins, conn.toPin);

      if (!fromPinDef) {
        const available = fromDef.symbol.pins.map(p => p.name || p.id).join(', ');
        const msg = `Pin "${conn.fromPin}" not found on ${conn.fromDesignator} (available: ${available})`;
        console.warn(`[Subcircuit] Skipping connection: ${msg}`);
        this.failedConnections.push(msg);
        continue;
      }
      if (!toPinDef) {
        const available = toDef.symbol.pins.map(p => p.name || p.id).join(', ');
        const msg = `Pin "${conn.toPin}" not found on ${conn.toDesignator} (available: ${available})`;
        console.warn(`[Subcircuit] Skipping connection: ${msg}`);
        this.failedConnections.push(msg);
        continue;
      }

      const fromPinInstance = fromComp.pins.find(p => p.definitionId === fromPinDef.id);
      const toPinInstance = toComp.pins.find(p => p.definitionId === toPinDef.id);
      if (!fromPinInstance || !toPinInstance) {
        const msg = `Pin instance missing for ${conn.fromDesignator}.${conn.fromPin} or ${conn.toDesignator}.${conn.toPin}`;
        console.warn(`[Subcircuit] Skipping connection: ${msg}`);
        this.failedConnections.push(msg);
        continue;
      }

      // Create or reuse net
      const netKey = conn.netName || `SubNet_${generateId()}`;
      let net = netsByName.get(netKey);
      if (!net) {
        const netId = generateId();
        net = { id: netId, name: conn.netName || `Net_${sheet.nets.length + netsByName.size + 1}`, pinIds: [], wireIds: [] };
        netsByName.set(netKey, net);
        this.createdNetIds.push(netId);
      }

      // Route the connection: orthogonal wire or net labels
      const otherObstacles = getComponentObstacles(
        sheet.components, symbolSizes, [fromComp.id, toComp.id]
      );
      const selfObstacles = getComponentObstacles([fromComp, toComp], symbolSizes, [], -1);
      const obstacles = [...otherObstacles, ...selfObstacles];
      const labelNetName = conn.netName || generateNetName(
        conn.fromDesignator, conn.fromPin,
        conn.toDesignator, conn.toPin,
        existingNetNames
      );
      const route = routeConnection(
        fromPinInstance.absolutePosition,
        toPinInstance.absolutePosition,
        obstacles, labelNetName, sheet.gridSize
      );

      if (route.type === 'wire') {
        // Create wire with orthogonal segments
        const wireId = generateId();
        const wire: Wire = {
          id: wireId,
          netId: net.id,
          segments: route.segments,
        };
        sheet.wires.push(wire);
        net.wireIds.push(wireId);
        this.createdWireIds.push(wireId);
      } else {
        // Create net labels at both pin positions
        const label1Id = generateId();
        const label2Id = generateId();
        const label1: NetLabel = {
          id: label1Id,
          position: { ...fromPinInstance.absolutePosition },
          netName: route.netName,
          rotation: getPinOutwardRotation(fromPinInstance.absolutePosition, fromComp.position),
        };
        const label2: NetLabel = {
          id: label2Id,
          position: { ...toPinInstance.absolutePosition },
          netName: route.netName,
          rotation: getPinOutwardRotation(toPinInstance.absolutePosition, toComp.position),
        };
        sheet.labels.push(label1, label2);
        this.createdLabelIds.push(label1Id, label2Id);
        existingNetNames.add(route.netName);
      }

      // Assign pins to net
      const fromPinId = `${fromComp.id}:${fromPinDef.id}`;
      const toPinId = `${toComp.id}:${toPinDef.id}`;

      if (!net.pinIds.includes(fromPinId)) net.pinIds.push(fromPinId);
      if (!net.pinIds.includes(toPinId)) net.pinIds.push(toPinId);

      // Track for undo and set netId on pin instances
      this.pinNetAssignments.push(
        { componentId: fromComp.id, definitionId: fromPinDef.id, previousNetId: fromPinInstance.netId },
        { componentId: toComp.id, definitionId: toPinDef.id, previousNetId: toPinInstance.netId }
      );
      fromPinInstance.netId = net.id;
      toPinInstance.netId = net.id;

      this.connectionsCreated++;
    }

    // Push all created nets to the sheet
    for (const net of netsByName.values()) {
      sheet.nets.push(net);
    }

    if (this.connectionsCreated < this.connections.length) {
      console.warn(
        `[Subcircuit] ${this.connectionsCreated}/${this.connections.length} connections created ` +
        `(${this.connections.length - this.connectionsCreated} failed due to pin matching issues)`
      );
    }

    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    const sheet = getSheet(doc, this.sheetId);

    // Restore pin netId assignments
    for (const assignment of this.pinNetAssignments) {
      const comp = sheet.components.find(c => c.id === assignment.componentId);
      if (comp) {
        const pin = comp.pins.find(p => p.definitionId === assignment.definitionId);
        if (pin) pin.netId = assignment.previousNetId;
      }
    }

    // Remove created wires
    sheet.wires = sheet.wires.filter(w => !this.createdWireIds.includes(w.id));

    // Remove created net labels
    sheet.labels = sheet.labels.filter(l => !this.createdLabelIds.includes(l.id));

    // Remove created nets
    sheet.nets = sheet.nets.filter(n => !this.createdNetIds.includes(n.id));

    // Remove created components
    sheet.components = sheet.components.filter(c => !this.createdComponentIds.includes(c.id));

    doc.updatedAt = new Date().toISOString();
  }
}

// ----- Serialization -----

export function serializeDocument(doc: CircuitDocument): string {
  return JSON.stringify(doc, null, 2);
}

export function deserializeDocument(json: string): CircuitDocument {
  return JSON.parse(json) as CircuitDocument;
}
