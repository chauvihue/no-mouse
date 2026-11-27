// Every tunable parameter of the processing pipeline lives in ONE plain object.
// Units are SI unless the name says otherwise (…G = g, …Dps = °/s, …Ms = ms).
// On the ESP32 this maps directly to a `struct PipelineConfig`.

export type FusionMode = 'madgwick' | 'gyro-only' | 'static' | 'accel-complementary' | 'accel-kalman';

/** Modes that move the cursor from the accelerometer alone (the gyro is ignored for motion). */
export const isAccelOnly = (m: FusionMode): boolean => m === 'accel-complementary' || m === 'accel-kalman';
/** How linear acceleration becomes cursor motion: one continuous integration, or stroke by stroke. */
export type MotionModel = 'integrate' | 'stroke' | 'segment';
export type SegLive = 'raw' | 'stroke';
export type ClassifierKind = 'logistic' | 'centroid';

export interface PipelineConfig {
  sampleRateHz: number;

  // ── 0. Accelerometer calibration (6-face rest, see the UI) ──
  accelBias: [number, number, number];  // g: reading at rest with the axis up/down, averaged; subtracted first
  accelScale: [number, number, number]; // unitless: multiplies (raw − bias); 1 = no change

  // ── Step toggles (each one can be switched off to show its effect) ──
  enableCalibration: boolean;   // 1. average gyro bias / gravity during startup stillness
  enableFusion: boolean;        // 2. orientation filter (off ⇒ orientation frozen at start)
  enableGravityRemoval: boolean;// 3. rotate to level frame and subtract 1 g
  enableZupt: boolean;          // 4. stillness detection → zero-velocity reset
  enableRestDetect: boolean;    // 4b. tilt-independent rest test: still even with a tilt error, and re-level
  enableSlideDetect: boolean;   // 4c. sliding detector: desk vibration says the hand is moving
  enableVelocityDecay: boolean; // 5. slight leak on the velocity integrator
  enableDeadzone: boolean;      // 6. ignore tiny velocities
  enableSpeedCurve: boolean;    // 7. nonlinear gain (off ⇒ constant linear gain)
  enableClickFreeze: boolean;   // 8. lock cursor around a detected tap
  enableTaps: boolean;          // 9. tap detection + classification

  // 1. Calibration
  calibrationMs: number;
  biasTracking: boolean;        // keep refining gyro bias whenever the hand is still
  biasTrackingTauS: number;

  // 2. Fusion (Madgwick)
  fusionMode: FusionMode;       // used when enableFusion is on
  adaptiveBeta: boolean;        // trust accel more when still, gyro more when moving
  betaFixed: number;            // rad/s, when adaptiveBeta is off
  betaStill: number;            // rad/s
  betaMoving: number;           // rad/s (only after fusionMovingDelayMs of continuous motion)
  accelGateG: number;           // skip accel correction if | |a| − g | exceeds this
  motionGateG: number;          // while still: pause correction if horizontal linear accel exceeds this (stroke onset)
  fusionMovingDelayMs: number;  // while moving: gyro only, unless "moving" has lasted longer than this

  // 2b. Accelerometer-only gravity tracking (fusionMode accel-complementary / accel-kalman)
  compTauS: number;             // complementary: gravity = low-pass of accel with this time constant
  kalmanTiltRate: number;       // Kalman: how fast gravity may wander (process noise), g/√s
  kalmanNoiseG: number;         // Kalman: accelerometer noise at rest, g
  kalmanSpreadFloorG: number;   // Kalman: accel spread below this is sensor noise, not hand motion, g
  kalmanMotionK: number;        // Kalman: measurement noise added per g of spread above the floor (hand motion)

  // 4. Stillness / ZUPT
  stillWindowMs: number;        // moving-average window for the stillness test
  stillAccelG: number;          // |mean horizontal linear accel| threshold
  stillGyroDps: number;         // |mean gyro| threshold
  stillPeakG: number;           // no instantaneous |linear accel| spike above this in the window
  stillBaselineS: number;       // accel is judged relative to its own slow baseline (time constant)…
  stillBaselineCalmG: number;   // …learned only from samples calmer than this…
  stillBaselineMaxG: number;    // …and capped at this (≈ the largest tilt error we expect, 0.02 g ≈ 1.1°)
  stillHoldMs: number;          // must stay below thresholds this long (≈50–60 ms)
  stillHoldPerVel: number;      // extra hold (ms per m/s of current velocity estimate) so slow strokes aren't cut
  stillHoldMaxExtraMs: number;  // cap on that extra hold (prevents a drift → never-still feedback loop)

  // 4b. Tilt-independent rest test. The stillness test above judges horizontal linear
  // accel, which a tilt error corrupts: a tilt error then blocks stillness, which blocks
  // the tilt correction and the zero-velocity reset, and the cursor runs off. This test
  // only uses things a tilt error can't fake: quiet gyro, steady accel, |a| ≈ 1 g.
  restSpreadG: number;          // accel spread over ~100 ms must stay below this, g
  restHoldMs: number;           // …together with quiet gyro and |a| ≈ 1 g, for this long
  betaRelevel: number;          // Madgwick gain while at rest with a leftover tilt error, rad/s
  relevelDelayMs: number;       // the normal stillness test must fail this long before re-levelling
  relevelSnap: boolean;         // on rest confirmed: set the tilt to the 100 ms mean accel direction (keeps yaw)
  restRetake: boolean;          // accel-only: on rest confirmed (segRest* test): gravity := 100 ms mean accel, once per pause

