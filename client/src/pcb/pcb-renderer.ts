// ============================================================
// Smart Circuit — PCB Canvas Renderer
// Renders board outline, pads, traces, components with
// multi-layer transparency on an HTML5 Canvas.
// ============================================================

import type { CircuitDocument, PCBComponent, PCBTrace, PCBLayer, Point } from '../core/types';
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
  // Scale factor: 1mm = how many canvas pixels at scale 1.0
  // We use 1mm = 1 world unit, then the view scale handles zoom.
  // At scale 4.0, 1mm = 4 screen pixels, which is a reasonable starting zoom.

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

  setFootprintMap(map: Map<string, FootprintDefinition>): void {
    this.footprintMap = map;
  }

  setActiveLayer(layer: PCBLayer): void {
    this.activeLayer = layer;
  }

  setLayerVisibility(layer: PCBLayer, visible: boolean): void {
    this.layerVisibility[layer] = visible;
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

  centerView(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    if (this.document?.pcbLayout) {
      const board = this.document.pcbLayout.board;
      // Fit board in view with some padding
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

  destroy(): void {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.resizeObserver?.disconnect();
    this.canvas.remove();
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
    // macOS trackpads appear as a single pointer so multi-touch pointer tracking
    // doesn't capture trackpad pinch — we still need GestureEvent for that.
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
      this.isBoxSelecting = false;
      this.dragOffset = { x: 0, y: 0 };
      return;
    }

    // If multitouch was just active, ignore stale single-pointer down events
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

    // Middle-click or shift+click → pan
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      this.isPanning = true;
      this.dragStart = { ...this.mouseScreen };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 0) {
      // Try to hit-test a component
      const hit = this.hitTestComponent(this.mouseWorld);
      if (hit) {
        if (!this.selectedPCBComponentIds.has(hit.id)) {
          // Not already in multi-selection — start fresh
          this.selectedPCBComponentIds.clear();
          this.selectedPCBComponentIds.add(hit.id);
        }
        this.selectedPCBComponentId = hit.id;
        this.isDragging = true;
        this.dragStart = this.snapToGrid(this.mouseWorld);
        this.dragOffset = { x: 0, y: 0 };

        // Notify about schematic component selection
        this.onComponentSelected?.(hit.schematicComponentId);
        return;
      }

      // Nothing hit → start box selection, deselect
      this.isBoxSelecting = true;
      this.boxSelectStart = { ...this.mouseWorld };
      this.boxSelectEnd = { ...this.mouseWorld };
      this.selectedPCBComponentIds.clear();
      this.selectedPCBComponentId = null;
      this.onComponentSelected?.(null);
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
        const newScale = Math.max(0.5, Math.min(50, this._pinchStartScale * ratio));
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

    if (this.isDragging && this.selectedPCBComponentId) {
      const snapped = this.snapToGrid(this.mouseWorld);
      this.dragOffset = {
        x: snapped.x - this.dragStart.x,
        y: snapped.y - this.dragStart.y,
      };
    }

    // Box selection — update end point
    if (this.isBoxSelecting) {
      this.boxSelectEnd = { ...this.mouseWorld };
      this.computeBoxSelection();
      return;
    }

    // Update cursor for drag-from-drawer
    if (this.draggingComponentId) {
      this.canvas.style.cursor = 'copy';
    }
  }

  private onPointerUp(e: PointerEvent): void {
    this.activePointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}

    // When all fingers are lifted after a multitouch gesture, clear the flag
    if (this._multiTouchActive) {
      if (this.activePointers.size < 2) {
        this._multiTouchActive = this.activePointers.size > 0;
        if (this.activePointers.size === 0) this._multiTouchActive = false;
      }
      return;
    }

    if (this.isPanning) {
      this.isPanning = false;
      this.canvas.style.cursor = 'crosshair';
      return;
    }

    // Box selection complete
    if (this.isBoxSelecting) {
      this.isBoxSelecting = false;
      this.computeBoxSelection();
      // Notify about first selected component
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
          // Multi-component drag
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
          // Single component drag
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

    // If a Safari gesture is active, skip — gesturechange handles zoom
    if (this._gestureActive) return;

    if (e.ctrlKey || e.metaKey) {
      // Pinch-to-zoom
      // Clamp deltaY to avoid extreme values from Safari trackpad gestures
      const clampedDeltaY = Math.max(-50, Math.min(50, e.deltaY));
      const zoomIntensity = 0.01;
      const zoomFactor = Math.exp(-clampedDeltaY * zoomIntensity);
      const oldScale = this.transform.scale;
      const newScale = Math.max(0.5, Math.min(50, oldScale * zoomFactor));

      // Guard against NaN/Infinity corrupting the transform
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
      // Two-finger scroll → pan
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
      this.draggingComponentId = null;
      this.selectedPCBComponentIds.clear();
      this.selectedPCBComponentId = null;
      this.onComponentSelected?.(null);
      this.canvas.style.cursor = 'crosshair';
    }

    // Delete/Backspace — unplace selected PCB components (does NOT delete from schematic)
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedPCBComponentIds.size > 0) {
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

      // Check if world point is within the courtyard (rotated)
      const cy = fp.courtyard;
      const hw = cy.width / 2;
      const hh = cy.height / 2;
      const cx = cy.x + cy.width / 2;
      const cyY = cy.y + cy.height / 2;

      // Transform world point to component-local space
      const dx = world.x - comp.position.x;
      const dy = world.y - comp.position.y;
      const rad = -(comp.rotation || 0) * Math.PI / 180;
      const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
      const localY = dx * Math.sin(rad) + dy * Math.cos(rad);

      if (
        localX >= cx - hw &&
        localX <= cx + hw &&
        localY >= cyY - hh &&
        localY <= cyY + hh
      ) {
        return comp;
      }
    }
    return null;
  }

  private findPCBComponent(id: string): PCBComponent | undefined {
    return this.document?.pcbLayout?.components.find(c => c.id === id);
  }

  /** Compute which PCB components fall inside the box-selection rectangle. */
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
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    // Clear
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    // Save & apply transform
    ctx.save();
    ctx.translate(this.transform.offsetX, this.transform.offsetY);
    ctx.scale(this.transform.scale, this.transform.scale);

    this.renderGrid(w, h);

    if (this.document?.pcbLayout) {
      const pcb = this.document.pcbLayout;

      // Board outline
      this.renderBoardOutline(pcb);

      // Render layers in order (bottom → top)
      for (const layer of LAYER_RENDER_ORDER) {
        if (!this.layerVisibility[layer]) continue;
        const opacity = layer === this.activeLayer ? 1.0 : 0.3;
        ctx.globalAlpha = opacity;

        // Traces on this layer
        this.renderTraces(pcb.traces, layer);

        // Components (pads) on this layer
        this.renderComponentsOnLayer(pcb.components, layer);

        ctx.globalAlpha = 1.0;
      }

      // Courtyard outlines (always visible at full opacity)
      this.renderCourtyards(pcb.components);

      // Selection / cross-highlights
      this.renderHighlights(pcb.components);
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

    // Adaptive grid: show different grid levels based on zoom
    // At low zoom, show 1mm grid; at higher zoom, show 0.254mm grid
    const effectiveGridMm = scale > 8 ? this.gridSizeMm : (scale > 3 ? this.gridSizeMm * 4 : 1.0);

    const startX = Math.floor(-this.transform.offsetX / scale / effectiveGridMm) * effectiveGridMm - effectiveGridMm;
    const startY = Math.floor(-this.transform.offsetY / scale / effectiveGridMm) * effectiveGridMm - effectiveGridMm;
    const endX = startX + viewW / scale + effectiveGridMm * 2;
    const endY = startY + viewH / scale + effectiveGridMm * 2;

    // Skip rendering if there would be too many dots
    const countX = (endX - startX) / effectiveGridMm;
    const countY = (endY - startY) / effectiveGridMm;
    if (countX * countY > 10000) return;

    ctx.fillStyle = COLORS.grid;
    for (let x = startX; x <= endX; x += effectiveGridMm) {
      for (let y = startY; y <= endY; y += effectiveGridMm) {
        // Major grid at 1mm intervals
        const isMajor = Math.abs(x % 1.0) < 0.01 && Math.abs(y % 1.0) < 0.01;
        const size = isMajor ? 0.15 : 0.08;
        ctx.fillStyle = isMajor ? COLORS.gridMajor : COLORS.grid;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }

    // Origin crosshair
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

      // Draw pads on this layer
      for (const pad of fp.pads) {
        if (pad.layer !== layer) continue;
        this.renderPad(pad, layer);
      }

      // Draw silkscreen on this layer
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

    // Drill hole for through-hole pads
    if (pad.drill && pad.drill > 0) {
      ctx.fillStyle = COLORS.drillHole;
      ctx.beginPath();
      ctx.arc(0, 0, pad.drill / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Pad number text
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
      // Horizontal oval
      ctx.arc(cx - hw + r, cy, r, Math.PI * 0.5, Math.PI * 1.5);
      ctx.arc(cx + hw - r, cy, r, Math.PI * 1.5, Math.PI * 0.5);
    } else {
      // Vertical oval
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
      if (silk.layer !== layer) continue;
      if (silk.points.length < 2) continue;

      ctx.strokeStyle = color;
      ctx.lineWidth = silk.strokeWidth || 0.12;
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

      // Designator text above courtyard
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

        // Filled selection tint
        ctx.fillStyle = COLORS.selection;
        ctx.fillRect(cy.x - pad, cy.y - pad, cy.width + pad * 2, cy.height + pad * 2);
      }

      if (isCrossHighlighted) {
        // Glowing outline
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

    // Draw ghost courtyard
    const cy = fp.courtyard;
    ctx.strokeStyle = COLORS.selectionBorder;
    ctx.lineWidth = 0.1;
    ctx.setLineDash([0.3, 0.2]);
    ctx.strokeRect(cy.x, cy.y, cy.width, cy.height);
    ctx.setLineDash([]);

    // Draw ghost pads
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

    // Ghost designator
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

    // Fill
    ctx.fillStyle = COLORS.selection;
    ctx.fillRect(x, y, w, h);

    // Border
    ctx.strokeStyle = COLORS.selectionBorder;
    ctx.lineWidth = 0.15 / this.transform.scale;
    ctx.setLineDash([0.6 / this.transform.scale, 0.4 / this.transform.scale]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  private renderHUD(_w: number, h: number): void {
    const { ctx } = this;
    const snapped = this.snapToGrid(this.mouseWorld);

    ctx.fillStyle = COLORS.textDim;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      `(${snapped.x.toFixed(2)}mm, ${snapped.y.toFixed(2)}mm)  zoom: ${this.getZoomPercent()}%  layer: ${this.activeLayer}`,
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
