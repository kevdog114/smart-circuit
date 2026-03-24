import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDocument,
  createSheet,
  nextDesignator,
  AddComponentCommand,
  MoveComponentCommand,
  RotateComponentCommand,
  DeleteComponentCommand,
  DeleteWireCommand,
  AddWireCommand,
  AddWireNodeCommand,
  MoveWireNodeCommand,
  DeleteWireNodeCommand,
  AddSubcircuitCommand,
  serializeDocument,
  deserializeDocument,
} from '../document';
import type { ComponentDefinition, CircuitDocument, WireSegment } from '../types';

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

// ---- createDocument ----

describe('createDocument', () => {
  it('returns a valid document structure', () => {
    const doc = createDocument('Test Project');
    expect(doc.id).toBeTruthy();
    expect(doc.name).toBe('Test Project');
    expect(doc.version).toBe('1.0.0');
    expect(doc.createdAt).toBeTruthy();
    expect(doc.updatedAt).toBeTruthy();
    expect(doc.sheets).toHaveLength(1);
    expect(doc.sheets[0].name).toBe('Main');
    expect(doc.metadata).toEqual({
      author: '',
      description: '',
      revision: 'A',
      tags: [],
    });
  });

  it('defaults name to Untitled', () => {
    const doc = createDocument();
    expect(doc.name).toBe('Untitled');
  });
});

// ---- createSheet ----

describe('createSheet', () => {
  it('returns sheet with correct defaults', () => {
    const sheet = createSheet('Sheet2');
    expect(sheet.id).toBeTruthy();
    expect(sheet.name).toBe('Sheet2');
    expect(sheet.components).toEqual([]);
    expect(sheet.wires).toEqual([]);
    expect(sheet.nets).toEqual([]);
    expect(sheet.junctions).toEqual([]);
    expect(sheet.labels).toEqual([]);
    expect(sheet.annotations).toEqual([]);
    expect(sheet.gridSize).toBe(10);
    expect(sheet.bounds).toEqual({ minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 });
  });
});

// ---- nextDesignator ----

describe('nextDesignator', () => {
  it('returns R1 for an empty document', () => {
    const doc = createDocument();
    expect(nextDesignator(doc, 'R')).toBe('R1');
  });

  it('generates sequential designators R1, R2, R3', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0];
    const def = makeComponentDef('R');

    // Simulate adding components by directly pushing (designator only matters)
    sheet.components.push({ id: '1', libraryId: def.id, designator: 'R1', value: '10k', position: { x: 0, y: 0 }, rotation: 0, mirror: false, pins: [], properties: {} });
    expect(nextDesignator(doc, 'R')).toBe('R2');

    sheet.components.push({ id: '2', libraryId: def.id, designator: 'R2', value: '22k', position: { x: 0, y: 0 }, rotation: 0, mirror: false, pins: [], properties: {} });
    expect(nextDesignator(doc, 'R')).toBe('R3');
  });

  it('ignores components with different prefixes', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0];
    sheet.components.push({ id: '1', libraryId: '', designator: 'C1', value: '100nF', position: { x: 0, y: 0 }, rotation: 0, mirror: false, pins: [], properties: {} });
    sheet.components.push({ id: '2', libraryId: '', designator: 'C2', value: '10uF', position: { x: 0, y: 0 }, rotation: 0, mirror: false, pins: [], properties: {} });
    expect(nextDesignator(doc, 'R')).toBe('R1');
  });
});

// ---- AddComponentCommand ----

describe('AddComponentCommand', () => {
  let doc: CircuitDocument;
  const def = makeComponentDef('R');

  beforeEach(() => {
    doc = createDocument();
  });

  it('execute adds a component to the sheet', () => {
    const sheetId = doc.sheets[0].id;
    const cmd = new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1');
    cmd.execute(doc);

    const sheet = doc.sheets[0];
    expect(sheet.components).toHaveLength(1);
    const comp = sheet.components[0];
    expect(comp.designator).toBe('R1');
    expect(comp.value).toBe('10k');
    expect(comp.position).toEqual({ x: 100, y: 200 });
    expect(comp.pins).toHaveLength(2);
    // Pin absolute positions should be offset from the component position
    expect(comp.pins[0].absolutePosition).toEqual({ x: 80, y: 200 });
    expect(comp.pins[1].absolutePosition).toEqual({ x: 120, y: 200 });
  });

  it('undo removes the added component', () => {
    const sheetId = doc.sheets[0].id;
    const cmd = new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1');
    cmd.execute(doc);
    expect(doc.sheets[0].components).toHaveLength(1);

    cmd.undo(doc);
    expect(doc.sheets[0].components).toHaveLength(0);
  });
});

// ---- MoveComponentCommand ----

