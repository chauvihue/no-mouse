// Scores the motion pipeline on one protocol recording, move by move, against the 10 cm truth.
// Run:  npm run bench:moves                                  (newest imu_session_*.csv in Final_Project/data)
//       npm run bench:moves -- path/to/file.csv              (explicit file)
//       npm run bench:moves -- '{"strokeLeakGain":0}'        (extra config merged into every setup)
//       npm run bench:moves -- --json                        (only the scores, as JSON)
//
// For the session 2026-11-25T19-48-25-866Z recording the section windows are hardcoded (confirmed by hand).
// Inside a window every burst of motion is one move; the only exclusions are +/-0.6 s around the true
// double-tap markers. Any other recording falls back to auto-detected sections from the taps.
// A move's displacement is pos(start - 0.1 s) -> pos(end + 0.5 s).
// Axis A = sign-folded mean direction of the S1+S2 moves; B = A + 90 deg.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, basename } from 'node:path';
import { APP_PIPELINE_CONFIG } from '../../algorithms/config.ts';
import type { PipelineConfig } from '../../algorithms/config.ts';
import { Pipeline } from '../../algorithms/pipeline.ts';
import type { ImuSample } from '../../algorithms/pipeline.ts';
import { swingShape } from '../src/harness/scenarios.ts';

declare const process: { argv: string[]; exitCode?: number; cwd(): string };

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));
const TRUE_CM = 10;
const HARD_FILE = 'imu_session_2026-11-25T19-48-25-866Z.csv';
const MARKERS_S = [50.1, 91.2, 108.7, 163.1, 205.1, 250.6, 288.5];
const MARK_MASK_S = 0.6;
const PEAK_G = 0.25, STRONG_G = 1.0, CLUSTER_S = 0.8, TAP_MASK_S = 0.4;
const SMOOTH_HALF = 50, GYRO_ON = 15, HP_ON = 0.05;

type Kind = 'lr' | 'fb' | 'swing' | 'tilt' | 'skip';
interface Sec { name: string; i0: number; i1: number; kind: Kind; expected: number | null; axisRef: boolean }

const HARD_WINDOWS: { name: string; t0: number; t1: number; kind: Kind; expected: number | null; axisRef: boolean }[] = [
  { name: 'S1 quick L/R', t0: 5.5, t1: 29.0, kind: 'lr', expected: 8, axisRef: true },
  { name: 'S2 normal L/R', t0: 29.5, t1: 49.5, kind: 'lr', expected: 8, axisRef: true },
  { name: 'S3 slow L/R', t0: 55, t1: 89.5, kind: 'lr', expected: 8, axisRef: false },
  { name: 'S4 nonstop L/R', t0: 94, t1: 108, kind: 'swing', expected: 10, axisRef: false },
  { name: 'S5 tilts', t0: 111, t1: 162.5, kind: 'tilt', expected: null, axisRef: false },
  { name: 'S6 repositioning', t0: 163.5, t1: 204.5, kind: 'skip', expected: null, axisRef: false },
  { name: 'S7 fwd/back quick', t0: 207, t1: 226, kind: 'fb', expected: 8, axisRef: false },
  { name: 'S8 fwd/back slow', t0: 252, t1: 288, kind: 'fb', expected: 8, axisRef: false },
];

// Auto fallback: protocol section k (0..10) with the same kinds.
const AUTO_KIND: Record<number, [Kind, number | null, boolean]> = {
  0: ['skip', 0, false], 1: ['lr', 8, true], 2: ['lr', 8, true], 3: ['lr', 8, false], 4: ['swing', 10, false],
  5: ['tilt', null, false], 6: ['skip', 0, false], 7: ['fb', 8, false], 8: ['fb', 8, false], 9: ['skip', 6, false], 10: ['skip', 0, false],
};

