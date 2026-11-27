// Scores the pipeline on the panning protocol: 10 cm moves between two paper marks, labelled in the CSV.
// Run:  npm run bench:pan                                   (take01 = training take)
//       npm run bench:pan -- --file take02                  (take02 = test take, report separately)
//       npm run bench:pan -- --file both
//       npm run bench:pan -- '{"motionModel":"segment"}'    (extra config merged over APP_PIPELINE_CONFIG)
//       npm run bench:pan -- --grid                         (fusion x motion x slide baseline table)
//       npm run bench:pan -- --json                         (per-section numbers and score as JSON)
//
// A move's displacement = estimated hand position at the end of the pause after the move
//   minus the position at the end of the step before the move (the pause or rest before it).
// The displacement is projected on the main movement axis A (PCA of all take01 move displacements,
// computed once with APP_PIPELINE_CONFIG and then fixed; the sign is set so dir +1 is positive).
// For each move, s = dir × (projection on A), in cm: positive means the hand went the instructed way.
// "correct" = s > 0. "side" = |off-axis component|, cm.
// The tilt section (true displacement 0): drift = distance between its end and the step before it.
//
// SCORE (lower is better) = mean over quick/normal/slow/very-slow of ( |mean s − 10| + std s )
//                         + tilt drift / 2
//                         + 5 × Σ over those 4 sections of (wrong-sign fraction)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_PIPELINE_CONFIG } from '../../algorithms/config.ts';
import type { PipelineConfig } from '../../algorithms/config.ts';
import { Pipeline } from '../../algorithms/pipeline.ts';
import type { ImuSample } from '../../algorithms/pipeline.ts';

declare const process: { argv: string[]; exitCode?: number };

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const FILES: Record<string, string> = {
  take01: 'panning_take01_2026-11-27_13-52-33.csv', // train: tune only on this one
  take02: 'panning_take02_2026-11-27_13-55-28.csv', // test
};
const SPEED = ['quick', 'normal', 'slow', 'very-slow'];
const TRUE_CM = 10;

interface Block { section: string; step: string; move: number; dir: number; i0: number; i1: number }
interface Loaded { samples: ImuSample[]; blocks: Block[] }
interface MoveRec { section: string; move: number; dir: number; dx: number; dy: number }
interface SecStat { section: string; n: number; mean: number; std: number; correct: number; side: number }
interface Eval { label: string; secs: SecStat[]; tiltCm: number; speedTerm: number; tiltTerm: number; signTerm: number; score: number; wrongTotal: number; meanCorrect: number }

/** Parses one take: samples plus runs of identical label values (section, step, move, dir). */
function load(path: string): Loaded {
  const lines = readFileSync(path, 'utf8').split('\n');
  const hdr = lines.find(l => l.startsWith('t,'))!.split(',').map(h => h.trim());
  const col = (n: string) => { const i = hdr.indexOf(n); if (i < 0) throw new Error(`${path}: no column ${n}`); return i; };
  const C = {
    t: col('t'), ax: col('ax'), ay: col('ay'), az: col('az'), gx: col('gx'), gy: col('gy'), gz: col('gz'),
    sec: col('guide_section'), step: col('guide_step'), move: col('guide_move'), dir: col('guide_dir'),
  };
  const samples: ImuSample[] = [], blocks: Block[] = [];
  let cur: Block | null = null, key = '';
  for (const l of lines) {
    if (!l || l.startsWith('#') || l.startsWith('t,')) continue;
    const c = l.split(',');
    const idx = samples.length;
    samples.push({ t: +c[C.t], ax: +c[C.ax], ay: +c[C.ay], az: +c[C.az], gx: +c[C.gx], gy: +c[C.gy], gz: +c[C.gz] });
    const k = `${c[C.sec]}|${c[C.step]}|${c[C.move]}|${c[C.dir]}`;
    if (!cur || k !== key) {
      cur = { section: c[C.sec], step: c[C.step], move: +c[C.move] || 0, dir: +c[C.dir] || 0, i0: idx, i1: idx };
      blocks.push(cur); key = k;
    }
    cur.i1 = idx;
  }
  return { samples, blocks };
}

