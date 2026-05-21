// ============================================================
// Smart Circuit — PCB Canvas Renderer
// Renders board outline, pads, traces, components with
// multi-layer transparency on an HTML5 Canvas.
// Includes full manual routing support.
// ============================================================

import type { CircuitDocument, PCBComponent, PCBTrace, PCBVia, PCBLayer, Point, PCBTool } from '../core/types';
import type { FootprintDefinition, PadDefinition } from '../library/easyeda-parser';

// ----- Layer Colors -----

const PCB_COLORS: Record<PCBLayer, string> = {
  'F.Cu': '#e54545',
  'B.Cu': '#4545e5',
  'In1.Cu': '#e5e545',
  'In2.Cu': '#45e545',
  'F.SilkS': '#e5e5e5',
  'B.SilkS': '#e5e5e5',
  'Edge.Cuts': '#e5e545',
};

const COLORS = {
  background: '#1a1e2e',
  grid: '#1e2a3e',
  gridMajor: '#253a52',
  text: '#e2e2e2',
  textDim: '#8888aa',
  selection: 'rgba(0, 201, 167, 0.2)',
  selectionBorder: '#00c9a7',
  crossHighlight: '#00c9a7',
  drillHole: '#1a1e2e',
  courtyard: '#888888',
  ghost: 'rgba(0, 201, 167, 0.35)',
  crosshair: '#ffffff22',
  routingPreview: '#00c9a7',
  routingActive: '#00ff88',
  viaColor: '#ffaa00',
  traceHighlight: '#00ff88',
  netIndicator: '#ff6644',
  diffPair1: '#00c9a7',
  diffPair2: '#45a5e5',
  lengthWarning: '#e5c545',
  lengthError: '#e54545',
};

// ----- Rendering order for layers (bottom → top) -----

const LAYER_RENDER_ORDER: PCBLayer[] = [
  'B.SilkS',
  'B.Cu',
  'In2.Cu',
  'In1.Cu',
  'F.Cu',
  'F.SilkS',
];

// Copper layers reference (used for layer-specific rendering)
const COPPER_LAYERS: PCBLayer[] = ['F.Cu', 'B.Cu', 'In1.Cu', 'In2.Cu'];
void COPPER_LAYERS;

// ----- View Transform -----

interface ViewTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

// ----- PCB Renderer -----