const SETUPS: [string, Partial<PipelineConfig>][] = [
  ['madgwick+stroke', { fusionMode: 'madgwick', motionModel: 'stroke' }],
  ['accel-kalman+stroke', { fusionMode: 'accel-kalman', motionModel: 'stroke' }],
  ['madgwick+seg/raw', { fusionMode: 'madgwick', motionModel: 'segment', segLive: 'raw' }],
  ['madgwick+seg/stroke', { fusionMode: 'madgwick', motionModel: 'segment', segLive: 'stroke' }],
  ['accel-kalman+seg/raw', { fusionMode: 'accel-kalman', motionModel: 'segment', segLive: 'raw' }],
  ['accel-kalman+seg/stroke', { fusionMode: 'accel-kalman', motionModel: 'segment', segLive: 'stroke' }],
];

function load(path: string): ImuSample[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const hdr = lines.find(l => l.startsWith('t,'))!.split(',');
  const col = (n: string) => hdr.indexOf(n);
  const [it, iax, iay, iaz, igx, igy, igz] = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'].map(col);
  const out: ImuSample[] = [];
  for (const l of lines) {
    if (!l || l.startsWith('#') || l.startsWith('t,')) continue;
    const c = l.split(',');
    out.push({ t: +c[it], ax: +c[iax], ay: +c[iay], az: +c[iaz], gx: +c[igx], gy: +c[igy], gz: +c[igz] });
  }
  return out;
}

/** Replays a recording; returns the estimated hand position (m) per sample. Same as bench-real.ts. */
// Segment corrections (segmentEnd with correct=true): sample index and |pos change| it made, cm.
const corrEv: { i: number; jump: number; net: number; max: number }[] = [];
let curI = 0;
{
  const P: any = Pipeline.prototype; const origEnd = P.segmentEnd;
  P.segmentEnd = function (this: any, correct: boolean, drop: number) {
    const b0x = this.pos[0], b0y = this.pos[1];
    const net = Math.hypot(this.segRot[0], this.segRot[1], this.segRot[2]), max = this.segRotMax;
    origEnd.call(this, correct, drop); // jump is 0 when the correction is not applied
    corrEv.push({ i: curI, jump: Math.hypot(this.pos[0] - b0x, this.pos[1] - b0y) * 100, net, max });
  };
}

function replay(samples: ImuSample[], cfg: PipelineConfig): { px: Float64Array; py: Float64Array; ev: typeof corrEv } {
  const p = new Pipeline({ ...cfg, screenW: 1e6, screenH: 1e6 });
  p.reset(5e5, 5e5);
  const t0 = samples[0].t, calib = samples.slice(0, 300), n = samples.length;
  for (let k = 0; k < cfg.calibrationMs; k++) {
    const s = calib[k % calib.length];
    p.step({ ...s, t: -cfg.calibrationMs / 1000 + k / 1000 });
  }
  const px = new Float64Array(n), py = new Float64Array(n);
  corrEv.length = 0;
  samples.forEach((s, i) => { curI = i; const o = p.step({ ...s, t: s.t - t0 }); px[i] = o.pos[0]; py[i] = o.pos[1]; });
  return { px, py, ev: corrEv.slice() };
}

/** Centered moving average with +/- half samples, from prefix sums. */
function smooth(x: Float64Array, half: number): Float64Array {
  const n = x.length, pre = new Float64Array(n + 1), out = new Float64Array(n);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
    out[i] = (pre[b] - pre[a]) / (b - a);
  }
  return out;
}

interface Run { s: number; e: number }  // sample indices, end exclusive

