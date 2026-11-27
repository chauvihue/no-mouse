// Trains the left/right click classifier and writes algorithms/clicks/model.ts.
//
// Run:  npm run train:clicks                              (default: the two clicks takes in ../data)
//       npm run train:clicks -- file1.csv file2.csv ...   (explicit list)
//
// Taps are found and their features computed by the streaming detector in algorithms/clicks/detector.ts,
// the same class the live click tester runs, so training and live use identical code. Labels come
// from the guide_click column of the guided "clicks" recordings (rows where guide_step is 'click').
// A click window is matched to the detector's event with the largest peak inside
// [window start - 50 ms, window end + 500 ms]. Events outside every window are false events.
//
// Prints per take: detections, false events, noise floor; then cross-take accuracy (train on one
// take, test on the other, feature selection done inside the training take); then fits the final
// model on both takes and writes algorithms/clicks/model.ts. Regenerate after changing the detector or
// the recordings.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClickDetector, FEATURE_NAMES } from '../../algorithms/clicks/detector.ts';
import type { ClickEvent, ClickModel, ImuReading, Side } from '../../algorithms/clicks/detector.ts';

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const MODEL_FILE = fileURLToPath(new URL('../../algorithms/clicks/model.ts', import.meta.url));
const DEFAULT_FILES = [
  `${DATA_DIR}clicks_take01_2026-11-27_13-58-32.csv`,
  `${DATA_DIR}clicks_take02_2026-11-27_14-05-43.csv`,
];
const cliFiles = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const FILES: string[] = cliFiles.length > 0 ? cliFiles : DEFAULT_FILES;
const TOP_K = 5;

// ---------- recordings ----------
interface Win { t0: number; t1: number; label: Side }
interface Take { name: string; fs: number; samples: ImuReading[]; wins: Win[] }

function loadTake(path: string): Take {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const hdrAt = lines.findIndex((l) => l.length > 0 && !l.startsWith('#'));
  const header = lines[hdrAt].split(',');
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`column "${name}" missing in ${path}`);
    return i;
  };
  const cT = col('t'), cAx = col('ax'), cAy = col('ay'), cAz = col('az');
  const cGx = col('gx'), cGy = col('gy'), cGz = col('gz');
  const cSec = col('guide_section'), cStep = col('guide_step');
  const cMove = col('guide_move'), cClick = col('guide_click');

  const rows = lines.slice(hdrAt + 1).filter((l) => l.length > 0);
  const N = rows.length;
  const samples: ImuReading[] = new Array(N);
  const STEP: string[] = new Array(N), SEC: string[] = new Array(N);
  const MOVE: string[] = new Array(N), CLK: string[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const f = rows[i].split(',');
    samples[i] = {
      t: Number(f[cT]), ax: Number(f[cAx]), ay: Number(f[cAy]), az: Number(f[cAz]),
      gx: Number(f[cGx]), gy: Number(f[cGy]), gz: Number(f[cGz]),
    };
    STEP[i] = f[cStep]; SEC[i] = f[cSec]; MOVE[i] = f[cMove]; CLK[i] = f[cClick];
  }

  const dts: number[] = [];
  for (let i = 1; i < Math.min(N, 20000); i++) dts.push(samples[i].t - samples[i - 1].t);
  dts.sort((a, b) => a - b);
  const fs = 1 / dts[Math.floor(dts.length / 2)];

  // a click window = a run of 'click' rows with the same section and move (one tap per window)
  const wins: Win[] = [];
  let open: { i0: number; i1: number; label: string } | null = null;
  const close = (): void => {
    if (!open) return;
    if (open.label !== 'L' && open.label !== 'R') throw new Error(`click window at row ${open.i0} has no L/R label`);
    wins.push({
      t0: samples[open.i0].t - 0.05,
      t1: samples[open.i1 - 1].t + 0.5,
      label: open.label,
    });
    open = null;
  };
  for (let i = 0; i < N; i++) {
    if (STEP[i] !== 'click') { close(); continue; }
    const newWin = !open || MOVE[i] !== MOVE[i - 1] || SEC[i] !== SEC[i - 1] || STEP[i - 1] !== 'click';
    if (newWin) { close(); open = { i0: i, i1: i + 1, label: CLK[i] }; } else open!.i1 = i + 1;
  }
  close();

  return { name: basename(path).replace(/\.csv$/, ''), fs, samples, wins };
}

// ---------- detection ----------
interface Matched { win: Win; ev: ClickEvent | null; extra: number }
interface TakeRun {
  take: Take;
  matched: Matched[];
  falseEvents: number;
  noise: { acc5: number; acc30: number; gyr5: number } | null;
  threshold: number;
}

