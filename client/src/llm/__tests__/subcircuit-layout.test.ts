import { describe, it, expect } from 'vitest';
import { layoutSubcircuit } from '../subcircuit-layout';
import type { ComponentDefinition } from '../../core/types';

// ---- Test Helpers ----

function makeResDef(): ComponentDefinition {
  return {
    id: 'lib-res', name: 'Resistor', description: 'Generic resistor',
    category: 'passives', designatorPrefix: 'R', properties: {}, tags: [], defaultValue: '10k',
    symbol: {
      id: 'sym-res', name: 'Resistor', width: 60, height: 20,
      origin: { x: 0, y: 0 },
      pins: [
        { id: 'pin1', name: '1', type: 'passive', position: { x: -30, y: 0 }, orientation: 'left', length: 10 },
        { id: 'pin2', name: '2', type: 'passive', position: { x: 30, y: 0 }, orientation: 'right', length: 10 },
      ],
      graphics: [],
      designatorPosition: { x: 0, y: -15 },
      valuePosition: { x: 0, y: 15 },
    },
  };
}

function makeCapDef(): ComponentDefinition {
  return {
    id: 'lib-cap', name: 'Capacitor', description: 'Generic capacitor',
    category: 'passives', designatorPrefix: 'C', properties: {}, tags: [], defaultValue: '100nF',
    symbol: {
      id: 'sym-cap', name: 'Capacitor', width: 30, height: 40,
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

function makeICDef(pinCount = 3): ComponentDefinition {
  const pins = [];
  for (let i = 0; i < pinCount; i++) {
    pins.push({
      id: `pin${i + 1}`,
      name: `P${i + 1}`,
      type: 'passive' as const,
      position: { x: i < pinCount / 2 ? -40 : 40, y: (i % Math.ceil(pinCount / 2)) * 20 - 15 },
      orientation: (i < pinCount / 2 ? 'left' : 'right') as 'left' | 'right',
      length: 10,
    });
  }

  return {
    id: 'lib-ic', name: 'IC', description: 'Generic IC',
    category: 'ics_digital', designatorPrefix: 'U', properties: {}, tags: [], defaultValue: 'IC',
    symbol: {
      id: 'sym-ic', name: 'IC', width: 80, height: 60,
      origin: { x: 0, y: 0 },
      pins,
      graphics: [],
      designatorPosition: { x: 0, y: -35 },
      valuePosition: { x: 0, y: 40 },
    },
  };
}

/**
 * Check that no two component bounding boxes overlap.
 * Uses center positions and symbol sizes with MIN_SPACING.
 */
function hasOverlaps(
  results: { position: { x: number; y: number }; def: ComponentDefinition }[]
): boolean {
  const MIN_SPACING = 80;
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i];
      const b = results[j];
      const aw = Math.max(a.def.symbol.width, 40);
      const ah = Math.max(a.def.symbol.height, 30);
      const bw = Math.max(b.def.symbol.width, 40);
      const bh = Math.max(b.def.symbol.height, 30);

      const overlapX = !(
        a.position.x + aw / 2 + MIN_SPACING / 2 <= b.position.x - bw / 2 - MIN_SPACING / 2 ||
        b.position.x + bw / 2 + MIN_SPACING / 2 <= a.position.x - aw / 2 - MIN_SPACING / 2
      );
      const overlapY = !(
        a.position.y + ah / 2 + MIN_SPACING / 2 <= b.position.y - bh / 2 - MIN_SPACING / 2 ||
        b.position.y + bh / 2 + MIN_SPACING / 2 <= a.position.y - ah / 2 - MIN_SPACING / 2
      );

      if (overlapX && overlapY) return true;
    }
  }
  return false;
}

// ---- Tests ----

