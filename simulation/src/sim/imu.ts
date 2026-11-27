// IMU simulator: turns a TRUE hand trajectory into MPU-6050-style readings at 1 kHz.
//   accel = R(q)ᵀ · (p̈ + g·ẑ)   (specific force in the sensor frame, in g)
//   gyro  = body angular rate from successive true orientations (°/s)
// plus wrist tilt / wobble, finger-tap impact signatures, offsets, bias drift,
// white noise (from the datasheet noise density), clipping and 16-bit quantisation.
// The "measured" preset adds what a real wrist-worn MPU-6050 showed (recording of Nov 25):
// vibration while the hand slides (100–300 Hz) and a gyro bias that moves after start-up.

import type { Finger } from '../pipeline/classifier.ts';
import type { ImuSample } from '../pipeline/pipeline.ts';
import { DEG, G, quatFromEuler, quatMul, rotateToSensor } from '../pipeline/math.ts';
import type { Quat, Vec3 } from '../pipeline/math.ts';
import { Rng } from './rng.ts';

export interface TapSignature {
  accel: Vec3;   // first-lobe amplitude per sensor axis (g)
  gyro: Vec3;    // first-lobe amplitude per sensor axis (°/s)
  freqHz: number;
  decayMs: number;
}

export type PresetName = 'MPU-6050 on the wrist (measured)' | 'MPU-6050' | 'ICM-42688-P' | 'Ideal (no noise)';

export interface SensorErrors {
  accelNoiseUg: number;     // µg/√Hz
  gyroNoiseDps: number;     // °/s/√Hz
  accelOffsetMg: number;    // ± max per axis
  gyroOffsetDps: number;    // ± max per axis
  accelDriftMg: number;     // bias random walk, mg/√s
  gyroDriftDps: number;     // bias random walk, °/s/√s
  quantize: boolean;
  vibrationMg: number;      // vibration while the hand slides (100–300 Hz), RMS on the horizontal axes, mg
  vibrationGyroDps: number; // the same vibration seen by the gyro, RMS, °/s
  gyroWarmupDps: number;    // ± max per axis: how far the gyro bias moves after start-up, °/s
  gyroWarmupTauS: number;   // …with this time constant
}

const NO_REAL_WORLD = { vibrationMg: 0, vibrationGyroDps: 0, gyroWarmupDps: 0, gyroWarmupTauS: 10 };

export const PRESETS: Record<PresetName, SensorErrors> = {
  // The datasheet MPU-6050, plus what the real one on the wrist showed (recording of Nov 25):
  // 60–85 mg of 100–300 Hz vibration on the horizontal axes whenever the hand slides (2 mg at
  // rest), 2–6 °/s of it on the gyro, and a gyro bias ~0.4 °/s off its start-up value.
  'MPU-6050 on the wrist (measured)': {
    // accel noise: the real one is quieter than the datasheet (~3 mg RMS at rest)
    accelNoiseUg: 140, gyroNoiseDps: 0.005, accelOffsetMg: 50, gyroOffsetDps: 20,
    accelDriftMg: 0.05, gyroDriftDps: 0.002, quantize: true,
    vibrationMg: 70, vibrationGyroDps: 4, gyroWarmupDps: 0.4, gyroWarmupTauS: 10,
  },
  'MPU-6050': {
    accelNoiseUg: 400, gyroNoiseDps: 0.005, accelOffsetMg: 50, gyroOffsetDps: 20,
    accelDriftMg: 0.05, gyroDriftDps: 0.002, quantize: true, // bias random walk ≈ 10–40 °/h instability
    ...NO_REAL_WORLD,
  },
  'ICM-42688-P': {
    accelNoiseUg: 70, gyroNoiseDps: 0.0028, accelOffsetMg: 20, gyroOffsetDps: 0.5,
    accelDriftMg: 0.02, gyroDriftDps: 0.0005, quantize: true,
    ...NO_REAL_WORLD,
  },
  'Ideal (no noise)': {
    accelNoiseUg: 0, gyroNoiseDps: 0, accelOffsetMg: 0, gyroOffsetDps: 0,
    accelDriftMg: 0, gyroDriftDps: 0, quantize: false,
    ...NO_REAL_WORLD,
  },
};

// Per-axis shape of the measured vibration (sensor x, y, z): the vertical axis vibrates least
// in the accelerometer and most in the gyro (yaw).
const VIB_ACCEL_AXES = [1.1, 0.9, 0.45];
const VIB_GYRO_AXES = [0.6, 0.8, 1.6];
const VIB_HZ = 200, VIB_Q = 0.8; // band-pass: most of the measured energy is 100–300 Hz

