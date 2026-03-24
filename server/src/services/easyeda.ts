// ============================================================
// Smart Circuit — EasyEDA Component Fetcher
// Resolves MPN → LCSC# via JLCPCB, fetches full symbol/pin data
// from the EasyEDA API.
// ============================================================

const JLCSEARCH_BASE = 'https://jlcsearch.tscircuit.com';
const EASYEDA_BASE = 'https://easyeda.com';

// ----- Public Types -----

export interface ResolvedPin {
  number: string;
  name: string;
  type: 'input' | 'output' | 'bidirectional' | 'passive' | 'power';
  x: number;
  y: number;
  rotation: number;
}

export interface FootprintPad {
  number: string;
  x: number;      // mm
  y: number;      // mm
  width: number;  // mm
  height: number; // mm
  shape: 'rect' | 'circle' | 'oval';
  layerId: number;
  drill: number;  // mm, 0 for SMD
  rotation: number;
}

export interface FootprintData {
  name: string;           // Package name from head.c_para.package
  packageUuid: string;    // EasyEDA footprint library UUID
  pads: FootprintPad[];
  tracks: { layerId: number; strokeWidth: number; points: string }[];
}

export interface ResolvedComponent {
  lcsc: string;
  mpn: string;
  componentUuid: string;  // EasyEDA schematic symbol UUID
  packageName: string;
  manufacturer: string;
  pinCount: number;
  pins: ResolvedPin[];
  stock: number;
  price: number;
  basic: boolean;
  footprint?: FootprintData;
}

// ----- JLCPCB search result shape -----

interface JLCSearchHit {
  lcsc: number;
  mfr: string;
  package: string;
  stock: number;
  price: number;
  manufacturer?: string;
  is_preferred?: boolean;
  [key: string]: unknown;
}

// ----- Service -----

export class EasyEDAService {
  /**
   * Resolve a component by manufacturer part number.
   * Searches JLCPCB, picks the best match, fetches pin data from EasyEDA.
   */
  async resolveByMPN(mpn: string): Promise<ResolvedComponent | null> {
    // 1. Search JLCPCB for the LCSC part number
    const lcsc = await this.searchJLCPCB(mpn);
    if (!lcsc) return null;

    // 2. Fetch full component from EasyEDA
    return this.fetchByLCSC(lcsc, mpn);
  }

  /**
   * Search JLCPCB and return the best LCSC part number for a given MPN.
   */
  private async searchJLCPCB(mpn: string): Promise<string | null> {
    try {
      const url = `${JLCSEARCH_BASE}/api/search?q=${encodeURIComponent(mpn)}&limit=5`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const data = await res.json() as { components?: JLCSearchHit[] };
      const components = data.components ?? [];
      if (components.length === 0) return null;

      // Prefer exact MPN match, then preferred, then highest stock
      const exact = components.find(c =>
        c.mfr.toLowerCase() === mpn.toLowerCase()
      );
      const preferred = components.find(c => c.is_preferred);
      const best = exact ?? preferred ?? components[0];

      return `C${best.lcsc}`;
    } catch {
      return null;
    }
  }

  /**
   * Fetch component data from the EasyEDA API and parse pins.
   */
  async fetchByLCSC(lcsc: string, mpn?: string): Promise<ResolvedComponent | null> {
    try {
      const url = `${EASYEDA_BASE}/api/products/${lcsc}/components?version=6.5.22`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const data = await res.json() as EasyEDAResponse;
      if (!data.success || !data.result) return null;

      const result = data.result;
      const pins = this.parseShapePins(result.dataStr?.shape ?? []);

      // Pull sourcing info from JLCPCB/LCSC data
      const lcscData = result.lcsc ?? result.szlcsc;

      const resolved: ResolvedComponent = {
        lcsc,
        mpn: mpn ?? result.title ?? '',
        componentUuid: result.uuid || '',
        packageName: result.dataStr?.head?.c_para?.package ?? '',
        manufacturer: (result.dataStr?.head?.c_para?.Manufacturer as string) ?? '',
        pinCount: pins.length,
        pins,
        stock: lcscData?.stock ?? 0,
        price: lcscData?.price ?? 0,
        basic: !!(result as Record<string, unknown>).basic,
      };

      // Parse footprint data from packageDetail
      const packageDetail = result.packageDetail;
      if (packageDetail?.dataStr?.shape) {
        // Get footprint origin from head.x / head.y to normalize pad coordinates
        const fpOriginX = parseFloat(packageDetail.dataStr?.head?.x ?? '0');
        const fpOriginY = parseFloat(packageDetail.dataStr?.head?.y ?? '0');
        const footprintPads = this.parseFootprintPads(packageDetail.dataStr.shape, fpOriginX, fpOriginY);
        const footprintTracks = this.parseFootprintTracks(packageDetail.dataStr.shape, fpOriginX, fpOriginY);
        resolved.footprint = {
          name: packageDetail.dataStr?.head?.c_para?.package || '',
          packageUuid: packageDetail.uuid || '',
          pads: footprintPads,
          tracks: footprintTracks,
        };
      }

      return resolved;
    } catch {
      return null;
    }
  }