export class PCBRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private transform: ViewTransform = { offsetX: 0, offsetY: 0, scale: 4.0 };
  private animFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Grid in mm (default 0.254mm = 10 mils)
  private gridSizeMm = 0.254;

  // Layer state
  private activeLayer: PCBLayer = 'F.Cu';
  private layerVisibility: Record<PCBLayer, boolean> = {
    'F.Cu': true, 'B.Cu': true, 'In1.Cu': true, 'In2.Cu': true,
    'F.SilkS': true, 'B.SilkS': true, 'Edge.Cuts': true,
  };

  // Interaction state
  private selectedPCBComponentId: string | null = null;
  private selectedPCBComponentIds = new Set<string>();
  private highlightedSchematicId: string | null = null;
  private isDragging = false;
  private isPanning = false;
  private dragStart: Point = { x: 0, y: 0 };
  private dragOffset: Point = { x: 0, y: 0 };
  private mouseScreen: Point = { x: 0, y: 0 };
  private mouseWorld: Point = { x: 0, y: 0 };

  // Box selection state
  private isBoxSelecting = false;
  private boxSelectStart: Point = { x: 0, y: 0 };
  private boxSelectEnd: Point = { x: 0, y: 0 };

  // Drag-from-drawer state
  private draggingComponentId: string | null = null;

  // Routing state
  private activeTool: PCBTool = 'select';
  private selectedTraceId: string | null = null;
  private selectedViaId: string | null = null;
  private routing45Deg = false; // 45-degree routing mode

  // Data
  private document: CircuitDocument | null = null;
  private footprintMap = new Map<string, FootprintDefinition>();

  // Callbacks
  onComponentPlaced: ((pcbComponentId: string, position: Point) => void) | null = null;
  onComponentMoved: ((pcbComponentId: string, position: Point) => void) | null = null;
  onComponentSelected: ((schematicComponentId: string | null) => void) | null = null;
  onZoomChanged: ((percent: number) => void) | null = null;
  onDeleteRequested: ((pcbComponentIds: string[]) => void) | null = null;
  onBatchMoved: ((moves: { id: string; position: Point }[]) => void) | null = null;

  // Routing callbacks
  onRouteStart: ((netId: string, layer: PCBLayer, point: Point) => void) | null = null;
  onRoutePoint: ((point: Point) => void) | null = null;
  onRouteComplete: ((netId: string, layer: PCBLayer, points: Point[]) => void) | null = null;
  onRouteCancel: (() => void) | null = null;
  onViaPlace: ((position: Point, fromLayer: PCBLayer, toLayer: PCBLayer) => void) | null = null;
  onLayerChange: ((layer: PCBLayer) => void) | null = null;
  onToolChange: ((tool: PCBTool) => void) | null = null;
  onTraceSelected: ((trace: PCBTrace | null) => void) | null = null;
  onViaSelected: ((via: PCBVia | null) => void) | null = null;

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
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.startRenderLoop();
  }

  // ----- Public API -----

  setDocument(doc: CircuitDocument): void {
    this.document = doc;
    if (doc.pcbLayout) {
      this.activeLayer = doc.pcbLayout.activeLayer || 'F.Cu';
      this.activeTool = doc.pcbLayout.activeTool || 'select';
    }
  }

  setFootprintMap(map: Map<string, FootprintDefinition>): void {
    this.footprintMap = map;
  }

  setActiveLayer(layer: PCBLayer): void {
    this.activeLayer = layer;
    if (this.document?.pcbLayout) {
      this.document.pcbLayout.activeLayer = layer;
    }
    this.onLayerChange?.(layer);
  }

  setLayerVisibility(layer: PCBLayer, visible: boolean): void {
    this.layerVisibility[layer] = visible;
  }

  setTool(tool: PCBTool): void {
    this.activeTool = tool;
    if (this.document?.pcbLayout) {
      this.document.pcbLayout.activeTool = tool;
    }
    this.updateCursor();
    this.onToolChange?.(tool);
  }

  set45DegreeRouting(enabled: boolean): void {
    this.routing45Deg = enabled;
  }

  highlightComponent(schematicComponentId: string | null): void {
    this.highlightedSchematicId = schematicComponentId;
  }

  startDraggingComponent(pcbComponentId: string): void {
    this.draggingComponentId = pcbComponentId;
    this.canvas.style.cursor = 'copy';
  }

  getSelectedPCBComponentId(): string | null {
    return this.selectedPCBComponentId;
  }

  getSelectedPCBComponentIds(): string[] {
    return [...this.selectedPCBComponentIds];
  }

  getActiveTool(): PCBTool {
    return this.activeTool;
  }

  centerView(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    if (this.document?.pcbLayout) {
      const board = this.document.pcbLayout.board;
      const scaleX = (w * 0.8) / board.width;
      const scaleY = (h * 0.8) / board.height;
      this.transform.scale = Math.min(scaleX, scaleY, 10);
      this.transform.offsetX = (w - board.width * this.transform.scale) / 2;
      this.transform.offsetY = (h - board.height * this.transform.scale) / 2;
    } else {
      this.transform = { offsetX: w / 2, offsetY: h / 2, scale: 4.0 };
    }
  }

  zoomIn(): void {
    const dpr = window.devicePixelRatio || 1;
    const cx = (this.canvas.width / dpr) / 2;
    const cy = (this.canvas.height / dpr) / 2;
    const oldScale = this.transform.scale;
    this.transform.scale = Math.min(50, oldScale * 1.15);
    this.transform.offsetX = cx - (cx - this.transform.offsetX) * (this.transform.scale / oldScale);
    this.transform.offsetY = cy - (cy - this.transform.offsetY) * (this.transform.scale / oldScale);
  }

  zoomOut(): void {
    const dpr = window.devicePixelRatio || 1;
    const cx = (this.canvas.width / dpr) / 2;
    const cy = (this.canvas.height / dpr) / 2;
    const oldScale = this.transform.scale;
    this.transform.scale = Math.max(0.5, oldScale * 0.85);
    this.transform.offsetX = cx - (cx - this.transform.offsetX) * (this.transform.scale / oldScale);
    this.transform.offsetY = cy - (cy - this.transform.offsetY) * (this.transform.scale / oldScale);
  }

  getZoomPercent(): number {
    return Math.round(this.transform.scale * 100);
  }

  /** Get the current active layer. */
  getActiveLayer(): PCBLayer {
    return this.activeLayer;
  }

  destroy(): void {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.resizeObserver?.disconnect();
    this.canvas.remove();
  }

  private updateCursor(): void {
    switch (this.activeTool) {
      case 'route':
        this.canvas.style.cursor = 'crosshair';
        break;
      case 'via':
        this.canvas.style.cursor = 'cell';
        break;
      case 'delete':
        this.canvas.style.cursor = 'not-allowed';
        break;
      case 'pan':
        this.canvas.style.cursor = 'grab';
        break;
      default:
        this.canvas.style.cursor = 'crosshair';
    }
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
    window.addEventListener('keydown', e => this.onKeyDown(e));

    // Safari-specific: handle trackpad pinch-to-zoom via native GestureEvent.
    this.canvas.addEventListener('gesturestart', ((e: any) => {
      e.preventDefault();
      this._gestureScale = this.transform.scale;
      this._gestureActive = true;
    }) as EventListener, { passive: false } as any);

    this.canvas.addEventListener('gesturechange', ((e: any) => {
      e.preventDefault();
      const newScale = Math.max(0.5, Math.min(50, this._gestureScale * e.scale));
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
      y: (sy - this.transform.offsetY) / this.transform.scale,
    };
  }

  private snapToGrid(p: Point): Point {
    const gs = this.gridSizeMm;
    return {
      x: Math.round(p.x / gs) * gs,
      y: Math.round(p.y / gs) * gs,
    };
  }

  /** Snap to grid with 45-degree constraint for routing. */
  private snapRoutingPoint(p: Point, fromPoint?: Point): Point {
    if (!fromPoint || !this.routing45Deg) {
      return this.snapToGrid(p);
    }

    // Constrain to 45-degree angles from the previous point
    const dx = p.x - fromPoint.x;
    const dy = p.y - fromPoint.y;

    if (Math.abs(dx) > Math.abs(dy)) {
      // Horizontal or 45-degree
      if (Math.abs(dy / dx) < 0.4) {
        // Horizontal
        return { x: p.x, y: fromPoint.y };
      } else {
        // 45-degree
        const dist = Math.abs(dx);
        const signX = dx > 0 ? 1 : -1;
        const signY = dy > 0 ? 1 : -1;
        return { x: fromPoint.x + signX * dist, y: fromPoint.y + signY * dist };
      }
    } else {
      // Vertical or 45-degree
      if (Math.abs(dx / dy) < 0.4) {
        // Vertical
        return { x: fromPoint.x, y: p.y };
      } else {
        // 45-degree
        const dist = Math.abs(dy);
        const signX = dx > 0 ? 1 : -1;
        const signY = dy > 0 ? 1 : -1;
        return { x: fromPoint.x + signX * dist, y: fromPoint.y + signY * dist };
      }
    }
  }

  // ----- Pointer Handlers -----

  private onPointerDown(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    const rect = this.canvas.getBoundingClientRect();
    this.activePointers.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });

    // Two-finger gesture start
    if (this.activePointers.size === 2) {
      const pts = [...this.activePointers.values()];
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      this._pinchStartDist = Math.sqrt(dx * dx + dy * dy);
      this._pinchStartScale = this.transform.scale;
      this._pinchLastCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      this._multiTouchActive = true;
      this.isPanning = false;
      this.isDragging = false;
      this.isBoxSelecting = false;
      this.dragOffset = { x: 0, y: 0 };
      return;
    }

    if (this._multiTouchActive) return;

    this.mouseScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.mouseWorld = this.screenToWorld(this.mouseScreen.x, this.mouseScreen.y);

    // Drag-from-drawer placement
    if (this.draggingComponentId && e.button === 0) {
      const snapped = this.snapToGrid(this.mouseWorld);
      this.onComponentPlaced?.(this.draggingComponentId, snapped);
      this.draggingComponentId = null;
      this.canvas.style.cursor = 'crosshair';
      return;
    }

    // Pan tool or middle-click or shift+click
    if (this.activeTool === 'pan' || e.button === 1 || (e.button === 0 && e.shiftKey)) {
      this.isPanning = true;
      this.dragStart = { ...this.mouseScreen };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 0) {
      // Routing mode
      if (this.activeTool === 'route') {
        this.handleRouteClick();
        return;
      }

      // Via placement mode
      if (this.activeTool === 'via') {
        this.handleViaClick();
        return;
      }

      // Delete mode
      if (this.activeTool === 'delete') {
        this.handleDeleteClick();
        return;
      }

      // Select mode - hit test traces first, then components
      const hitTrace = this.hitTestTrace(this.mouseWorld);
      if (hitTrace) {
        this.selectedTraceId = hitTrace.id;
        this.selectedViaId = null;
        this.onTraceSelected?.(hitTrace);
        this.onViaSelected?.(null);
        return;
      }

      const hitVia = this.hitTestVia(this.mouseWorld);
      if (hitVia) {
        this.selectedViaId = hitVia.id;
        this.selectedTraceId = null;
        this.onViaSelected?.(hitVia);
        this.onTraceSelected?.(null);
        return;
      }

      // Try to hit-test a component
      const hit = this.hitTestComponent(this.mouseWorld);
      if (hit) {
        if (!this.selectedPCBComponentIds.has(hit.id)) {
          this.selectedPCBComponentIds.clear();
          this.selectedPCBComponentIds.add(hit.id);
        }
        this.selectedPCBComponentId = hit.id;
        this.selectedTraceId = null;
        this.selectedViaId = null;
        this.isDragging = true;
        this.dragStart = this.snapToGrid(this.mouseWorld);
        this.dragOffset = { x: 0, y: 0 };
        this.onTraceSelected?.(null);
        this.onViaSelected?.(null);
        this.onComponentSelected?.(hit.schematicComponentId);
        return;
      }

      // Nothing hit → start box selection, deselect
      this.isBoxSelecting = true;
      this.boxSelectStart = { ...this.mouseWorld };
      this.boxSelectEnd = { ...this.mouseWorld };
      this.selectedPCBComponentIds.clear();
      this.selectedPCBComponentId = null;
      this.selectedTraceId = null;
      this.selectedViaId = null;
      this.onComponentSelected?.(null);
      this.onTraceSelected?.(null);
      this.onViaSelected?.(null);
    }
  }

  private handleRouteClick(): void {
    if (!this.document?.pcbLayout) return;

    const snapped = this.snapRoutingPoint(
      this.mouseWorld,
      this.document.pcbLayout.routingPoints?.length
        ? this.document.pcbLayout.routingPoints![this.document.pcbLayout.routingPoints!.length - 1]
        : undefined
    );

    // Check if clicking on a pad to start routing from that net
    if (!this.document.pcbLayout.routingPoints || this.document.pcbLayout.routingPoints.length === 0) {
      const padHit = this.hitTestPadForRouting(this.mouseWorld);
      if (padHit) {
        this.document.pcbLayout.routingNetId = padHit.netId;
        this.document.pcbLayout.routingPoints = [{ ...snapped }];
        this.document.pcbLayout.activeTool = 'route';
        this.onRouteStart?.(padHit.netId, this.activeLayer, snapped);
        return;
      }
    }

    // Add point to in-progress route
    if (this.document.pcbLayout.routingPoints) {
      this.document.pcbLayout.routingPoints.push({ ...snapped });
    }
    this.onRoutePoint?.(snapped);
  }

  private handleViaClick(): void {
    if (!this.document?.pcbLayout) return;

    const snapped = this.snapToGrid(this.mouseWorld);

    // Determine target layer
    let targetLayer: PCBLayer;
    if (this.activeLayer === 'F.Cu') {
      targetLayer = this.document.pcbLayout.board.layerCount >= 4 ? 'In1.Cu' : 'B.Cu';
    } else if (this.activeLayer === 'B.Cu') {
      targetLayer = this.document.pcbLayout.board.layerCount >= 4 ? 'In2.Cu' : 'F.Cu';
    } else if (this.activeLayer === 'In1.Cu') {
      targetLayer = 'In2.Cu';
    } else {
      targetLayer = 'F.Cu';
    }

    // Determine net ID from routing context or nearby traces
    const _netId = this.document.pcbLayout.routingNetId || 'unknown';
    void _netId;

    this.onViaPlace?.(snapped, this.activeLayer, targetLayer);

    // Switch to target layer after placing via
    if (this.document.pcbLayout.routingPoints) {
      this.setActiveLayer(targetLayer);
    }
  }

  private handleDeleteClick(): void {
    // Try to hit-test a trace
    const hitTrace = this.hitTestTrace(this.mouseWorld);
    if (hitTrace) {
      // Emit delete request
      this.selectedTraceId = hitTrace.id;
      this.onTraceSelected?.(hitTrace);
      return;
    }

    const hitVia = this.hitTestVia(this.mouseWorld);
    if (hitVia) {
      this.selectedViaId = hitVia.id;
      this.onViaSelected?.(hitVia);
      return;
    }

    // Try component
    const hit = this.hitTestComponent(this.mouseWorld);
    if (hit) {
      this.selectedPCBComponentId = hit.id;
      this.selectedPCBComponentIds.clear();
      this.selectedPCBComponentIds.add(hit.id);
      this.onDeleteRequested?.([hit.id]);
      this.selectedPCBComponentIds.clear();
      this.selectedPCBComponentId = null;
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

      this.transform.offsetX += center.x - this._pinchLastCenter.x;
      this.transform.offsetY += center.y - this._pinchLastCenter.y;
      this._pinchLastCenter = center;

      if (this._pinchStartDist > 0) {
        const ratio = dist / this._pinchStartDist;
        const newScale = Math.max(0.5, Math.min(50, this._pinchStartScale * ratio));
        if (Number.isFinite(newScale) && newScale > 0) {
          const oldScale = this.transform.scale;
          this.transform.scale = newScale;
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

    if (this._multiTouchActive) return;

    this.mouseScreen = screenPt;
    this.mouseWorld = this.screenToWorld(this.mouseScreen.x, this.mouseScreen.y);

    if (this.isPanning) {
      this.transform.offsetX += this.mouseScreen.x - this.dragStart.x;
      this.transform.offsetY += this.mouseScreen.y - this.dragStart.y;
      this.dragStart = { ...this.mouseScreen };
      return;
    }

    if (this.isDragging && this.selectedPCBComponentId) {
      const snapped = this.snapToGrid(this.mouseWorld);
      this.dragOffset = {
        x: snapped.x - this.dragStart.x,
        y: snapped.y - this.dragStart.y,
      };
    }

    if (this.isBoxSelecting) {
      this.boxSelectEnd = { ...this.mouseWorld };
      this.computeBoxSelection();
      return;
    }

    if (this.draggingComponentId) {
      this.canvas.style.cursor = 'copy';
    }
  }

  private onPointerUp(e: PointerEvent): void {
    this.activePointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}

    if (this._multiTouchActive) {
      if (this.activePointers.size < 2) {
        this._multiTouchActive = this.activePointers.size > 0;
        if (this.activePointers.size === 0) this._multiTouchActive = false;
      }
      return;
    }

    if (this.isPanning) {
      this.isPanning = false;
      this.updateCursor();
      return;
    }

    if (this.isBoxSelecting) {
      this.isBoxSelecting = false;
      this.computeBoxSelection();
      if (this.selectedPCBComponentIds.size > 0) {
        const firstId = [...this.selectedPCBComponentIds][0];
        this.selectedPCBComponentId = firstId;
        const comp = this.findPCBComponent(firstId);
        this.onComponentSelected?.(comp?.schematicComponentId || null);
      }
      return;
    }

    if (this.isDragging && this.selectedPCBComponentId) {
      if (this.dragOffset.x !== 0 || this.dragOffset.y !== 0) {
        if (this.selectedPCBComponentIds.size > 1 && this.onBatchMoved) {
          const moves: { id: string; position: Point }[] = [];
          for (const id of this.selectedPCBComponentIds) {
            const comp = this.findPCBComponent(id);
            if (comp) {
              moves.push({
                id,
                position: {
                  x: comp.position.x + this.dragOffset.x,
                  y: comp.position.y + this.dragOffset.y,
                }
              });
            }
          }
          this.onBatchMoved(moves);
        } else {
          const comp = this.findPCBComponent(this.selectedPCBComponentId);
          if (comp) {
            this.onComponentMoved?.(this.selectedPCBComponentId, {
              x: comp.position.x + this.dragOffset.x,
              y: comp.position.y + this.dragOffset.y,
            });
          }
        }
      }
      this.isDragging = false;
      this.dragOffset = { x: 0, y: 0 };
    }
  }

  private onWheel(e: WheelEvent): void {
    try {
      if (e.cancelable) e.preventDefault();
    } catch (_) { /* Safari: non-cancelable event */ }

    if (this._gestureActive) return;

    if (e.ctrlKey || e.metaKey) {
      const clampedDeltaY = Math.max(-50, Math.min(50, e.deltaY));
      const zoomIntensity = 0.01;
      const zoomFactor = Math.exp(-clampedDeltaY * zoomIntensity);
      const oldScale = this.transform.scale;
      const newScale = Math.max(0.5, Math.min(50, oldScale * zoomFactor));

      if (!Number.isFinite(newScale) || newScale <= 0) return;
      this.transform.scale = newScale;

      const newOffX = this.mouseScreen.x - (this.mouseScreen.x - this.transform.offsetX) * (this.transform.scale / oldScale);
      const newOffY = this.mouseScreen.y - (this.mouseScreen.y - this.transform.offsetY) * (this.transform.scale / oldScale);
      if (Number.isFinite(newOffX) && Number.isFinite(newOffY)) {
        this.transform.offsetX = newOffX;
        this.transform.offsetY = newOffY;
      }
      this.onZoomChanged?.(this.getZoomPercent());
    } else {
      this.transform.offsetX -= e.deltaX;
      this.transform.offsetY -= e.deltaY;
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;

    if (e.key === 'Escape') {
      if (this.isBoxSelecting) {
        this.isBoxSelecting = false;
        return;
      }

      // Cancel routing
      if (this.activeTool === 'route' && this.document?.pcbLayout?.routingPoints) {
        this.document.pcbLayout.routingPoints = [];
        this.document.pcbLayout.routingNetId = undefined;
        this.document.pcbLayout.activeTool = 'select';
        this.activeTool = 'select';
        this.updateCursor();
        this.onRouteCancel?.();
        return;
      }

      this.draggingComponentId = null;
      this.selectedPCBComponentIds.clear();
      this.selectedPCBComponentId = null;
      this.selectedTraceId = null;
      this.selectedViaId = null;
      this.onComponentSelected?.(null);
      this.onTraceSelected?.(null);
      this.onViaSelected?.(null);
      this.updateCursor();
    }

    // Delete/Backspace
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedTraceId) {
        e.preventDefault();
        this.onTraceSelected?.(null);
        this.selectedTraceId = null;
      } else if (this.selectedViaId) {
        e.preventDefault();
        this.onViaSelected?.(null);
        this.selectedViaId = null;
      } else if (this.selectedPCBComponentIds.size > 0) {
        e.preventDefault();
        this.onDeleteRequested?.([...this.selectedPCBComponentIds]);
        this.selectedPCBComponentIds.clear();
        this.selectedPCBComponentId = null;
        this.onComponentSelected?.(null);
      } else if (this.selectedPCBComponentId) {
        e.preventDefault();
        this.onDeleteRequested?.([this.selectedPCBComponentId]);
        this.selectedPCBComponentId = null;
        this.onComponentSelected?.(null);
      }
    }

    // Tool shortcuts
    if (e.key === 'r' || e.key === 'R') {
      if (!e.ctrlKey && !e.metaKey) {
        this.setTool(this.activeTool === 'route' ? 'select' : 'route');
      }
    }
    if (e.key === 'v' || e.key === 'V') {
      this.setTool(this.activeTool === 'via' ? 'select' : 'via');
    }
    if (e.key === 'd' || e.key === 'D') {
      this.setTool(this.activeTool === 'delete' ? 'select' : 'delete');
    }
    if (e.key === 'h' || e.key === 'H') {
      this.setTool(this.activeTool === 'pan' ? 'select' : 'pan');
    }

    // Double-click to complete route
    if (e.key === 'Enter' && this.activeTool === 'route' && this.document?.pcbLayout?.routingPoints) {
      e.preventDefault();
      const points = [...this.document.pcbLayout.routingPoints];
      const netId = this.document.pcbLayout.routingNetId || 'unknown';
      this.onRouteComplete?.(netId, this.activeLayer, points);
    }
  }

  // ----- Hit Testing -----

  private hitTestComponent(world: Point): PCBComponent | null {
    if (!this.document?.pcbLayout) return null;

    const components = this.document.pcbLayout.components;
    for (let i = components.length - 1; i >= 0; i--) {
      const comp = components[i];
      if (!comp.isPlaced) continue;

      const fp = this.footprintMap.get(comp.footprintId);
      if (!fp) continue;

      const cy = fp.courtyard;
      const hw = cy.width / 2;
      const hh = cy.height / 2;
      const cx = cy.x + cy.width / 2;
      const cyY = cy.y + cy.height / 2;

      const dx = world.x - comp.position.x;
      const dy = world.y - comp.position.y;
      const rad = -(comp.rotation || 0) * Math.PI / 180;
      const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
      const localY = dx * Math.sin(rad) + dy * Math.cos(rad);

      if (localX >= cx - hw && localX <= cx + hw && localY >= cyY - hh && localY <= cyY + hh) {
        return comp;
      }
    }
    return null;
  }

  /** Hit-test traces. Returns the closest trace within snap distance. */
  private hitTestTrace(world: Point): PCBTrace | null {
    if (!this.document?.pcbLayout) return null;

    const snapDist = 2 / this.transform.scale; // ~2mm in world space
    let closest: PCBTrace | null = null;
    let closestDist = snapDist;

    for (const trace of this.document.pcbLayout.traces) {
      if (trace.points.length < 2) continue;

      for (let i = 0; i < trace.points.length - 1; i++) {
        const dist = this.pointToSegmentDist(world, trace.points[i], trace.points[i + 1]);
        if (dist < closestDist) {
          closestDist = dist;
          closest = trace;
        }
      }
    }

    return closest;
  }

  /** Hit-test vias. */
  private hitTestVia(world: Point): PCBVia | null {
    if (!this.document?.pcbLayout) return null;

    const snapDist = 1.5 / this.transform.scale;
    let closest: PCBVia | null = null;
    let closestDist = snapDist;

    for (const via of this.document.pcbLayout.vias) {
      const dist = Math.sqrt(
        (world.x - via.position.x) ** 2 + (world.y - via.position.y) ** 2
      );
      if (dist < closestDist) {
        closestDist = dist;
        closest = via;
      }
    }

    return closest;
  }

  /** Hit-test pads for routing start. Returns pad info with net ID. */
  private hitTestPadForRouting(world: Point): { netId: string; position: Point } | null {
    if (!this.document?.pcbLayout) return null;

    const snapDist = 3 / this.transform.scale;
    let closest: { netId: string; position: Point } | null = null;
    let closestDist = snapDist;

    for (const comp of this.document.pcbLayout.components) {
      if (!comp.isPlaced) continue;

      const fp = this.footprintMap.get(comp.footprintId);
      if (!fp) continue;

      // Find schematic component to get net info
      const schematicComp = this.getSchematicComponent(comp.schematicComponentId);
      if (!schematicComp) continue;

      for (const pad of fp.pads) {
        const dx = pad.x;
        const dy = pad.y;
        const rad = (comp.rotation || 0) * Math.PI / 180;
        const boardX = comp.position.x + (dx * Math.cos(rad) - dy * Math.sin(rad));
        const boardY = comp.position.y + (dx * Math.sin(rad) + dy * Math.cos(rad));

        const dist = Math.sqrt(
          (world.x - boardX) ** 2 + (world.y - boardY) ** 2
        );

        if (dist < closestDist) {
          closestDist = dist;
          // Get net ID from the pin
          const pinDef = pad.pinId || pad.id;
          const pinInstance = schematicComp.pins.find(p => p.definitionId === pinDef);
          const netId = pinInstance?.netId || comp.schematicComponentId;
          closest = { netId, position: { x: boardX, y: boardY } };
        }
      }
    }

    return closest;
  }

  private findPCBComponent(id: string): PCBComponent | undefined {
    return this.document?.pcbLayout?.components.find(c => c.id === id);
  }

  private pointToSegmentDist(p: Point, a: Point, b: Point): number {
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

  private computeBoxSelection(): void {
    if (!this.document?.pcbLayout) return;

    const minX = Math.min(this.boxSelectStart.x, this.boxSelectEnd.x);
    const maxX = Math.max(this.boxSelectStart.x, this.boxSelectEnd.x);
    const minY = Math.min(this.boxSelectStart.y, this.boxSelectEnd.y);
    const maxY = Math.max(this.boxSelectStart.y, this.boxSelectEnd.y);

    this.selectedPCBComponentIds.clear();
    for (const comp of this.document.pcbLayout.components) {
      if (!comp.isPlaced) continue;
      if (comp.position.x >= minX && comp.position.x <= maxX &&
          comp.position.y >= minY && comp.position.y <= maxY) {
        this.selectedPCBComponentIds.add(comp.id);
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
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this.transform.offsetX, this.transform.offsetY);
    ctx.scale(this.transform.scale, this.transform.scale);

    this.renderGrid(w, h);

    if (this.document?.pcbLayout) {
      const pcb = this.document.pcbLayout;

      this.renderBoardOutline(pcb);

      for (const layer of LAYER_RENDER_ORDER) {
        if (!this.layerVisibility[layer]) continue;
        const opacity = layer === this.activeLayer ? 1.0 : 0.3;
        ctx.globalAlpha = opacity;

        this.renderTraces(pcb.traces, layer);
        this.renderComponentsOnLayer(pcb.components, layer);

        ctx.globalAlpha = 1.0;
      }

      // Vias (rendered on top of all layers)
      this.renderVias(pcb.vias);

      // Courtyard outlines
      this.renderCourtyards(pcb.components);

      // Selection / cross-highlights
      this.renderHighlights(pcb.components);

      // Trace selection highlight
      this.renderTraceHighlight();

      // Routing preview
      this.renderRoutingPreview();
    }

    // Ghost preview for drag-from-drawer
    this.renderDragGhost();

    // Box selection rectangle
    this.renderBoxSelection();

    ctx.restore();

    // HUD
    this.renderHUD(w, h);
  }

  private renderGrid(viewW: number, viewH: number): void {
    const { ctx } = this;
    const scale = this.transform.scale;
    const effectiveGridMm = scale > 8 ? this.gridSizeMm : (scale > 3 ? this.gridSizeMm * 4 : 1.0);

    const startX = Math.floor(-this.transform.offsetX / scale / effectiveGridMm) * effectiveGridMm - effectiveGridMm;
    const startY = Math.floor(-this.transform.offsetY / scale / effectiveGridMm) * effectiveGridMm - effectiveGridMm;
    const endX = startX + viewW / scale + effectiveGridMm * 2;
    const endY = startY + viewH / scale + effectiveGridMm * 2;

    const countX = (endX - startX) / effectiveGridMm;
    const countY = (endY - startY) / effectiveGridMm;
    if (countX * countY > 10000) return;

    ctx.fillStyle = COLORS.grid;
    for (let x = startX; x <= endX; x += effectiveGridMm) {
      for (let y = startY; y <= endY; y += effectiveGridMm) {
        const isMajor = Math.abs(x % 1.0) < 0.01 && Math.abs(y % 1.0) < 0.01;
        const size = isMajor ? 0.15 : 0.08;
        ctx.fillStyle = isMajor ? COLORS.gridMajor : COLORS.grid;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }

    ctx.strokeStyle = COLORS.crosshair;
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(endX, 0);
    ctx.moveTo(0, startY);
    ctx.lineTo(0, endY);
    ctx.stroke();
  }

  private renderBoardOutline(pcb: NonNullable<CircuitDocument['pcbLayout']>): void {
    const { ctx } = this;
    const board = pcb.board;

    if (!this.layerVisibility['Edge.Cuts']) return;

    ctx.strokeStyle = PCB_COLORS['Edge.Cuts'];
    ctx.lineWidth = 0.15;
    ctx.setLineDash([]);
    ctx.strokeRect(0, 0, board.width, board.height);
  }

  private renderTraces(traces: PCBTrace[], layer: PCBLayer): void {
    const { ctx } = this;
    const color = PCB_COLORS[layer];

    for (const trace of traces) {
      if (trace.layer !== layer) continue;
      if (trace.points.length < 2) continue;

      ctx.strokeStyle = color;
      ctx.lineWidth = trace.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(trace.points[0].x, trace.points[0].y);
      for (let i = 1; i < trace.points.length; i++) {
        ctx.lineTo(trace.points[i].x, trace.points[i].y);
      }
      ctx.stroke();
    }
  }

  private renderVias(vias: PCBVia[]): void {
    const { ctx } = this;

    for (const via of vias) {
      ctx.fillStyle = COLORS.viaColor;
      ctx.beginPath();
      ctx.arc(via.position.x, via.position.y, via.outerDiameter / 2, 0, Math.PI * 2);
      ctx.fill();

      // Drill hole
      ctx.fillStyle = COLORS.drillHole;
      ctx.beginPath();
      ctx.arc(via.position.x, via.position.y, via.drill / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private renderComponentsOnLayer(components: PCBComponent[], layer: PCBLayer): void {
    const { ctx } = this;

    for (const comp of components) {
      if (!comp.isPlaced) continue;

      const fp = this.footprintMap.get(comp.footprintId);
      if (!fp) continue;

      const isBeingDragged = this.isDragging && this.selectedPCBComponentIds.has(comp.id);
      const offsetX = isBeingDragged ? this.dragOffset.x : 0;
      const offsetY = isBeingDragged ? this.dragOffset.y : 0;

      ctx.save();
      ctx.translate(comp.position.x + offsetX, comp.position.y + offsetY);
      if (comp.rotation) {
        ctx.rotate(comp.rotation * Math.PI / 180);
      }

      for (const pad of fp.pads) {
        if (pad.layer !== layer) continue;
        this.renderPad(pad, layer);
      }

      if (layer === 'F.SilkS' || layer === 'B.SilkS') {
        this.renderSilkscreen(fp, layer);
      }

      ctx.restore();
    }
  }

  private renderPad(pad: PadDefinition, layer: PCBLayer): void {
    const { ctx } = this;
    const color = PCB_COLORS[layer];

    ctx.save();
    ctx.translate(pad.x, pad.y);
    if (pad.rotation) {
      ctx.rotate(pad.rotation * Math.PI / 180);
    }

    ctx.fillStyle = color;

    switch (pad.shape) {
      case 'rect':
        ctx.fillRect(-pad.width / 2, -pad.height / 2, pad.width, pad.height);
        break;
      case 'circle': {
        const r = Math.max(pad.width, pad.height) / 2;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'oval':
        this.drawOval(ctx, 0, 0, pad.width, pad.height);
        break;
    }

    if (pad.drill && pad.drill > 0) {
      ctx.fillStyle = COLORS.drillHole;
      ctx.beginPath();
      ctx.arc(0, 0, pad.drill / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    const fontSize = Math.min(pad.width, pad.height) * 0.5;
    if (fontSize > 0.1) {
      ctx.fillStyle = COLORS.background;
      ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pad.pinId || pad.id, 0, 0);
    }

    ctx.restore();
  }

  private drawOval(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number): void {
    const r = Math.min(w, h) / 2;
    const hw = w / 2;
    const hh = h / 2;

    ctx.beginPath();
    if (w > h) {
      ctx.arc(cx - hw + r, cy, r, Math.PI * 0.5, Math.PI * 1.5);
      ctx.arc(cx + hw - r, cy, r, Math.PI * 1.5, Math.PI * 0.5);
    } else {
      ctx.arc(cx, cy - hh + r, r, Math.PI, 0);
      ctx.arc(cx, cy + hh - r, r, 0, Math.PI);
    }
    ctx.closePath();
    ctx.fill();
  }

  private renderSilkscreen(fp: FootprintDefinition, layer: PCBLayer): void {
    const { ctx } = this;
    const color = PCB_COLORS[layer];

    for (const silk of fp.silkscreen) {
      if ('layer' in silk && (silk as any).layer !== layer) continue;
      if (!silk.points || silk.points.length < 2) continue;

      ctx.strokeStyle = color;
      ctx.lineWidth = (silk as any).strokeWidth || 0.12;
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(silk.points[0].x, silk.points[0].y);
      for (let i = 1; i < silk.points.length; i++) {
        ctx.lineTo(silk.points[i].x, silk.points[i].y);
      }
      ctx.stroke();
    }
  }

  private renderCourtyards(components: PCBComponent[]): void {
    const { ctx } = this;

    for (const comp of components) {
      if (!comp.isPlaced) continue;

      const fp = this.footprintMap.get(comp.footprintId);
      if (!fp) continue;

      const isBeingDragged = this.isDragging && this.selectedPCBComponentIds.has(comp.id);
      const offsetX = isBeingDragged ? this.dragOffset.x : 0;
      const offsetY = isBeingDragged ? this.dragOffset.y : 0;

      ctx.save();
      ctx.translate(comp.position.x + offsetX, comp.position.y + offsetY);
      if (comp.rotation) {
        ctx.rotate(comp.rotation * Math.PI / 180);
      }

      const cy = fp.courtyard;
      ctx.strokeStyle = COLORS.courtyard;
      ctx.lineWidth = 0.08;
      ctx.setLineDash([0.2, 0.15]);
      ctx.strokeRect(cy.x, cy.y, cy.width, cy.height);
      ctx.setLineDash([]);

      const schematicComp = this.getSchematicComponent(comp.schematicComponentId);
      if (schematicComp) {
        ctx.fillStyle = COLORS.text;
        const fontSize = Math.max(0.6, Math.min(cy.width * 0.2, 1.2));
        ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(schematicComp.designator, cy.x + cy.width / 2, cy.y - 0.3);
      }

      ctx.restore();
    }
  }

  private renderHighlights(components: PCBComponent[]): void {
    const { ctx } = this;

    for (const comp of components) {
      if (!comp.isPlaced) continue;

      const isSelected = this.selectedPCBComponentIds.has(comp.id) || comp.id === this.selectedPCBComponentId;
      const isCrossHighlighted = comp.schematicComponentId === this.highlightedSchematicId;

      if (!isSelected && !isCrossHighlighted) continue;

      const fp = this.footprintMap.get(comp.footprintId);
      if (!fp) continue;

      const isBeingDragged = this.isDragging && this.selectedPCBComponentIds.has(comp.id);
      const offsetX = isBeingDragged ? this.dragOffset.x : 0;
      const offsetY = isBeingDragged ? this.dragOffset.y : 0;

      ctx.save();
      ctx.translate(comp.position.x + offsetX, comp.position.y + offsetY);
      if (comp.rotation) {
        ctx.rotate(comp.rotation * Math.PI / 180);
      }

      const cy = fp.courtyard;
      const pad = 0.3;

      if (isSelected) {
        ctx.strokeStyle = COLORS.selectionBorder;
        ctx.lineWidth = 0.15;
        ctx.setLineDash([]);
        ctx.strokeRect(cy.x - pad, cy.y - pad, cy.width + pad * 2, cy.height + pad * 2);
        ctx.fillStyle = COLORS.selection;
        ctx.fillRect(cy.x - pad, cy.y - pad, cy.width + pad * 2, cy.height + pad * 2);
      }

      if (isCrossHighlighted) {
        ctx.shadowColor = COLORS.crossHighlight;
        ctx.shadowBlur = 3;
        ctx.strokeStyle = COLORS.crossHighlight;
        ctx.lineWidth = 0.15;
        ctx.setLineDash([]);
        ctx.strokeRect(cy.x - pad, cy.y - pad, cy.width + pad * 2, cy.height + pad * 2);
        ctx.shadowBlur = 0;
      }

      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  private renderTraceHighlight(): void {
    if (!this.selectedTraceId || !this.document?.pcbLayout) return;

    const trace = this.document.pcbLayout.traces.find(t => t.id === this.selectedTraceId);
    if (!trace || trace.points.length < 2) return;

    const { ctx } = this;

    // Glow effect
    ctx.strokeStyle = COLORS.traceHighlight;
    ctx.lineWidth = trace.width + 0.3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(trace.points[0].x, trace.points[0].y);
    for (let i = 1; i < trace.points.length; i++) {
      ctx.lineTo(trace.points[i].x, trace.points[i].y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    // Length label
    const length = trace.length ?? this.calcTraceLength(trace.points);
    const midIdx = Math.floor(trace.points.length / 2);
    const mid = trace.points[midIdx];
    ctx.fillStyle = COLORS.text;
    ctx.font = '0.8px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${length.toFixed(2)}mm`, mid.x, mid.y - trace.width - 0.2);
  }

  private calcTraceLength(points: Point[]): number {
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      length += Math.sqrt(dx * dx + dy * dy);
    }
    return length;
  }

  private renderRoutingPreview(): void {
    if (!this.document?.pcbLayout?.routingPoints) return;
    if (this.document.pcbLayout.routingPoints.length === 0) return;

    const { ctx } = this;
    const points = this.document.pcbLayout.routingPoints;

    // Draw completed segments
    ctx.strokeStyle = COLORS.routingActive;
    ctx.lineWidth = this.document.pcbLayout.defaultTraceWidth || 0.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // Draw preview line from last point to mouse
    const lastPoint = points[points.length - 1];
    const snappedMouse = this.snapRoutingPoint(this.mouseWorld, lastPoint);

    ctx.strokeStyle = COLORS.routingPreview;
    ctx.lineWidth = (this.document.pcbLayout.defaultTraceWidth || 0.2) * 0.5;
    ctx.setLineDash([0.3, 0.2]);
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(snappedMouse.x, snappedMouse.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw snap points (small circles at vertices)
    for (const pt of points) {
      ctx.fillStyle = COLORS.routingActive;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 0.15, 0, Math.PI * 2);
      ctx.fill();
    }

    // Show net name at start
    if (this.document.pcbLayout.routingNetId) {
      ctx.fillStyle = COLORS.netIndicator;
      ctx.font = '0.8px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`Net: ${this.document.pcbLayout.routingNetId}`, points[0].x + 0.3, points[0].y - 0.3);
    }
  }

  private renderDragGhost(): void {
    if (!this.draggingComponentId || !this.document?.pcbLayout) return;

    const { ctx } = this;
    const comp = this.findPCBComponent(this.draggingComponentId);
    if (!comp) return;

    const fp = this.footprintMap.get(comp.footprintId);
    if (!fp) return;

    const snapped = this.snapToGrid(this.mouseWorld);

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.translate(snapped.x, snapped.y);

    const cy = fp.courtyard;
    ctx.strokeStyle = COLORS.selectionBorder;
    ctx.lineWidth = 0.1;
    ctx.setLineDash([0.3, 0.2]);
    ctx.strokeRect(cy.x, cy.y, cy.width, cy.height);
    ctx.setLineDash([]);

    for (const pad of fp.pads) {
      ctx.fillStyle = COLORS.ghost;
      ctx.save();
      ctx.translate(pad.x, pad.y);
      if (pad.rotation) ctx.rotate(pad.rotation * Math.PI / 180);

      switch (pad.shape) {
        case 'rect':
          ctx.fillRect(-pad.width / 2, -pad.height / 2, pad.width, pad.height);
          break;
        case 'circle': {
          const r = Math.max(pad.width, pad.height) / 2;
          ctx.beginPath();
          ctx.arc(0, 0, r, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'oval':
          this.drawOval(ctx, 0, 0, pad.width, pad.height);
          break;
      }
      ctx.restore();
    }

    const schematicComp = this.getSchematicComponent(comp.schematicComponentId);
    if (schematicComp) {
      ctx.fillStyle = COLORS.text;
      const fontSize = Math.max(0.6, Math.min(cy.width * 0.2, 1.2));
      ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(schematicComp.designator, cy.x + cy.width / 2, cy.y - 0.3);
    }

    ctx.restore();
  }

  private renderBoxSelection(): void {
    if (!this.isBoxSelecting) return;
    const { ctx } = this;
    const x = Math.min(this.boxSelectStart.x, this.boxSelectEnd.x);
    const y = Math.min(this.boxSelectStart.y, this.boxSelectEnd.y);
    const w = Math.abs(this.boxSelectEnd.x - this.boxSelectStart.x);
    const h = Math.abs(this.boxSelectEnd.y - this.boxSelectStart.y);

    ctx.fillStyle = COLORS.selection;
    ctx.fillRect(x, y, w, h);

    ctx.strokeStyle = COLORS.selectionBorder;
    ctx.lineWidth = 0.15 / this.transform.scale;
    ctx.setLineDash([0.6 / this.transform.scale, 0.4 / this.transform.scale]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  private renderHUD(_w: number, h: number): void {
    const { ctx } = this;
    const snapped = this.snapToGrid(this.mouseWorld);

    let toolText: string = this.activeTool;
    if (this.activeTool === 'route' && this.document?.pcbLayout?.routingNetId) {
      toolText = `route:${this.document.pcbLayout.routingNetId}`;
    }

    ctx.fillStyle = COLORS.textDim;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      `(${snapped.x.toFixed(2)}mm, ${snapped.y.toFixed(2)}mm)  zoom: ${this.getZoomPercent()}%  layer: ${this.activeLayer}  tool: ${toolText}`,
      10, h - 10,
    );
  }

  // ----- Helpers -----

  private getSchematicComponent(schematicComponentId: string) {
    if (!this.document) return null;
    for (const sheet of this.document.sheets) {
      const comp = sheet.components.find(c => c.id === schematicComponentId);
      if (comp) return comp;
    }
    return null;
  }
}
