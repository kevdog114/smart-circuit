// ============================================================
// Smart Circuit — Simulation Panel UI
// ============================================================
// Bottom drawer panel with analysis configuration, waveform
// charting, node picker, and tabs.

import type { SimulationConfig } from './netlist-generator';
import type { SimulationResult, SimulationVector } from './simulation-engine';
import { WaveformChart } from './waveform-chart';

// ----- SimulationPanel -----

export class SimulationPanel {
  private container: HTMLElement;
  private visible = false;
  private latestResult: SimulationResult | null = null;
  private chart: WaveformChart | null = null;
  private panelHeight = 320;
  private resizing = false;

  // DOM refs (set after render)
  private analysisSelect!: HTMLSelectElement;
  private paramsDiv!: HTMLElement;
  private runBtn!: HTMLButtonElement;
  private closeBtn!: HTMLButtonElement;
  private chartArea!: HTMLElement;
  private nodeList!: HTMLElement;
  private logPanel!: HTMLElement;
  private dataPanel!: HTMLElement;
  private loadingOverlay!: HTMLElement;
  private tabBtns!: NodeListOf<HTMLButtonElement>;

  /** Callback: fired when user clicks "Run". */
  onRunSimulation: ((config: SimulationConfig) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;

    // Restore saved height
    const savedH = localStorage.getItem('sc_sim_panel_height');
    if (savedH) this.panelHeight = Math.max(200, parseInt(savedH, 10) || 320);

    this.buildDOM();
    this.bindEvents();
  }

  // ---- Public API ----

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    this.visible = true;
    this.container.style.display = 'block';
    this.container.style.height = `${this.panelHeight}px`;

    // Push main-area up
    const mainArea = document.querySelector<HTMLElement>('.main-area');
    if (mainArea) mainArea.style.marginBottom = `${this.panelHeight}px`;

    // Resize chart after transition
    requestAnimationFrame(() => this.chart?.resize());
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';

    const mainArea = document.querySelector<HTMLElement>('.main-area');
    if (mainArea) mainArea.style.marginBottom = '0';
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Get the user's current analysis configuration from the form. */
  getConfig(): SimulationConfig {
    const analysis = this.analysisSelect.value as SimulationConfig['analysis'];
    const config: SimulationConfig = { analysis };

    switch (analysis) {
      case 'transient':
        config.stepTime = this.getParam('step-time', '1u');
        config.stopTime = this.getParam('stop-time', '10m');
        break;
      case 'ac':
        config.acType = this.getParam('ac-type', 'dec') as 'dec' | 'oct' | 'lin';
        config.acPoints = parseInt(this.getParam('ac-points', '100')) || 100;
        config.fStart = this.getParam('f-start', '1');
        config.fStop = this.getParam('f-stop', '1Meg');
        break;
      case 'dc':
        config.dcSource = this.getParam('dc-source', 'V1');
        config.dcStart = this.getParam('dc-start', '0');
        config.dcStop = this.getParam('dc-stop', '5');
        config.dcStep = this.getParam('dc-step', '0.1');
        break;
      case 'op':
        // No extra parameters
        break;
    }

    return config;
  }

  /** Display simulation results in the waveform chart. */
  displayResults(result: SimulationResult): void {
    this.latestResult = result;
    this.setLoading(false);

    if (!result.success) {
      this.displayErrors(result.errors, []);
      return;
    }

    // Show chart tab
    this.switchTab('chart');

    // Find X axis (time, frequency, or sweep variable)
    const xVector = result.vectors[0];
    const yVectors = result.vectors.slice(1);

    if (!xVector || yVectors.length === 0) {
      this.chartArea.innerHTML = '<p class="hint" style="padding:20px">No data to display.</p>';
      return;
    }

    // Render chart
    if (!this.chart) {
      this.chart = new WaveformChart(this.chartArea);
    }
    this.chart.render(xVector, yVectors);

    // Build node checkboxes
    this.buildNodeList(yVectors);

    // Populate log
    this.logPanel.textContent = result.log || '(no log output)';

    // Populate data table
    this.buildDataTable(result.vectors);
  }

  /** Display errors/warnings from netlist generation. */
  displayErrors(errors: string[], warnings: string[]): void {
    this.switchTab('log');
    let html = '';
    if (errors.length > 0) {
      html += errors.map(e => `<div class="sim-error-line">❌ ${this.esc(e)}</div>`).join('');
    }
    if (warnings.length > 0) {
      html += warnings.map(w => `<div class="sim-warn-line">⚠️ ${this.esc(w)}</div>`).join('');
    }
    this.logPanel.innerHTML = html || '(no issues)';
  }

