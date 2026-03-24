import { describe, it, expect } from 'vitest';
import { serializeToEasyEDA } from '../easyeda-serializer';
import type { CircuitDocument, ComponentDefinition } from '../../core/types';
import type { FootprintDefinition, PadDefinition, PCBLayer } from '../../library/easyeda-parser';

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
    properties: { lcsc: 'C12345', package: '0805' },
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

function createFootprint(): FootprintDefinition {
  const pads: PadDefinition[] = [
    { id: 'pad_1', pinId: '1', x: -0.8, y: 0, width: 1.0, height: 0.6, shape: 'rect', layer: 'F.Cu' as PCBLayer, drill: 0, rotation: 0 },
    { id: 'pad_2', pinId: '2', x: 0.8, y: 0, width: 1.0, height: 0.6, shape: 'rect', layer: 'F.Cu' as PCBLayer, drill: 0, rotation: 0 },
  ];
  return {
    id: 'fp_C12345',
    name: '0805',
    pads,
    courtyard: { x: -1.55, y: -0.55, width: 3.1, height: 1.1 },
    silkscreen: [],
  };
}

describe('easyeda-serializer', () => {
  describe('serializeToEasyEDA', () => {
    it('should return a single EasyEDA document', () => {
      const doc = createMinimalDoc();
      const libraryMap = new Map<string, ComponentDefinition>();
      const result = serializeToEasyEDA(doc, libraryMap);

      expect(result.docType).toBe('1');
      expect(result.head.title).toBe('Test Circuit');
    });

    it('should include packageDetails when footprintMap is provided', () => {
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
        properties: { lcsc: 'C12345' },
      });

      const libraryMap = new Map<string, ComponentDefinition>();
      libraryMap.set('res_generic', resDef);

      const fp = createFootprint();
      const footprintMap = new Map<string, FootprintDefinition>();
      footprintMap.set('C12345', fp);

      const result = serializeToEasyEDA(doc, libraryMap, footprintMap);

      expect(result.docType).toBe('1');
      expect(result.packageDetails).toBeDefined();
      expect(result.packageDetails!.length).toBe(1);
      expect(result.packageDetails![0].docType).toBe('4');
      expect(result.packageDetails![0].title).toBe('0805');
      expect(result.packageDetails![0].head.c_para).toHaveProperty('package', '0805');
    });

    it('should generate PAD shapes in packageDetails', () => {
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
        properties: { lcsc: 'C12345' },
      });

      const libraryMap = new Map<string, ComponentDefinition>();
      libraryMap.set('res_generic', resDef);

      const fp = createFootprint();
      const footprintMap = new Map<string, FootprintDefinition>();
      footprintMap.set('C12345', fp);

      const result = serializeToEasyEDA(doc, libraryMap, footprintMap);
      const fpDoc = result.packageDetails![0];

      expect(fpDoc.shape.length).toBeGreaterThanOrEqual(2);
      const padShapes = fpDoc.shape.filter(s => s.startsWith('PAD~'));
      expect(padShapes).toHaveLength(2);

      // Check first pad has correct format
      const pad1Parts = padShapes[0].split('~');
      expect(pad1Parts[0]).toBe('PAD');
      expect(pad1Parts[1]).toBe('RECT'); // shape
      expect(pad1Parts[8]).toBe('1');    // pin number
    });

    it('should deduplicate footprints for same component type', () => {
      const doc = createMinimalDoc();
      const resDef = createResistorDef();
      doc.sheets[0].components.push(
        { id: 'comp-1', libraryId: 'res_generic', designator: 'R1', value: '10k', position: { x: 100, y: 200 }, rotation: 0, mirror: false, pins: [], properties: { lcsc: 'C12345' } },
        { id: 'comp-2', libraryId: 'res_generic', designator: 'R2', value: '10k', position: { x: 200, y: 200 }, rotation: 0, mirror: false, pins: [], properties: { lcsc: 'C12345' } },
      );

      const libraryMap = new Map<string, ComponentDefinition>();
      libraryMap.set('res_generic', resDef);

      const fp = createFootprint();
      const footprintMap = new Map<string, FootprintDefinition>();
      footprintMap.set('C12345', fp);

      const result = serializeToEasyEDA(doc, libraryMap, footprintMap);

      // Should have exactly 1 footprint (not 2)
      expect(result.packageDetails!.length).toBe(1);
    });

    it('should work without footprintMap (backwards compatible)', () => {
      const doc = createMinimalDoc();
      const libraryMap = new Map<string, ComponentDefinition>();
      const result = serializeToEasyEDA(doc, libraryMap);

      expect(result.docType).toBe('1');
      expect(result.packageDetails).toBeUndefined();
    });
  });
});
