// Streaming click detector: finds index (left click) and pinky (right click) taps in the live IMU
// stream and decides which finger made each one. Causal, sample by sample; scripts/train-clicks.ts
// runs this same class over the recordings, so the models are fitted on exactly the features the
// live tester computes.
//
// A tap is a sharp, short transient while the hand is otherwise at rest. Hand lifts, slides and
// wrist rotations are slow or sustained: sliding on the desk keeps the accelerometer buzzing
// before and after, and a lift or rotation leaves low-frequency motion. So the detector looks at
// the quiet before the peak and at how fast the tap dies away after it.
//
// Per sample (fs = 1 kHz):
//   accel: 20 Hz high-pass (tap band, a20), 5 Hz high-pass (a5, wider view), 1-10 Hz band (aLF, motion)
//   gyro:  2 Hz high-pass magnitude (gm, motion) and 20 Hz high-pass magnitude (tap band)
// Stage 1, candidate: a20 is the largest within +/-PEAK_HALF_S around p and above the amplitude
//   threshold max(AMP_MIN_G, K_NOISE x noise) / sensitivity, at least REFRACTORY_S after the last tap.
//   The noise unit is the median of 10 ms maxima of a20 over the last 6 s, so a still hand sets it
//   and brief activity (taps, a hand moving to the mouse) does not.
// Stage 2, tap or not: DECISION_DELAY_S after p, the features below are computed from
//   [p - 1 s, p + 150 ms] and a logistic model (TapModel) scores them. The score must reach the model's
//   threshold, lowered by sensitivity. Quiet before, short ring, quiet again 100-150 ms later = tap.
// Stage 3, which finger: an LDA model (SideModel) on the tap's peak amplitude and its spectral share (lpk, lfshare).
//   Neither uses the sensitivity. A personal profile (teach.ts) moves the class centres and the gate.

import { CLICK_MODEL } from './model.ts';

export type Side = 'L' | 'R';

/** Logistic regression on standardised features: score = bias + sum w_q (x_q - mean_q) / std_q. A tap if score >= threshold. */
export interface TapModel {
  features: string[];   // names from FEATURE_NAMES, in weight order
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
  threshold: number;    // accept when the score reaches this (at sensitivity 1)
}

/** Linear discriminant between index (L) and pinky (R): shared covariance, class means in feature space. */
export interface SideModel {
  features: string[];
  muL: number[];
  muR: number[];
  cov: number[];        // k x k, row-major, pooled within-class covariance
}

export interface ClickModel {
  tap: TapModel;
  side: SideModel;
  trainedOn: string[];  // recording file names (documentation only)
}

/** Per-user adjustment learned by the teach step (see teach.ts). Every field is optional. */
export interface ClickProfile {
  muL?: number[];       // index class centre, in SideModel feature order
  muR?: number[];       // pinky class centre
  gateShift?: number;   // added to the tap model's threshold
  ampMinG?: number;     // replaces AMP_MIN_G
}

/** One IMU reading: t in seconds, accel in g, gyro in deg/s (the same shape as the pipeline's ImuSample). */
export interface ImuReading {
  t: number;
  ax: number; ay: number; az: number;
  gx: number; gy: number; gz: number;
}

export interface ClickEvent {
  t: number;                        // time of the tap's peak (device seconds)
  side: Side;                       // 'L' = index (left click), 'R' = pinky (right click)
  prob: number;                     // classifier confidence in `side`, 0.5..1
  peakG: number;                    // peak of the 20 Hz-high-passed accel magnitude, g
  tapScore: number;                 // tap-model score (NaN with no model)
  accepted: boolean;                // false only for rejected candidates when emitRejected is set
  features: Record<string, number>; // derived features, keyed by FEATURE_NAMES
}

export interface ClickDetectorOptions {
  sampleRateHz: number;
  sensitivity?: number;             // amplitude threshold and tap gate are relaxed by this (1 = as trained)
  model?: ClickModel | null;        // default: CLICK_MODEL. null: every candidate is returned, side 'L' prob 0.5
  profile?: ClickProfile | null;
  emitRejected?: boolean;           // also return candidates the tap model refused (accepted = false)
}

