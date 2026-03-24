import { describe, it, expect } from 'vitest';
import { serializeToKiCad, toKiCadFootprint } from '../kicad-serializer';
import type { CircuitDocument, ComponentDefinition } from '../../core/types';

function createMinimalDoc(): CircuitDocument {
  return {
    id: 'test-doc',
    name: 'Test Circuit',
    version: '1.0',
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
    metadata: { author: '', description: '', revision: '', tags: [] },
    sheets: [{
      id: 'sheet-1',
      name: 'Main',
      components: [],
      wires: [],
      nets: [],
      junctions: [],
      labels: [],
      annotations: [],
      gridSize: 10,
      bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
    }],
  };
}

function createResistorDef(): ComponentDefinition {
  return {
    id: 'res_generic',
    name: 'Resistor',
    description: 'Generic resistor',
    category: 'passives',
    designatorPrefix: 'R',
    defaultValue: '10k',
    properties: { lcsc: 'C17414', package: '0805' },
    tags: ['passive'],
    symbol: {
      id: 'sym_res',
      name: 'Resistor',
      width: 40,
      height: 10,
      origin: { x: 0, y: 0 },
      pins: [
        { id: '1', name: '1', type: 'passive', position: { x: -20, y: 0 }, orientation: 'left', length: 10 },
        { id: '2', name: '2', type: 'passive', position: { x: 20, y: 0 }, orientation: 'right', length: 10 },
      ],
      graphics: [
        { type: 'rect', properties: { x: 0, y: 0, width: 20, height: 8 } },
      ],
      designatorPosition: { x: 0, y: -10 },
      valuePosition: { x: 0, y: 10 },
    },
  };
}

