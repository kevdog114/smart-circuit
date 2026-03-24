import { describe, it, expect } from 'vitest';
import { FootprintLibrary } from '../footprint-library';
import type { FootprintDefinition } from '../easyeda-parser';

describe('FootprintLibrary', () => {
  describe('generateFallback', () => {
    it('generates a 2-pad passive footprint', () => {
      const lib = new FootprintLibrary();
      const fp = lib.generateFallback(2);

      expect(fp.pads).toHaveLength(2);
      expect(fp.name).toBe('Generic-2');

      // Check pad dimensions (1.0mm × 0.6mm)
      for (const pad of fp.pads) {
        expect(pad.width).toBeCloseTo(1.0);
        expect(pad.height).toBeCloseTo(0.6);
        expect(pad.shape).toBe('rect');
        expect(pad.drill).toBe(0);
        expect(pad.layer).toBe('F.Cu');
      }

      // Check spacing — 1.6mm apart
      const dx = Math.abs(fp.pads[1].x - fp.pads[0].x);
      expect(dx).toBeCloseTo(1.6);
    });

    it('generates an 8-pad SOIC layout for ICs', () => {
      const lib = new FootprintLibrary();
      const fp = lib.generateFallback(8);

      expect(fp.pads).toHaveLength(8);

      // All SMD pads (no drill)
      for (const pad of fp.pads) {
        expect(pad.drill).toBe(0);
        expect(pad.shape).toBe('rect');
      }

      // Should have two rows — 4 pads on left (negative x), 4 on right (positive x)
      const leftPads = fp.pads.filter(p => p.x < 0);
      const rightPads = fp.pads.filter(p => p.x > 0);
      expect(leftPads).toHaveLength(4);
      expect(rightPads).toHaveLength(4);

      // Check SOIC pad dimensions (0.4mm × 1.2mm)
      for (const pad of fp.pads) {
        expect(pad.width).toBeCloseTo(0.4);
        expect(pad.height).toBeCloseTo(1.2);
      }
    });

    it('generates through-hole pads when package hint contains "DIP"', () => {
      const lib = new FootprintLibrary();
      const fp = lib.generateFallback(8, 'DIP-8');

      expect(fp.pads).toHaveLength(8);

      // Through-hole: circular pads with 0.8mm drill
      for (const pad of fp.pads) {
        expect(pad.shape).toBe('circle');
        expect(pad.drill).toBeCloseTo(0.8);
        expect(pad.width).toBeCloseTo(1.6);
        expect(pad.height).toBeCloseTo(1.6);
      }
    });

    it('generates a valid courtyard bounding box', () => {
      const lib = new FootprintLibrary();
      const fp = lib.generateFallback(4);

      expect(fp.courtyard.width).toBeGreaterThan(0);
      expect(fp.courtyard.height).toBeGreaterThan(0);

      // All pads should be inside the courtyard
      for (const pad of fp.pads) {
        expect(pad.x).toBeGreaterThanOrEqual(fp.courtyard.x);
        expect(pad.y).toBeGreaterThanOrEqual(fp.courtyard.y);
        expect(pad.x).toBeLessThanOrEqual(fp.courtyard.x + fp.courtyard.width);
        expect(pad.y).toBeLessThanOrEqual(fp.courtyard.y + fp.courtyard.height);
      }
    });
  });

  describe('register / getFootprint', () => {
    it('returns a registered footprint by LCSC number', () => {
      const lib = new FootprintLibrary();
      const fp: FootprintDefinition = {
        id: 'fp_C12345',
        name: 'SOIC-8',
        pads: [],
        courtyard: { x: 0, y: 0, width: 5, height: 5 },
        silkscreen: [],
      };

      lib.register('C12345', fp);

      const result = lib.getFootprint(
        { definitionId: 'some_def', properties: { lcsc: 'C12345' } },
        { id: 'some_def', name: 'NE555', symbol: { pins: [] } } as any
      );

      expect(result).toBe(fp);
      expect(result.name).toBe('SOIC-8');
    });

    it('falls back to generated footprint when LCSC not cached', () => {
      const lib = new FootprintLibrary();
      const result = lib.getFootprint(
        { definitionId: 'def_1', properties: {} },
        { id: 'def_1', name: 'R1', symbol: { pins: [{}, {}] }, properties: {} } as any
      );

      // Should generate a 2-pad passive
      expect(result.pads).toHaveLength(2);
    });
  });
});
