// ============================================================
// Smart Circuit — Simulation Engine
// ============================================================
//
// Calls the backend /api/simulate endpoint to run ngspice.
// Falls back to MockSimulationEngine when the server is
// unreachable (offline development).
// ============================================================

// ----- Interfaces -----

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

// ----- MockSimulationEngine -----

/**
 * Returns hardcoded transient-analysis results for a voltage divider.
 * Use this while the backend is not available — other agents
 * can develop the UI and result-interpretation code against this.
 *
 * The mock simulates a simple RC network:
 *   V1 1 0 DC 5
 *   R1 1 out 1k
 *   R2 out 0 1k
 *   .tran 1u 1m
 *
 * v(out) ≈ 2.5V (steady-state voltage divider)
 */
export class MockSimulationEngine {
  private ready = false;

  async init(): Promise<void> {
    // Simulate a short initialization delay
    await new Promise(resolve => setTimeout(resolve, 10));
    this.ready = true;
  }

  async run(netlist: string): Promise<SimulationResult> {
    if (!this.ready) {
      throw new Error('MockSimulationEngine not initialized. Call init() first.');
    }

    const start = performance.now();

    // Generate 100 time points from 0 to 1ms
    const numPoints = 100;
    const tEnd = 1e-3; // 1ms
    const timeData = new Float64Array(numPoints);
    const vOutData = new Float64Array(numPoints);
    const vInData = new Float64Array(numPoints);

    for (let i = 0; i < numPoints; i++) {
      const t = (i / (numPoints - 1)) * tEnd;
      timeData[i] = t;
      // Voltage divider: V(out) = V1 * R2/(R1+R2) = 5 * 0.5 = 2.5V
      // Add a small RC transient: V(out) = 2.5 * (1 - e^(-t/RC))
      // where RC = 500 * 1e-9 = 500ns
      const rc = 500e-9;
      vOutData[i] = 2.5 * (1 - Math.exp(-t / rc));
      vInData[i] = 5.0;
    }

    const elapsed = performance.now() - start;

    // Detect analysis type from the netlist
    let analysisType = 'tran';
    if (netlist.toLowerCase().includes('.ac')) {
      analysisType = 'ac';
    } else if (netlist.toLowerCase().includes('.dc')) {
      analysisType = 'dc';
    } else if (netlist.toLowerCase().includes('.op')) {
      analysisType = 'op';
    }

    return {
      success: true,
      vectors: [
        { name: 'time', data: timeData },
        { name: 'v(out)', data: vOutData },
        { name: 'v(1)', data: vInData },
      ],
      log: `Mock simulation of ${numPoints} points completed.\nNetlist length: ${netlist.length} chars\nAnalysis: .tran 1u 1m`,
      errors: [],
      analysisType,
      elapsed,
    };
  }

  isReady(): boolean {
    return this.ready;
  }

  destroy(): void {
    this.ready = false;
  }
}

// ----- SimulationEngine (HTTP-based, calls backend) -----

const SERVER_URL = 'http://localhost:3001';
const RUN_TIMEOUT_MS = 60_000; // 60 seconds per simulation

/**
 * Main-thread simulation engine that calls the backend
 * /api/simulate endpoint running ngspice WASM in Node.js.
 * Falls back to MockSimulationEngine if the server is unreachable.
 */
export class SimulationEngine {
  private ready = false;
  private mockFallback: MockSimulationEngine | null = null;
  private usingMock = false;

  /**
   * Check that the backend is reachable.
   * Falls back to MockSimulationEngine if the server is down.
   */
  async init(): Promise<void> {
    if (this.ready) return;

    try {
      const resp = await fetch(`${SERVER_URL}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) throw new Error(`Health check failed: ${resp.status}`);
      this.ready = true;
      console.log('[SimulationEngine] Backend simulation server connected');
    } catch (err) {
      console.warn(
        '[SimulationEngine] Backend unreachable, falling back to MockSimulationEngine:',
        err instanceof Error ? err.message : err
      );
      this.mockFallback = new MockSimulationEngine();
      await this.mockFallback.init();
      this.usingMock = true;
      this.ready = true;
    }
  }

  /**
   * Run a simulation by sending the netlist to the backend.
   */
  async run(netlist: string): Promise<SimulationResult> {
    if (!this.ready) {
      throw new Error('SimulationEngine not initialized. Call init() first.');
    }

    // If using mock fallback, delegate directly
    if (this.usingMock && this.mockFallback) {
      return this.mockFallback.run(netlist);
    }

    const resp = await fetch(`${SERVER_URL}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ netlist }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(
        (errBody as any).errors?.[0] ||
        (errBody as any).error ||
        `Simulation request failed: ${resp.status}`
      );
    }

    const data = await resp.json() as {
      success: boolean;
      vectors: Array<{ name: string; data: number[] }>;
      log: string;
      errors: string[];
      analysisType: string;
      elapsed: number;
    };

    // Convert plain number arrays back to Float64Arrays
    const vectors: SimulationVector[] = (data.vectors ?? []).map(v => ({
      name: v.name,
      data: new Float64Array(v.data),
    }));

    return {
      success: data.success ?? false,
      vectors,
      log: data.log ?? '',
      errors: data.errors ?? [],
      analysisType: data.analysisType ?? 'unknown',
      elapsed: data.elapsed ?? 0,
    };
  }

  /** Whether the engine is ready to run simulations. */
  isReady(): boolean {
    return this.ready;
  }

  /** Whether the engine is using the mock fallback. */
  isUsingMock(): boolean {
    return this.usingMock;
  }

  /** Free resources. */
  destroy(): void {
    if (this.mockFallback) {
      this.mockFallback.destroy();
      this.mockFallback = null;
    }
    this.ready = false;
    this.usingMock = false;
  }
}
