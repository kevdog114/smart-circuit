# Smart Circuit — Data Model Specification

## Overview

The core data model represents electronic circuits as a graph of components, pins, nets, and wires. It is designed to be:
- **Serializable** — round-trips to JSON for persistence and export
- **Observable** — emits events on mutation for UI reactivity
- **Undoable** — every mutation is a command that can be reversed

---

## Core Types

### CircuitDocument

The top-level container. A project is one `CircuitDocument`.

```typescript
interface CircuitDocument {
  id: string;                    // UUID
  name: string;
  version: string;               // Semantic version of the file format
  createdAt: string;             // ISO 8601
  updatedAt: string;
  sheets: Sheet[];               // Multi-sheet schematics
  pcb?: PCBLayout;               // Optional PCB layout (stretch)
  metadata: ProjectMetadata;
}

interface ProjectMetadata {
  author: string;
  description: string;
  revision: string;
  tags: string[];
}
```

### Sheet (Schematic Page)

```typescript
interface Sheet {
  id: string;
  name: string;                  // e.g. "Power Supply", "MCU"
  components: Component[];
  wires: Wire[];
  nets: Net[];
  junctions: Junction[];
  labels: NetLabel[];
  annotations: Annotation[];     // Text, rectangles, etc.
  gridSize: number;              // Default 10 (mils)
  bounds: BoundingBox;
}
```

### Component

A placed instance of a library symbol.

```typescript
interface Component {
  id: string;                    // Unique within document
  libraryId: string;             // Reference to ComponentDefinition
  designator: string;            // e.g. "R1", "U3", "C14"
  value: string;                 // e.g. "10kΩ", "AMS1117-3.3"
  position: Point;               // Center point
  rotation: 0 | 90 | 180 | 270;
  mirror: boolean;
  pins: PinInstance[];           // Resolved from library + transforms
  properties: Record<string, string>;  // Arbitrary KV pairs
  footprintId?: string;         // Override library default footprint
}
```

### Pin & PinInstance

```typescript
// Defined in the library
interface PinDefinition {
  id: string;                    // e.g. "1", "VIN", "GND"
  name: string;                  // Display name
  type: PinType;                 // input | output | passive | power | ...
  position: Point;               // Relative to symbol origin
  orientation: Direction;        // up | down | left | right
  length: number;
}

// Resolved instance on a placed component
interface PinInstance {
  definitionId: string;
  componentId: string;
  absolutePosition: Point;       // Computed from component transform
  netId: string | null;          // Which net this pin is connected to
}

type PinType =
  | 'input'
  | 'output'
  | 'bidirectional'
  | 'passive'
  | 'power'
  | 'open_collector'
  | 'open_emitter'
  | 'unspecified';
```

### Net & Wire

```typescript
interface Net {
  id: string;
  name: string;                  // e.g. "+3V3", "GND", "SDA"
  pinIds: string[];              // References to PinInstance IDs
  wireIds: string[];             // Wires forming this net
  color?: string;                // Optional visual override
}

interface Wire {
  id: string;
  netId: string;
  segments: WireSegment[];
}

interface WireSegment {
  start: Point;
  end: Point;
}
```

### Junction & NetLabel

```typescript
interface Junction {
  id: string;
  position: Point;
  netId: string;
}

interface NetLabel {
  id: string;
  position: Point;
  netName: string;               // Creates or references a named net
  rotation: number;
}
```

### Annotation

Free-form drawing elements that aren't electrically significant.

```typescript
interface Annotation {
  id: string;
  type: 'text' | 'rectangle' | 'line' | 'ellipse' | 'image';
  position: Point;
  properties: Record<string, any>;  // Type-specific: text content, dimensions, color, etc.
}
```

---

## PCB Types (Stretch Goal)

### PCBLayout