function runTake(take: Take): TakeRun {
  const det = new ClickDetector({ sampleRateHz: take.fs, model: null });
  const events: ClickEvent[] = [];
  let noise: TakeRun['noise'] = null;
  let threshold = Infinity;
  for (const s of take.samples) {
    const e = det.step(s);
    if (e) events.push(e);
    if (!noise && !det.calibrating) { noise = det.noiseRms(); threshold = det.threshold(); }
  }
  const used = new Set<ClickEvent>();
  const matched: Matched[] = take.wins.map((win) => {
    const inWin = events.filter((e) => e.t >= win.t0 && e.t <= win.t1);
    inWin.forEach((e) => used.add(e));
    const ev = inWin.reduce<ClickEvent | null>((best, e) => (!best || e.peakG > best.peakG ? e : best), null);
    return { win, ev, extra: Math.max(0, inWin.length - 1) };
  });
  const falseEvents = events.filter((e) => !used.has(e)).length;
  return { take, matched, falseEvents, noise, threshold };
}

// ---------- statistics and classifier ----------
type Row = { take: number; label: number; x: Record<string, number> }; // label 1 = L, 0 = R
const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
const sd = (v: number[]): number => {
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
};
function sep(rows: Row[], f: string): number {
  const vL = rows.filter((r) => r.label === 1).map((r) => r.x[f]);
  const vR = rows.filter((r) => r.label === 0).map((r) => r.x[f]);
  const pooled = Math.sqrt((sd(vL) ** 2 + sd(vR) ** 2) / 2);
  return Math.abs(mean(vL) - mean(vR)) / Math.max(pooled, 1e-12);
}
function selectTop(rows: Row[], k: number): string[] {
  return [...FEATURE_NAMES]
    .map((f) => ({ f, s: sep(rows, f) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((o) => o.f);
}

interface Fit { features: string[]; mean: number[]; std: number[]; weights: number[]; bias: number }
function fitLogistic(rows: Row[], features: string[]): Fit {
  const mu = features.map((f) => mean(rows.map((r) => r.x[f])));
  const sg = features.map((f) => sd(rows.map((r) => r.x[f])) || 1);
  const Z = rows.map((r) => features.map((f, q) => (r.x[f] - mu[q]) / sg[q]));
  const y = rows.map((r) => r.label);
  const k = features.length, n = rows.length;
  const w = new Array(k).fill(0);
  let b = 0;
  const lr = 0.1, lam = 0.01;
  for (let it = 0; it < 5000; it++) {
    const gw = new Array(k).fill(0);
    let gb = 0;
    for (let s = 0; s < n; s++) {
      let a = b;
      for (let q = 0; q < k; q++) a += w[q] * Z[s][q];
      const e = 1 / (1 + Math.exp(-a)) - y[s];
      for (let q = 0; q < k; q++) gw[q] += e * Z[s][q];
      gb += e;
    }
    for (let q = 0; q < k; q++) w[q] -= lr * (gw[q] / n + lam * w[q]);
    b -= (lr * gb) / n;
  }
  return { features, mean: mu, std: sg, weights: w, bias: b };
}
function predictL(fit: Fit, x: Record<string, number>): boolean {
  let a = fit.bias;
  fit.features.forEach((f, q) => { a += fit.weights[q] * ((x[f] - fit.mean[q]) / fit.std[q]); });
  return a > 0;
}
interface Acc { n: number; correct: number; LL: number; LR: number; RL: number; RR: number }
function score(fit: Fit, rows: Row[]): Acc {
  const acc: Acc = { n: rows.length, correct: 0, LL: 0, LR: 0, RL: 0, RR: 0 };
  for (const r of rows) {
    const pL = predictL(fit, r.x);
    if (r.label === 1) { if (pL) acc.LL++; else acc.LR++; } else if (pL) acc.RL++; else acc.RR++;
    if (pL === (r.label === 1)) acc.correct++;
  }
  return acc;
}
const pct = (a: number, b: number): string => (b ? ((100 * a) / b).toFixed(1) : '—').padStart(5);
const confText = (a: Acc): string =>
  `[true L: ${a.LL} L, ${a.LR} R | true R: ${a.RL} L, ${a.RR} R]`;

// ---------- run ----------
const runs = FILES.map((f) => runTake(loadTake(f)));
const rowsOf = (run: TakeRun, t: number): Row[] => run.matched
  .filter((m) => m.ev)
  .map((m) => ({ take: t, label: m.win.label === 'L' ? 1 : 0, x: m.ev!.features }));

console.log('Streaming detector, per recording (labels from guide_click; no model needed for detection)');
runs.forEach((run, t) => {
  const tk = run.take;
  const nL = tk.wins.filter((w) => w.label === 'L').length;
  const detected = run.matched.filter((m) => m.ev);
  const dL = detected.filter((m) => m.win.label === 'L').length;
  const dR = detected.length - dL;
  const extra = run.matched.reduce((s, m) => s + m.extra, 0);
  console.log(`== ${tk.name} ==  ${tk.samples.length.toLocaleString()} samples at ${tk.fs.toFixed(0)} Hz, ${tk.wins.length} click windows (L ${nL}, R ${tk.wins.length - nL})`);
  if (run.noise) {
    console.log(`  noise floor (still hand): acc5 rms ${run.noise.acc5.toFixed(4)} g, acc30 rms ${run.noise.acc30.toFixed(4)} g, gyr5 rms ${run.noise.gyr5.toFixed(2)} deg/s; acc5 threshold ${run.threshold.toFixed(3)} g`);
  }
  console.log(`  detections: ${detected.length}/${tk.wins.length} click windows (L ${dL}/${nL}, R ${dR}/${tk.wins.length - nL})`);
  console.log(`  extra events inside click windows: ${extra}`);
  console.log(`  false events outside click windows (pauses, rests, tilt): ${run.falseEvents}`);
  console.log(`  match rate ${pct(detected.length, tk.wins.length)}%`);
});

// cross-take: fit on one take's detected taps, test on the other's (matched taps, and end to end)
console.log('');
console.log('Cross-take: train on one take (feature choice inside it), test on the other');
for (let a = 0; a < runs.length; a++) {
  for (let b = 0; b < runs.length; b++) {
    if (a === b) continue;
    const train = rowsOf(runs[a], a), test = rowsOf(runs[b], b);
    const feats = selectTop(train, TOP_K);
    const fit = fitLogistic(train, feats);
    const sc = score(fit, test);
    const windowsB = runs[b].matched.length;
    const e2e = sc.correct; // missed windows count as wrong
    console.log(`-- train ${runs[a].take.name.split('_')[1]} (${train.length} taps) -> test ${runs[b].take.name.split('_')[1]} (${test.length} taps)`);
    console.log(`   features: ${feats.join(', ')}`);
    console.log(`   matched taps: side accuracy ${pct(sc.correct, sc.n)}%  ${confText(sc)}`);
    console.log(`   end to end over all ${windowsB} click windows (missed = wrong): ${pct(e2e, windowsB)}%`);
  }
}

// final model: both takes, features chosen on both
const all = runs.flatMap((run, t) => rowsOf(run, t));
const finalFeats = selectTop(all, TOP_K);
const final = fitLogistic(all, finalFeats);
const fin = score(final, all);
console.log('');
console.log(`Final model on ${all.length} detected taps from ${runs.length} takes: ${finalFeats.join(', ')}`);
console.log(`  training accuracy ${pct(fin.correct, fin.n)}%  ${confText(fin)}`);
console.log(`  bias ${final.bias.toFixed(4)}; weights ${final.weights.map((w) => w.toFixed(4)).join(', ')}`);
console.log(`  standardisation mean ${final.mean.map((v) => v.toFixed(4)).join(', ')}; std ${final.std.map((v) => v.toFixed(4)).join(', ')}`);

// ---------- write algorithms/clicks/model.ts ----------
const num = (v: number): string => String(Number(v.toPrecision(7)));
const list = (xs: number[]): string => `[${xs.map(num).join(', ')}]`;
const model: ClickModel = {
  features: finalFeats,
  mean: final.mean,
  std: final.std,
  weights: final.weights,
  bias: final.bias,
  trainedOn: runs.map((r) => r.take.name),
};
const source = `// Generated by scripts/train-clicks.ts (npm run train:clicks). Do not edit by hand:
// change the recordings or the detector, then run the script again to regenerate this file.
import type { ClickModel } from './detector.ts';

/**
 * Logistic regression on ${model.features.length} raw features from the streaming detector.
 * P(L) = sigmoid(bias + sum_q weights[q] * (x[q] - mean[q]) / std[q]); L = index (left), R = pinky (right).
 */
export const CLICK_MODEL: ClickModel | null = {
  features: ${JSON.stringify(model.features)},
  mean: ${list(model.mean)},
  std: ${list(model.std)},
  weights: ${list(model.weights)},
  bias: ${num(model.bias)},
  trainedOn: ${JSON.stringify(model.trainedOn)},
};
`;
writeFileSync(MODEL_FILE, source);
console.log('');
console.log(`Wrote ${MODEL_FILE}`);