/** Derived features (see features()); the models use subsets. */
export const FEATURE_NAMES = [
  'lpk',        // ln peak of a20 (g)
  'lpk5',       // ln peak of a5 around the tap (g)
  'lratio',     // ln(peak / quiet before): a20 rms 40-300 ms before the peak
  'lnear',      // same with the 30-120 ms before
  'lpre1s',     // ln(peak / a20 rms 0.3-1 s before)
  'prelf1s',    // ln(aLF rms 0.3-1 s before / peak + 0.01): slow motion before
  'lhw',        // ln(half-peak width of a20, samples)
  'lpost150',   // ln(a20 rms 100-150 ms after / peak + 0.01): has the ring died away
  'lpost40',    // ln(a20 rms 40-100 ms after / peak + 0.01)
  'postlf',     // ln(aLF rms 30-100 ms after / peak + 0.01)
  'lpostg150',  // ln(1 + gyro rms 60-150 ms after, deg/s)
  'lfshare',    // ln(peak a5 / peak a20)
  'lg20rel',    // ln(gyro tap-band peak / a20 peak + 0.01)
  'prelf',      // ln(aLF rms 40-300 ms before / peak + 0.01): slow motion just before (a hand coming down)
  'lpreg',      // ln(1 + gyro rms 40-300 ms before, deg/s)
  'lpostg',     // ln(1 + gyro rms 30-100 ms after, deg/s)
] as const;

export const DECISION_DELAY_S = 0.15;
export const REFRACTORY_S = 0.15;
export const PEAK_HALF_S = 0.15;
export const READY_S = 1.3;          // history needed before the first decision
export const AMP_MIN_G = 0.05;       // lowest candidate peak (a20), g
const K_NOISE = 8;                   // candidate peak >= K_NOISE x noise unit
const NOISE_BIN_S = 0.01;
const NOISE_BINS = 600;              // 6 s
const NOISE_MIN_BINS = 100;          // 1 s
const MAX_HALF_SEARCH_S = 0.2;

// ring buffer slots
const TIME = 0, AX = 1, AY = 2, AZ = 3, GX = 4, GY = 5, GZ = 6, A20 = 7, A5 = 8, ALF = 9, GM = 10, G20 = 11;
const SLOTS = 12;

type FilterKind = 'hp' | 'lp';

/** 2nd-order Butterworth (RBJ form), run causally: one sample in, one out. */
class Biquad {
  private readonly b0: number; private readonly b1: number; private readonly b2: number;
  private readonly a1: number; private readonly a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private started = false;
  private readonly lowpass: boolean;

  constructor(kind: FilterKind, fc: number, fs: number) {
    const w0 = (2 * Math.PI * fc) / fs;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    if (kind === 'hp') {
      this.b0 = (1 + cw) / 2 / a0;
      this.b1 = -(1 + cw) / a0;
    } else {
      this.b0 = (1 - cw) / 2 / a0;
      this.b1 = (1 - cw) / a0;
    }
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    this.lowpass = kind === 'lp';
  }

  process(x: number): number {
    // start in the steady state of a constant input, so a resting sensor gives no start-up step
    if (!this.started) {
      this.started = true;
      this.x1 = x; this.x2 = x;
      if (this.lowpass) { this.y1 = x; this.y2 = x; }
    }
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const bank = (n: number, kind: FilterKind, fc: number, fs: number): Biquad[] =>
  Array.from({ length: n }, () => new Biquad(kind, fc, fs));

/** P(L) from the side model at feature vector x (feature order of model.features). */
export function sideProbL(model: SideModel, x: number[], muL = model.muL, muR = model.muR): number {
  const k = model.features.length;
  const w = solve(model.cov, k, muL.map((v, q) => v - muR[q]));
  let a = 0;
  for (let q = 0; q < k; q++) a += w[q] * (x[q] - 0.5 * (muL[q] + muR[q]));
  return 1 / (1 + Math.exp(-a));
}

/** Solves C w = d for a small symmetric positive-definite C (Gaussian elimination with pivoting). */
export function solve(C: number[], k: number, d: number[]): number[] {
  const M = C.slice();
  const b = d.slice();
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r * k + c]) > Math.abs(M[piv * k + c])) piv = r;
    if (piv !== c) {
      for (let j = 0; j < k; j++) { const t = M[c * k + j]; M[c * k + j] = M[piv * k + j]; M[piv * k + j] = t; }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    const p = M[c * k + c] || 1e-12;
    for (let r = c + 1; r < k; r++) {
      const f = M[r * k + c] / p;
      for (let j = c; j < k; j++) M[r * k + j] -= f * M[c * k + j];
      b[r] -= f * b[c];
    }
  }
  const w = new Array<number>(k).fill(0);
  for (let r = k - 1; r >= 0; r--) {
    let s = b[r];
    for (let j = r + 1; j < k; j++) s -= M[r * k + j] * w[j];
    w[r] = s / (M[r * k + r] || 1e-12);
  }
  return w;
}

