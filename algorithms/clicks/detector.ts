// Streaming click detector: finds index (left click) and pinky (right click) taps in the live IMU
// stream and classifies each one. It is the causal, sample-by-sample form of the rule in
// scripts/analyze-clicks.ts. scripts/train-clicks.ts runs this same class over the recordings,
// so the model is fitted on exactly the features the live tester computes.
//
// Per sample:
//   1. 2nd-order Butterworth high-pass (5 Hz) on each accel and gyro axis, and at 30 Hz on the accel axes.
//   2. Magnitudes: acc5 (accel, 5 Hz), acc30 (accel, 30 Hz), gyr5 (gyro, 5 Hz).
//   3. A candidate tap is the largest acc5 within +/-DECISION_DELAY_S of its peak. It is judged
//      DECISION_DELAY_S after the peak, so every test uses only samples already seen:
//        amp     acc5 >= 5 x noise rms              (both thresholds divided by sensitivity)
//        sharp   acc30 >= 5 x noise rms within +/-20 ms
//        short   acc5 stays above half its peak for <= 80 ms (the right side is cut at the decision delay)
//        gyro    gyr5 >= 4 x noise rms within +/-50 ms
//      and it must come at least REFRACTORY_S after the previous accepted tap.
//   4. An accepted tap gets 16 raw features over +/-100 ms around its peak. A logistic regression
//      (CLICK_MODEL) then decides L (index) or R (pinky).
//
// Noise floor: the detector waits WARMUP_S for the filters to settle and then averages the still
// hand for CALIBRATE_S. After that the average keeps running, but only while no tap was seen for
// QUIET_S and acc5 stays below the detection threshold (a tap never raises the floor).

import { CLICK_MODEL } from './model.ts';

export type Side = 'L' | 'R';

/** Logistic regression on standardised features: P(L) = sigmoid(bias + sum w_q (x_q - mean_q) / std_q). */
export interface ClickModel {
  features: string[];   // names from FEATURE_NAMES, in weight order
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
  trainedOn: string[];  // recording file names (documentation only)
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
  peakG: number;                    // peak of the 5 Hz-high-passed accel magnitude, g
  features: Record<string, number>; // raw features, keyed by FEATURE_NAMES
}

export interface ClickDetectorOptions {
  sampleRateHz: number;
  sensitivity?: number;             // thresholds are divided by this (1 = the analysed rule)
  model?: ClickModel | null;        // default: CLICK_MODEL. null: detect only, side is 'L' with prob 0.5
}

/** The 16 raw features; the model uses the subset named in its `features` list. */
export const FEATURE_NAMES = [
  'p2p_ax', 'p2p_ay', 'p2p_az', 'p2p_gx', 'p2p_gy', 'p2p_gz',
  'max_ax', 'max_ay', 'max_az', 'min_ax', 'min_ay', 'min_az',
  'peak_acc5', 'peak_acc30', 'peak_gyr5', 'energy',
] as const;

export const DECISION_DELAY_S = 0.1;
export const REFRACTORY_S = 0.15;
export const WARMUP_S = 0.5;
export const CALIBRATE_S = 2;
export const QUIET_S = 1;
const K_ACC = 5;     // accel thresholds: x noise rms
const K_GYR = 4;     // gyro threshold: x noise rms
const MAX_HALF_MS = 80;
const HALF_SEARCH = 200; // samples searched to the left of the peak for the half-peak width

// ring buffer slots
const TIME = 0, AX = 1, AY = 2, AZ = 3, GX = 4, GY = 5, GZ = 6, ACC5 = 7, ACC30 = 8, GYR5 = 9;
const SLOTS = 10;
const AXIS_SLOT = [AX, AY, AZ, GX, GY, GZ];
const AXIS_NAME = ['ax', 'ay', 'az', 'gx', 'gy', 'gz'];

/** 2nd-order Butterworth high-pass (RBJ form), run causally: one sample in, one out. */
class Biquad {
  private readonly b0: number; private readonly b1: number; private readonly b2: number;
  private readonly a1: number; private readonly a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private started = false;