/** Motion bursts outside the masks, merged across quiet gaps shorter than mergeS. */
function findRuns(tr: Float64Array, gyro: Float64Array, hp: Float64Array, masks: [number, number][], mergeS: number): Run[] {
  const n = tr.length;
  const gS = smooth(gyro, SMOOTH_HALF), hS = smooth(hp, SMOOTH_HALF);
  const masked = new Uint8Array(n);
  for (const [a, b] of masks) for (let i = 0; i < n; i++) if (tr[i] >= a && tr[i] <= b) masked[i] = 1;
  const runs: Run[] = [];
  let s = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && !masked[i] && (gS[i] > GYRO_ON || hS[i] > HP_ON);
    if (on && s < 0) s = i;
    if (!on && s >= 0) { runs.push({ s, e: i }); s = -1; }
  }
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && tr[r.s] - tr[last.e - 1] < mergeS) last.e = r.e;
    else merged.push({ ...r });
  }
  return merged.filter(r => tr[r.e - 1] - tr[r.s] >= 0.2);
}

/** Auto fallback: tap clusters (>= 2 spikes, one strong) on the |accel| high-pass. */
function findTapMasks(tr: Float64Array, tapHp: Float64Array): [number, number][] {
  const n = tr.length, peaks: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    const v = Math.abs(tapHp[i]);
    if (v <= PEAK_G) continue;
    if (v < Math.abs(tapHp[i - 1]) || v < Math.abs(tapHp[i + 1]) || v < Math.abs(tapHp[i - 2]) || v < Math.abs(tapHp[i + 2])) continue;
    const last = peaks.length ? peaks[peaks.length - 1] : -1;
    if (last >= 0 && tr[i] - tr[last] < 0.08) { if (v > Math.abs(tapHp[last])) peaks[peaks.length - 1] = i; continue; }
    peaks.push(i);
  }
  const masks: [number, number][] = [];
  let c: number[] = [];
  const flush = () => {
    if (c.length >= 2 && c.some(i => Math.abs(tapHp[i]) >= STRONG_G))
      masks.push([tr[c[0]] - TAP_MASK_S, tr[c[c.length - 1]] + TAP_MASK_S]);
    c = [];
  };
  for (const i of peaks) { if (c.length && tr[i] - tr[c[c.length - 1]] > CLUSTER_S) flush(); c.push(i); }
  flush();
  return masks;
}

/** Auto fallback sections: segments between tap clusters, mapped to protocol sections 0..10 by index. */
function autoSections(tr: Float64Array, masks: [number, number][]): { secs: Sec[]; note: string } {
  const n = tr.length;
  const idxAt = (t: number) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (tr[m] < t) lo = m + 1; else hi = m; } return lo; };
  const segs: [number, number][] = [];
  let from = 0;
  for (const [a, b] of masks) { segs.push([from, idxAt(a + TAP_MASK_S - 0.3)]); from = idxAt(b - TAP_MASK_S + 0.5); }
  segs.push([from, n]);
  const secs: Sec[] = segs.slice(0, 11).map(([i0, i1], k) => {
    const [kind, expected, axisRef] = AUTO_KIND[k] ?? ['skip', null, false];
    return { name: `sec ${k}`, i0, i1, kind, expected, axisRef };
  });
  const note = segs.length === 11 ? `auto: ${masks.length} tap clusters, 11 segments` : `auto: ${masks.length} tap clusters -> ${segs.length} segments; mapped by index, scores unreliable`;
  return { secs, note };
}

const deg = (r: number) => (r * 180) / Math.PI;
/** Folded angle between two lines (mod 180 deg), 0..90 deg. */
const lineErr = (a: number, target: number) => { const d = (((a - target) % Math.PI) + 2 * Math.PI) % Math.PI; return deg(Math.min(d, Math.PI - d)); };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const std = (xs: number[]) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };

interface Move { sec: number; dx: number; dy: number; dist: number; ang: number; jump: number; corr: number; rotNet: number; rotMax: number }
interface SecRes {
  name: string; kind: Kind; moves: number; expected: number | null;
  distMean?: number; distStd?: number; dirErr?: number;
  swing?: { mean: number; scatter: number; side: number; drift: number };
  tiltMax?: number; tiltMean?: number;
}