export class ClickDetector {
  readonly fs: number;
  private readonly model: ClickModel | null;
  private readonly decision: number;     // decision delay, samples
  private readonly peakHalf: number;
  private readonly refractory: number;
  private readonly readyAt: number;
  private readonly mask: number;
  private readonly ring: Float64Array[] = [];
  private readonly hp20a: Biquad[]; private readonly hp5a: Biquad[];
  private readonly lpA: Biquad[]; private readonly hp1A: Biquad[];
  private readonly hp2g: Biquad[]; private readonly hp20g: Biquad[];
  private readonly binLen: number;

  private n = 0;                         // samples processed
  private sens: number;
  private profile: ClickProfile | null;
  private emitRejected: boolean;
  private lastTap = -Infinity;           // sample index of the last accepted peak
  // noise unit: median of 10 ms maxima of a20
  private readonly bins = new Float64Array(NOISE_BINS);
  private binCount = 0;
  private binPos = 0;
  private binMax = 0;
  private binFill = 0;
  private noiseUnit = 0;

  constructor(opts: ClickDetectorOptions) {
    if (!(opts.sampleRateHz > 0)) throw new Error('ClickDetector needs a sample rate');
    this.fs = opts.sampleRateHz;
    this.sens = opts.sensitivity ?? 1;
    this.model = opts.model === undefined ? CLICK_MODEL : opts.model;
    this.profile = opts.profile ?? null;
    this.emitRejected = opts.emitRejected ?? false;
    for (const name of [...(this.model?.tap.features ?? []), ...(this.model?.side.features ?? [])]) {
      if (!(FEATURE_NAMES as readonly string[]).includes(name)) throw new Error(`unknown click feature "${name}"`);
    }
    const fs = this.fs;
    this.decision = Math.round(DECISION_DELAY_S * fs);
    this.peakHalf = Math.round(PEAK_HALF_S * fs);
    this.refractory = Math.round(REFRACTORY_S * fs);
    this.readyAt = Math.round(READY_S * fs);
    this.binLen = Math.max(1, Math.round(NOISE_BIN_S * fs));
    let size = 4096;
    while (size < 4 * fs) size *= 2;   // at least 4 s of history
    this.mask = size - 1;
    for (let k = 0; k < SLOTS; k++) this.ring.push(new Float64Array(size));
    this.hp20a = bank(3, 'hp', 20, fs);
    this.hp5a = bank(3, 'hp', 5, fs);
    this.lpA = bank(3, 'lp', 10, fs);
    this.hp1A = bank(3, 'hp', 1, fs);
    this.hp2g = bank(3, 'hp', 2, fs);
    this.hp20g = bank(3, 'hp', 20, fs);
  }

  get sensitivity(): number { return this.sens; }
  set sensitivity(v: number) { if (v > 0) this.sens = v; }
  get calibrating(): boolean { return this.binCount < NOISE_MIN_BINS || this.n < this.readyAt; }
  get samplesSeen(): number { return this.n; }

  setProfile(p: ClickProfile | null): void { this.profile = p; }
  /** Also return candidates the tap model refused (used while teaching). */
  set rejectedEvents(on: boolean) { this.emitRejected = on; }
  getProfile(): ClickProfile | null { return this.profile; }

  /** Share of the start-up time collected so far, 0..1. */
  calibrationProgress(): number {
    return Math.min(1, this.n / this.readyAt, this.binCount / NOISE_MIN_BINS);
  }

  /** Noise unit (median of 10 ms maxima of the tap-band accel, g), or null while starting up. */
  noiseUnitG(): number | null { return this.calibrating ? null : this.noiseUnit; }

