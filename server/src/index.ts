import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { llmRouter } from './routes/llm.js';
import { componentsRouter } from './routes/components.js';
import { getPool, ensureDatabaseReady, isDatabaseAvailable } from './services/database.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// In production the built client is served from the same origin;
// in development allow the Vite dev-server origin.
const CLIENT_DIST = path.join(process.cwd(), 'client-dist');
const isProduction = process.env.NODE_ENV === 'production';
if (!isProduction) {
  app.use(cors({ origin: 'http://localhost:5173' }));
}
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: isDatabaseAvailable() ? 'connected' : 'unavailable',
  });
});

import { projectsRouter } from './routes/projects.js';
import { simulateRouter } from './routes/simulate.js';

// Routes
app.use('/api/llm', llmRouter);
app.use('/api/components', componentsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/simulate', simulateRouter);

// ----- Testing API Routes -----

/**
 * POST /api/test/simulate - Test simulation with predefined circuits
 * Used by automated testing and tools like opencode
 */
app.post('/api/test/simulate', async (req, res) => {
  const { circuit } = req.body;
  if (!circuit) {
    return res.status(400).json({ error: 'Missing "circuit" parameter (e.g. "rc-filter", "voltage-divider", "op-amp")' });
  }

  const testCircuits: Record<string, string> = {
    'voltage-divider': `* Voltage Divider Test
V1 1 0 DC 5
R1 1 out 1k
R2 out 0 1k
.tran 1u 1m
.end`,
    'rc-filter': `* RC Low-pass Filter Test
V1 1 0 PULSE(0 5 0 1u 1u 1m 2m)
R1 1 out 1k
C1 out 0 1u
.tran 1u 5m
.end`,
    'rlc-oscillator': `* RLC Circuit Test
V1 1 0 SIN(0 5 1k 0 0)
R1 1 out 100
L1 out mid 10m
C1 mid 0 100n
.tran 1u 2m
.end`,
    'diode-clipper': `* Diode Clipper Test
V1 1 0 SIN(0 5 1k)
R1 1 out 1k
D1 out 0 DDEF
.model DDEF D(IS=1e-14 N=1)
.tran 1u 2m
.end`,
    'bjt-amplifier': `* BJT Common-Emitter Amplifier Test
Vcc VCC 0 DC 12
V1 1 0 SIN(0 0.1 1k)
C1 1 base 10u
R1 VCC base 100k
R2 base 0 10k
R3 VCC collector 2.2k
R4 emitter 0 1k
C2 collector out 10u
Q1 collector base emitter QNPN
.model QNPN NPN(BF=100 IS=1e-14)
.tran 1u 2m
.end`,
    'op-amp': `* Op-Amp (simplified as voltage-controlled source)
V1 1 0 DC 1
R1 1 out 1k
R2 out 0 1k
E1 out 0 1 0 1
.tran 1u 1m
.end`,
  };

  const netlist = testCircuits[circuit.toLowerCase()];
  if (!netlist) {
    const available = Object.keys(testCircuits).join(', ');
    return res.status(400).json({ error: `Unknown circuit: ${circuit}. Available: ${available}` });
  }

  try {
    const { runSimulation } = await import('./services/simulation.js');
    const result = await runSimulation(netlist);
    res.json({ circuit, ...result });
  } catch (err) {
    res.status(500).json({
      circuit,
      success: false,
      errors: [err instanceof Error ? err.message : 'Simulation failed'],
    });
  }
});

/**
 * GET /api/test/circuits - List available test circuits
 */
app.get('/api/test/circuits', (_req, res) => {
  res.json({
    circuits: [
      { id: 'voltage-divider', name: 'Voltage Divider', description: 'Simple 5V divider with two 1k resistors' },
      { id: 'rc-filter', name: 'RC Low-pass Filter', description: '1kHz pulse through 1k resistor and 1uF capacitor' },
      { id: 'rlc-oscillator', name: 'RLC Circuit', description: 'Series RLC with 1kHz sine input' },
      { id: 'diode-clipper', name: 'Diode Clipper', description: 'Sine wave through resistor and diode to ground' },
      { id: 'bjt-amplifier', name: 'BJT Amplifier', description: 'Common-emitter NPN amplifier with 12V supply' },
      { id: 'op-amp', name: 'Op-Amp (VCVS)', description: 'Voltage-controlled voltage source model' },
    ],
  });
});

/**
 * POST /api/test/netlist - Validate a SPICE netlist without running simulation
 */
app.post('/api/test/netlist', async (req, res) => {
  const { netlist } = req.body;
  if (!netlist || typeof netlist !== 'string') {
    return res.status(400).json({ error: 'Missing "netlist" parameter' });
  }

  const lines = netlist.trim().split('\n');
  const components: string[] = [];
  const models: string[] = [];
  let analysis = '';
  let hasGround = false;
  const errors: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('*')) continue;

    if (trimmed.startsWith('.model')) {
      models.push(trimmed);
    } else if (trimmed.startsWith('.end')) {
      continue;
    } else if (trimmed.startsWith('.')) {
      analysis = trimmed;
    } else if (trimmed[0] && !trimmed.startsWith('+')) {
      components.push(trimmed);
      // Check for ground node (0)
      const parts = trimmed.split(/\s+/);
      if (parts.includes('0')) hasGround = true;
    }
  }

  if (!hasGround) errors.push('No ground node (0) found');
  if (!analysis) errors.push('No analysis command found (.tran, .ac, .dc, .op)');
  if (components.length === 0) errors.push('No components found');

  res.json({
    valid: errors.length === 0,
    errors,
    components: components.length,
    models: models.length,
    analysis,
    hasGround,
  });
});

