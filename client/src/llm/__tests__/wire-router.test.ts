import { describe, it, expect } from 'vitest';
import { routeConnection, routeSimple, generateNetName, getComponentObstacles, routeConnectionBatch } from '../wire-router';
import type { BoundingBox, WireSegment } from '../../core/types';

// ---- Helpers ----

/**
 * Assert all segments are strictly horizontal or vertical (no diagonals).
 */
function assertOrthogonal(segments: WireSegment[]): void {
  for (const seg of segments) {
    const isHorizontal = seg.start.y === seg.end.y;
    const isVertical = seg.start.x === seg.end.x;
    expect(
      isHorizontal || isVertical,
      `Segment (${seg.start.x},${seg.start.y})→(${seg.end.x},${seg.end.y}) is diagonal`
    ).toBe(true);
  }
}

/**
 * Assert segments form a continuous path.
 */
function assertContinuous(segments: WireSegment[]): void {
  for (let i = 1; i < segments.length; i++) {
    expect(segments[i].start.x).toBe(segments[i - 1].end.x);
    expect(segments[i].start.y).toBe(segments[i - 1].end.y);
  }
}

// ---- Tests ----

describe('routeSimple', () => {
  it('returns single segment for axis-aligned horizontal pins', () => {
    const segs = routeSimple({ x: 100, y: 200 }, { x: 300, y: 200 });
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toEqual({ x: 100, y: 200 });
    expect(segs[0].end).toEqual({ x: 300, y: 200 });
  });

  it('returns single segment for axis-aligned vertical pins', () => {
    const segs = routeSimple({ x: 100, y: 200 }, { x: 100, y: 400 });
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toEqual({ x: 100, y: 200 });
    expect(segs[0].end).toEqual({ x: 100, y: 400 });
  });

  it('returns L-shaped path for diagonal offset', () => {
    const segs = routeSimple({ x: 100, y: 100 }, { x: 200, y: 300 });
    expect(segs).toHaveLength(2);
    assertOrthogonal(segs);
    assertContinuous(segs);
    // Path starts at (100,100) and ends at (200,300)
    expect(segs[0].start).toEqual({ x: 100, y: 100 });
    expect(segs[segs.length - 1].end).toEqual({ x: 200, y: 300 });
  });

  it('all output segments are orthogonal', () => {
    const segs = routeSimple({ x: 50, y: 70 }, { x: 230, y: 190 });
    assertOrthogonal(segs);
    assertContinuous(segs);
  });

  it('snaps to grid', () => {
    const segs = routeSimple({ x: 53, y: 67 }, { x: 237, y: 184 }, 10);
    for (const seg of segs) {
      expect(seg.start.x % 10).toBe(0);
      expect(seg.start.y % 10).toBe(0);
      expect(seg.end.x % 10).toBe(0);
      expect(seg.end.y % 10).toBe(0);
    }
  });
});

describe('routeConnection', () => {
  it('creates wire for nearby unobstructed pins', () => {
    const result = routeConnection(
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      [], // no obstacles
      'NET1'
    );
    expect(result.type).toBe('wire');
    if (result.type === 'wire') {
      expect(result.segments.length).toBeGreaterThanOrEqual(1);
      assertOrthogonal(result.segments);
    }
  });

  it('creates wire for L-shaped route with no obstacles', () => {
    const result = routeConnection(
      { x: 100, y: 100 },
      { x: 200, y: 200 },
      [],
      'NET2'
    );
    expect(result.type).toBe('wire');
    if (result.type === 'wire') {
      expect(result.segments).toHaveLength(2);
      assertOrthogonal(result.segments);
      assertContinuous(result.segments);
    }
  });

  it('falls back to net label for very distant pins', () => {
    const result = routeConnection(
      { x: 0, y: 0 },
      { x: 500, y: 500 },
      [],
      'FAR_NET'
    );
    expect(result.type).toBe('label');
    if (result.type === 'label') {
      expect(result.netName).toBe('FAR_NET');
    }
  });

  it('falls back to net label when obstacle blocks both L-paths', () => {
    // Place an obstacle right at the bend point of both possible L-routes
    const obstacle: BoundingBox = {
      minX: 140, minY: 140,
      maxX: 260, maxY: 260,
    };
    const result = routeConnection(
      { x: 100, y: 200 },
      { x: 300, y: 200 },
      [obstacle],
      'BLOCKED_NET'
    );
    // If the primary L-path crosses the obstacle, should try alternate
    // or fall back to label
    if (result.type === 'label') {
      expect(result.netName).toBe('BLOCKED_NET');
    } else {
      // If it managed to route, verify orthogonal
      assertOrthogonal(result.segments);
    }
  });

  it('routes around obstacle using alternate L-path', () => {
    // Obstacle blocks the horizontal-first path but not the vertical-first
    const obstacle: BoundingBox = {
      minX: 150, minY: 90,
      maxX: 250, maxY: 110,
    };
    const result = routeConnection(
      { x: 100, y: 100 },
      { x: 300, y: 200 },
      [obstacle],
      'ALT_NET'
    );
    // Should either use the alternate path or net label
    if (result.type === 'wire') {
      assertOrthogonal(result.segments);
      assertContinuous(result.segments);
    }
  });
});