describe('kicad-serializer', () => {
  describe('toKiCadFootprint', () => {
    it('maps resistor SMD packages', () => {
      expect(toKiCadFootprint('R', '0805')).toBe('R0805');
      expect(toKiCadFootprint('R', '0402')).toBe('R0402');
      expect(toKiCadFootprint('R', '1206')).toBe('R1206');
    });

    it('maps capacitor SMD packages', () => {
      expect(toKiCadFootprint('C', '0402')).toBe('C0402');
      expect(toKiCadFootprint('C', '0805')).toBe('C0805');
    });

    it('maps inductor SMD packages', () => {
      expect(toKiCadFootprint('L', '0805')).toBe('L0805');
    });

    it('maps diode packages', () => {
      expect(toKiCadFootprint('D', 'SOD-323')).toBe('SOD-323');
    });

    it('maps transistor packages', () => {
      expect(toKiCadFootprint('Q', 'SOT-23')).toBe('SOT-23');
    });

    it('maps connector headers', () => {
      expect(toKiCadFootprint('J', '1x2')).toBe('HDR-2');
      expect(toKiCadFootprint('J', '1x4')).toBe('HDR-4');
    });

    it('returns fallback for unknown packages', () => {
      expect(toKiCadFootprint('R', 'unknown')).toBe('Runknown');
      expect(toKiCadFootprint('X', '0805')).toBe('X0805');
    });
  });

  describe('serializeToKiCad', () => {
    it('generates valid KiCad header', () => {
      const doc = createMinimalDoc();
      const libraryMap = new Map<string, ComponentDefinition>();
      const result = serializeToKiCad(doc, libraryMap);

      expect(result).toContain('(kicad_sch (version 20231120)');
      expect(result).toContain('(generator "smart-circuit")');
      expect(result).toContain('(paper "A4")');
      expect(result).toContain('(lib_symbols');
      expect(result).toContain('(sheet_instances');
    });

    it('includes symbol library definitions and instances', () => {
      const doc = createMinimalDoc();
      const resDef = createResistorDef();
      doc.sheets[0].components.push({
        id: 'comp-1',
        libraryId: 'res_generic',
        designator: 'R1',
        value: '10k',
        position: { x: 100, y: 200 },
        rotation: 0,
        mirror: false,
        pins: [],
        properties: { lcsc: 'C17414', package: '0805' },
      });

      const libraryMap = new Map<string, ComponentDefinition>();
      libraryMap.set('res_generic', resDef);

      const result = serializeToKiCad(doc, libraryMap);

      // Should have lib_symbols definition
      expect(result).toContain('(symbol "smart-circuit:res_generic"');
      // Should have instance
      expect(result).toContain('(lib_id "smart-circuit:res_generic")');
      // Should have correct properties
      expect(result).toContain('"Reference" "R1"');
      expect(result).toContain('"Value" "10k"');
    });

    it('includes Footprint property from package mapping', () => {
      const doc = createMinimalDoc();
      const resDef = createResistorDef();
      doc.sheets[0].components.push({
        id: 'comp-1',
        libraryId: 'res_generic',
        designator: 'R1',
        value: '10k',
        position: { x: 100, y: 200 },
        rotation: 0,
        mirror: false,
        pins: [],
        properties: { lcsc: 'C17414', package: '0805' },
      });

      const libraryMap = new Map<string, ComponentDefinition>();
      libraryMap.set('res_generic', resDef);
      const result = serializeToKiCad(doc, libraryMap);

      expect(result).toContain('"Footprint" "R0805"');
    });

    it('includes LCSC and MPN custom properties', () => {
      const doc = createMinimalDoc();
      const resDef = createResistorDef();
      doc.sheets[0].components.push({
        id: 'comp-1',
        libraryId: 'res_generic',
        designator: 'R1',
        value: '10k',
        position: { x: 100, y: 200 },
        rotation: 0,
        mirror: false,
        pins: [],
        properties: { lcsc: 'C17414', mpn: '0805W8F1002T5E', package: '0805' },
      });

      const libraryMap = new Map<string, ComponentDefinition>();
      libraryMap.set('res_generic', resDef);
      const result = serializeToKiCad(doc, libraryMap);

      expect(result).toContain('"LCSC" "C17414"');
      expect(result).toContain('"MPN" "0805W8F1002T5E"');
    });

    it('serializes wires correctly', () => {
      const doc = createMinimalDoc();
      doc.sheets[0].wires.push({
        id: 'w1',
        netId: 'net1',
        segments: [
          { start: { x: 100, y: 200 }, end: { x: 300, y: 200 } },
        ],
      });

      const libraryMap = new Map<string, ComponentDefinition>();
      const result = serializeToKiCad(doc, libraryMap);

      expect(result).toContain('(wire (pts');
      expect(result).toContain('(xy 25.4 50.8)');
      expect(result).toContain('(xy 76.2 50.8)');
    });

    it('serializes labels and junctions', () => {
      const doc = createMinimalDoc();
      doc.sheets[0].labels.push({
        id: 'lbl1',
        netName: 'VCC',
        position: { x: 100, y: 100 },
        rotation: 0,
      });
      doc.sheets[0].junctions.push({
        id: 'j1',
        position: { x: 200, y: 200 },
        netId: 'net1',
      });

      const libraryMap = new Map<string, ComponentDefinition>();
      const result = serializeToKiCad(doc, libraryMap);

      expect(result).toContain('(label "VCC"');
      expect(result).toContain('(junction (at');
    });

    it('skips power symbols (#PWR)', () => {
      const doc = createMinimalDoc();
      const pwrDef: ComponentDefinition = {
        id: 'pwr_gnd', name: 'GND', description: '', category: 'power',
        designatorPrefix: '#PWR', defaultValue: 'GND', properties: {}, tags: [],
        symbol: {
          id: 'sym_gnd', name: 'GND', width: 20, height: 20,
          origin: { x: 0, y: 0 }, designatorPosition: { x: 0, y: 0 }, valuePosition: { x: 0, y: 0 },
          pins: [{ id: '1', name: 'GND', type: 'power', position: { x: 0, y: 0 }, orientation: 'up', length: 10 }],
          graphics: [],
        },
      };
      doc.sheets[0].components.push({
        id: 'pwr1', libraryId: 'pwr_gnd', designator: '#PWR01', value: 'GND',
        position: { x: 0, y: 0 }, rotation: 0, mirror: false, pins: [], properties: {},
      });

      const libraryMap = new Map<string, ComponentDefinition>();
      libraryMap.set('pwr_gnd', pwrDef);
      const result = serializeToKiCad(doc, libraryMap);

      expect(result).not.toContain('#PWR');
      expect(result).not.toContain('pwr_gnd');
    });
  });
});