// settled (default): a move's end reading is taken just before the next move's window starts
// (next run start - 0.3 s, = its window start - 0.2 s), at least at the move end, at most move end + 2.5 s.
// early (--early): the old reading, move end + 0.5 s.
function evaluate(label: string, cfg: PipelineConfig, samples: ImuSample[], tr: Float64Array, secs: Sec[], runs: Run[], settled: boolean) {
  const { px, py, ev } = replay(samples, cfg);
  const n = samples.length;
  const idxAt = (t: number) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (tr[m] < t) lo = m + 1; else hi = m; } return lo; };
  const moves: Move[] = [];
  secs.forEach((sec, k) => {
    for (const r of runs) {
      if (r.s < sec.i0 || r.e > sec.i1) continue;
      const a = idxAt(tr[r.s] - 0.1);
      const tEnd = tr[r.e - 1];
      let b = Math.min(n - 1, idxAt(tEnd + 0.5));
      if (settled) {
        const nx = runs.find(q => q.s > r.e - 1);
        const tRead = Math.min(nx ? tr[nx.s] - 0.3 : Infinity, tEnd + 2.5);
        b = Math.min(n - 1, Math.max(idxAt(tRead), idxAt(tEnd)));
      }
      let corr = 0;
      for (const e of ev) if (e.i >= a && e.i <= b) corr += e.jump;
      // rotation of the segment that ends this move (first segment ending from the move start, up to move end + 2.5 s)
      const iLate = idxAt(tEnd + 2.5);
      const seg = ev.find(e => e.i >= a && e.i <= iLate);
      const rotNet = seg ? seg.net : 0, rotMax = seg ? seg.max : 0;
      const dx = (px[b] - px[a]) * 100, dy = (py[b] - py[a]) * 100;
      // UX: how far the live position strays from the final (corrected) one during the move, cm
      let jump = 0;
      for (let i = a; i <= b; i++) jump = Math.max(jump, Math.hypot(px[i] - px[b], py[i] - py[b]) * 100);
      moves.push({ sec: k, dx, dy, dist: Math.hypot(dx, dy), ang: Math.atan2(dy, dx), jump, corr, rotNet, rotMax });
    }
  });
  // axis A: sign-folded, length-weighted mean direction of the reference moves (S1+S2)
  let c = 0, s = 0;
  secs.forEach((sec, k) => {
    if (!sec.axisRef) return;
    for (const m of moves) if (m.sec === k) { c += m.dist * Math.cos(2 * m.ang); s += m.dist * Math.sin(2 * m.ang); }
  });
  const A = 0.5 * Math.atan2(s, c);
  const dirErrOf = (sec: Sec, m: Move) => (sec.kind === 'lr' ? lineErr(m.ang, A) : sec.kind === 'fb' ? lineErr(m.ang, A + Math.PI / 2) : NaN);

  const out: SecRes[] = [];
  const scoredDist: number[] = [], scoredDir: number[] = [];
  let s4term = 0, s5max = 0;
  secs.forEach((sec, k) => {
    if (sec.kind === 'skip') return;
    const mv = moves.filter(m => m.sec === k);
    const r: SecRes = { name: sec.name, kind: sec.kind, moves: mv.length, expected: sec.expected };
    if (sec.kind === 'lr' || sec.kind === 'fb') {
      const d = mv.map(m => Math.abs(m.dist - TRUE_CM)), dir = mv.map(m => dirErrOf(sec, m));
      r.distMean = mean(mv.map(m => m.dist)); r.distStd = std(mv.map(m => m.dist)); r.dirErr = mean(dir);
      scoredDist.push(...d); scoredDir.push(...dir);
    } else if (sec.kind === 'swing') {
      const sw = swingShape(px, py, sec.i0, sec.i1);
      r.swing = { mean: sw.mean, scatter: sw.scatter, side: sw.side, drift: sw.net };
      r.moves = sw.n;
      s4term = (Math.abs(sw.mean - TRUE_CM) + sw.scatter + sw.side) / 2;
    } else if (sec.kind === 'tilt') {
      const mags = mv.map(m => m.dist);
      r.tiltMax = mags.length ? Math.max(...mags) : 0; r.tiltMean = mean(mags.length ? mags : [0]);
      s5max = r.tiltMax;
    }
    out.push(r);
  });
  // A section with no detected moves must score badly, not NaN: "cursor never moves" = 10 cm off, 90° off.
  const distMean = scoredDist.length ? mean(scoredDist) : TRUE_CM;
  const dirMean = scoredDir.length ? mean(scoredDir) : 90;
  // score = 3·mean|dist−10| + mean|dir|/10 + S4/2 + S5 max (distance errors dominate on purpose)
  const jumps = moves.filter(m => secs[m.sec].kind === 'lr' || secs[m.sec].kind === 'fb').map(m => m.jump);
  const uxJump = jumps.length ? mean(jumps) : NaN;
  const distTerm = distMean, dirTerm = dirMean / 10; // distTerm = mean |dist − 10| (scoredDist holds |dist − 10|)
  const score = 3 * distTerm + dirTerm + s4term / 2 + s5max;
  const scoredMv = moves.filter(m => secs[m.sec].kind === 'lr' || secs[m.sec].kind === 'fb' || secs[m.sec].kind === 'tilt');
  const corrMean = scoredMv.length ? mean(scoredMv.map(m => m.corr)) : NaN;
  const corrMax = scoredMv.length ? Math.max(...scoredMv.map(m => m.corr)) : NaN;
  const rotOf = (prefix: string, field: 'rotNet' | 'rotMax', fn: (xs: number[]) => number) => {
    const k = secs.findIndex(x => x.name.startsWith(prefix));
    const xs = moves.filter(m => m.sec === k).map(m => m[field]);
    return xs.length ? fn(xs) : NaN;
  };
  const med = (xs: number[]) => { const y = [...xs].sort((a, b) => a - b); const m = y.length >> 1; return y.length % 2 ? y[m] : (y[m - 1] + y[m]) / 2; };
  const rot = { s2NetMed: rotOf('S2', 'rotNet', med), s2NetMax: rotOf('S2', 'rotNet', xs => Math.max(...xs)),
    s5NetMed: rotOf('S5', 'rotNet', med), s5NetMax: rotOf('S5', 'rotNet', xs => Math.max(...xs)),
    s2MaxMed: rotOf('S2', 'rotMax', med), s5MaxMed: rotOf('S5', 'rotMax', med) };
  return { label, score, distTerm, dirTerm, s4term, s5max, uxJump, corrMean, corrMax, rot, axisDeg: deg(A), out };
}

