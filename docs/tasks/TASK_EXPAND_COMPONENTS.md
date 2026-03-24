# Agent Task: Expand Built-in Component Library

## Objective
Add more built-in schematic symbols to the component library so users can design real circuits.

## Context
- The app is a Vite + TypeScript schematic editor at `/Users/klschaefer/dev-projects/smart-circuit/`
- **Library spec**: Read `docs/COMPONENT_LIBRARY.md` — types and conventions
- **Data model**: Read `client/src/core/types.ts` — `ComponentDefinition`, `SymbolDefinition`, `PinDefinition`

## What Exists
- `client/src/main.ts` — has 6 inline `ComponentDefinition` objects (~line 12-130):
  - `res_generic` (Resistor), `cap_generic` (Capacitor), `led_generic` (LED)
  - `ic_generic` (Generic IC), `pwr_gnd` (GND), `pwr_vcc` (VCC)
- Components are defined inline with symbol graphics (lines, rects, polylines, circles)
- Each needs: `id`, `name`, `designatorPrefix`, `defaultValue`, `symbol` with `pins` and `graphics`

## What to Build

### New Components (~10 more)
Add these to the `builtinLibrary` array in `main.ts` (or better, extract to a separate `client/src/library/builtin-library.ts` file):

| ID | Name | Prefix | Pins | Symbol Shape |
|----|------|--------|------|-------------|
| `cap_polarized` | Electrolytic Cap | C | 2 (+, −) | Curved + straight line |
| `ind_generic` | Inductor | L | 2 | Coil/bumps |
| `diode_generic` | Diode | D | 2 (A, K) | Triangle + bar |
| `zener_generic` | Zener Diode | D | 2 (A, K) | Modified diode |
| `npn_generic` | NPN Transistor | Q | 3 (B, C, E) | BJT symbol |
| `pnp_generic` | PNP Transistor | Q | 3 (B, C, E) | BJT symbol (reversed arrow) |
| `nmos_generic` | N-MOSFET | Q | 3 (G, D, S) | FET symbol |
| `opamp_generic` | Op-Amp | U | 5 (+in, −in, out, V+, V−) | Triangle |
| `header_1x2` | 2-Pin Header | J | 2 | Rectangle with pins |
| `header_1x4` | 4-Pin Header | J | 4 | Rectangle with pins |
| `pwr_3v3` | +3V3 | #PWR | 1 | Arrow up + label |
| `pwr_5v` | +5V | #PWR | 1 | Arrow up + label |

### Recommended Refactoring
Extract the `builtinLibrary` array from `main.ts` into `client/src/library/builtin-library.ts`:
```typescript
export const builtinLibrary: ComponentDefinition[] = [ ... ];
```
Then import it in `main.ts`. This keeps `main.ts` clean.

## Symbol Drawing Guide
Symbols are centered at (0,0). Use these graphic primitives:
- `{ type: 'line', properties: { x1, y1, x2, y2 } }`
- `{ type: 'rect', properties: { x, y, width, height, fill } }`
- `{ type: 'circle', properties: { cx, cy, r } }`
- `{ type: 'polyline', properties: { points: [{x,y}, ...] } }`
- `{ type: 'text', properties: { x, y, text, fontSize } }`

Pin positions define where wires connect. Keep them on grid multiples of 20.

## Acceptance Criteria
1. All new components appear in the library sidebar
2. Each renders with a recognizable schematic symbol on canvas
3. Pin positions are correct (wires can connect to them)
4. Designator auto-increment works (Q1, Q2, Q3... for transistors)
5. `main.ts` is cleaner with components extracted to a separate file

## Key Files to Read First
- `client/src/main.ts` (existing component definitions, lines ~12-130)
- `client/src/core/types.ts` (`ComponentDefinition`, `SymbolDefinition`)
- `client/src/schematic/canvas-renderer.ts` (`renderSymbol` method, ~line 280)