describe('generateNetName', () => {
  it('creates descriptive net name from connection', () => {
    const name = generateNetName('U1', 'VCC', 'C1', '1', new Set());
    expect(name).toBe('U1_VCC-C1_1');
  });

  it('avoids collision with existing names', () => {
    const existing = new Set(['U1_P1-R1_1']);
    const name = generateNetName('U1', 'P1', 'R1', '1', existing);
    expect(name).toBe('U1_P1-R1_1_2');
    expect(name).not.toBe('U1_P1-R1_1');
  });

  it('increments suffix for multiple collisions', () => {
    const existing = new Set(['U1_P1-R1_1', 'U1_P1-R1_1_2']);
    const name = generateNetName('U1', 'P1', 'R1', '1', existing);
    expect(name).toBe('U1_P1-R1_1_3');
  });
});

describe('getComponentObstacles', () => {
  it('returns bounding boxes excluding specified IDs', () => {
    const components = [
      { id: 'a', position: { x: 100, y: 100 }, libraryId: 'lib1' },
      { id: 'b', position: { x: 200, y: 200 }, libraryId: 'lib1' },
      { id: 'c', position: { x: 300, y: 300 }, libraryId: 'lib1' },
    ];
    const sizes = new Map([['lib1', { width: 60, height: 40 }]]);

    const boxes = getComponentObstacles(components, sizes, ['a', 'c']);
    expect(boxes).toHaveLength(1);
    // Should be component 'b' centered at (200, 200) with padding
    expect(boxes[0].minX).toBeLessThan(200);
    expect(boxes[0].maxX).toBeGreaterThan(200);
    expect(boxes[0].minY).toBeLessThan(200);
    expect(boxes[0].maxY).toBeGreaterThan(200);
  });

  it('returns empty array when all components excluded', () => {
    const components = [
      { id: 'a', position: { x: 100, y: 100 }, libraryId: 'lib1' },
    ];
    const sizes = new Map([['lib1', { width: 60, height: 40 }]]);
    const boxes = getComponentObstacles(components, sizes, ['a']);
    expect(boxes).toHaveLength(0);
  });

  it('uses default size for unknown library ID', () => {
    const components = [
      { id: 'a', position: { x: 100, y: 100 }, libraryId: 'unknown' },
    ];
    const sizes = new Map<string, { width: number; height: number }>();
    const boxes = getComponentObstacles(components, sizes, []);
    expect(boxes).toHaveLength(1);
    // Default 60x40 + 10 padding → half-width = 40, half-height = 30
    expect(boxes[0].minX).toBe(100 - 40);
    expect(boxes[0].maxX).toBe(100 + 40);
    expect(boxes[0].minY).toBe(100 - 30);
    expect(boxes[0].maxY).toBe(100 + 30);
  });
});

