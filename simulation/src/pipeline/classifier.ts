// Tap feature extraction + a tiny trainable classifier (index vs pinky).
// No hard-coded decision rule: the decision boundary is learned from recorded
// taps. Both models are a handful of floats, trivially portable to the ESP32.

import type { ClassifierKind } from './config.ts';

export type Finger = 'index' | 'pinky';

export const FEATURE_NAMES = [
  'peak ax', 'peak ay', 'peak az',          // signed value at max |a| per axis (g)
  'peak gx', 'peak gy', 'peak gz',          // signed value at max |ω| per axis (°/s)
  'rms ax', 'rms ay', 'rms az',             // RMS over the window (g)
  'peak |a|',                               // overall impact strength (g)
  'duration',                               // ms above half the peak magnitude
  'gyro/accel',                             // ratio of rotational to linear response
] as const;
export const N_FEATURES = FEATURE_NAMES.length;

/**
 * Extract the feature vector from a baseline-removed window.
 * acc: n×3 interleaved (g), gyr: n×3 interleaved (°/s), dtMs: sample period.
 */
export function extractFeatures(acc: Float64Array, gyr: Float64Array, n: number, dtMs: number): number[] {
  const f = new Array<number>(N_FEATURES).fill(0);
  let peakMag = 0;
  const mag = new Float64Array(n);
  for (let ax = 0; ax < 3; ax++) {
    let best = 0, bestAbs = -1, ss = 0, gBest = 0, gBestAbs = -1;
    for (let i = 0; i < n; i++) {
      const a = acc[i * 3 + ax];
      ss += a * a;
      if (Math.abs(a) > bestAbs) { bestAbs = Math.abs(a); best = a; }
      const g = gyr[i * 3 + ax];
      if (Math.abs(g) > gBestAbs) { gBestAbs = Math.abs(g); gBest = g; }
    }
    f[ax] = best;
    f[3 + ax] = gBest;
    f[6 + ax] = Math.sqrt(ss / Math.max(1, n));
  }
  let gyroPeak = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]);
    mag[i] = m;
    if (m > peakMag) peakMag = m;
    const gm = Math.hypot(gyr[i * 3], gyr[i * 3 + 1], gyr[i * 3 + 2]);
    if (gm > gyroPeak) gyroPeak = gm;
  }
  let above = 0;
  for (let i = 0; i < n; i++) if (mag[i] > 0.5 * peakMag) above++;
  f[9] = peakMag;
  f[10] = above * dtMs;
  f[11] = gyroPeak / Math.max(1e-3, peakMag) / 100; // (°/s per g) / 100
  return f;
}

export interface LabeledFeatures { x: number[]; y: Finger }

export interface Prediction { finger: Finger; confidence: number; pIndex: number }

/** Trainable binary classifier with z-score standardisation. */
export class TapClassifier {
  kind: ClassifierKind = 'logistic';
  trained = false;
  source = 'untrained';
  mean = new Array<number>(N_FEATURES).fill(0);
  std = new Array<number>(N_FEATURES).fill(1);
  // logistic regression: p(pinky) = σ(w·z + b)
  w = new Array<number>(N_FEATURES).fill(0);
  b = 0;
  // nearest centroid (in standardised space)
  cIndex = new Array<number>(N_FEATURES).fill(0);
  cPinky = new Array<number>(N_FEATURES).fill(0);

  private z(x: number[]): number[] {
    return x.map((v, i) => (v - this.mean[i]) / this.std[i]);
  }

