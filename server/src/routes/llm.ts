import { Router, Request, Response } from 'express';
import { GeminiService } from '../services/gemini.js';

export const llmRouter = Router();
const gemini = new GeminiService();

// Streaming chat endpoint (SSE)
llmRouter.post('/chat', async (req: Request, res: Response) => {
  const { messages, circuitContext } = req.body;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'messages array is required' } });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({ error: { code: 'LLM_UNAVAILABLE', message: 'GEMINI_API_KEY not configured' } });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    await gemini.streamChat(messages, circuitContext, {
      onText: (text: string) => {
        console.log('[SSE] Emitting text:', text.slice(0, 80));
        res.write(`event: text\ndata: ${JSON.stringify({ content: text })}\n\n`);
      },
      onToolCall: (name: string, args: Record<string, unknown>) => {
        console.log('[SSE] Emitting tool_call:', name);
        res.write(`event: tool_call\ndata: ${JSON.stringify({ name, args })}\n\n`);
      },
      onDone: () => {
        console.log('[SSE] Emitting done');
        res.write(`event: done\ndata: {}\n\n`);
        res.end();
      },
      onError: (error: string) => {
        console.error('[SSE] Emitting error:', error);
        res.write(`event: error\ndata: ${JSON.stringify({ message: error })}\n\n`);
        res.end();
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Gemini] Chat endpoint error:', message);
    res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    res.end();
  }
});

// Suggest parts endpoint
llmRouter.post('/suggest-parts', async (req: Request, res: Response) => {
  const { requirement, constraints, existingCircuit } = req.body;

  if (!requirement) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'requirement is required' } });
    return;
  }

  try {
    const result = await gemini.suggestParts(requirement, constraints, existingCircuit);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Gemini] Suggest parts error:', message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
  }
});

// Review circuit endpoint
llmRouter.post('/review-circuit', async (req: Request, res: Response) => {
  const { document, focusAreas } = req.body;

  if (!document) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'document is required' } });
    return;
  }

  try {
    const result = await gemini.reviewCircuit(document, focusAreas);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Gemini] Review circuit error:', message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
  }
});
