// Trains the click models (tap-or-not gate and index-or-pinky classifier) and writes algorithms/clicks/model.ts.
//
// Run:  npm run train:clicks                              (every clicks*/panning* recording in ../data)
//       npm run train:clicks -- file1.csv file2.csv ...   (explicit list)
//       add --dry to print the numbers without rewriting model.ts
//
// Recordings (told apart by file name):
//   clicks_*.csv    guided "clicks v1": labelled taps (guide_click L/R); everything else is unlabelled.
//   clicks2_*.csv   guided "clicks v2": labelled firm and soft taps (section "soft...") plus labelled
//                   non-click motions (guide_step "neg": lift, slide, rotate, palm, thumb) and rests.
//   panning_*.csv   hand sliding on the desk with no clicks: all of it is negative.
//
// Taps and their features come from the streaming detector in algorithms/clicks/detector.ts, the
// class the live click tester runs, so training and live use identical code. The detector is first run
// without a model, which returns every candidate peak. A candidate inside a click window (window start
// - 50 ms .. end + 500 ms) is the tap if it is the largest there (the others are "extra"); candidates
// in a negative window or in a panning take are negatives; the rest (pauses of v1 takes) are
// unlabelled, since a late tap can land there, and are only reported.
//
// Then: tap gate = logistic regression tap vs negative (TAP_FEATURES), threshold at the TAP_QUANTILE
// of the training taps' scores; side = linear discriminant on (lpk, lhw). Evaluation is leave-one-group-
// out: each clicks recording is a group, panning recordings are spread over the groups; the models are
// fitted on the other groups and the real gated detector is run on the held-out one.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClickDetector } from '../../algorithms/clicks/detector.ts';
import type { ClickEvent, ClickModel, ImuReading, Side } from '../../algorithms/clicks/detector.ts';

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const MODEL_FILE = fileURLToPath(new URL('../../algorithms/clicks/model.ts', import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const cliFiles = args.filter((a) => !a.startsWith('-'));

const tapArg = args.find((a) => a.startsWith('--tap='));
const TAP_FEATURES = tapArg ? tapArg.slice(6).split(',') : ['lratio', 'lhw', 'lpost150', 'prelf1s', 'lpre1s', 'lpk'];
const sideArg = args.find((a) => a.startsWith('--side='));
const skipArg = args.find((a) => a.startsWith('--skip-neg='));
const SKIP_NEG = new Set(skipArg ? skipArg.slice(11).split(',') : []);   // v2 non-click sections left out of training
const SIDE_FEATURES = sideArg ? sideArg.slice(7).split(',') : ['lpk', 'lfshare'];
const qArg = args.find((a) => a.startsWith('--q='));
const TAP_QUANTILE = qArg ? Number(qArg.slice(4)) : 0.06;   // share of the training taps the gate may refuse
const NEG_WEIGHT_CAP = 10;   // positive-class weight in the logistic fit is min(this, #neg / #pos)

// ---------- recordings ----------
type Kind = 'clicks' | 'clicks2' | 'panning';
interface Win { t0: number; t1: number; label: Side | ''; section: string; ord: number }
interface Rec { name: string; kind: Kind; fs: number; samples: ImuReading[]; clicks: Win[]; negs: Win[]; minutes: number }

function kindOf(path: string): Kind {
  const b = basename(path);
  return b.startsWith('panning') ? 'panning' : b.startsWith('clicks2') ? 'clicks2' : 'clicks';
}

function defaultFiles(): string[] {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((f) => /^(clicks2?|panning)_take.*\.csv$/.test(f) && !f.includes('_aborted'))
    .sort()
    .map((f) => DATA_DIR + f);
}

function loadRec(path: string): Rec {
  const kind = kindOf(path);
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

  // a window = a run of rows of the wanted step with the same section and move index
  const runs = (wanted: (i: number) => boolean, label: (i: number) => string, tail: number): Win[] => {
    const out: Win[] = [];
    let open: { i0: number; i1: number } | null = null;
    const close = (): void => {
      if (!open) return;
      out.push({
        t0: samples[open.i0].t - 0.05, t1: samples[open.i1 - 1].t + tail,
        label: label(open.i0) as Side | '', section: SEC[open.i0], ord: -1,
      });
      open = null;
    };
    for (let i = 0; i < N; i++) {
      if (!wanted(i)) { close(); continue; }
      const same = open && MOVE[i] === MOVE[i - 1] && SEC[i] === SEC[i - 1] && wanted(i - 1);
      if (same) open!.i1 = i + 1; else { close(); open = { i0: i, i1: i + 1 }; }
    }
    close();
    return out;
  };
  const clicks = kind === 'panning' ? [] : runs((i) => STEP[i] === 'click', (i) => CLK[i], 0.5);
  for (const w of clicks) if (w.label !== 'L' && w.label !== 'R') throw new Error(`click window at ${w.t0} in ${path} has no L/R label`);
  const negs = kind === 'clicks2'
    ? runs((i) => STEP[i] === 'neg' || (STEP[i] === 'still' && SEC[i] === 'rest'), () => '', 1.0)
    : [];
  [...clicks, ...negs].sort((a, b) => a.t0 - b.t0).forEach((w, k) => { w.ord = k; });   // window order, for the even/odd split
  return { name: basename(path).replace(/\.csv$/, ''), kind, fs, samples, clicks, negs, minutes: N / fs / 60 };
}

// ---------- candidates ----------
type Cls = 'tap' | 'extra' | 'neg' | 'unl';
interface Cand { ev: ClickEvent; cls: Cls; label: Side | ''; soft: boolean; section: string; ord: number }

function candidatesOf(rec: Rec): Cand[] {
  const det = new ClickDetector({ sampleRateHz: rec.fs, model: null });
  const evs: ClickEvent[] = [];
  for (const s of rec.samples) { const e = det.step(s); if (e) evs.push(e); }
  const out: Cand[] = evs.map((ev) => ({ ev, cls: rec.kind === 'panning' ? 'neg' : 'unl', label: '', soft: false, section: '', ord: -1 }));
  for (const w of rec.negs) for (const c of out) if (c.ev.t >= w.t0 && c.ev.t <= w.t1) { c.cls = 'neg'; c.section = w.section; c.ord = w.ord; }
  for (const w of rec.clicks) {
    const inWin = out.filter((c) => c.ev.t >= w.t0 && c.ev.t <= w.t1);
    let best: Cand | null = null;
    for (const c of inWin) { c.cls = 'extra'; if (!best || c.ev.peakG > best.ev.peakG) best = c; }
    if (best) { best.cls = 'tap'; best.label = w.label; best.soft = w.section.startsWith('soft'); best.section = w.section; best.ord = w.ord; }
  }
  return out;
}

// ---------- fitting ----------
const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
const sd = (v: number[]): number => {
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
};
const quantile = (v: number[], q: number): number => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(q * s.length)))];
};

