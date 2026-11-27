// The wrist-mouse processing pipeline. Pure TypeScript, no DOM, no allocation
// in the per-sample hot path (except when a tap is classified) — written so it
// can be ported line-by-line to C++ on the ESP32.
//
//   raw IMU ─► 1 calibration ─► 2 fusion ─► 3 gravity removal ─► 4 stillness/ZUPT
//           ─► 5 integration (or 5b stroke tracker) ─► 6 deadzone ─► 7 speed curve ─► cursor
//   raw accel ─► 9 tap detect + classify ─► click   (8 freezes the cursor around it)

import type { PipelineConfig } from './config.ts';
import { DEFAULT_PIPELINE_CONFIG, isAccelOnly } from './config.ts';
import { madgwickUpdateIMU } from './madgwick.ts';
import { GravityTracker } from './gravity.ts';
import { StrokeTracker } from './stroke.ts';
import type { StrokePhase } from './stroke.ts';
import { DEG, G, quatFromEuler, quatFromGravity, quatYaw, rotateToWorld } from './math.ts';
import type { Quat, Vec3 } from './math.ts';
import { TapClassifier, extractFeatures } from './classifier.ts';
import type { Finger } from './classifier.ts';

/** One IMU reading, MPU-6050 style units. */
export interface ImuSample {
  t: number;  // seconds
  ax: number; ay: number; az: number; // g
  gx: number; gy: number; gz: number; // °/s
}

export interface TapEvent {
  tTrigger: number;    // s, when the high-passed accel crossed the threshold
  tClassified: number; // s, when the window was complete and the click was emitted
  finger: Finger;
  confidence: number;
  pIndex: number;
  features: number[];
  peakG: number;
}

export interface StepOutput {
  t: number;
  phase: 'calibrating' | 'running';
  calibProgress: number;
  q: Quat;
  lin: Vec3;          // linear accel, m/s², hand-heading frame
  vel: [number, number];
  vOut: [number, number];
  pos: [number, number];    // estimated hand displacement, m
  cursor: [number, number]; // px
  gain: number;
  still: boolean;
  frozen: boolean;
  tapTriggered: boolean;
  tap: TapEvent | null;
  hpMag: number;      // high-passed |accel| (g), the tap trigger signal
  beta: number;       // fusion gain actually applied on this sample (rad/s)
  strokePhase: StrokePhase; // stroke tracker phase ('idle' in the integrate model)
  sliding: boolean;   // 4c: the desk-vibration detector says the hand is sliding
  slideMg: number;    // vibration level it judges by (RMS above slideHpHz), mg
}

const RING = 512; // must exceed any window (in samples) used below

export class Pipeline {
  cfg: PipelineConfig;
  readonly classifier = new TapClassifier();
  readonly out: StepOutput;

  // state
  private n = 0;
  private tPrev = NaN;
  private calibN = 0;
  private calibAcc: Vec3 = [0, 0, 0];
  private calibGyr: Vec3 = [0, 0, 0];
  private initialised = false;
  private linLP = [0, 0];
  private linBase = [0, 0];
  private lastStillK = 0;
  private runStart = 0;
  private hpPrimed = false;
  private tmp3: Vec3 = [0, 0, 0];
  private tmp5 = [0, 0, 0, 0, 0];
  readonly gyroBias: Vec3 = [0, 0, 0];
  gRef = 1;
  private q: Quat = [1, 0, 0, 0];
  /** Gravity estimate for the accelerometer-only modes. */
  readonly gravity = new GravityTracker();
  /** Stroke-by-stroke motion (motionModel 'stroke'). */
  readonly stroke = new StrokeTracker();
  private strokeFrom = [0, 0, 0, 0]; // pos and cursor where the current stroke started

  // Segment model (motionModel 'segment'): one segment per move, from the stillness flag going false
  // to it going true again. Its lin is stored so the drift can be removed when the segment ends.
  private static readonly SEG_CAP = 20000;
  private segLin = new Float64Array(Pipeline.SEG_CAP * 2); // lin x, y (m/s²) per stored sample
  private segDt = new Float64Array(Pipeline.SEG_CAP);      // dt (s) per stored sample
  private segVib = new Float64Array(Pipeline.SEG_CAP);     // vibration RMS (mg) per stored sample (for segDriftVibK)
  private segActive = false;
  private segRestN = 0;         // samples in a row passing the segment rest test
  private rtN = 0;              // the same, for the accel-only restRetake
  private segN = 0;
  private segOverflow = false;   // the segment outgrew the buffer: no correction for it
  private segVx = 0; private segVy = 0; // raw integrated velocity inside the segment (no halts)
  private segPos0: [number, number] = [0, 0];
  private segCur0: [number, number] = [0, 0];
  // accel spread for the segment rest test: like gravity.spread but over segSpreadMs (fast, so the
  // segment ends when the hand stops, not ~0.5 s later while the 100 ms spread decays)
  private fsMean: Vec3 = [0, 0, 1]; private fsVar = 0; private fsSpread = 0;
  // rotation of the current segment: integrated bias-corrected gyro (deg), and the largest |angle| reached
  private segRot: Vec3 = [0, 0, 0]; private segRotMax = 0;

