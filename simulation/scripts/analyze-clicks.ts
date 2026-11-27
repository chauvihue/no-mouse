// Analyses left/right click takes. For each take: finds the tap in each click window with a rule-based
// detector, extracts per-tap features aligned on the tap peak, and reports noise floor, detection,
// pause false events and top L-vs-R features. Then tests cross-take generalisation: train on all taps
// of one take, test on all taps of the other (both directions), with raw amplitude features and with
// amplitude-normalised features.
// Run:  npm run analyze:clicks                              (default: clicks_take01 and clicks_take02)
//       npm run analyze:clicks -- file1.csv file2.csv ...   (explicit list)

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const DEFAULT_FILES = [
  `${DATA_DIR}clicks_take01_2026-11-27_13-58-32.csv`,
  `${DATA_DIR}clicks_take02_2026-11-27_14-05-43.csv`,
];
const cliFiles = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const FILES: string[] = cliFiles.length > 0 ? cliFiles : DEFAULT_FILES;

// ---------- filtering ----------
// 2nd-order Butterworth high-pass (RBJ), run forward and backward (zero phase).
function biquadHP(x: Float64Array, fc: number, fs: number): Float64Array {
  const w0 = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cw) / 2 / a0;
  const b1 = -(1 + cw) / a0;
  const b2 = b0;
  const a1 = (-2 * cw) / a0;
  const a2 = (1 - alpha) / a0;
  const pass = (src: Float64Array, rev: boolean): Float64Array => {
    const out = new Float64Array(src.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let k = 0; k < src.length; k++) {
      const i = rev ? src.length - 1 - k : k;
      const x0 = src[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y0;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return out;
  };
  return pass(pass(x, false), true);
}

function magOf(H: Record<string, Float64Array>, a: string, b: string, c: string, N: number): Float64Array {
  const m = new Float64Array(N);
  for (let i = 0; i < N; i++) m[i] = Math.hypot(H[a][i], H[b][i], H[c][i]);
  return m;
}

function rmsPeak(arr: Float64Array, idx: number[]): [number, number] {
  let s = 0, p = 0;
  for (const i of idx) { s += arr[i] * arr[i]; if (arr[i] > p) p = arr[i]; }
  return [Math.sqrt(s / idx.length), p];
}

// ---------- one take ----------
interface Win { i0: number; i1: number; section: string; move: string; label: string }
interface Take {
  name: string; N: number; FS: number;
  H5: Record<string, Float64Array>;
  ACC5: Float64Array; ACC30: Float64Array; GYR5: Float64Array;
  kind: Uint8Array; pauseIdx: number[]; stillIdx: number[];
  TH5: number; TH30: number; THG: number;
  wins: Win[];
}

function loadTake(path: string): Take {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const hdrAt = lines.findIndex((l) => l.length > 0 && !l.startsWith('#'));
  const header = lines[hdrAt].split(',');
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`column "${name}" missing in ${path}`);
    return i;
  };
  const cT = col('t');
  const cSig: Record<string, number> = { ax: col('ax'), ay: col('ay'), az: col('az'), gx: col('gx'), gy: col('gy'), gz: col('gz') };
  const cSec = col('guide_section');
  const cStep = col('guide_step');
  const cMove = col('guide_move');
  const cClick = col('guide_click');

  const rows = lines.slice(hdrAt + 1).filter((l) => l.length > 0);
  const N = rows.length;
  const T = new Float64Array(N);
  const SIG: Record<string, Float64Array> = {};
  for (const k of Object.keys(cSig)) SIG[k] = new Float64Array(N);
  const SEC: string[] = new Array(N), STEP: string[] = new Array(N), MOVE: string[] = new Array(N), CLK: string[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const f = rows[i].split(',');
    T[i] = Number(f[cT]);
    for (const k of Object.keys(cSig)) SIG[k][i] = Number(f[cSig[k]]);
    SEC[i] = f[cSec]; STEP[i] = f[cStep]; MOVE[i] = f[cMove]; CLK[i] = f[cClick];
  }

  const dts: number[] = [];
  for (let i = 1; i < Math.min(N, 20000); i++) dts.push(T[i] - T[i - 1]);
  dts.sort((a, b) => a - b);
  const FS = 1 / dts[Math.floor(dts.length / 2)];

  const H5: Record<string, Float64Array> = {};
  const H30: Record<string, Float64Array> = {};
  for (const k of Object.keys(SIG)) {
    H5[k] = biquadHP(SIG[k], 5, FS);
    H30[k] = biquadHP(SIG[k], 30, FS);
  }
  const ACC5 = magOf(H5, 'ax', 'ay', 'az', N);
  const ACC30 = magOf(H30, 'ax', 'ay', 'az', N);
  const GYR5 = magOf(H5, 'gx', 'gy', 'gz', N);

  // click windows: contiguous runs of guide_step === 'click' with the same section and move
  const wins: Win[] = [];
  for (let i = 0; i < N; i++) {
    if (STEP[i] !== 'click') continue;
    const newWin = i === 0 || STEP[i - 1] !== 'click' || MOVE[i] !== MOVE[i - 1] || SEC[i] !== SEC[i - 1];
    if (newWin) wins.push({ i0: i, i1: i + 1, section: SEC[i], move: MOVE[i], label: CLK[i] });
    else wins[wins.length - 1].i1 = i + 1;
  }

  // noise rows: pause/still, >0.7 s after any click, first/last 1 s excluded
  const kind = new Uint8Array(N);
  const pauseIdx: number[] = [], stillIdx: number[] = [];
  {
    let lastClick = -1e9;
    for (let i = 0; i < N; i++) {
      if (STEP[i] === 'click') { lastClick = i; continue; }
      if (i < 1000 || i >= N - 1000 || i - lastClick <= 700) continue;
      if (STEP[i] === 'pause') { kind[i] = 1; pauseIdx.push(i); }
      else if (STEP[i] === 'still') { kind[i] = 2; stillIdx.push(i); }
    }
  }
  const TH5 = 5 * rmsPeak(ACC5, pauseIdx)[0];
  const TH30 = 5 * rmsPeak(ACC30, pauseIdx)[0];
  const THG = 4 * rmsPeak(GYR5, pauseIdx)[0];

  const name = basename(path).replace(/\.csv$/, '');
  return { name, N, FS, H5, ACC5, ACC30, GYR5, kind, pauseIdx, stillIdx, TH5, TH30, THG, wins };
}