describe('MoveComponentCommand', () => {
  let doc: CircuitDocument;
  const def = makeComponentDef('R');

  beforeEach(() => {
    doc = createDocument();
    const sheetId = doc.sheets[0].id;
    const addCmd = new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1');
    addCmd.execute(doc);
  });

  it('execute updates component and pin positions', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    const cmd = new MoveComponentCommand(sheet.id, comp.id, { x: 300, y: 400 });
    cmd.execute(doc);

    expect(comp.position).toEqual({ x: 300, y: 400 });
    // Pins should move by the same delta (+200, +200)
    expect(comp.pins[0].absolutePosition).toEqual({ x: 280, y: 400 });
    expect(comp.pins[1].absolutePosition).toEqual({ x: 320, y: 400 });
  });

  it('undo restores original position and pin positions', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    const cmd = new MoveComponentCommand(sheet.id, comp.id, { x: 300, y: 400 });
    cmd.execute(doc);
    cmd.undo(doc);

    expect(comp.position).toEqual({ x: 100, y: 200 });
    expect(comp.pins[0].absolutePosition).toEqual({ x: 80, y: 200 });
    expect(comp.pins[1].absolutePosition).toEqual({ x: 120, y: 200 });
  });

  it('execute also moves connected wire endpoints', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    // Add a wire whose start matches pin1 (80,200) and end matches pin2 (120,200)
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 80, y: 200 }, end: { x: 120, y: 200 } },
    ]);
    addWire.execute(doc);

    const cmd = new MoveComponentCommand(sheet.id, comp.id, { x: 300, y: 400 });
    cmd.execute(doc);

    // Wire endpoints should have shifted by (+200, +200)
    const wire = sheet.wires[0];
    expect(wire.segments[0].start).toEqual({ x: 280, y: 400 });
    expect(wire.segments[wire.segments.length - 1].end).toEqual({ x: 320, y: 400 });
  });

  it('undo restores wire endpoints', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 80, y: 200 }, end: { x: 120, y: 200 } },
    ]);
    addWire.execute(doc);

    const cmd = new MoveComponentCommand(sheet.id, comp.id, { x: 300, y: 400 });
    cmd.execute(doc);
    cmd.undo(doc);

    const wire = sheet.wires[0];
    expect(wire.segments[0].start).toEqual({ x: 80, y: 200 });
    expect(wire.segments[0].end).toEqual({ x: 120, y: 200 });
  });

  it('morphs net labels back to wire when moved close', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0]; // R1 at 100, 200, pins at 80,200 and 120,200

    // Add a second component R2 to ensure obstacles are correctly excluded
    const c2Cmd = new AddComponentCommand(sheet.id, def, { x: 300, y: 200 }, '10k', 'R2');
    c2Cmd.execute(doc);
    const r2 = sheet.components.find(c => c.designator === 'R2')!; // pins at 280,200 and 320,200
    
    // Explicitly add 2 net labels matching R1 pin 2 (120, 200) and R2 pin 1 (280, 200)
    sheet.labels.push({ id: 'L1', position: { x: 120, y: 200 }, netName: 'NET_MORPH', rotation: 0 });
    sheet.labels.push({ id: 'L2', position: { x: 280, y: 200 }, netName: 'NET_MORPH', rotation: 180 });
    
    // Define the net locally so p.netId resolves
    const net = { id: 'morph_net', name: 'NET_MORPH', pinIds: [`${comp.id}:pin2`, `${r2.id}:pin1`], wireIds: [] };
    sheet.nets.push(net);
    comp.pins[1].netId = 'morph_net';
    r2.pins[0].netId = 'morph_net';

    // Move R1 close to R2 (R1 goes from X=100 to X=160, pin 2 moves from X=120 to X=180)
    // Distance from R1 pin 2 (180, 200) to R2 pin 1 (280, 200) is 100
    const cmd = new MoveComponentCommand(sheet.id, comp.id, { x: 160, y: 200 });
    cmd.execute(doc);
    
    expect(sheet.labels.find(l => l.netName === 'NET_MORPH')).toBeUndefined();
    const newWire = sheet.wires.find(w => w.netId === 'morph_net');
    expect(newWire).toBeDefined();
    expect(newWire!.segments[newWire!.segments.length - 1].end).toEqual({ x: 280, y: 200 });
  });

  it('round-trip: wire → labels (far) → wire (close)', () => {
    const sheet = doc.sheets[0];
    const r1 = sheet.components[0]; // R1 at (100, 200), pins at (80,200) and (120,200)

    // Add R2
    const c2Cmd = new AddComponentCommand(sheet.id, def, { x: 200, y: 200 }, '10k', 'R2');
    c2Cmd.execute(doc);
    sheet.components.find(c => c.designator === 'R2')!;

    // Draw a wire from R1 pin2 (120,200) to R2 pin1 (180,200)
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 120, y: 200 }, end: { x: 180, y: 200 } },
    ]);
    addWire.execute(doc);

    sheet.wires[0].id;
    expect(sheet.wires).toHaveLength(1);
    expect(sheet.labels).toHaveLength(0);

    // Move R1 far away (pin2 goes from 120→1120, manhattan from 1120 to 180 = 940 > 400 threshold)
    const moveFar = new MoveComponentCommand(sheet.id, r1.id, { x: 1100, y: 200 });
    moveFar.execute(doc);

    // Wire should have been morphed to labels
    expect(sheet.wires).toHaveLength(0);
    expect(sheet.labels.length).toBeGreaterThanOrEqual(2);
    const labelNetName = sheet.labels[0].netName;
    expect(sheet.labels.filter(l => l.netName === labelNetName)).toHaveLength(2);

    // Move R1 back close to R2 (pin2 goes from 1120 → 220)
    const moveClose = new MoveComponentCommand(sheet.id, r1.id, { x: 200, y: 200 });
    moveClose.execute(doc);

    // Labels should have been morphed back to a wire
    expect(sheet.labels.filter(l => l.netName === labelNetName)).toHaveLength(0);
    expect(sheet.wires).toHaveLength(1);
  });

  it('does not move unconnected wire endpoints', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    // Wire that doesn't touch any pin
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 500, y: 500 }, end: { x: 600, y: 500 } },
    ]);
    addWire.execute(doc);

    const cmd = new MoveComponentCommand(sheet.id, comp.id, { x: 300, y: 400 });
    cmd.execute(doc);

    const wire = sheet.wires[0];
    expect(wire.segments[0].start).toEqual({ x: 500, y: 500 });
    expect(wire.segments[0].end).toEqual({ x: 600, y: 500 });
  });
});