  // 4c. sliding detector (desk vibration)
  private slideHp = new Float64Array(12); // high-pass state per axis: x1, x2, y1, y2
  private slideCoef = [0, 0, 0, 0, 0];
  private slideKey = '';
  private slidePrimed = false;
  private slideE = 0;          // smoothed squared vibration, g²
  private slideQuiet = 0;      // samples below the threshold
  private slideThr = 0.008;    // g
  private slideCalSum = 0; private slideCalN = 0;
  private sliding = false;
  private yawRef = 0;
  private vel: [number, number] = [0, 0];
  private pos: [number, number] = [0, 0];
  private cursor: [number, number] = [0, 0];

  // stillness
  private ring = new Float64Array(RING * 5); // lin x, lin y (g), gyro x,y,z (°/s)
  private sums = [0, 0, 0, 0, 0];
  private winN = 0;
  private lastSpike = -1e9;
  private quiet = 0;
  private still = false;
  private restN = 0;        // samples in a row passing the tilt-independent rest test
  private relevel = false;  // at rest, but the normal stillness test fails: a tilt error to correct
  private notQuietN = 0;    // samples since the normal stillness test last passed

  // click freeze history (vel, pos, cursor)
  private hist = new Float64Array(RING * 6);
  private frozenUntil = -1;

  // tap detection
  private hpState = new Float64Array(3 * 4); // x1,x2,y1,y2 per axis
  private hpCoef = [0, 0, 0, 0, 0];
  private hpFc = -1;
  private rawRing = new Float64Array(RING * 6); // bias-corrected acc (g) + gyro (°/s)
  private capturing = false;
  private capStart = 0;   // sample index where the window starts
  private capTrigger = 0;
  private capTTrigger = 0;
  private refractoryUntil = -1;

  constructor(cfg: PipelineConfig = DEFAULT_PIPELINE_CONFIG) {
    this.cfg = { ...cfg };
    this.out = {
      t: 0, phase: 'calibrating', calibProgress: 0, q: this.q, lin: [0, 0, 0],
      vel: this.vel, vOut: [0, 0], pos: this.pos, cursor: this.cursor, gain: 0,
      still: false, frozen: false, tapTriggered: false, tap: null, hpMag: 0, beta: 0, strokePhase: 'idle',
      sliding: false, slideMg: 0,
    };
    this.reset();
  }

  /** Restart from scratch (re-calibrates). The trained classifier is kept. */
  reset(cursorX = this.cfg.screenW / 2, cursorY = this.cfg.screenH / 2): void {
    this.n = 0; this.tPrev = NaN;
    this.calibN = 0; this.calibAcc.fill(0); this.calibGyr.fill(0);
    this.initialised = false;
    this.gyroBias.fill(0); this.gRef = 1;
    this.q[0] = 1; this.q[1] = 0; this.q[2] = 0; this.q[3] = 0;
    this.yawRef = 0; this.linLP = [0, 0]; this.linBase = [0, 0]; this.lastStillK = 0;
    this.vel[0] = this.vel[1] = 0;
    this.pos[0] = this.pos[1] = 0;
    this.cursor[0] = cursorX; this.cursor[1] = cursorY;
    this.ring.fill(0); this.sums.fill(0); this.winN = 0;
    this.lastSpike = -1e9; this.quiet = 0; this.still = false; this.restN = 0; this.relevel = false; this.notQuietN = 0;
    this.hist.fill(0); this.frozenUntil = -1;
    this.hpState.fill(0); this.hpPrimed = false; this.rawRing.fill(0); this.runStart = 0;
    this.capturing = false; this.refractoryUntil = -1;
    this.stroke.reset();
    this.rtN = 0;
    this.segActive = false; this.segRestN = 0; this.segN = 0; this.segOverflow = false; this.segVx = 0; this.segVy = 0;
    this.fsMean[0] = 0; this.fsMean[1] = 0; this.fsMean[2] = 1; this.fsVar = 0; this.fsSpread = 0;
    this.slideHp.fill(0); this.slidePrimed = false; this.slideE = 0; this.slideQuiet = 0;
    this.slideCalSum = 0; this.slideCalN = 0; this.slideThr = this.cfg.slideOnMg / 1000; this.sliding = false;
    this.out.phase = 'calibrating';
    this.out.calibProgress = 0;
  }

  setCursor(x: number, y: number): void { this.cursor[0] = x; this.cursor[1] = y; }

  private ms2n(ms: number): number {
    return Math.max(1, Math.min(RING - 8, Math.round(ms * this.cfg.sampleRateHz / 1000)));
  }