// ---------- detector ----------
// Candidate = local maximum of the 5 Hz-high-passed accel magnitude above 5x pause RMS.
// Rule stages (cumulative):
//   1 amp:   ACC5 >= 5x pause RMS
//   2 sharp: 30 Hz-high-passed accel >= 5x pause RMS within +/-20 ms (fast onset)
//   3 short: ACC5 stays above half its peak for <= 80 ms (no long ring)
//   4 gyro:  gyro (5 Hz) >= 4x pause RMS within +/-50 ms (matching rotation)
const STAGE_NAMES = ['1 amp (acc5 >= 5x rms)', '2 + sharp onset', '3 + short (<=80 ms)', '4 + gyro transient'];
const REFRACT_MS = 150;

function durHalfMs(tk: Take, p: number): number {
  const half = 0.5 * tk.ACC5[p];
  let l = p, r = p;
  while (l > 0 && tk.ACC5[l - 1] > half && p - l < 200) l--;
  while (r < tk.N - 1 && tk.ACC5[r + 1] > half && r - p < 200) r++;
  return ((r - l + 1) * 1000) / tk.FS;
}
function maxIn(arr: Float64Array, p: number, w: number, N: number): number {
  let m = 0;
  for (let j = Math.max(0, p - w); j <= Math.min(N - 1, p + w); j++) if (arr[j] > m) m = arr[j];
  return m;
}
function isLocalMax(arr: Float64Array, i: number, N: number): boolean {
  if (i < 3 || i > N - 4) return false;
  for (let j = i - 3; j <= i + 3; j++) if (j !== i && arr[j] > arr[i]) return false;
  return true;
}
function passesStage(tk: Take, p: number, stage: number): boolean {
  const w20 = Math.round(0.02 * tk.FS);
  if (tk.ACC5[p] < tk.TH5) return false;
  if (stage >= 2 && maxIn(tk.ACC30, p, w20, tk.N) < tk.TH30) return false;
  if (stage >= 3 && durHalfMs(tk, p) > 80) return false;
  if (stage >= 4 && maxIn(tk.GYR5, p, Math.round(0.05 * tk.FS), tk.N) < tk.THG) return false;  // +/-50 ms
  return true;
}
function pauseFalseEvents(tk: Take, stage: number): number {
  const refr = Math.round((REFRACT_MS / 1000) * tk.FS);
  let count = 0, last = -1e9;
  for (const i of tk.pauseIdx) {
    if (!isLocalMax(tk.ACC5, i, tk.N) || i - last <= refr) continue;
    if (passesStage(tk, i, stage)) { count++; last = i; }
  }
  return count;
}
// tap peak for a window: largest candidate passing the stage; fallback = argmax of ACC5 (flagged)
function detectWindow(tk: Take, w: Win, stage: number): { p: number; ok: boolean } {
  const r0 = w.i0, r1 = Math.min(tk.N - 1, w.i1 + Math.round(0.5 * tk.FS));
  let best = -1, bestV = -1;
  for (let i = r0; i <= r1; i++) {
    if (isLocalMax(tk.ACC5, i, tk.N) && tk.ACC5[i] > bestV && passesStage(tk, i, stage)) { best = i; bestV = tk.ACC5[i]; }
  }
  if (best >= 0) return { p: best, ok: true };
  let p = r0, v = -1;
  for (let i = r0; i <= r1; i++) if (tk.ACC5[i] > v) { v = tk.ACC5[i]; p = i; }
  return { p, ok: false };
}

