# Agent D — Gemini Simulation Tools

## Objective
Add two new Gemini LLM tools: `run_simulation` (triggers a simulation from the chat) and `interpret_simulation` (asks Gemini to analyze the latest results). Follow the exact same patterns as the existing tools (`add_component`, `layout_pcb_components`, etc.).

## Prerequisites
- **Agent A** complete: `generateNetlist()` available
- **Agent B** complete: `SimulationEngine` available
- **Agent C** complete: `SimulationPanel` with `displayResults()` available

## Context
- **Server LLM service:** `server/src/services/gemini.ts` — study `SYSTEM_PROMPT`, `TOOL_DECLARATIONS`, `streamChat()`, and the function-response follow-up pattern
- **Server LLM route:** `server/src/routes/llm.ts` — the SSE streaming endpoint
- **Client tool executor:** `client/src/llm/tool-executor.ts` — study `handleToolCall()` switch, card renderers, `attachActions()`, `markAccepted()`/`markRejected()`/`markLoading()`
- **Client main:** `client/src/main.ts` — study how `circuitContext` is built and sent with chat messages (search for `sendLLMMessage`)
- All tools follow the pattern: Gemini calls a tool → client renders a card with Accept/Reject → on Accept, execute the action

## Deliverables

### 1. Modify `server/src/services/gemini.ts`

**Update `SYSTEM_PROMPT`** — add simulation capabilities:

```diff
 5. Mapping schematic components to real JLCPCB parts for manufacturing
 6. Auto-placing components on the PCB board based on circuit topology
+7. Running circuit simulations (transient, AC, DC, operating point) using ngspice
+8. Interpreting and explaining simulation results (waveforms, frequency response, metrics)
```

Add to constraints:
```diff
+- When asked to simulate a circuit, use the run_simulation tool
+- After running a simulation, proactively offer to interpret the results
+- When interpreting results, focus on practical metrics: DC bias points, settling time, bandwidth, stability, etc.
+- The simulation engine currently supports R, C, L, and voltage/current sources only
```

**Add two tool declarations** to `TOOL_DECLARATIONS`:

```typescript
{
  name: 'run_simulation',
  description: 'Run a SPICE circuit simulation on the current schematic. The simulation runs client-side using ngspice WASM. Use this when the user asks to simulate, test, or verify their circuit behavior. Supports transient, AC, DC sweep, and operating point analysis. The circuit must have a GND node and at least one source.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      analysis: {
        type: Type.STRING,
        description: 'Type of analysis: transient (time-domain), ac (frequency response), dc (DC sweep), op (operating point)',
        enum: ['transient', 'ac', 'dc', 'op']
      },
      stopTime: {
        type: Type.STRING,
        description: 'Stop time for transient analysis. Use SPICE notation: "10m" = 10ms, "1u" = 1µs, "100n" = 100ns'
      },
      stepTime: {
        type: Type.STRING,
        description: 'Maximum step time for transient analysis. Should be at least 10x smaller than stopTime. E.g. "1u" for a 10ms simulation'
      },
      fStart: {
        type: Type.STRING,
        description: 'Start frequency for AC analysis, e.g. "1" = 1Hz, "100" = 100Hz'
      },
      fStop: {
        type: Type.STRING,
        description: 'Stop frequency for AC analysis, e.g. "1Meg" = 1MHz, "100k" = 100kHz'
      },
      acPoints: {
        type: Type.NUMBER,
        description: 'Number of frequency points per decade for AC analysis (default 100)'
      },
      dcSource: {
        type: Type.STRING,
        description: 'Designator of the voltage/current source to sweep for DC analysis, e.g. "V1"'
      },
      dcStart: { type: Type.STRING, description: 'Start value for DC sweep, e.g. "0"' },
      dcStop: { type: Type.STRING, description: 'Stop value for DC sweep, e.g. "5"' },
      dcStep: { type: Type.STRING, description: 'Step value for DC sweep, e.g. "0.1"' }
    },
    required: ['analysis']
  }
},
{
  name: 'interpret_simulation',
  description: 'Analyze and interpret the most recent simulation results. Examines waveforms, identifies key metrics (DC bias, settling time, overshoot, bandwidth, gain, phase margin), and explains the circuit behavior in plain language. Use this after a simulation has completed successfully.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      focusNodes: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Specific signals to focus analysis on, e.g. ["v(out)", "i(R1)"]'
      },
      question: {
        type: Type.STRING,
        description: 'A specific question about the results, e.g. "What is the time constant?" or "What is the cutoff frequency?"'
      }
    }
  }
}
```

**Update `buildContextString()`** — add simulation context when available:

In the `CircuitContext` interface, add:
```typescript
simulationResult?: {
  analysisType: string;
  vectors: { name: string; min: number; max: number; mean: number }[];
  success: boolean;
} | null;
```

In `buildContextString()`:
```typescript
if (ctx.simulationResult) {
  const sim = ctx.simulationResult;
  lines.push(`\nSimulation (${sim.analysisType}):`);
  lines.push(`  Status: ${sim.success ? 'Success' : 'Failed'}`);
  for (const v of sim.vectors) {
    lines.push(`  ${v.name}: min=${v.min.toPrecision(4)}, max=${v.max.toPrecision(4)}, mean=${v.mean.toPrecision(4)}`);
  }
}
```

**Handle `interpret_simulation` server-side** — When this function call is made, the server should pass the simulation summary data back to Gemini as the function response so it can generate its interpretation. The simulation data will arrive in the function response from the client. No server-side execution needed — just pass it through.

### 2. Modify `client/src/llm/tool-executor.ts`

**Add interfaces:**
```typescript
interface RunSimulationArgs {
  analysis: 'transient' | 'ac' | 'dc' | 'op';
  stopTime?: string;
  stepTime?: string;
  fStart?: string;
  fStop?: string;
  acPoints?: number;
  dcSource?: string;
  dcStart?: string;
  dcStop?: string;
  dcStep?: string;
}

interface InterpretSimulationArgs {
  focusNodes?: string[];
  question?: string;
}
```

**Add to `handleToolCall` switch:**
```typescript
case 'run_simulation':
  return this.renderRunSimulation(args as unknown as RunSimulationArgs);
case 'interpret_simulation':
  return this.renderInterpretSimulation(args as unknown as InterpretSimulationArgs);
```

**Add `SimulationPanel` and `SimulationEngine` references** to the constructor opts (or receive them via a setter method):
```typescript
private simPanel: SimulationPanel | null;
private simEngine: SimulationEngine | null;
```

**Implement `renderRunSimulation()`:**

1. Create a tool card:
   - Icon: `📊`
   - Title: `"Run Simulation"`
   - Details: `{ label: 'Analysis', value: args.analysis }` + relevant params

2. On accept:
   - `markLoading(card, 'Generating netlist...')`
   - Call `generateNetlist(doc, config, libraryMap)`
   - If errors → `markRejected(card, error message)`
   - `markLoading(card, 'Running simulation...')`
   - If engine not ready → `await engine.init()`
   - Call `engine.run(netlist)`
   - Pass results to `simPanel.displayResults(result)`
   - Show/ensure sim panel is visible
   - `markAccepted(card, 'Simulation complete — X vectors, Y points')`

3. On reject: standard rejection

**Implement `renderInterpretSimulation()`:**

1. Create a tool card:
   - Icon: `🔬`
   - Title: `"Interpret Results"`
   - Details: focus nodes and/or question

2. On accept:
   - Get latest results from `simPanel.getLatestResult()`
   - If no results → `markRejected(card, 'No simulation results available')`
   - Build a summary of the results (vector names, min/max/mean for each)
   - This summary will be included in the next chat message context
   - `markAccepted(card, 'Analysis context added')`

3. The actual interpretation text comes from Gemini in the follow-up response (the server's function response will contain the simulation summary, and Gemini will generate the natural-language interpretation).

### 3. Modify `client/src/main.ts` — Extend chat context

Find where `circuitContext` is built for the LLM chat (search for `circuitContext`). Add the simulation result summary:

```typescript
// Add simulation context if available
const simResult = simPanel?.getLatestResult();
const simulationResult = simResult?.success ? {
  analysisType: simResult.analysisType,
  vectors: simResult.vectors.map(v => ({
    name: v.name,
    min: Math.min(...Array.from(v.data)),
    max: Math.max(...Array.from(v.data)),
    mean: Array.from(v.data).reduce((a, b) => a + b, 0) / v.data.length,
  })),
  success: true,
} : null;
```

Add `simulationResult` to the `circuitContext` object sent with chat messages.

### 4. Modify `server/src/routes/llm.ts`

Ensure the `circuitContext` interface accepted by the chat endpoint includes the new `simulationResult` field. No other changes needed — the streaming/tool-call infrastructure already handles new tools automatically.

## Important Notes
- Do NOT modify the netlist generator, simulation engine, or simulation panel UI files
- Match the existing tool card style exactly (icon, title, details, Accept/Reject buttons)
- Follow the `map_jlcpcb_part` pattern for tools that need async work on Accept
- The `interpret_simulation` tool is unique: it provides data TO Gemini rather than executing an action. The function response sends sim data, and Gemini's follow-up text IS the interpretation.
- Run type check with: `cd client && npx tsc --noEmit && cd ../server && npx tsc --noEmit`
