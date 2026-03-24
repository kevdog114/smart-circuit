// ============================================================
// Smart Circuit — Simulation Worker (Child Process)
// ============================================================
// Runs eecircuit-engine (ngspice WASM) in an isolated child
// process so that WASM crashes don't kill the main server.
//
// This file is forked via child_process.fork() with tsx.
// ============================================================

import { Simulation } from 'eecircuit-engine';

let sim: Simulation | null = null;

process.on('message', async (msg: { type: string; netlist?: string }) => {
  if (msg.type === 'init') {
    try {
      sim = new Simulation();
      await sim.start();
      process.send!({ type: 'ready' });
    } catch (err) {
      process.send!({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to initialize ngspice',
      });
    }
  }

  if (msg.type === 'run') {
    if (!sim) {
      process.send!({
        type: 'error',
        message: 'Simulation engine not initialized',
      });
      return;
    }

    const start = performance.now();
    try {
      sim.setNetList(msg.netlist || '');
      const result = await sim.runSim();
      const elapsed = performance.now() - start;

      // Extract vectors
      const vectors = (result.data || []).map(v => {
        let values: number[];
        if (result.dataType === 'complex') {
          values = (v.values as Array<{ real: number; img: number }>).map(
            val => Math.sqrt(val.real * val.real + val.img * val.img)
          );
        } else {
          values = v.values as number[];
        }
        return { name: v.name, data: values };
      });

      // Detect analysis type
      const nl = (msg.netlist || '').toLowerCase();
      let analysisType = 'unknown';
      if (nl.includes('.ac')) analysisType = 'ac';
      else if (nl.includes('.dc')) analysisType = 'dc';
      else if (nl.includes('.op')) analysisType = 'op';
      else if (nl.includes('.tran')) analysisType = 'tran';

      const logInfo = (sim.getInfo() || '').trim();
      const rawErrors = sim.getError() || [];
      const errors = Array.isArray(rawErrors) ? rawErrors : [rawErrors];

      process.send!({
        type: 'result',
        success: errors.length === 0 || vectors.length > 0,
        vectors,
        log: logInfo,
        errors,
        analysisType,
        elapsed,
      });
    } catch (err) {
      const elapsed = performance.now() - start;
      process.send!({
        type: 'result',
        success: false,
        vectors: [],
        log: '',
        errors: [err instanceof Error ? err.message : 'Simulation error'],
        analysisType: 'unknown',
        elapsed,
      });
    }
  }
});