export interface SimConfig extends SensorErrors {
  sampleRateHz: number;
  noiseBandwidthHz: number;  // σ = density·√BW
  accelRangeG: number;
  gyroRangeDps: number;
  baseRollDeg: number;
  basePitchDeg: number;
  wobbleDeg: number;         // natural wrist wobble amplitude during strokes
  seed: number;
  handOmega: number;         // rad/s, smoothing of the mouse-driven hand
  tapIndex: TapSignature;
  tapPinky: TapSignature;
  tapVariation: number;      // 0..1, tap-to-tap randomness
  tapSimilarity: number;     // 0 = distinct, 1 = identical signatures
}

export const DEFAULT_TAP_INDEX: TapSignature = {
  accel: [0.25, 0.45, -1.1], gyro: [45, -25, 8], freqHz: 90, decayMs: 7,
};
export const DEFAULT_TAP_PINKY: TapSignature = {
  accel: [-0.55, 0.15, -0.7], gyro: [15, 60, -12], freqHz: 115, decayMs: 6,
};

export const DEFAULT_SIM_CONFIG: SimConfig = {
  ...PRESETS['MPU-6050 on the wrist (measured)'],
  sampleRateHz: 1000,
  noiseBandwidthHz: 500,
  accelRangeG: 8,
  gyroRangeDps: 1000,
  baseRollDeg: 2,
  basePitchDeg: -3,
  wobbleDeg: 0.8, // measured on the real wrist: ~0.3° RMS tilt during swings (3° was 4× too much)
  seed: 1,
  handOmega: 45,
  tapIndex: DEFAULT_TAP_INDEX,
  tapPinky: DEFAULT_TAP_PINKY,
  tapVariation: 0.2,
  tapSimilarity: 0,
};

export function cloneSimConfig(c: SimConfig): SimConfig {
  return {
    ...c,
    tapIndex: { ...c.tapIndex, accel: [...c.tapIndex.accel] as Vec3, gyro: [...c.tapIndex.gyro] as Vec3 },
    tapPinky: { ...c.tapPinky, accel: [...c.tapPinky.accel] as Vec3, gyro: [...c.tapPinky.gyro] as Vec3 },
  };
}

/** Ground truth that accompanies every simulated sample. */
export interface Truth {
  px: number; py: number;     // m
  vx: number; vy: number;     // m/s
  ax: number; ay: number;     // m/s² (world)
  roll: number; pitch: number; yaw: number; // deg
  tap: Finger | null;         // a tap signature is ringing on this sample
}

interface ActiveTap { start: number; finger: Finger; sig: TapSignature }

export class ImuSim {
  cfg: SimConfig;
  readonly sample: ImuSample = { t: 0, ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 };
  readonly truth: Truth = { px: 0, py: 0, vx: 0, vy: 0, ax: 0, ay: 0, roll: 0, pitch: 0, yaw: 0, tap: null };
  k = 0;

  private rng!: Rng;
  private tapRng!: Rng;
  private vibRng!: Rng;          // separate stream, so turning vibration on/off leaves the other noise unchanged
  private warmUnit: Vec3 = [0, 0, 0];
  private vibState = new Float64Array(6 * 4); // band-pass filter state per channel (ax, ay, az, gx, gy, gz)
  private vibCoef = [0, 0, 0, 0, 0];
  private vibNorm = 1;
  private moving = 0;            // 0 at rest … 1 sliding, smoothed
  private offUnitA: Vec3 = [0, 0, 0];
  private offUnitG: Vec3 = [0, 0, 0];
  readonly driftA: Vec3 = [0, 0, 0];
  readonly driftG: Vec3 = [0, 0, 0];
  private p: [number, number] = [0, 0];
  private v: [number, number] = [0, 0];
  private hasPrev = false;
  private q: Quat = [1, 0, 0, 0];
  private qPrev: Quat = [1, 0, 0, 0];
  private qTmp: Quat = [1, 0, 0, 0];
  private speedLP = 0;
  private accLP: [number, number] = [0, 0];
  private phases: number[] = [];
  private taps: ActiveTap[] = [];
  private fTmp: Vec3 = [0, 0, 0];

  constructor(cfg: SimConfig = DEFAULT_SIM_CONFIG) {
    this.cfg = cloneSimConfig(cfg);
    this.reset(0, 0);
  }