  /**
   * Parse pin definitions from EasyEDA shape array.
   *
   * EasyEDA pin format (^^ delimited fields):
   * P~show~0~{pinNumber}~{x}~{y}~{rotation}~{id}~0^^...^^M x y ...~#880000^^
   *   1~{textX}~{textY}~{rot}~{pinName}~...^^
   *   1~{textX}~{textY}~{rot}~{pinNumber}~...
   */
  private parseShapePins(shapes: string[]): ResolvedPin[] {
    const pins: ResolvedPin[] = [];

    for (const shape of shapes) {
      if (!shape.startsWith('P~')) continue;

      try {
        // Split by ^^ to get main sections
        const sections = shape.split('^^');
        const header = sections[0]; // P~show~0~pinNum~x~y~rot~id~...
        const headerParts = header.split('~');

        const pinNumber = headerParts[3] ?? '';
        const x = parseFloat(headerParts[4] ?? '0');
        const y = parseFloat(headerParts[5] ?? '0');
        const rotation = parseInt(headerParts[6] ?? '0', 10);

        // Find pin name — it's in one of the text sections (starting with 1~)
        // The name section has the pin name and uses a blue color (#0000FF)
        let pinName = pinNumber;

        for (let i = 2; i < sections.length; i++) {
          const section = sections[i];
          if (!section || section === '0') continue;

          // Text sections: 1~x~y~rot~text~alignment~~fontSize~color
          const textParts = section.split('~');
          if (textParts.length < 5) continue;

          const text = textParts[4] ?? '';
          const color = textParts[8] ?? '';

          // Pin name uses blue (#0000FF) color, pin number uses red (#FF0000) or black
          if (color === '#0000FF' && text && text !== pinNumber) {
            pinName = text;
            break;
          }
        }

        // If we still don't have a name, check for non-number text sections
        if (pinName === pinNumber) {
          for (let i = 2; i < sections.length; i++) {
            const section = sections[i];
            if (!section || section === '0') continue;
            const textParts = section.split('~');
            if (textParts.length < 5) continue;
            const text = textParts[4] ?? '';
            // Skip if it's just the pin number or empty
            if (text && text !== pinNumber && !/^\d+$/.test(text)) {
              pinName = text;
              break;
            }
          }
        }

        // Determine pin type from color/name heuristics
        const type = this.inferPinType(pinName);

        pins.push({ number: pinNumber, name: pinName, type, x, y, rotation });
      } catch {
        // Skip unparseable pin shapes
        continue;
      }
    }

    // Sort by pin number
    pins.sort((a, b) => {
      const na = parseInt(a.number, 10);
      const nb = parseInt(b.number, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.number.localeCompare(b.number);
    });

    return pins;
  }

  /**
   * Infer pin type from name heuristics.
   */
  private inferPinType(name: string): ResolvedPin['type'] {
    const upper = name.toUpperCase();
    if (['VCC', 'VDD', 'VIN', 'V+', '+V', 'AVCC', 'DVCC', 'VBAT', 'VBUS', 'VSYS'].includes(upper)) return 'power';
    if (['GND', 'VSS', 'AGND', 'DGND', 'V-', 'PGND', 'EPAD', 'EP'].includes(upper)) return 'power';
    if (upper.startsWith('OUT') || upper === 'DISCH' || upper === 'Q') return 'output';
    if (upper.startsWith('IN') || upper === 'TRIG' || upper === 'THRES' || upper === 'RST' || upper === 'RESET') return 'input';
    if (upper === 'CONT' || upper === 'CTRL') return 'input';
    return 'passive';
  }

  // ----- Footprint shape parsers -----

  /**
   * Parse PAD~ lines from packageDetail shape data.
   * Format: PAD~shape~cx~cy~w~h~layer~net~number~holeR~points~rot~id~holeLen~holePt~isPlated~isLocked
   * Coordinates are in EasyEDA units; converted to mm via: value * 10 * 0.0254
   */
  private parseFootprintPads(shapes: string[], originX = 0, originY = 0): FootprintPad[] {
    const pads: FootprintPad[] = [];
    const toMM = (val: string) => parseFloat(val || '0') * 10 * 0.0254;
    const originXmm = originX * 10 * 0.0254;
    const originYmm = originY * 10 * 0.0254;

    for (const shape of shapes) {
      if (!shape.startsWith('PAD~')) continue;
      try {
        const parts = shape.split('~');
        // parts[0] = 'PAD'
        const rawShape = (parts[1] || '').toUpperCase();
        const cx = toMM(parts[2]) - originXmm;
        const cy = toMM(parts[3]) - originYmm;
        const w = toMM(parts[4]);
        const h = toMM(parts[5]);
        const layerId = parseInt(parts[6] || '1', 10);
        // parts[7] = net (unused)
        const number = parts[8] || '';
        const holeRadius = toMM(parts[9]);
        // parts[10] = points (unused)
        const rotation = parseFloat(parts[11] || '0');

        let padShape: FootprintPad['shape'] = 'rect';
        if (rawShape === 'ELLIPSE') padShape = 'circle';
        else if (rawShape === 'OVAL') padShape = 'oval';

        pads.push({
          number,
          x: cx,
          y: cy,
          width: w,
          height: h,
          shape: padShape,
          layerId,
          drill: holeRadius * 2,  // radius → diameter
          rotation,
        });
      } catch {
        continue;
      }
    }

    // Sort by pad number
    pads.sort((a, b) => {
      const na = parseInt(a.number, 10);
      const nb = parseInt(b.number, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.number.localeCompare(b.number);
    });

    return pads;
  }

  /**
   * Parse TRACK~ lines for silkscreen / courtyard outlines.
   * Format: TRACK~strokeWidth~layerId~net~points~id~isLocked
   */
  private parseFootprintTracks(shapes: string[], originX = 0, originY = 0): FootprintData['tracks'] {
    const tracks: FootprintData['tracks'] = [];
    const toMM = (val: string) => parseFloat(val || '0') * 10 * 0.0254;
    const originXmm = originX * 10 * 0.0254;
    const originYmm = originY * 10 * 0.0254;

    for (const shape of shapes) {
      if (!shape.startsWith('TRACK~')) continue;
      try {
        const parts = shape.split('~');
        const strokeWidth = toMM(parts[1]);
        const layerId = parseInt(parts[2] || '0', 10);
        // parts[3] = net (unused)
        const rawPoints = parts[4] || '';

        // Convert point coordinates from EasyEDA units to mm
        const coords = rawPoints.trim().split(/\s+/);
        const mmCoords: string[] = [];
        for (let i = 0; i < coords.length; i++) {
          const val = parseFloat(coords[i]);
          if (!isNaN(val)) {
            // Alternate x,y pairs — subtract corresponding origin
            const origin = (i % 2 === 0) ? originXmm : originYmm;
            mmCoords.push(((val * 10 * 0.0254) - origin).toFixed(4));
          }
        }

        tracks.push({
          layerId,
          strokeWidth,
          points: mmCoords.join(' '),
        });
      } catch {
        continue;
      }
    }

    return tracks;
  }
}

// ----- EasyEDA API response types (partial) -----

interface EasyEDAResponse {
  success: boolean;
  result?: {
    uuid: string;
    title: string;
    lcsc?: { stock: number; price: number };
    szlcsc?: { stock: number; price: number };
    dataStr?: {
      head?: {
        c_para?: {
          package?: string;
          [key: string]: unknown;
        };
      };
      shape?: string[];
      [key: string]: unknown;
    };
    packageDetail?: {
      uuid: string;
      title: string;
      dataStr?: {
        head?: {
          x?: string;
          y?: string;
          c_para?: {
            package?: string;
            [key: string]: unknown;
          };
        };
        shape?: string[];
      };
    };
    SMT?: boolean;
    [key: string]: unknown;
  };
}