  step(s: ImuSample): StepOutput {
    const c = this.cfg;
    const o = this.out;
    // 0. Accelerometer offset / scale from the 6-face calibration (identity by default).
    // Local copies, so the caller's sample is left as it was and everything below uses the corrected values.
    const ax = (s.ax - c.accelBias[0]) * c.accelScale[0];
    const ay = (s.ay - c.accelBias[1]) * c.accelScale[1];
    const az = (s.az - c.accelBias[2]) * c.accelScale[2];
    const fs = c.sampleRateHz;
    let dt = s.t - this.tPrev;
    if (!(dt > 0 && dt < 0.1)) dt = 1 / fs;
    this.tPrev = s.t;
    const k = this.n++;
    o.t = s.t;
    o.tap = null;
    o.tapTriggered = false;
    // the tap high-pass runs from the very first sample so it is settled after calibration
    const hpMag = this.highpass(ax, ay, az);
    o.hpMag = hpMag;
    const slideRms = this.vibration(ax, ay, az, dt);
    o.slideMg = slideRms * 1000;

    // ───────────── 1. Calibration ─────────────
    if (!this.initialised) {
      if (c.enableCalibration) {
        if (k < Math.round(c.calibSkipMs * fs / 1000)) { // start-up transient: not part of the average
          o.phase = 'calibrating'; o.still = false; o.frozen = false;
          o.lin[0] = o.lin[1] = o.lin[2] = 0;
          return o;
        }
        this.calibAcc[0] += ax; this.calibAcc[1] += ay; this.calibAcc[2] += az;
        this.calibGyr[0] += s.gx; this.calibGyr[1] += s.gy; this.calibGyr[2] += s.gz;
        this.calibN++;
        this.slideCalSum += slideRms; this.slideCalN++;
        const needN = Math.max(1, Math.round(c.calibrationMs * fs / 1000));
        o.calibProgress = this.calibN / needN;
        if (this.calibN < needN) {
          o.phase = 'calibrating';
          o.still = false; o.frozen = false;
          o.lin[0] = o.lin[1] = o.lin[2] = 0;
          return o;
        }
        const ma = this.calibAcc.map(v => v / this.calibN) as Vec3;
        for (let i = 0; i < 3; i++) this.gyroBias[i] = this.calibGyr[i] / this.calibN;
        this.gRef = Math.hypot(ma[0], ma[1], ma[2]);
        quatFromGravity(ma[0], ma[1], ma[2], this.q);
        this.gravity.reset(ma[0], ma[1], ma[2]);
        // sliding = clearly above the vibration level at rest (calibration is done at rest)
        this.slideThr = Math.max(c.slideOnMg / 1000, 2 * this.slideCalSum / this.slideCalN);
      } else {
        this.gyroBias.fill(0);
        this.gRef = 1;
        quatFromGravity(ax, ay, az, this.q);
        this.gravity.reset(ax, ay, az);
      }
      this.yawRef = quatYaw(this.q);
      this.initialised = true;
      this.runStart = k + 1;
      this.lastStillK = k;
      o.phase = 'running';
      o.calibProgress = 1;
      return o;
    }

    const gx = s.gx - this.gyroBias[0], gy = s.gy - this.gyroBias[1], gz = s.gz - this.gyroBias[2];
    const frozen = k < this.frozenUntil;
    const accelOnly = isAccelOnly(c.fusionMode);
    const lin = o.lin;
    this.gravity.observe(ax, ay, az, dt); // accel spread: for the Kalman gain and the rest test
    if (c.motionModel === 'segment') {
      const af = Math.min(1, dt / (c.segSpreadMs / 1000));
      const fm = this.fsMean;
      fm[0] += (ax - fm[0]) * af; fm[1] += (ay - fm[1]) * af; fm[2] += (az - fm[2]) * af;
      const ex = ax - fm[0], ey = ay - fm[1], ez = az - fm[2];
      this.fsVar += (ex * ex + ey * ey + ez * ez - this.fsVar) * af;
      this.fsSpread = Math.sqrt(this.fsVar);
    }

    if (accelOnly) {
      // ───────────── 2–3 (accelerometer only). Track gravity, subtract it ─────────────
      // No gyro: gravity is estimated from the accelerometer itself (see gravity.ts).
      // With fusion off, gravity stays where calibration left it.
      // 4c: while the hand slides, the accelerometer reads hand motion too: hold gravity still
      if (c.enableFusion && !(c.enableSlideDetect && this.sliding)) {
        if (c.fusionMode === 'accel-kalman') this.gravity.kalman(ax, ay, az, dt, c);
        else this.gravity.complementary(ax, ay, az, dt, c);
      }
      o.beta = 0;
      if (c.restRetake) { // rest by the segment rest test: take the recent mean accel as gravity, once per pause
        const rr = Math.hypot(gx, gy, gz) < c.segRestDps && this.gravity.spread < c.segRestSpreadG;
        this.rtN = rr ? this.rtN + 1 : 0;
        if (this.rtN === this.ms2n(c.segRestMs)) { this.gravity.retake(); this.stroke.rebase(); }
      }
      if (c.enableGravityRemoval) this.gravity.linear(ax, ay, az, lin);
      else { lin[0] = ax; lin[1] = ay; lin[2] = az - this.gRef; }
    }

    // ───────────── 2. Sensor fusion ─────────────
    if (!accelOnly && c.enableFusion && c.fusionMode !== 'static') {
      let beta = 0;
      if (c.fusionMode === 'madgwick') {
        if (!c.adaptiveBeta) beta = c.betaFixed;
        else if (this.relevel) {
          // at rest by the tilt-independent test, yet the normal test sees sideways accel:
          // that's a tilt error, not motion. Re-level quickly from the accelerometer.
          beta = c.betaRelevel;
        } else if (this.still) {
          // still: let the accelerometer define "down" — except at the very onset of a
          // stroke (the stillness flag lags a few ms behind the first acceleration)
          beta = Math.hypot(this.linLP[0], this.linLP[1]) > c.motionGateG ? 0 : c.betaStill;
        } else {
          // moving: trust the gyro alone for a normal stroke; only if "moving" lasts
          // implausibly long (likely a tilt error masquerading as motion) correct slowly
          beta = k - this.lastStillK > c.fusionMovingDelayMs * fs / 1000 ? c.betaMoving : 0;
        }
        const an = Math.hypot(ax, ay, az);
        // the accelerometer only tells us "down" when it reads ≈ 1 g and no tap is ringing
        if (Math.abs(an - this.gRef) > c.accelGateG || this.capturing || frozen) beta = 0;
        // 4c: sliding on the desk means moving, whatever the other tests say: the accelerometer
        // then reads hand motion too, and a slow push would be learned as tilt
        if (c.enableSlideDetect && this.sliding) beta = 0;
      }
      o.beta = beta;
      madgwickUpdateIMU(this.q, gx * DEG, gy * DEG, gz * DEG, ax, ay, az, beta, dt);
    }

    // ───────────── 3. Gravity removal (in the hand's heading frame) ─────────────
    if (accelOnly) {
      // done above
    } else if (c.enableGravityRemoval) {
      const f = this.tmp3; f[0] = ax; f[1] = ay; f[2] = az;
      rotateToWorld(this.q, f, lin);
      lin[2] -= this.gRef;
      // express in the hand heading latched at the last stillness → yaw drift can't skew direction
      const cy = Math.cos(this.yawRef), sy = Math.sin(this.yawRef);
      const x = lin[0], y = lin[1];
      lin[0] = cy * x + sy * y;
      lin[1] = -sy * x + cy * y;
    } else {
      // naive: assume the sensor is perfectly level
      lin[0] = ax; lin[1] = ay; lin[2] = az - this.gRef;
    }
    lin[0] *= G; lin[1] *= G; lin[2] *= G; // → m/s²
    // 5 ms low-pass of the horizontal linear accel vector (g): stroke-onset gate for the fusion
    // (low-pass the vector, not its magnitude — the magnitude of pure noise is never small)
    const af = Math.min(1, dt / 0.005);
    this.linLP[0] += (lin[0] / G - this.linLP[0]) * af;
    this.linLP[1] += (lin[1] / G - this.linLP[1]) * af;

    // ───────────── 9a. Tap trigger (high-passed accel) ─────────────
    const ri = (k % RING) * 6;
    this.rawRing[ri] = ax; this.rawRing[ri + 1] = ay; this.rawRing[ri + 2] = az;
    this.rawRing[ri + 3] = gx; this.rawRing[ri + 4] = gy; this.rawRing[ri + 5] = gz;
    if (c.enableTaps && !this.capturing && k >= this.refractoryUntil && hpMag > c.tapThresholdG) {
      this.capturing = true;
      this.capTrigger = k;
      this.capTTrigger = s.t;
      this.capStart = k - this.ms2n(5); // include the onset that precedes the trigger
      o.tapTriggered = true;
      // ───── 8. Click freeze: roll the cursor back to just before the tap and hold it ─────
      if (c.enableClickFreeze) {
        const back = Math.min(k - this.runStart, this.ms2n(c.freezePreMs));
        if (back >= 1) {
          const hi = ((k - back) % RING) * 6;
          this.vel[0] = this.hist[hi]; this.vel[1] = this.hist[hi + 1];
          this.pos[0] = this.hist[hi + 2]; this.pos[1] = this.hist[hi + 3];
          this.cursor[0] = this.hist[hi + 4]; this.cursor[1] = this.hist[hi + 5];
        }
        this.frozenUntil = k + this.ms2n(c.freezePostMs);
      }
    }
    if (this.capturing && k - this.capStart + 1 >= this.ms2n(c.tapWindowMs)) {
      o.tap = this.classifyWindow(k, s.t, dt);
      this.capturing = false;
      this.refractoryUntil = this.capTrigger + this.ms2n(c.tapRefractoryMs);
    }
    const isFrozen = k < this.frozenUntil;

    // ───────────── 4c. Sliding detector ─────────────
    if (slideRms > this.slideThr) { this.sliding = true; this.slideQuiet = 0; }
    else if (++this.slideQuiet >= this.ms2n(c.slideQuietMs)) this.sliding = false;
    const slideGate = c.enableSlideDetect ? this.sliding : null;

    // ───────────── 4. Stillness detection ─────────────
    const W = this.ms2n(c.stillWindowMs);
    const linxG = lin[0] / G, linyG = lin[1] / G;
    if (W !== this.winN) this.recomputeSums(k, W);
    const wi = (k % RING) * 5;
    const old = ((k - W + RING * 1000) % RING) * 5;
    const vals = this.tmp5;
    vals[0] = linxG; vals[1] = linyG; vals[2] = gx; vals[3] = gy; vals[4] = gz;
    for (let i = 0; i < 5; i++) {
      this.sums[i] += vals[i] - (k >= W ? this.ring[old + i] : 0);
      this.ring[wi + i] = vals[i];
    }
    // Measure accel relative to a slow baseline: hand strokes are short transients, while a
    // constant offset (a small leftover tilt error) must not be able to block stillness forever.
    // The baseline only learns from calm samples and is capped at a plausible tilt-error size,
    // so the average acceleration of vigorous strokes can't leak into it.
    if (Math.hypot(linxG, linyG) < c.stillBaselineCalmG) {
      const ab = Math.min(1, dt / c.stillBaselineS);
      this.linBase[0] += (linxG - this.linBase[0]) * ab;
      this.linBase[1] += (linyG - this.linBase[1]) * ab;
      const bm = Math.hypot(this.linBase[0], this.linBase[1]);
      if (bm > c.stillBaselineMaxG) { this.linBase[0] *= c.stillBaselineMaxG / bm; this.linBase[1] *= c.stillBaselineMaxG / bm; }
    }
    if (Math.hypot(linxG - this.linBase[0], linyG - this.linBase[1]) > c.stillPeakG) this.lastSpike = k;
    const mAcc = Math.hypot(this.sums[0] / W - this.linBase[0], this.sums[1] / W - this.linBase[1]);
    const mGyr = accelOnly ? 0 : Math.hypot(this.sums[2], this.sums[3], this.sums[4]) / W; // accel-only: ignore the gyro
    const quietNow = mAcc < c.stillAccelG && mGyr < c.stillGyroDps && k - this.lastSpike >= W;
    this.quiet = quietNow ? this.quiet + 1 : 0;
    const speedEst = Math.hypot(this.vel[0], this.vel[1]);
    const holdN = (c.stillHoldMs + Math.min(c.stillHoldMaxExtraMs, c.stillHoldPerVel * speedEst)) * fs / 1000;
    const wasStill = this.still;
    const quietStill = this.quiet >= holdN;
    // 4b. Tilt-independent rest: quiet gyro, steady accel vector, |a| ≈ 1 g. None of these
    // depend on the orientation estimate, so a tilt error can't block them (see config.ts).
    // Gyro modes only: without the gyro, a slow stroke looks just like rest, and the
    // accel-only gravity filters can't get stuck this way in the first place.
    const restNow = c.enableRestDetect && !accelOnly && Math.abs(Math.hypot(ax, ay, az) - this.gRef) < c.accelGateG
      && this.gravity.spread < c.restSpreadG && mGyr < c.stillGyroDps
      && !(c.enableSlideDetect && this.sliding); // 4c: sliding is never rest (a slow pan passed this test)
    this.restN = restNow ? this.restN + 1 : 0;
    const restNeed = this.ms2n(c.restHoldMs);
    const atRest = this.restN >= restNeed;
    // Rest just confirmed while the normal test still sees sideways accel: the hand has been
    // at rest for the whole hold, so the motion integrated meanwhile came from the tilt error.
    // Undo it, like the click freeze does (the history ring covers ~0.5 s at 1 kHz).
    if (atRest && this.restN === restNeed && !quietStill && !isFrozen) {
      const back = Math.min(restNeed, k - this.runStart);
      if (back >= 1) {
        const hi = ((k - back) % RING) * 6;
        this.vel[0] = this.hist[hi]; this.vel[1] = this.hist[hi + 1];
        this.pos[0] = this.hist[hi + 2]; this.pos[1] = this.hist[hi + 3];
        this.cursor[0] = this.hist[hi + 4]; this.cursor[1] = this.hist[hi + 5];
      }
      this.stroke.halt();
    }
    // relevelSnap: at the moment rest is confirmed, set the tilt from the 100 ms mean accel (yaw kept)
    if (c.relevelSnap && c.enableRestDetect && !accelOnly && atRest && this.restN === restNeed && !isFrozen && k >= 100) {
      let sx = 0, sy = 0, sz = 0;
      for (let j = 0; j < 100; j++) { const idx = ((k - j) % RING) * 6; sx += this.rawRing[idx]; sy += this.rawRing[idx + 1]; sz += this.rawRing[idx + 2]; }
      sx /= 100; sy /= 100; sz /= 100;
      quatFromEuler(Math.atan2(sy, sz), Math.atan2(-sx, Math.hypot(sy, sz)), quatYaw(this.q), this.q);
    }
    this.still = quietStill || atRest;
    // Re-level only once the normal test has failed for a while: a tilt error lasts, while the
    // start of a slow push fails it too, but only until it turns into sliding (~0.1 s).
    this.notQuietN = quietStill ? 0 : this.notQuietN + 1;
    this.relevel = atRest && !quietStill && this.notQuietN >= this.ms2n(c.relevelDelayMs);

    // Leaving stillness: the stillness test lags by about one window, so the first
    // few ms of a stroke were zeroed by ZUPT. Re-integrate that window so the
    // stroke's onset isn't lost (cheap: only runs on the still→moving edge).
    // (The stroke tracker recovers a stroke's onset by itself.)
    const strokeModel = c.motionModel === 'stroke';
    const segModel = c.motionModel === 'segment';
    // (the segment model starts its segment exactly on the stillness edge, so it skips this re-integration)
    if (wasStill && !this.still && c.enableZupt && !isFrozen && !strokeModel && !segModel) {
      let vx = 0, vy = 0;
      for (let j = W - 1; j >= 1; j--) {
        const idx = ((k - j + RING * 1000) % RING) * 5;
        vx += this.ring[idx] * G * dt; vy += this.ring[idx + 1] * G * dt;
        const sp = Math.hypot(vx, vy);
        if (c.enableDeadzone && sp < c.deadzoneMps) continue;
        this.pos[0] += vx * dt; this.pos[1] += vy * dt;
        const gn = c.enableSpeedCurve ? c.gainMin + c.gainK * Math.log(1 + sp / c.gainV0) : c.gainLinear;
        this.cursor[0] = clamp(this.cursor[0] + gn * vx * dt, 0, c.screenW);
        this.cursor[1] = clamp(this.cursor[1] - gn * vy * dt, 0, c.screenH);
      }
      this.vel[0] = vx; this.vel[1] = vy;
    }

    if (this.still) {
      this.lastStillK = k;
      this.yawRef = quatYaw(this.q);
      // refine the gyro bias only while clearly at rest: the stillness flag lags the start of a
      // stroke by a few ms, and absorbing real rotation into the bias would tilt every later stroke
      const atRest = Math.hypot(gx, gy, gz) < 0.5 * c.stillGyroDps && Math.hypot(this.linLP[0], this.linLP[1]) < c.motionGateG;
      if (c.enableCalibration && c.biasTracking && atRest) {
        const a = dt / c.biasTrackingTauS;
        this.gyroBias[0] += a * (s.gx - this.gyroBias[0]);
        this.gyroBias[1] += a * (s.gy - this.gyroBias[1]);
        this.gyroBias[2] += a * (s.gz - this.gyroBias[2]);
      }
    }

    if (strokeModel) {
      // ───────────── 5b. Stroke tracker ─────────────
      // velocity only exists inside a stroke, and each stroke ends at exactly zero (stroke.ts)
      const st = this.stroke;
      if (isFrozen) st.suspend(); // a tap, not hand motion; pick up again once quiet
      else {
        st.step(lin[0], lin[1], dt, c.enableZupt && this.still, c, slideGate);
        const f = this.strokeFrom;
        if (st.started) { f[0] = this.pos[0]; f[1] = this.pos[1]; f[2] = this.cursor[0]; f[3] = this.cursor[1]; }
        if (st.cancelled) { // not a stroke after all (a tilt): undo what it moved
          this.pos[0] = f[0]; this.pos[1] = f[1]; this.cursor[0] = f[2]; this.cursor[1] = f[3];
          // Without a gyro, a tilt is only visible this way: what the accelerometer has read
          // lately is gravity. Take it, so the gravity filter doesn't spend seconds catching up
          // (which would look like a stroke the other way).
          if (accelOnly) { this.gravity.retake(); st.rebase(); }
        }
      }
      this.vel[0] = st.vx; this.vel[1] = st.vy;
    } else if (segModel) {
      // ───────────── 5c. Segment integration (see segmentStep) ─────────────
      this.segmentStep(lin, dt, gx, gy, gz);
    } else {
      // ───────────── 5. Integration ─────────────
      if (!isFrozen) {
        this.vel[0] += lin[0] * dt;
        this.vel[1] += lin[1] * dt;
      }
      if (c.enableVelocityDecay) {
        const d = Math.exp(-c.velocityDecayPerS * dt);
        this.vel[0] *= d; this.vel[1] *= d;
      }
      // ───── 4b. Zero-velocity update ─────
      if (c.enableZupt && this.still) { this.vel[0] = 0; this.vel[1] = 0; }
    }

    // ───────────── 6. Deadzone ─────────────
    let vx = this.vel[0], vy = this.vel[1];
    const sp = Math.hypot(vx, vy);
    if (c.enableDeadzone && sp < c.deadzoneMps) { vx = 0; vy = 0; }
    o.vOut[0] = vx; o.vOut[1] = vy;

    // ───────────── 7. Speed curve → cursor ─────────────
    const speed = Math.hypot(vx, vy);
    const gain = c.enableSpeedCurve ? c.gainMin + c.gainK * Math.log(1 + speed / c.gainV0) : c.gainLinear;
    o.gain = gain;
    if (!isFrozen) {
      this.pos[0] += vx * dt;
      this.pos[1] += vy * dt;
      this.cursor[0] = clamp(this.cursor[0] + gain * vx * dt, 0, c.screenW);
      this.cursor[1] = clamp(this.cursor[1] - gain * vy * dt, 0, c.screenH); // desk forward = screen up
      // Screen edges act as a wall: velocity pushing further out is dropped, so moving
      // back takes effect at once instead of first unwinding the velocity built up
      // against the edge (which made the cursor look stuck in a corner).
      const wallX = (this.cursor[0] <= 0 && this.vel[0] < 0) || (this.cursor[0] >= c.screenW && this.vel[0] > 0);
      const wallY = (this.cursor[1] <= 0 && this.vel[1] > 0) || (this.cursor[1] >= c.screenH && this.vel[1] < 0);
      if (wallX) this.vel[0] = this.stroke.vx = 0;
      if (wallY) this.vel[1] = this.stroke.vy = 0;
      // Stroke model: running into the edge (not just sliding along it) ends the stroke, and
      // its braking is ignored, so the cursor doesn't bounce back off the edge.
      if (strokeModel && ((wallX && Math.abs(this.stroke.ux) > 0.5) || (wallY && Math.abs(this.stroke.uy) > 0.5))) this.stroke.hitWall();
    }

    const hi = (k % RING) * 6;
    this.hist[hi] = this.vel[0]; this.hist[hi + 1] = this.vel[1];
    this.hist[hi + 2] = this.pos[0]; this.hist[hi + 3] = this.pos[1];
    this.hist[hi + 4] = this.cursor[0]; this.hist[hi + 5] = this.cursor[1];

    o.phase = 'running';
    o.still = this.still;
    o.frozen = isFrozen;
    o.strokePhase = this.stroke.phase;
    o.sliding = this.sliding;
    return o;
  }