  /** Power-cycle the sensor: re-roll offsets from the seed, place the hand at rest at (x, y). */
  reset(x: number, y: number): void {
    this.rng = new Rng(this.cfg.seed);
    this.tapRng = new Rng(this.cfg.seed * 7919 + 17);
    this.vibRng = new Rng(this.cfg.seed * 104729 + 31);
    for (let i = 0; i < 3; i++) this.warmUnit[i] = this.vibRng.uniform(-1, 1);
    this.vibState.fill(0); this.moving = 0;
    this.initVibration();
    for (let i = 0; i < 3; i++) {
      this.offUnitA[i] = this.rng.uniform(-1, 1);
      this.offUnitG[i] = this.rng.uniform(-1, 1);
    }
    this.driftA.fill(0); this.driftG.fill(0);
    this.phases = Array.from({ length: 9 }, () => this.rng.uniform(0, 2 * Math.PI));
    this.k = 0;
    this.p[0] = x; this.p[1] = y; this.v[0] = this.v[1] = 0;
    this.hasPrev = false;
    this.speedLP = 0; this.accLP[0] = this.accLP[1] = 0;
    this.taps = [];
    this.orientation(0, 0, 0, this.q);
    this.qPrev[0] = this.q[0]; this.qPrev[1] = this.q[1]; this.qPrev[2] = this.q[2]; this.qPrev[3] = this.q[3];
  }

  /** Band-pass for the vibration, normalised so unit white noise in gives unit RMS out. */
  private initVibration(): void {
    const fs = this.cfg.sampleRateHz, w0 = 2 * Math.PI * Math.min(VIB_HZ, 0.4 * fs) / fs;
    const al = Math.sin(w0) / (2 * VIB_Q), a0 = 1 + al;
    this.vibCoef = [al / a0, 0, -al / a0, -2 * Math.cos(w0) / a0, (1 - al) / a0];
    // noise power gain = sum of the squared impulse response
    const [b0, b1, b2, a1, a2] = this.vibCoef;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, pow = 0;
    for (let k = 0; k < 4000; k++) {
      const x = k === 0 ? 1 : 0, y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; pow += y * y;
    }
    this.vibNorm = 1 / Math.sqrt(pow);
  }

  /** One sample of band-passed vibration noise for channel ch (unit RMS). */
  private vib(ch: number): number {
    const st = this.vibState, j = ch * 4, [b0, b1, b2, a1, a2] = this.vibCoef;
    const x = this.vibRng.gauss() * this.vibNorm;
    const y = b0 * x + b1 * st[j] + b2 * st[j + 1] - a1 * st[j + 2] - a2 * st[j + 3];
    st[j + 1] = st[j]; st[j] = x; st[j + 3] = st[j + 2]; st[j + 2] = y;
    return y;
  }

  get accelOffsetG(): Vec3 { return this.offUnitA.map(u => u * this.cfg.accelOffsetMg / 1000) as Vec3; }
  get gyroOffsetDps(): Vec3 { return this.offUnitG.map(u => u * this.cfg.gyroOffsetDps) as Vec3; }

  injectTap(finger: Finger): void {
    this.taps.push({ start: this.k, finger, sig: this.drawSignature(finger) });
  }

  /** Effective (similarity-blended) mean signature for a finger. */
  meanSignature(finger: Finger): TapSignature {
    const a = this.cfg.tapIndex, b = this.cfg.tapPinky, s = this.cfg.tapSimilarity;
    const own = finger === 'index' ? a : b;
    const mix = (x: number, y: number, o: number) => o + s * ((x + y) / 2 - o);
    return {
      accel: [0, 1, 2].map(i => mix(a.accel[i], b.accel[i], own.accel[i])) as Vec3,
      gyro: [0, 1, 2].map(i => mix(a.gyro[i], b.gyro[i], own.gyro[i])) as Vec3,
      freqHz: mix(a.freqHz, b.freqHz, own.freqHz),
      decayMs: mix(a.decayMs, b.decayMs, own.decayMs),
    };
  }