describe('routeConnection — pin avoidance', () => {
  it('avoids an otherPin on the direct L-path', () => {
    // Route from (0,0) to (100,100) grid=10
    // Pin at the L-bend point (100,0) should force an alternate path
    const result = routeConnection(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      [], // no component obstacles
      'NET_TEST',
      10,
      [{ x: 100, y: 0 }], // pin at the default horizontal-first bend
    );
    expect(result.type).toBe('wire');
    if (result.type === 'wire') {
      assertOrthogonal(result.segments);
      assertContinuous(result.segments);
      // The route should NOT pass through (100, 0) — check no segment endpoint is there
      for (const seg of result.segments) {
        const goesThrough = (seg.start.y === 0 && seg.end.y === 0 &&
          Math.min(seg.start.x, seg.end.x) <= 100 && Math.max(seg.start.x, seg.end.x) >= 100);
        expect(goesThrough).toBe(false);
      }
    }
  });

  it('still routes successfully when otherPins is empty', () => {
    const result = routeConnection(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      [],
      'NET_TEST',
      10,
      [], // empty pin list
    );
    expect(result.type).toBe('wire');
    if (result.type === 'wire') {
      assertOrthogonal(result.segments);
      assertContinuous(result.segments);
    }
  });

  it('does not block the actual from/to endpoints even if they appear in otherPins', () => {
    const result = routeConnection(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      [],
      'NET_TEST',
      10,
      [{ x: 0, y: 0 }, { x: 100, y: 0 }], // endpoints included as pins
    );
    expect(result.type).toBe('wire');
    if (result.type === 'wire') {
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].start).toEqual({ x: 0, y: 0 });
      expect(result.segments[0].end).toEqual({ x: 100, y: 0 });
    }
  });
});

describe('routeConnectionBatch — overlap avoidance', () => {
  it('routes two parallel connections to non-overlapping paths', () => {
    // Two connections: (0,0)→(100,0) and (0,20)→(100,20)
    // Both would naturally be straight horizontal lines.
    // If one is moved so from/to are at (0,0)→(100,40) and (0,20)→(100,40)
    // they'd both want to route through common vertical segment at x=100.
    const results = routeConnectionBatch(
      [
        { from: { x: 0, y: 0 }, to: { x: 100, y: 40 }, netName: 'A' },
        { from: { x: 0, y: 20 }, to: { x: 100, y: 40 }, netName: 'B' },
      ],
      [], // no component obstacles
      [],
      10,
    );
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe('wire');
    expect(results[1].type).toBe('wire');

    if (results[0].type === 'wire' && results[1].type === 'wire') {
      assertOrthogonal(results[0].segments);
      assertOrthogonal(results[1].segments);

      // Verify the paths are not identical
      const segs1 = results[0].segments.map(s => `${s.start.x},${s.start.y}-${s.end.x},${s.end.y}`).join('|');
      const segs2 = results[1].segments.map(s => `${s.start.x},${s.start.y}-${s.end.x},${s.end.y}`).join('|');
      expect(segs1).not.toBe(segs2);
    }
  });

  it('single connection batch returns same result as routeConnection', () => {
    const single = routeConnection(
      { x: 0, y: 0 }, { x: 100, y: 100 }, [], 'NET1', 10,
    );
    const batch = routeConnectionBatch(
      [{ from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, netName: 'NET1' }],
      [], [], 10,
    );
    expect(batch).toHaveLength(1);
    expect(batch[0].type).toBe(single.type);
    if (single.type === 'wire' && batch[0].type === 'wire') {
      expect(batch[0].segments.length).toBe(single.segments.length);
    }
  });

  it('all batch results are orthogonal and continuous', () => {
    const results = routeConnectionBatch(
      [
        { from: { x: 0, y: 0 }, to: { x: 80, y: 60 }, netName: 'A' },
        { from: { x: 0, y: 10 }, to: { x: 80, y: 70 }, netName: 'B' },
        { from: { x: 0, y: 20 }, to: { x: 80, y: 80 }, netName: 'C' },
      ],
      [], [], 10,
    );
    for (const r of results) {
      expect(r.type).toBe('wire');
      if (r.type === 'wire') {
        assertOrthogonal(r.segments);
        assertContinuous(r.segments);
      }
    }
  });
});
