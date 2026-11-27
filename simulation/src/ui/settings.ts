// Slider / toggle builders bound to the live config objects.

import type { PipelineConfig } from '../pipeline/config.ts';
import type { SimConfig, TapSignature } from '../sim/imu.ts';

export interface SliderSpec {
  label: string; min: number; max: number; step: number;
  get: () => number; set: (v: number) => void;
  fmt?: (v: number) => string; tip?: string;
}

export interface Bound { el: HTMLElement; refresh: () => void }

export function slider(spec: SliderSpec, onChange?: () => void): Bound {
  const row = document.createElement('div');
  row.className = 'sl';
  if (spec.tip) row.title = spec.tip;
  const lab = document.createElement('label');
  lab.textContent = spec.label;
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = String(spec.min); inp.max = String(spec.max); inp.step = String(spec.step);
  inp.setAttribute('aria-label', spec.label);
  const val = document.createElement('span');
  val.className = 'v';
  const fmt = spec.fmt ?? ((v: number) => String(v));
  const refresh = () => { const v = spec.get(); inp.value = String(v); val.textContent = fmt(v); };
  inp.addEventListener('input', () => { spec.set(Number(inp.value)); val.textContent = fmt(Number(inp.value)); onChange?.(); });
  row.append(lab, inp, val);
  refresh();
  return { el: row, refresh };
}

function heading(text: string): HTMLElement {
  const h = document.createElement('div');
  h.className = 'subhead';
  h.textContent = text;
  return h;
}

const f0 = (u: string) => (v: number) => `${v.toFixed(0)} ${u}`;
const f1 = (u: string) => (v: number) => `${v.toFixed(1)} ${u}`;
const f2 = (u: string) => (v: number) => `${v.toFixed(2)} ${u}`;
const f3 = (u: string) => (v: number) => `${v.toFixed(3)} ${u}`;

type Num<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