// ---- DeleteComponentCommand ----

describe('DeleteComponentCommand', () => {
  let doc: CircuitDocument;
  const def = makeComponentDef('R');

  beforeEach(() => {
    doc = createDocument();
    const sheetId = doc.sheets[0].id;
    const addCmd = new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1');
    addCmd.execute(doc);
  });

  it('execute removes the component', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    const cmd = new DeleteComponentCommand(sheet.id, comp.id);
    cmd.execute(doc);

    expect(sheet.components).toHaveLength(0);
  });

  it('undo restores the deleted component', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    const origDesignator = comp.designator;
    const cmd = new DeleteComponentCommand(sheet.id, comp.id);
    cmd.execute(doc);
    cmd.undo(doc);

    expect(sheet.components).toHaveLength(1);
    expect(sheet.components[0].designator).toBe(origDesignator);
  });
});

// ---- AddWireCommand ----

describe('AddWireCommand', () => {
  let doc: CircuitDocument;

  beforeEach(() => {
    doc = createDocument();
  });

  it('execute adds a wire and creates a net', () => {
    const sheetId = doc.sheets[0].id;
    const segments: WireSegment[] = [
      { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
    ];
    const cmd = new AddWireCommand(sheetId, segments);
    cmd.execute(doc);

    const sheet = doc.sheets[0];
    expect(sheet.wires).toHaveLength(1);
    expect(sheet.nets).toHaveLength(1);
    expect(sheet.nets[0].wireIds).toContain(sheet.wires[0].id);
    expect(sheet.wires[0].segments).toEqual(segments);
  });

  it('undo removes the wire and the empty net', () => {
    const sheetId = doc.sheets[0].id;
    const segments: WireSegment[] = [
      { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
    ];
    const cmd = new AddWireCommand(sheetId, segments);
    cmd.execute(doc);
    cmd.undo(doc);

    const sheet = doc.sheets[0];
    expect(sheet.wires).toHaveLength(0);
    expect(sheet.nets).toHaveLength(0);
  });
});

// ---- Serialization Round-trip ----

describe('serialization round-trip', () => {
  it('preserves the document through serialize → deserialize', () => {
    const doc = createDocument('RoundTrip');
    const sheet = doc.sheets[0];
    const def = makeComponentDef('R');

    // Add a component and a wire to make it non-trivial
    const addComp = new AddComponentCommand(sheet.id, def, { x: 50, y: 60 }, '4.7k', 'R1');
    addComp.execute(doc);

    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
      { start: { x: 100, y: 0 }, end: { x: 100, y: 100 } },
    ]);
    addWire.execute(doc);

    const json = serializeDocument(doc);
    const restored = deserializeDocument(json);

    expect(restored).toEqual(doc);
  });
});

// ---- AddSubcircuitCommand ----