// ── main ──
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const settled = !args.includes('--early');
const extra: Partial<PipelineConfig> = JSON.parse(args.find(a => a.startsWith('{')) ?? '{}');
const fileArg = args.find(a => !a.startsWith('-') && !a.startsWith('{'));
const newest = readdirSync(DATA_DIR).filter(f => /^imu_session_.*\.csv$/.test(f)).sort().pop()!;
const path = fileArg ? resolve(fileArg) : resolve(DATA_DIR, newest);

const samples = load(path);
const t0 = samples[0].t;
const n = samples.length;
const tr = Float64Array.from(samples, s => s.t - t0);
const gyro = Float64Array.from(samples, s => Math.hypot(s.gx, s.gy, s.gz));
const tapHp = new Float64Array(n), hp = new Float64Array(n);
{
  const mag = Float64Array.from(samples, s => Math.hypot(s.ax, s.ay, s.az)), mb = smooth(mag, 125);
  for (let i = 0; i < n; i++) tapHp[i] = mag[i] - mb[i];
  const bx = smooth(Float64Array.from(samples, s => s.ax), 125), by = smooth(Float64Array.from(samples, s => s.ay), 125), bz = smooth(Float64Array.from(samples, s => s.az), 125);
  for (let i = 0; i < n; i++) hp[i] = Math.hypot(samples[i].ax - bx[i], samples[i].ay - by[i], samples[i].az - bz[i]);
}

