// ============================================================
// Smart Circuit — PCB Trace Settings Panel
// ============================================================
// Panel for configuring trace properties: width, clearance,
// length constraints, differential pairs, and presets.

import type { PCBTrace, PCBVia, TraceSettings } from '../core/types';
import { TRACE_PRESETS, calculateTraceLength } from '../core/pcb-routing';

export class PCBTraceSettingsPanel {
  private container: HTMLElement;
  private visible = false;
  private selectedTraceId: string | null = null;
  private selectedViaId: string | null = null;

  // Callbacks
  onSettingsChange: ((traceId: string, settings: Partial<TraceSettings>) => void) | null = null;
  onDiffPairRequest: ((trace1Id: string, trace2Id: string) => void) | null = null;
  onDeleteTrace: ((traceId: string) => void) | null = null;
  onDeleteVia: ((viaId: string) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.buildDOM();
    this.bindEvents();
  }

  show(): void {
    this.visible = true;
    this.container.style.display = 'block';
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
    this.selectedTraceId = null;
    this.selectedViaId = null;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Select a trace and show its settings. */
  selectTrace(trace: PCBTrace): void {
    this.selectedTraceId = trace.id;
    this.selectedViaId = null;
    this.updateUI(trace, null);
    if (!this.visible) this.show();
  }

  /** Select a via and show its settings. */
  selectVia(via: PCBVia): void {
    this.selectedViaId = via.id;
    this.selectedTraceId = null;
    this.updateUI(null, via);
    if (!this.visible) this.show();
  }

  /** Get all unrouted nets for the diff pair selector. */
  setAvailableTraces(traces: PCBTrace[]): void {
    const selector = this.container.querySelector<HTMLSelectElement>('#trace-diff-pair-select');
    if (!selector) return;

    selector.innerHTML = '<option value="">— Select partner —</option>';
    for (const t of traces) {
      if (t.id === this.selectedTraceId) continue;
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `Net ${t.netId} (${t.length?.toFixed(2) ?? '?'}mm)`;
      selector.appendChild(opt);
    }
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="pcb-trace-settings-panel">
        <div class="pcb-trace-settings-header">
          <h3>🔧 Trace Settings</h3>
          <button class="tool-btn" id="pcb-trace-settings-close">✕</button>
        </div>
        <div class="pcb-trace-settings-body">
          <div id="pcb-trace-info" class="pcb-trace-info">
            <div class="pcb-trace-info-row">
              <span class="pcb-trace-info-label">Net:</span>
              <span class="pcb-trace-info-value" id="pcb-trace-net">—</span>
            </div>
            <div class="pcb-trace-info-row">
              <span class="pcb-trace-info-label">Layer:</span>
              <span class="pcb-trace-info-value" id="pcb-trace-layer">—</span>
            </div>
            <div class="pcb-trace-info-row">
              <span class="pcb-trace-info-label">Length:</span>
              <span class="pcb-trace-info-value" id="pcb-trace-length">—</span>
            </div>
            <div class="pcb-trace-info-row">
              <span class="pcb-trace-info-label">Diff Pair:</span>
              <span class="pcb-trace-info-value" id="pcb-trace-diff-pair">—</span>
            </div>
          </div>

          <div class="pcb-trace-settings-section">
            <h4>Preset</h4>
            <select id="trace-preset-select">
              <option value="signal">Signal (0.2mm)</option>
              <option value="power">Power (0.5mm)</option>
              <option value="ground">Ground (0.6mm)</option>
              <option value="high-speed">High-Speed (0.15mm, 50Ω)</option>
              <option value="diff-pair">Diff Pair (0.15mm, 100Ω)</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          <div class="pcb-trace-settings-section">
            <h4>Trace Width</h4>
            <div class="pcb-trace-input-row">
              <input type="number" id="trace-width" step="0.01" min="0.05" max="3" value="0.2" />
              <span>mm</span>
            </div>
          </div>

          <div class="pcb-trace-settings-section">
            <h4>Clearance</h4>
            <div class="pcb-trace-input-row">
              <input type="number" id="trace-clearance" step="0.01" min="0.05" max="2" value="0.15" />
              <span>mm</span>
            </div>
          </div>

          <div class="pcb-trace-settings-section">
            <h4>Length Constraints</h4>
            <div class="pcb-trace-input-row">
              <label>Max</label>
              <input type="number" id="trace-max-length" step="0.1" min="0" placeholder="∞" />
              <span>mm</span>
            </div>
            <div class="pcb-trace-input-row">
              <label>Min</label>
              <input type="number" id="trace-min-length" step="0.1" min="0" placeholder="0" />
              <span>mm</span>
            </div>
            <div class="pcb-trace-length-status" id="pcb-trace-length-status"></div>
          </div>

          <div class="pcb-trace-settings-section">
            <h4>Target Impedance</h4>
            <div class="pcb-trace-input-row">
              <input type="number" id="trace-impedance" step="1" min="25" max="300" placeholder="—" />
              <span>Ω</span>
            </div>
          </div>

          <div class="pcb-trace-settings-section">
            <h4>Differential Pair</h4>
            <select id="trace-diff-pair-select">
              <option value="">— Select partner —</option>
            </select>
            <button id="trace-associate-diff-pair" class="pcb-trace-btn">Associate</button>
            <div class="pcb-trace-diff-status" id="pcb-trace-diff-status"></div>
          </div>

          <div class="pcb-trace-settings-section pcb-trace-actions">
            <button id="trace-apply-settings" class="pcb-trace-btn pcb-trace-btn-primary">Apply</button>
            <button id="trace-delete" class="pcb-trace-btn pcb-trace-btn-danger">Delete</button>
          </div>
        </div>
      </div>
    `;
  }

  private bindEvents(): void {
    const closeBtn = this.container.querySelector('#pcb-trace-settings-close')!;
    closeBtn.addEventListener('click', () => {
      this.hide();
      this.onClose?.();
    });

    const applyBtn = this.container.querySelector('#trace-apply-settings')!;
    applyBtn.addEventListener('click', () => this.applySettings());

    const deleteBtn = this.container.querySelector('#trace-delete')!;
    deleteBtn.addEventListener('click', () => {
      if (this.selectedTraceId) {
        this.onDeleteTrace?.(this.selectedTraceId);
      } else if (this.selectedViaId) {
        this.onDeleteVia?.(this.selectedViaId);
      }
    });

    const presetSelect = this.container.querySelector<HTMLSelectElement>('#trace-preset-select')!;
    presetSelect.addEventListener('change', () => {
      const preset = presetSelect.value as keyof typeof TRACE_PRESETS;
      const settings = TRACE_PRESETS[preset];
      if (settings) {
        this.container.querySelector<HTMLInputElement>('#trace-width')!.value = settings.width.toString();
        this.container.querySelector<HTMLInputElement>('#trace-clearance')!.value = settings.clearance.toString();
        if (settings.maxLength !== undefined) {
          this.container.querySelector<HTMLInputElement>('#trace-max-length')!.value = settings.maxLength.toString();
        }
        if (settings.minLength !== undefined) {
          this.container.querySelector<HTMLInputElement>('#trace-min-length')!.value = settings.minLength.toString();
        }
        if (settings.impedance !== undefined) {
          this.container.querySelector<HTMLInputElement>('#trace-impedance')!.value = settings.impedance.toString();
        }
      }
    });

    const diffPairBtn = this.container.querySelector('#trace-associate-diff-pair')!;
    diffPairBtn.addEventListener('click', () => {
      const partnerSelect = this.container.querySelector<HTMLSelectElement>('#trace-diff-pair-select')!;
      const partnerId = partnerSelect.value;
      if (this.selectedTraceId && partnerId) {
        this.onDiffPairRequest?.(this.selectedTraceId, partnerId);
        partnerSelect.value = '';
      }
    });
  }

  private updateUI(trace: PCBTrace | null, via: any): void {
    const info = this.container.querySelector<HTMLElement>('#pcb-trace-info')!;

    if (trace) {
      info.style.display = 'block';
      this.container.querySelector<HTMLElement>('#pcb-trace-net')!.textContent = trace.netId;
      this.container.querySelector<HTMLElement>('#pcb-trace-layer')!.textContent = trace.layer;

      const length = trace.length ?? calculateTraceLength(trace.points);
      this.container.querySelector<HTMLElement>('#pcb-trace-length')!.textContent = `${length.toFixed(2)}mm`;

      const diffPairEl = this.container.querySelector<HTMLElement>('#pcb-trace-diff-pair')!;
      diffPairEl.textContent = trace.diffPairId ? `Yes (${trace.diffPairId})` : 'No';
      diffPairEl.style.color = trace.diffPairId ? '#00c9a7' : '#888';

      // Populate fields from current settings
      const settings = trace.settings || TRACE_PRESETS['signal'];
      this.container.querySelector<HTMLInputElement>('#trace-width')!.value = trace.width.toString();
      this.container.querySelector<HTMLInputElement>('#trace-clearance')!.value = (settings.clearance ?? 0.15).toString();
      this.container.querySelector<HTMLInputElement>('#trace-max-length')!.value = settings.maxLength?.toString() || '';
      this.container.querySelector<HTMLInputElement>('#trace-min-length')!.value = settings.minLength?.toString() || '';
      this.container.querySelector<HTMLInputElement>('#trace-impedance')!.value = settings.impedance?.toString() || '';

      // Update length status
      this.updateLengthStatus(length, settings);

      // Show trace sections
      this.setSectionsVisible(true);
    } else if (via) {
      info.style.display = 'block';
      this.container.querySelector<HTMLElement>('#pcb-trace-net')!.textContent = via.netId;
      this.container.querySelector<HTMLElement>('#pcb-trace-layer')!.textContent = `${via.fromLayer} ↔ ${via.toLayer}`;
      this.container.querySelector<HTMLElement>('#pcb-trace-length')!.textContent = 'N/A (via)';
      this.container.querySelector<HTMLElement>('#pcb-trace-diff-pair')!.textContent = 'N/A';

      this.setSectionsVisible(false);
    }
  }

  private updateLengthStatus(length: number, settings: TraceSettings): void {
    const statusEl = this.container.querySelector<HTMLElement>('#pcb-trace-length-status')!;
    const parts: string[] = [];

    if (settings.maxLength !== undefined && length > settings.maxLength) {
      parts.push(`<span style="color:#e54545">⚠ Exceeds max (${settings.maxLength}mm)</span>`);
    }
    if (settings.minLength !== undefined && length < settings.minLength) {
      parts.push(`<span style="color:#e5c545">⚠ Below min (${settings.minLength}mm)</span>`);
    }

    if (parts.length === 0) {
      statusEl.innerHTML = '<span style="color:#00c9a7">✓ Within constraints</span>';
    } else {
      statusEl.innerHTML = parts.join('<br>');
    }
  }

  private setSectionsVisible(visible: boolean): void {
    const sections = this.container.querySelectorAll<HTMLElement>('.pcb-trace-settings-section');
    sections.forEach(s => {
      s.style.display = visible ? '' : 'none';
    });
  }

  private applySettings(): void {
    if (!this.selectedTraceId) return;

    const settings: Partial<TraceSettings> = {
      width: parseFloat(this.container.querySelector<HTMLInputElement>('#trace-width')!.value) || 0.2,
      clearance: parseFloat(this.container.querySelector<HTMLInputElement>('#trace-clearance')!.value) || 0.15,
    };

    const maxLength = this.container.querySelector<HTMLInputElement>('#trace-max-length')!.value;
    if (maxLength) settings.maxLength = parseFloat(maxLength);

    const minLength = this.container.querySelector<HTMLInputElement>('#trace-min-length')!.value;
    if (minLength) settings.minLength = parseFloat(minLength);

    const impedance = this.container.querySelector<HTMLInputElement>('#trace-impedance')!.value;
    if (impedance) settings.impedance = parseFloat(impedance);

    const preset = this.container.querySelector<HTMLSelectElement>('#trace-preset-select')!.value;
    settings.preset = preset as any;

    this.onSettingsChange?.(this.selectedTraceId, settings);
  }
}
