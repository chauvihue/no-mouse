// CSV export (simulated IMU stream + results) and import (real MPU-6050 logs).

import type { ImuSample, StepOutput } from '../../../algorithms/pipeline.ts';
import type { Finger } from '../../../algorithms/taps/classifier.ts';
import type { GuideStep } from './guide.ts';

/** Rolling recorder of the raw IMU stream (+ truth / estimate) for export. */
export class Recorder {
  readonly cap: number;
  private t: Float64Array;
  private d: Float32Array; // ax ay az gx gy gz trueX trueY estX estY curX curY still
  private lab: Uint8Array;
  n = 0;
  static readonly NC = 13;
  constructor(seconds = 120, rate = 1000) {
    this.cap = seconds * rate;
    this.t = new Float64Array(this.cap);
    this.d = new Float32Array(this.cap * Recorder.NC);
    this.lab = new Uint8Array(this.cap);
  }
  clear(): void { this.n = 0; }
  push(s: ImuSample, label: Finger | null, tx: number, ty: number, ex: number, ey: number, cx: number, cy: number, still: boolean): void {
    const i = this.n % this.cap;
    this.t[i] = s.t;
    const o = i * Recorder.NC, d = this.d;
    d[o] = s.ax; d[o + 1] = s.ay; d[o + 2] = s.az; d[o + 3] = s.gx; d[o + 4] = s.gy; d[o + 5] = s.gz;
    d[o + 6] = tx; d[o + 7] = ty; d[o + 8] = ex; d[o + 9] = ey; d[o + 10] = cx; d[o + 11] = cy; d[o + 12] = still ? 1 : 0;
    this.lab[i] = label === 'index' ? 1 : label === 'pinky' ? 2 : 0;
    this.n++;
  }
  toCSV(): string {
    const rows = ['t,ax,ay,az,gx,gy,gz,label,true_x_m,true_y_m,est_x_m,est_y_m,cursor_x_px,cursor_y_px,still'];
    const count = Math.min(this.n, this.cap);
    const t0 = this.n - count;
    for (let k = t0; k < this.n; k++) {
      const i = k % this.cap, o = i * Recorder.NC, d = this.d;
      const lab = this.lab[i] === 1 ? 'index' : this.lab[i] === 2 ? 'pinky' : '';
      rows.push(`${this.t[i].toFixed(4)},${d[o].toFixed(5)},${d[o + 1].toFixed(5)},${d[o + 2].toFixed(5)},${d[o + 3].toFixed(4)},${d[o + 4].toFixed(4)},${d[o + 5].toFixed(4)},${lab},` +
        `${d[o + 6].toFixed(5)},${d[o + 7].toFixed(5)},${d[o + 8].toFixed(5)},${d[o + 9].toFixed(5)},${d[o + 10].toFixed(1)},${d[o + 11].toFixed(1)},${d[o + 12]}`);
    }
    return rows.join('\n');
  }
}

/**
 * Records every sample of a session, real or simulated: the raw IMU reading next to
 * what the pipeline made of it (hand acceleration, velocity, position, cursor,
 * stillness, detected taps). Unlike Recorder it isn't a ring buffer: it keeps
 * everything from Record to Stop, up to maxSeconds.
 */
export class SessionRecorder {
  static readonly COLUMNS = [
    't', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'true_x_m', 'true_y_m',
    'lin_x_ms2', 'lin_y_ms2', 'vel_x_ms', 'vel_y_ms', 'pos_x_m', 'pos_y_m',
    'cursor_x_px', 'cursor_y_px', 'still', 'frozen', 'tap_detected',
    'guide_section', 'guide_step', 'guide_move', 'guide_dir', 'guide_click',
  ];
  private static readonly NUM = 18; // numeric columns after t (tap_detected is text)
  private static readonly CHUNK = 10000;
  private static readonly NO_STEP = 255; // guide step index stored for samples outside a guided run
  readonly maxRows: number;
  private t: Float64Array[] = [];
  private d: Float32Array[] = [];
  private g: Uint8Array[] = []; // guide step index per row
  private taps = new Map<number, Finger>();
  private meta = '';
  private note = '';
  private steps: GuideStep[] = []; // the guided script that was run (indexes the guide column)
  rows = 0;
  recording = false;

  constructor(maxSeconds = 600, rateHz = 1000) { this.maxRows = maxSeconds * rateHz; }

