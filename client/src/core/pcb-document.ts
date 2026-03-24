import type {
  CircuitDocument, PCBLayout, PCBComponent, PCBLayer, Point
} from './types';
import { generateId } from './document';

// ----- PCB Layout Factory -----

const ALL_LAYERS: PCBLayer[] = [
  'F.Cu', 'B.Cu', 'In1.Cu', 'In2.Cu', 'F.SilkS', 'B.SilkS', 'Edge.Cuts'
];

export function createPCBLayout(
  width = 100, height = 80, layerCount: 2 | 4 = 2
): PCBLayout {
  const layerVisibility = {} as Record<PCBLayer, boolean>;
  for (const layer of ALL_LAYERS) {
    layerVisibility[layer] = true;
  }

  return {
    board: {
      width,
      height,
      layerCount,
      gridSize: 0.254,
    },
    components: [],
    traces: [],
    vias: [],
    activeLayer: 'F.Cu',
    layerVisibility,
  };
}

// ----- PCB Commands -----

/**
 * Places a component on the PCB board.
 */
export class PlacePCBComponentCommand {
  type = 'PLACE_PCB_COMPONENT';
  description: string;
  private componentId: string;
  private schematicComponentId: string;
  private footprintId: string;
  private position: Point;
  private layer: 'F.Cu' | 'B.Cu';

  constructor(
    schematicComponentId: string,
    footprintId: string,
    position: Point,
    layer: 'F.Cu' | 'B.Cu' = 'F.Cu'
  ) {
    this.schematicComponentId = schematicComponentId;
    this.footprintId = footprintId;
    this.position = position;
    this.layer = layer;
    this.componentId = generateId();
    this.description = `Place PCB component (${footprintId})`;
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    const component: PCBComponent = {
      id: this.componentId,
      schematicComponentId: this.schematicComponentId,
      footprintId: this.footprintId,
      position: { ...this.position },
      rotation: 0,
      layer: this.layer,
      isPlaced: true,
    };

    doc.pcbLayout.components.push(component);
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;
    doc.pcbLayout.components = doc.pcbLayout.components.filter(
      c => c.id !== this.componentId
    );
    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Moves a placed PCB component to a new position.
 */
export class MovePCBComponentCommand {
  type = 'MOVE_PCB_COMPONENT';
  description = 'Move PCB component';
  private pcbComponentId: string;
  private newPosition: Point;
  private oldPosition: Point | null = null;

  constructor(pcbComponentId: string, newPosition: Point) {
    this.pcbComponentId = pcbComponentId;
    this.newPosition = newPosition;
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;
    const comp = doc.pcbLayout.components.find(c => c.id === this.pcbComponentId);
    if (!comp) return;

    this.oldPosition = { ...comp.position };
    comp.position = { ...this.newPosition };
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout || !this.oldPosition) return;
    const comp = doc.pcbLayout.components.find(c => c.id === this.pcbComponentId);
    if (!comp) return;

    comp.position = { ...this.oldPosition };
    doc.updatedAt = new Date().toISOString();
  }
}

/**
 * Flips a PCB component between F.Cu and B.Cu layers.
 */
export class FlipPCBComponentCommand {
  type = 'FLIP_PCB_COMPONENT';
  description = 'Flip PCB component';
  private pcbComponentId: string;

  constructor(pcbComponentId: string) {
    this.pcbComponentId = pcbComponentId;
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;
    const comp = doc.pcbLayout.components.find(c => c.id === this.pcbComponentId);
    if (!comp) return;

    comp.layer = comp.layer === 'F.Cu' ? 'B.Cu' : 'F.Cu';
    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    // Flip is self-inverse: toggling again restores the original layer
    this.execute(doc);
  }
}

/**
 * Initializes PCBComponent entries for all schematic components.
 * Used when the user first switches to PCB view.
 */
export class InitializePCBFromSchematicCommand {
  type = 'INITIALIZE_PCB_FROM_SCHEMATIC';
  description = 'Initialize PCB from schematic';
  private addedComponentIds: string[] = [];

  constructor() {
    // No-arg constructor; reads schematic components at execute time
  }

  execute(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;

    this.addedComponentIds = [];

    for (const sheet of doc.sheets) {
      for (const comp of sheet.components) {
        // Skip if a PCBComponent already exists for this schematic component
        const existing = doc.pcbLayout.components.find(
          c => c.schematicComponentId === comp.id
        );
        if (existing) continue;

        const id = generateId();
        const pcbComp: PCBComponent = {
          id,
          schematicComponentId: comp.id,
          footprintId: comp.footprintId || '',
          position: { x: 0, y: 0 },
          rotation: 0,
          layer: 'F.Cu',
          isPlaced: false,
        };

        doc.pcbLayout.components.push(pcbComp);
        this.addedComponentIds.push(id);
      }
    }

    doc.updatedAt = new Date().toISOString();
  }

  undo(doc: CircuitDocument): void {
    if (!doc.pcbLayout) return;
    doc.pcbLayout.components = doc.pcbLayout.components.filter(
      c => !this.addedComponentIds.includes(c.id)
    );
    this.addedComponentIds = [];
    doc.updatedAt = new Date().toISOString();
  }
}
