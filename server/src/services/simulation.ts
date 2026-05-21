// ============================================================
// Smart Circuit — Server-Side Simulation Service
// ============================================================
//
// Runs ngspice WASM inside a forked child process for crash
// isolation. If ngspice crashes on a bad netlist, only the child
// process dies — the main server stays alive and respawns.
// ============================================================

import { fork, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// ----- Interfaces -----

export interface SimulationVector {
  name: string;
  data: number[];
}

export interface SimulationResult {
  success: boolean;
  vectors: SimulationVector[];
  log: string;
  errors: string[];
  analysisType: string;
  elapsed: number;
}

// ----- Child Process Management -----

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = process.env.NODE_ENV === 'production';
// In production, use the compiled JS file; in development, use TS with tsx loader
const WORKER_PATH = isProduction
  ? path.join(__dirname, 'simulation-worker.js')
  : path.join(__dirname, 'simulation-worker.ts');

const INIT_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 60_000;

let child: ChildProcess | null = null;
let childReady = false;

/**
 * Spawn (or respawn) the simulation child process.
 * Returns a promise that resolves when the child reports 'ready'.
 */
function spawnChild(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Clean up old child if any
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
      child = null;
      childReady = false;
    }

    // Fork the worker. Use tsx loader in development, plain Node in production.
    child = fork(WORKER_PATH, [], {
      execArgv: isProduction ? [] : ['--import', 'tsx'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    const timeout = setTimeout(() => {
      reject(new Error('Simulation worker init timed out'));
      try { child?.kill(); } catch { /* ignore */ }
      child = null;
    }, INIT_TIMEOUT_MS);

    const onMessage = (msg: any) => {
      if (msg.type === 'ready') {
        clearTimeout(timeout);
        child?.off('message', onMessage);
        childReady = true;
        console.log('[Simulation] ngspice child process initialized');
        resolve();
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        child?.off('message', onMessage);
        reject(new Error(msg.message || 'Worker init failed'));
      }
    };

    child.on('message', onMessage);

    child.on('error', (err) => {
      console.error('[Simulation] Child process error:', err.message);
      childReady = false;
      child = null;
    });

    child.on('exit', (code) => {
      if (childReady) {
        console.warn(`[Simulation] Child process exited with code ${code}`);
      }
      childReady = false;
      child = null;
    });

    // Log child process stderr for debugging
    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.error('[Simulation Worker]', msg);
    });

    child.send({ type: 'init' });
  });
}

/**
 * Ensure a child process is running and ready.
 */
async function ensureChild(): Promise<void> {
  if (child && childReady) return;
  await spawnChild();
}

/**
 * Run a SPICE simulation with the given netlist.
 * Automatically (re)spawns the child process if needed.
 */
export async function runSimulation(netlist: string): Promise<SimulationResult> {
  await ensureChild();

  return new Promise<SimulationResult>((resolve, reject) => {
    if (!child) {
      reject(new Error('Simulation process not available'));
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error(`Simulation timed out after ${RUN_TIMEOUT_MS}ms`));
      // Kill the stuck child; next call will respawn
      try { child?.kill(); } catch { /* ignore */ }
      child = null;
      childReady = false;
    }, RUN_TIMEOUT_MS);

    const onMessage = (msg: any) => {
      clearTimeout(timeout);
      child?.off('message', onMessage);
      child?.off('error', onError);
      child?.off('exit', onExit);

      if (msg.type === 'result') {
        resolve({
          success: msg.success ?? false,
          vectors: msg.vectors ?? [],
          log: msg.log ?? '',
          errors: msg.errors ?? [],
          analysisType: msg.analysisType ?? 'unknown',
          elapsed: msg.elapsed ?? 0,
        });
      } else if (msg.type === 'error') {
        reject(new Error(msg.message || 'Simulation failed'));
      }
    };

    const onError = (err: Error) => {
      clearTimeout(timeout);
      child?.off('message', onMessage);
      child?.off('exit', onExit);
      childReady = false;
      child = null;
      reject(new Error(`Simulation process crashed: ${err.message}`));
    };

    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      child?.off('message', onMessage);
      child?.off('error', onError);
      childReady = false;
      child = null;
      reject(new Error(`Simulation process crashed (exit code ${code}). The netlist may be invalid.`));
    };

    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);

    // Log the netlist for debugging
    console.log('[Simulation] Sending netlist to worker:');
    console.log(netlist);
    console.log('[Simulation] --- End netlist ---');

    child.send({ type: 'run', netlist });
  });
}

/**
 * Whether the engine is currently initialized.
 */
export function isSimulationReady(): boolean {
  return childReady;
}