describe('AddSubcircuitCommand', () => {
  let doc: CircuitDocument;
  const resDef = makeComponentDef('R');

  function makeCapDef(): ComponentDefinition {
    return {
      id: 'lib-cap',
      name: 'Capacitor',
      description: 'Generic capacitor',
      category: 'Passives',
      designatorPrefix: 'C',
      properties: {},
      tags: [],
      defaultValue: '100nF',
      symbol: {
        id: 'sym-cap',
        name: 'Capacitor',
        width: 30,
        height: 40,
        origin: { x: 0, y: 0 },
        pins: [
          { id: 'pin1', name: '1', type: 'passive', position: { x: 0, y: -20 }, orientation: 'up', length: 10 },
          { id: 'pin2', name: '2', type: 'passive', position: { x: 0, y: 20 }, orientation: 'down', length: 10 },
        ],
        graphics: [],
        designatorPosition: { x: 0, y: -20 },
        valuePosition: { x: 0, y: 25 },
      },
    };
  }

  beforeEach(() => {
    doc = createDocument();
  });

  it('places components and creates wires with nets', () => {
    const sheet = doc.sheets[0];
    const capDef = makeCapDef();

    const cmd = new AddSubcircuitCommand(
      sheet.id,
      [
        { def: resDef, position: { x: 100, y: 100 }, value: '10k', designator: 'R1' },
        { def: capDef, position: { x: 200, y: 100 }, value: '100nF', designator: 'C1' },
      ],
      [
        { fromDesignator: 'R1', fromPin: '2', toDesignator: 'C1', toPin: '1', netName: 'NET_RC' },
      ]
    );
    cmd.execute(doc);

    // 2 components placed
    expect(sheet.components).toHaveLength(2);
    expect(sheet.components[0].designator).toBe('R1');
    expect(sheet.components[1].designator).toBe('C1');

    // 1 wire created
    expect(sheet.wires).toHaveLength(1);

    // 1 net created
    expect(sheet.nets).toHaveLength(1);
    expect(sheet.nets[0].name).toBe('NET_RC');
    expect(sheet.nets[0].wireIds).toHaveLength(1);
    expect(sheet.nets[0].pinIds).toHaveLength(2);

    // Pins have netId assigned
    const r1Pin2 = sheet.components[0].pins.find(p => p.definitionId === 'pin2');
    const c1Pin1 = sheet.components[1].pins.find(p => p.definitionId === 'pin1');
    expect(r1Pin2?.netId).toBe(sheet.nets[0].id);
    expect(c1Pin1?.netId).toBe(sheet.nets[0].id);

    // Wire path starts at R1-pin2 and ends at C1-pin1 (may be multi-segment for orthogonal routing)
    const wire = sheet.wires[0];
    expect(wire.segments.length).toBeGreaterThanOrEqual(1);
    expect(wire.segments[0].start).toEqual(r1Pin2!.absolutePosition);
    expect(wire.segments[wire.segments.length - 1].end).toEqual(c1Pin1!.absolutePosition);
    // All segments should be orthogonal (horizontal or vertical)
    for (const seg of wire.segments) {
      const isHoriz = seg.start.y === seg.end.y;
      const isVert = seg.start.x === seg.end.x;
      expect(isHoriz || isVert).toBe(true);
    }
  });

  it('merges connections with the same netName into one net', () => {
    const sheet = doc.sheets[0];
    const capDef = makeCapDef();

    const cmd = new AddSubcircuitCommand(
      sheet.id,
      [
        { def: resDef, position: { x: 100, y: 100 }, value: '10k', designator: 'R1' },
        { def: resDef, position: { x: 200, y: 100 }, value: '22k', designator: 'R2' },
        { def: capDef, position: { x: 300, y: 100 }, value: '100nF', designator: 'C1' },
      ],
      [
        { fromDesignator: 'R1', fromPin: '2', toDesignator: 'R2', toPin: '1', netName: 'SHARED' },
        { fromDesignator: 'R2', fromPin: '2', toDesignator: 'C1', toPin: '1', netName: 'SHARED' },
      ]
    );
    cmd.execute(doc);

    // 3 components, 2 wires, but only 1 net (both connections share 'SHARED')
    expect(sheet.components).toHaveLength(3);
    expect(sheet.wires).toHaveLength(2);
    expect(sheet.nets).toHaveLength(1);
    expect(sheet.nets[0].name).toBe('SHARED');
    expect(sheet.nets[0].wireIds).toHaveLength(2);
  });

  it('undo removes all components, wires, and nets', () => {
    const sheet = doc.sheets[0];
    const capDef = makeCapDef();

    const cmd = new AddSubcircuitCommand(
      sheet.id,
      [
        { def: resDef, position: { x: 100, y: 100 }, value: '10k', designator: 'R1' },
        { def: capDef, position: { x: 200, y: 100 }, value: '100nF', designator: 'C1' },
      ],
      [
        { fromDesignator: 'R1', fromPin: '2', toDesignator: 'C1', toPin: '1' },
      ]
    );
    cmd.execute(doc);
    expect(sheet.components).toHaveLength(2);
    expect(sheet.wires).toHaveLength(1);
    expect(sheet.nets).toHaveLength(1);

    cmd.undo(doc);
    expect(sheet.components).toHaveLength(0);
    expect(sheet.wires).toHaveLength(0);
    expect(sheet.nets).toHaveLength(0);
  });

  it('skips connections with non-existent pin names gracefully', () => {
    const sheet = doc.sheets[0];

    const cmd = new AddSubcircuitCommand(
      sheet.id,
      [
        { def: resDef, position: { x: 100, y: 100 }, value: '10k', designator: 'R1' },
        { def: resDef, position: { x: 200, y: 100 }, value: '22k', designator: 'R2' },
      ],
      [
        { fromDesignator: 'R1', fromPin: 'BOGUS_PIN', toDesignator: 'R2', toPin: '1' },
      ]
    );
    // Should not throw
    cmd.execute(doc);

    // Components placed, but no wire or net (connection was invalid)
    expect(sheet.components).toHaveLength(2);
    expect(sheet.wires).toHaveLength(0);
    expect(sheet.nets).toHaveLength(0);
  });

  it('handles connections referencing pins by id or name', () => {
    const sheet = doc.sheets[0];

    // Use pin id 'pin1' instead of pin name '1'
    const cmd = new AddSubcircuitCommand(
      sheet.id,
      [
        { def: resDef, position: { x: 100, y: 100 }, value: '10k', designator: 'R1' },
        { def: resDef, position: { x: 200, y: 100 }, value: '22k', designator: 'R2' },
      ],
      [
        { fromDesignator: 'R1', fromPin: 'pin2', toDesignator: 'R2', toPin: 'pin1' },
      ]
    );
    cmd.execute(doc);

    expect(sheet.wires).toHaveLength(1);
    expect(sheet.nets).toHaveLength(1);
  });

  it('matches pins case-insensitively', () => {
    const sheet = doc.sheets[0];

    // IC-style def with named pins (like EasyEDA-resolved)
    const icDef: ComponentDefinition = {
      ...makeComponentDef('U'),
      id: 'lib-ic-555',
      name: 'NE555',
      symbol: {
        ...makeComponentDef('U').symbol,
        pins: [
          { id: '1', name: 'GND', type: 'power', position: { x: -20, y: 0 }, orientation: 'left', length: 10 },
          { id: '2', name: 'TRIG', type: 'input', position: { x: 20, y: 0 }, orientation: 'right', length: 10 },
        ],
      },
    };

    const cmd = new AddSubcircuitCommand(
      sheet.id,
      [
        { def: icDef, position: { x: 100, y: 100 }, value: 'NE555', designator: 'U1' },
        { def: resDef, position: { x: 200, y: 100 }, value: '10k', designator: 'R1' },
      ],
      [
        // LLM sends lowercase "trig" → should match "TRIG"
        { fromDesignator: 'U1', fromPin: 'trig', toDesignator: 'R1', toPin: '1' },
      ]
    );
    cmd.execute(doc);

    expect(sheet.wires).toHaveLength(1);
    expect(cmd.connectionsCreated).toBe(1);
  });

  it('matches pins by prefix/substring (TRIGGER → TRIG)', () => {
    const sheet = doc.sheets[0];

    const icDef: ComponentDefinition = {
      ...makeComponentDef('U'),
      id: 'lib-ic-555b',
      symbol: {
        ...makeComponentDef('U').symbol,
        pins: [
          { id: '1', name: 'GND', type: 'power', position: { x: -20, y: 0 }, orientation: 'left', length: 10 },
          { id: '2', name: 'TRIG', type: 'input', position: { x: 20, y: 0 }, orientation: 'right', length: 10 },
        ],
      },
    };

    const cmd = new AddSubcircuitCommand(
      sheet.id,
      [
        { def: icDef, position: { x: 100, y: 100 }, value: 'NE555', designator: 'U1' },
        { def: resDef, position: { x: 200, y: 100 }, value: '10k', designator: 'R1' },
      ],
      [
        // LLM sends "TRIGGER" but pin is "TRIG" → prefix match
        { fromDesignator: 'U1', fromPin: 'TRIGGER', toDesignator: 'R1', toPin: '1' },
      ]
    );
    cmd.execute(doc);

    expect(sheet.wires).toHaveLength(1);
    expect(cmd.connectionsCreated).toBe(1);
  });

  it('tracks connectionsCreated accurately when some fail', () => {
    const sheet = doc.sheets[0];

    const cmd = new AddSubcircuitCommand(
      sheet.id,
      [
        { def: resDef, position: { x: 100, y: 100 }, value: '10k', designator: 'R1' },
        { def: resDef, position: { x: 200, y: 100 }, value: '22k', designator: 'R2' },
      ],
      [
        // Valid connection
        { fromDesignator: 'R1', fromPin: '2', toDesignator: 'R2', toPin: '1' },
        // Invalid — pin "BOGUS" doesn't exist
        { fromDesignator: 'R1', fromPin: 'BOGUS', toDesignator: 'R2', toPin: '2' },
      ]
    );
    cmd.execute(doc);

    expect(cmd.connectionsCreated).toBe(1);
    expect(sheet.wires).toHaveLength(1);
  });
});