// ----- HTTP + WebSocket Server -----
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const DATA_DIR = path.join(process.cwd(), 'data', 'projects');

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'save') {
        const doc = msg.payload;
        if (!doc || !doc.id || !doc.name) {
          ws.send(JSON.stringify({ type: 'save:error', error: 'Invalid project document' }));
          return;
        }

        doc.updatedAt = new Date().toISOString();

        // Use database if available, otherwise fall back to file storage
        if (isDatabaseAvailable()) {
          try {
            const pool = getPool();
            await pool.query(
              `INSERT INTO projects (id, name, version, data, created_at, updated_at)
               VALUES ($1, $2, $3, $4, COALESCE((SELECT created_at FROM projects WHERE id = $1), NOW()), $5)
               ON CONFLICT (id) DO UPDATE SET
                 name = EXCLUDED.name,
                 version = EXCLUDED.version,
                 data = EXCLUDED.data,
                 updated_at = EXCLUDED.updated_at`,
              [doc.id, doc.name, doc.version || '1.0.0', JSON.stringify(doc), doc.updatedAt]
            );
          } catch (dbErr) {
            console.error('[WS] Database save failed, falling back to file:', dbErr);
            // Fall back to file storage
            await fs.mkdir(DATA_DIR, { recursive: true });
            const safeId = path.basename(doc.id);
            const filePath = path.join(DATA_DIR, `${safeId}.json`);
            await fs.writeFile(filePath, JSON.stringify(doc, null, 2), 'utf-8');
          }
        } else {
          await fs.mkdir(DATA_DIR, { recursive: true });
          const safeId = path.basename(doc.id);
          const filePath = path.join(DATA_DIR, `${safeId}.json`);
          await fs.writeFile(filePath, JSON.stringify(doc, null, 2), 'utf-8');
        }

        ws.send(JSON.stringify({
          type: 'save:ack',
          id: doc.id,
          updatedAt: doc.updatedAt,
        }));
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err);
      ws.send(JSON.stringify({ type: 'error', error: 'Failed to process message' }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[WS] Socket error:', err);
  });
});

// ----- Serve built client in production -----
if (isProduction) {
  app.use(express.static(CLIENT_DIST));
  // SPA catch-all: let the client-side router handle unmatched GETs
  app.get('*', (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

server.listen(PORT, () => {
  console.log(`Smart Circuit server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`Gemini API key: ${process.env.GEMINI_API_KEY ? '✓ configured' : '✗ missing'}`);
  console.log(`Database: ${process.env.DATABASE_URL ? '✓ configured' : '✗ missing (file storage fallback)'}`);
  if (isProduction) console.log(`Serving client from ${CLIENT_DIST}`);
});
