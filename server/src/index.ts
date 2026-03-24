import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { llmRouter } from './routes/llm.js';
import { componentsRouter } from './routes/components.js';

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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

import { projectsRouter } from './routes/projects.js';
import { simulateRouter } from './routes/simulate.js';

// Routes
app.use('/api/llm', llmRouter);
app.use('/api/components', componentsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/simulate', simulateRouter);

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
        const safeId = path.basename(doc.id);
        const filePath = path.join(DATA_DIR, `${safeId}.json`);

        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(doc, null, 2), 'utf-8');

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
  if (isProduction) console.log(`Serving client from ${CLIENT_DIST}`);
});
