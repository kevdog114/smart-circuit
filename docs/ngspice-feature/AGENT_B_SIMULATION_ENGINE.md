# Agent B — Simulation Engine (ngspice WASM)

## Objective
Wrap the ngspice WASM binary in a clean async TypeScript API that runs simulations off the main thread using a Web Worker. This module accepts a SPICE netlist string and returns parsed output vectors.

## Context
- The project is a circuit schematic editor at `/Users/klschaefer/dev-projects/smart-circuit`
- Read the core types: `client/src/core/types.ts`
- Read `client/vite.config.ts` for build configuration
- The app uses TypeScript with Vite (client) and Vitest for testing
- **ngspice WASM source:** Use a pre-built npm package. Try `@niccokunzmann/ngspice-wasm` or `wokwi/ngspice-wasm` first. If neither works as an npm package, you can load the WASM from a CDN or vendor it into `public/`.

## Deliverables

### 1. Install ngspice WASM dependency

Research available npm packages. The best options are:
- `ngspice` — check npmjs.com
- Self-vendor: Download pre-built `.wasm` + `.js` glue from a GitHub release (e.g. `wokwi/ngspice-wasm`) and place in `client/public/ngspice/`

If you vendor manually:
- Place `ngspice.wasm` and `ngspice.js` in `client/public/ngspice/`
- Load via fetch in the worker

### 2. Create `client/src/simulation/simulation-engine.ts`

Main-thread API that communicates with a Web Worker:

```typescript
export interface SimulationVector {
  name: string;        // e.g. "time", "v(out)", "v(1)", "i(v1)"
  data: Float64Array;
}

export interface SimulationResult {
  success: boolean;
  vectors: SimulationVector[];
  log: string;         // raw ngspice stdout output
  errors: string[];    // parsed error messages
  analysisType: string;
  elapsed: number;     // wall-clock ms
}

export class SimulationEngine {
  private worker: Worker | null = null;
  private ready = false;

  /**
   * Load the ngspice WASM binary in a Web Worker.
   * Call once at app startup or lazily on first simulation.
   */
  async init(): Promise<void>;

  /**
   * Run a simulation. The netlist string is sent to the worker,
   * which loads it into ngspice, runs the simulation, and returns
   * the output vectors.
   */
  async run(netlist: string): Promise<SimulationResult>;

  /** Whether the engine is ready to run simulations. */
  isReady(): boolean;

  /** Terminate the worker and free resources. */
  destroy(): void;
}
```

**Implementation details:**

1. `init()` creates a new `Worker` pointing to `simulation-worker.ts` (or compiled equivalent). The worker loads the WASM binary and signals readiness.

2. `run(netlist)` sends a `{ type: 'run', netlist }` message to the worker and returns a Promise that resolves when the worker sends back `{ type: 'result', ... }`.

3. The Promise should have a **timeout** (e.g. 30 seconds) to prevent hanging on infinite loops or bad netlists.

4. Communication uses `postMessage` / `onmessage`. Use a simple request-ID system to match requests/responses if needed.

### 3. Create `client/src/simulation/simulation-worker.ts`

Web Worker script:

```typescript
// This file runs in a Web Worker context

// Load ngspice WASM
// Option A: npm import (if the package supports it)
// Option B: fetch from /ngspice/ngspice.wasm

self.onmessage = async (event) => {
  const { type, netlist, id } = event.data;

  if (type === 'init') {
    // Load WASM binary
    // Signal ready
    self.postMessage({ type: 'ready' });
  }

  if (type === 'run') {
    const start = performance.now();
    try {
      // 1. Load the netlist into ngspice (write to virtual filesystem or pipe)
      // 2. Run the simulation
      // 3. Capture stdout/stderr
      // 4. Extract output vectors (parse rawfile or use shared_module API)
      // 5. Send results back

      const result = { type: 'result', id, success: true, vectors: [...], log: '...', errors: [], elapsed: performance.now() - start };
      self.postMessage(result);
    } catch (err) {
      self.postMessage({ type: 'result', id, success: false, vectors: [], log: '', errors: [err.message], elapsed: performance.now() - start });
    }
  }
};
```

**Key challenges:**
- **WASM loading:** ngspice WASM typically exposes a Module object with `FS` for virtual filesystem access. You'll need to write the netlist to a virtual file, then call `ngspice_Command("source /netlist.cir")` and `ngspice_Command("run")`.
- **Output capture:** Hook `Module.print` and `Module.printErr` to capture ngspice stdout/stderr.
- **Vector extraction:** After simulation, use `ngSpice_AllVecs()` or parse the output to get vector data. The exact API depends on the WASM build.

### 4. Configure Vite for Web Workers

Vite supports Web Workers natively. In the main thread, import like:
```typescript
import SimWorker from './simulation-worker?worker';
```

Or use `new Worker(new URL('./simulation-worker.ts', import.meta.url))`.

Make sure the Vite config doesn't exclude the worker from the build.

### 5. Create `client/src/simulation/__tests__/simulation-engine.test.ts`

**Note:** Testing the full WASM engine in Vitest may be challenging due to Worker limitations. If WASM loading fails in test environment, create a mock test that verifies the API contract and message format. Add a comment explaining that full integration testing is done in the browser.

Test cases:
1. **API contract** — `SimulationEngine` has `init()`, `run()`, `isReady()`, `destroy()` methods
2. **Mock worker** — Send a netlist message, verify the expected message format
3. **Timeout handling** — Verify that `run()` rejects after timeout

### 6. Update `client/src/simulation/index.ts`

Add to the barrel export:
```typescript
export { SimulationEngine, type SimulationResult, type SimulationVector } from './simulation-engine';
```

## Important Notes
- Do NOT modify `canvas-renderer.ts`, `main.ts`, or any renderer/UI files
- Do NOT modify the netlist generator files (Agent A's responsibility)
- The WASM binary may be 2-5MB — it should be lazy-loaded, not included in the main bundle
- The Worker must run off the main thread to avoid blocking the UI
- If the chosen WASM package doesn't work, leave a clear `TODO` comment and implement a `MockSimulationEngine` that returns hardcoded results for a voltage divider. This lets other agents proceed.
- Run type check with: `cd client && npx tsc --noEmit`
