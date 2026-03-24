import { describe, it, expect } from 'vitest';
import { createDocument, AddComponentCommand } from '../../core/document';
import type { ComponentDefinition, CircuitDocument } from '../../core/types';
import { generateNetlist, type SimulationConfig } from '../netlist-generator';
import { parseSpiceValue } from '../spice-value-parser';

// ---- Test Helpers ----

function makeResistorDef(): ComponentDefinition {
  return {
    id: 'res_generic', name: 'Resistor', description: 'Generic resistor',
    category: 'passives', designatorPrefix: 'R', defaultValue: '10kΩ',
    properties: {}, tags: ['passive'],
    symbol: {
      id: 'sym_res', name: 'Resistor', width: 60, height: 20,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -15 },
      valuePosition: { x: 0, y: 20 },
      pins: [
        { id: '1', name: '1', type: 'passive', position: { x: -30, y: 0 }, orientation: 'left', length: 10 },
        { id: '2', name: '2', type: 'passive', position: { x: 30, y: 0 }, orientation: 'right', length: 10 },
      ],
      graphics: [],
    },
  };
}

function makeCapacitorDef(): ComponentDefinition {
  return {
    id: 'cap_generic', name: 'Capacitor', description: 'Generic capacitor',
    category: 'passives', designatorPrefix: 'C', defaultValue: '100nF',
    properties: {}, tags: ['passive'],
    symbol: {
      id: 'sym_cap', name: 'Capacitor', width: 30, height: 40,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -20 },
      valuePosition: { x: 0, y: 25 },
      pins: [
        { id: '1', name: '1', type: 'passive', position: { x: 0, y: -20 }, orientation: 'up', length: 10 },
        { id: '2', name: '2', type: 'passive', position: { x: 0, y: 20 }, orientation: 'down', length: 10 },
      ],
      graphics: [],
    },
  };
}

function makeVoltageDef(): ComponentDefinition {
  return {
    id: 'vsource_dc', name: 'DC Voltage Source', description: 'DC voltage source',
    category: 'sources', designatorPrefix: 'V', defaultValue: '5V',
    properties: {}, tags: ['source'],
    symbol: {
      id: 'sym_vsrc', name: 'V Source', width: 30, height: 40,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -25 },
      valuePosition: { x: 0, y: 30 },
      pins: [
        { id: '+', name: '+', type: 'passive', position: { x: 0, y: -20 }, orientation: 'up', length: 10 },
        { id: '-', name: '−', type: 'passive', position: { x: 0, y: 20 }, orientation: 'down', length: 10 },
      ],
      graphics: [],
    },
  };
}

function makeGndDef(): ComponentDefinition {
  return {
    id: 'pwr_gnd', name: 'GND', description: 'Ground power symbol',
    category: 'power', designatorPrefix: '#PWR', defaultValue: 'GND',
    properties: {}, tags: ['power'],
    symbol: {
      id: 'sym_gnd', name: 'GND', width: 20, height: 20,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: 20 },
      valuePosition: { x: 0, y: 20 },
      pins: [
        { id: '1', name: 'GND', type: 'power', position: { x: 0, y: -10 }, orientation: 'up', length: 10 },
      ],
      graphics: [],
    },
  };
}

function makeICDef(): ComponentDefinition {
  return {
    id: 'ic_generic', name: 'IC', description: 'Generic IC',
    category: 'ics_digital', designatorPrefix: 'U', defaultValue: 'IC',
    properties: {}, tags: ['ic'],
    symbol: {
      id: 'sym_ic', name: 'IC', width: 80, height: 60,
      origin: { x: 0, y: 0 },
      designatorPosition: { x: 0, y: -35 },
      valuePosition: { x: 0, y: 40 },
      pins: [
        { id: '1', name: 'VIN', type: 'power', position: { x: -40, y: -15 }, orientation: 'left', length: 10 },
        { id: '2', name: 'GND', type: 'power', position: { x: -40, y: 15 }, orientation: 'left', length: 10 },
        { id: '3', name: 'OUT', type: 'output', position: { x: 40, y: 0 }, orientation: 'right', length: 10 },
      ],
      graphics: [],
    },
  };
}

function buildLibraryMap(...defs: ComponentDefinition[]): Map<string, ComponentDefinition> {
  const map = new Map<string, ComponentDefinition>();
  for (const d of defs) {
    map.set(d.id, d);
  }
  return map;
}

