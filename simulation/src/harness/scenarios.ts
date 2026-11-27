// Headless, deterministic test scenarios. Each one builds a fresh Session from a
// seed, runs it as fast as the CPU allows, and returns metrics. The live UI and
// the verification script (scripts/verify.ts) both call these.

import type { PipelineConfig, StepKey } from '../pipeline/config.ts';
import type { Finger, LabeledFeatures } from '../pipeline/classifier.ts';
import { TapClassifier } from '../pipeline/classifier.ts';
import type { SimConfig } from '../sim/imu.ts';
import { Script, DEFAULT_STROKES } from '../sim/hand.ts';
import type { Stroke } from '../sim/hand.ts';
import { Session } from './session.ts';
import type { SessionStep } from './session.ts';

export const DESK_W = 0.40, DESK_H = 0.25;      // m
export const START_X = 0.20, START_Y = 0.10;     // m
const BIG = 1e6; // headless runs use an "infinite" screen so the cursor never clamps

function headlessCfg(p: PipelineConfig): PipelineConfig {
  return { ...p, screenW: BIG, screenH: BIG };
}
function withSeed(s: SimConfig, seed: number): SimConfig { return { ...s, seed }; }

// ───────────────────────── Stroke accuracy ─────────────────────────

export interface StrokeResult {
  label: string;
  trueDx: number; trueDy: number;   // cm
  estDx: number; estDy: number;     // cm
  distErrCm: number;                // |est| − |true|
  distErrPct: number;
  dirErrDeg: number;                // signed angle est − true
  endErrCm: number;                 // |est − true|
  cursorPx: number;                 // cursor travel for this stroke
}

export interface PathPoint { t: number; tx: number; ty: number; ex: number; ey: number }

export interface StrokeRun { strokes: StrokeResult[]; path: PathPoint[]; meanEndErrCm: number; meanAbsDirErr: number; meanAbsDistPct: number }
/**
 * Steps a Session through the scripted strokes one sample at a time, so the
 * live UI (a few samples per frame) and the headless runner share the code.
 * The session must already be reset with the hand at (x0, y0).
 */
export class StrokeTestRunner {
  readonly script: Script;
  readonly path: PathPoint[] = [];
  readonly N: number;
  k = 0;
  private snaps = new Map<number, [number, number, number, number]>();
  private lastSeg = -1;
  private readonly fs: number;
  readonly ses: Session;
  readonly strokes: Stroke[];
  readonly x0: number;
  readonly y0: number;
  constructor(ses: Session, strokes: Stroke[], x0: number, y0: number) {
    this.ses = ses; this.strokes = strokes; this.x0 = x0; this.y0 = y0;
    this.fs = ses.sim.cfg.sampleRateHz;
    const p = ses.pipe.cfg;
    this.script = new Script(x0, y0, (p.enableCalibration ? p.calibrationMs / 1000 : 0) + 0.4, strokes, 0);
    this.N = Math.ceil(this.script.duration * this.fs) + 1;
  }
  get done(): boolean { return this.k >= this.N; }
  get progress(): number { return this.k / this.N; }
  /** Index of the stroke currently being performed (or -1). */
  get currentStroke(): number {
    const seg = this.script.segments[this.lastSeg];
    return seg && seg.kind === 'stroke' ? seg.stroke! : -1;
  }
  step(): SessionStep {
    const t = this.k / this.fs;
    const [x, y, seg] = this.script.at(t);
    if (seg !== this.lastSeg) {
      const o = this.ses.pipe.out;
      this.snaps.set(seg, [o.pos[0], o.pos[1], o.cursor[0], o.cursor[1]]);
      this.lastSeg = seg;
    }
    const r = this.ses.step(x, y);
    if (this.k % 10 === 0) this.path.push({ t, tx: x - this.x0, ty: y - this.y0, ex: r.out.pos[0], ey: r.out.pos[1] });
    this.k++;
    return r;
  }
  result(): StrokeRun {
    const o = this.ses.pipe.out;
    this.snaps.set(this.script.segments.length, [o.pos[0], o.pos[1], o.cursor[0], o.cursor[1]]);
    const res: StrokeResult[] = [];
    this.script.segments.forEach((s, i) => {
      if (s.kind !== 'stroke') return;
      const a = this.snaps.get(i), b = this.snaps.get(i + 2); // b = end of the rest after the stroke
      if (!a || !b) return;
      const tdx = s.x1 - s.x0, tdy = s.y1 - s.y0;
      const edx = b[0] - a[0], edy = b[1] - a[1];
      const tl = Math.hypot(tdx, tdy), el = Math.hypot(edx, edy);
      let dir = (Math.atan2(edy, edx) - Math.atan2(tdy, tdx)) * 180 / Math.PI;
      dir = ((dir + 540) % 360) - 180;
      if (el < 1e-6) dir = NaN;
      res.push({
        label: this.strokes[s.stroke!].label,
        trueDx: tdx * 100, trueDy: tdy * 100, estDx: edx * 100, estDy: edy * 100,
        distErrCm: (el - tl) * 100, distErrPct: (el - tl) / tl * 100,
        dirErrDeg: dir, endErrCm: Math.hypot(edx - tdx, edy - tdy) * 100,
        cursorPx: Math.hypot(b[2] - a[2], b[3] - a[3]),
      });
    });
    const mean = (f: (r: StrokeResult) => number) => res.reduce((s, r) => s + (isFinite(f(r)) ? f(r) : 180), 0) / Math.max(1, res.length);
    return {
      strokes: res, path: this.path,
      meanEndErrCm: mean(r => r.endErrCm),
      meanAbsDirErr: mean(r => Math.abs(r.dirErrDeg)),
      meanAbsDistPct: mean(r => Math.abs(r.distErrPct)),
    };
  }
}