  /**
   * 5c. Segment model. A segment is one move: it starts when the hand leaves rest and ends when rest
   * is confirmed again (tilt-independent rest test, see config segRest*). Velocity integrates lin with
   * no halts. Live, the cursor moves by raw integration (segLive 'raw') or by the stroke tracker
   * ('stroke'). At the segment end the drift is removed: the velocity is linearly detrended to zero at
   * both ends over the stored samples, and pos/cursor are corrected to the detrended displacement.
   * A segment longer than segMaxS is cut without correction, and the next one starts at once.
   */
  private segmentStep(lin: Vec3, dt: number, gx: number, gy: number, gz: number): void {
    const c = this.cfg;
    // rest: quiet gyro, and quiet accel spread and/or no desk vibration (segRestTest)
    const quietHere = c.segRestTest === 'slide' ? !this.sliding
      : c.segRestTest === 'spread+slide' ? this.fsSpread < c.segRestSpreadG && !this.sliding
      : this.fsSpread < c.segRestSpreadG;
    const restHere = Math.hypot(gx, gy, gz) < c.segRestDps && quietHere;
    this.segRestN = restHere ? this.segRestN + 1 : 0;
    if (this.segRestN >= this.ms2n(c.segRestMs)) {
      // at rest: the segment ends here (once), its stored rest-hold samples are dropped unless wanted
      if (this.segActive) this.segmentEnd(true, c.segIncludeHold ? 0 : this.segRestN - 1);
      this.vel[0] = 0; this.vel[1] = 0; // zero velocity at rest
      return;
    }
    if (this.segActive && this.segN >= Math.round(c.segMaxS * c.sampleRateHz)) {
      this.segmentEnd(false, 0); // too long: cut without correction, keep the live position
    }
    if (!this.segActive) { // the hand has just left rest: a segment starts on this sample
      this.segActive = true; this.segN = 0; this.segOverflow = false;
      this.segVx = 0; this.segVy = 0;
      this.segRot[0] = 0; this.segRot[1] = 0; this.segRot[2] = 0; this.segRotMax = 0;
      this.segPos0[0] = this.pos[0]; this.segPos0[1] = this.pos[1];
      this.segCur0[0] = this.cursor[0]; this.segCur0[1] = this.cursor[1];
      if (c.segLive === 'stroke') this.stroke.reset();
    }
    const n = this.segN;
    if (n < Pipeline.SEG_CAP) {
      this.segLin[2 * n] = lin[0]; this.segLin[2 * n + 1] = lin[1]; this.segDt[n] = dt;
      this.segVib[n] = Math.sqrt(this.slideE) * 1000;
      this.segN = n + 1;
    } else this.segOverflow = true;
    this.segVx += lin[0] * dt; this.segVy += lin[1] * dt;
    this.segRot[0] += gx * dt; this.segRot[1] += gy * dt; this.segRot[2] += gz * dt;
    this.segRotMax = Math.max(this.segRotMax, Math.hypot(this.segRot[0], this.segRot[1], this.segRot[2]));
    if (c.segLive === 'stroke') {
      const st = this.stroke;
      st.step(lin[0], lin[1], dt, false, c, c.enableSlideDetect ? this.sliding : null);
      this.vel[0] = st.vx; this.vel[1] = st.vy;
    } else {
      this.vel[0] = this.segVx; this.vel[1] = this.segVy;
    }
  }