export function buildPipelineSliders(host: HTMLElement, P: () => PipelineConfig, onChange: () => void): Bound[] {
  const b: Bound[] = [];
  const add = (key: Num<PipelineConfig>, label: string, min: number, max: number, step: number, fmt: (v: number) => string, tip?: string, scale = 1) => {
    const s = slider({ label, min, max, step, fmt: v => fmt(v), tip, get: () => (P()[key] as number) * scale, set: v => { (P()[key] as number) = v / scale; } }, onChange);
    host.appendChild(s.el); b.push(s);
  };
  host.appendChild(heading('1–2 · Calibration & fusion'));
  add('calibrationMs', 'Calibration time', 200, 3000, 100, f0('ms'));
  add('betaStill', 'Madgwick β (still)', 0, 0.3, 0.005, f3('rad/s'), 'How strongly the accelerometer corrects tilt while the hand is still');
  add('betaMoving', 'Madgwick β (long motion)', 0, 0.1, 0.001, f3('rad/s'), 'Accelerometer correction after long continuous motion');
  add('betaFixed', 'Madgwick β (non-adaptive)', 0, 0.3, 0.005, f3('rad/s'));
  add('motionGateG', 'Fusion onset gate', 0, 30, 0.5, f1('mg'), 'While still, pause tilt correction if sideways accel exceeds this (start of a stroke)', 1000);
  add('fusionMovingDelayMs', 'Gyro-only while moving, up to', 0, 5000, 100, f0('ms'), 'After this much continuous motion, slowly re-enable accelerometer tilt correction');
  host.appendChild(heading('2b · Accelerometer-only gravity filters (no gyro)'));
  add('compTauS', 'Complementary: time constant', 0.2, 10, 0.1, f1('s'), 'Gravity = low-pass of the accelerometer. Longer: steadier strokes, slower recovery after a tilt');
  add('kalmanTiltRate', 'Kalman: tilt change rate', 0.1, 5, 0.1, f1('mg/√s'), 'Process noise: how fast gravity may move. Higher: faster recovery after a tilt, more of each stroke absorbed', 1000);
  add('kalmanMotionK', 'Kalman: motion distrust', 0, 50, 1, f0('×'), 'How much hand motion (accel spread) lowers trust in the accelerometer as a gravity reading');
  add('kalmanSpreadFloorG', 'Kalman: noise floor', 2, 60, 1, f0('mg'), 'Accel spread below this is sensor noise, not hand motion', 1000);
  host.appendChild(heading('4 · Stillness / zero-velocity reset'));
  add('stillAccelG', 'Still: |lin. accel| <', 1, 30, 0.5, f1('mg'), 'Mean horizontal linear acceleration over the window', 1000);
  add('stillGyroDps', 'Still: |gyro| <', 0.5, 20, 0.5, f1('°/s'));
  add('stillWindowMs', 'Still: averaging window', 10, 150, 5, f0('ms'));
  add('stillHoldMs', 'Still: hold time', 10, 200, 5, f0('ms'), 'Thresholds must hold this long before velocity is forced to 0');
  add('stillHoldPerVel', 'Still: extra hold per speed', 0, 10000, 250, v => `${(v / 100).toFixed(1)} ms/(cm/s)`);
  host.appendChild(heading('4b · Tilt-proof rest test (gyro modes)'));
  add('restSpreadG', 'Rest: accel spread <', 2, 60, 1, f0('mg'), 'Accel varies less than this over ~100 ms (steady even when tilted)', 1000);
  add('restHoldMs', 'Rest: hold time', 100, 500, 25, f0('ms'), 'Quiet gyro + steady accel + |a| ≈ 1 g this long counts as rest. Shorter cuts slow strokes short; capped by the ~0.5 s history used to undo drift');
  add('betaRelevel', 'Rest: re-level gain', 0, 0.5, 0.01, f2('rad/s'), 'Madgwick gain used to remove a tilt error found at rest');
  host.appendChild(heading('5b · Stroke tracker (motion model)'));
  add('strokeOnsetG', 'Stroke: start at', 2, 50, 1, f0('mg'), 'A stroke starts when acceleration (relative to what the sensor reads at rest) passes this. Lower catches slower strokes but also noise', 1000);
  add('strokeBrakeG', 'Stroke: braking from', 1, 50, 1, f0('mg'), 'Speeding up turns into slowing down once acceleration points back by this much; from then on only the stroke direction counts', 1000);
  add('strokeEndFrac', 'Stroke: halt when braking <', 0.02, 0.8, 0.01, v => `${(v * 100).toFixed(0)} % of peak`, 'Once braking has faded to this fraction of its strongest, the hand has stopped: velocity is set to 0');
  add('strokeEndMs', 'Stroke: …for', 1, 50, 1, f0('ms'));
  add('strokeCruiseMs', 'Stroke: no glide after', 50, 1000, 10, f0('ms'), 'Pushed, then neither pushing nor braking for this long: a hand does not glide, so it has stopped');
  add('strokeSettleMs', 'Stroke: settle quiet', 0, 200, 5, f0('ms'), 'After a stroke, this long of quiet before a new stroke can start (ignores the wrist wobbling to a stop)');
  add('strokeMaxSpeedupMs', 'Stroke: max speed-up', 200, 2000, 50, f0('ms'), 'Speeding up longer than this is a wrist tilt, not a stroke: the movement is undone');
  add('strokeLpHz', 'Stroke: decision low-pass', 4, 60, 1, f0('Hz'), 'The phase decisions look at acceleration below this frequency. Real strokes carry strong vibration above ~50 Hz (sliding on the desk); hand motion is below ~10 Hz');
  add('strokeRelFrac', 'Stroke: relative threshold', 0, 0.6, 0.05, v => `${(v * 100).toFixed(0)} % of peak`, 'Braking, pushing again or turning only counts above this fraction of the stroke\'s own strongest push or braking, so vibration can\'t flip the phase');
  add('strokeLeakGain', 'Stroke: leak learning', 0, 1, 0.05, f2('×'), 'Each time the hand stops, the speed left over says how much gravity leaked in; this much of it is learned and subtracted from later strokes (0 = off)');
  host.appendChild(heading('5–7 · Integration, deadzone, speed curve'));
  add('velocityDecayPerS', 'Velocity decay', 0, 2, 0.01, f2('/s'));
  add('deadzoneMps', 'Deadzone', 0, 20, 0.5, f1('mm/s'), undefined, 1000);
  add('gainMin', 'Gain gMin', 200, 6000, 100, f0('px/m'), 'gain = gMin + k·ln(1 + speed/v0)');
  add('gainK', 'Gain k', 0, 10000, 100, f0('px/m'));
  add('gainV0', 'Gain v0', 0.5, 30, 0.5, f1('cm/s'), undefined, 100);
  add('gainLinear', 'Linear gain (curve off)', 500, 10000, 100, f0('px/m'));
  host.appendChild(heading('8–9 · Click freeze & tap detection'));
  add('freezePreMs', 'Freeze: roll back', 0, 60, 1, f0('ms'));
  add('freezePostMs', 'Freeze: hold after', 0, 250, 5, f0('ms'));
  add('tapThresholdG', 'Tap threshold', 0.05, 1.5, 0.01, f2('g'));
  add('tapHighpassHz', 'Tap high-pass', 5, 100, 1, f0('Hz'));
  add('tapWindowMs', 'Tap feature window', 15, 80, 1, f0('ms'));
  return b;
}