// ---- RotateComponentCommand ----

describe('RotateComponentCommand', () => {
  let doc: CircuitDocument;
  const def = makeComponentDef('R');

  beforeEach(() => {
    doc = createDocument();
    const sheetId = doc.sheets[0].id;
    const addCmd = new AddComponentCommand(sheetId, def, { x: 100, y: 200 }, '10k', 'R1');
    addCmd.execute(doc);
  });

  it('increments rotation by 90 degrees', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    expect(comp.rotation).toBe(0);

    const cmd1 = new RotateComponentCommand(sheet.id, comp.id, def);
    cmd1.execute(doc);
    expect(comp.rotation).toBe(90);

    const cmd2 = new RotateComponentCommand(sheet.id, comp.id, def);
    cmd2.execute(doc);
    expect(comp.rotation).toBe(180);

    const cmd3 = new RotateComponentCommand(sheet.id, comp.id, def);
    cmd3.execute(doc);
    expect(comp.rotation).toBe(270);

    const cmd4 = new RotateComponentCommand(sheet.id, comp.id, def);
    cmd4.execute(doc);
    expect(comp.rotation).toBe(0);
  });

  it('recalculates pin absolute positions after 90° rotation', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    // Pins at 0°: pin1 at (80, 200), pin2 at (120, 200)
    // Pin def offsets: pin1 (-20, 0), pin2 (20, 0)
    // After 90° CW: (-20,0) → (0, 20), (20,0) → (0, -20)
    // Absolute: pin1 (100, 220), pin2 (100, 180)

    const cmd = new RotateComponentCommand(sheet.id, comp.id, def);
    cmd.execute(doc);

    expect(comp.pins[0].absolutePosition).toEqual({ x: 100, y: 220 });
    expect(comp.pins[1].absolutePosition).toEqual({ x: 100, y: 180 });
  });

  it('undo restores rotation and pin positions', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];

    const cmd = new RotateComponentCommand(sheet.id, comp.id, def);
    cmd.execute(doc);
    expect(comp.rotation).toBe(90);

    cmd.undo(doc);
    expect(comp.rotation).toBe(0);
    expect(comp.pins[0].absolutePosition).toEqual({ x: 80, y: 200 });
    expect(comp.pins[1].absolutePosition).toEqual({ x: 120, y: 200 });
  });

  it('moves connected wire endpoints on rotation', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    // Add a wire from pin1 (80,200) to some external point
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 80, y: 200 }, end: { x: 0, y: 200 } },
    ]);
    addWire.execute(doc);

    const cmd = new RotateComponentCommand(sheet.id, comp.id, def);
    cmd.execute(doc);

    // Pin1 moved to (100, 220), wire should be re-routed orthogonally
    const wire = sheet.wires[0];
    expect(wire.segments[0].start).toEqual({ x: 100, y: 220 });
    // External end should still be at (0, 200)
    expect(wire.segments[wire.segments.length - 1].end).toEqual({ x: 0, y: 200 });
    // All segments should be orthogonal
    for (const seg of wire.segments) {
      const isHoriz = seg.start.y === seg.end.y;
      const isVert = seg.start.x === seg.end.x;
      expect(isHoriz || isVert).toBe(true);
    }
  });

  it('undo restores wire endpoints', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 80, y: 200 }, end: { x: 0, y: 200 } },
    ]);
    addWire.execute(doc);

    const cmd = new RotateComponentCommand(sheet.id, comp.id, def);
    cmd.execute(doc);
    cmd.undo(doc);

    const wire = sheet.wires[0];
    expect(wire.segments[0].start).toEqual({ x: 80, y: 200 });
    expect(wire.segments[0].end).toEqual({ x: 0, y: 200 });
  });

  it('does not move unconnected wire endpoints', () => {
    const sheet = doc.sheets[0];
    const comp = sheet.components[0];
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 500, y: 500 }, end: { x: 600, y: 500 } },
    ]);
    addWire.execute(doc);

    const cmd = new RotateComponentCommand(sheet.id, comp.id, def);
    cmd.execute(doc);

    const wire = sheet.wires[0];
    expect(wire.segments[0].start).toEqual({ x: 500, y: 500 });
    expect(wire.segments[0].end).toEqual({ x: 600, y: 500 });
  });
});