  /**
   * End of a segment. If correct: the first n stored samples (n = stored − drop) give the detrended
   * displacement d; pos becomes posAtStart + d, and the cursor moves by the same correction.
   */
  private segmentEnd(correct: boolean, drop: number): void {
    const c = this.cfg;
    this.segActive = false;
    const n = Math.max(0, this.segN - drop);
    // a tilt is wrist rotation, not a slide: a segment that turned the hand past segMaxTiltDeg is not corrected
    const turn = c.segTiltMode === 'max' ? this.segRotMax : Math.hypot(this.segRot[0], this.segRot[1], this.segRot[2]);
    if (turn > c.segMaxTiltDeg) correct = false;
    if (correct && !this.segOverflow && n > 0) {
      let vEx = 0, vEy = 0; // raw v_end: integral over the kept samples
      for (let k = 0; k < n; k++) { vEx += this.segLin[2 * k] * this.segDt[k]; vEy += this.segLin[2 * k + 1] * this.segDt[k]; }
      let vx = 0, vy = 0, dx = 0, dy = 0;
      if (c.segDriftAccelK === 0 && c.segDriftVibK === 0) {
        for (let k = 0; k < n; k++) {
          const h = this.segDt[k];
          vx += this.segLin[2 * k] * h; vy += this.segLin[2 * k + 1] * h;
          const f = (k + 1) / n;
          dx += (vx - vEx * f) * h; dy += (vy - vEy * f) * h;
        }
      } else {
        // drift weighted by motion and vibration: the velocity correction ramps up in proportion to
        // the cumulative weight w = dt·(1 + Ka·|a| + Kv·vib) instead of linearly in time
        const wOf = (k: number) => this.segDt[k] * (1 + c.segDriftAccelK * Math.hypot(this.segLin[2 * k], this.segLin[2 * k + 1]) + c.segDriftVibK * this.segVib[k]);
        let wTot = 0;
        for (let k = 0; k < n; k++) wTot += wOf(k);
        let wc = 0;
        for (let k = 0; k < n; k++) {
          const h = this.segDt[k];
          vx += this.segLin[2 * k] * h; vy += this.segLin[2 * k + 1] * h;
          wc += wOf(k);
          const f = wc / wTot;
          dx += (vx - vEx * f) * h; dy += (vy - vEy * f) * h;
        }
      }
      // raw displacement and cursor movement of this segment so far (live)
      const pdx = this.pos[0] - this.segPos0[0], pdy = this.pos[1] - this.segPos0[1];
      const pd = Math.hypot(pdx, pdy);
      // sanity cap: a correction that adds more than segMaxJumpCm to the live displacement is not believed
      if ((Math.hypot(dx, dy) - pd) * 100 <= c.segMaxJumpCm) {
        const cdx = this.cursor[0] - this.segCur0[0], cdy = this.cursor[1] - this.segCur0[1];
        const g = pd > 0.001 ? Math.hypot(cdx, cdy) / pd : c.gainMin; // px per metre
        this.pos[0] = this.segPos0[0] + dx; this.pos[1] = this.segPos0[1] + dy;
        // the screen y axis is flipped (cursor y moves against vy), so the y correction is negated
        this.cursor[0] = clamp(this.cursor[0] + g * (dx - pdx), 0, c.screenW);
        this.cursor[1] = clamp(this.cursor[1] - g * (dy - pdy), 0, c.screenH);
      }
    }
    if (c.segLive === 'stroke') this.stroke.halt();
    this.segN = 0; this.segOverflow = false;
    this.segVx = 0; this.segVy = 0;
  }