  // 4c. Sliding detector: when the hand slides on the desk the sensor vibrates (100–300 Hz,
  // 60–85 mg on the real board, ~4 mg at rest). That says "moving" even at steady speed, when
  // there is no acceleration, and "not moving" during a wrist tilt, which makes no vibration.
  slideHpHz: number;            // high-pass that keeps the vibration and drops hand motion
  slideOnMg: number;            // sliding when the vibration RMS is above this (or 2× the level at calibration)…
  slideQuietMs: number;         // …and stopped once it has been below it for this long
  // What it is used for (each measured on real recording 1 and the simulator):
  //  - while sliding, the tilt filters don't learn (Madgwick β = 0, no 4b re-level, accel-only
  //    gravity held): the accelerometer reads hand motion then, and a slow push was learned as tilt;
  //  - a stroke only starts while sliding (a tilt with no vibration is ignored);
  //  - a stroke may glide at steady speed while sliding (strokeGlideMaxMs) instead of strokeCruiseMs.
  // Not used: ending strokes when the vibration stops. The real hand vibrates ~90% of the time
  // in back-and-forth, so leaked speed then lived on (accel-only drift 77 → 180 cm).

  // 5. Integration
  motionModel: MotionModel;     // 'integrate': velocity = ∫ accel all the time; 'stroke': see stroke.ts;
                                // 'segment': integrate per move (rest to rest), then remove the drift (linear detrend)
  // 5c. Segment model (motionModel 'segment')
  segRestDps: number;           // rest: |gyro − bias| below this (°/s), …
  segRestSpreadG: number;       // …and accel spread (gravity tracker) below this (g) …
  segRestMs: number;            // …held this long: a segment ends; the next starts when rest ends
  segMaxTiltDeg: number;        // a segment whose rotation exceeds this (deg) is not corrected (a tilt, not a slide)
  segTiltMode: 'net' | 'max';   // rotation measure: magnitude of the integrated gyro, or the largest angle reached
  segMaxJumpCm: number;         // a correction that adds more than this (cm) to the live displacement is not applied
  segSpreadMs: number;          // window of the accel spread in the rest test (100 = gravity.spread; shorter ends segments sooner)
  segMaxS: number;              // longer segments are cut WITHOUT correction (live position kept), then restart
  segLive: SegLive;             // what moves the cursor during a segment: raw integration, or the stroke tracker
  segIncludeHold: boolean;      // detrend over the rest-hold samples too (false: stop at the start of the hold)
  velocityDecayPerS: number;    // v ← v·exp(−rate·dt)

  // 5b. Stroke tracker (motionModel 'stroke'): speed-up → slow-down → halt, see stroke.ts
  strokeOnsetG: number;         // a stroke starts when accel relative to rest passes this, g…
  strokeOnsetMs: number;        // …in a steady direction for this long (a noise blip doesn't)
  strokeBrakeG: number;         // speed-up turns into slow-down once accel points back by this much, g
  strokeEndFrac: number;        // halt once braking has faded below this fraction of its peak…
  strokeEndMs: number;          // …for this long…
  strokeEndSpeedFrac: number;   // …with the speed below this fraction of the stroke's top speed
  strokeCruiseMs: number;       // pushed, then neither pushing nor braking for this long: stopped
  strokeGlideMaxMs: number;     // …or this long if the sliding detector says the hand is still sliding
  strokeSettleMs: number;       // after a halt, this long of quiet before the next stroke can start
  strokeMaxSpeedupMs: number;   // speeding up longer than this isn't a hand stroke (a tilt): undo it
  strokeRestTauS: number;       // time constant for learning the at-rest acceleration
  strokeLpHz: number;           // low-pass for the stroke decisions: real strokes carry strong vibration above ~50 Hz
  strokeRelFrac: number;        // braking / pushing again counts only above this fraction of the stroke's own peak
  strokeLeakGain: number;       // learn the gravity leak from the velocity left over each time the hand stops (0 = off)

  // 6. Deadzone
  deadzoneMps: number;

  // 7. Gain curve: gain = gMin + k·ln(1 + speed / v0)   [px per metre]
  gainMin: number;
  gainK: number;
  gainV0: number;
  gainLinear: number;           // used when the speed curve is off

  // 8. Click freeze
  freezePreMs: number;          // roll the cursor back this far before the tap onset
  freezePostMs: number;         // and hold it this long after

  // 9. Tap detection
  tapHighpassHz: number;        // 2nd-order high-pass that separates taps from hand motion
  tapThresholdG: number;
  tapWindowMs: number;          // feature-extraction window after trigger
  tapBaselineMs: number;        // pre-trigger baseline used to remove gravity/motion
  tapRefractoryMs: number;
  classifier: ClassifierKind;