// ---- Netlabel rotation correctness on wire→label morph ----

describe('netlabel rotation on wire→label morph', () => {
  const def = makeComponentDef('R');

  it('MoveComponentCommand: both labels get correct outward rotation', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0];

    // R1 at (100,200): pin1 at (80,200), pin2 at (120,200)
    const addR1 = new AddComponentCommand(sheet.id, def, { x: 100, y: 200 }, '10k', 'R1');
    addR1.execute(doc);
    // R2 at (200,200): pin1 at (180,200), pin2 at (220,200)
    const addR2 = new AddComponentCommand(sheet.id, def, { x: 200, y: 200 }, '10k', 'R2');
    addR2.execute(doc);

    // Wire from R1-pin2 (120,200) to R2-pin1 (180,200)
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 120, y: 200 }, end: { x: 180, y: 200 } },
    ]);
    addWire.execute(doc);

    expect(sheet.wires).toHaveLength(1);

    // Move R1 very far away so route fails -> morphs to labels
    const moveFar = new MoveComponentCommand(sheet.id, sheet.components[0].id, { x: 2000, y: 2000 });
    moveFar.execute(doc);

    // Wire should have been morphed to labels
    expect(sheet.wires).toHaveLength(0);
    expect(sheet.labels.length).toBe(2);

    // Find label at R1's new pin2 position and label at R2's pin1 position
    const r1 = sheet.components.find(c => c.designator === 'R1')!;
    const r2 = sheet.components.find(c => c.designator === 'R2')!;
    const r1Pin2Pos = r1.pins[1].absolutePosition;
    const r2Pin1Pos = r2.pins[0].absolutePosition;

    const labelAtR1 = sheet.labels.find(l => l.position.x === r1Pin2Pos.x && l.position.y === r1Pin2Pos.y);
    const labelAtR2 = sheet.labels.find(l => l.position.x === r2Pin1Pos.x && l.position.y === r2Pin1Pos.y);

    expect(labelAtR1).toBeDefined();
    expect(labelAtR2).toBeDefined();

    // R1 pin2 is to the right of R1 center -> rotation 0
    expect(labelAtR1!.rotation).toBe(0);
    // R2 pin1 is to the left of R2 center -> rotation 180
    expect(labelAtR2!.rotation).toBe(180);
  });
});

// ---- DeleteComponentCommand (cascade) ----