  /** Current candidate threshold on the tap-band peak, g (Infinity while starting up: nothing is detected then). */
  threshold(): number {
    if (this.calibrating) return Infinity;
    return Math.max(this.profile?.ampMinG ?? AMP_MIN_G, K_NOISE * this.noiseUnit) / this.sens;
  }

  /** Tap-model threshold in use now (sensitivity lowers it by 1.5 per doubling; the profile shifts it). */
  gateThreshold(): number {
    const t = this.model?.tap.threshold ?? 0;
    return t + (this.profile?.gateShift ?? 0) - 1.5 * Math.log2(this.sens);
  }

  /** Forgets the noise estimate and measures it again from now (the hand should be still). */
  recalibrate(): void {
    this.binCount = 0; this.binPos = 0; this.binFill = 0; this.binMax = 0;
  }

  /** The newest `seconds` of the tap-band accel magnitude (oldest first), with the device time of each sample. */
  recent(seconds: number): { t: Float64Array; acc: Float64Array } {
    const count = Math.max(0, Math.min(this.n, Math.round(seconds * this.fs)));
    const t = new Float64Array(count), acc = new Float64Array(count);
    const start = this.n - count;
    for (let k = 0; k < count; k++) {
      const m = (start + k) & this.mask;
      t[k] = this.ring[TIME][m];
      acc[k] = this.ring[A20][m];
    }
    return { t, acc };
  }

  /** Feeds the next reading. Returns a tap when one is confirmed (DECISION_DELAY_S after its peak). */
  step(s: ImuReading): ClickEvent | null {
    const i = this.n++;
    const m = i & this.mask;
    const R = this.ring;
    const a = [s.ax, s.ay, s.az], g = [s.gx, s.gy, s.gz];

    R[TIME][m] = s.t;
    let s20 = 0, s5 = 0, sLF = 0, sGm = 0, sG20 = 0;
    for (let k = 0; k < 3; k++) {
      const v20 = this.hp20a[k].process(a[k]);
      const v5 = this.hp5a[k].process(a[k]);
      const vLF = this.hp1A[k].process(this.lpA[k].process(a[k]));
      const vg2 = this.hp2g[k].process(g[k]);
      const vg20 = this.hp20g[k].process(g[k]);
      R[AX + k][m] = v20;
      R[GX + k][m] = vg20;
      s20 += v20 * v20; s5 += v5 * v5; sLF += vLF * vLF; sGm += vg2 * vg2; sG20 += vg20 * vg20;
    }
    R[A20][m] = Math.sqrt(s20);
    R[A5][m] = Math.sqrt(s5);
    R[ALF][m] = Math.sqrt(sLF);
    R[GM][m] = Math.sqrt(sGm);
    R[G20][m] = Math.sqrt(sG20);

    this.updateNoise(R[A20][m]);
    if (this.calibrating) return null;

    // judge the candidate peak that is now DECISION_DELAY_S old
    const p = i - this.decision;
    if (p < this.readyAt || p - this.lastTap <= this.refractory) return null;
    const v = R[A20][p & this.mask];
    if (v < this.threshold()) return null;
    if (!this.isPeak(p)) return null;

    const features = this.features(p);
    let tapScore = NaN;
    let accepted = true;
    if (this.model) {
      tapScore = this.score(features);
      accepted = tapScore >= this.gateThreshold();
    }
    if (!accepted && !this.emitRejected) return null;
    if (accepted) this.lastTap = p;
    const { side, prob } = this.classify(features);
    return { t: R[TIME][p & this.mask], side, prob, peakG: v, tapScore, accepted, features };
  }

  private updateNoise(a20: number): void {
    if (a20 > this.binMax) this.binMax = a20;
    if (++this.binFill < this.binLen) return;
    this.bins[this.binPos] = this.binMax;
    this.binPos = (this.binPos + 1) % NOISE_BINS;
    if (this.binCount < NOISE_BINS) this.binCount++;
    this.binFill = 0;
    this.binMax = 0;
    // the median of the stored maxima, refreshed about 4 times a second
    if (this.binCount >= NOISE_MIN_BINS && (this.binPos & 15) === 0) {
      const v = Array.from(this.bins.subarray(0, this.binCount)).sort((x, y) => x - y);
      this.noiseUnit = v[v.length >> 1];
    }
  }