// ---------- per-tap features (window +/-100 ms around the detected peak) ----------
function domFreq(x: Float64Array, s0: number, s1: number, fs: number): number {
  const n = s1 - s0 + 1;
  let m = 0;
  for (let j = 0; j < n; j++) m += x[s0 + j];
  m /= n;
  let best = 0, bestF = 0;
  for (let k = 1; k <= Math.floor(n / 2); k++) {
    let re = 0, im = 0;
    for (let j = 0; j < n; j++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (n - 1));
      const v = (x[s0 + j] - m) * w;
      const ang = (2 * Math.PI * k * j) / n;
      re += v * Math.cos(ang);
      im -= v * Math.sin(ang);
    }
    const pw = re * re + im * im;
    if (pw > best) { best = pw; bestF = (k * fs) / n; }
  }
  return bestF;
}

function featuresAt(tk: Take, p: number): Record<string, number> {
  const N = tk.N;
  const half = Math.round(0.1 * tk.FS);
  const s0 = Math.max(0, p - half), s1 = Math.min(N - 1, p + half);
  const f: Record<string, number> = {};
  for (const a of ['ax', 'ay', 'az', 'gx', 'gy', 'gz']) {
    const x = tk.H5[a];
    let mx = -Infinity, mn = Infinity, M = 0;
    for (let j = s0; j <= s1; j++) {
      const v = x[j];
      if (v > mx) mx = v;
      if (v < mn) mn = v;
      if (Math.abs(v) > M) M = Math.abs(v);
    }
    f[`p2p_${a}`] = mx - mn;
    if (a[0] === 'a') { f[`max_${a}`] = mx; f[`min_${a}`] = mn; }
    let sgn = 0;
    for (let j = s0; j <= s1; j++) if (Math.abs(x[j]) >= 0.5 * M) { sgn = Math.sign(x[j]); break; }
    f[`sgn_${a}`] = sgn;
  }
  let pa5 = 0, pa30 = 0, pg5 = 0, energy = 0;
  for (let j = s0; j <= s1; j++) {
    if (tk.ACC5[j] > pa5) pa5 = tk.ACC5[j];
    if (tk.ACC30[j] > pa30) pa30 = tk.ACC30[j];
    if (tk.GYR5[j] > pg5) pg5 = tk.GYR5[j];
    energy += tk.ACC5[j] * tk.ACC5[j];
  }
  const hh = 0.5 * tk.ACC5[p];
  let l = p, r = p;
  while (l > s0 && tk.ACC5[l - 1] > hh) l--;
  while (r < s1 && tk.ACC5[r + 1] > hh) r++;
  f.peak_acc5 = pa5;
  f.peak_acc30 = pa30;
  f.peak_gyr5 = pg5;
  f.dur_half_ms = ((r - l + 1) * 1000) / tk.FS;
  f.energy = energy / tk.FS;
  f.dom_freq_hz = domFreq(tk.ACC5, s0, s1, tk.FS);
  const pp = (a: string) => f[`p2p_${a}`];
  const ratio = (a: number, b: number) => a / (b + 1e-9);
  f.r_gx_gz = ratio(pp('gx'), pp('gz'));
  f.r_gy_gz = ratio(pp('gy'), pp('gz'));
  f.r_gx_gy = ratio(pp('gx'), pp('gy'));
  f.r_ay_az = ratio(pp('ay'), pp('az'));
  f.r_ax_az = ratio(pp('ax'), pp('az'));
  // amplitude-normalised: per-axis share of the peak-to-peak, gyro per accel
  const sA = pp('ax') + pp('ay') + pp('az');
  const sG = pp('gx') + pp('gy') + pp('gz');
  f.sh_ax = pp('ax') / sA; f.sh_ay = pp('ay') / sA; f.sh_az = pp('az') / sA;
  f.sh_gx = pp('gx') / sG; f.sh_gy = pp('gy') / sG; f.sh_gz = pp('gz') / sG;
  f.gyr_per_acc = pg5 / pa5;
  return f;
}