describe('DeleteComponentCommand (cascade)', () => {
  const def = makeComponentDef('R');

  it('removes attached wires when component is deleted', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0];

    // Add R1 and R2
    const addR1 = new AddComponentCommand(sheet.id, def, { x: 100, y: 200 }, '10k', 'R1');
    addR1.execute(doc);
    const addR2 = new AddComponentCommand(sheet.id, def, { x: 300, y: 200 }, '22k', 'R2');
    addR2.execute(doc);

    // Wire from R1-pin2 (120,200) to R2-pin1 (280,200)
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 120, y: 200 }, end: { x: 280, y: 200 } },
    ]);
    addWire.execute(doc);
    expect(sheet.wires).toHaveLength(1);

    // Delete R1 — attached wire should also be removed
    const r1 = sheet.components.find(c => c.designator === 'R1')!;
    const cmd = new DeleteComponentCommand(sheet.id, r1.id);
    cmd.execute(doc);

    expect(sheet.components).toHaveLength(1);
    expect(sheet.components[0].designator).toBe('R2');
    expect(sheet.wires).toHaveLength(0);
  });

  it('removes attached labels when component is deleted', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0];

    const addR1 = new AddComponentCommand(sheet.id, def, { x: 100, y: 200 }, '10k', 'R1');
    addR1.execute(doc);

    // Add a label at R1 pin2 position (120, 200)
    sheet.labels.push({ id: 'lbl1', position: { x: 120, y: 200 }, netName: 'VCC', rotation: 0 });
    expect(sheet.labels).toHaveLength(1);

    const r1 = sheet.components[0];
    const cmd = new DeleteComponentCommand(sheet.id, r1.id);
    cmd.execute(doc);

    expect(sheet.components).toHaveLength(0);
    expect(sheet.labels).toHaveLength(0);
  });

  it('undo restores component, wires, and labels', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0];

    const addR1 = new AddComponentCommand(sheet.id, def, { x: 100, y: 200 }, '10k', 'R1');
    addR1.execute(doc);
    const addR2 = new AddComponentCommand(sheet.id, def, { x: 300, y: 200 }, '22k', 'R2');
    addR2.execute(doc);

    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 120, y: 200 }, end: { x: 280, y: 200 } },
    ]);
    addWire.execute(doc);
    sheet.labels.push({ id: 'lbl1', position: { x: 80, y: 200 }, netName: 'GND', rotation: 180 });

    const r1 = sheet.components.find(c => c.designator === 'R1')!;
    const cmd = new DeleteComponentCommand(sheet.id, r1.id);
    cmd.execute(doc);

    expect(sheet.components).toHaveLength(1);
    expect(sheet.wires).toHaveLength(0);
    expect(sheet.labels).toHaveLength(0);

    cmd.undo(doc);

    expect(sheet.components).toHaveLength(2);
    expect(sheet.wires).toHaveLength(1);
    expect(sheet.labels).toHaveLength(1);
    expect(sheet.labels[0].netName).toBe('GND');
  });

  it('does not remove wires not connected to deleted component', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0];

    const addR1 = new AddComponentCommand(sheet.id, def, { x: 100, y: 200 }, '10k', 'R1');
    addR1.execute(doc);

    // Add an unrelated wire
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 500, y: 500 }, end: { x: 600, y: 500 } },
    ]);
    addWire.execute(doc);

    const r1 = sheet.components[0];
    const cmd = new DeleteComponentCommand(sheet.id, r1.id);
    cmd.execute(doc);

    expect(sheet.components).toHaveLength(0);
    expect(sheet.wires).toHaveLength(1); // Unrelated wire untouched
  });
});

// ---- DeleteWireCommand ----

describe('DeleteWireCommand', () => {
  it('removes the wire and cleans up net', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0];

    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
    ]);
    addWire.execute(doc);
    expect(sheet.wires).toHaveLength(1);
    expect(sheet.nets).toHaveLength(1);

    const wireId = sheet.wires[0].id;
    const cmd = new DeleteWireCommand(sheet.id, wireId);
    cmd.execute(doc);

    expect(sheet.wires).toHaveLength(0);
    expect(sheet.nets[0].wireIds).toHaveLength(0);
  });

  it('undo restores the wire', () => {
    const doc = createDocument();
    const sheet = doc.sheets[0];

    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
    ]);
    addWire.execute(doc);

    const wireId = sheet.wires[0].id;
    const cmd = new DeleteWireCommand(sheet.id, wireId);
    cmd.execute(doc);
    cmd.undo(doc);

    expect(sheet.wires).toHaveLength(1);
    expect(sheet.wires[0].id).toBe(wireId);
    expect(sheet.nets[0].wireIds).toContain(wireId);
  });
});

// ---- Wire Node Commands ----

describe('AddWireNodeCommand', () => {
  let doc: CircuitDocument;
  const def = makeComponentDef('R');

  beforeEach(() => {
    doc = createDocument();
    const sheet = doc.sheets[0];
    // Add two components with a wire between them
    const add1 = new AddComponentCommand(sheet.id, def, { x: 100, y: 200 }, '10k', 'R1');
    add1.execute(doc);
    const add2 = new AddComponentCommand(sheet.id, def, { x: 300, y: 200 }, '22k', 'R2');
    add2.execute(doc);
    // Wire from R1-pin2 (120,200) to R2-pin1 (280,200)
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 120, y: 200 }, end: { x: 280, y: 200 } },
    ]);
    addWire.execute(doc);
  });

  it('adds a node to the wire, splitting the segment', () => {
    const sheet = doc.sheets[0];
    const wireId = sheet.wires[0].id;

    const cmd = new AddWireNodeCommand(sheet.id, wireId, { x: 200, y: 200 });
    cmd.execute(doc);

    const wire = sheet.wires[0];
    expect(wire.nodes).toHaveLength(1);
    expect(wire.nodes![0].position).toEqual({ x: 200, y: 200 });
    // Should now have 2+ segments instead of 1
    expect(wire.segments.length).toBeGreaterThanOrEqual(2);
    // Wire should still start at 120,200 and end at 280,200
    expect(wire.segments[0].start).toEqual({ x: 120, y: 200 });
    expect(wire.segments[wire.segments.length - 1].end).toEqual({ x: 280, y: 200 });
  });

  it('undo removes the node and restores original segment', () => {
    const sheet = doc.sheets[0];
    const wireId = sheet.wires[0].id;

    const cmd = new AddWireNodeCommand(sheet.id, wireId, { x: 200, y: 200 });
    cmd.execute(doc);
    cmd.undo(doc);

    const wire = sheet.wires[0];
    expect(wire.nodes).toHaveLength(0);
    expect(wire.segments).toHaveLength(1);
    expect(wire.segments[0].start).toEqual({ x: 120, y: 200 });
    expect(wire.segments[0].end).toEqual({ x: 280, y: 200 });
  });
});