  /** p is the largest a20 within +/-PEAK_HALF_S: a tap's small shoulder before its main peak loses to it. */
  private isPeak(p: number): boolean {
    const v = this.ring[A20][p & this.mask];
    for (let j = p - this.peakHalf; j <= p + this.peakHalf; j++) {
      if (j !== p && this.ring[A20][j & this.mask] > v) return false;
    }
    return true;
  }

  private ms(x: number): number { return Math.round((x * this.fs) / 1000); }

  private rms(slot: number, a: number, b: number): number {
    const arr = this.ring[slot], mask = this.mask;
    let s = 0;
    for (let j = a; j <= b; j++) { const v = arr[j & mask]; s += v * v; }
    return Math.sqrt(s / (b - a + 1));
  }

  private maxIn(slot: number, a: number, b: number): number {
    const arr = this.ring[slot], mask = this.mask;
    let best = 0;
    for (let j = a; j <= b; j++) { const v = arr[j & mask]; if (v > best) best = v; }
    return best;
  }

  /** Duration in samples that a20 stays above half its peak around p (right side cut at the decision delay). */
  private halfWidth(p: number): number {
    const acc = this.ring[A20];
    const half = 0.5 * acc[p & this.mask];
    let l = p, r = p;
    const maxL = Math.round(MAX_HALF_SEARCH_S * this.fs);
    while (p - l < maxL && acc[(l - 1) & this.mask] > half) l--;
    while (r - p < this.decision && acc[(r + 1) & this.mask] > half) r++;
    return r - l + 1;
  }

  private features(p: number): Record<string, number> {
    const ms = (x: number) => this.ms(x);
    const pk = this.ring[A20][p & this.mask];
    const pk5 = this.maxIn(A5, p - ms(100), p + ms(100));
    const preHF = this.rms(A20, p - ms(300), p - ms(40));
    const near = this.rms(A20, p - ms(120), p - ms(30));
    const pre1s = this.rms(A20, p - ms(1000), p - ms(300));
    const preLF1s = this.rms(ALF, p - ms(1000), p - ms(300));
    const post150 = this.rms(A20, p + ms(100), p + ms(150));
    const post40 = this.rms(A20, p + ms(40), p + ms(100));
    const postLF = this.rms(ALF, p + ms(30), p + ms(100));
    const postG = this.rms(GM, p + ms(60), p + ms(150));
    const preLF = this.rms(ALF, p - ms(300), p - ms(40));
    const preG = this.rms(GM, p - ms(300), p - ms(40));
    const postG2 = this.rms(GM, p + ms(30), p + ms(100));
    const g20 = this.maxIn(G20, p - ms(20), p + ms(20));
    const ln = Math.log;
    return {
      lpk: ln(pk),
      lpk5: ln(pk5 + 1e-6),
      lratio: ln(pk / (preHF + 0.004)),
      lnear: ln(pk / (near + 0.004)),
      lpre1s: ln(pk / (pre1s + 0.004)),
      prelf1s: ln(preLF1s / pk + 0.01),
      lhw: ln(this.halfWidth(p)),
      lpost150: ln(post150 / pk + 0.01),
      lpost40: ln(post40 / pk + 0.01),
      postlf: ln(postLF / pk + 0.01),
      lpostg150: ln(1 + postG),
      lfshare: ln((pk5 + 1e-6) / pk),
      lg20rel: ln(g20 / pk + 0.01),
      prelf: ln(preLF / pk + 0.01),
      lpreg: ln(1 + preG),
      lpostg: ln(1 + postG2),
    };
  }

  private score(f: Record<string, number>): number {
    const t = this.model!.tap;
    let a = t.bias;
    for (let q = 0; q < t.features.length; q++) a += t.weights[q] * ((f[t.features[q]] - t.mean[q]) / t.std[q]);
    return a;
  }

  private classify(f: Record<string, number>): { side: Side; prob: number } {
    const model = this.model;
    if (!model) return { side: 'L', prob: 0.5 };
    const sm = model.side;
    const x = sm.features.map(name => f[name]);
    const pL = sideProbL(sm, x, this.profile?.muL ?? sm.muL, this.profile?.muR ?? sm.muR);
    return pL >= 0.5 ? { side: 'L', prob: pL } : { side: 'R', prob: 1 - pL };
  }
}
