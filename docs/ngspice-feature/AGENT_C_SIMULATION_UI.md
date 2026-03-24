# Agent C — Simulation Panel UI & Charting

## Objective
Build the simulation panel UI: a bottom drawer with analysis configuration, waveform charting (using µPlot), and a node picker. Wire up the netlist generator and simulation engine to create an end-to-end simulation flow.

## Prerequisites
- **Agent A** complete: `generateNetlist()` function available
- **Agent B** complete: `SimulationEngine` class available

If A or B are not ready, stub their interfaces so the UI can be developed with mock data.

## Context
- The project is a circuit schematic editor at `/Users/klschaefer/dev-projects/smart-circuit`
- Read the main app file: `client/src/main.ts` — understand the layout structure, toolbar, and how panels (library, properties, PCB drawer) are toggled
- Read the CSS: `client/src/style.css` — follow existing design patterns (dark theme, glassmorphism, CSS variables)
- Read the HTML in `main.ts` lines 38–250 — the app layout is generated here
- The app uses vanilla TypeScript (no React/Vue), HTML5 Canvas, and CSS variables for theming
- **Charting library:** µPlot (https://github.com/leeoniya/uPlot) — install via npm

## Deliverables

### 1. Install µPlot

```bash
cd client && npm install uplot
```

µPlot provides its own CSS file (`uplot/dist/uPlot.min.css`) that needs to be imported.

### 2. Create `client/src/simulation/simulation-panel.ts`

The main simulation panel class:

```typescript
import type { SimulationConfig, NetlistResult } from './netlist-generator';
import type { SimulationResult, SimulationVector } from './simulation-engine';

export class SimulationPanel {
  private container: HTMLElement;
  private visible = false;
  private latestResult: SimulationResult | null = null;

  constructor(container: HTMLElement);

  /** Show/hide the simulation panel. */
  toggle(): void;
  show(): void;
  hide(): void;
  isVisible(): boolean;

  /** Get the user's current analysis configuration from the form. */
  getConfig(): SimulationConfig;

  /** Display simulation results in the waveform chart. */
  displayResults(result: SimulationResult): void;

  /** Display errors/warnings from netlist generation. */
  displayErrors(errors: string[], warnings: string[]): void;

  /** Show loading state. */
  setLoading(loading: boolean, message?: string): void;

  /** Get the latest simulation result (for Gemini context). */
  getLatestResult(): SimulationResult | null;

  /** Callback: fired when user clicks "Run". */
  onRunSimulation: ((config: SimulationConfig) => void) | null;
}
```

**UI Layout (rendered into the container):**

```html
<div class="simulation-panel">
  <div class="sim-resize-handle"></div>
  <div class="sim-header">
    <h3>📊 Simulation</h3>
    <div class="sim-toolbar">
      <select id="sim-analysis-type">
        <option value="transient">Transient</option>
        <option value="ac">AC Analysis</option>
        <option value="dc">DC Sweep</option>
        <option value="op">Operating Point</option>
      </select>
      <!-- Dynamic parameter inputs appear here based on analysis type -->
      <div id="sim-params"></div>
      <button id="sim-run" class="btn-primary">▶ Run</button>
    </div>
    <button id="sim-close" class="tool-btn">✕</button>
  </div>
  <div class="sim-body">
    <div class="sim-chart-area">
      <div id="sim-chart"></div>
    </div>
    <div class="sim-sidebar">
      <div class="sim-node-list" id="sim-nodes">
        <!-- Checkboxes for each trace -->
      </div>
      <div class="sim-tabs">
        <button class="sim-tab active" data-tab="chart">Waveforms</button>
        <button class="sim-tab" data-tab="log">SPICE Log</button>
        <button class="sim-tab" data-tab="data">Raw Data</button>
      </div>
    </div>
  </div>
  <div class="sim-log" id="sim-log" style="display:none"></div>
</div>
```

**Analysis parameter inputs** (shown conditionally):
- **Transient:** Step Time (default "1u"), Stop Time (default "10m")
- **AC:** Type (dec/oct/lin), Points (default 100), Start Freq (default "1"), Stop Freq (default "1Meg")
- **DC:** Source (dropdown of V/I sources), Start, Stop, Step
- **Operating Point:** No extra parameters

### 3. Create `client/src/simulation/waveform-chart.ts`

Wraps µPlot for the simulation panel:

```typescript
import uPlot from 'uplot';

export class WaveformChart {
  private plot: uPlot | null = null;
  private container: HTMLElement;

  constructor(container: HTMLElement);

  /**
   * Render simulation vectors as a line chart.
   * The first vector should be the X axis (time or frequency).
   */
  render(xVector: SimulationVector, yVectors: SimulationVector[]): void;

  /** Update which traces are visible. */
  setTraceVisibility(name: string, visible: boolean): void;

  /** Clear the chart. */
  clear(): void;

  /** Resize the chart to fit its container. */
  resize(): void;

  destroy(): void;
}
```

**µPlot configuration:**
- Dark theme (match app)—override µPlot default CSS
- Series colors: use a palette like `['#00d4ff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b']`
- Axes: engineering notation for Y values, SI time suffixes for X axis
- Cursor: crosshair with value readout
- Legend: shown inline below chart

### 4. Add simulation panel to the DOM in `main.ts`

Add the simulation panel container to the app layout HTML. Insert it after the `.main-area` div:

```html
<!-- Simulation Panel (bottom drawer) -->
<div class="sim-drawer" id="sim-drawer" style="display:none"></div>
```

Add a "Simulate" button to the toolbar:
```html
<button id="btn-simulate" class="tool-btn" title="Simulate (F5)">📊 Sim</button>
```

Wire up the simulation flow in `main.ts`:

```typescript
import { SimulationPanel } from './simulation/simulation-panel';
import { SimulationEngine } from './simulation/simulation-engine';
import { generateNetlist } from './simulation/netlist-generator';

// Lazy init
let simPanel: SimulationPanel | null = null;
let simEngine: SimulationEngine | null = null;

function initSimulation() {
  if (simPanel) return;
  const container = document.getElementById('sim-drawer')!;
  simPanel = new SimulationPanel(container);
  simEngine = new SimulationEngine();

  simPanel.onRunSimulation = async (config) => {
    simPanel!.setLoading(true, 'Generating netlist...');
    const nlResult = generateNetlist(doc, config, libraryMap);
    if (nlResult.errors.length > 0) {
      simPanel!.displayErrors(nlResult.errors, nlResult.warnings);
      simPanel!.setLoading(false);
      return;
    }
    if (nlResult.warnings.length > 0) {
      simPanel!.displayErrors([], nlResult.warnings);
    }

    simPanel!.setLoading(true, 'Initializing simulation engine...');
    if (!simEngine!.isReady()) await simEngine!.init();

    simPanel!.setLoading(true, 'Running simulation...');
    const result = await simEngine!.run(nlResult.netlist);
    simPanel!.setLoading(false);
    simPanel!.displayResults(result);
  };
}

// Toggle button
document.getElementById('btn-simulate')!.addEventListener('click', () => {
  initSimulation();
  simPanel!.toggle();
});

// F5 shortcut
document.addEventListener('keydown', (e) => {
  if (e.key === 'F5') {
    e.preventDefault();
    initSimulation();
    simPanel!.show();
    // Auto-run if already visible
    if (simPanel!.isVisible()) {
      simPanel!.onRunSimulation?.(simPanel!.getConfig());
    }
  }
});
```

### 5. Add styles to `client/src/style.css`

Follow the existing dark theme. Key styles needed:

```css
/* Simulation Panel - Bottom Drawer */
.sim-drawer { ... }          /* Bottom drawer container, resizable */
.simulation-panel { ... }    /* Inner panel */
.sim-resize-handle { ... }   /* Drag handle at top */
.sim-header { ... }          /* Toolbar row */
.sim-toolbar { ... }         /* Analysis picker + run button */
.sim-body { ... }            /* Chart + sidebar flexbox */
.sim-chart-area { ... }      /* Chart container */
.sim-sidebar { ... }         /* Node list + tabs */
.sim-node-list { ... }       /* Trace checkboxes */
.sim-log { ... }             /* Raw log viewer */
.sim-tab { ... }             /* Tab buttons */

/* µPlot overrides for dark theme */
.uplot { ... }
.u-legend { ... }
```

Use existing CSS variables: `--bg-dark`, `--bg-card`, `--text-primary`, `--accent`, etc. Reference existing panel styles for consistency.

### 6. Handle resize and layout

The simulation panel should:
- Be a resizable bottom drawer (like browser DevTools)
- The resize handle allows dragging the panel taller/shorter
- When visible, the canvas container above should shrink accordingly
- Store the panel height in `localStorage` for persistence

## Important Notes
- Do NOT modify the netlist generator or simulation engine files (Agents A and B)
- Do NOT modify the Gemini/LLM integration files (Agent D)
- Match the existing app aesthetic exactly: dark theme, glassmorphism, smooth transitions
- The panel should feel native to the existing app — not like a bolted-on afterthought
- If Agents A or B are not ready, use stub imports with mock data so the UI can be developed
- µPlot must be imported as: `import uPlot from 'uplot'` and `import 'uplot/dist/uPlot.min.css'`
- Run type check with: `cd client && npx tsc --noEmit`