describe('layoutSubcircuit', () => {
  it('returns empty array for zero components', () => {
    const result = layoutSubcircuit([], [], [], { x: 200, y: 200 });
    expect(result).toEqual([]);
  });

  it('places single component at base position (grid-snapped)', () => {
    const def = makeResDef();
    const result = layoutSubcircuit(
      [{ designator: 'R1', value: '10k' }],
      [],
      [def],
      { x: 205, y: 195 }
    );
    expect(result).toHaveLength(1);
    expect(result[0].designator).toBe('R1');
    // Should be snapped to nearest grid (10px)
    expect(result[0].position.x % 10).toBe(0);
    expect(result[0].position.y % 10).toBe(0);
    expect(result[0].position).toEqual({ x: 210, y: 200 });
  });

  it('arranges unconnected components in a grid (not a column)', () => {
    const r = makeResDef();
    const c = makeCapDef();
    const components = [
      { designator: 'R1', value: '10k' },
      { designator: 'R2', value: '22k' },
      { designator: 'C1', value: '100nF' },
      { designator: 'C2', value: '10uF' },
    ];
    const defs = [r, r, c, c];
    const result = layoutSubcircuit(components, [], defs, { x: 200, y: 200 });

    expect(result).toHaveLength(4);

    // Should NOT all have the same X position (not a column)
    const xs = new Set(result.map(r => r.position.x));
    expect(xs.size).toBeGreaterThan(1);

    // No overlaps
    expect(hasOverlaps(result)).toBe(false);
  });

  it('lays out linear signal path left-to-right (RC filter)', () => {
    const r = makeResDef();
    const c = makeCapDef();
    const result = layoutSubcircuit(
      [
        { designator: 'R1', value: '10k' },
        { designator: 'C1', value: '100nF' },
      ],
      [
        { fromDesignator: 'R1', fromPin: '2', toDesignator: 'C1', toPin: '1' },
      ],
      [r, c],
      { x: 200, y: 200 }
    );

    expect(result).toHaveLength(2);

    // R1 should be to the left of C1 (linear signal path)
    const r1 = result.find(r => r.designator === 'R1')!;
    const c1 = result.find(r => r.designator === 'C1')!;
    expect(r1.position.x).toBeLessThan(c1.position.x);

    // No overlaps
    expect(hasOverlaps(result)).toBe(false);
  });

  it('places IC centrally with passives around it', () => {
    const ic = makeICDef(6);
    const c1 = makeCapDef();
    const c2 = makeCapDef();
    const r = makeResDef();

    const components = [
      { designator: 'U1', value: 'LM7805' },
      { designator: 'C1', value: '100nF' },
      { designator: 'C2', value: '10uF' },
      { designator: 'R1', value: '10k' },
    ];
    const connections = [
      { fromDesignator: 'U1', fromPin: 'P1', toDesignator: 'C1', toPin: '1' },
      { fromDesignator: 'U1', fromPin: 'P2', toDesignator: 'C2', toPin: '1' },
      { fromDesignator: 'U1', fromPin: 'P3', toDesignator: 'R1', toPin: '1' },
    ];
    const defs = [ic, c1, c2, r];

    const result = layoutSubcircuit(components, connections, defs, { x: 300, y: 300 });

    expect(result).toHaveLength(4);

    // U1 (IC) should be at or near the base position
    const u1 = result.find(r => r.designator === 'U1')!;
    expect(u1.position.x).toBe(300);
    expect(u1.position.y).toBe(300);

    // Passives should NOT all be at the same position as the IC
    const otherPositions = result.filter(r => r.designator !== 'U1');
    for (const comp of otherPositions) {
      const dx = Math.abs(comp.position.x - u1.position.x);
      const dy = Math.abs(comp.position.y - u1.position.y);
      expect(dx + dy).toBeGreaterThan(0);
    }

    // No overlaps
    expect(hasOverlaps(result)).toBe(false);
  });

  it('all positions are grid-snapped (multiples of 10)', () => {
    const ic = makeICDef(4);
    const r = makeResDef();
    const c = makeCapDef();

    const result = layoutSubcircuit(
      [
        { designator: 'U1', value: 'IC' },
        { designator: 'R1', value: '10k' },
        { designator: 'C1', value: '100nF' },
      ],
      [
        { fromDesignator: 'U1', fromPin: 'P1', toDesignator: 'R1', toPin: '1' },
        { fromDesignator: 'U1', fromPin: 'P2', toDesignator: 'C1', toPin: '1' },
      ],
      [ic, r, c],
      { x: 200, y: 200 }
    );

    for (const comp of result) {
      expect(comp.position.x % 10).toBe(0);
      expect(comp.position.y % 10).toBe(0);
    }
  });

  it('handles larger subcircuit with multiple passives without overlaps', () => {
    const ic = makeICDef(8);
    const r = makeResDef();
    const c = makeCapDef();

    const components = [
      { designator: 'U1', value: 'ATmega328P' },
      { designator: 'C1', value: '100nF' },
      { designator: 'C2', value: '100nF' },
      { designator: 'C3', value: '10uF' },
      { designator: 'R1', value: '10k' },
      { designator: 'R2', value: '1k' },
    ];
    const connections = [
      { fromDesignator: 'U1', fromPin: 'P1', toDesignator: 'C1', toPin: '1' },
      { fromDesignator: 'U1', fromPin: 'P2', toDesignator: 'C2', toPin: '1' },
      { fromDesignator: 'U1', fromPin: 'P3', toDesignator: 'R1', toPin: '1' },
      { fromDesignator: 'U1', fromPin: 'P4', toDesignator: 'R2', toPin: '1' },
      { fromDesignator: 'U1', fromPin: 'P5', toDesignator: 'C3', toPin: '1' },
    ];
    const defs = [ic, c, c, c, r, r];

    const result = layoutSubcircuit(components, connections, defs, { x: 400, y: 400 });

    expect(result).toHaveLength(6);
    expect(hasOverlaps(result)).toBe(false);

    // Verify all grid-snapped
    for (const comp of result) {
      expect(comp.position.x % 10).toBe(0);
      expect(comp.position.y % 10).toBe(0);
    }
  });

  it('preserves designator and value in output', () => {
    const r = makeResDef();
    const result = layoutSubcircuit(
      [
        { designator: 'R1', value: '4.7k' },
        { designator: 'R2', value: '100Ω' },
      ],
      [
        { fromDesignator: 'R1', fromPin: '2', toDesignator: 'R2', toPin: '1' },
      ],
      [r, r],
      { x: 200, y: 200 }
    );

    expect(result[0].designator).toBe('R1');
    expect(result[0].value).toBe('4.7k');
    expect(result[1].designator).toBe('R2');
    expect(result[1].value).toBe('100Ω');
  });

  it('includes component defs in output', () => {
    const r = makeResDef();
    const c = makeCapDef();
    const result = layoutSubcircuit(
      [{ designator: 'R1', value: '10k' }, { designator: 'C1', value: '100nF' }],
      [],
      [r, c],
      { x: 200, y: 200 }
    );

    expect(result[0].def.id).toBe('lib-res');
    expect(result[1].def.id).toBe('lib-cap');
  });

  // ---- Gemini-provided position tests ----

  it('uses Gemini-provided positions when all components have x/y', () => {
    const r = makeResDef();
    const c = makeCapDef();
    const result = layoutSubcircuit(
      [
        { designator: 'R1', value: '10k', x: 0, y: 0 },
        { designator: 'C1', value: '100nF', x: 200, y: 0 },
      ],
      [
        { fromDesignator: 'R1', fromPin: '2', toDesignator: 'C1', toPin: '1' },
      ],
      [r, c],
      { x: 300, y: 300 }
    );

    expect(result).toHaveLength(2);
    // Positions should be base + hint, snapped to grid
    expect(result[0].position).toEqual({ x: 300, y: 300 });
    expect(result[1].position).toEqual({ x: 500, y: 300 });
    expect(hasOverlaps(result)).toBe(false);
  });

  it('falls back to algorithmic layout when only some components have x/y', () => {
    const r = makeResDef();
    const c = makeCapDef();
    const result = layoutSubcircuit(
      [
        { designator: 'R1', value: '10k', x: 0, y: 0 },
        { designator: 'C1', value: '100nF' }, // no x/y
      ],
      [
        { fromDesignator: 'R1', fromPin: '2', toDesignator: 'C1', toPin: '1' },
      ],
      [r, c],
      { x: 200, y: 200 }
    );

    expect(result).toHaveLength(2);
    // Should use algorithmic layout (linear, since no ICs)
    // R1 should be to the left of C1
    const r1 = result.find(r => r.designator === 'R1')!;
    const c1 = result.find(r => r.designator === 'C1')!;
    expect(r1.position.x).toBeLessThan(c1.position.x);
    expect(hasOverlaps(result)).toBe(false);
  });

  it('resolves overlapping Gemini-provided positions', () => {
    const r = makeResDef();
    const result = layoutSubcircuit(
      [
        { designator: 'R1', value: '10k', x: 0, y: 0 },
        { designator: 'R2', value: '22k', x: 0, y: 0 }, // same position!
      ],
      [],
      [r, r],
      { x: 200, y: 200 }
    );

    expect(result).toHaveLength(2);
    // Collision resolution should push the second one away
    expect(
      result[0].position.x !== result[1].position.x ||
      result[0].position.y !== result[1].position.y
    ).toBe(true);
    expect(hasOverlaps(result)).toBe(false);
  });

  it('uses Gemini hint for single component with x/y', () => {
    const r = makeResDef();
    const result = layoutSubcircuit(
      [{ designator: 'R1', value: '10k', x: 50, y: -30 }],
      [],
      [r],
      { x: 200, y: 200 }
    );

    expect(result).toHaveLength(1);
    // base (200,200) + hint (50,-30) = (250, 170), snapped to grid
    expect(result[0].position).toEqual({ x: 250, y: 170 });
  });
});