function fitTap(taps: Cand[], negs: Cand[]): ClickModel['tap'] {
  const feats = TAP_FEATURES;
  const rows = [...taps, ...negs];
  const y = rows.map((c) => (c.cls === 'tap' ? 1 : 0));
  const wpos = Math.min(NEG_WEIGHT_CAP, negs.length / Math.max(1, taps.length));
  const sw = y.map((v) => (v ? wpos : 1));
  const mu = feats.map((f) => mean(rows.map((r) => r.ev.features[f])));
  const sg = feats.map((f) => sd(rows.map((r) => r.ev.features[f])) || 1);
  const Z = rows.map((r) => feats.map((f, q) => (r.ev.features[f] - mu[q]) / sg[q]));
  const k = feats.length;
  const w = new Array<number>(k).fill(0);
  let b = 0;
  const sws = sw.reduce((s, x) => s + x, 0);
  const lr = 0.3, lam = 0.05;
  for (let it = 0; it < 2500; it++) {
    const gw = new Array<number>(k).fill(0);
    let gb = 0;
    for (let s = 0; s < Z.length; s++) {
      let a = b;
      for (let q = 0; q < k; q++) a += w[q] * Z[s][q];
      const e = (1 / (1 + Math.exp(-a)) - y[s]) * sw[s];
      for (let q = 0; q < k; q++) gw[q] += e * Z[s][q];
      gb += e;
    }
    for (let q = 0; q < k; q++) w[q] -= lr * (gw[q] / sws + lam * w[q]);
    b -= (lr * gb) / sws;
  }
  const scoreOf = (c: Cand): number => b + feats.reduce((a, f, q) => a + w[q] * ((c.ev.features[f] - mu[q]) / sg[q]), 0);
  const threshold = quantile(taps.map(scoreOf), TAP_QUANTILE);
  return { features: feats, mean: mu, std: sg, weights: w, bias: b, threshold };
}

