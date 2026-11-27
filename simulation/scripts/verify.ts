// Headless verification of the simulator + pipeline.  Run:  npm run verify
// (Node ≥ 23 runs TypeScript directly via type stripping.)

import { APP_PIPELINE_CONFIG, DEFAULT_PIPELINE_CONFIG } from '../src/pipeline/config.ts';
import type { PipelineConfig } from '../src/pipeline/config.ts';
import { TapClassifier } from '../src/pipeline/classifier.ts';
import { DEFAULT_SIM_CONFIG, PRESETS } from '../src/sim/imu.ts';
import type { SimConfig } from '../src/sim/imu.ts';
import { Session } from '../src/harness/session.ts';
import { HandModel, Script } from '../src/sim/hand.ts';
import { Rng } from '../src/sim/rng.ts';
import { runDriftTest, runStrokeTest, runSwingTest, runTapTest, trainSimulated, collectTrainingTaps } from '../src/harness/scenarios.ts';
import type { SwingRun } from '../src/harness/scenarios.ts';

const f = (v: number, d = 2) => (isFinite(v) ? v.toFixed(d) : '—');
const pipe: PipelineConfig = { ...DEFAULT_PIPELINE_CONFIG };
const SEEDS = [1, 2, 3, 4, 5];
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  if (!ok) failures++;
}

declare const process: { exitCode?: number };
const t0 = performance.now();

// ── 1. Ideal preset: estimated path ≈ true path ─────────────────────────────
console.log('\n[1] Ideal preset — estimated vs true stroke path (wobble 3°, base tilt 2°/−3°)');
{
  const sim: SimConfig = { ...DEFAULT_SIM_CONFIG, ...PRESETS['Ideal (no noise)'], wobbleDeg: 3 };
  const run = runStrokeTest(sim, pipe, 1);
  for (const s of run.strokes)
    console.log(`    ${s.label.padEnd(20)} true ${f(Math.hypot(s.trueDx, s.trueDy))} cm  est ${f(Math.hypot(s.estDx, s.estDy))} cm  ` +
      `dist err ${f(s.distErrPct, 1)} %  dir err ${f(s.dirErrDeg, 2)}°  end-point err ${f(s.endErrCm * 10, 2)} mm`);
  const rms = Math.sqrt(mean(run.path.map(p => (p.tx - p.ex) ** 2 + (p.ty - p.ey) ** 2))) * 1000;
  const maxDev = Math.max(...run.path.map(p => Math.hypot(p.tx - p.ex, p.ty - p.ey))) * 1000;
  console.log(`    whole-path RMS deviation ${f(rms)} mm, max ${f(maxDev)} mm over ${f(run.path.at(-1)!.t, 1)} s (total travel ≈ 34 cm)`);
  check('Ideal: path matches', run.meanEndErrCm < 0.3 && rms < 5, `mean end-point error ${f(run.meanEndErrCm * 10)} mm, mean |dir err| ${f(run.meanAbsDirErr)}°`);
}

// ── 2. MPU-6050 drift with hand still, ZUPT on vs off ──────────────────────
console.log('\n[2] MPU-6050 noise, hand still for 30 s — zero-velocity reset on vs off (5 seeds)');
{
  const sim: SimConfig = { ...DEFAULT_SIM_CONFIG, ...PRESETS['MPU-6050'], wobbleDeg: 3 };
  const on = SEEDS.map(s => runDriftTest(sim, { ...pipe, enableZupt: true }, s, 30));
  const off = SEEDS.map(s => runDriftTest(sim, { ...pipe, enableZupt: false }, s, 30));
  console.log(`    ZUPT on : drift ${on.map(r => f(r.driftCm, 3)).join(', ')} cm   (cursor ${on.map(r => f(r.cursorPx, 1)).join(', ')} px)`);
  console.log(`    ZUPT off: drift ${off.map(r => f(r.driftCm, 1)).join(', ')} cm   (cursor ${off.map(r => f(r.cursorPx, 0)).join(', ')} px)`);
  const offSeries = off[0].series;
  console.log(`    ZUPT off growth (seed 1): ` + [5, 10, 20, 30].map(t => `${t}s → ${f(offSeries.find(p => p.t >= t - 1e-9)?.cm ?? offSeries.at(-1)!.cm, 1)} cm`).join(', '));
  check('ZUPT keeps drift ≈ 0', mean(on.map(r => r.driftCm)) < 0.1, `mean ${f(mean(on.map(r => r.driftCm)), 3)} cm`);
  check('Without ZUPT drift grows visibly', mean(off.map(r => r.driftCm)) > 2, `mean ${f(mean(off.map(r => r.driftCm)), 1)} cm`);

  const noDecay = SEEDS.map(s => runDriftTest(sim, { ...pipe, enableZupt: false, enableVelocityDecay: false, enableDeadzone: false }, s, 30));
  console.log(`    (ZUPT, decay and deadzone all off: ${noDecay.map(r => f(r.driftCm, 0)).join(', ')} cm)`);
}

