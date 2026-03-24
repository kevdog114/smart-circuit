import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPCBLayout,
  PlacePCBComponentCommand,
  MovePCBComponentCommand,
  FlipPCBComponentCommand,
  InitializePCBFromSchematicCommand,
} from '../pcb-document';
import { createDocument, AddComponentCommand } from '../document';
import type { CircuitDocument, ComponentDefinition } from '../types';

// ---- Test Helpers ----

function makeComponentDef(prefix = 'R'): ComponentDefinition {
  return {
    id: 'lib-resistor',
    name: 'Resistor',
    description: 'Generic resistor',
    category: 'Passives',
    designatorPrefix: prefix,
    properties: {},
    tags: [],
    defaultValue: '10k',
    symbol: {
      id: 'sym-resistor',
      name: 'Resistor',
      width: 40,
      height: 20,
      origin: { x: 0, y: 0 },
      pins: [
        { id: 'pin1', name: '1', type: 'passive', position: { x: -20, y: 0 }, orientation: 'left', length: 10 },
        { id: 'pin2', name: '2', type: 'passive', position: { x: 20, y: 0 }, orientation: 'right', length: 10 },
      ],
      graphics: [],
      designatorPosition: { x: 0, y: -15 },
      valuePosition: { x: 0, y: 15 },
    },
  };
}

function createDocWithPCB(): CircuitDocument {
  const doc = createDocument('Test PCB');
  doc.pcbLayout = createPCBLayout();
  return doc;
}

// ---- createPCBLayout ----

describe('createPCBLayout', () => {
  it('returns a layout with default dimensions', () => {
    const layout = createPCBLayout();
    expect(layout.board.width).toBe(100);
    expect(layout.board.height).toBe(80);
    expect(layout.board.layerCount).toBe(2);
    expect(layout.board.gridSize).toBe(0.254);
  });

  it('accepts custom dimensions and layer count', () => {
    const layout = createPCBLayout(200, 150, 4);
    expect(layout.board.width).toBe(200);
    expect(layout.board.height).toBe(150);
    expect(layout.board.layerCount).toBe(4);
  });

  it('starts with empty component, trace, and via arrays', () => {
    const layout = createPCBLayout();
    expect(layout.components).toEqual([]);
    expect(layout.traces).toEqual([]);
    expect(layout.vias).toEqual([]);
  });

  it('defaults active layer to F.Cu', () => {
    const layout = createPCBLayout();
    expect(layout.activeLayer).toBe('F.Cu');
  });

  it('has all layers visible by default', () => {
    const layout = createPCBLayout();
    expect(layout.layerVisibility['F.Cu']).toBe(true);
    expect(layout.layerVisibility['B.Cu']).toBe(true);
    expect(layout.layerVisibility['In1.Cu']).toBe(true);
    expect(layout.layerVisibility['In2.Cu']).toBe(true);
    expect(layout.layerVisibility['F.SilkS']).toBe(true);
    expect(layout.layerVisibility['B.SilkS']).toBe(true);
    expect(layout.layerVisibility['Edge.Cuts']).toBe(true);
  });
});

// ---- PlacePCBComponentCommand ----

describe('PlacePCBComponentCommand', () => {
  let doc: CircuitDocument;

  beforeEach(() => {
    doc = createDocWithPCB();
  });

  it('execute adds a component to the PCB layout', () => {
    const cmd = new PlacePCBComponentCommand('sch-comp-1', 'fp-soic8', { x: 50, y: 30 }, 'F.Cu');
    cmd.execute(doc);

    expect(doc.pcbLayout!.components).toHaveLength(1);
    const comp = doc.pcbLayout!.components[0];
    expect(comp.schematicComponentId).toBe('sch-comp-1');
    expect(comp.footprintId).toBe('fp-soic8');
    expect(comp.position).toEqual({ x: 50, y: 30 });
    expect(comp.layer).toBe('F.Cu');
    expect(comp.isPlaced).toBe(true);
    expect(comp.rotation).toBe(0);
  });

  it('defaults to F.Cu layer', () => {
    const cmd = new PlacePCBComponentCommand('sch-comp-1', 'fp-0805', { x: 10, y: 10 });
    cmd.execute(doc);

    expect(doc.pcbLayout!.components[0].layer).toBe('F.Cu');
  });

  it('can place on B.Cu layer', () => {
    const cmd = new PlacePCBComponentCommand('sch-comp-1', 'fp-0805', { x: 10, y: 10 }, 'B.Cu');
    cmd.execute(doc);

    expect(doc.pcbLayout!.components[0].layer).toBe('B.Cu');
  });

  it('undo removes the placed component', () => {
    const cmd = new PlacePCBComponentCommand('sch-comp-1', 'fp-soic8', { x: 50, y: 30 });
    cmd.execute(doc);
    expect(doc.pcbLayout!.components).toHaveLength(1);

    cmd.undo(doc);
    expect(doc.pcbLayout!.components).toHaveLength(0);
  });

  it('multiple placements add multiple components', () => {
    const cmd1 = new PlacePCBComponentCommand('sch-1', 'fp-a', { x: 10, y: 10 });
    const cmd2 = new PlacePCBComponentCommand('sch-2', 'fp-b', { x: 50, y: 50 });
    cmd1.execute(doc);
    cmd2.execute(doc);

    expect(doc.pcbLayout!.components).toHaveLength(2);
  });
});