  fit(data: LabeledFeatures[], kind: ClassifierKind, source = 'trained'): void {
    this.kind = kind;
    const nI = data.filter(d => d.y === 'index').length;
    const nP = data.length - nI;
    if (nI < 1 || nP < 1) { this.trained = false; return; }
    for (let j = 0; j < N_FEATURES; j++) {
      let m = 0;
      for (const d of data) m += d.x[j];
      m /= data.length;
      let v = 0;
      for (const d of data) v += (d.x[j] - m) ** 2;
      this.mean[j] = m;
      this.std[j] = Math.sqrt(v / data.length) || 1;
    }
    const Z = data.map(d => this.z(d.x));
    const Y = data.map(d => (d.y === 'pinky' ? 1 : 0));

    // centroids
    this.cIndex.fill(0); this.cPinky.fill(0);
    Z.forEach((z, i) => {
      const c = Y[i] ? this.cPinky : this.cIndex;
      for (let j = 0; j < N_FEATURES; j++) c[j] += z[j];
    });
    for (let j = 0; j < N_FEATURES; j++) { this.cIndex[j] /= nI; this.cPinky[j] /= nP; }

    // logistic regression, batch gradient descent with L2
    this.w.fill(0); this.b = 0;
    const lr = 0.3, l2 = 0.01, iters = 400;
    const gw = new Array<number>(N_FEATURES);
    for (let it = 0; it < iters; it++) {
      gw.fill(0);
      let gb = 0;
      for (let i = 0; i < Z.length; i++) {
        const p = sigmoid(dot(this.w, Z[i]) + this.b);
        const e = p - Y[i];
        for (let j = 0; j < N_FEATURES; j++) gw[j] += e * Z[i][j];
        gb += e;
      }
      for (let j = 0; j < N_FEATURES; j++) this.w[j] -= lr * (gw[j] / Z.length + l2 * this.w[j]);
      this.b -= lr * gb / Z.length;
    }
    this.trained = true;
    this.source = source;
  }

  predict(x: number[]): Prediction {
    if (!this.trained) return { finger: 'index', confidence: 0, pIndex: 0.5 };
    const z = this.z(x);
    let pP: number;
    if (this.kind === 'logistic') {
      pP = sigmoid(dot(this.w, z) + this.b);
    } else {
      const dI = dist2(z, this.cIndex), dP = dist2(z, this.cPinky);
      // soft-max over negative squared distances → pseudo-probability
      pP = 1 / (1 + Math.exp(Math.max(-50, Math.min(50, (dP - dI) / 2))));
    }
    const finger: Finger = pP >= 0.5 ? 'pinky' : 'index';
    return { finger, confidence: Math.max(pP, 1 - pP), pIndex: 1 - pP };
  }

  /** Leave-one-out confusion matrix [[ii, ip], [pi, pp]] (rows = truth). */
  static leaveOneOut(data: LabeledFeatures[], kind: ClassifierKind): number[][] {
    const cm = [[0, 0], [0, 0]];
    const tmp = new TapClassifier();
    for (let i = 0; i < data.length; i++) {
      const train = data.filter((_, j) => j !== i);
      tmp.fit(train, kind);
      if (!tmp.trained) continue;
      const p = tmp.predict(data[i].x).finger;
      cm[data[i].y === 'index' ? 0 : 1][p === 'index' ? 0 : 1]++;
    }
    return cm;
  }

  /** Fisher score per feature — used by the UI to pick the 2 most telling axes. */
  static fisherScores(data: LabeledFeatures[]): number[] {
    const out: number[] = [];
    for (let j = 0; j < N_FEATURES; j++) {
      const a = data.filter(d => d.y === 'index').map(d => d.x[j]);
      const b = data.filter(d => d.y === 'pinky').map(d => d.x[j]);
      if (!a.length || !b.length) { out.push(0); continue; }
      const ma = avg(a), mb = avg(b);
      const va = avg(a.map(v => (v - ma) ** 2)), vb = avg(b.map(v => (v - mb) ** 2));
      out.push((ma - mb) ** 2 / (va + vb + 1e-12));
    }
    return out;
  }

  toJSON(): object {
    return { kind: this.kind, mean: this.mean, std: this.std, w: this.w, b: this.b, cIndex: this.cIndex, cPinky: this.cPinky };
  }
}

function sigmoid(x: number): number { return 1 / (1 + Math.exp(-Math.max(-50, Math.min(50, x)))); }
function dot(a: number[], b: number[]): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function dist2(a: number[], b: number[]): number { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s; }
function avg(a: number[]): number { return a.reduce((s, v) => s + v, 0) / a.length; }