// ── 3. 1° tilt error with gravity subtraction disabled ─────────────────────
console.log('\n[3] 1° uncorrected tilt, gravity subtraction disabled (ideal sensor, no wobble)');
{
  const sim: SimConfig = { ...DEFAULT_SIM_CONFIG, ...PRESETS['Ideal (no noise)'], baseRollDeg: 0, basePitchDeg: 1, wobbleDeg: 0 };
  const cases: [string, Partial<PipelineConfig>][] = [
    ['gravity removal ON,  ZUPT on ', { enableGravityRemoval: true }],
    ['gravity removal OFF, ZUPT on ', { enableGravityRemoval: false }],
    ['gravity removal ON,  ZUPT off', { enableGravityRemoval: true, enableZupt: false }],
    ['gravity removal OFF, ZUPT off', { enableGravityRemoval: false, enableZupt: false }],
  ];
  const results: Record<string, number> = {};
  for (const [name, patch] of cases) {
    const d = runDriftTest(sim, { ...pipe, ...patch }, 1, 10);
    const s = runStrokeTest(sim, { ...pipe, ...patch }, 1);
    results[name] = d.driftCm;
    console.log(`    ${name}: still 10 s → drift ${f(d.driftCm, 2)} cm (cursor ${f(d.cursorPx, 0)} px);  strokes → mean end-point err ${f(s.meanEndErrCm, 2)} cm, mean |dir err| ${f(s.meanAbsDirErr, 1)}°`);
  }
  const series = runDriftTest(sim, { ...pipe, enableGravityRemoval: false, enableZupt: false }, 1, 10).series;
  console.log(`    runaway (OFF/OFF): ` + [1, 2, 5, 10].map(t => `${t}s → ${f(series.find(p => p.t >= t - 1e-9)?.cm ?? series.at(-1)!.cm, 1)} cm`).join(', ') + `   (theory ½·g·sin1°·t² = ${f(0.5 * 9.80665 * Math.sin(Math.PI / 180) * 100 * 100, 0)} cm at 10 s, less velocity decay)`);
  check('1° tilt w/o gravity removal runs away', results['gravity removal OFF, ZUPT off'] > 50 && results['gravity removal ON,  ZUPT off'] < 1,
    `OFF ${f(results['gravity removal OFF, ZUPT off'], 1)} cm vs ON ${f(results['gravity removal ON,  ZUPT off'], 3)} cm after 10 s`);
}