export function buildSimSliders(host: HTMLElement, S: () => SimConfig, onChange: () => void): Bound[] {
  const b: Bound[] = [];
  const add = (key: Num<SimConfig>, label: string, min: number, max: number, step: number, fmt: (v: number) => string, tip?: string) => {
    const s = slider({ label, min, max, step, fmt, tip, get: () => S()[key] as number, set: v => { (S()[key] as number) = v; } }, onChange);
    host.appendChild(s.el); b.push(s);
  };
  host.appendChild(heading('Sensor errors'));
  add('accelNoiseUg', 'Accel noise density', 0, 1000, 10, f0('µg/√Hz'));
  add('gyroNoiseDps', 'Gyro noise density', 0, 0.03, 0.0005, f3('°/s/√Hz'));
  add('accelOffsetMg', 'Accel offset (max)', 0, 100, 1, f0('± mg'), 'Each axis gets a random offset within ± this at power-on');
  add('gyroOffsetDps', 'Gyro offset (max)', 0, 30, 0.5, f1('± °/s'));
  add('accelDriftMg', 'Accel bias drift', 0, 1, 0.01, f2('mg/√s'), 'Bias random walk');
  add('gyroDriftDps', 'Gyro bias drift', 0, 0.05, 0.0005, v => `${v.toFixed(4)} °/s/√s`, 'Bias random walk');
  host.appendChild(heading('Measured on the real wrist'));
  add('vibrationMg', 'Vibration while sliding', 0, 200, 5, f0('mg'), 'Shaking at 100–300 Hz whenever the hand moves (sliding on the desk). The real sensor showed 60–85 mg on the horizontal axes, 2 mg at rest');
  add('vibrationGyroDps', 'Vibration on the gyro', 0, 15, 0.5, f1('°/s'), 'The same shaking as seen by the gyro (the real one: 2–6 °/s)');
  add('gyroWarmupDps', 'Gyro bias warm-up', 0, 2, 0.05, f2('± °/s'), 'How far each gyro axis drifts from its start-up bias as the sensor warms up (the real one: ~0.4 °/s)');
  add('gyroWarmupTauS', 'Warm-up time constant', 1, 120, 1, f0('s'));
  host.appendChild(heading('Wrist'));
  add('baseRollDeg', 'Base tilt — roll', -10, 190, 0.5, f1('°'), 'Around 180° = sensor mounted upside down (as on the real board: z reads −1 g at rest)');
  add('basePitchDeg', 'Base tilt — pitch', -10, 10, 0.5, f1('°'));
  add('wobbleDeg', 'Wobble during strokes', 0, 10, 0.1, f1('°'), 'Wrist tilt wobble while the hand moves. 0.8° matches the real wrist (about 0.3° RMS)');
  add('handOmega', 'Hand smoothing (ω)', 15, 90, 1, f0('rad/s'), 'How quickly the simulated hand follows your mouse');
  return b;
}

export function buildTapSliders(host: HTMLElement, S: () => SimConfig, onChange: () => void): Bound[] {
  const b: Bound[] = [];
  const push = (s: Bound) => { host.appendChild(s.el); b.push(s); };
  push(slider({ label: 'Index ↔ pinky similarity', min: 0, max: 1, step: 0.01, fmt: v => `${(v * 100).toFixed(0)} %`,
    tip: '0 = each finger has its own signature, 100 % = identical (classification becomes a coin flip)',
    get: () => S().tapSimilarity, set: v => { S().tapSimilarity = v; } }, onChange));
  push(slider({ label: 'Tap-to-tap variation', min: 0, max: 0.6, step: 0.01, fmt: v => `${(v * 100).toFixed(0)} %`,
    get: () => S().tapVariation, set: v => { S().tapVariation = v; } }, onChange));
  const finger = (name: string, sig: () => TapSignature) => {
    host.appendChild(heading(name));
    (['x', 'y', 'z'] as const).forEach((ax, i) => push(slider({ label: `accel ${ax}`, min: -2, max: 2, step: 0.05, fmt: f2('g'),
      get: () => sig().accel[i], set: v => { sig().accel[i] = v; } }, onChange)));
    (['x', 'y', 'z'] as const).forEach((ax, i) => push(slider({ label: `gyro ${ax}`, min: -150, max: 150, step: 1, fmt: f0('°/s'),
      get: () => sig().gyro[i], set: v => { sig().gyro[i] = v; } }, onChange)));
    push(slider({ label: 'ring frequency', min: 40, max: 200, step: 1, fmt: f0('Hz'), get: () => sig().freqHz, set: v => { sig().freqHz = v; } }, onChange));
    push(slider({ label: 'decay', min: 2, max: 20, step: 0.5, fmt: f1('ms'), get: () => sig().decayMs, set: v => { sig().decayMs = v; } }, onChange));
  };
  finger('Index tap (J)', () => S().tapIndex);
  finger('Pinky tap (L)', () => S().tapPinky);
  return b;
}
