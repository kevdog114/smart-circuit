# Agent A — Netlist Generator

## Objective
Convert the in-memory `CircuitDocument` into a valid SPICE netlist string that ngspice can simulate. This is the bridge between the schematic editor and the simulation engine.

## Context
- The project is a circuit schematic editor at `/Users/klschaefer/dev-projects/smart-circuit`
- Read the core data model: `client/src/core/types.ts` — especially `CircuitDocument`, `Sheet`, `Component`, `Pin`, `Net`, `Wire`, `NetLabel`
- Read the component library: `client/src/library/builtin-library.ts` — to understand `ComponentDefinition` and `SymbolDefinition`
- Read tests for patterns: `client/src/core/__tests__/document.test.ts`
- The app uses TypeScript with Vite (client) and Vitest for testing
- **Scope:** R, C, L + voltage/current sources ONLY (no diodes, transistors, op-amps)

## Deliverables

### 1. Create `client/src/simulation/netlist-generator.ts`

Export a function and supporting types:

```typescript
export interface SimulationConfig {
  analysis: 'transient' | 'ac' | 'dc' | 'op';
  // Transient
  stepTime?: string;  // e.g. "1u" = 1µs
  stopTime?: string;  // e.g. "10m" = 10ms
  // AC
  acType?: 'dec' | 'oct' | 'lin';
  acPoints?: number;
  fStart?: string;    // e.g. "1" = 1Hz
  fStop?: string;     // e.g. "1Meg"
  // DC
  dcSource?: string;  // designator of source to sweep
  dcStart?: string;
  dcStop?: string;
  dcStep?: string;
}

export interface NetlistResult {
  netlist: string;
  nodeMap: Map<string, string>;  // net name → SPICE node number
  errors: string[];              // fatal: "No ground node found"
  warnings: string[];            // non-fatal: "R3 is floating"
}

export function generateNetlist(
  doc: CircuitDocument,
  config: SimulationConfig,
  libraryMap: Map<string, ComponentDefinition>
): NetlistResult;
```

**Algorithm:**

1. **Build node map** — Walk every `Net` in `doc.sheets[0]`. Each unique net becomes a SPICE node. Assign node numbers (SPICE uses integer node IDs, but names also work in ngspice). A net named `GND`, `gnd`, or `0` maps to node `0` (mandatory ground).

2. **Map component pins to nodes** — For each component, find the nets its pins belong to via `PinInstance.netId`. Also check `NetLabel` connections by matching label positions to pin positions.

3. **Emit component lines** — For each component, based on its `designator` prefix:
   - `R*` → `R<designator> <pin1_node> <pin2_node> <value>`
   - `C*` → `C<designator> <pin1_node> <pin2_node> <value>`
   - `L*` → `L<designator> <pin1_node> <pin2_node> <value>`
   - `V*` → `V<designator> <+_node> <-_node> <value>` (default DC)
   - `I*` → `I<designator> <+_node> <-_node> <value>`
   - Others → emit as comment `* <designator> (unsupported)` + add warning

4. **Parse values** — Convert human-readable values to SPICE notation:
   - `"10kΩ"` → `"10k"`, `"100nF"` → `"100n"`, `"4.7µH"` → `"4.7u"`
   - `"1MΩ"` → `"1Meg"` (SPICE uses `Meg` not `M` for mega)
   - Strip any unit suffix (Ω, F, H, V, A)

5. **Emit analysis command** based on `config.analysis`:
   - `'transient'` → `.tran ${stepTime} ${stopTime}`
   - `'ac'` → `.ac ${acType} ${acPoints} ${fStart} ${fStop}`
   - `'dc'` → `.dc ${dcSource} ${dcStart} ${dcStop} ${dcStep}`
   - `'op'` → `.op`

6. **Emit control block** — Add `.control` / `.endc` block with `run` command and relevant `print` or `plot` commands.

7. **Assemble** — Title line + component lines + models + analysis + `.end`

**Error handling:**
- No ground node → `errors.push("No ground node found. Add a GND net label.")` and return early
- Component with unconnected pin → `warnings.push("R3 pin 2 is not connected")`
- Unknown component type → `warnings.push("U1: no SPICE model, skipping")`

### 2. Create `client/src/simulation/spice-value-parser.ts`

Small utility module for value parsing:

```typescript
/**
 * Convert a human-readable component value to SPICE notation.
 * Examples: "10kΩ" → "10k", "100nF" → "100n", "4.7µH" → "4.7u"
 */
export function parseSpiceValue(value: string): string;

/**
 * Format a SPICE value back to human-readable.
 * Examples: "10k" → "10kΩ", "100n" → "100nF"
 */
export function formatSpiceValue(value: string, unit?: string): string;
```

### 3. Create `client/src/simulation/__tests__/netlist-generator.test.ts`

Test cases (use Vitest, follow patterns from `document.test.ts`):

1. **Simple voltage divider** — V1 + R1 + R2 with GND → valid netlist with 3 elements and `.op`
2. **RC circuit** — V1 + R1 + C1 with GND → valid netlist with `.tran`
3. **Value parsing** — `"10kΩ"` → `"10k"`, `"100nF"` → `"100n"`, `"4.7µH"` → `"4.7u"`, `"1MΩ"` → `"1Meg"`
4. **Missing ground** — Circuit without GND net → `errors` contains ground warning
5. **Floating node** — R1 with only one pin connected → `warnings` contains floating message
6. **Unknown component** — IC component (U1) → `warnings` contains unsupported message
7. **Net labels connect nodes** — Two components connected only by net labels with same name → both map to same SPICE node

### 4. Create `client/src/simulation/index.ts`

Barrel export file:
```typescript
export { generateNetlist, type SimulationConfig, type NetlistResult } from './netlist-generator';
export { parseSpiceValue, formatSpiceValue } from './spice-value-parser';
```

## Important Notes
- Do NOT modify `canvas-renderer.ts`, `main.ts`, or any renderer/UI files
- Do NOT install any new packages
- Import types from `../core/types` for `CircuitDocument`, `ComponentDefinition`, etc.
- To build the node map, you'll need to trace connectivity through wires, nets, and net labels
- Run tests with: `cd client && npx vitest run src/simulation/__tests__/netlist-generator.test.ts`
- Run type check with: `cd client && npx tsc --noEmit`