// ── 4. Tap classification vs similarity ────────────────────────────────────
console.log('\n[4] Index vs pinky classification vs signature similarity (MPU-6050 noise; train 20 taps/finger, test 3 runs × 15 taps/finger)');
{
  const base: SimConfig = { ...DEFAULT_SIM_CONFIG, ...PRESETS['MPU-6050'], wobbleDeg: 3 };
  const sims = [0, 0.25, 0.5, 0.75, 0.85, 0.9, 0.95, 1.0];
  const sweeps: Record<string, number[]> = {};
  for (const variation of [0.2, 0.4]) {
    console.log(`    tap-to-tap variation ${variation}:`);
    const accs: number[] = [];
    for (const sim of sims) {
      const cfg = { ...base, tapSimilarity: sim, tapVariation: variation };
      const row: string[] = [];
      let accL = 0;
      for (const kind of ['logistic', 'centroid'] as const) {
        const p = { ...pipe, classifier: kind };
        const { clf } = trainSimulated(cfg, p, 100, 20);
        const runs = [11, 12, 13].map(s => runTapTest(cfg, p, s, clf, 15));
        const cm = [[0, 0], [0, 0]];
        runs.forEach(r => r.confusion.forEach((rw, i) => rw.forEach((v, j) => (cm[i][j] += v))));
        const n = cm.flat().reduce((s, v) => s + v, 0);
        const acc = (cm[0][0] + cm[1][1]) / n * 100;
        if (kind === 'logistic') accL = acc;
        const fm = runs.reduce((s, r) => s + r.falseN + r.missed, 0);
        row.push(`${kind.padEnd(8)} ${f(acc, 1).padStart(5)} %  CM [[${cm[0]}],[${cm[1]}]]  false/missed ${fm}/90`);
      }
      accs.push(accL);
      console.log(`      similarity ${f(sim, 2)}:  ${row.join('   |   ')}`);
    }
    sweeps[variation] = accs;
  }
  const train = collectTrainingTaps({ ...base }, pipe, 7, 10);
  console.log(`    leave-one-out on 10+10 simulated training taps (similarity 0): CM ${JSON.stringify(TapClassifier.leaveOneOut(train, 'logistic'))}`);
  const a = sweeps[0.2];
  const monotone = (xs: number[]) => xs.every((v, i) => i === 0 || v <= xs[i - 1] + 5);
  check('Distinct signatures classify correctly', a[0] >= 97, `${f(a[0], 1)} % at similarity 0`);
  check('Accuracy degrades monotonically to chance', monotone(a) && monotone(sweeps[0.4]) && a.at(-1)! < 65 && sweeps[0.4].at(-1)! < 65,
    `var 0.2: ${a.map(v => f(v, 0)).join(' → ')} %;  var 0.4: ${sweeps[0.4].map(v => f(v, 0)).join(' → ')} %`);
}

// ── 5. Regression: vigorous mouse-driven motion must not run away ──────────
console.log('\n[5] Mouse-driven hand (60 Hz input, accel-limited), MPU-6050 — 20 random 300 ms moves across the desk (≈ 2 m travel)');
{
  const runMoves = (seed: number, pauseMs: number) => {
    const ses = new Session({ ...DEFAULT_SIM_CONFIG, ...PRESETS['MPU-6050'], wobbleDeg: 3, seed }, { ...pipe, screenW: 1e6, screenH: 1e6 });
    ses.reset(0.2, 0.1);
    const hand = new HandModel(45); hand.setPosition(0.2, 0.1);
    let prev = [0.2, 0.1], tgt = [0.2, 0.1];
    const run = (ms: number) => { for (let i = 0; i < ms; i++) { const fr = (i + 1) / ms; const p = hand.step(prev[0] + (tgt[0] - prev[0]) * fr, prev[1] + (tgt[1] - prev[1]) * fr, 0.001); ses.step(p[0], p[1]); } prev = [...tgt]; };
    for (let i = 0; i < 15; i++) run(100);
    const rng = new Rng(seed);
    for (let j = 0; j < 20; j++) { tgt = [0.05 + 0.3 * rng.next(), 0.04 + 0.17 * rng.next()]; for (let i = 0; i < 3; i++) run(100); for (let i = 0; i < pauseMs / 100; i++) run(100); }
    for (let i = 0; i < 20; i++) run(100);
    const o = ses.pipe.out, t = ses.sim.truth;
    return Math.hypot(o.pos[0] - (t.px - 0.2), o.pos[1] - (t.py - 0.1)) * 100;
  };
  const paused = SEEDS.map(s => runMoves(s, 400));
  const nonstop = SEEDS.map(s => runMoves(s, 0));
  console.log(`    with a 0.4 s pause after each move : accumulated error ${paused.map(e => f(e, 2)).join(', ')} cm`);
  console.log(`    nonstop for 6 s (no pause at all)  : accumulated error ${nonstop.map(e => f(e, 2)).join(', ')} cm   (no zero-velocity reset possible — pure dead-reckoning)`);
  check('Normal mousing stays accurate (no runaway)', Math.max(...paused) < 5, `worst ${f(Math.max(...paused), 2)} cm after ≈ 2 m of travel`);
}

