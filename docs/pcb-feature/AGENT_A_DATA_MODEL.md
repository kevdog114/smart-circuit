# Agent A — PCB Data Model & Commands

## Objective
Add PCB Layout types to the core data model and create PCB-specific commands with undo/redo support. This is the foundation that all other streams depend on.

## Context
- The project is a circuit schematic editor at `/Users/klschaefer/dev-projects/smart-circuit`
- Read the existing data model: `client/src/core/types.ts`
- Read the existing command system: `client/src/core/document.ts` (especially `AddComponentCommand`, `MoveComponentCommand`, and `RotateComponentCommand` for patterns)
- Read the command stack: `client/src/core/command-stack.ts`
- The app uses TypeScript with Vite (client) and Express (server)
- Existing tests are in `client/src/core/__tests__/` using Vitest

## Deliverables

### 1. Extend `client/src/core/types.ts`

Add these types at the end, before the events section:

```typescript
// ----- PCB Layout Types -----

export type PCBLayer = 'F.Cu' | 'B.Cu' | 'In1.Cu' | 'In2.Cu' | 'F.SilkS' | 'B.SilkS' | 'Edge.Cuts';

export interface PadDefinition {
  id: string;
  pinId: string;         // Maps to PinDefinition.id in the schematic
  position: Point;       // Relative to footprint origin, in mm
  width: number;         // mm
  height: number;        // mm
  shape: 'rect' | 'circle' | 'oval';
  layer: PCBLayer;
  drill?: number;        // Through-hole drill diameter in mm
  rotation: number;
}

export interface FootprintDefinition {
  id: string;
  name: string;          // Package name (e.g. "SOIC-8", "0805")
  pads: PadDefinition[];
  silkscreen: SymbolGraphic[];  // Reuse existing SymbolGraphic type
  courtyard: BoundingBox;       // Bounding box in mm
}

export interface PCBBoard {
  width: number;          // mm
  height: number;         // mm
  layerCount: 2 | 4;
  gridSize: number;       // mm snap grid (default 0.254 = 10 mils)
}

export interface PCBComponent {
  id: string;
  schematicComponentId: string;  // Links to Component.id in the schematic
  footprintId: string;           // References FootprintDefinition.id
  position: Point;               // mm, board coordinates
  rotation: number;              // degrees
  layer: 'F.Cu' | 'B.Cu';
  isPlaced: boolean;             // false = still in the component drawer
}

export interface PCBTrace {
  id: string;
  netId: string;                 // Links to schematic Net.id
  layer: PCBLayer;
  width: number;                 // mm
  points: Point[];               // Polyline points in mm
}

export interface PCBVia {
  id: string;
  netId: string;
  position: Point;
  drill: number;
  outerDiameter: number;
  fromLayer: PCBLayer;
  toLayer: PCBLayer;
}

export interface PCBLayout {
  board: PCBBoard;
  components: PCBComponent[];
  traces: PCBTrace[];
  vias: PCBVia[];
  activeLayer: PCBLayer;
  layerVisibility: Record<PCBLayer, boolean>;
}
```

Extend `CircuitDocument`:
```diff
 export interface CircuitDocument {
   ...
   metadata: ProjectMetadata;
+  pcbLayout?: PCBLayout;
 }
```

Extend `EventType`:
```diff
 export type EventType =
   ...
   | 'export:requested'
+  | 'pcb:component:placed'
+  | 'pcb:component:moved'
+  | 'pcb:layer:changed'
+  | 'pcb:view:changed';
```

### 2. Create `client/src/core/pcb-document.ts`

Create the PCB document module with:

**Factory function:**
```typescript
export function createPCBLayout(
  width = 100, height = 80, layerCount: 2 | 4 = 2
): PCBLayout
```
- Returns a PCBLayout with default board, empty components/traces/vias
- `activeLayer` defaults to `'F.Cu'`
- `layerVisibility`: all layers visible by default

**Commands (follow the same pattern as `AddComponentCommand` etc.):**

1. **`PlacePCBComponentCommand`** — Places a component on the board
   - Constructor: `(schematicComponentId, footprintId, position, layer)`
   - Creates a new `PCBComponent` with `isPlaced: true`
   - Undo: removes it (or sets `isPlaced: false`)

2. **`MovePCBComponentCommand`** — Moves a placed component
   - Constructor: `(pcbComponentId, newPosition)`
   - Stores old position for undo

3. **`FlipPCBComponentCommand`** — Flips between F.Cu ↔ B.Cu
   - Constructor: `(pcbComponentId)`
   - Toggles the component's `layer`

4. **`InitializePCBFromSchematicCommand`** — Creates PCBComponent entries for all schematic components
   - Constructor: `(doc)` 
   - For each schematic component, creates an unplaced (`isPlaced: false`) PCBComponent
   - Used when the user first switches to PCB view

All commands must implement `execute(doc)` and `undo(doc)` matching the existing `Command` interface in `types.ts`.

### 3. Write tests in `client/src/core/__tests__/pcb-document.test.ts`

Test each command's execute and undo. Follow the patterns in `document.test.ts`.

## Important Notes
- Do NOT modify `canvas-renderer.ts`, `main.ts`, or any renderer files — those are other agents' responsibility
- Do NOT install any new packages
- Import the `generateId()` function from `./document` for ID generation
- Run tests with: `cd client && npx vitest run src/core/__tests__/pcb-document.test.ts`