function fitSide(taps: Cand[]): ClickModel['side'] {
  const feats = SIDE_FEATURES, k = feats.length;
  const L = taps.filter((c) => c.label === 'L'), R = taps.filter((c) => c.label === 'R');
  const muL = feats.map((f) => mean(L.map((c) => c.ev.features[f])));
  const muR = feats.map((f) => mean(R.map((c) => c.ev.features[f])));
  const cov = new Array<number>(k * k).fill(0);
  for (const [grp, mu] of [[L, muL], [R, muR]] as const) {
    for (const c of grp) {
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
        cov[a * k + b] += (c.ev.features[feats[a]] - mu[a]) * (c.ev.features[feats[b]] - mu[b]);
      }
    }
  }
  const dof = Math.max(1, L.length + R.length - 2);
  for (let q = 0; q < cov.length; q++) cov[q] /= dof;
  return { features: feats, muL, muR, cov };
}

function fitModel(cands: Cand[], trainedOn: string[]): ClickModel {
  const taps = cands.filter((c) => c.cls === 'tap');
  const negs = cands.filter((c) => c.cls === 'neg' && !SKIP_NEG.has(c.section));
  return { tap: fitTap(taps, negs), side: fitSide(taps), trainedOn };
}

// ---------- evaluation with the real gated detector ----------
/** Scales the 20 Hz+ part of every channel by `k` (zero-phase high-pass), to imitate a softer tap. */
function scaleTapBand(samples: ImuReading[], fs: number, k: number): ImuReading[] {
  if (k === 1) return samples;
  const w0 = (2 * Math.PI * 20) / fs, cw = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + al;
  const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, a1 = (-2 * cw) / a0, a2 = (1 - al) / a0;
  const hpass = (x: Float64Array): Float64Array => {
    const run = (src: Float64Array, rev: boolean): Float64Array => {
      const out = new Float64Array(src.length);
      let x1 = src[rev ? src.length - 1 : 0], x2 = x1, y1 = 0, y2 = 0;
      for (let q = 0; q < src.length; q++) {
        const i = rev ? src.length - 1 - q : q;
        const y = b0 * src[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
        out[i] = y; x2 = x1; x1 = src[i]; y2 = y1; y1 = y;
      }
      return out;
    };
    return run(run(x, false), true);
  };
  const keys = ['ax', 'ay', 'az', 'gx', 'gy', 'gz'] as const;
  const out: ImuReading[] = samples.map((s) => ({ ...s }));
  for (const key of keys) {
    const x = Float64Array.from(samples, (s) => s[key]);
    const h = hpass(x);
    for (let i = 0; i < out.length; i++) out[i][key] = x[i] - (1 - k) * h[i];
  }
  return out;
}

interface Tally {
  windows: number; detected: number; sideOk: number; sideOkL: number; detL: number; sideOkR: number; detR: number;
  softWindows: number; softDetected: number; softSideOk: number;
  extras: number; pauseEvents: number; pauseMin: number; negEvents: number; negWindows: number;
  panEvents: number; panMin: number;
  negBy: Record<string, { w: number; ev: number }>;
}
const newTally = (): Tally => ({
  windows: 0, detected: 0, sideOk: 0, sideOkL: 0, detL: 0, sideOkR: 0, detR: 0,
  softWindows: 0, softDetected: 0, softSideOk: 0,
  extras: 0, pauseEvents: 0, pauseMin: 0, negEvents: 0, negWindows: 0, panEvents: 0, panMin: 0, negBy: {},
});

function evaluate(model: ClickModel, recs: Rec[], sens: number, softScale: number, into: Tally, parity = -1): void {
  const mine = (w: Win): boolean => parity < 0 || w.ord % 2 === parity;
  for (const rec of recs) {
    const samples = rec.kind === 'panning' ? rec.samples : scaleTapBand(rec.samples, rec.fs, softScale);
    const det = new ClickDetector({ sampleRateHz: rec.fs, model, sensitivity: sens });
    const evs: ClickEvent[] = [];
    for (const s of samples) { const e = det.step(s); if (e) evs.push(e); }
    if (rec.kind === 'panning') { into.panEvents += evs.length; into.panMin += rec.minutes; continue; }
    const used = new Set<ClickEvent>();
    for (const w of rec.clicks) {
      if (!mine(w)) continue;
      const inWin = evs.filter((e) => e.t >= w.t0 && e.t <= w.t1);
      inWin.forEach((e) => used.add(e));
      const best = inWin.reduce<ClickEvent | null>((b, e) => (!b || e.peakG > b.peakG ? e : b), null);
      const soft = w.section.startsWith('soft');
      into.windows++;
      if (soft) into.softWindows++;
      if (best) {
        into.detected++;
        if (soft) into.softDetected++;
        const ok = best.side === w.label;
        if (ok) { into.sideOk++; if (soft) into.softSideOk++; }
        if (w.label === 'L') { into.detL++; if (ok) into.sideOkL++; } else { into.detR++; if (ok) into.sideOkR++; }
        into.extras += inWin.length - 1;
      }
    }
    for (const w of rec.negs) {
      if (!mine(w)) continue;
      into.negWindows++;
      const nb = (into.negBy[w.section] ??= { w: 0, ev: 0 });
      nb.w++;
      for (const e of evs) if (e.t >= w.t0 && e.t <= w.t1) { into.negEvents++; nb.ev++; used.add(e); }
    }
    if (parity < 0) { into.pauseEvents += evs.filter((e) => !used.has(e)).length; into.pauseMin += rec.minutes; }
  }
}

const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : '-').padStart(6);
const per = (a: number, b: number): string => (b ? (a / b).toFixed(1) : '-').padStart(5);