  constructor(fc: number, fs: number) {
    const w0 = (2 * Math.PI * fc) / fs;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = (1 + cw) / 2 / a0;
    this.b1 = -(1 + cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    // start in the steady state of a constant input, so a resting sensor gives no start-up step
    if (!this.started) { this.started = true; this.x1 = x; this.x2 = x; }
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

export class ClickDetector {
  readonly fs: number;
  private readonly model: ClickModel | null;
  private readonly decision: number;    // decision delay, samples
  private readonly refractory: number;   // samples
  private readonly quiet: number;        // samples
  private readonly alpha: number;        // running-average weight (5 s time constant)
  private readonly mask: number;
  private readonly ring: Float64Array[] = [];
  private readonly hp5: Biquad[] = [];
  private readonly hp30: Biquad[] = [];

  private n = 0;                         // samples processed
  private sens: number;
  private calFrom: number;               // sample range used for the noise floor
  private calEnd: number;
  private calSum = [0, 0, 0];
  private calCount = 0;
  private calibrated = false;
  private ms = [0, 0, 0];                // mean square of acc5, acc30, gyr5 (the noise floor)
  private lastTap = -Infinity;           // sample index of the last accepted peak

  constructor(opts: ClickDetectorOptions) {
    if (!(opts.sampleRateHz > 0)) throw new Error('ClickDetector needs a sample rate');
    this.fs = opts.sampleRateHz;
    this.sens = opts.sensitivity ?? 1;
    this.model = opts.model === undefined ? CLICK_MODEL : opts.model;
    for (const name of this.model?.features ?? []) {
      if (!(FEATURE_NAMES as readonly string[]).includes(name)) throw new Error(`unknown click feature "${name}"`);
    }
    this.decision = Math.round(DECISION_DELAY_S * this.fs);
    this.refractory = Math.round(REFRACTORY_S * this.fs);
    this.quiet = Math.round(QUIET_S * this.fs);
    this.alpha = 1 / (5 * this.fs);
    let size = 4096;
    while (size < 4 * this.fs) size *= 2;   // at least 4 s of history
    this.mask = size - 1;
    for (let k = 0; k < SLOTS; k++) this.ring.push(new Float64Array(size));
    for (let k = 0; k < 6; k++) this.hp5.push(new Biquad(5, this.fs));
    for (let k = 0; k < 3; k++) this.hp30.push(new Biquad(30, this.fs));
    this.calFrom = Math.round(WARMUP_S * this.fs);
    this.calEnd = this.calFrom + Math.round(CALIBRATE_S * this.fs);
  }

  get sensitivity(): number { return this.sens; }
  set sensitivity(v: number) { if (v > 0) this.sens = v; }
  get calibrating(): boolean { return !this.calibrated; }
  get samplesSeen(): number { return this.n; }

  /** Share of the noise-floor window collected so far, 0..1. */
  calibrationProgress(): number {
    if (this.calibrated) return 1;
    const span = this.calEnd - this.calFrom;
    return Math.min(1, Math.max(0, (this.n - this.calFrom) / span));
  }

  /** Current noise floor (rms of acc5, acc30, gyr5), or null while calibrating. */
  noiseRms(): { acc5: number; acc30: number; gyr5: number } | null {
    if (!this.calibrated) return null;
    return { acc5: Math.sqrt(this.ms[0]), acc30: Math.sqrt(this.ms[1]), gyr5: Math.sqrt(this.ms[2]) };
  }

  /** Current acc5 threshold in g (Infinity while calibrating: nothing is detected then). */
  threshold(): number {
    return this.calibrated ? (K_ACC / this.sens) * Math.sqrt(this.ms[0]) : Infinity;
  }

  /** Starts the noise-floor average again from now (the hand should be still). */
  recalibrate(): void {
    this.calibrated = false;
    this.calFrom = this.n;
    this.calEnd = this.n + Math.round(CALIBRATE_S * this.fs);
    this.calSum = [0, 0, 0];
    this.calCount = 0;
  }

  /** The newest `seconds` of acc5 (oldest first), with the device time of each sample. */
  recent(seconds: number): { t: Float64Array; acc5: Float64Array } {
    const count = Math.max(0, Math.min(this.n, Math.round(seconds * this.fs)));
    const t = new Float64Array(count), acc5 = new Float64Array(count);
    const start = this.n - count;
    for (let k = 0; k < count; k++) {
      const m = (start + k) & this.mask;
      t[k] = this.ring[TIME][m];
      acc5[k] = this.ring[ACC5][m];
    }
    return { t, acc5 };
  }

  /** Feeds the next reading. Returns a tap when one is confirmed (DECISION_DELAY_S after its peak). */
  step(s: ImuReading): ClickEvent | null {
    const i = this.n++;
    const m = i & this.mask;
    const R = this.ring;
    const x = [s.ax, s.ay, s.az, s.gx, s.gy, s.gz];

    R[TIME][m] = s.t;
    for (let k = 0; k < 6; k++) R[AXIS_SLOT[k]][m] = this.hp5[k].process(x[k]);
    const h30 = [this.hp30[0].process(x[0]), this.hp30[1].process(x[1]), this.hp30[2].process(x[2])];
    R[ACC30][m] = Math.hypot(h30[0], h30[1], h30[2]);
    R[ACC5][m] = Math.hypot(R[AX][m], R[AY][m], R[AZ][m]);
    R[GYR5][m] = Math.hypot(R[GX][m], R[GY][m], R[GZ][m]);

    if (!this.calibrated) {
      if (i >= this.calFrom) {
        this.calSum[0] += R[ACC5][m] ** 2;
        this.calSum[1] += R[ACC30][m] ** 2;
        this.calSum[2] += R[GYR5][m] ** 2;
        this.calCount++;
        if (i === this.calEnd - 1) {
          for (let k = 0; k < 3; k++) this.ms[k] = Math.max(1e-12, this.calSum[k] / this.calCount);
          this.calibrated = true;
        }
      }
      return null;
    }

    // slow running update of the noise floor, only while the signal is quiet: samples above the
    // detection threshold are left out (gating much lower than that would pull the floor down)
    if (i - this.lastTap > this.quiet && R[ACC5][m] < K_ACC * Math.sqrt(this.ms[0])) {
      const a = this.alpha;
      this.ms[0] += a * (R[ACC5][m] ** 2 - this.ms[0]);
      this.ms[1] += a * (R[ACC30][m] ** 2 - this.ms[1]);
      this.ms[2] += a * (R[GYR5][m] ** 2 - this.ms[2]);
    }

    // judge the candidate peak that is now DECISION_DELAY_S old
    const p = i - this.decision;
    if (p < this.calEnd || p - this.lastTap <= this.refractory) return null;
    const pm = p & this.mask;
    const k = 1 / this.sens;
    if (R[ACC5][pm] < K_ACC * k * Math.sqrt(this.ms[0])) return null;
    if (!this.isPeak(p)) return null;
    const w20 = Math.round(0.02 * this.fs);
    const w50 = Math.round(0.05 * this.fs);
    if (this.maxIn(ACC30, p, w20) < K_ACC * k * Math.sqrt(this.ms[1])) return null;
    if (this.halfWidthMs(p) > MAX_HALF_MS) return null;
    if (this.maxIn(GYR5, p, w50) < K_GYR * k * Math.sqrt(this.ms[2])) return null;

    this.lastTap = p;
    return this.event(p);
  }

  /** p is the largest acc5 within +/-DECISION_DELAY_S: a tap's small shoulder before its main peak loses to it. */
  private isPeak(p: number): boolean {
    const v = this.ring[ACC5][p & this.mask];
    for (let j = p - this.decision; j <= p + this.decision; j++) {
      if (j !== p && this.ring[ACC5][j & this.mask] > v) return false;
    }
    return true;
  }

  private maxIn(slot: number, p: number, w: number): number {
    let best = 0;
    for (let j = p - w; j <= p + w; j++) {
      const v = this.ring[slot][j & this.mask];
      if (v > best) best = v;
    }
    return best;
  }

  /** Duration in ms that acc5 stays above half its peak around p (search cut at the decision delay). */
  private halfWidthMs(p: number): number {
    const acc = this.ring[ACC5];
    const half = 0.5 * acc[p & this.mask];
    let l = p, r = p;
    while (p - l < HALF_SEARCH && acc[(l - 1) & this.mask] > half) l--;
    while (r - p < this.decision && acc[(r + 1) & this.mask] > half) r++;
    return ((r - l + 1) * 1000) / this.fs;
  }

  private event(p: number): ClickEvent {
    const features = this.features(p);
    const { side, prob } = this.classify(features);
    return { t: this.ring[TIME][p & this.mask], side, prob, peakG: this.ring[ACC5][p & this.mask], features };
  }

  private features(p: number): Record<string, number> {
    const R = this.ring, mask = this.mask, H = this.decision;
    const f: Record<string, number> = {};
    for (let k = 0; k < 6; k++) {
      const slot = AXIS_SLOT[k];
      let mx = -Infinity, mn = Infinity;
      for (let j = p - H; j <= p + H; j++) {
        const v = R[slot][j & mask];
        if (v > mx) mx = v;
        if (v < mn) mn = v;
      }
      f[`p2p_${AXIS_NAME[k]}`] = mx - mn;
      if (k < 3) { f[`max_${AXIS_NAME[k]}`] = mx; f[`min_${AXIS_NAME[k]}`] = mn; }
    }
    let pa5 = 0, pa30 = 0, pg5 = 0, energy = 0;
    for (let j = p - H; j <= p + H; j++) {
      const a5 = R[ACC5][j & mask];
      if (a5 > pa5) pa5 = a5;
      if (R[ACC30][j & mask] > pa30) pa30 = R[ACC30][j & mask];
      if (R[GYR5][j & mask] > pg5) pg5 = R[GYR5][j & mask];
      energy += a5 * a5;
    }
    f.peak_acc5 = pa5;
    f.peak_acc30 = pa30;
    f.peak_gyr5 = pg5;
    f.energy = energy / this.fs;
    return f;
  }

  private classify(f: Record<string, number>): { side: Side; prob: number } {
    const model = this.model;
    if (!model) return { side: 'L', prob: 0.5 };
    let a = model.bias;
    for (let q = 0; q < model.features.length; q++) {
      const z = (f[model.features[q]] - model.mean[q]) / model.std[q];
      a += model.weights[q] * z;
    }
    const pL = 1 / (1 + Math.exp(-a));
    return pL >= 0.5 ? { side: 'L', prob: pL } : { side: 'R', prob: 1 - pL };
  }
}