  private drawSignature(finger: Finger): TapSignature {
    const m = this.meanSignature(finger);
    const v = this.cfg.tapVariation;
    const r = this.tapRng;
    const strength = Math.max(0.35, 1 + 1.25 * v * r.gauss());
    const jit = (x: number, floor: number) => strength * (x * (1 + v * r.gauss()) + floor * v * r.gauss());
    return {
      accel: [jit(m.accel[0], 0.15), jit(m.accel[1], 0.15), jit(m.accel[2], 0.15)],
      gyro: [jit(m.gyro[0], 10), jit(m.gyro[1], 10), jit(m.gyro[2], 10)],
      freqHz: m.freqHz * Math.max(0.5, 1 + 0.4 * v * r.gauss()),
      decayMs: m.decayMs * Math.max(0.4, 1 + 0.75 * v * r.gauss()),
    };
  }

  private orientation(t: number, speedF: number, _unused: number, out: Quat): Quat {
    const c = this.cfg, ph = this.phases;
    const n = (i: number) =>
      (Math.sin(2 * Math.PI * 1.7 * t + ph[i * 3]) + 0.7 * Math.sin(2 * Math.PI * 2.9 * t + ph[i * 3 + 1]) +
        0.5 * Math.sin(2 * Math.PI * 4.3 * t + ph[i * 3 + 2])) / 1.6;
    const w = c.wobbleDeg;
    // the wrist also tips a little with hand acceleration (saturating, so wobble stays "a few degrees")
    const aR = 0.6 * w * Math.tanh(this.accLP[0] / (0.3 * G));
    const aP = -0.6 * w * Math.tanh(this.accLP[1] / (0.3 * G));
    const roll = c.baseRollDeg + w * speedF * n(0) + aR;
    const pitch = c.basePitchDeg + w * speedF * n(1) + aP;
    const yaw = 0.5 * w * speedF * n(2);
    this.truth.roll = roll; this.truth.pitch = pitch; this.truth.yaw = yaw;
    return quatFromEuler(roll * DEG, pitch * DEG, yaw * DEG, out);
  }

