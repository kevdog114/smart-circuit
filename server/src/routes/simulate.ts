// ============================================================
// Smart Circuit — Simulation Route
// ============================================================
// POST /api/simulate — accepts a SPICE netlist and returns
// simulation results from the server-side ngspice engine.
// ============================================================

import { Router } from 'express';
import { runSimulation } from '../services/simulation.js';

export const simulateRouter = Router();

simulateRouter.post('/', async (req, res) => {
  const { netlist } = req.body;

  if (!netlist || typeof netlist !== 'string') {
    res.status(400).json({ error: 'Missing or invalid "netlist" in request body' });
    return;
  }

  try {
    const result = await runSimulation(netlist);
    res.json(result);
  } catch (err) {
    console.error('[Simulate] Error:', err);
    res.status(500).json({
      success: false,
      vectors: [],
      log: '',
      errors: [err instanceof Error ? err.message : 'Simulation failed'],
      analysisType: 'unknown',
      elapsed: 0,
    });
  }
});