describe('MoveWireNodeCommand', () => {
  let doc: CircuitDocument;
  const def = makeComponentDef('R');

  beforeEach(() => {
    doc = createDocument();
    const sheet = doc.sheets[0];
    const add1 = new AddComponentCommand(sheet.id, def, { x: 100, y: 200 }, '10k', 'R1');
    add1.execute(doc);
    const add2 = new AddComponentCommand(sheet.id, def, { x: 300, y: 200 }, '22k', 'R2');
    add2.execute(doc);
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 120, y: 200 }, end: { x: 280, y: 200 } },
    ]);
    addWire.execute(doc);
    // Add a node at mid-point
    const wireId = doc.sheets[0].wires[0].id;
    const addNode = new AddWireNodeCommand(sheet.id, wireId, { x: 200, y: 200 });
    addNode.execute(doc);
  });

  it('moves the node to a new position and re-routes segments', () => {
    const sheet = doc.sheets[0];
    const wire = sheet.wires[0];
    const nodeId = wire.nodes![0].id;

    const cmd = new MoveWireNodeCommand(sheet.id, nodeId, wire.id, { x: 200, y: 100 });
    cmd.execute(doc);

    expect(wire.nodes![0].position).toEqual({ x: 200, y: 100 });
    // Wire should route through the new position
    expect(wire.segments[0].start).toEqual({ x: 120, y: 200 });
    expect(wire.segments[wire.segments.length - 1].end).toEqual({ x: 280, y: 200 });
    // At least one segment should pass through or end at (200, 100)
    const passesThrough = wire.segments.some(
      s => (s.start.x === 200 && s.start.y === 100) || (s.end.x === 200 && s.end.y === 100)
    );
    expect(passesThrough).toBe(true);
  });

  it('undo restores original node position and segments', () => {
    const sheet = doc.sheets[0];
    const wire = sheet.wires[0];
    const nodeId = wire.nodes![0].id;
    const segsBefore = wire.segments.map(s => ({ start: { ...s.start }, end: { ...s.end } }));

    const cmd = new MoveWireNodeCommand(sheet.id, nodeId, wire.id, { x: 200, y: 100 });
    cmd.execute(doc);
    cmd.undo(doc);

    expect(wire.nodes![0].position).toEqual({ x: 200, y: 200 });
    expect(wire.segments).toEqual(segsBefore);
  });
});

describe('DeleteWireNodeCommand', () => {
  let doc: CircuitDocument;
  const def = makeComponentDef('R');

  beforeEach(() => {
    doc = createDocument();
    const sheet = doc.sheets[0];
    const add1 = new AddComponentCommand(sheet.id, def, { x: 100, y: 200 }, '10k', 'R1');
    add1.execute(doc);
    const add2 = new AddComponentCommand(sheet.id, def, { x: 300, y: 200 }, '22k', 'R2');
    add2.execute(doc);
    const addWire = new AddWireCommand(sheet.id, [
      { start: { x: 120, y: 200 }, end: { x: 280, y: 200 } },
    ]);
    addWire.execute(doc);
    const wireId = doc.sheets[0].wires[0].id;
    const addNode = new AddWireNodeCommand(sheet.id, wireId, { x: 200, y: 200 });
    addNode.execute(doc);
  });

  it('removes the node and rebuilds segments', () => {
    const sheet = doc.sheets[0];
    const wire = sheet.wires[0];
    const nodeId = wire.nodes![0].id;

    const cmd = new DeleteWireNodeCommand(sheet.id, nodeId, wire.id);
    cmd.execute(doc);

    expect(wire.nodes).toHaveLength(0);
    // Wire should still connect endpoints
    expect(wire.segments[0].start).toEqual({ x: 120, y: 200 });
    expect(wire.segments[wire.segments.length - 1].end).toEqual({ x: 280, y: 200 });
  });

  it('undo restores the node and segments', () => {
    const sheet = doc.sheets[0];
    const wire = sheet.wires[0];
    const nodeId = wire.nodes![0].id;
    const segsBefore = wire.segments.map(s => ({ start: { ...s.start }, end: { ...s.end } }));

    const cmd = new DeleteWireNodeCommand(sheet.id, nodeId, wire.id);
    cmd.execute(doc);
    cmd.undo(doc);

    expect(wire.nodes).toHaveLength(1);
    expect(wire.segments).toEqual(segsBefore);
  });
});