  /** `note` is an extra comment line for the header; `steps` is the guided script behind the guide column. */
  start(meta: string, note = '', steps: GuideStep[] = []): void {
    this.t = []; this.d = []; this.g = []; this.taps.clear();
    this.rows = 0; this.meta = meta; this.note = note; this.steps = steps; this.recording = true;
  }

  stop(): void { this.recording = false; }

  get full(): boolean { return this.rows >= this.maxRows; }

  /** `guideStep` is the index into the guided script's steps active when this sample was processed, or -1. */
  push(s: ImuSample, out: StepOutput, trueX: number, trueY: number, guideStep = -1): void {
    if (!this.recording || this.full) return;
    const C = SessionRecorder.CHUNK, N = SessionRecorder.NUM;
    const ci = Math.floor(this.rows / C), ri = this.rows % C;
    if (ri === 0) { this.t.push(new Float64Array(C)); this.d.push(new Float32Array(C * N)); this.g.push(new Uint8Array(C)); }
    this.t[ci][ri] = s.t;
    this.g[ci][ri] = guideStep < 0 ? SessionRecorder.NO_STEP : guideStep;
    const d = this.d[ci], o = ri * N;
    d[o] = s.ax; d[o + 1] = s.ay; d[o + 2] = s.az; d[o + 3] = s.gx; d[o + 4] = s.gy; d[o + 5] = s.gz;
    d[o + 6] = trueX; d[o + 7] = trueY;
    d[o + 8] = out.lin[0]; d[o + 9] = out.lin[1];
    d[o + 10] = out.vel[0]; d[o + 11] = out.vel[1];
    d[o + 12] = out.pos[0]; d[o + 13] = out.pos[1];
    d[o + 14] = out.cursor[0]; d[o + 15] = out.cursor[1];
    d[o + 16] = out.still ? 1 : 0; d[o + 17] = out.frozen ? 1 : 0;
    if (out.tap) this.taps.set(this.rows, out.tap.finger);
    this.rows++;
  }

  /** The CSV, built in pieces so a long session doesn't need one giant string. */
  toBlob(): Blob {
    const parts: string[] = [
      `# Wrist Mouse Lab session · ${this.meta}\n` + (this.note ? `${this.note}\n` : ''),
      SessionRecorder.COLUMNS.join(',') + '\n',
    ];
    const C = SessionRecorder.CHUNK, N = SessionRecorder.NUM;
    const f = (v: number, digits: number) => (Number.isFinite(v) ? v.toFixed(digits) : '');
    for (let ci = 0; ci * C < this.rows; ci++) {
      const lines: string[] = [];
      const n = Math.min(C, this.rows - ci * C);
      for (let ri = 0; ri < n; ri++) {
        const d = this.d[ci], o = ri * N;
        lines.push([
          this.t[ci][ri].toFixed(4), f(d[o], 4), f(d[o + 1], 4), f(d[o + 2], 4), f(d[o + 3], 2), f(d[o + 4], 2), f(d[o + 5], 2),
          f(d[o + 6], 5), f(d[o + 7], 5), f(d[o + 8], 4), f(d[o + 9], 4), f(d[o + 10], 5), f(d[o + 11], 5),
          f(d[o + 12], 5), f(d[o + 13], 5), f(d[o + 14], 1), f(d[o + 15], 1), d[o + 16], d[o + 17],
          this.taps.get(ci * C + ri) ?? '',
          ...guideCells(this.g[ci][ri] === SessionRecorder.NO_STEP ? undefined : this.steps[this.g[ci][ri]]),
        ].join(','));
      }
      parts.push(lines.join('\n') + '\n');
    }
    return new Blob(parts, { type: 'text/csv' });
  }
}

/**
 * guide_section, guide_step, guide_move, guide_dir, guide_click: empty outside a guided run.
 * guide_move is the move index (panning) or click index (clicks); dir is 0 and click is empty for non-moves / non-clicks.
 */
function guideCells(st: GuideStep | undefined): string[] {
  if (!st) return ['', '', '', '', ''];
  const indexed = st.kind === 'move' || st.kind === 'click' || st.kind === 'neg';
  return [
    st.section, st.kind, indexed ? String(st.n) : '',
    st.dir > 0 ? '+1' : st.dir < 0 ? '-1' : '0', st.click,
  ];
}

