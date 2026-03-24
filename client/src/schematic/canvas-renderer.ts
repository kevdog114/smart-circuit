import type { CircuitDocument, Component, Wire, WireNode, Point, ComponentDefinition, NetLabel, BoundingBox } from '../core/types';
import { routeSimple, routeConnection, routeConnectionBatch } from '../llm/wire-router';

const COLORS = {
  background: '#1a1a2e',
  grid: '#16213e',
  gridMajor: '#0f3460',
  wire: '#00c9a7',
  wireDraw: '#00c9a7aa',
  component: '#e2e2e2',
  componentBody: '#2d2d44',
  componentSelected: '#00c9a7',
  pin: '#e94560',
  pinConnected: '#00c9a7',
  text: '#e2e2e2',
  textDim: '#8888aa',
  selection: 'rgba(0, 201, 167, 0.15)',
  selectionBorder: '#00c9a7',
  crosshair: '#ffffff33',
};

export type Tool = 'select' | 'wire' | 'component' | 'label' | 'pan';

interface ViewTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export class SchematicRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private transform: ViewTransform = { offsetX: 0, offsetY: 0, scale: 1.0 };
  private animFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private gridSize = 20; // pixels per grid unit at scale 1.0

  // Interaction state
  private currentTool: Tool = 'select';
  private selectedComponentIds = new Set<string>();
  private hoveredComponentId: string | null = null;
  private isDragging = false;
  private isPanning = false;
  private dragStart: Point = { x: 0, y: 0 };
  private dragOffset: Point = { x: 0, y: 0 };
  private mouseScreen: Point = { x: 0, y: 0 };
  private mouseWorld: Point = { x: 0, y: 0 };

  // Label/Wire selection & hover state
  private selectedLabelId: string | null = null;
  private selectedWireId: string | null = null;
  private selectedWireIds = new Set<string>();
  private selectedLabelIds = new Set<string>();
  private hoveredLabelNetName: string | null = null;
  private hoveredWireId: string | null = null;

  // Box selection state
  private isBoxSelecting = false;
  private boxSelectStart: Point = { x: 0, y: 0 };
  private boxSelectEnd: Point = { x: 0, y: 0 };

  // Wire node state
  private selectedWireNodeId: string | null = null;
  private selectedWireNodeWireId: string | null = null;
  private hoveredWireNodeId: string | null = null;
  private isDraggingWireNode = false;
  private wireNodeDragStart: Point = { x: 0, y: 0 };

  // Cross-highlight from PCB view
  private highlightedComponentId: string | null = null;

  // Wire drawing state
  private isDrawingWire = false;
  private wirePoints: Point[] = [];

  // Component placement state
  private placingComponent: ComponentDefinition | null = null;
  private placingRotation: 0 | 90 | 180 | 270 = 0;

  // Data
  private document: CircuitDocument | null = null;
  private libraryMap = new Map<string, ComponentDefinition>();
  private activeSheetIndex = 0;

  /** Convenience getter for the currently active sheet. */
  private get sheet() {
    return this.document?.sheets[this.activeSheetIndex] ?? this.document?.sheets[0] ?? null;
  }

  // Callbacks
  onComponentSelected: ((ids: string[]) => void) | null = null;
  onWireDrawn: ((segments: { start: Point; end: Point }[]) => void) | null = null;
  onComponentPlaced: ((def: ComponentDefinition, position: Point, rotation: 0 | 90 | 180 | 270) => void) | null = null;
  onComponentMoved: ((id: string, position: Point) => void) | null = null;
  onComponentRotated: ((id: string) => void) | null = null;
  onNetSelected: ((info: { type: 'label' | 'wire'; id: string; netName: string } | null) => void) | null = null;
  onToolChanged: ((tool: Tool) => void) | null = null;
  onZoomChanged: ((percent: number) => void) | null = null;
  onWireNodeAdded: ((wireId: string, position: Point) => void) | null = null;
  onWireNodeMoved: ((nodeId: string, wireId: string, position: Point) => void) | null = null;
  onWireNodeDeleted: ((nodeId: string, wireId: string) => void) | null = null;
  onDeleteRequested: ((target: { type: 'component'; ids: string[] } | { type: 'wire'; id: string } | { type: 'label'; id: string }) => void) | null = null;
  onBatchMoved: ((moves: { id: string; position: Point }[]) => void) | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    this.canvas.style.cursor = 'crosshair';
    this.canvas.style.touchAction = 'none';
    (this.canvas.style as any).overscrollBehavior = 'none';
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Cannot get 2d context');
    this.ctx = ctx;

    this.setupEvents();
    this.resize();
    // Use ResizeObserver instead of window 'resize' event so the canvas
    // re-measures when the flex container settles (fixes Safari stretch on load).
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.startRenderLoop();
  }

  // ----- Public API -----

  setDocument(doc: CircuitDocument): void {
    this.document = doc;
  }

  setActiveSheetIndex(idx: number): void {
    this.activeSheetIndex = idx;
  }

  setLibraryMap(map: Map<string, ComponentDefinition>): void {
    this.libraryMap = map;
  }

  setTool(tool: Tool): void {
    this.currentTool = tool;
    this.placingComponent = null;
    this.placingRotation = 0;
    this.isDrawingWire = false;
    this.wirePoints = [];
    this.canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
  }

  startPlacingComponent(def: ComponentDefinition): void {
    this.placingComponent = def;
    this.placingRotation = 0;
    this.currentTool = 'component';
    this.canvas.style.cursor = 'copy';
  }

  getSelectedIds(): string[] {
    return [...this.selectedComponentIds];
  }

  getSelectedWireId(): string | null {
    return this.selectedWireId;
  }

  getSelectedLabelId(): string | null {
    return this.selectedLabelId;
  }

  clearSelection(): void {
    this.clearAllSelections();
    this.onComponentSelected?.([]);
    this.onNetSelected?.(null);
  }

  highlightComponent(id: string | null): void {
    this.highlightedComponentId = id;
  }

  centerView(): void {
    const dpr = window.devicePixelRatio || 1;
    this.transform = {
      offsetX: (this.canvas.width / dpr) / 2,
      offsetY: (this.canvas.height / dpr) / 2,
      scale: 1.0
    };
  }

  zoomIn(): void {
    const dpr = window.devicePixelRatio || 1;
    const cx = (this.canvas.width / dpr) / 2;
    const cy = (this.canvas.height / dpr) / 2;
    const oldScale = this.transform.scale;
    this.transform.scale = Math.min(5, oldScale * 1.15);
    this.transform.offsetX = cx - (cx - this.transform.offsetX) * (this.transform.scale / oldScale);
    this.transform.offsetY = cy - (cy - this.transform.offsetY) * (this.transform.scale / oldScale);
  }

  zoomOut(): void {
    const dpr = window.devicePixelRatio || 1;
    const cx = (this.canvas.width / dpr) / 2;
    const cy = (this.canvas.height / dpr) / 2;
    const oldScale = this.transform.scale;
    this.transform.scale = Math.max(0.1, oldScale * 0.85);
    this.transform.offsetX = cx - (cx - this.transform.offsetX) * (this.transform.scale / oldScale);
    this.transform.offsetY = cy - (cy - this.transform.offsetY) * (this.transform.scale / oldScale);
  }

  getZoomPercent(): number {
    return Math.round(this.transform.scale * 100);
  }

  // ----- Event Setup -----

  // Multi-touch tracking for two-finger pan & pinch-to-zoom
  private activePointers = new Map<number, Point>();
  private _pinchStartDist = 0;
  private _pinchStartScale = 1;
  private _pinchLastCenter: Point = { x: 0, y: 0 };
  private _multiTouchActive = false;

  // Safari gesture tracking for macOS trackpad pinch-to-zoom
  private _gestureScale = 1;
  private _gestureActive = false;

  private setupEvents(): void {
    this.canvas.addEventListener('pointerdown', e => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', e => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', e => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', e => this.onPointerUp(e));
    this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('dblclick', e => this.onDoubleClick(e));
    window.addEventListener('keydown', e => this.onKeyDown(e));

    // Safari-specific: handle trackpad pinch-to-zoom via native GestureEvent.
    // macOS trackpads appear as a single pointer so multi-touch pointer tracking
    // doesn't capture trackpad pinch — we still need GestureEvent for that.
    this.canvas.addEventListener('gesturestart', ((e: any) => {
      e.preventDefault();
      this._gestureScale = this.transform.scale;
      this._gestureActive = true;
    }) as EventListener, { passive: false } as any);

    this.canvas.addEventListener('gesturechange', ((e: any) => {
      e.preventDefault();
      const newScale = Math.max(0.1, Math.min(5, this._gestureScale * e.scale));
      if (!Number.isFinite(newScale) || newScale <= 0) return;
      const oldScale = this.transform.scale;
      this.transform.scale = newScale;
      const newOffX = this.mouseScreen.x - (this.mouseScreen.x - this.transform.offsetX) * (newScale / oldScale);
      const newOffY = this.mouseScreen.y - (this.mouseScreen.y - this.transform.offsetY) * (newScale / oldScale);
      if (Number.isFinite(newOffX) && Number.isFinite(newOffY)) {
        this.transform.offsetX = newOffX;
        this.transform.offsetY = newOffY;
      }
      this.onZoomChanged?.(this.getZoomPercent());
    }) as EventListener, { passive: false } as any);

    this.canvas.addEventListener('gestureend', ((e: any) => {
      e.preventDefault();
      this._gestureActive = false;
    }) as EventListener, { passive: false } as any);
  }

  private screenToWorld(sx: number, sy: number): Point {
    return {
      x: (sx - this.transform.offsetX) / this.transform.scale,
      y: (sy - this.transform.offsetY) / this.transform.scale
    };
  }

  private snapToGrid(p: Point): Point {
    const gs = this.gridSize;
    return {
      x: Math.round(p.x / gs) * gs,
      y: Math.round(p.y / gs) * gs
    };
  }

  private snapToPinOrGrid(p: Point, threshold = 10): Point {
    if (this.document) {
      const sheet = this.sheet!;
      // Check pins
      for (const comp of sheet.components) {
        for (const pin of comp.pins) {
          const dx = p.x - pin.absolutePosition.x;
          const dy = p.y - pin.absolutePosition.y;
          if (dx * dx + dy * dy <= threshold * threshold) {
            return { x: pin.absolutePosition.x, y: pin.absolutePosition.y };
          }
        }
      }
      // Check wire nodes as connection points
      for (const wire of sheet.wires) {
        for (const node of (wire.nodes || [])) {
          const dx = p.x - node.position.x;
          const dy = p.y - node.position.y;
          if (dx * dx + dy * dy <= threshold * threshold) {
            return { x: node.position.x, y: node.position.y };
          }
        }
      }
    }
    return this.snapToGrid(p);
  }

  // ----- Pointer Handlers -----

  private onPointerDown(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    const rect = this.canvas.getBoundingClientRect();
    this.activePointers.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });

    // Two-finger gesture start: record pinch baseline
    if (this.activePointers.size === 2) {
      const pts = [...this.activePointers.values()];
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      this._pinchStartDist = Math.sqrt(dx * dx + dy * dy);
      this._pinchStartScale = this.transform.scale;
      this._pinchLastCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      this._multiTouchActive = true;
      // Cancel any in-progress single-pointer interaction
      this.isPanning = false;
      this.isDragging = false;
      this.isDraggingWireNode = false;
      this.isBoxSelecting = false;
      this.dragOffset = { x: 0, y: 0 };
      return;
    }

    // If multitouch was just active, ignore stale single-pointer down events
    if (this._multiTouchActive) return;

    this.mouseScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.mouseWorld = this.screenToWorld(this.mouseScreen.x, this.mouseScreen.y);

    if (e.button === 1 || (e.button === 0 && (this.currentTool === 'pan' || e.shiftKey))) {
      this.isPanning = true;
      this.dragStart = { ...this.mouseScreen };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    // Middle-click is handled above; also allow left-click pan on empty space in select mode
    if (e.button === 0 && this.currentTool === 'select') {
      // Try pin (connection point) first — auto-switch to wire tool
      const hitPin = this.hitTestPin(this.mouseWorld);
      if (hitPin) {
        this.currentTool = 'wire';
        this.canvas.style.cursor = 'crosshair';
        this.isDrawingWire = true;
        this.wirePoints = [{ x: hitPin.x, y: hitPin.y }];
        this.clearAllSelections();
        this.onComponentSelected?.([]);
        this.onNetSelected?.(null);
        this.onToolChanged?.('wire');
        return;
      }

      // Try wire node (draggable waypoint)
      const hitNode = this.hitTestWireNode(this.mouseWorld);
      if (hitNode) {
        this.clearAllSelections();
        this.selectedWireNodeId = hitNode.id;
        this.selectedWireNodeWireId = hitNode.wireId;
        this.isDraggingWireNode = true;
        this.wireNodeDragStart = this.snapToGrid(this.mouseWorld);
        this.dragOffset = { x: 0, y: 0 };
        this.onComponentSelected?.([]);
        this.onNetSelected?.(null);
        this.canvas.style.cursor = 'move';
        return;
      }

      // Try label
      const hitLabel = this.hitTestLabel(this.mouseWorld);
      if (hitLabel) {
        this.clearAllSelections();
        this.selectedLabelId = hitLabel.id;
        this.selectedLabelIds.add(hitLabel.id);
        this.onComponentSelected?.([]);
        this.onNetSelected?.({ type: 'label', id: hitLabel.id, netName: hitLabel.netName });
        return;
      }

      // Try wire
      const hitWire = this.hitTestWire(this.mouseWorld);
      if (hitWire) {
        this.clearAllSelections();
        this.selectedWireId = hitWire.id;
        this.selectedWireIds.add(hitWire.id);
        this.onComponentSelected?.([]);
        const net = this.sheet?.nets.find(n => n.id === hitWire.netId);
        this.onNetSelected?.({ type: 'wire', id: hitWire.id, netName: net?.name || hitWire.netId });
        return;
      }

      // Try component
      const hit = this.hitTestComponent(this.mouseWorld);
      if (hit) {
        if (!this.selectedComponentIds.has(hit.id)) {
          // If not already in a multi-selection, start a fresh single selection
          this.clearAllSelections();
          this.selectedComponentIds.add(hit.id);
        }
        this.selectedLabelId = null;
        this.selectedWireId = null;
        this.selectedWireNodeId = null;
        this.selectedWireNodeWireId = null;
        this.isDragging = true;
        this.dragStart = this.snapToGrid(this.mouseWorld);
        this.onComponentSelected?.(this.getSelectedIds());
        this.onNetSelected?.(null);
        return;
      }

      // Nothing hit — start box selection, clear all selections
      this.isBoxSelecting = true;
      this.boxSelectStart = { ...this.mouseWorld };
      this.boxSelectEnd = { ...this.mouseWorld };
      this.clearAllSelections();
      this.onComponentSelected?.([]);
      this.onNetSelected?.(null);
      return;
    }

    if (this.currentTool === 'wire') {
      const snapped = this.snapToPinOrGrid(this.mouseWorld);
      if (!this.isDrawingWire) {
        this.isDrawingWire = true;
        this.wirePoints = [snapped];
      } else {
        this.wirePoints.push(snapped);
        
        // Auto-commit if we have 2+ points and the new point hits a pin on a different component
        if (this.wirePoints.length >= 2 && this.document) {
          const startPt = this.wirePoints[0];
          const endPt = snapped;
          const sheet = this.sheet!;
          
          // Find which component owns the start pin and end pin
          let startComp: string | null = null;
          let endComp: string | null = null;
          for (const c of sheet.components) {
            for (const p of c.pins) {
              if (p.absolutePosition.x === startPt.x && p.absolutePosition.y === startPt.y) startComp = c.id;
              if (p.absolutePosition.x === endPt.x && p.absolutePosition.y === endPt.y) endComp = c.id;
            }
          }
          
          // Auto-commit if end is on a different component's pin (or any pin if start wasn't on a component)
          if (endComp && endComp !== startComp) {
            const segments = [];
            for (let i = 0; i < this.wirePoints.length - 1; i++) {
              segments.push({ start: this.wirePoints[i], end: this.wirePoints[i + 1] });
            }
            this.onWireDrawn?.(segments);
            this.isDrawingWire = false;
            this.wirePoints = [];
            // Revert to select tool after auto-commit
            this.currentTool = 'select';
            this.onToolChanged?.('select');
          }
        }
      }
    }

    if (this.currentTool === 'component' && this.placingComponent) {
      const snapped = this.snapToGrid(this.mouseWorld);
      this.onComponentPlaced?.(this.placingComponent, snapped, this.placingRotation);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const screenPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.activePointers.set(e.pointerId, screenPt);

    // Two-finger gesture: pan + pinch-to-zoom
    if (this.activePointers.size === 2 && this._multiTouchActive) {
      const pts = [...this.activePointers.values()];
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const center: Point = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

      // Pan by center movement
      this.transform.offsetX += center.x - this._pinchLastCenter.x;
      this.transform.offsetY += center.y - this._pinchLastCenter.y;
      this._pinchLastCenter = center;

      // Pinch-to-zoom
      if (this._pinchStartDist > 0) {
        const ratio = dist / this._pinchStartDist;
        const newScale = Math.max(0.1, Math.min(5, this._pinchStartScale * ratio));
        if (Number.isFinite(newScale) && newScale > 0) {
          const oldScale = this.transform.scale;
          this.transform.scale = newScale;
          // Zoom towards pinch center
          const newOffX = center.x - (center.x - this.transform.offsetX) * (newScale / oldScale);
          const newOffY = center.y - (center.y - this.transform.offsetY) * (newScale / oldScale);
          if (Number.isFinite(newOffX) && Number.isFinite(newOffY)) {
            this.transform.offsetX = newOffX;
            this.transform.offsetY = newOffY;
          }
          this.onZoomChanged?.(this.getZoomPercent());
        }
      }
      return;
    }

    // Skip single-pointer handling while multitouch is active
    if (this._multiTouchActive) return;

    this.mouseScreen = screenPt;
    this.mouseWorld = this.screenToWorld(this.mouseScreen.x, this.mouseScreen.y);

    if (this.isPanning) {
      this.transform.offsetX += this.mouseScreen.x - this.dragStart.x;
      this.transform.offsetY += this.mouseScreen.y - this.dragStart.y;
      this.dragStart = { ...this.mouseScreen };
      return;
    }

    if (this.isDragging && this.selectedComponentIds.size > 0) {
      const snapped = this.snapToGrid(this.mouseWorld);
      this.dragOffset = {
        x: snapped.x - this.dragStart.x,
        y: snapped.y - this.dragStart.y
      };
    }

    // Wire node dragging
    if (this.isDraggingWireNode && this.selectedWireNodeId) {
      const snapped = this.snapToGrid(this.mouseWorld);
      this.dragOffset = {
        x: snapped.x - this.wireNodeDragStart.x,
        y: snapped.y - this.wireNodeDragStart.y
      };
    }

    // Box selection — update end point and compute selected objects
    if (this.isBoxSelecting) {
      this.boxSelectEnd = { ...this.mouseWorld };
      this.computeBoxSelection();
      return;
    }

    // Hover detection
    if (this.currentTool === 'select' && !this.isDraggingWireNode) {
      // Check pins first (connection points)
      const hitPin = this.hitTestPin(this.mouseWorld);
      if (hitPin) {
        this.hoveredComponentId = null;
        this.hoveredLabelNetName = null;
        this.hoveredWireId = null;
        this.hoveredWireNodeId = null;
        this.canvas.style.cursor = 'crosshair';
        return;
      }

      // Check wire nodes
      const hitNode = this.hitTestWireNode(this.mouseWorld);
      if (hitNode) {
        this.hoveredWireNodeId = hitNode.id;
        this.hoveredComponentId = null;
        this.hoveredLabelNetName = null;
        this.hoveredWireId = null;
        this.canvas.style.cursor = 'move';
        return;
      }

      // Check labels
      const hitLabel = this.hitTestLabel(this.mouseWorld);
      if (hitLabel) {
        this.hoveredLabelNetName = hitLabel.netName;
        this.hoveredWireId = null;
        this.hoveredComponentId = null;
        this.hoveredWireNodeId = null;
        this.canvas.style.cursor = 'pointer';
        return;
      }

      // Check wires
      const hitWire = this.hitTestWire(this.mouseWorld);
      if (hitWire) {
        this.hoveredWireId = hitWire.id;
        this.hoveredLabelNetName = null;
        this.hoveredComponentId = null;
        this.hoveredWireNodeId = null;
        this.canvas.style.cursor = 'pointer';
        return;
      }

      // Check components
      const hit = this.hitTestComponent(this.mouseWorld);
      this.hoveredComponentId = hit?.id ?? null;
      this.hoveredLabelNetName = null;
      this.hoveredWireId = null;
      this.hoveredWireNodeId = null;
      this.canvas.style.cursor = hit ? 'move' : 'crosshair';
    }
  }

  private onPointerUp(e: PointerEvent): void {
    this.activePointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}

    // When all fingers are lifted after a multitouch gesture, clear the flag
    if (this._multiTouchActive) {
      if (this.activePointers.size < 2) {
        // If one finger remains, update pinch tracking so lifting the second
        // finger doesn't cause a jump if the user starts a new two-finger gesture.
        this._multiTouchActive = this.activePointers.size > 0;
        if (this.activePointers.size === 0) this._multiTouchActive = false;
      }
      return;
    }

    if (this.isPanning) {
      this.isPanning = false;
      this.canvas.style.cursor = this.currentTool === 'pan' ? 'grab' : 'crosshair';
      return;
    }

    // Box selection complete
    if (this.isBoxSelecting) {
      this.isBoxSelecting = false;
      this.computeBoxSelection();
      if (this.selectedComponentIds.size > 0) {
        this.onComponentSelected?.(this.getSelectedIds());
      }
      return;
    }

    if (this.isDragging && this.selectedComponentIds.size > 0) {
      if (this.dragOffset.x !== 0 || this.dragOffset.y !== 0) {
        if (this.selectedComponentIds.size > 1 && this.onBatchMoved) {
          // Multi-component drag — use batch callback
          const moves: { id: string; position: Point }[] = [];
          for (const id of this.selectedComponentIds) {
            const comp = this.sheet?.components.find(c => c.id === id);
            if (comp) {
              moves.push({
                id,
                position: {
                  x: comp.position.x + this.dragOffset.x,
                  y: comp.position.y + this.dragOffset.y
                }
              });
            }
          }
          this.onBatchMoved(moves);
        } else {
          // Single component drag
          for (const id of this.selectedComponentIds) {
            const comp = this.sheet?.components.find(c => c.id === id);
            if (comp) {
              this.onComponentMoved?.(id, {
                x: comp.position.x + this.dragOffset.x,
                y: comp.position.y + this.dragOffset.y
              });
            }
          }
        }
      }
      this.isDragging = false;
      this.dragOffset = { x: 0, y: 0 };
    }

    // Wire node drag commit
    if (this.isDraggingWireNode && this.selectedWireNodeId && this.selectedWireNodeWireId) {
      if (this.dragOffset.x !== 0 || this.dragOffset.y !== 0) {
        // Find the node's original position to compute new position
        const wire = this.sheet?.wires.find(w => w.id === this.selectedWireNodeWireId);
        const node = wire?.nodes?.find(n => n.id === this.selectedWireNodeId);
        if (node) {
          this.onWireNodeMoved?.(this.selectedWireNodeId, this.selectedWireNodeWireId, {
            x: node.position.x + this.dragOffset.x,
            y: node.position.y + this.dragOffset.y
          });
        }
      }
      this.isDraggingWireNode = false;
      this.dragOffset = { x: 0, y: 0 };
    }
  }

  private onWheel(e: WheelEvent): void {
    try {
      if (e.cancelable) e.preventDefault();
    } catch (_) { /* Safari: non-cancelable event */ }

    // If a Safari gesture is active, skip — gesturechange handles zoom
    if (this._gestureActive) return;

    if (e.ctrlKey || e.metaKey) {
      // Pinch-to-zoom on macOS trackpad (or Ctrl+scroll with a mouse wheel)
      // Clamp deltaY to avoid extreme values from Safari trackpad gestures
      const clampedDeltaY = Math.max(-50, Math.min(50, e.deltaY));
      const zoomIntensity = 0.01;
      const zoomFactor = Math.exp(-clampedDeltaY * zoomIntensity);
      const oldScale = this.transform.scale;
      const newScale = Math.max(0.1, Math.min(5, oldScale * zoomFactor));

      // Guard against NaN/Infinity corrupting the transform
      if (!Number.isFinite(newScale) || newScale <= 0) return;
      this.transform.scale = newScale;

      // Zoom towards mouse cursor
      const newOffX = this.mouseScreen.x - (this.mouseScreen.x - this.transform.offsetX) * (this.transform.scale / oldScale);
      const newOffY = this.mouseScreen.y - (this.mouseScreen.y - this.transform.offsetY) * (this.transform.scale / oldScale);
      if (Number.isFinite(newOffX) && Number.isFinite(newOffY)) {
        this.transform.offsetX = newOffX;
        this.transform.offsetY = newOffY;
      }
      this.onZoomChanged?.(this.getZoomPercent());
    } else {
      // Two-finger scroll → pan the canvas (native macOS feel)
      this.transform.offsetX -= e.deltaX;
      this.transform.offsetY -= e.deltaY;
    }
  }

  private onDoubleClick(_e: MouseEvent): void {
    if (this.isDrawingWire && this.wirePoints.length >= 2) {
      const segments = [];
      for (let i = 0; i < this.wirePoints.length - 1; i++) {
        segments.push({ start: this.wirePoints[i], end: this.wirePoints[i + 1] });
      }
      this.onWireDrawn?.(segments);
      this.isDrawingWire = false;
      this.wirePoints = [];
      return;
    }

    // Double-click on a wire to add a node
    if (this.currentTool === 'select' && this.document) {
      const hitWire = this.hitTestWire(this.mouseWorld);
      if (hitWire) {
        const snapped = this.snapToGrid(this.mouseWorld);
        this.onWireNodeAdded?.(hitWire.id, snapped);
        return;
      }
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;

    if (e.key === 'Escape') {
      if (this.isBoxSelecting) {
        this.isBoxSelecting = false;
        return;
      }
      this.isDrawingWire = false;
      this.wirePoints = [];
      this.placingComponent = null;
      this.placingRotation = 0;
      if (this.currentTool === 'component') this.setTool('select');
      // Clear multi-selection
      this.clearAllSelections();
      this.onComponentSelected?.([]);
      this.onNetSelected?.(null);
    }
    if (e.key === ' ' && this.placingComponent) {
      e.preventDefault();
      this.placingRotation = ((this.placingRotation + 90) % 360) as 0 | 90 | 180 | 270;
    } else if (e.key === ' ' && this.selectedComponentIds.size > 0 && !this.isDragging) {
      e.preventDefault();
      for (const id of this.selectedComponentIds) {
        this.onComponentRotated?.(id);
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      // Delete selected wire node
      if (this.selectedWireNodeId && this.selectedWireNodeWireId) {
        this.onWireNodeDeleted?.(this.selectedWireNodeId, this.selectedWireNodeWireId);
        this.selectedWireNodeId = null;
        this.selectedWireNodeWireId = null;
        return;
      }
      // Delete all selected objects (multi-select aware)
      if (this.selectedComponentIds.size > 0) {
        this.onDeleteRequested?.({ type: 'component', ids: [...this.selectedComponentIds] });
        this.selectedComponentIds.clear();
        this.onComponentSelected?.([]);
      }
      // Delete selected wires (multi-select)
      for (const wid of this.selectedWireIds) {
        this.onDeleteRequested?.({ type: 'wire', id: wid });
      }
      if (this.selectedWireId && !this.selectedWireIds.has(this.selectedWireId)) {
        this.onDeleteRequested?.({ type: 'wire', id: this.selectedWireId });
      }
      this.selectedWireIds.clear();
      this.selectedWireId = null;
      // Delete selected labels (multi-select)
      for (const lid of this.selectedLabelIds) {
        this.onDeleteRequested?.({ type: 'label', id: lid });
      }
      if (this.selectedLabelId && !this.selectedLabelIds.has(this.selectedLabelId)) {
        this.onDeleteRequested?.({ type: 'label', id: this.selectedLabelId });
      }
      this.selectedLabelIds.clear();
      this.selectedLabelId = null;
      this.onNetSelected?.(null);
    }
  }

  // ----- Hit Testing -----

  private hitTestPin(world: Point, threshold = 8): Point | null {
    if (!this.document) return null;
    const sheet = this.sheet!;
    let closest: Point | null = null;
    let closestDist = threshold;
    for (const comp of sheet.components) {
      for (const pin of comp.pins) {
        const dx = world.x - pin.absolutePosition.x;
        const dy = world.y - pin.absolutePosition.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= closestDist) {
          closestDist = dist;
          closest = { x: pin.absolutePosition.x, y: pin.absolutePosition.y };
        }
      }
    }
    return closest;
  }

  private hitTestComponent(world: Point): Component | null {
    if (!this.document) return null;
    const sheet = this.sheet!;
    // Reverse order so top-most is hit first
    for (let i = sheet.components.length - 1; i >= 0; i--) {
      const comp = sheet.components[i];
      const def = this.libraryMap.get(comp.libraryId);
      let w = def ? def.symbol.width : 60;
      let h = def ? def.symbol.height : 40;
      // Swap dimensions for 90° and 270° rotations
      if (comp.rotation === 90 || comp.rotation === 270) {
        [w, h] = [h, w];
      }
      if (
        world.x >= comp.position.x - w / 2 &&
        world.x <= comp.position.x + w / 2 &&
        world.y >= comp.position.y - h / 2 &&
        world.y <= comp.position.y + h / 2
      ) {
        return comp;
      }
    }
    return null;
  }

  private hitTestLabel(world: Point): NetLabel | null {
    if (!this.document) return null;
    const sheet = this.sheet!;
    for (let i = sheet.labels.length - 1; i >= 0; i--) {
      const label = sheet.labels[i];
      // The badge extends from the label position outward
      // Badge is roughly: offsetX(6) to offsetX+badgeW+flagW(~50) wide, ±7 tall
      const rot = (label.rotation || 0) * Math.PI / 180;
      const dx = world.x - label.position.x;
      const dy = world.y - label.position.y;
      // Rotate the test point into the label's local coordinate frame
      const localX = dx * Math.cos(-rot) - dy * Math.sin(-rot);
      const localY = dx * Math.sin(-rot) + dy * Math.cos(-rot);
      // Hit region: from -3 to 40 in x (covers stub + badge + flag), ±6 in y
      if (localX >= -3 && localX <= 40 && localY >= -6 && localY <= 6) {
        return label;
      }
    }
    return null;
  }

  private hitTestWireNode(world: Point): WireNode | null {
    if (!this.document) return null;
    const sheet = this.sheet!;
    const threshold = 8;
    for (const wire of sheet.wires) {
      for (const node of (wire.nodes || [])) {
        const dx = world.x - node.position.x;
        const dy = world.y - node.position.y;
        if (Math.sqrt(dx * dx + dy * dy) <= threshold) return node;
      }
    }
    return null;
  }

  private hitTestWire(world: Point): Wire | null {
    if (!this.document) return null;
    const sheet = this.sheet!;
    const threshold = 6; // pixels tolerance
    for (let i = sheet.wires.length - 1; i >= 0; i--) {
      const wire = sheet.wires[i];
      for (const seg of wire.segments) {
        const dist = this.pointToSegmentDistance(world, seg.start, seg.end);
        if (dist <= threshold) return wire;
      }
    }
    return null;
  }

  private pointToSegmentDistance(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(p.x - projX, p.y - projY);
  }

  // ----- Selection Helpers -----

  private clearAllSelections(): void {
    this.selectedComponentIds.clear();
    this.selectedLabelId = null;
    this.selectedWireId = null;
    this.selectedWireIds.clear();
    this.selectedLabelIds.clear();
    this.selectedWireNodeId = null;
    this.selectedWireNodeWireId = null;
  }

  /** Compute which objects fall inside the box-selection rectangle. */
  private computeBoxSelection(): void {
    if (!this.document) return;
    const sheet = this.sheet!;

    const minX = Math.min(this.boxSelectStart.x, this.boxSelectEnd.x);
    const maxX = Math.max(this.boxSelectStart.x, this.boxSelectEnd.x);
    const minY = Math.min(this.boxSelectStart.y, this.boxSelectEnd.y);
    const maxY = Math.max(this.boxSelectStart.y, this.boxSelectEnd.y);

    // Select components whose center is inside the box
    this.selectedComponentIds.clear();
    for (const comp of sheet.components) {
      if (comp.position.x >= minX && comp.position.x <= maxX &&
          comp.position.y >= minY && comp.position.y <= maxY) {
        this.selectedComponentIds.add(comp.id);
      }
    }

    // Select wires with at least one segment endpoint inside the box
    this.selectedWireIds.clear();
    this.selectedWireId = null;
    for (const wire of sheet.wires) {
      let inside = false;
      for (const seg of wire.segments) {
        if ((seg.start.x >= minX && seg.start.x <= maxX && seg.start.y >= minY && seg.start.y <= maxY) ||
            (seg.end.x >= minX && seg.end.x <= maxX && seg.end.y >= minY && seg.end.y <= maxY)) {
          inside = true;
          break;
        }
      }
      if (inside) {
        this.selectedWireIds.add(wire.id);
      }
    }

    // Select labels whose position is inside the box
    this.selectedLabelIds.clear();
    this.selectedLabelId = null;
    for (const label of sheet.labels) {
      if (label.position.x >= minX && label.position.x <= maxX &&
          label.position.y >= minY && label.position.y <= maxY) {
        this.selectedLabelIds.add(label.id);
      }
    }
  }

  // ----- Rendering -----

  private resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const newW = Math.round(parent.clientWidth * dpr);
    const newH = Math.round(parent.clientHeight * dpr);
    // Skip if container is hidden or dimensions unchanged (prevents
    // ResizeObserver ↔ canvas.width feedback loop that crashes Safari).
    if (newW <= 0 || newH <= 0) return;
    if (this.canvas.width === newW && this.canvas.height === newH) return;
    this.canvas.width = newW;
    this.canvas.height = newH;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private startRenderLoop(): void {
    const render = () => {
      this.render();
      this.animFrameId = requestAnimationFrame(render);
    };
    this.animFrameId = requestAnimationFrame(render);
  }

  private render(): void {
    const { ctx } = this;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    // Clear
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    // Save & apply transform
    ctx.save();
    ctx.translate(this.transform.offsetX, this.transform.offsetY);
    ctx.scale(this.transform.scale, this.transform.scale);

    this.renderGrid(w, h);

    if (this.document) {
      const sheet = this.sheet!;
      this.renderWires(sheet.wires);
      this.renderComponents(sheet.components);
      this.renderJunctions(sheet);
      this.renderLabels(sheet.labels);
    }

    this.renderWirePreview();
    this.renderComponentPreview();
    this.renderBoxSelection();

    ctx.restore();

    // HUD
    this.renderHUD(w, h);
  }

  private renderGrid(viewW: number, viewH: number): void {
    const { ctx } = this;
    const gs = this.gridSize;
    const scale = this.transform.scale;

    // Calculate grid bounds in world space
    const startX = Math.floor(-this.transform.offsetX / scale / gs) * gs - gs;
    const startY = Math.floor(-this.transform.offsetY / scale / gs) * gs - gs;
    const endX = startX + viewW / scale + gs * 2;
    const endY = startY + viewH / scale + gs * 2;

    // Minor grid (dots)
    ctx.fillStyle = COLORS.grid;
    for (let x = startX; x <= endX; x += gs) {
      for (let y = startY; y <= endY; y += gs) {
        const isMajor = x % (gs * 5) === 0 && y % (gs * 5) === 0;
        const size = isMajor ? 2 : 1;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }

    // Origin crosshair
    ctx.strokeStyle = COLORS.crosshair;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(endX, 0);
    ctx.moveTo(0, startY);
    ctx.lineTo(0, endY);
    ctx.stroke();
  }

  private renderComponents(components: Component[]): void {
    const { ctx } = this;

    for (const comp of components) {
      const def = this.libraryMap.get(comp.libraryId);
      const isSelected = this.selectedComponentIds.has(comp.id);
      const isHovered = this.hoveredComponentId === comp.id;
      const isCrossHighlighted = comp.id === this.highlightedComponentId;

      // Apply drag offset for selected components being dragged
      const offsetX = (this.isDragging && isSelected) ? this.dragOffset.x : 0;
      const offsetY = (this.isDragging && isSelected) ? this.dragOffset.y : 0;

      ctx.save();
      ctx.translate(comp.position.x + offsetX, comp.position.y + offsetY);
      if (comp.rotation) {
        ctx.rotate(comp.rotation * Math.PI / 180);
      }

      // Cross-highlight glow from PCB view
      if (isCrossHighlighted) {
        ctx.shadowColor = '#00c9a7';
        ctx.shadowBlur = 15;
      }

      if (def) {
        this.renderSymbol(def, isSelected || isCrossHighlighted, isHovered);
      } else {
        // Fallback: generic box
        const w = 60, h = 40;
        ctx.fillStyle = COLORS.componentBody;
        ctx.strokeStyle = (isSelected || isCrossHighlighted) ? COLORS.componentSelected : COLORS.component;
        ctx.lineWidth = (isSelected || isCrossHighlighted) ? 2 : 1;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.strokeRect(-w / 2, -h / 2, w, h);
      }

      // Reset shadow after glow
      if (isCrossHighlighted) {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }

      // Designator
      ctx.fillStyle = COLORS.text;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(comp.designator, 0, -25);

      // Value
      ctx.fillStyle = COLORS.textDim;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText(comp.value, 0, 30);

      // JLCPCB sourcing status dot
      const hasLCSC = !!(def?.properties?.lcsc);
      const dotColor = hasLCSC ? '#10b981' : '#f59e0b';
      ctx.fillStyle = dotColor;
      ctx.beginPath();
      const dotW = def ? def.symbol.width : 60;
      ctx.arc(dotW / 2 + 4, -25, 3, 0, Math.PI * 2);
      ctx.fill();

      // Pins — use definition positions (unrotated) so ctx.rotate() handles rotation
      for (const pin of comp.pins) {
        const pinDef = def?.symbol.pins.find(p => p.id === pin.definitionId);
        const px = pinDef ? pinDef.position.x : pin.absolutePosition.x - comp.position.x;
        const py = pinDef ? pinDef.position.y : pin.absolutePosition.y - comp.position.y;
        ctx.fillStyle = pin.netId ? COLORS.pinConnected : COLORS.pin;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  private renderSymbol(def: ComponentDefinition, isSelected: boolean, isHovered: boolean): void {
    const { ctx } = this;
    const color = isSelected ? COLORS.componentSelected : isHovered ? '#bbbbdd' : COLORS.component;

    for (const graphic of def.symbol.graphics) {
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2 : 1.5;
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
          ctx.fillStyle = color;
          ctx.font = `${p['fontSize'] || 10}px "JetBrains Mono", monospace`;
          ctx.textAlign = (p['textAlign'] as CanvasTextAlign) || 'center';
          ctx.fillText(String(p['text'] || ''), p['x'] as number || 0, p['y'] as number || 0);
          ctx.textAlign = 'center'; // Reset to default
          break;
        }
      }
    }
  }

  // Build a map of pin position → offset pin position for dragged components
  private getDragPinMap(): Map<string, Point> {
    const map = new Map<string, Point>();
    if (!this.isDragging || !this.document) return map;
    const sheet = this.sheet!;
    for (const comp of sheet.components) {
      if (this.selectedComponentIds.has(comp.id)) {
        for (const pin of comp.pins) {
          const key = `${pin.absolutePosition.x},${pin.absolutePosition.y}`;
          map.set(key, {
            x: pin.absolutePosition.x + this.dragOffset.x,
            y: pin.absolutePosition.y + this.dragOffset.y,
          });
        }
      }
    }
    return map;
  }

  private renderWires(wires: Wire[]): void {
    const { ctx } = this;
    ctx.lineCap = 'round';

    const dragPinMap = this.getDragPinMap();
    const hasDrag = dragPinMap.size > 0;

    if (!hasDrag) {
      // No drag in progress — render stored segments directly
      for (const wire of wires) {
        const isWireHovered = this.hoveredWireId === wire.id;
        const isWireSelected = this.selectedWireId === wire.id || this.selectedWireIds.has(wire.id);
        const isHighlighted = isWireHovered || isWireSelected;

        if (isHighlighted) {
          ctx.shadowColor = '#00c9a7';
          ctx.shadowBlur = 10;
        }
        ctx.strokeStyle = isHighlighted ? '#00ffcc' : COLORS.wire;
        ctx.lineWidth = isHighlighted ? 3 : 2;
        ctx.setLineDash([]);
        for (const seg of wire.segments) {
          ctx.beginPath();
          ctx.moveTo(seg.start.x, seg.start.y);
          ctx.lineTo(seg.end.x, seg.end.y);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
      }

      // Render wire nodes
      for (const wire of wires) {
        for (const node of (wire.nodes || [])) {
          const isNodeHovered = this.hoveredWireNodeId === node.id;
          const isNodeSelected = this.selectedWireNodeId === node.id;
          if (isNodeHovered || isNodeSelected) {
            ctx.shadowColor = '#00c9a7';
            ctx.shadowBlur = 8;
          }
          ctx.fillStyle = isNodeSelected ? '#00ffcc' : isNodeHovered ? '#66ffd9' : COLORS.wire;
          ctx.beginPath();
          ctx.arc(node.position.x, node.position.y, isNodeSelected || isNodeHovered ? 5 : 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      return;
    }

    // During drag: collect dragged wires for batch routing
    type DragWireInfo = { wire: Wire; effStart: Point; effEnd: Point };
    const draggedWires: DragWireInfo[] = [];

    for (const wire of wires) {
      const firstSeg = wire.segments[0];
      const lastSeg = wire.segments[wire.segments.length - 1];
      const startKey = `${firstSeg.start.x},${firstSeg.start.y}`;
      const endKey = `${lastSeg.end.x},${lastSeg.end.y}`;
      const startDragged = dragPinMap.has(startKey);
      const endDragged = dragPinMap.has(endKey);

      if (!startDragged && !endDragged) {
        // Wire not connected to dragged component — render as-is
        const isWireHovered = this.hoveredWireId === wire.id;
        const isWireSelected = this.selectedWireId === wire.id || this.selectedWireIds.has(wire.id);
        const isHighlighted = isWireHovered || isWireSelected;
        if (isHighlighted) {
          ctx.shadowColor = '#00c9a7';
          ctx.shadowBlur = 10;
        }
        ctx.strokeStyle = isHighlighted ? '#00ffcc' : COLORS.wire;
        ctx.lineWidth = isHighlighted ? 3 : 2;
        ctx.setLineDash([]);
        for (const seg of wire.segments) {
          ctx.beginPath();
          ctx.moveTo(seg.start.x, seg.start.y);
          ctx.lineTo(seg.end.x, seg.end.y);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        continue;
      }

      // Compute effective endpoints
      const effStart = startDragged ? dragPinMap.get(startKey)! : { ...firstSeg.start };
      const effEnd = endDragged ? dragPinMap.get(endKey)! : { ...lastSeg.end };
      draggedWires.push({ wire, effStart, effEnd });
    }

    // Batch-route all dragged wires with pin avoidance and overlap avoidance
    if (draggedWires.length > 0) {
      // Collect all pin positions for avoidance
      const sheet = this.document!.sheets[0];
      const allPins: Point[] = [];
      for (const comp of sheet.components) {
        if (!this.selectedComponentIds.has(comp.id)) {
          for (const pin of comp.pins) {
            allPins.push({ x: pin.absolutePosition.x, y: pin.absolutePosition.y });
          }
        } else {
          for (const pin of comp.pins) {
            allPins.push({
              x: pin.absolutePosition.x + this.dragOffset.x,
              y: pin.absolutePosition.y + this.dragOffset.y,
            });
          }
        }
      }

      const obstacles = this.getObstaclesForDrag(draggedWires[0].effStart, draggedWires[0].effEnd);
      const batchConns = draggedWires.map(dw => ({ from: dw.effStart, to: dw.effEnd, netName: '' }));
      const batchResults = routeConnectionBatch(batchConns, obstacles, allPins, this.gridSize);

      for (let i = 0; i < draggedWires.length; i++) {
        const route = batchResults[i];
        if (route.type === 'wire') {
          ctx.strokeStyle = COLORS.wire;
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          for (const seg of route.segments) {
            ctx.beginPath();
            ctx.moveTo(seg.start.x, seg.start.y);
            ctx.lineTo(seg.end.x, seg.end.y);
            ctx.stroke();
          }
        } else {
          // Draw dotted diagonal line between pins
          ctx.strokeStyle = COLORS.wireDraw;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(draggedWires[i].effStart.x, draggedWires[i].effStart.y);
          ctx.lineTo(draggedWires[i].effEnd.x, draggedWires[i].effEnd.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // Render wire nodes (including during drag)
    for (const wire of wires) {
      for (const node of (wire.nodes || [])) {
        const isBeingDragged = this.isDraggingWireNode && this.selectedWireNodeId === node.id;
        const drawX = isBeingDragged ? node.position.x + this.dragOffset.x : node.position.x;
        const drawY = isBeingDragged ? node.position.y + this.dragOffset.y : node.position.y;
        const isNodeHovered = this.hoveredWireNodeId === node.id;
        const isNodeSelected = this.selectedWireNodeId === node.id;
        if (isNodeHovered || isNodeSelected) {
          ctx.shadowColor = '#00c9a7';
          ctx.shadowBlur = 8;
        }
        ctx.fillStyle = isNodeSelected ? '#00ffcc' : isNodeHovered ? '#66ffd9' : COLORS.wire;
        ctx.beginPath();
        ctx.arc(drawX, drawY, isNodeSelected || isNodeHovered ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
  }

  /**
   * Build obstacle bounding boxes for drag-time re-routing.
   * Excludes components at the two endpoint positions.
   */
  private getObstaclesForDrag(_pinA: Point, pinB: Point): BoundingBox[] {
    if (!this.document) return [];
    const sheet = this.sheet!;
    const boxes: BoundingBox[] = [];
    const padding = 10;

    for (const comp of sheet.components) {
      // Skip dragged components
      if (this.selectedComponentIds.has(comp.id)) continue;

      // Skip the component that owns pinB (the non-dragged end)
      const ownsPinB = comp.pins.some(
        p => p.absolutePosition.x === pinB.x && p.absolutePosition.y === pinB.y
      );
      if (ownsPinB) continue;

      const def = this.libraryMap.get(comp.libraryId);
      const w = def ? def.symbol.width : 60;
      const h = def ? def.symbol.height : 40;
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

  private renderJunctions(sheet: { junctions: { position: Point }[] }): void {
    const { ctx } = this;
    ctx.fillStyle = COLORS.wire;
    for (const j of sheet.junctions) {
      ctx.beginPath();
      ctx.arc(j.position.x, j.position.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private renderLabels(labels: NetLabel[]): void {
    if (!labels || labels.length === 0) return;
    const { ctx } = this;

    // Build a set of dragged pin positions for label offset detection
    const dragPinMap = this.getDragPinMap();
    const hasDrag = dragPinMap.size > 0;

    // Track dragged labels and their effective positions for connection preview
    const draggedLabelPeers: { from: Point; to: Point }[] = [];

    for (const label of labels) {
      // Check if this label is at a dragged pin position and should be offset
      const labelKey = `${label.position.x},${label.position.y}`;
      const isDraggedLabel = hasDrag && dragPinMap.has(labelKey);
      const effX = isDraggedLabel ? label.position.x + this.dragOffset.x : label.position.x;
      const effY = isDraggedLabel ? label.position.y + this.dragOffset.y : label.position.y;

      // If this label is being dragged, find its peer and track for connection preview
      if (isDraggedLabel) {
        const peer = labels.find(l => l.netName === label.netName && l.id !== label.id);
        if (peer) {
          const peerKey = `${peer.position.x},${peer.position.y}`;
          const peerIsDragged = dragPinMap.has(peerKey);
          draggedLabelPeers.push({
            from: { x: effX, y: effY },
            to: peerIsDragged
              ? { x: peer.position.x + this.dragOffset.x, y: peer.position.y + this.dragOffset.y }
              : { x: peer.position.x, y: peer.position.y },
          });
        }
      }

      const text = label.netName;

      ctx.save();
      ctx.translate(effX, effY);
      if (label.rotation) {
        ctx.rotate(label.rotation * Math.PI / 180);
      }

      // Measure text for badge sizing
      ctx.font = '5.5px "JetBrains Mono", monospace';
      const metrics = ctx.measureText(text);
      const textW = metrics.width;
      const padH = 2;
      const badgeW = textW + padH * 2;
      const badgeH = 8;
      const flagW = 3;
      const offsetX = 3;

      // Determine highlight state
      const isHovered = this.hoveredLabelNetName === label.netName;
      const isSelected = this.selectedLabelId === label.id || this.selectedLabelIds.has(label.id);
      const isHighlighted = isHovered || isSelected;

      // Flag body
      if (isHighlighted) {
        ctx.shadowColor = '#00c9a7';
        ctx.shadowBlur = 8;
      }
      ctx.fillStyle = isSelected ? 'rgba(0, 201, 167, 0.35)' : isHovered ? 'rgba(0, 201, 167, 0.25)' : 'rgba(0, 201, 167, 0.15)';
      ctx.strokeStyle = isHighlighted ? '#00ffcc' : COLORS.wire;
      ctx.lineWidth = isHighlighted ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(offsetX, -badgeH / 2);
      ctx.lineTo(offsetX + badgeW, -badgeH / 2);
      ctx.lineTo(offsetX + badgeW + flagW, 0);
      ctx.lineTo(offsetX + badgeW, badgeH / 2);
      ctx.lineTo(offsetX, badgeH / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Short stub line from pin to badge
      ctx.strokeStyle = COLORS.wire;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(offsetX, 0);
      ctx.stroke();

      ctx.restore();

      // Net name text (draw separately to maintain upright readability)
      ctx.save();
      ctx.translate(effX, effY);
      ctx.fillStyle = COLORS.wire;
      ctx.textBaseline = 'middle';
      const rot = label.rotation || 0;

      if (rot === 0) {
        ctx.textAlign = 'left';
        ctx.fillText(text, offsetX + padH, 1);
      } else if (rot === 180) {
        ctx.textAlign = 'right';
        ctx.fillText(text, -(offsetX + padH), 1);
      } else if (rot === 90) {
        ctx.rotate(Math.PI / 2);
        ctx.textAlign = 'left';
        ctx.fillText(text, offsetX + padH, 1);
      } else if (rot === 270) {
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'left';
        ctx.fillText(text, offsetX + padH, 1);
      }

      ctx.restore();
    }

    // Draw connection previews between dragged labels and their peers
    for (const pair of draggedLabelPeers) {
      const obstacles = this.getObstaclesForDrag(pair.from, pair.to);
      const route = routeConnection(pair.from, pair.to, obstacles, '', this.gridSize);

      if (route.type === 'wire') {
        // Close enough for orthogonal routing — draw solid wire preview
        ctx.strokeStyle = COLORS.wire;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.globalAlpha = 0.7;
        for (const seg of route.segments) {
          ctx.beginPath();
          ctx.moveTo(seg.start.x, seg.start.y);
          ctx.lineTo(seg.end.x, seg.end.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      } else {
        // Too far — draw dashed diagonal line
        ctx.strokeStyle = COLORS.wireDraw;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(pair.from.x, pair.from.y);
        ctx.lineTo(pair.to.x, pair.to.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // Draw hover/selection connection line between matching labels (when not dragging)
    if (!hasDrag && (this.hoveredLabelNetName || this.selectedLabelId)) {
      const targetNetName = this.hoveredLabelNetName ||
        labels.find(l => l.id === this.selectedLabelId)?.netName;
      if (targetNetName) {
        const matchingLabels = labels.filter(l => l.netName === targetNetName);
        if (matchingLabels.length === 2) {
          const [a, b] = matchingLabels;
          ctx.strokeStyle = '#00c9a7';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          ctx.moveTo(a.position.x, a.position.y);
          ctx.lineTo(b.position.x, b.position.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  private renderWirePreview(): void {
    if (!this.isDrawingWire || this.wirePoints.length === 0) return;
    const { ctx } = this;
    ctx.strokeStyle = COLORS.wireDraw;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);

    // Draw already-placed segments
    ctx.beginPath();
    ctx.moveTo(this.wirePoints[0].x, this.wirePoints[0].y);
    for (let i = 1; i < this.wirePoints.length; i++) {
      ctx.lineTo(this.wirePoints[i].x, this.wirePoints[i].y);
    }
    ctx.stroke();

    // Draw orthogonal preview from last placed point to cursor
    const lastPt = this.wirePoints[this.wirePoints.length - 1];
    const snapped = this.snapToPinOrGrid(this.mouseWorld);

    if (lastPt.x !== snapped.x || lastPt.y !== snapped.y) {
      const previewSegs = routeSimple(lastPt, snapped, this.gridSize);
      ctx.beginPath();
      ctx.moveTo(previewSegs[0].start.x, previewSegs[0].start.y);
      for (const seg of previewSegs) {
        ctx.lineTo(seg.end.x, seg.end.y);
      }
      ctx.stroke();
    }

    ctx.setLineDash([]);
  }

  private renderComponentPreview(): void {
    if (!this.placingComponent) return;
    const { ctx } = this;
    const snapped = this.snapToGrid(this.mouseWorld);

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.translate(snapped.x, snapped.y);
    if (this.placingRotation) {
      ctx.rotate(this.placingRotation * Math.PI / 180);
    }

    // Draw actual symbol graphics instead of generic box
    this.renderSymbol(this.placingComponent, true, false);

    // Draw pin dots
    for (const pin of this.placingComponent.symbol.pins) {
      ctx.fillStyle = COLORS.pin;
      ctx.beginPath();
      ctx.arc(pin.position.x, pin.position.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Component name label (draw un-rotated so text stays readable)
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.translate(snapped.x, snapped.y);
    ctx.fillStyle = COLORS.text;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(this.placingComponent.name, 0, 4);

    ctx.restore();
  }

  private renderBoxSelection(): void {
    if (!this.isBoxSelecting) return;
    const { ctx } = this;
    const x = Math.min(this.boxSelectStart.x, this.boxSelectEnd.x);
    const y = Math.min(this.boxSelectStart.y, this.boxSelectEnd.y);
    const w = Math.abs(this.boxSelectEnd.x - this.boxSelectStart.x);
    const h = Math.abs(this.boxSelectEnd.y - this.boxSelectStart.y);

    // Fill
    ctx.fillStyle = COLORS.selection;
    ctx.fillRect(x, y, w, h);

    // Border
    ctx.strokeStyle = COLORS.selectionBorder;
    ctx.lineWidth = 1.5 / this.transform.scale;
    ctx.setLineDash([6 / this.transform.scale, 4 / this.transform.scale]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  private renderHUD(w: number, h: number): void {
    const { ctx } = this;
    const snapped = this.currentTool === 'wire' ? this.snapToPinOrGrid(this.mouseWorld) : this.snapToGrid(this.mouseWorld);

    // Coordinates
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`(${snapped.x}, ${snapped.y})  zoom: ${(this.transform.scale * 100).toFixed(0)}%`, 10, h - 10);

    // Tool indicator
    ctx.textAlign = 'right';
    ctx.fillText(`Tool: ${this.currentTool}`, w - 10, h - 10);
  }

  destroy(): void {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
  }
}