const hard = basename(path) === HARD_FILE;
let secs: Sec[], runs: Run[], note: string;
const idxAt = (t: number) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (tr[m] < t) lo = m + 1; else hi = m; } return lo; };
if (hard) {
  const masks: [number, number][] = MARKERS_S.map(m => [m - MARK_MASK_S, m + MARK_MASK_S]);
  runs = findRuns(tr, gyro, hp, masks, 0.5);
  secs = HARD_WINDOWS.map(w => ({ name: w.name, i0: idxAt(w.t0), i1: idxAt(w.t1), kind: w.kind, expected: w.expected, axisRef: w.axisRef }));
  note = `hardcoded windows for ${HARD_FILE}; markers excluded +/-${MARK_MASK_S} s; merge gap 0.5 s`;
} else {
  const masks = findTapMasks(tr, tapHp);
  runs = findRuns(tr, gyro, hp, masks, 1.0);
  const a = autoSections(tr, masks);
  secs = a.secs; note = a.note;
}

const results = SETUPS.map(([label, cfg]) => evaluate(label, { ...APP_PIPELINE_CONFIG, ...cfg, ...extra }, samples, tr, secs, runs, settled));

if (asJson) {
  const out: Record<string, unknown> = {};
  for (const r of results) {
    const secsOut: Record<string, unknown> = {};
    for (const s of r.out) secsOut[s.name] = { moves: s.moves, expected: s.expected, distMeanCm: s.distMean, distStdCm: s.distStd, dirErrDeg: s.dirErr, swing: s.swing, tiltMaxCm: s.tiltMax, tiltMeanCm: s.tiltMean };
    out[r.label] = { score: r.score, distTerm: r.distTerm, dirTerm: r.dirTerm, s4Term: r.s4term, s5MaxCm: r.s5max, uxJumpMeanCm: r.uxJump, corrJumpMeanCm: r.corrMean, corrJumpMaxCm: r.corrMax, rot: r.rot, reading: settled ? 'settled' : 'early', axisDeg: r.axisDeg, sections: secsOut };
  }
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`${basename(path)}: ${note}`);
  for (const r of results) {
    console.log(`\n${r.label}  (axis A ${r.axisDeg.toFixed(0)}°)`);
    for (const s of r.out) {
      const cnt = `moves ${s.moves}/${s.expected ?? '-'}`;
      if (s.swing) console.log(`  ${s.name.padEnd(18)} ${cnt}  swing mean ${s.swing.mean.toFixed(1)} scatter ${s.swing.scatter.toFixed(1)} side ${s.swing.side.toFixed(1)} drift ${s.swing.drift.toFixed(1)} cm`);
      else if (s.tiltMax !== undefined) console.log(`  ${s.name.padEnd(18)} bursts ${s.moves}  |disp| max ${s.tiltMax.toFixed(1)} mean ${s.tiltMean!.toFixed(1)} cm (truth 0)`);
      else console.log(`  ${s.name.padEnd(18)} ${cnt}  MEAN DIST ${s.distMean!.toFixed(1)} cm (± ${s.distStd!.toFixed(1)})  |dir| ${s.dirErr!.toFixed(0)}°`);
    }
    console.log(`  UX jump (mean over moves of max |live − final| during move) ${r.uxJump.toFixed(1)} cm`);
    console.log(`  correction jump per scored move (|pos change at the segment end|): mean ${r.corrMean.toFixed(1)} max ${r.corrMax.toFixed(1)} cm  [reading: ${settled ? "settled" : "early"}]`);
    console.log(`  score ${r.score.toFixed(2)} = 3×dist ${(3 * r.distTerm).toFixed(2)} + dir ${r.dirTerm.toFixed(2)} + S4/2 ${(r.s4term / 2).toFixed(2)} + S5 ${r.s5max.toFixed(2)}   (mean|dist−10| ${r.distTerm.toFixed(2)})`);
  }
}
