# Agent B — EasyEDA Footprint Parsing

## Objective
Extend the EasyEDA integration to fetch and parse real PCB footprint data (pad positions, sizes, shapes) from the EasyEDA API. The API already returns this data in `result.packageDetail.dataStr.shape` but the current code ignores it.

## Context
- The project is at `/Users/klschaefer/dev-projects/smart-circuit`
- **Server EasyEDA service:** `server/src/services/easyeda.ts` — fetches from `easyeda.com/api/products/{lcsc}/components`
- **Server route:** `server/src/routes/components.ts` — exposes `/api/components/resolve?mpn=...`
- **Client parser:** `client/src/library/easyeda-parser.ts` — converts server response into `ComponentDefinition`
- **Client types:** `client/src/core/types.ts` — will contain new PCB types (being added by Agent A)
- The API response already includes `packageDetail` with footprint shape data, but the current code only parses schematic symbol shapes (lines starting with `P~` for pins)

## EasyEDA Footprint Shape Format

The `packageDetail.dataStr.shape` array contains strings, each starting with a designator:

**PAD format (tilde-delimited):**
```
PAD~shape~center_x~center_y~width~height~layer_id~net~number~hole_radius~points~rotation~id~hole_length~hole_point~is_plated~is_locked
```

Fields:
- `shape`: "ELLIPSE", "RECT", "OVAL"  
- `center_x`, `center_y`: position in EasyEDA units (mils × 10)
- `width`, `height`: pad dimensions in EasyEDA units
- `hole_radius`: drill radius (0 for SMD)
- `number`: pad number (maps to pin number in schematic)
- `layer_id`: 1=F.Cu, 2=B.Cu, 11=Inner1, 12=Inner2
- `rotation`: pad rotation in degrees

**Unit conversion:** `value * 10 * 0.0254` converts EasyEDA units to mm

**TRACK format (silkscreen/courtyard outlines):**
```
TRACK~stroke_width~layer_id~net~points~id~is_locked
```
- `points` is a space-separated string of x,y coordinates
- Layer 3 = F.SilkS, Layer 4 = B.SilkS

## Deliverables

### 1. Modify `server/src/services/easyeda.ts`

**Add footprint parsing method:**
```typescript
private parseFootprintPads(shapes: string[]): FootprintPad[] {
  // Parse PAD~ lines from packageDetail.dataStr.shape
  // Convert coordinates from EasyEDA units to mm
  // Map layer IDs to layer names
}
```

**Extend `fetchByLCSC` to include footprint data:**

The current response shape is `ResolvedComponent`. Extend it:

```typescript
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
  pads: FootprintPad[];
  tracks: { layerId: number; strokeWidth: number; points: string; }[];
}

export interface ResolvedComponent {
  // ... existing fields ...
  footprint?: FootprintData;
}
```

In `fetchByLCSC()`, after parsing schematic pins, also parse `result.packageDetail?.dataStr?.shape`:
```typescript
// After existing pin parsing...
const packageDetail = result.packageDetail;
if (packageDetail?.dataStr?.shape) {
  const footprintPads = this.parseFootprintPads(packageDetail.dataStr.shape);
  const footprintTracks = this.parseFootprintTracks(packageDetail.dataStr.shape);
  resolved.footprint = {
    name: packageDetail.dataStr?.head?.c_para?.package || '',
    pads: footprintPads,
    tracks: footprintTracks,
  };
}
```

**You will need to update the `EasyEDAResponse` type** to include `packageDetail`:
```typescript
interface EasyEDAResponse {
  success: boolean;
  result?: {
    // ... existing ...
    packageDetail?: {
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
```

### 2. Modify `client/src/library/easyeda-parser.ts`

**Add footprint conversion function:**

```typescript
export interface FootprintPadResponse {
  number: string;
  x: number; y: number;
  width: number; height: number;
  shape: 'rect' | 'circle' | 'oval';
  layerId: number;
  drill: number;
  rotation: number;
}

export interface FootprintResponse {
  name: string;
  pads: FootprintPadResponse[];
  tracks: { layerId: number; strokeWidth: number; points: string; }[];
}

// Add to ResolvedComponentResponse:
export interface ResolvedComponentResponse {
  // ... existing fields ...
  footprint?: FootprintResponse;
}
```

Add a function to convert footprint response into the PCB types:

```typescript
export function resolvedFootprintToDefinition(
  footprint: FootprintResponse,
  lcsc: string,
  schematicPins: { number: string; name: string }[]
): FootprintDefinition {
  // Map each FootprintPadResponse to a PadDefinition
  // Use schematicPins to set pinId (match by pad.number == pin.number)
  // Calculate courtyard bounding box from pad extents
  // Parse TRACK shapes for silkscreen graphics
}
```

**EasyEDA layer ID mapping:**
```typescript
const LAYER_MAP: Record<number, PCBLayer> = {
  1: 'F.Cu',
  2: 'B.Cu',
  3: 'F.SilkS',
  4: 'B.SilkS',
  11: 'In1.Cu',
  12: 'In2.Cu',
};
```

### 3. Create `client/src/library/footprint-library.ts`

A cache/registry for footprint definitions:

```typescript
export class FootprintLibrary {
  private cache = new Map<string, FootprintDefinition>();

  /** Get a footprint from cache or return a generic fallback */
  getFootprint(component: Component, def: ComponentDefinition): FootprintDefinition;

  /** Register a resolved EasyEDA footprint */
  register(lcsc: string, footprint: FootprintDefinition): void;

  /** Generate a generic rectangular footprint based on pin count */
  generateFallback(pinCount: number, packageHint?: string): FootprintDefinition;
}
```

The fallback footprint generator should create simple 2-row pad layouts for ICs (like DIP/SOIC) or inline pads for passives (2-pad for resistors/caps). Use reasonable default pad sizes:
- SMD passive (2 pads): 1.0mm × 0.6mm pads, 1.6mm apart
- SMD IC: 0.4mm × 1.2mm pads, spaced 1.27mm apart in two rows
- Through-hole: 1.6mm circular pads with 0.8mm drill

## Important Notes
- Agent A is adding `PadDefinition`, `FootprintDefinition`, `PCBLayer` etc. to `types.ts`. If those types aren't available yet, define them locally in your files and leave a TODO comment — they'll be unified later.
- Do NOT modify `canvas-renderer.ts`, `main.ts`, `tool-executor.ts`, or any UI files
- Test the server changes by calling `curl http://localhost:3001/api/components/resolve?mpn=NE555` and verifying the response includes a `footprint` field with pads
- The server runs with `npm run dev` in `/server` — it hot-reloads on save