// ---- MovePCBComponentCommand ----

describe('MovePCBComponentCommand', () => {
  let doc: CircuitDocument;
  let compId: string;

  beforeEach(() => {
    doc = createDocWithPCB();
    const placeCmd = new PlacePCBComponentCommand('sch-1', 'fp-a', { x: 10, y: 20 });
    placeCmd.execute(doc);
    compId = doc.pcbLayout!.components[0].id;
  });

  it('execute updates the component position', () => {
    const cmd = new MovePCBComponentCommand(compId, { x: 50, y: 60 });
    cmd.execute(doc);

    const comp = doc.pcbLayout!.components[0];
    expect(comp.position).toEqual({ x: 50, y: 60 });
  });

  it('undo restores the original position', () => {
    const cmd = new MovePCBComponentCommand(compId, { x: 50, y: 60 });
    cmd.execute(doc);
    cmd.undo(doc);

    const comp = doc.pcbLayout!.components[0];
    expect(comp.position).toEqual({ x: 10, y: 20 });
  });

  it('supports sequential moves with undo', () => {
    const cmd1 = new MovePCBComponentCommand(compId, { x: 30, y: 40 });
    cmd1.execute(doc);
    const cmd2 = new MovePCBComponentCommand(compId, { x: 70, y: 80 });
    cmd2.execute(doc);

    expect(doc.pcbLayout!.components[0].position).toEqual({ x: 70, y: 80 });

    cmd2.undo(doc);
    expect(doc.pcbLayout!.components[0].position).toEqual({ x: 30, y: 40 });

    cmd1.undo(doc);
    expect(doc.pcbLayout!.components[0].position).toEqual({ x: 10, y: 20 });
  });
});

// ---- FlipPCBComponentCommand ----

describe('FlipPCBComponentCommand', () => {
  let doc: CircuitDocument;
  let compId: string;

  beforeEach(() => {
    doc = createDocWithPCB();
    const placeCmd = new PlacePCBComponentCommand('sch-1', 'fp-a', { x: 10, y: 20 }, 'F.Cu');
    placeCmd.execute(doc);
    compId = doc.pcbLayout!.components[0].id;
  });

  it('execute flips from F.Cu to B.Cu', () => {
    const cmd = new FlipPCBComponentCommand(compId);
    cmd.execute(doc);

    expect(doc.pcbLayout!.components[0].layer).toBe('B.Cu');
  });

  it('undo flips back to F.Cu', () => {
    const cmd = new FlipPCBComponentCommand(compId);
    cmd.execute(doc);
    cmd.undo(doc);

    expect(doc.pcbLayout!.components[0].layer).toBe('F.Cu');
  });

  it('double flip returns to original layer', () => {
    const cmd1 = new FlipPCBComponentCommand(compId);
    cmd1.execute(doc);
    expect(doc.pcbLayout!.components[0].layer).toBe('B.Cu');

    const cmd2 = new FlipPCBComponentCommand(compId);
    cmd2.execute(doc);
    expect(doc.pcbLayout!.components[0].layer).toBe('F.Cu');
  });

  it('flips B.Cu component to F.Cu', () => {
    // Place on B.Cu
    const placeCmd = new PlacePCBComponentCommand('sch-2', 'fp-b', { x: 30, y: 40 }, 'B.Cu');
    placeCmd.execute(doc);
    const bCuCompId = doc.pcbLayout!.components[1].id;

    const cmd = new FlipPCBComponentCommand(bCuCompId);
    cmd.execute(doc);

    expect(doc.pcbLayout!.components[1].layer).toBe('F.Cu');
  });
});

