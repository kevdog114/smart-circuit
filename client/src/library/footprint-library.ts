// ============================================================
// Smart Circuit — Footprint Library
// Cache/registry for PCB footprint definitions with fallback
// generation for components without EasyEDA footprint data.
// ============================================================

// TODO: import FootprintDefinition, PadDefinition, PCBLayer from '../core/types' once Agent A merges
import type { FootprintDefinition, PadDefinition, PCBLayer } from './easyeda-parser';
import type { ComponentDefinition } from '../core/types';

// Alias for Component — uses the id from the definition + LCSC property
interface ComponentLike {
  definitionId: string;
  properties?: Record<string, string>;
}

export class FootprintLibrary {
  private cache = new Map<string, FootprintDefinition>();

  /**
   * Get a footprint from cache or return a generic fallback.
   * Looks up by LCSC number first, then definition ID.
   */
  getFootprint(component: ComponentLike, def: ComponentDefinition): FootprintDefinition {
    const lcsc = component.properties?.['lcsc'] ?? def.properties?.['lcsc'];
    if (lcsc && this.cache.has(lcsc)) {
      return this.cache.get(lcsc)!;
    }
    if (this.cache.has(def.id)) {
      return this.cache.get(def.id)!;
    }

    // Generate and cache a fallback
    const pinCount = def.symbol?.pins?.length ?? 2;
    const packageHint = def.properties?.['package'];
    const fallback = this.generateFallback(pinCount, packageHint);
    this.cache.set(def.id, fallback);
    return fallback;
  }

  /** Register a resolved EasyEDA footprint by LCSC number. */
  register(lcsc: string, footprint: FootprintDefinition): void {
    this.cache.set(lcsc, footprint);
  }

  /**
   * Generate a generic rectangular footprint based on pin count and package hint.
   *
   * Defaults:
   * - 2-pad passive (resistor/cap): 1.0mm × 0.6mm pads, 1.6mm apart
   * - IC (>2 pins): 0.4mm × 1.2mm pads, 1.27mm apart in two rows (SOIC-style)
   * - Through-hole: 1.6mm circular pads with 0.8mm drill
   */
  generateFallback(pinCount: number, packageHint?: string): FootprintDefinition {
    const isTH = packageHint ? /dip|through|th/i.test(packageHint) : false;
    const pads: PadDefinition[] = [];

    if (pinCount <= 2) {
      // SMD passive — 2 inline pads
      const padW = 1.0;
      const padH = 0.6;
      const spacing = 1.6;

      for (let i = 0; i < Math.max(pinCount, 2); i++) {
        const x = i === 0 ? -spacing / 2 : spacing / 2;
        pads.push({
          id: `pad_${i + 1}`,
          pinId: `${i + 1}`,
          x,
          y: 0,
          width: padW,
          height: padH,
          shape: 'rect',
          layer: 'F.Cu' as PCBLayer,
          drill: 0,
          rotation: 0,
        });
      }
    } else if (isTH) {
      // Through-hole — two rows
      const halfCount = Math.ceil(pinCount / 2);
      const spacing = 2.54; // standard 0.1" pitch
      const rowGap = spacing * 3;
      const padSize = 1.6;
      const drill = 0.8;

      for (let i = 0; i < pinCount; i++) {
        const isLeft = i < halfCount;
        const rowIndex = isLeft ? i : (pinCount - 1 - i);
        const x = isLeft ? -rowGap / 2 : rowGap / 2;
        const y = (rowIndex - (halfCount - 1) / 2) * spacing;
        pads.push({
          id: `pad_${i + 1}`,
          pinId: `${i + 1}`,
          x,
          y,
          width: padSize,
          height: padSize,
          shape: 'circle',
          layer: 'F.Cu' as PCBLayer,
          drill,
          rotation: 0,
        });
      }
    } else {
      // SMD IC — SOIC-style two-row layout
      const halfCount = Math.ceil(pinCount / 2);
      const padW = 0.4;
      const padH = 1.2;
      const pitch = 1.27;
      const rowGap = pitch * 3;

      for (let i = 0; i < pinCount; i++) {
        const isLeft = i < halfCount;
        const rowIndex = isLeft ? i : (pinCount - 1 - i);
        const x = isLeft ? -rowGap / 2 : rowGap / 2;
        const y = (rowIndex - (halfCount - 1) / 2) * pitch;
        pads.push({
          id: `pad_${i + 1}`,
          pinId: `${i + 1}`,
          x,
          y,
          width: padW,
          height: padH,
          shape: 'rect',
          layer: 'F.Cu' as PCBLayer,
          drill: 0,
          rotation: 0,
        });
      }
    }

    // Calculate courtyard from pad extents
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pad of pads) {
      const hw = pad.width / 2;
      const hh = pad.height / 2;
      minX = Math.min(minX, pad.x - hw);
      minY = Math.min(minY, pad.y - hh);
      maxX = Math.max(maxX, pad.x + hw);
      maxY = Math.max(maxY, pad.y + hh);
    }
    const margin = 0.25;

    return {
      id: `fp_fallback_${pinCount}`,
      name: packageHint ?? `Generic-${pinCount}`,
      pads,
      courtyard: {
        x: minX - margin,
        y: minY - margin,
        width: (maxX - minX) + 2 * margin,
        height: (maxY - minY) + 2 * margin,
      },
      silkscreen: [],
    };
  }
}
