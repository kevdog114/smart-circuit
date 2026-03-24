# Agent C — PCB Canvas Renderer & Component Drawer

## Objective
Build the PCB Layout canvas renderer and component drawer panel. This is the core visual component — a canvas that renders the PCB board, pads, traces, and components, with drag-and-drop placement from a drawer.

## Prerequisites
- **Agent A** must complete first: you need `PCBLayout`, `PCBComponent`, `FootprintDefinition`, `PadDefinition`, `PCBLayer` types from `client/src/core/types.ts`
- **Agent B** must complete first: you need `FootprintLibrary` from `client/src/library/footprint-library.ts`
- Read Agent A's output: `client/src/core/pcb-document.ts` for PCB commands

## Context
- Study the existing schematic renderer: `client/src/schematic/canvas-renderer.ts` (~1100 lines). Use it as a pattern for structure, event handling, view transforms, and rendering approach.
- The schematic renderer uses HTML5 Canvas with a render loop, view transform (pan/zoom), and grid rendering
- The PCB renderer will follow the same structure but render PCB-specific elements (board outline, pads, traces, silkscreen)

## Deliverables

### 1. Create `client/src/pcb/pcb-renderer.ts`

A canvas-based PCB renderer class. Use the same architectural patterns as `SchematicRenderer`.

**Constructor:** Takes a container HTMLElement, creates a canvas, sets up events and render loop.

**PCB Layer Colors:**
```typescript
const PCB_COLORS: Record<PCBLayer, string> = {
  'F.Cu': '#e54545',     // red
  'B.Cu': '#4545e5',     // blue
  'In1.Cu': '#e5e545',   // yellow
  'In2.Cu': '#45e545',   // green
  'F.SilkS': '#e5e5e5',  // white
  'B.SilkS': '#e5e5e5',  // white
  'Edge.Cuts': '#e5e545', // yellow
};
```

**View Transform:** Same as schematic — offsetX, offsetY, scale. Support pan (scroll/drag), zoom (pinch/scroll).

**Rendering layers (in order, bottom to top):**
1. Background (dark, similar to schematic `#1a1a2e` but slightly different `#1a1e2e`)
2. Grid (mm-based, dots or lines)
3. Board outline (yellow `Edge.Cuts` rectangle)
4. Back copper layer (B.Cu) — traces and pads
5. Inner layers (if 4-layer)
6. Front copper layer (F.Cu) — traces and pads
7. Silkscreen overlay
8. Component courtyard outlines
9. Selection highlights / cross-highlights

**Opacity rules:**
- Active layer: 100% opacity
- Other visible layers: 30% opacity
- Hidden layers: not rendered

**Rendering components:**
For each `PCBComponent` that has `isPlaced: true`:
1. Look up its `FootprintDefinition` from the footprint map
2. Apply position + rotation transform
3. Draw each pad:
   - Filled rectangle/circle/oval in the layer's color
   - Drill hole as dark circle inside if through-hole
   - Pad number text
4. Draw silkscreen graphics
5. Draw courtyard outline (dashed)

**Interaction:**
- **Select:** Click on a component to select it. Show selection outline.
- **Drag:** Click and drag to reposition placed components (grid-snap in mm).
- **Cross-highlight:** When `highlightComponent(schematicId)` is called, find the matching `PCBComponent` and render it with a glowing outline.
- **Drag from drawer:** When `startDraggingComponent(componentId)` is called, render a ghost footprint following the cursor until click places it.
- **Pan/zoom:** Same wheel/scroll behavior as schematic renderer.

**Public API:**
```typescript
export class PCBRenderer {
  constructor(container: HTMLElement);

  setDocument(doc: CircuitDocument): void;
  setFootprintMap(map: Map<string, FootprintDefinition>): void;
  setActiveLayer(layer: PCBLayer): void;
  setLayerVisibility(layer: PCBLayer, visible: boolean): void;
  highlightComponent(schematicComponentId: string | null): void;
  startDraggingComponent(pcbComponentId: string): void;
  getSelectedPCBComponentId(): string | null;
  centerView(): void;
  zoomIn(): void;
  zoomOut(): void;
  getZoomPercent(): number;
  destroy(): void;  // Stop render loop, remove event listeners

  // Callbacks
  onComponentPlaced: ((pcbComponentId: string, position: Point) => void) | null;
  onComponentMoved: ((pcbComponentId: string, position: Point) => void) | null;
  onComponentSelected: ((schematicComponentId: string | null) => void) | null;
}
```

### 2. Create `client/src/pcb/component-drawer.ts`

A DOM-based side panel that lists components that need to be placed on the PCB.

```typescript
export class ComponentDrawer {
  constructor(container: HTMLElement);

  /** Update the drawer based on current document state */
  update(doc: CircuitDocument, libraryMap: Map<string, ComponentDefinition>): void;

  /** Callback when user starts dragging a component from the drawer */
  onDragStart: ((pcbComponentId: string, schematicComponentId: string) => void) | null;
}
```

**UI for each unplaced component:**
- Designator (e.g. "R1")
- Value (e.g. "10kΩ")  
- Package name (e.g. "0805") if available from component properties
- Small footprint preview (optional, can be a simple icon)
- Draggable (HTML5 drag and drop or mousedown-based)

**Behavior:**
- Lists only `PCBComponent` entries where `isPlaced === false`
- Groups by component type (resistors, capacitors, ICs)
- When a component is placed (via PCB renderer), call `update()` to remove it from the list
- Style to match the existing sidebar panels (see `.library-panel` in `style.css`)

### 3. Create `client/src/pcb/index.ts`

Barrel export:
```typescript
export { PCBRenderer } from './pcb-renderer';
export { ComponentDrawer } from './component-drawer';
```

## Important Notes
- Do NOT modify `main.ts`, `style.css`, or the schematic renderer — Agent D handles UI integration
- Do NOT modify server files — Agent B handles that
- Import types from `../core/types` — they should be available from Agent A's work
- If Agent A's types aren't available yet, define local interfaces with `// TODO: import from types.ts` comments
- Use mm as the coordinate system for the PCB (not pixels or mils)
- The grid should default to 0.254mm (10 mils) which is standard for PCB layout
- Board origin (0,0) should be at top-left corner of the board outline