// ---- InitializePCBFromSchematicCommand ----

describe('InitializePCBFromSchematicCommand', () => {
  let doc: CircuitDocument;
  const def = makeComponentDef('R');

  beforeEach(() => {
    doc = createDocWithPCB();
  });

  it('creates PCBComponent entries for all schematic components', () => {
    const sheetId = doc.sheets[0].id;
    new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1').execute(doc);
    new AddComponentCommand(sheetId, def, { x: 300, y: 200 }, '22k', 'R2').execute(doc);

    const cmd = new InitializePCBFromSchematicCommand();
    cmd.execute(doc);

    expect(doc.pcbLayout!.components).toHaveLength(2);
    expect(doc.pcbLayout!.components[0].schematicComponentId).toBe(doc.sheets[0].components[0].id);
    expect(doc.pcbLayout!.components[1].schematicComponentId).toBe(doc.sheets[0].components[1].id);
  });

  it('all initialized components are unplaced', () => {
    const sheetId = doc.sheets[0].id;
    new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1').execute(doc);

    const cmd = new InitializePCBFromSchematicCommand();
    cmd.execute(doc);

    for (const comp of doc.pcbLayout!.components) {
      expect(comp.isPlaced).toBe(false);
    }
  });

  it('initialized components default to F.Cu layer with zero position', () => {
    const sheetId = doc.sheets[0].id;
    new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1').execute(doc);

    const cmd = new InitializePCBFromSchematicCommand();
    cmd.execute(doc);

    const comp = doc.pcbLayout!.components[0];
    expect(comp.layer).toBe('F.Cu');
    expect(comp.position).toEqual({ x: 0, y: 0 });
    expect(comp.rotation).toBe(0);
  });

  it('uses footprintId from schematic component if present', () => {
    const sheetId = doc.sheets[0].id;
    new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1').execute(doc);
    doc.sheets[0].components[0].footprintId = 'fp-0805';

    const cmd = new InitializePCBFromSchematicCommand();
    cmd.execute(doc);

    expect(doc.pcbLayout!.components[0].footprintId).toBe('fp-0805');
  });

  it('does not duplicate already-existing PCB components', () => {
    const sheetId = doc.sheets[0].id;
    new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1').execute(doc);

    const cmd1 = new InitializePCBFromSchematicCommand();
    cmd1.execute(doc);
    expect(doc.pcbLayout!.components).toHaveLength(1);

    // Add another schematic component afterward
    new AddComponentCommand(sheetId, def, { x: 300, y: 200 }, '22k', 'R2').execute(doc);

    // Initialize again — should only add the new one
    const cmd2 = new InitializePCBFromSchematicCommand();
    cmd2.execute(doc);
    expect(doc.pcbLayout!.components).toHaveLength(2);
  });

  it('undo removes the initialized components', () => {
    const sheetId = doc.sheets[0].id;
    new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1').execute(doc);
    new AddComponentCommand(sheetId, def, { x: 300, y: 200 }, '22k', 'R2').execute(doc);

    const cmd = new InitializePCBFromSchematicCommand();
    cmd.execute(doc);
    expect(doc.pcbLayout!.components).toHaveLength(2);

    cmd.undo(doc);
    expect(doc.pcbLayout!.components).toHaveLength(0);
  });

  it('undo only removes components it added', () => {
    const sheetId = doc.sheets[0].id;
    new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1').execute(doc);

    // Manually place a component first
    const placeCmd = new PlacePCBComponentCommand('manual-id', 'fp-manual', { x: 10, y: 10 });
    placeCmd.execute(doc);
    expect(doc.pcbLayout!.components).toHaveLength(1);

    // Initialize from schematic
    const cmd = new InitializePCBFromSchematicCommand();
    cmd.execute(doc);
    expect(doc.pcbLayout!.components).toHaveLength(2);

    cmd.undo(doc);
    // Only the manually placed one should remain
    expect(doc.pcbLayout!.components).toHaveLength(1);
    expect(doc.pcbLayout!.components[0].footprintId).toBe('fp-manual');
  });

  it('handles empty schematic gracefully', () => {
    const cmd = new InitializePCBFromSchematicCommand();
    cmd.execute(doc);

    expect(doc.pcbLayout!.components).toHaveLength(0);
  });
});