  /** Show loading state. */
  setLoading(loading: boolean, message?: string): void {
    if (loading) {
      this.loadingOverlay.style.display = 'flex';
      this.loadingOverlay.querySelector('.sim-loading-text')!.textContent = message || 'Running…';
      this.runBtn.disabled = true;
    } else {
      this.loadingOverlay.style.display = 'none';
      this.runBtn.disabled = false;
    }
  }

  /** Get the latest simulation result (for Gemini context). */
  getLatestResult(): SimulationResult | null {
    return this.latestResult;
  }

  // ---- Private: DOM Construction ----

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="simulation-panel">
        <div class="sim-resize-handle" id="sim-resize-handle"></div>
        <div class="sim-header">
          <h3>📊 Simulation</h3>
          <div class="sim-toolbar">
            <select id="sim-analysis-type">
              <option value="transient">Transient</option>
              <option value="ac">AC Analysis</option>
              <option value="dc">DC Sweep</option>
              <option value="op">Operating Point</option>
            </select>
            <div id="sim-params" class="sim-params"></div>
            <button id="sim-run" class="sim-run-btn">▶ Run</button>
          </div>
          <button id="sim-close" class="tool-btn">✕</button>
        </div>
        <div class="sim-body">
          <div class="sim-chart-container">
            <div class="sim-chart-area" id="sim-chart-area"></div>
            <div class="sim-log" id="sim-log" style="display:none"></div>
            <div class="sim-data" id="sim-data" style="display:none"></div>
            <div class="sim-loading" id="sim-loading" style="display:none">
              <div class="sim-loading-spinner"></div>
              <div class="sim-loading-text">Running…</div>
            </div>
          </div>
          <div class="sim-sidebar">
            <div class="sim-sidebar-section">
              <div class="sim-sidebar-label">Traces</div>
              <div class="sim-node-list" id="sim-nodes"></div>
            </div>
            <div class="sim-tabs">
              <button class="sim-tab active" data-tab="chart">Waveforms</button>
              <button class="sim-tab" data-tab="log">SPICE Log</button>
              <button class="sim-tab" data-tab="data">Raw Data</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Cache refs
    this.analysisSelect = this.container.querySelector('#sim-analysis-type')!;
    this.paramsDiv = this.container.querySelector('#sim-params')!;
    this.runBtn = this.container.querySelector('#sim-run')!;
    this.closeBtn = this.container.querySelector('#sim-close')!;
    this.chartArea = this.container.querySelector('#sim-chart-area')!;
    this.nodeList = this.container.querySelector('#sim-nodes')!;
    this.logPanel = this.container.querySelector('#sim-log')!;
    this.dataPanel = this.container.querySelector('#sim-data')!;
    this.loadingOverlay = this.container.querySelector('#sim-loading')!;
    this.tabBtns = this.container.querySelectorAll('.sim-tab');