  // Cursor
  screenW: number;
  screenH: number;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  sampleRateHz: 1000,

  accelBias: [0, 0, 0],
  accelScale: [1, 1, 1],

  enableCalibration: true,
  enableFusion: true,
  enableGravityRemoval: true,
  enableZupt: true,
  enableRestDetect: true,
  enableSlideDetect: false, // on in the app (APP_PIPELINE_CONFIG); the datasheet simulator doesn't vibrate
  enableVelocityDecay: true,
  enableDeadzone: true,
  enableSpeedCurve: true,
  enableClickFreeze: true,
  enableTaps: true,

  calibrationMs: 1000,
  biasTracking: true,
  biasTrackingTauS: 10,

  fusionMode: 'madgwick',
  adaptiveBeta: true,
  betaFixed: 0.05,
  betaStill: 0.02,
  betaMoving: 0,
  accelGateG: 0.08,
  motionGateG: 0.008,
  fusionMovingDelayMs: 1500,

  compTauS: 2.0,
  kalmanTiltRate: 0.0006,
  kalmanNoiseG: 0.008,
  kalmanSpreadFloorG: 0.02,
  kalmanMotionK: 10,

  stillWindowMs: 40,
  stillAccelG: 0.006,
  stillGyroDps: 3,
  stillPeakG: 0.08,
  stillBaselineS: 1.5,
  stillBaselineCalmG: 0.03,
  stillBaselineMaxG: 0.02,
  stillHoldMs: 55,
  stillHoldPerVel: 3000,
  stillHoldMaxExtraMs: 100,

  restSpreadG: 0.02,
  restHoldMs: 500,  // shorter cuts slow strokes short (a stroke's accel flips sign within ~0.5 s; a stuck tilt error doesn't)
  betaRelevel: 0.1,
  relevelDelayMs: 200,
  relevelSnap: false,
  restRetake: false,

  slideHpHz: 60,
  slideOnMg: 8,
  slideQuietMs: 40,

  motionModel: 'integrate',
  velocityDecayPerS: 0.05,

  segRestDps: 3,
  segRestSpreadG: 0.015,
  segRestMs: 150,
  segSpreadMs: 60,
  segMaxTiltDeg: 6,
  segTiltMode: 'net',
  segMaxJumpCm: 1e9,
  segMaxS: 4,
  segLive: 'stroke',
  segIncludeHold: false,

  strokeOnsetG: 0.006,
  strokeOnsetMs: 10,
  strokeBrakeG: 0.006,
  strokeEndFrac: 0.2,
  strokeEndMs: 8,
  strokeEndSpeedFrac: 1,
  strokeCruiseMs: 120,
  strokeGlideMaxMs: 1500,
  strokeSettleMs: 40,
  strokeMaxSpeedupMs: 600,
  strokeRestTauS: 0.5,
  strokeLpHz: 12,
  strokeRelFrac: 0.25,
  strokeLeakGain: 0.2,

  deadzoneMps: 0.0025,

  gainMin: 1500,
  gainK: 2500,
  gainV0: 0.05,
  gainLinear: 4000,

  freezePreMs: 20,
  freezePostMs: 80,

  tapHighpassHz: 25,
  tapThresholdG: 0.2,
  tapWindowMs: 45,
  tapBaselineMs: 20,
  tapRefractoryMs: 120,
  classifier: 'logistic',

  screenW: 1000,
  screenH: 560,
};

/**
 * What the app runs with (and what scripts/bench-real.ts scores real recordings with): no gyro
 * for cursor motion, the stroke tracker, the sliding detector on, taps parked for now.
 */
export const APP_PIPELINE_CONFIG: PipelineConfig = {
  ...DEFAULT_PIPELINE_CONFIG,
  fusionMode: 'accel-kalman', motionModel: 'stroke', enableSlideDetect: true,
  enableTaps: false, enableClickFreeze: false,
};

export function cloneConfig(c: PipelineConfig): PipelineConfig {
  return { ...c };
}

/** The pipeline steps that can be A/B-tested, in pipeline order. */
export const PIPELINE_STEPS = [
  { key: 'enableCalibration', label: '1. Calibration' },
  { key: 'enableFusion', label: '2. Sensor fusion' },
  { key: 'enableGravityRemoval', label: '3. Gravity removal' },
  { key: 'enableZupt', label: '4. Zero-velocity reset' },
  { key: 'enableRestDetect', label: '4b. Tilt-proof rest test' },
  { key: 'enableSlideDetect', label: '4c. Sliding detector (desk vibration)' },
  { key: 'enableVelocityDecay', label: '5. Velocity decay' },
  { key: 'enableDeadzone', label: '6. Deadzone' },
  { key: 'enableSpeedCurve', label: '7. Speed curve' },
  { key: 'enableClickFreeze', label: '8. Click freeze' },
  { key: 'enableTaps', label: '9. Tap detection' },
] as const;

export type StepKey = (typeof PIPELINE_STEPS)[number]['key'];