/**
 * Replays a take; returns the estimated hand position in cm per sample.
 * Calibration uses the take's own first calibrationMs of samples (the hand is still there, as in the app).
 * Repeating a 300-sample block instead (as bench-moves.ts does) puts a seam every 300 samples: fake
 * vibration, which pushes the sliding threshold to ~86 mg. Those samples get position 0; no move uses them.
 */
function replay(samples: ImuSample[], cfg: PipelineConfig): { px: Float64Array; py: Float64Array } {
  const p = new Pipeline({ ...cfg, screenW: 1e6, screenH: 1e6 });
  p.reset(5e5, 5e5);
  const t0 = samples[0].t, n = samples.length;
  const nCal = Math.max(1, Math.round(((cfg.calibrationMs + (cfg.enableCalibration ? cfg.calibSkipMs : 0)) * cfg.sampleRateHz) / 1000));
  const px = new Float64Array(n), py = new Float64Array(n);
  samples.forEach((s, i) => {
    const o = p.step({ ...s, t: s.t - t0 });
    if (i >= nCal) { px[i] = o.pos[0] * 100; py[i] = o.pos[1] * 100; }
  });
  return { px, py };
}

/** Move displacements (cm) and the tilt drift (cm) of one take. */
function displacements(L: Loaded, px: Float64Array, py: Float64Array): { moves: MoveRec[]; tiltCm: number } {
  const moves: MoveRec[] = [];
  let tiltCm = NaN;
  L.blocks.forEach((b, k) => {
    const ref = L.blocks[k - 1];
    if (!ref) return;
    if (b.step === 'move') {
      const end = L.blocks[k + 1];
      if (!end) return;
      moves.push({ section: b.section, move: b.move, dir: b.dir, dx: (px[end.i1] - px[ref.i1]), dy: (py[end.i1] - py[ref.i1]) });
    } else if (b.step === 'tilt') {
      tiltCm = Math.hypot(px[b.i1] - px[ref.i1], py[b.i1] - py[ref.i1]);
    }
  });
  return { moves, tiltCm };
}

/** Main movement axis: centred PCA of the displacement vectors, sign so that dir +1 is positive. */
function fitAxis(moves: MoveRec[]): { ax: number; ay: number; deg: number } {
  const mx = moves.reduce((a, m) => a + m.dx, 0) / moves.length, my = moves.reduce((a, m) => a + m.dy, 0) / moves.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const m of moves) { const x = m.dx - mx, y = m.dy - my; sxx += x * x; syy += y * y; sxy += x * y; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ax = Math.cos(th), ay = Math.sin(th);
  let s = 0;
  for (const m of moves) s += m.dir * (m.dx * ax + m.dy * ay);
  if (s < 0) { ax = -ax; ay = -ay; }
  return { ax, ay, deg: (th * 180) / Math.PI };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const std = (xs: number[]) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };

function evaluate(label: string, moves: MoveRec[], tiltCm: number, axis: { ax: number; ay: number }): Eval {
  const secs: SecStat[] = SPEED.map(name => {
    const mv = moves.filter(m => m.section === name);
    const s = mv.map(m => m.dir * (m.dx * axis.ax + m.dy * axis.ay));
    const side = mv.map(m => Math.abs(-m.dx * axis.ay + m.dy * axis.ax));
    const correct = mv.length ? (100 * s.filter(v => v > 0).length) / mv.length : 0;
    return { section: name, n: mv.length, mean: mv.length ? mean(s) : 0, std: mv.length > 1 ? std(s) : 0, correct, side: mv.length ? mean(side) : 0 };
  });
  // a missing section counts as 0 cm, all wrong
  const speedTerm = mean(secs.map(s => Math.abs(s.mean - TRUE_CM) + s.std));
  const wrongTotal = secs.reduce((a, s) => a + (100 - s.correct) / 100, 0);
  const tiltTerm = (Number.isFinite(tiltCm) ? tiltCm : TRUE_CM) / 2;
  const signTerm = 5 * wrongTotal;
  const meanCorrect = mean(secs.map(s => s.correct));
  return { label, secs, tiltCm, speedTerm, tiltTerm, signTerm, score: speedTerm + tiltTerm + signTerm, wrongTotal, meanCorrect };
}