```typescript
interface PCBLayout {
  id: string;
  boardOutline: Polygon;
  layers: LayerStack;
  footprints: FootprintInstance[];
  traces: Trace[];
  vias: Via[];
  zones: CopperZone[];
  designRules: DesignRules;
}

interface LayerStack {
  layers: Layer[];
}

interface Layer {
  id: string;
  name: string;                  // e.g. "F.Cu", "B.Cu", "F.SilkS"
  type: 'copper' | 'silk' | 'mask' | 'paste' | 'courtyard' | 'edge';
  visible: boolean;
  color: string;
}
```

### FootprintInstance

```typescript
interface FootprintInstance {
  id: string;
  libraryId: string;            // Reference to FootprintDefinition
  componentId: string;          // Back-reference to schematic Component
  position: Point;
  rotation: number;             // Degrees
  layer: 'front' | 'back';
  pads: PadInstance[];
  locked: boolean;
}
```

### Trace, Via, CopperZone

```typescript
interface Trace {
  id: string;
  netId: string;
  layer: string;
  width: number;
  segments: TraceSegment[];
}

interface TraceSegment {
  start: Point;
  end: Point;
  type: 'straight' | 'arc';
  // Arc-specific
  center?: Point;
  radius?: number;
}

interface Via {
  id: string;
  netId: string;
  position: Point;
  drill: number;
  outerDiameter: number;
  startLayer: string;
  endLayer: string;
}

interface CopperZone {
  id: string;
  netId: string;
  layer: string;
  outline: Polygon;
  fillStyle: 'solid' | 'hatched';
  clearance: number;
}
```

---

## Geometry Primitives

```typescript
interface Point {
  x: number;  // mils (1 mil = 0.001 inch = 0.0254 mm)
  y: number;
}

interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Polygon {
  points: Point[];
  closed: boolean;
}

type Direction = 'up' | 'down' | 'left' | 'right';
```

---

## Design Rules

```typescript
interface DesignRules {
  minTraceWidth: number;
  minClearance: number;
  minViaDrill: number;
  minViaOuter: number;
  defaultTraceWidth: number;
  defaultViaDrill: number;
  defaultViaOuter: number;
}
```

---

## Command System (Undo / Redo)

All mutations go through commands:

```typescript
interface Command {
  type: string;                // e.g. 'ADD_COMPONENT', 'MOVE_COMPONENT', 'ADD_WIRE'
  payload: any;
  execute(doc: CircuitDocument): void;
  undo(doc: CircuitDocument): void;
}
```

| Command | Payload | Side Effects |
|---------|---------|-------------|
| `ADD_COMPONENT` | `{ component, sheetId }` | Adds to sheet, assigns designator |
| `DELETE_COMPONENT` | `{ componentId }` | Removes component, disconnects nets |
| `MOVE_COMPONENT` | `{ componentId, newPosition }` | Updates position, recalculates pins |
| `ADD_WIRE` | `{ wire, sheetId }` | Adds wire, auto-joins nets |
| `DELETE_WIRE` | `{ wireId }` | Removes wire, may split net |
| `SET_VALUE` | `{ componentId, key, value }` | Updates component property |
| `RENAME_NET` | `{ netId, name }` | Updates net name |
| `ADD_SHEET` | `{ sheet }` | Adds new schematic sheet |

---

## Serialization

The `CircuitDocument` serializes to/from JSON:

```json
{
  "id": "abc-123",
  "name": "Audio Matrix",
  "version": "1.0.0",
  "sheets": [ ... ],
  "pcb": null,
  "metadata": {
    "author": "klschaefer",
    "description": "8-channel audio matrix mixer",
    "revision": "A",
    "tags": ["audio", "matrix"]
  }
}
```

File extension: `.smartcircuit` (just JSON with this extension).

## Units

- **Schematic**: mils (thousandths of an inch). 1 grid unit = 10 mils by default.
- **PCB**: millimeters. Standard for modern PCB design.
- Conversion: `1 mil = 0.0254 mm`