    // Set initial params
    this.updateParams();
  }

  private bindEvents(): void {
    // Analysis type change
    this.analysisSelect.addEventListener('change', () => this.updateParams());

    // Run button
    this.runBtn.addEventListener('click', () => {
      this.onRunSimulation?.(this.getConfig());
    });

    // Close button
    this.closeBtn.addEventListener('click', () => this.hide());

    // Tab switching
    this.tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab) this.switchTab(tab);
      });
    });

    // Resize handle
    const handle = this.container.querySelector('#sim-resize-handle')!;
    handle.addEventListener('mousedown', (e: Event) => this.startResize(e as MouseEvent));

    // Window resize → resize chart
    window.addEventListener('resize', () => {
      if (this.visible) this.chart?.resize();
    });
  }

  // ---- Private: Analysis Parameters ----

  private updateParams(): void {
    const analysis = this.analysisSelect.value;

    switch (analysis) {
      case 'transient':
        this.paramsDiv.innerHTML = `
          <label class="sim-param">Step <input type="text" id="sim-p-step-time" value="1u" /></label>
          <label class="sim-param">Stop <input type="text" id="sim-p-stop-time" value="10m" /></label>
        `;
        break;
      case 'ac':
        this.paramsDiv.innerHTML = `
          <label class="sim-param">
            <select id="sim-p-ac-type">
              <option value="dec">Dec</option>
              <option value="oct">Oct</option>
              <option value="lin">Lin</option>
            </select>
          </label>
          <label class="sim-param">Pts <input type="text" id="sim-p-ac-points" value="100" size="4" /></label>
          <label class="sim-param">Start <input type="text" id="sim-p-f-start" value="1" /></label>
          <label class="sim-param">Stop <input type="text" id="sim-p-f-stop" value="1Meg" /></label>
        `;
        break;
      case 'dc':
        this.paramsDiv.innerHTML = `
          <label class="sim-param">Src <input type="text" id="sim-p-dc-source" value="Vvcc" size="6" /></label>
          <label class="sim-param">Start <input type="text" id="sim-p-dc-start" value="0" size="4" /></label>
          <label class="sim-param">Stop <input type="text" id="sim-p-dc-stop" value="5" size="4" /></label>
          <label class="sim-param">Step <input type="text" id="sim-p-dc-step" value="0.1" size="4" /></label>
        `;
        break;
      case 'op':
        this.paramsDiv.innerHTML = `<span class="sim-param-hint">No parameters needed</span>`;
        break;
    }
  }

  private getParam(id: string, fallback: string): string {
    const el = this.container.querySelector<HTMLInputElement | HTMLSelectElement>(`#sim-p-${id}`);
    return el?.value?.trim() || fallback;
  }

  // ---- Private: Tabs ----

  private switchTab(tab: string): void {
    this.tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    this.chartArea.style.display = tab === 'chart' ? '' : 'none';
    this.logPanel.style.display = tab === 'log' ? 'block' : 'none';
    this.dataPanel.style.display = tab === 'data' ? 'block' : 'none';

    if (tab === 'chart') {
      requestAnimationFrame(() => this.chart?.resize());
    }
  }

  // ---- Private: Node List ----

  private buildNodeList(_yVectors: SimulationVector[]): void {
    if (!this.chart) return;
    const traces = this.chart.getTraces();

    this.nodeList.innerHTML = traces.map((t, _i) => `
      <label class="sim-node-item">
        <input type="checkbox" data-trace="${this.esc(t.name)}" checked />
        <span class="sim-node-color" style="background:${t.color}"></span>
        <span class="sim-node-name">${this.esc(t.name)}</span>
      </label>
    `).join('');

    // Bind checkbox events
    this.nodeList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const name = cb.dataset.trace || '';
        this.chart?.setTraceVisibility(name, cb.checked);
      });
    });
  }

  // ---- Private: Data Table ----

  private buildDataTable(vectors: SimulationVector[]): void {
    if (vectors.length === 0) {
      this.dataPanel.innerHTML = '<p class="hint">No data.</p>';
      return;
    }

    const maxRows = 200;
    const numRows = Math.min(vectors[0].data.length, maxRows);

    let html = '<div class="sim-data-table-wrap"><table class="sim-data-table"><thead><tr>';
    html += vectors.map(v => `<th>${this.esc(v.name)}</th>`).join('');
    html += '</tr></thead><tbody>';

    for (let r = 0; r < numRows; r++) {
      html += '<tr>';
      html += vectors.map(v => `<td>${v.data[r].toExponential(4)}</td>`).join('');
      html += '</tr>';
    }

    if (vectors[0].data.length > maxRows) {
      html += `<tr><td colspan="${vectors.length}" class="hint">Showing ${maxRows} of ${vectors[0].data.length} rows</td></tr>`;
    }

    html += '</tbody></table></div>';
    this.dataPanel.innerHTML = html;
  }

  // ---- Private: Resizing ----

  private startResize(e: MouseEvent): void {
    e.preventDefault();
    this.resizing = true;
    const startY = e.clientY;
    const startH = this.panelHeight;

    const onMove = (me: MouseEvent) => {
      if (!this.resizing) return;
      const dy = startY - me.clientY;
      this.panelHeight = Math.max(150, Math.min(window.innerHeight - 100, startH + dy));
      this.container.style.height = `${this.panelHeight}px`;

      const mainArea = document.querySelector<HTMLElement>('.main-area');
      if (mainArea) mainArea.style.marginBottom = `${this.panelHeight}px`;

      this.chart?.resize();
    };

    const onUp = () => {
      this.resizing = false;
      localStorage.setItem('sc_sim_panel_height', String(this.panelHeight));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ---- Util ----

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