function report(label: string, t: Tally): void {
  const parts = [
    `detected ${t.detected}/${t.windows} (${pct(t.detected, t.windows).trim()})`,
    `side ${pct(t.sideOk, t.detected).trim()} (L ${pct(t.sideOkL, t.detL).trim()}, R ${pct(t.sideOkR, t.detR).trim()})`,
  ];
  if (t.softWindows) parts.push(`soft: det ${pct(t.softDetected, t.softWindows).trim()} side ${pct(t.softSideOk, t.softDetected).trim()}`);
  parts.push(`extra in windows ${t.extras}`);
  parts.push(`pause/rest events ${per(t.pauseEvents, t.pauseMin).trim()}/min`);
  if (t.negWindows) parts.push(`${t.negEvents} events in ${t.negWindows} non-click windows`);
  if (t.negWindows) parts.push(`by motion: ${Object.entries(t.negBy).map(([k, v]) => `${k} ${v.ev}/${v.w}`).join(' ')}`);
  parts.push(`panning ${per(t.panEvents, t.panMin).trim()}/min (${t.panEvents} in ${t.panMin.toFixed(1)} min)`);
  console.log(`  ${label.padEnd(26)} ${parts.join(' | ')}`);
}

// ---------- run ----------
const FILES = cliFiles.length > 0 ? cliFiles : defaultFiles();
if (FILES.length === 0) throw new Error(`no recordings found in ${DATA_DIR}`);
const recs = FILES.map(loadRec);
const cands = recs.map(candidatesOf);

console.log('Recordings');
recs.forEach((rec, i) => {
  const c = cands[i];
  const nT = c.filter((x) => x.cls === 'tap').length;
  const soft = c.filter((x) => x.cls === 'tap' && x.soft).length;
  console.log(`  ${rec.name.padEnd(40)} ${rec.kind.padEnd(7)} ${rec.minutes.toFixed(1)} min  windows ${rec.clicks.length} (taps found ${nT}, soft ${soft}), non-click windows ${rec.negs.length}, candidates ${c.length} (neg ${c.filter((x) => x.cls === 'neg').length}, unlabelled ${c.filter((x) => x.cls === 'unl').length}, extra ${c.filter((x) => x.cls === 'extra').length})`);
});
// Groups for leave-one-group-out: every clicks recording is a group; a clicks v2 recording is split into
// two groups by the order of its windows (even / odd), because one session is all there is. The even/odd
// split shares the session (same hand position and mood), so it is more optimistic than a new take.
interface Group { recs: number[]; parity: number }
const groups: Group[] = [];
recs.forEach((r, i) => {
  if (r.kind === 'clicks2') { groups.push({ recs: [i], parity: 0 }, { recs: [i], parity: 1 }); }
  else if (r.kind === 'clicks') groups.push({ recs: [i], parity: -1 });
});
if (groups.length === 0) throw new Error('need at least one clicks recording');
const panIdx = recs.map((r, i) => (r.kind === 'panning' ? i : -1)).filter((i) => i >= 0);
panIdx.forEach((i, k) => groups[k % groups.length].recs.push(i));
const G = groups.length;
const groupName = (g: Group): string => g.recs.filter((i) => recs[i].kind !== 'panning').map((i) => recs[i].name.split('_')[0] + recs[i].name.split('_')[1].replace('take', '') + (g.parity >= 0 ? (g.parity ? ' odd' : ' even') : '')).join(',');

