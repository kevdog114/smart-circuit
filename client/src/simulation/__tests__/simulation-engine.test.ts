import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockSimulationEngine } from '../simulation-engine';
import type { SimulationResult, SimulationVector } from '../simulation-engine';

// Note: Full SimulationEngine (Worker-based) cannot be tested in Vitest's
// Node environment because Web Workers are not available. Integration
// testing of the real Worker-based engine should be done in a browser
// environment (e.g., Playwright or manual browser testing).
//
// These tests exercise:
// 1. MockSimulationEngine functionality (which other agents depend on)
// 2. API contract verification
// 3. Type-level checks for SimulationResult and SimulationVector

const SAMPLE_NETLIST = `* Voltage Divider
V1 1 0 DC 5
R1 1 out 1k
R2 out 0 1k
.tran 1u 1m
.end`;

describe('MockSimulationEngine', () => {
  let engine: MockSimulationEngine;

  beforeEach(() => {
    engine = new MockSimulationEngine();
  });

  afterEach(() => {
    engine.destroy();
  });

  // ---- init() ----

  it('isReady() returns false before init', () => {
    expect(engine.isReady()).toBe(false);
  });

  it('init() makes the engine ready', async () => {
    await engine.init();
    expect(engine.isReady()).toBe(true);
  });

  it('init() can be called multiple times safely', async () => {
    await engine.init();
    await engine.init();
    expect(engine.isReady()).toBe(true);
  });

  // ---- run() ----

  it('run() throws if not initialized', async () => {
    await expect(engine.run(SAMPLE_NETLIST)).rejects.toThrow(/not initialized/i);
  });

  it('run() returns a valid SimulationResult', async () => {
    await engine.init();
    const result: SimulationResult = await engine.run(SAMPLE_NETLIST);

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.analysisType).toBe('tran');
    expect(result.elapsed).toBeGreaterThanOrEqual(0);
    expect(result.log).toBeTruthy();
    expect(result.vectors.length).toBeGreaterThan(0);
  });

  it('run() returns time and v(out) vectors', async () => {
    await engine.init();
    const result = await engine.run(SAMPLE_NETLIST);

    const timeVec = result.vectors.find((v: SimulationVector) => v.name === 'time');
    const vOutVec = result.vectors.find((v: SimulationVector) => v.name === 'v(out)');

    expect(timeVec).toBeDefined();
    expect(vOutVec).toBeDefined();
    expect(timeVec!.data).toBeInstanceOf(Float64Array);
    expect(vOutVec!.data).toBeInstanceOf(Float64Array);
    expect(timeVec!.data.length).toBe(100);
    expect(vOutVec!.data.length).toBe(100);
  });

  it('run() time vector starts at 0 and ends near 1ms', async () => {
    await engine.init();
    const result = await engine.run(SAMPLE_NETLIST);
    const timeVec = result.vectors.find(v => v.name === 'time')!;

    expect(timeVec.data[0]).toBe(0);
    expect(timeVec.data[timeVec.data.length - 1]).toBeCloseTo(1e-3, 6);
  });

  it('run() v(out) converges to 2.5V', async () => {
    await engine.init();
    const result = await engine.run(SAMPLE_NETLIST);
    const vOutVec = result.vectors.find(v => v.name === 'v(out)')!;

    // Last value should be very close to 2.5V (steady state)
    const lastValue = vOutVec.data[vOutVec.data.length - 1];
    expect(lastValue).toBeCloseTo(2.5, 2);
  });

  it('run() detects AC analysis type from netlist', async () => {
    await engine.init();
    const acNetlist = `* AC test\nV1 1 0 AC 1\nR1 1 0 1k\n.ac dec 10 1 1meg\n.end`;
    const result = await engine.run(acNetlist);
    expect(result.analysisType).toBe('ac');
  });

  it('run() detects DC analysis type from netlist', async () => {
    await engine.init();
    const dcNetlist = `* DC sweep\nV1 1 0 DC 5\nR1 1 0 1k\n.dc V1 0 5 0.1\n.end`;
    const result = await engine.run(dcNetlist);
    expect(result.analysisType).toBe('dc');
  });

  it('run() detects OP analysis type from netlist', async () => {
    await engine.init();
    const opNetlist = `* Operating point\nV1 1 0 DC 5\nR1 1 0 1k\n.op\n.end`;
    const result = await engine.run(opNetlist);
    expect(result.analysisType).toBe('op');
  });

  // ---- destroy() ----

  it('destroy() resets ready state', async () => {
    await engine.init();
    expect(engine.isReady()).toBe(true);

    engine.destroy();
    expect(engine.isReady()).toBe(false);
  });

  it('run() throws after destroy()', async () => {
    await engine.init();
    engine.destroy();
    await expect(engine.run(SAMPLE_NETLIST)).rejects.toThrow(/not initialized/i);
  });
});

// ---- API Contract ----

describe('SimulationEngine API contract', () => {
  it('MockSimulationEngine has expected method signatures', () => {
    const engine = new MockSimulationEngine();

    // Verify all required methods exist and are functions
    expect(typeof engine.init).toBe('function');
    expect(typeof engine.run).toBe('function');
    expect(typeof engine.isReady).toBe('function');
    expect(typeof engine.destroy).toBe('function');

    engine.destroy();
  });

  it('SimulationResult vectors contain Float64Array data', async () => {
    const engine = new MockSimulationEngine();
    await engine.init();
    const result = await engine.run(SAMPLE_NETLIST);

    for (const vec of result.vectors) {
      expect(typeof vec.name).toBe('string');
      expect(vec.data).toBeInstanceOf(Float64Array);
      expect(vec.data.length).toBeGreaterThan(0);
    }

    engine.destroy();
  });
});
