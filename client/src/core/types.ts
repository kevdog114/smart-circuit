// ============================================================
// Smart Circuit — Core Data Model Types
// ============================================================

// ----- Geometry Primitives -----

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Polygon {
  points: Point[];
  closed: boolean;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

// ----- Circuit Document -----

export interface CircuitDocument {
  id: string;
  name: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  sheets: Sheet[];
  metadata: ProjectMetadata;
  pcbLayout?: PCBLayout;
  /** Imported component definitions that aren't in the built-in library */
  customLibrary?: ComponentDefinition[];
}

export interface ProjectMetadata {
  author: string;
  description: string;
  revision: string;
  tags: string[];
}

// ----- Sheet -----

export interface Sheet {
  id: string;
  name: string;
  components: Component[];
  wires: Wire[];
  nets: Net[];
  junctions: Junction[];
  labels: NetLabel[];
  annotations: Annotation[];
  gridSize: number;
  bounds: BoundingBox;
}

// ----- Component -----

export interface Component {
  id: string;
  libraryId: string;
  designator: string;
  value: string;
  position: Point;
  rotation: 0 | 90 | 180 | 270;
  mirror: boolean;
  pins: PinInstance[];
  properties: Record<string, string>;
  footprintId?: string;
}

// ----- Pins -----

export type PinType =
  | 'input'
  | 'output'
  | 'bidirectional'
  | 'passive'
  | 'power'
  | 'open_collector'
  | 'open_emitter'
  | 'unspecified';

export interface PinDefinition {
  id: string;
  name: string;
  type: PinType;
  position: Point;
  orientation: Direction;
  length: number;
}

export interface PinInstance {
  definitionId: string;
  componentId: string;
  absolutePosition: Point;
  netId: string | null;
}

// ----- Nets & Wires -----

export interface Net {
  id: string;
  name: string;
  pinIds: string[];
  wireIds: string[];
  color?: string;
  connectionMode?: 'auto' | 'wire' | 'label';
}

export interface Wire {
  id: string;
  netId: string;
  segments: WireSegment[];
  nodes?: WireNode[];
}

export interface WireSegment {
  start: Point;
  end: Point;
}

export interface WireNode {
  id: string;
  position: Point;
  wireId: string;
  segmentIndex: number; // node sits between segments[segmentIndex].end and segments[segmentIndex+1].start
}

// ----- Junction & Labels -----

export interface Junction {
  id: string;
  position: Point;
  netId: string;
}

export interface NetLabel {
  id: string;
  position: Point;
  netName: string;
  rotation: number;
}

// ----- Annotations -----

export interface Annotation {
  id: string;
  type: 'text' | 'rectangle' | 'line' | 'ellipse' | 'image';
  position: Point;
  properties: Record<string, unknown>;
}

// ----- Symbol Definition (Library) -----

export interface SymbolGraphic {
  type: 'line' | 'rect' | 'circle' | 'arc' | 'polyline' | 'polygon' | 'text';
  properties: Record<string, unknown>;
}

export interface SymbolDefinition {
  id: string;
  name: string;
  width: number;
  height: number;
  origin: Point;
  pins: PinDefinition[];
  graphics: SymbolGraphic[];
  designatorPosition: Point;
  valuePosition: Point;
}

// ----- Component Definition (Library) -----

export interface ComponentDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  symbol: SymbolDefinition;
  manufacturer?: string;
  mpn?: string;
  datasheet?: string;
  lcscPartNumber?: string;
  properties: Record<string, string>;
  tags: string[];
  defaultValue?: string;
  designatorPrefix: string;   // e.g. "R", "C", "U"
}

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
  /** Length of the trace in mm (computed) */
  length?: number;
  /** Associated differential pair partner trace ID */
  diffPairId?: string;
  /** Custom settings override */
  settings?: TraceSettings;
}

export interface TraceSettings {
  width: number;                 // mm
  clearance: number;             // mm keepout from other traces
  maxLength?: number;            // mm max allowed length
  minLength?: number;            // mm min allowed length
  impedance?: number;            // target impedance in Ohms
  preset?: 'signal' | 'power' | 'ground' | 'high-speed' | 'diff-pair' | 'custom';
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

export type PCBTool = 'select' | 'move' | 'route' | 'via' | 'delete' | 'pan';

export interface PCBLayout {
  board: PCBBoard;
  components: PCBComponent[];
  traces: PCBTrace[];
  vias: PCBVia[];
  activeLayer: PCBLayer;
  layerVisibility: Record<PCBLayer, boolean>;
  /** Current routing tool */
  activeTool?: PCBTool;
  /** Net being routed (when in route tool) */
  routingNetId?: string;
  /** In-progress trace points */
  routingPoints?: Point[];
  /** Default trace settings */
  defaultTraceWidth?: number;
  /** Snap to grid for routing */
  routingGridSize?: number;
}

// ----- Command System -----

export interface Command {
  type: string;
  description: string;
  execute(doc: CircuitDocument): void;
  undo(doc: CircuitDocument): void;
}

// ----- Events -----

export type EventType =
  | 'document:changed'
  | 'component:added'
  | 'component:removed'
  | 'component:moved'
  | 'component:selected'
  | 'component:deselected'
  | 'wire:added'
  | 'wire:removed'
  | 'net:changed'
  | 'sheet:changed'
  | 'tool:changed'
  | 'selection:changed'
  | 'undo'
  | 'redo'
  | 'export:requested'
  | 'pcb:component:placed'
  | 'pcb:component:moved'
  | 'pcb:layer:changed'
  | 'pcb:view:changed'
  | 'pcb:trace:added'
  | 'pcb:trace:removed'
  | 'pcb:trace:modified'
  | 'pcb:via:added'
  | 'pcb:via:removed'
  | 'pcb:tool:changed'
  | 'pcb:routing:start'
  | 'pcb:routing:end';

export interface AppEvent {
  type: EventType;
  payload?: unknown;
}