// ── 6. Stroke tracker vs plain double integration ──────────────────────────
console.log('\n[6] Motion model: stroke tracker vs plain double integration (MPU-6050 + 3° wobble, 5 seeds)');
{
  const sim: SimConfig = { ...DEFAULT_SIM_CONFIG, ...PRESETS['MPU-6050'], wobbleDeg: 3 };
  const REV = [
    { label: '5 cm right', dx: 0.05, dy: 0, dur: 0.3, rest: 0.03 },
    { label: '5 cm left', dx: -0.05, dy: 0, dur: 0.3, rest: 0.03 },
    { label: '4 cm up', dx: 0, dy: 0.04, dur: 0.3, rest: 0.03 },
    { label: '4 cm down', dx: 0, dy: -0.04, dur: 0.3, rest: 0.6 },
  ];
  const endErr = (p: PipelineConfig, strokes?: typeof REV) => mean(SEEDS.map(s => runStrokeTest(sim, p, s, undefined, strokes).meanEndErrCm));
  for (const mode of ['madgwick', 'accel-kalman'] as const) {
    const r: Record<string, number[]> = {};
    for (const model of ['integrate', 'stroke'] as const) {
      const p: PipelineConfig = { ...pipe, fusionMode: mode, motionModel: model };
      r[model] = [endErr(p), endErr(p, REV), mean(SEEDS.map(s => runDriftTest(sim, p, s, 30).cursorPx))];
      console.log(`    ${mode.padEnd(13)} ${model.padEnd(9)}: stroke end-point err ${f(r[model][0])} cm, back-and-forth ${f(r[model][1])} cm, still 30 s → cursor ${f(r[model][2], 1)} px`);
    }
    check(`${mode}: stroke tracker more accurate`, r.stroke[0] < r.integrate[0] && r.stroke[1] < r.integrate[1],
      `end-point ${f(r.stroke[0])} vs ${f(r.integrate[0])} cm, back-and-forth ${f(r.stroke[1])} vs ${f(r.integrate[1])} cm`);
    check(`${mode}: stroke tracker still at rest`, r.stroke[2] < 3, `${f(r.stroke[2], 1)} px in 30 s`);
  }
  // A stroke into the screen edge: the edge drops the outward speed, so plain integration turns
  // the braking that follows into a big bounce back off the edge. The stroke tracker ends the
  // stroke at the edge and ignores that braking.
  const bounce = (model: 'integrate' | 'stroke', seed: number) => {
    const ses = new Session({ ...sim, seed }, { ...pipe, fusionMode: 'accel-kalman', motionModel: model });
    ses.reset(0.2, 0.1, 900, 280);
    const sc = new Script(0.2, 0.1, 1.5, [{ label: 'right', dx: 0.05, dy: 0, dur: 0.3, rest: 1.0 }], 0);
    let hit = false, back = 0;
    for (let k = 0; k < sc.duration * 1000; k++) {
      const [x, y] = sc.at(k / 1000);
      const o = ses.step(x, y).out;
      if (o.cursor[0] >= pipe.screenW) hit = true;
      if (hit) back = Math.max(back, pipe.screenW - o.cursor[0]);
    }
    return back;
  };
  const bi = SEEDS.map(s => bounce('integrate', s)), bs = SEEDS.map(s => bounce('stroke', s));
  console.log(`    5 cm stroke into the screen edge (accel-kalman), bounce back off it: integrate ${bi.map(v => f(v, 0)).join(', ')} px; stroke ${bs.map(v => f(v, 0)).join(', ')} px`);
  check('Stroke tracker: no bounce off the screen edge', Math.max(...bs) < 10, `worst ${f(Math.max(...bs), 0)} px (integrate: ${f(Math.max(...bi), 0)} px)`);
}