/**
 * Build a simple voltage divider circuit:
 *   V1(+) ── node1 ── R1 ── node2 ── R2 ── GND
 *   V1(-) ── GND
 *
 * Layout:
 *   V1 at (0, 0), pins at (0, -20)=+ and (0, 20)=-
 *   R1 at (100, -20), pins at (70, -20) and (130, -20)
 *   R2 at (100, 60), pins at (70, 60) and (130, 60)
 *   GND label at (0, 20) and (130, 60)
 *
 * Wires:
 *   V1+ (0,-20) → R1 pin1 (70,-20)
 *   R1 pin2 (130,-20) → R2 pin1 (70, 60)   (junction/intermediate node)
 *   V1- (0, 20) → GND, R2 pin2 (130, 60) → GND
 */
function buildVoltageDivider(): {
  doc: CircuitDocument;
  libraryMap: Map<string, ComponentDefinition>;
} {
  const doc = createDocument('Voltage Divider');
  const sheet = doc.sheets[0];
  const resDef = makeResistorDef();
  const vDef = makeVoltageDef();
  const gndDef = makeGndDef();
  const libraryMap = buildLibraryMap(resDef, vDef, gndDef);

  // Add V1 at y-center so pins are at (0,-20) and (0,20)
  const addV1 = new AddComponentCommand(sheet.id, vDef, { x: 0, y: 0 }, '5V', 'V1');
  addV1.execute(doc);

  // Add R1 horizontal at (100, -20): pins at (70, -20) and (130, -20)
  const addR1 = new AddComponentCommand(sheet.id, resDef, { x: 100, y: -20 }, '10kΩ', 'R1');
  addR1.execute(doc);

  // Add R2 horizontal at (100, 60): pins at (70, 60) and (130, 60)
  const addR2 = new AddComponentCommand(sheet.id, resDef, { x: 100, y: 60 }, '20kΩ', 'R2');
  addR2.execute(doc);

  // Create nets and wire everything up
  // Net 1: V1+ to R1 pin1 (node "1")
  const net1 = { id: 'net1', name: 'Net_1', pinIds: [], wireIds: ['w1'] };
  sheet.nets.push(net1);
  const w1 = { id: 'w1', netId: 'net1', segments: [{ start: { x: 0, y: -20 }, end: { x: 70, y: -20 } }] };
  sheet.wires.push(w1);
  // Assign net to pins
  const v1 = sheet.components.find(c => c.designator === 'V1')!;
  const r1 = sheet.components.find(c => c.designator === 'R1')!;
  const r2 = sheet.components.find(c => c.designator === 'R2')!;
  v1.pins[0].netId = 'net1'; // V1+
  r1.pins[0].netId = 'net1'; // R1 pin1

  // Net 2: R1 pin2 to R2 pin1 (mid-point node "2")
  const net2 = { id: 'net2', name: 'Net_2', pinIds: [], wireIds: ['w2'] };
  sheet.nets.push(net2);
  const w2 = { id: 'w2', netId: 'net2', segments: [
    { start: { x: 130, y: -20 }, end: { x: 130, y: 60 } },
    { start: { x: 130, y: 60 }, end: { x: 70, y: 60 } },
  ] };
  sheet.wires.push(w2);
  r1.pins[1].netId = 'net2'; // R1 pin2
  r2.pins[0].netId = 'net2'; // R2 pin1

  // Net GND: V1- and R2 pin2
  const netGnd = { id: 'net_gnd', name: 'GND', pinIds: [], wireIds: [] };
  sheet.nets.push(netGnd);
  v1.pins[1].netId = 'net_gnd'; // V1-
  r2.pins[1].netId = 'net_gnd'; // R2 pin2

  // Add GND labels
  sheet.labels.push({ id: 'lbl_gnd1', position: { x: 0, y: 20 }, netName: 'GND', rotation: 0 });
  sheet.labels.push({ id: 'lbl_gnd2', position: { x: 130, y: 60 }, netName: 'GND', rotation: 0 });

  return { doc, libraryMap };
}

// ---- Tests ----

describe('parseSpiceValue', () => {
  it('converts human-readable values to SPICE notation', () => {
    expect(parseSpiceValue('10kΩ')).toBe('10k');
    expect(parseSpiceValue('100nF')).toBe('100n');
    expect(parseSpiceValue('4.7µH')).toBe('4.7u');
    expect(parseSpiceValue('1MΩ')).toBe('1Meg');
  });

  it('handles plain numbers', () => {
    expect(parseSpiceValue('10')).toBe('10');
    expect(parseSpiceValue('3.3')).toBe('3.3');
    expect(parseSpiceValue('5V')).toBe('5');
  });

  it('handles SPICE-ready values as passthrough', () => {
    expect(parseSpiceValue('10k')).toBe('10k');
    expect(parseSpiceValue('100n')).toBe('100n');
    expect(parseSpiceValue('4.7u')).toBe('4.7u');
  });

  it('handles empty/null values', () => {
    expect(parseSpiceValue('')).toBe('0');
  });
});