  /** Advance one sample with the hand at (px, py) metres. Returns the IMU reading. */
  step(px: number, py: number): ImuSample {
    const c = this.cfg;
    const dt = 1 / c.sampleRateHz;
    const t = this.k * dt;
    // discrete kinematics consistent with semi-implicit Euler (v += a·dt; p += v·dt)
    let vx = 0, vy = 0;
    if (this.hasPrev) { vx = (px - this.p[0]) / dt; vy = (py - this.p[1]) / dt; }
    const ax = this.hasPrev ? (vx - this.v[0]) / dt : 0;
    const ay = this.hasPrev ? (vy - this.v[1]) / dt : 0;
    this.hasPrev = true;
    this.p[0] = px; this.p[1] = py; this.v[0] = vx; this.v[1] = vy;

    // wrist wobble state (smooth so the true gyro is smooth)
    this.speedLP += (Math.min(1, Math.hypot(vx, vy) / 0.15) - this.speedLP) * dt / 0.05;
    this.accLP[0] += (ax - this.accLP[0]) * dt / 0.03;
    this.accLP[1] += (ay - this.accLP[1]) * dt / 0.03;

    this.qPrev[0] = this.q[0]; this.qPrev[1] = this.q[1]; this.qPrev[2] = this.q[2]; this.qPrev[3] = this.q[3];
    this.orientation(t, this.speedLP, 0, this.q);

    // body angular rate: q̇ = ½ q ⊗ ω  ⇒  ω ≈ 2·vec(q_prev* ⊗ q)/dt
    const qc: Quat = this.qTmp;
    qc[0] = this.qPrev[0]; qc[1] = -this.qPrev[1]; qc[2] = -this.qPrev[2]; qc[3] = -this.qPrev[3];
    const dq = quatMul(qc, this.q, [0, 0, 0, 0]);
    const sgn = dq[0] < 0 ? -1 : 1;
    let gx = 2 * sgn * dq[1] / dt / DEG, gy = 2 * sgn * dq[2] / dt / DEG, gz = 2 * sgn * dq[3] / dt / DEG;

    // specific force in the sensor frame (g)
    const f = this.fTmp;
    f[0] = ax / G; f[1] = ay / G; f[2] = 1;
    rotateToSensor(this.q, f, f);
    let fx = f[0], fy = f[1], fz = f[2];

    // finger taps: short damped oscillations in the sensor frame
    this.truth.tap = null;
    for (let i = this.taps.length - 1; i >= 0; i--) {
      const tp = this.taps[i];
      const tau = (this.k - tp.start) * dt;
      if (tau > 0.045) { this.taps.splice(i, 1); continue; }
      const s = tp.sig;
      const onset = 1 - Math.exp(-tau / 0.0008);
      const ea = onset * Math.exp(-tau / (s.decayMs / 1000)) * Math.sin(2 * Math.PI * s.freqHz * tau);
      // the wrist vibrates and comes back: the gyro burst is the derivative of a rotation
      // that starts and ends at 0, so it integrates to (almost exactly) zero net rotation
      const wg = 2 * Math.PI * 0.6 * s.freqHz;
      const h = (x: number) => (x <= 0 ? 0 : (1 - Math.exp(-x / 0.0008)) * Math.exp(-x / (1.4 * s.decayMs / 1000)) * Math.sin(wg * x));
      const eg = (h(tau) - h(tau - dt)) / (dt * wg);
      fx += s.accel[0] * ea; fy += s.accel[1] * ea; fz += s.accel[2] * ea;
      gx += s.gyro[0] * eg; gy += s.gyro[1] * eg; gz += s.gyro[2] * eg;
      this.truth.tap = tp.finger;
    }

    // bias random walk
    const sq = Math.sqrt(dt);
    for (let i = 0; i < 3; i++) {
      this.driftA[i] += c.accelDriftMg / 1000 * sq * this.rng.gauss();
      this.driftG[i] += c.gyroDriftDps * sq * this.rng.gauss();
    }
    // vibration while the hand slides: on from ~0.5 cm/s, full from ~3 cm/s (measured)
    const target = Math.min(1, Math.max(0, (Math.hypot(vx, vy) - 0.005) / 0.025));
    this.moving += (target - this.moving) * Math.min(1, dt / 0.03);
    if (this.moving > 1e-3 && (c.vibrationMg > 0 || c.vibrationGyroDps > 0)) {
      const va = c.vibrationMg / 1000 * this.moving, vg = c.vibrationGyroDps * this.moving;
      fx += va * VIB_ACCEL_AXES[0] * this.vib(0); fy += va * VIB_ACCEL_AXES[1] * this.vib(1); fz += va * VIB_ACCEL_AXES[2] * this.vib(2);
      gx += vg * VIB_GYRO_AXES[0] * this.vib(3); gy += vg * VIB_GYRO_AXES[1] * this.vib(4); gz += vg * VIB_GYRO_AXES[2] * this.vib(5);
    }
    // the gyro bias moves away from its start-up value as the sensor warms up
    if (c.gyroWarmupDps > 0) {
      const w = c.gyroWarmupDps * (1 - Math.exp(-t / Math.max(0.1, c.gyroWarmupTauS)));
      gx += w * this.warmUnit[0]; gy += w * this.warmUnit[1]; gz += w * this.warmUnit[2];
    }
    const sA = c.accelNoiseUg * 1e-6 * Math.sqrt(c.noiseBandwidthHz);
    const sG = c.gyroNoiseDps * Math.sqrt(c.noiseBandwidthHz);
    const oA = c.accelOffsetMg / 1000, oG = c.gyroOffsetDps;
    const out = this.sample;
    out.t = t;
    out.ax = this.adc(fx + oA * this.offUnitA[0] + this.driftA[0] + sA * this.rng.gauss(), c.accelRangeG);
    out.ay = this.adc(fy + oA * this.offUnitA[1] + this.driftA[1] + sA * this.rng.gauss(), c.accelRangeG);
    out.az = this.adc(fz + oA * this.offUnitA[2] + this.driftA[2] + sA * this.rng.gauss(), c.accelRangeG);
    out.gx = this.adc(gx + oG * this.offUnitG[0] + this.driftG[0] + sG * this.rng.gauss(), c.gyroRangeDps);
    out.gy = this.adc(gy + oG * this.offUnitG[1] + this.driftG[1] + sG * this.rng.gauss(), c.gyroRangeDps);
    out.gz = this.adc(gz + oG * this.offUnitG[2] + this.driftG[2] + sG * this.rng.gauss(), c.gyroRangeDps);

    const tr = this.truth;
    tr.px = px; tr.py = py; tr.vx = vx; tr.vy = vy; tr.ax = ax; tr.ay = ay;
    this.k++;
    return out;
  }

  /** Full-scale clipping + 16-bit quantisation like the MPU-6050 ADC. */
  private adc(v: number, range: number): number {
    const x = Math.max(-range, Math.min(range * (32767 / 32768), v));
    if (!this.cfg.quantize) return x;
    const lsb = range / 32768;
    return Math.round(x / lsb) * lsb;
  }
}