// ── 7. Measured sensor model (vibration, gyro warm-up, real wobble) ───────
console.log('\n[7] MPU-6050 as measured on the wrist: vibration, gyro bias warm-up, 0.8° wobble (5 seeds)');
{
  const sim: SimConfig = { ...DEFAULT_SIM_CONFIG, ...PRESETS['MPU-6050 on the wrist (measured)'] };
  // As the app runs (APP_PIPELINE_CONFIG): taps off (this vibration alone sets off the tap
  // detector, and the click freeze then swallows the motion), sliding detector on.
  const pipe7: PipelineConfig = { ...APP_PIPELINE_CONFIG };
  const swings = (mode: PipelineConfig['fusionMode'], model: PipelineConfig['motionModel'], s: SimConfig = sim) =>
    SEEDS.map(seed => runSwingTest(s, { ...pipe7, fusionMode: mode, motionModel: model }, seed, { swingS: 0.9 }));
  const avg = (rs: SwingRun[], k: 'mean' | 'scatter' | 'side' | 'net') => mean(rs.map(r => r[k]));
  console.log('    12 swings of 10 cm, 0.9 s each, no pause (like real recording 1): mean swing ± scatter, sideways, drift');
  for (const mode of ['madgwick', 'accel-kalman'] as const) {
    const st = swings(mode, 'stroke'), it = swings(mode, 'integrate');
    console.log(`    ${mode.padEnd(13)} stroke ${f(avg(st, 'mean'), 1)} ± ${f(avg(st, 'scatter'), 1)} cm, sideways ${f(avg(st, 'side'), 1)}, drift ${f(avg(st, 'net'), 1)} cm   |   integrate: drift ${f(avg(it, 'net'), 0)} cm`);
    // No runaway: well under plain integration. (The sliding detector costs some drift here:
    // while the hand never stops sliding, the tilt filters never get to correct.)
    check(`${mode}: stroke tracker survives nonstop swings with vibration`, avg(st, 'net') < Math.min(25, avg(it, 'net') / 10) && avg(st, 'side') < 5,
      `drift ${f(avg(st, 'net'), 1)} cm, sideways ${f(avg(st, 'side'), 1)} cm (plain integration runs away: ${f(avg(it, 'net'), 0)} cm)`);
  }
  // the real board is mounted upside down (z reads −1 g at rest)
  const flipped: SimConfig = { ...sim, baseRollDeg: 182 };
  for (const mode of ['madgwick', 'accel-kalman'] as const) {
    const a = mean(SEEDS.map(s => runStrokeTest(sim, { ...pipe7, fusionMode: mode, motionModel: 'stroke' }, s).meanEndErrCm));
    const b = mean(SEEDS.map(s => runStrokeTest(flipped, { ...pipe7, fusionMode: mode, motionModel: 'stroke' }, s).meanEndErrCm));
    check(`${mode}: works with the sensor upside down`, b < Math.max(0.2, 1.5 * a), `stroke end-point error ${f(b)} cm upside down vs ${f(a)} cm normal`);
  }
  // A steady pan (speed up, glide at constant speed, slow down): the sliding detector keeps the
  // glide alive. Without it the stroke tracker took the glide for a stop and lost the pan.
  const pan = (cfg: PipelineConfig, seed: number) => {
    const D = 0.2, ta = 0.2, tc = 1.2, v = D / (ta + tc), acc = v / ta;
    const x = (t: number) => t <= 0 ? 0 : t < ta ? 0.5 * acc * t * t : t < ta + tc ? 0.5 * acc * ta * ta + v * (t - ta)
      : t < 2 * ta + tc ? D - 0.5 * acc * (2 * ta + tc - t) ** 2 : D;
    const ses = new Session({ ...sim, seed }, { ...cfg, screenW: 1e6, screenH: 1e6 });
    ses.reset(0.2, 0.1, 5e5, 5e5);
    let p0 = 0;
    for (let k = 0; k < 4600; k++) { const o = ses.step(0.2 + x(k / 1000 - 1.6), 0.1).out; if (k === 1595) p0 = o.pos[0]; }
    return (ses.pipe.out.pos[0] - p0) * 100;
  };
  const withD = mean(SEEDS.map(s => pan({ ...pipe7, fusionMode: 'madgwick' }, s)));
  const without = mean(SEEDS.map(s => pan({ ...pipe7, fusionMode: 'madgwick', enableSlideDetect: false }, s)));
  console.log(`    steady 20 cm pan (0.2 s up, 1.2 s gliding, 0.2 s down), Madgwick + stroke: ${f(withD, 1)} cm with the sliding detector, ${f(without, 1)} cm without`);
  check('Steady pans move the cursor (sliding detector)', withD > 15 && withD < 25, `${f(withD, 1)} cm measured for 20 cm (without the detector: ${f(without, 1)} cm)`);
}

console.log(`\nDone in ${f((performance.now() - t0) / 1000, 1)} s — ${failures ? failures + ' check(s) FAILED' : 'all checks passed'}.`);
process.exitCode = failures ? 1 : 0;