describe('generateNetlist', () => {
  it('generates valid netlist for voltage divider with .op', () => {
    const { doc, libraryMap } = buildVoltageDivider();
    const config: SimulationConfig = { analysis: 'op' };

    const result = generateNetlist(doc, config, libraryMap);

    expect(result.errors).toHaveLength(0);

    // Should contain V1, R1, R2 component lines
    expect(result.netlist).toContain('V1');
    expect(result.netlist).toContain('R1');
    expect(result.netlist).toContain('R2');

    // Should contain .op analysis
    expect(result.netlist).toContain('.op');

    // Should contain .end
    expect(result.netlist).toContain('.end');

    // Should have a title line
    expect(result.netlist.startsWith('* Voltage Divider')).toBe(true);

    // Node map should have GND mapped to 0
    const gndNode = result.nodeMap.get('GND');
    expect(gndNode).toBe('0');

    // Should contain 3 component lines (V1, R1, R2)
    const componentLineCount = result.netlist.split('\n')
      .filter(line => /^[VRCLIQ]/.test(line)).length;
    expect(componentLineCount).toBe(3);
  });

  it('generates valid netlist for RC circuit with .tran', () => {
    const doc = createDocument('RC Circuit');
    const sheet = doc.sheets[0];
    const resDef = makeResistorDef();
    const capDef = makeCapacitorDef();
    const vDef = makeVoltageDef();
    const gndDef = makeGndDef();
    const libraryMap = buildLibraryMap(resDef, capDef, vDef, gndDef);

    // V1 at (0, 0): pins at (0, -20)+ and (0, 20)-
    const addV1 = new AddComponentCommand(sheet.id, vDef, { x: 0, y: 0 }, '5V', 'V1');
    addV1.execute(doc);

    // R1 at (100, -20): pins at (70, -20) and (130, -20)
    const addR1 = new AddComponentCommand(sheet.id, resDef, { x: 100, y: -20 }, '10kΩ', 'R1');
    addR1.execute(doc);

    // C1 at (200, 0): pins at (200, -20) and (200, 20)
    const addC1 = new AddComponentCommand(sheet.id, capDef, { x: 200, y: 0 }, '100nF', 'C1');
    addC1.execute(doc);

    const v1 = sheet.components.find(c => c.designator === 'V1')!;
    const r1 = sheet.components.find(c => c.designator === 'R1')!;
    const c1 = sheet.components.find(c => c.designator === 'C1')!;

    // Net 1: V1+ to R1 pin1
    const net1 = { id: 'net1', name: 'Net_1', pinIds: [], wireIds: ['w1'] };
    sheet.nets.push(net1);
    sheet.wires.push({ id: 'w1', netId: 'net1', segments: [{ start: { x: 0, y: -20 }, end: { x: 70, y: -20 } }] });
    v1.pins[0].netId = 'net1';
    r1.pins[0].netId = 'net1';

    // Net 2: R1 pin2 to C1 pin1
    const net2 = { id: 'net2', name: 'Net_2', pinIds: [], wireIds: ['w2'] };
    sheet.nets.push(net2);
    sheet.wires.push({ id: 'w2', netId: 'net2', segments: [{ start: { x: 130, y: -20 }, end: { x: 200, y: -20 } }] });
    r1.pins[1].netId = 'net2';
    c1.pins[0].netId = 'net2';

    // Net GND: V1- and C1 pin2
    const netGnd = { id: 'net_gnd', name: 'GND', pinIds: [], wireIds: [] };
    sheet.nets.push(netGnd);
    v1.pins[1].netId = 'net_gnd';
    c1.pins[1].netId = 'net_gnd';

    sheet.labels.push({ id: 'lbl_gnd', position: { x: 0, y: 20 }, netName: 'GND', rotation: 0 });

    const config: SimulationConfig = {
      analysis: 'transient',
      stepTime: '1u',
      stopTime: '10m',
    };

    const result = generateNetlist(doc, config, libraryMap);

    expect(result.errors).toHaveLength(0);
    expect(result.netlist).toContain('V1');
    expect(result.netlist).toContain('R1');
    expect(result.netlist).toContain('C1');
    expect(result.netlist).toContain('.tran 1u 10m');
    expect(result.netlist).toContain('.end');
  });

  it('reports error when no GND node is present', () => {
    const doc = createDocument('No GND');
    const sheet = doc.sheets[0];
    const resDef = makeResistorDef();
    const libraryMap = buildLibraryMap(resDef);

    // Add a lone resistor with no ground
    const addR1 = new AddComponentCommand(sheet.id, resDef, { x: 100, y: 0 }, '10kΩ', 'R1');
    addR1.execute(doc);

    // Create a net but no GND
    const net1 = { id: 'net1', name: 'Net_1', pinIds: [], wireIds: [] };
    sheet.nets.push(net1);
    sheet.components[0].pins[0].netId = 'net1';

    const config: SimulationConfig = { analysis: 'op' };
    const result = generateNetlist(doc, config, libraryMap);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('ground');
  });

  it('warns about floating/unconnected pins', () => {
    const doc = createDocument('Floating');
    const sheet = doc.sheets[0];
    const resDef = makeResistorDef();
    const libraryMap = buildLibraryMap(resDef);

    // Add R1 with only pin 1 connected, pin 2 floating
    const addR1 = new AddComponentCommand(sheet.id, resDef, { x: 100, y: 0 }, '10kΩ', 'R1');
    addR1.execute(doc);

    const r1 = sheet.components[0];

    // Connect pin 1 to a net, leave pin 2 unconnected
    const net1 = { id: 'net_gnd', name: 'GND', pinIds: [], wireIds: [] };
    sheet.nets.push(net1);
    r1.pins[0].netId = 'net_gnd';
    // pin 2 has netId = null → floating

    sheet.labels.push({ id: 'lbl_gnd', position: { x: 70, y: 0 }, netName: 'GND', rotation: 0 });

    const config: SimulationConfig = { analysis: 'op' };
    const result = generateNetlist(doc, config, libraryMap);

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('R1') && w.includes('not connected'))).toBe(true);
  });

  it('warns about unknown/unsupported component types', () => {
    const doc = createDocument('Unknown');
    const sheet = doc.sheets[0];
    const icDef = makeICDef();
    const libraryMap = buildLibraryMap(icDef);

    const addU1 = new AddComponentCommand(sheet.id, icDef, { x: 100, y: 0 }, 'IC', 'U1');
    addU1.execute(doc);

    // Need ground for the netlist to process at all
    const netGnd = { id: 'net_gnd', name: 'GND', pinIds: [], wireIds: [] };
    sheet.nets.push(netGnd);
    sheet.labels.push({ id: 'lbl_gnd', position: { x: 60, y: 15 }, netName: 'GND', rotation: 0 });

    // Connect IC GND pin to ground
    const u1 = sheet.components[0];
    u1.pins[1].netId = 'net_gnd'; // GND pin

    const config: SimulationConfig = { analysis: 'op' };
    const result = generateNetlist(doc, config, libraryMap);

    expect(result.warnings.some(w => w.includes('U1'))).toBe(true);
    expect(result.netlist).toContain('* U1 (unsupported)');
  });

  it('connects nodes via matching net labels without wires', () => {
    const doc = createDocument('Net Labels');
    const sheet = doc.sheets[0];
    const resDef = makeResistorDef();
    const vDef = makeVoltageDef();
    const libraryMap = buildLibraryMap(resDef, vDef);

    // V1 at (0, 0): pins at (0, -20)+ and (0, 20)-
    const addV1 = new AddComponentCommand(sheet.id, vDef, { x: 0, y: 0 }, '5V', 'V1');
    addV1.execute(doc);

    // R1 at (200, 0): pins at (170, 0) and (230, 0) — far away, no wire
    const addR1 = new AddComponentCommand(sheet.id, resDef, { x: 200, y: 0 }, '10kΩ', 'R1');
    addR1.execute(doc);

    // Components are added; labels connect them implicitly (no wires needed)

    // Connect V1+ and R1 pin1 via matching "VOUT" label (no wire needed)
    sheet.labels.push({ id: 'lbl_vout1', position: { x: 0, y: -20 }, netName: 'VOUT', rotation: 0 });
    sheet.labels.push({ id: 'lbl_vout2', position: { x: 170, y: 0 }, netName: 'VOUT', rotation: 0 });

    // GND for V1- and R1 pin2
    sheet.labels.push({ id: 'lbl_gnd1', position: { x: 0, y: 20 }, netName: 'GND', rotation: 0 });
    sheet.labels.push({ id: 'lbl_gnd2', position: { x: 230, y: 0 }, netName: 'GND', rotation: 0 });

    const config: SimulationConfig = { analysis: 'op' };
    const result = generateNetlist(doc, config, libraryMap);

    expect(result.errors).toHaveLength(0);

    // Both V1+ and R1 pin1 should be on the same node ("VOUT")
    // Parse the netlist to verify
    const lines = result.netlist.split('\n');
    const v1Line = lines.find(l => l.startsWith('V1'))!;
    const r1Line = lines.find(l => l.startsWith('R1'))!;

    // V1 should have VOUT as its + node
    expect(v1Line).toContain('VOUT');
    // R1 should also reference VOUT
    expect(r1Line).toContain('VOUT');

    // Both should reference node 0 (GND)
    expect(v1Line).toContain('0');
    expect(r1Line).toContain('0');
  });
});