// scale-free features: these are the candidates for cross-take generalisation
const NORM_NAMES = new Set([
  'sh_ax', 'sh_ay', 'sh_az', 'sh_gx', 'sh_gy', 'sh_gz', 'gyr_per_acc',
  'r_gx_gz', 'r_gy_gz', 'r_gx_gy', 'r_ay_az', 'r_ax_az',
  'dur_half_ms', 'dom_freq_hz', 'sgn_ax', 'sgn_ay', 'sgn_az', 'sgn_gx', 'sgn_gy', 'sgn_gz',
]);

// ---------- statistics and classifiers ----------
const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
const sd = (v: number[]): number => {
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
};
function sepOf(vL: number[], vR: number[]): number {
  const pooled = Math.sqrt((sd(vL) ** 2 + sd(vR) ** 2) / 2);
  return Math.abs(mean(vL) - mean(vR)) / Math.max(pooled, 1e-12);
}
function aucOf(vL: number[], vR: number[]): number {
  let s = 0;
  for (const a of vL) for (const b of vR) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (vL.length * vR.length);
}

// dataset: rows are taps (all takes together), columns are FEATS; Y = 1 for L, 0 for R
let FEATS: string[] = [];
const X: number[][] = [];
const Y: number[] = [];

const colVals = (idx: number[], f: number, cls: 0 | 1): number[] => idx.filter((i) => Y[i] === cls).map((i) => X[i][f]);
const predThr = (x: number, thr: number, pol: 1 | -1): number => (pol * (x - thr) > 0 ? 1 : 0);