export function runStrokeTest(sim: SimConfig, pipe: PipelineConfig, seed: number, clf?: TapClassifier,
  strokes: Stroke[] = DEFAULT_STROKES): StrokeRun {
  const ses = new Session(withSeed(sim, seed), headlessCfg(pipe), clf);
  ses.reset(START_X, START_Y, BIG / 2, BIG / 2);
  const run = new StrokeTestRunner(ses, strokes, START_X, START_Y);
  while (!run.done) run.step();
  return run.result();
}

// ───────────────────────── Back-and-forth swings ─────────────────────────
// Like the real recordings: the hand swings between two marks with no pause. Scored the same way
// as scripts/bench-real.ts scores a real recording (swingShape), so the two can be compared.

/**
 * The path through one back-and-forth phase, measured along its own main axis (cm):
 * each swing between turning points, how far the swings scatter, the sideways spread, and the drift.
 */
export function swingShape(px: Float64Array, py: Float64Array, a: number, b: number) {
  let mx = 0, my = 0;
  for (let i = a; i < b; i++) { mx += px[i]; my += py[i]; }
  mx /= b - a; my /= b - a;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = a; i < b; i++) { const dx = px[i] - mx, dy = py[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
  let clo = Infinity, chi = -Infinity;
  // turning points (zigzag): the extreme reached before the path comes back by more than TURN_CM
  const TURN_CM = 1.5, turns: number[] = [];
  let ext = 0, dir = 0;
  for (let i = a; i < b; i++) {
    const dx = px[i] - mx, dy = py[i] - my, v = (dx * ux + dy * uy) * 100, cr = (-dx * uy + dy * ux) * 100;
    clo = Math.min(clo, cr); chi = Math.max(chi, cr);
    if (i === a) { turns.push(v); ext = v; continue; }
    if (dir === 0) { if (Math.abs(v - turns[0]) > TURN_CM) { dir = v > turns[0] ? 1 : -1; ext = v; } }
    else if (dir === 1) { if (v > ext) ext = v; else if (ext - v > TURN_CM) { turns.push(ext); dir = -1; ext = v; } }
    else { if (v < ext) ext = v; else if (v - ext > TURN_CM) { turns.push(ext); dir = 1; ext = v; } }
  }
  if (dir !== 0) turns.push(ext);
  const swings = turns.slice(1).map((v, k) => Math.abs(v - turns[k])).filter(v => v > TURN_CM);
  const mean = swings.reduce((t, v) => t + v, 0) / Math.max(1, swings.length);
  const scatter = swings.reduce((t, v) => t + Math.abs(v - mean), 0) / Math.max(1, swings.length);
  return { n: swings.length, mean, scatter, side: chi - clo, net: Math.hypot(px[b - 1] - px[a], py[b - 1] - py[a]) * 100 };
}

export interface SwingRun { n: number; mean: number; scatter: number; side: number; net: number; trueCm: number }

/** `swings` back-and-forth swings of `lengthM` along x (or y), each `swingS` long, no pause. */
export function runSwingTest(sim: SimConfig, pipe: PipelineConfig, seed: number,
  opts: { axis?: 'x' | 'y'; lengthM?: number; swingS?: number; swings?: number; restS?: number } = {}): SwingRun {
  const { axis = 'x', lengthM = 0.1, swingS = 0.8, swings = 12, restS = 0 } = opts;
  const strokes: Stroke[] = [];
  for (let i = 0; i < swings; i++) {
    const d = i % 2 === 0 ? lengthM : -lengthM;
    strokes.push({ label: `swing ${i + 1}`, dx: axis === 'x' ? d : 0, dy: axis === 'y' ? d : 0, dur: swingS, rest: restS });
  }
  const ses = new Session(withSeed(sim, seed), headlessCfg(pipe));
  ses.reset(START_X, START_Y, BIG / 2, BIG / 2);
  const lead = (pipe.enableCalibration ? pipe.calibrationMs / 1000 : 0) + 0.4;
  const script = new Script(START_X, START_Y, lead, strokes, 0.5);
  const fs = sim.sampleRateHz, N = Math.ceil(script.duration * fs);
  const px = new Float64Array(N), py = new Float64Array(N);
  for (let k = 0; k < N; k++) { const [x, y] = script.at(k / fs); const o = ses.step(x, y).out; px[k] = o.pos[0]; py[k] = o.pos[1]; }
  const a = Math.round(lead * fs);
  return { ...swingShape(px, py, a, N), trueCm: lengthM * 100 };
}

// ───────────────────────── Drift ─────────────────────────

export interface DriftRun { driftCm: number; cursorPx: number; maxCm: number; durS: number; series: { t: number; cm: number }[] }

/** Hand perfectly still: measure how far the estimate wanders. Session must be freshly reset. */
export class DriftTestRunner {
  readonly N: number;
  readonly calibN: number;
  k = 0;
  private p0 = [0, 0];
  private c0 = [0, 0];
  private maxCm = 0;
  readonly series: { t: number; cm: number }[] = [];
  private readonly fs: number;
  readonly ses: Session;
  readonly x: number;
  readonly y: number;
  readonly durS: number;
  constructor(ses: Session, x: number, y: number, durS: number) {
    this.ses = ses; this.x = x; this.y = y; this.durS = durS;
    this.fs = ses.sim.cfg.sampleRateHz;
    const p = ses.pipe.cfg;
    this.calibN = Math.round((p.enableCalibration ? p.calibrationMs : 0) / 1000 * this.fs) + 1;
    this.N = this.calibN + Math.round(durS * this.fs);
  }
  get done(): boolean { return this.k >= this.N; }
  get progress(): number { return this.k / this.N; }
  get elapsedS(): number { return Math.max(0, (this.k - this.calibN) / this.fs); }
  get currentCm(): number { const o = this.ses.pipe.out; return this.k > this.calibN ? Math.hypot(o.pos[0] - this.p0[0], o.pos[1] - this.p0[1]) * 100 : 0; }
  step(): SessionStep {
    const r = this.ses.step(this.x, this.y);
    const out = r.out;
    if (this.k === this.calibN) { this.p0 = [out.pos[0], out.pos[1]]; this.c0 = [out.cursor[0], out.cursor[1]]; }
    if (this.k >= this.calibN) {
      const d = Math.hypot(out.pos[0] - this.p0[0], out.pos[1] - this.p0[1]) * 100;
      if (d > this.maxCm) this.maxCm = d;
      if ((this.k - this.calibN) % 250 === 0) this.series.push({ t: (this.k - this.calibN) / this.fs, cm: d });
    }
    this.k++;
    return r;
  }
  result(): DriftRun {
    const o = this.ses.pipe.out;
    return {
      driftCm: Math.hypot(o.pos[0] - this.p0[0], o.pos[1] - this.p0[1]) * 100,
      cursorPx: Math.hypot(o.cursor[0] - this.c0[0], o.cursor[1] - this.c0[1]),
      maxCm: this.maxCm, durS: this.durS, series: this.series,
    };
  }
}

export function runDriftTest(sim: SimConfig, pipe: PipelineConfig, seed: number, durS = 30): DriftRun {
  const ses = new Session(withSeed(sim, seed), headlessCfg(pipe));
  ses.reset(START_X, START_Y, BIG / 2, BIG / 2);
  const run = new DriftTestRunner(ses, START_X, START_Y, durS);
  while (!run.done) run.step();
  return run.result();
}

// ───────────────────────── Taps (jolt + classification) ─────────────────────────

export interface TapRun {
  accuracy: number; confusion: number[][]; falseN: number; missed: number;
  meanJumpPx: number; maxJumpPx: number;
}

export function runTapTest(sim: SimConfig, pipe: PipelineConfig, seed: number, clf: TapClassifier, nPerFinger = 15,
  gapS = 0.5): TapRun {
  const ses = new Session(withSeed(sim, seed), headlessCfg(pipe), clf);
  ses.reset(START_X, START_Y, BIG / 2, BIG / 2);
  const fs = sim.sampleRateHz;
  const order: Finger[] = [];
  for (let i = 0; i < nPerFinger; i++) order.push('index', 'pinky');
  const lead = Math.round((pipe.calibrationMs / 1000 + 0.5) * fs);
  const gap = Math.round(gapS * fs);
  const total = lead + order.length * gap + gap;
  const jumps: number[] = [];
  let before: [number, number] | null = null, worst = 0, ti = 0;
  for (let k = 0; k < total; k++) {
    if (k >= lead && (k - lead) % gap === 0 && ti < order.length) {
      if (before) jumps.push(worst);
      before = [ses.pipe.out.cursor[0], ses.pipe.out.cursor[1]];
      worst = 0;
      ses.injectTap(order[ti++]);
    }
    const { out } = ses.step(START_X, START_Y);
    if (before) worst = Math.max(worst, Math.hypot(out.cursor[0] - before[0], out.cursor[1] - before[1]));
  }
  if (before) jumps.push(worst);
  ses.tracker.tick(1e9);
  const st = ses.tracker.stats();
  return {
    accuracy: st.accuracy, confusion: st.confusion, falseN: st.falseN, missed: st.missed,
    meanJumpPx: jumps.reduce((s, v) => s + v, 0) / Math.max(1, jumps.length),
    maxJumpPx: Math.max(0, ...jumps),
  };
}

/** Simulate N taps per finger with the hand still and return labelled feature vectors. */
export function collectTrainingTaps(sim: SimConfig, pipe: PipelineConfig, seed: number, nPerFinger: number): LabeledFeatures[] {
  const ses = new Session(withSeed(sim, seed), headlessCfg({ ...pipe, enableTaps: true }));
  ses.reset(START_X, START_Y, BIG / 2, BIG / 2);
  const fs = sim.sampleRateHz;
  const lead = Math.round((pipe.calibrationMs / 1000 + 0.3) * fs);
  const gap = Math.round(0.35 * fs);
  const order: Finger[] = [];
  for (let i = 0; i < nPerFinger; i++) order.push('index', 'pinky');
  const total = lead + order.length * gap + gap;
  let ti = 0;
  for (let k = 0; k < total; k++) {
    if (k >= lead && (k - lead) % gap === 0 && ti < order.length) ses.injectTap(order[ti++]);
    ses.step(START_X, START_Y);
  }
  ses.tracker.tick(1e9);
  return ses.tracker.records
    .filter(r => r.features && r.truth)
    .map(r => ({ x: r.features!, y: r.truth! }));
}

export function trainSimulated(sim: SimConfig, pipe: PipelineConfig, seed: number, nPerFinger: number): { clf: TapClassifier; data: LabeledFeatures[] } {
  const data = collectTrainingTaps(sim, pipe, seed, nPerFinger);
  const clf = new TapClassifier();
  clf.fit(data, pipe.classifier, `auto-trained on ${data.length} simulated taps`);
  return { clf, data };
}

// ───────────────────────── A/B comparison ─────────────────────────

export interface Agg { mean: number; std: number; values: number[] }
export interface ABMetric { key: string; label: string; unit: string; group: string; a: Agg; b: Agg; lowerIsBetter: boolean }
export interface ABResult { step: StepKey; stepLabel: string; repeats: number; metrics: ABMetric[]; strokeLabels: string[] }

function agg(values: number[]): Agg {
  const v = values.filter(x => isFinite(x));
  const mean = v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
  const std = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, v.length));
  return { mean, std, values };
}