export function download(name: string, text: string | Blob): void {
  const blob = typeof text === 'string' ? new Blob([text], { type: 'text/csv' }) : text;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export interface ReplayData {
  samples: ImuSample[];
  labels: (Finger | null)[];
  trueXY: [number, number][] | null;
  rateHz: number;
  notes: string[];
  labeledTaps: { index: number; finger: Finger }[];
}

const NAMES: Record<string, string[]> = {
  t: ['t', 'time', 'timestamp', 'time_s', 't_s', 'ms', 'millis', 'micros'],
  ax: ['ax', 'acc_x', 'accel_x', 'a_x', 'accx'], ay: ['ay', 'acc_y', 'accel_y', 'a_y', 'accy'], az: ['az', 'acc_z', 'accel_z', 'a_z', 'accz'],
  gx: ['gx', 'gyro_x', 'g_x', 'gyrx'], gy: ['gy', 'gyro_y', 'g_y', 'gyry'], gz: ['gz', 'gyro_z', 'g_z', 'gyrz'],
  label: ['label', 'tap', 'finger', 'class'], tx: ['true_x_m'], ty: ['true_y_m'],
};

function parseLabel(s: string | undefined): Finger | null {
  if (!s) return null;
  const v = s.trim().toLowerCase().replace(/"/g, '');
  if (['index', 'i', '1', 'left', 'l', 'index_tap'].includes(v)) return 'index';
  if (['pinky', 'p', '2', 'right', 'r', 'pinky_tap'].includes(v)) return 'pinky';
  return null;
}

export function parseImuCsv(text: string): ReplayData {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) throw new Error('Empty file');
  const sep = lines[0].includes(',') ? ',' : lines[0].includes(';') ? ';' : /\t/.test(lines[0]) ? '\t' : ',';
  const first = lines[0].split(sep).map(s => s.trim().toLowerCase().replace(/"/g, ''));
  const hasHeader = first.some(c => isNaN(Number(c)) && c !== '');
  const col: Record<string, number> = {};
  if (hasHeader) {
    for (const [k, names] of Object.entries(NAMES)) {
      const idx = first.findIndex(c => names.includes(c));
      if (idx >= 0) col[k] = idx;
    }
    for (const k of ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz']) if (col[k] === undefined) throw new Error(`Missing column "${k}" in header`);
  } else {
    ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'label'].forEach((k, i) => (col[k] = i));
  }
  const notes: string[] = [];
  const raw: number[][] = [];
  const labels: (Finger | null)[] = [];
  const trueXY: [number, number][] = [];
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const c = lines[i].split(sep);
    const vals = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'].map(k => Number(c[col[k]]));
    if (vals.some(v => !isFinite(v))) continue;
    raw.push(vals);
    labels.push(col.label !== undefined ? parseLabel(c[col.label]) : null);
    // blank true-position cells (live recordings have no ground truth) mean "no truth", not 0
    const tx = col.tx !== undefined ? c[col.tx]?.trim() : '', ty = col.ty !== undefined ? c[col.ty]?.trim() : '';
    if (tx && ty) trueXY.push([Number(tx), Number(ty)]);
  }
  if (raw.length < 10) throw new Error('Fewer than 10 valid rows');

  // time units
  const dts = raw.slice(1, 2001).map((r, i) => r[0] - raw[i][0]).filter(d => d > 0).sort((a, b) => a - b);
  let med = dts[Math.floor(dts.length / 2)] ?? 0.001;
  let tScale = 1;
  if (med >= 50) { tScale = 1e-6; notes.push('time in µs → s'); } else if (med >= 0.2) { tScale = 1e-3; notes.push('time in ms → s'); }
  med *= tScale;
  // accel units
  const mags = raw.slice(0, 2000).map(r => Math.hypot(r[1], r[2], r[3])).sort((a, b) => a - b);
  const mMed = mags[Math.floor(mags.length / 2)];
  let aScale = 1;
  if (mMed > 4 && mMed < 20) { aScale = 1 / 9.80665; notes.push('accel in m/s² → g'); }
  else if (mMed > 1000) { aScale = 1 / 16384; notes.push('accel raw LSB (±2 g) → g'); }
  const t0 = raw[0][0] * tScale;
  const samples: ImuSample[] = raw.map(r => ({
    t: r[0] * tScale - t0, ax: r[1] * aScale, ay: r[2] * aScale, az: r[3] * aScale, gx: r[4], gy: r[5], gz: r[6],
  }));
  const labeledTaps: { index: number; finger: Finger }[] = [];
  labels.forEach((l, i) => { if (l && labels[i - 1] !== l) labeledTaps.push({ index: i, finger: l }); });
  return {
    samples, labels, trueXY: trueXY.length === samples.length ? trueXY : null,
    rateHz: Math.round(1 / med), notes, labeledTaps,
  };
}