/** Loads one take, replays it with cfg, and evaluates against the fixed axis. */
const loaded = new Map<string, Loaded>();
function runTake(file: string, cfg: PipelineConfig, axis: { ax: number; ay: number }, label: string): Eval {
  if (!loaded.has(file)) loaded.set(file, load(DATA_DIR + FILES[file]));
  const L = loaded.get(file)!;
  const { px, py } = replay(L.samples, cfg);
  const { moves, tiltCm } = displacements(L, px, py);
  return evaluate(label, moves, tiltCm, axis);
}

const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pm = (s: SecStat) => `${f(s.mean)} ± ${f(s.std)}`;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const grid = args.includes('--grid');
const fi = args.indexOf('--file');
const fileSel = fi >= 0 ? args[fi + 1] : 'take01';
const files = fileSel === 'both' ? ['take01', 'take02'] : [fileSel];
const extra: Partial<PipelineConfig> = JSON.parse(args.find(a => a.startsWith('{')) ?? '{}');
for (const f0 of files) if (!FILES[f0]) throw new Error(`--file must be take01, take02 or both (got ${f0})`);

// The axis: fixed once from take01 with the app config (no overrides), the same for every run.
const L1 = load(DATA_DIR + FILES.take01);
const r1 = replay(L1.samples, APP_PIPELINE_CONFIG);
const AXIS = fitAxis(displacements(L1, r1.px, r1.py).moves);
const axis = { ax: AXIS.ax, ay: AXIS.ay };

if (grid) {
  const rows: [string, Partial<PipelineConfig>][] = [];
  for (const fusionMode of ['madgwick', 'accel-kalman', 'accel-complementary'] as const)
    for (const motionModel of ['integrate', 'stroke', 'segment'] as const)
      for (const slide of [true, false])
        rows.push([`${fusionMode}+${motionModel}${slide ? '+slide' : ''}`, { fusionMode, motionModel, enableSlideDetect: slide }]);
  const out: Record<string, unknown> = {};
  for (const fi0 of files) {
    const table = rows.map(([label, cfg]) => {
      const e = runTake(fi0, { ...APP_PIPELINE_CONFIG, ...cfg, ...extra }, axis, label);
      out[`${fi0}:${label}`] = e;
      return { config: label, score: +e.score.toFixed(2), quick: pm(e.secs[0]), normal: pm(e.secs[1]), slow: pm(e.secs[2]), vslow: pm(e.secs[3]), 'sign%': +e.meanCorrect.toFixed(0), 'tilt cm': +f(e.tiltCm), };
    }).sort((a, b) => a.score - b.score);
    if (!asJson) { console.log(`\n${fi0}  (axis ${AXIS.deg.toFixed(1)}°, sorted by score)`); console.table(table); }
  }
  if (asJson) console.log(JSON.stringify(out, null, 2));
} else {
  const cfg = { ...APP_PIPELINE_CONFIG, ...extra };
  const res: Record<string, unknown> = {};
  for (const fi0 of files) {
    const e = runTake(fi0, cfg, axis, fi0);
    res[fi0] = e;
    if (!asJson) {
      console.log(`\n${fi0}  axis ${AXIS.deg.toFixed(1)}° (fixed from take01)  ${Object.keys(extra).length ? 'override ' + JSON.stringify(extra) : 'APP config'}`);
      console.table(e.secs.map(s => ({ section: s.section, n: s.n, 'mean ± std cm': pm(s), 'correct %': +s.correct.toFixed(0), 'side cm': +f(s.side) })));
      console.log(`  tilt drift ${f(e.tiltCm)} cm (truth 0)`);
      console.log(`  SCORE ${f(e.score, 2)} = speed ${f(e.speedTerm, 2)} + tilt/2 ${f(e.tiltTerm, 2)} + sign ${f(e.signTerm, 2)}`);
    }
  }
  if (asJson) console.log(JSON.stringify(res, null, 2));
}
