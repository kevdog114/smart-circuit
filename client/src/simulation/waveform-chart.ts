// ============================================================
// Smart Circuit — Waveform Chart (µPlot Wrapper)
// ============================================================
// Dark-themed µPlot wrapper for rendering simulation vectors.

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import type { SimulationVector } from './simulation-engine';

// ----- Series Colors -----
const SERIES_COLORS = [
  '#00d4ff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b',
  '#20c997', '#f06595', '#748ffc', '#fcc419', '#a9e34b', '#e599f7',
];

// ----- Engineering Notation Helpers -----

const SI_PREFIXES: [number, string][] = [
  [1e15,  'P'],
  [1e12,  'T'],
  [1e9,   'G'],
  [1e6,   'M'],
  [1e3,   'k'],
  [1,     '' ],
  [1e-3,  'm'],
  [1e-6,  'µ'],
  [1e-9,  'n'],
  [1e-12, 'p'],
  [1e-15, 'f'],
];

function engFormat(val: number, unit: string = ''): string {
  if (val == null) return '';
  if (val === 0) return `0${unit}`;
  const abs = Math.abs(val);
  for (const [scale, prefix] of SI_PREFIXES) {
    if (abs >= scale * 0.999) {
      const scaled = val / scale;
      // Avoid ugly trailing zeros
      const str = scaled.toFixed(scaled === Math.floor(scaled) ? 0 : 2);
      return `${str}${prefix}${unit}`;
    }
  }
  return val.toExponential(2) + unit;
}

function timeAxisFormat(val: number): string {
  return engFormat(val, 's');
}

function freqAxisFormat(val: number): string {
  return engFormat(val, 'Hz');
}

function voltAxisFormat(val: number): string {
  return engFormat(val, '');
}

// ----- WaveformChart Class -----

export class WaveformChart {
  private plot: uPlot | null = null;
  private container: HTMLElement;
  private traceSeries: { name: string; visible: boolean }[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * Render simulation vectors as a line chart.
   * The first vector should be the X axis (time or frequency).
   */
  render(xVector: SimulationVector, yVectors: SimulationVector[]): void {
    // Destroy previous plot
    this.destroy();

    if (yVectors.length === 0) return;

    // Determine X axis type
    const xName = xVector.name.toLowerCase();
    const isFreq = xName.includes('freq') || xName.includes('hertz');

    // Store trace metadata
    this.traceSeries = yVectors.map(v => ({ name: v.name, visible: true }));

    // Build uPlot data: [xData, y1Data, y2Data, ...]
    const data: uPlot.AlignedData = [
      xVector.data as unknown as number[],
      ...yVectors.map(v => v.data as unknown as number[]),
    ];

    // Build series config
    const series: uPlot.Series[] = [
      {
        label: xVector.name,
        value: (_self: uPlot, rawValue: number) =>
          isFreq ? freqAxisFormat(rawValue) : timeAxisFormat(rawValue),
      },
      ...yVectors.map((v, i) => ({
        label: v.name,
        stroke: SERIES_COLORS[i % SERIES_COLORS.length],
        width: 1.5,
        show: true,
        value: (_self: uPlot, rawValue: number) => voltAxisFormat(rawValue),
      } as uPlot.Series)),
    ];

    // Build axes
    const axes: uPlot.Axis[] = [
      {
        stroke: '#8888aa',
        grid: { stroke: 'rgba(255,255,255,0.06)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
        values: (_self: uPlot, ticks: number[]) =>
          ticks.map(v => isFreq ? freqAxisFormat(v) : timeAxisFormat(v)),
        font: '11px "JetBrains Mono", monospace',
        labelFont: '11px "JetBrains Mono", monospace',
        labelSize: 20,
      },
      {
        stroke: '#8888aa',
        grid: { stroke: 'rgba(255,255,255,0.06)', width: 1 },
        ticks: { stroke: 'rgba(255,255,255,0.1)', width: 1 },
        values: (_self: uPlot, ticks: number[]) =>
          ticks.map(v => voltAxisFormat(v)),
        font: '11px "JetBrains Mono", monospace',
        labelFont: '11px "JetBrains Mono", monospace',
        labelSize: 20,
        size: 60,
      },
    ];

    // Compute container dimensions
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(rect.width, 300);
    const height = Math.max(rect.height - 2, 150);

    const opts: uPlot.Options = {
      width,
      height,
      series,
      axes,
      cursor: {
        x: true,
        y: true,
        drag: { x: true, y: true, setScale: true },
      },
      scales: {
        x: isFreq ? { distr: 3 } : {},  // log scale for frequency
      },
      legend: {
        show: true,
      },
      plugins: [],
    };

    this.plot = new uPlot(opts, data, this.container);
  }

  /** Update which traces are visible. */
  setTraceVisibility(name: string, visible: boolean): void {
    if (!this.plot) return;
    const idx = this.traceSeries.findIndex(t => t.name === name);
    if (idx >= 0) {
      this.traceSeries[idx].visible = visible;
      // Series index is idx + 1 (0 is the X axis)
      this.plot.setSeries(idx + 1, { show: visible });
    }
  }

  /** Clear the chart. */
  clear(): void {
    this.destroy();
  }

  /** Resize the chart to fit its container. */
  resize(): void {
    if (!this.plot) return;
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(rect.width, 300);
    const height = Math.max(rect.height - 2, 150);
    this.plot.setSize({ width, height });
  }

  /** Returns list of trace names and their visibility. */
  getTraces(): { name: string; visible: boolean; color: string }[] {
    return this.traceSeries.map((t, i) => ({
      name: t.name,
      visible: t.visible,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    }));
  }

  destroy(): void {
    if (this.plot) {
      this.plot.destroy();
      this.plot = null;
    }
    this.traceSeries = [];
    this.container.innerHTML = '';
  }
}