interface Thr { acc: number; thr: number; pol: 1 | -1 }
function bestThreshold(f: number, idx: number[]): Thr {
  const vals = [...new Set(idx.map((i) => X[i][f]))].sort((a, b) => a - b);
  const cands: number[] = [];
  for (let k = 0; k + 1 < vals.length; k++) cands.push((vals[k] + vals[k + 1]) / 2);
  if (cands.length === 0) cands.push(vals[0]);
  let best: Thr = { acc: -1, thr: cands[0], pol: 1 };
  const pols: (1 | -1)[] = [1, -1];
  for (const thr of cands) {
    for (const pol of pols) {
      let c = 0;
      for (const i of idx) if (predThr(X[i][f], thr, pol) === Y[i]) c++;
      const acc = c / idx.length;
      if (acc > best.acc) best = { acc, thr, pol };
    }
  }
  return best;
}
function bestSingle(idx: number[], feats: number[]): { f: number; thr: number; pol: 1 | -1; acc: number } {
  let out = { f: -1, thr: 0, pol: 1 as 1 | -1, acc: -1 };
  for (const f of feats) {
    const b = bestThreshold(f, idx);
    if (b.acc > out.acc) out = { f, thr: b.thr, pol: b.pol, acc: b.acc };
  }
  return out;
}
function topK(idx: number[], feats: number[], K: number): number[] {
  return feats
    .map((f) => ({ f, s: sepOf(colVals(idx, f, 1), colVals(idx, f, 0)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, K)
    .map((o) => o.f);
}
function standardizer(idx: number[], fs: number[]): (i: number) => number[] {
  const mu = fs.map((f) => mean(idx.map((i) => X[i][f])));
  const sg = fs.map((f) => sd(idx.map((i) => X[i][f])) || 1);
  return (i: number) => fs.map((f, k) => (X[i][f] - mu[k]) / sg[k]);
}
function centroidPredict(train: number[], test: number[], fs: number[]): number[] {
  const z = standardizer(train, fs);
  const sums: Record<number, number[]> = { 0: new Array(fs.length).fill(0), 1: new Array(fs.length).fill(0) };
  const cnt: Record<number, number> = { 0: 0, 1: 0 };
  for (const i of train) {
    const v = z(i);
    cnt[Y[i]]++;
    v.forEach((x, k) => (sums[Y[i]][k] += x));
  }
  const c1 = sums[1].map((s) => s / cnt[1]);
  const c0 = sums[0].map((s) => s / cnt[0]);
  const dist = (a: number[], b: number[]) => a.reduce((s, x, k) => s + (x - b[k]) ** 2, 0);
  return test.map((i) => {
    const v = z(i);
    return dist(v, c1) < dist(v, c0) ? 1 : 0;
  });
}
function logisticPredict(train: number[], test: number[], fs: number[]): number[] {
  const z = standardizer(train, fs);
  const Z = train.map((i) => z(i));
  const yy = train.map((i) => Y[i]);
  const k = fs.length, n = train.length;
  const w = new Array(k).fill(0);
  let b = 0;
  const lr = 0.1, lam = 0.01;
  for (let it = 0; it < 5000; it++) {
    const gw = new Array(k).fill(0);
    let gb = 0;
    for (let s = 0; s < n; s++) {
      let a = b;
      for (let q = 0; q < k; q++) a += w[q] * Z[s][q];
      const e = 1 / (1 + Math.exp(-a)) - yy[s];
      for (let q = 0; q < k; q++) gw[q] += e * Z[s][q];
      gb += e;
    }
    for (let q = 0; q < k; q++) w[q] -= lr * (gw[q] / n + lam * w[q]);
    b -= (lr * gb) / n;
  }
  return test.map((i) => {
    const v = z(i);
    let a = b;
    for (let q = 0; q < k; q++) a += w[q] * v[q];
    return a > 0 ? 1 : 0;
  });
}
// one line: accuracy plus confusion counts (true L -> L / R, true R -> L / R)
function confLine(idx: number[], pred: number[]): string {
  let LL = 0, LR = 0, RL = 0, RR = 0;
  idx.forEach((i, k) => {
    if (Y[i] === 1) { if (pred[k] === 1) LL++; else LR++; }
    else if (pred[k] === 1) RL++; else RR++;
  });
  const acc = (LL + RR) / idx.length;
  return `acc ${(acc * 100).toFixed(1).padStart(5)}%  [true L: ${LL} L, ${LR} R | true R: ${RL} L, ${RR} R]`;
}

// ---------- main ----------
const takes = FILES.map(loadTake);
const takeTaps: number[][] = takes.map(() => []);

takes.forEach((tk, t) => {
  console.log(`== ${tk.name} ==  (${tk.N} samples, ${tk.FS.toFixed(0)} Hz, ${tk.wins.length} click windows)`);
  const [a5r, a5p] = rmsPeak(tk.ACC5, tk.pauseIdx);
  const [a30r, a30p] = rmsPeak(tk.ACC30, tk.pauseIdx);
  const [g5r, g5p] = rmsPeak(tk.GYR5, tk.pauseIdx);
  const [sa5r, sa5p] = rmsPeak(tk.ACC5, tk.stillIdx);
  const [sg5r, sg5p] = rmsPeak(tk.GYR5, tk.stillIdx);
  console.log(`  noise, pause rows (n=${tk.pauseIdx.length}): acc >5 Hz rms ${a5r.toFixed(4)} g peak ${a5p.toFixed(3)}; acc >30 Hz rms ${a30r.toFixed(4)} peak ${a30p.toFixed(3)}; gyro >5 Hz rms ${g5r.toFixed(2)} peak ${g5p.toFixed(1)} deg/s`);
  console.log(`  noise, still rows (n=${tk.stillIdx.length}): acc >5 Hz rms ${sa5r.toFixed(4)} peak ${sa5p.toFixed(3)}; gyro >5 Hz rms ${sg5r.toFixed(2)} peak ${sg5p.toFixed(1)}`);
  console.log(`  thresholds: acc5 ${tk.TH5.toFixed(3)} g (5x pause rms), acc30 ${tk.TH30.toFixed(3)} g (5x), gyro5 ${tk.THG.toFixed(2)} deg/s (4x)`);
  console.log('  detector stage                         clicks detected   pause false events');
  for (let s = 1; s <= 4; s++) {
    const det = tk.wins.filter((w) => detectWindow(tk, w, s).ok).length;
    console.log(`    ${STAGE_NAMES[s - 1].padEnd(36)} ${String(det).padStart(3)}/${tk.wins.length}          ${String(pauseFalseEvents(tk, s)).padStart(4)}`);
  }
  // final taps use the full rule (stage 4); windows that fail it fall back to argmax of ACC5
  let fallbacks = 0;
  let nL = 0;
  for (const w of tk.wins) {
    if (w.label !== 'L' && w.label !== 'R') throw new Error(`click window at row ${w.i0} has no L/R label`);
    const d = detectWindow(tk, w, 4);
    if (!d.ok) fallbacks++;
    const f = featuresAt(tk, d.p);
    if (FEATS.length === 0) FEATS = Object.keys(f);
    takeTaps[t].push(X.length);
    X.push(FEATS.map((n) => f[n]));
    Y.push(w.label === 'L' ? 1 : 0);
    if (w.label === 'L') nL++;
  }
  console.log(`  final rule (stage 4): ${tk.wins.length - fallbacks}/${tk.wins.length} windows pass; ${fallbacks} used fallback; taps L ${nL}, R ${tk.wins.length - nL}`);
});

const RAW = FEATS.map((_, f) => f).filter((f) => !NORM_NAMES.has(FEATS[f]));
const NORM = FEATS.map((_, f) => f).filter((f) => NORM_NAMES.has(FEATS[f]));

// per-take top features (within-take separability and L/R means)
console.log('');
for (let t = 0; t < takes.length; t++) {
  const idx = takeTaps[t];
  const nL = idx.filter((i) => Y[i] === 1).length;
  const rows = FEATS.map((n, f) => {
    const vL = colVals(idx, f, 1), vR = colVals(idx, f, 0);
    return { n, mL: mean(vL), mR: mean(vR), sep: sepOf(vL, vR), auc: aucOf(vL, vR) };
  }).sort((a, b) => b.sep - a.sep).slice(0, 6);
  console.log(`== ${takes[t].name}: top features, L vs R (L ${nL}, R ${idx.length - nL}) ==`);
  console.log('  feature               L mean      R mean    sep   AUC(L>R)');
  for (const r of rows) {
    console.log(`  ${r.n.padEnd(18)} ${r.mL.toFixed(3).padStart(10)} ${r.mR.toFixed(3).padStart(10)}  ${r.sep.toFixed(2).padStart(6)}   ${r.auc.toFixed(2)}`);
  }
}

// stability across takes
console.log('');
console.log('Stability: L mean / R mean per take');
const stableNames = ['peak_acc5', 'peak_acc30', 'p2p_az', 'min_az', 'p2p_gz', 'r_gy_gz', 'sh_az', 'sh_gz', 'gyr_per_acc', 'dur_half_ms'];
for (const n of stableNames) {
  const f = FEATS.indexOf(n);
  const cells = takes.map((tk, t) => {
    const idx = takeTaps[t];
    return `${tk.name.split('_')[1]} ${mean(colVals(idx, f, 1)).toFixed(3)} / ${mean(colVals(idx, f, 0)).toFixed(3)}`;
  });
  console.log(`  ${n.padEnd(12)} ${cells.join('    ')}`);
}

// cross-take generalisation: train on one take's taps, test on the other's
console.log('');
console.log('Cross-take: train on all taps of one take, test on all taps of the other.');
for (let a = 0; a < takes.length; a++) {
  for (let b = 0; b < takes.length; b++) {
    if (a === b) continue;
    const train = takeTaps[a], test = takeTaps[b];
    console.log(`-- train ${takes[a].name.split('_')[1]} (${train.length}) -> test ${takes[b].name.split('_')[1]} (${test.length})`);
    for (const [setName, feats] of [['raw', RAW], ['norm', NORM]] as const) {
      const s = bestSingle(train, feats);
      const singlePred = test.map((i) => predThr(X[i][s.f], s.thr, s.pol));
      console.log(`  [${setName}] (a) single ${FEATS[s.f]} ${s.pol === 1 ? '>' : '<'} ${s.thr.toFixed(3)} (train ${(s.acc * 100).toFixed(0)}%)`);
      console.log(`      test ${confLine(test, singlePred)}`);
      const k3 = topK(train, feats, 3), k5 = topK(train, feats, 5);
      console.log(`  [${setName}] (b3) centroid ${k3.map((f) => FEATS[f]).join(', ')}`);
      console.log(`      test ${confLine(test, centroidPredict(train, test, k3))}`);
      console.log(`  [${setName}] (b5) centroid ${k5.map((f) => FEATS[f]).join(', ')}`);
      console.log(`      test ${confLine(test, centroidPredict(train, test, k5))}`);
      console.log(`  [${setName}] (c) logistic top5 (same as b5)`);
      console.log(`      test ${confLine(test, logisticPredict(train, test, k5))}`);
    }
  }
}