export interface ABOptions { strokes: boolean; drift: boolean; taps: boolean; repeats: number; driftS: number; baseSeed: number }

const tick = () => new Promise<void>(r => setTimeout(r, 0));

export async function runAB(step: StepKey, stepLabel: string, sim: SimConfig, pipe: PipelineConfig, clf: TapClassifier,
  opt: ABOptions, onProgress?: (f: number) => void): Promise<ABResult> {
  const cfgA = { ...pipe, [step]: false } as PipelineConfig;
  const cfgB = { ...pipe, [step]: true } as PipelineConfig;
  const metrics: ABMetric[] = [];
  const jobs = (opt.strokes ? 1 : 0) + (opt.drift ? 1 : 0) + (opt.taps ? 1 : 0);
  let done = 0;
  const prog = () => onProgress?.(done / (jobs * opt.repeats * 2));
  let strokeLabels: string[] = [];

  if (opt.strokes) {
    const A: StrokeRun[] = [], B: StrokeRun[] = [];
    for (let r = 0; r < opt.repeats; r++) {
      A.push(runStrokeTest(sim, cfgA, opt.baseSeed + r, clf)); done++; prog(); await tick();
      B.push(runStrokeTest(sim, cfgB, opt.baseSeed + r, clf)); done++; prog(); await tick();
    }
    strokeLabels = A[0].strokes.map(s => s.label);
    strokeLabels.forEach((lab, i) => {
      metrics.push({
        key: `end${i}`, label: lab, unit: 'cm', group: 'Stroke end-point error', lowerIsBetter: true,
        a: agg(A.map(x => x.strokes[i].endErrCm)), b: agg(B.map(x => x.strokes[i].endErrCm)),
      });
    });
    metrics.push({ key: 'endMean', label: 'Mean end-point error', unit: 'cm', group: 'Stroke summary', lowerIsBetter: true, a: agg(A.map(x => x.meanEndErrCm)), b: agg(B.map(x => x.meanEndErrCm)) });
    metrics.push({ key: 'dist', label: 'Mean |distance error|', unit: '%', group: 'Stroke summary', lowerIsBetter: true, a: agg(A.map(x => x.meanAbsDistPct)), b: agg(B.map(x => x.meanAbsDistPct)) });
    metrics.push({ key: 'dir', label: 'Mean |direction error|', unit: '°', group: 'Stroke summary', lowerIsBetter: true, a: agg(A.map(x => x.meanAbsDirErr)), b: agg(B.map(x => x.meanAbsDirErr)) });
  }
  if (opt.drift) {
    const A: DriftRun[] = [], B: DriftRun[] = [];
    for (let r = 0; r < opt.repeats; r++) {
      A.push(runDriftTest(sim, cfgA, opt.baseSeed + r, opt.driftS)); done++; prog(); await tick();
      B.push(runDriftTest(sim, cfgB, opt.baseSeed + r, opt.driftS)); done++; prog(); await tick();
    }
    metrics.push({ key: 'drift', label: `Drift after ${opt.driftS} s still`, unit: 'cm', group: 'Drift', lowerIsBetter: true, a: agg(A.map(x => x.driftCm)), b: agg(B.map(x => x.driftCm)) });
    metrics.push({ key: 'driftPx', label: `Cursor drift after ${opt.driftS} s`, unit: 'px', group: 'Drift', lowerIsBetter: true, a: agg(A.map(x => x.cursorPx)), b: agg(B.map(x => x.cursorPx)) });
  }
  if (opt.taps) {
    const A: TapRun[] = [], B: TapRun[] = [];
    for (let r = 0; r < opt.repeats; r++) {
      A.push(runTapTest(sim, cfgA, opt.baseSeed + r, clf)); done++; prog(); await tick();
      B.push(runTapTest(sim, cfgB, opt.baseSeed + r, clf)); done++; prog(); await tick();
    }
    metrics.push({ key: 'jump', label: 'Cursor jump per tap', unit: 'px', group: 'Taps', lowerIsBetter: true, a: agg(A.map(x => x.meanJumpPx)), b: agg(B.map(x => x.meanJumpPx)) });
    metrics.push({ key: 'acc', label: 'Finger classification accuracy', unit: '%', group: 'Taps', lowerIsBetter: false, a: agg(A.map(x => (isFinite(x.accuracy) ? x.accuracy * 100 : 0))), b: agg(B.map(x => (isFinite(x.accuracy) ? x.accuracy * 100 : 0))) });
    metrics.push({ key: 'false', label: 'False / missed clicks', unit: '', group: 'Taps', lowerIsBetter: true, a: agg(A.map(x => x.falseN + x.missed)), b: agg(B.map(x => x.falseN + x.missed)) });
  }
  onProgress?.(1);
  return { step, stepLabel, repeats: opt.repeats, metrics, strokeLabels };
}