console.log('');
console.log(G > 1 ? 'Leave-one-group-out (fit on the other groups, run the gated detector on the held-out one)' : 'Only one clicks recording: no cross-validation, training-set numbers only');
const cv: Record<string, Tally> = {
  'sens 1': newTally(), 'sens 0.75': newTally(), 'sens 1.5': newTally(),
  'tap x0.5 (soft), sens 1': newTally(), 'tap x0.5, sens 1.5': newTally(),
};
if (G > 1) {
  for (let g = 0; g < G; g++) {
    const grp = groups[g];
    const trainC = cands.flatMap((c, i) => {
      if (!grp.recs.includes(i)) return c;
      if (grp.parity < 0 || recs[i].kind === 'panning') return [];
      return c.filter((x) => x.ord >= 0 && x.ord % 2 !== grp.parity);   // the other half of the same v2 recording
    });
    const test = grp.recs.map((i) => recs[i]);
    const model = fitModel(trainC, []);
    evaluate(model, test, 1, 1, cv['sens 1'], grp.parity);
    evaluate(model, test, 0.75, 1, cv['sens 0.75'], grp.parity);
    evaluate(model, test, 1.5, 1, cv['sens 1.5'], grp.parity);
    evaluate(model, test, 1, 0.5, cv['tap x0.5 (soft), sens 1'], grp.parity);
    evaluate(model, test, 1.5, 0.5, cv['tap x0.5, sens 1.5'], grp.parity);
    const one = newTally();
    evaluate(model, test, 1, 1, one, grp.parity);
    report(`fold ${g + 1} (${groupName(grp)})`, one);
  }
  console.log('  all folds:');
  for (const [k, t] of Object.entries(cv)) report(k, t);
}

const finalModel = fitModel(cands.flat(), recs.map((r) => r.name));
const train = newTally();
evaluate(finalModel, recs, 1, 1, train);
console.log('');
console.log('Final model on all recordings (training-set numbers, optimistic)');
report('sens 1', train);
const tapsAll = cands.flat().filter((c) => c.cls === 'tap');
const L = tapsAll.filter((c) => c.label === 'L'), R = tapsAll.filter((c) => c.label === 'R');
const gm = (c: Cand[], f: string): number => mean(c.map((x) => x.ev.features[f]));
console.log(`  taps: ${L.length} L, ${R.length} R; mean peak L ${Math.exp(gm(L, 'lpk')).toFixed(2)} g, R ${Math.exp(gm(R, 'lpk')).toFixed(2)} g; mean half-width L ${Math.exp(gm(L, 'lhw')).toFixed(1)} ms, R ${Math.exp(gm(R, 'lhw')).toFixed(1)} ms`);
console.log(`  tap gate: ${finalModel.tap.features.map((f, q) => `${f} ${finalModel.tap.weights[q].toFixed(2)}`).join(', ')}; bias ${finalModel.tap.bias.toFixed(2)}, threshold ${finalModel.tap.threshold.toFixed(2)}`);

// ---------- write algorithms/clicks/model.ts ----------
if (DRY) {
  console.log('\n--dry: model.ts not rewritten');
} else {
  const num = (v: number): string => String(Number(v.toPrecision(7)));
  const list = (xs: number[]): string => `[${xs.map(num).join(', ')}]`;
  const t = finalModel.tap, s = finalModel.side;
  const source = `// Generated by scripts/train-clicks.ts (npm run train:clicks). Do not edit by hand:
// change the recordings or the detector, then run the script again to regenerate this file.
import type { ClickModel } from './detector.ts';

/**
 * tap:  logistic regression (tap vs not a tap) on ${t.features.length} features of a candidate peak; a tap when score >= threshold.
 * side: linear discriminant on ${s.features.join(' and ')}; L = index (left click), R = pinky (right click).
 */
export const CLICK_MODEL: ClickModel | null = {
  tap: {
    features: ${JSON.stringify(t.features)},
    mean: ${list(t.mean)},
    std: ${list(t.std)},
    weights: ${list(t.weights)},
    bias: ${num(t.bias)},
    threshold: ${num(t.threshold)},
  },
  side: {
    features: ${JSON.stringify(s.features)},
    muL: ${list(s.muL)},
    muR: ${list(s.muR)},
    cov: ${list(s.cov)},
  },
  trainedOn: ${JSON.stringify(finalModel.trainedOn)},
};
`;
  writeFileSync(MODEL_FILE, source);
  console.log(`\nWrote ${MODEL_FILE}`);
}