  private recomputeSums(k: number, W: number): void {
    this.winN = W;
    this.sums.fill(0);
    for (let j = 1; j <= W && k - j >= 0; j++) {
      const idx = ((k - j) % RING) * 5;
      for (let i = 0; i < 5; i++) this.sums[i] += this.ring[idx + i];
    }
  }

  /**
   * 4c. Vibration level: raw accel high-passed at slideHpHz (2nd-order Butterworth per axis),
   * squared magnitude smoothed over ~15 ms. Returns the RMS in g.
   */
  private vibration(ax: number, ay: number, az: number, dt: number): number {
    const c = this.cfg;
    const key = `${c.slideHpHz}/${c.sampleRateHz}`;
    if (key !== this.slideKey) {
      this.slideKey = key;
      const w0 = 2 * Math.PI * Math.min(c.slideHpHz, 0.45 * c.sampleRateHz) / c.sampleRateHz;
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2), cw = Math.cos(w0), a0 = 1 + alpha;
      this.slideCoef = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - alpha) / a0];
    }
    const st = this.slideHp, [b0, b1, b2, a1, a2] = this.slideCoef;
    const inp = this.tmp3; inp[0] = ax; inp[1] = ay; inp[2] = az;
    if (!this.slidePrimed) {
      this.slidePrimed = true;
      for (let i = 0; i < 3; i++) { st[i * 4] = st[i * 4 + 1] = inp[i]; st[i * 4 + 2] = st[i * 4 + 3] = 0; }
    }
    let m2 = 0;
    for (let i = 0; i < 3; i++) {
      const j = i * 4, x = inp[i];
      const y = b0 * x + b1 * st[j] + b2 * st[j + 1] - a1 * st[j + 2] - a2 * st[j + 3];
      st[j + 1] = st[j]; st[j] = x; st[j + 3] = st[j + 2]; st[j + 2] = y;
      m2 += y * y;
    }
    this.slideE += (m2 - this.slideE) * Math.min(1, dt / 0.015);
    return Math.sqrt(this.slideE);
  }

  /** 2nd-order Butterworth high-pass per axis (RBJ biquad); returns |output| in g. */
  private highpass(ax: number, ay: number, az: number): number {
    const c = this.cfg;
    if (c.tapHighpassHz !== this.hpFc) {
      this.hpFc = c.tapHighpassHz;
      const w0 = 2 * Math.PI * c.tapHighpassHz / c.sampleRateHz;
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
      const cw = Math.cos(w0), a0 = 1 + alpha;
      this.hpCoef = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - alpha) / a0];
    }
    const [b0, b1, b2, a1, a2] = this.hpCoef;
    const st = this.hpState;
    const inp = this.tmp3; inp[0] = ax; inp[1] = ay; inp[2] = az;
    if (!this.hpPrimed) { // start in steady state for a constant input (no start-up spike)
      this.hpPrimed = true;
      for (let i = 0; i < 3; i++) { st[i * 4] = st[i * 4 + 1] = inp[i]; st[i * 4 + 2] = st[i * 4 + 3] = 0; }
    }
    let m2 = 0;
    for (let i = 0; i < 3; i++) {
      const j = i * 4;
      const x = inp[i];
      const y = b0 * x + b1 * st[j] + b2 * st[j + 1] - a1 * st[j + 2] - a2 * st[j + 3];
      st[j + 1] = st[j]; st[j] = x;
      st[j + 3] = st[j + 2]; st[j + 2] = y;
      m2 += y * y;
    }
    return Math.sqrt(m2);
  }

  private classifyWindow(k: number, t: number, dt: number): TapEvent {
    const c = this.cfg;
    const n = k - this.capStart + 1;
    const nb = this.ms2n(c.tapBaselineMs);
    // baseline = mean of the samples just before the window (gravity + any slow motion)
    const base = [0, 0, 0, 0, 0, 0];
    for (let j = 1; j <= nb; j++) {
      const idx = ((this.capStart - j + RING * 1000) % RING) * 6;
      for (let i = 0; i < 6; i++) base[i] += this.rawRing[idx + i];
    }
    for (let i = 0; i < 6; i++) base[i] /= nb;
    const acc = new Float64Array(n * 3), gyr = new Float64Array(n * 3);
    for (let j = 0; j < n; j++) {
      const idx = ((this.capStart + j + RING * 1000) % RING) * 6;
      for (let i = 0; i < 3; i++) {
        acc[j * 3 + i] = this.rawRing[idx + i] - base[i];
        gyr[j * 3 + i] = this.rawRing[idx + 3 + i] - base[3 + i];
      }
    }
    const features = extractFeatures(acc, gyr, n, dt * 1000);
    const p = this.classifier.predict(features);
    return {
      tTrigger: this.capTTrigger, tClassified: t,
      finger: p.finger, confidence: p.confidence, pIndex: p.pIndex,
      features, peakG: features[9],
    };
  }
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
