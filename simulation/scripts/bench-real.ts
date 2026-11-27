// Scores the motion pipeline on REAL recordings (no true path, but a known script).
// Run:  npm run bench:real                 (default setups)
//       npm run bench:real -- '{"strokeLeakGain":0}'   (extra config for every setup, JSON)
//
// Each recording in Final_Project/data has phases where the hand moved between two marks 10 cm apart.
// There, the estimated path should swing back and forth by about 10 cm along a line, with no
// sideways spread. Swings are measured along the phase's own main axis (from the path itself),
// so a mirrored or slightly rotated frame doesn't count against it. The hand may not hit the
// marks exactly on every swing, so the swing-to-swing scatter is partly the hand's own.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_PIPELINE_CONFIG } from '../../algorithms/config.ts';
import type { PipelineConfig } from '../../algorithms/config.ts';
import { Pipeline } from '../../algorithms/pipeline.ts';
import type { ImuSample } from '../../algorithms/pipeline.ts';
import { swingShape } from '../src/harness/scenarios.ts';

declare const process: { argv: string[]; exitCode?: number };

interface Phase { name: string; t0: number; t1: number; lengthCm: number }
interface Recording { file: string; phases: Phase[] }

// Times are seconds from the first sample. lengthCm = the true back-and-forth length.
const RECORDINGS: Recording[] = [
  {
    file: '../../data/imu_session_2026-11-25T18-20-44-305Z.csv',
    phases: [
      { name: 'right/left', t0: 1.0, t1: 12.5, lengthCm: 10 },
      { name: 'forward/back', t0: 16.3, t1: 27.6, lengthCm: 10 },
      { name: 'flicks', t0: 41.5, t1: 47.5, lengthCm: 5 },
      { name: 'nonstop L/R', t0: 50.5, t1: 54.0, lengthCm: 10 },
    ],
  },
];

const SETUPS: [string, Partial<PipelineConfig>][] = [
  ['Madgwick + stroke', { fusionMode: 'madgwick', motionModel: 'stroke' }],
  ['Kalman + stroke', { fusionMode: 'accel-kalman', motionModel: 'stroke' }],
  ['Compl. + stroke', { fusionMode: 'accel-complementary', motionModel: 'stroke' }],
  ['Madgwick + integrate', { fusionMode: 'madgwick', motionModel: 'integrate' }],
  ['Kalman + integrate', { fusionMode: 'accel-kalman', motionModel: 'integrate' }],
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

/** Replays a recording; returns the estimated hand position (m) per sample. */
function replay(samples: ImuSample[], cfg: PipelineConfig): { px: Float64Array; py: Float64Array } {
  const p = new Pipeline({ ...cfg, screenW: 1e6, screenH: 1e6 });
  p.reset(5e5, 5e5);
  // Recordings start after the live calibration; calibrate the replay on the first 300 ms (hand still).
  const t0 = samples[0].t, calib = samples.slice(0, 300), n = samples.length;
  for (let k = 0; k < cfg.calibrationMs; k++) {
    const s = calib[k % calib.length];
    p.step({ ...s, t: -cfg.calibrationMs / 1000 + k / 1000 });
  }
  const px = new Float64Array(n), py = new Float64Array(n);
  samples.forEach((s, i) => { const o = p.step({ ...s, t: s.t - t0 }); px[i] = o.pos[0]; py[i] = o.pos[1]; });
  return { px, py };
}

const extra: Partial<PipelineConfig> = JSON.parse(process.argv[2] ?? '{}');
const f = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
for (const rec of RECORDINGS) {
  const path = fileURLToPath(new URL(rec.file, import.meta.url));
  if (!existsSync(path)) { console.log(`missing ${rec.file}`); continue; }
  const samples = load(path);
  const t0 = samples[0].t;
  console.log(`\n${rec.file.split('/').pop()}: ${samples.length} samples, ${(samples.at(-1)!.t - t0).toFixed(1)} s`);
  console.log('  per phase: swings found · mean swing ± scatter · sideways spread · drift start→end (cm)');
  console.log('  score = mean over phases of |mean swing − true| + scatter + sideways (cm, lower is better)');
  console.log(`  ${'setup'.padEnd(22)}${rec.phases.map(p => `${p.name} (true ${p.lengthCm})`.padStart(34)).join('')}   score`);
  for (const [label, cfg] of SETUPS) {
    const { px, py } = replay(samples, { ...APP_PIPELINE_CONFIG, ...cfg, ...extra }); // as the app runs it
    let score = 0;
    const cells = rec.phases.map(ph => {
      const a = samples.findIndex(s => s.t - t0 >= ph.t0), b = samples.findIndex(s => s.t - t0 >= ph.t1);
      const r = swingShape(px, py, a, b);
      score += Math.abs(r.mean - ph.lengthCm) + r.scatter + r.side;
      return `${r.n}× ${f(r.mean)}±${f(r.scatter)} · ${f(r.side)} · ${f(r.net)}`;
    });
    console.log(`  ${label.padEnd(22)}${cells.map(c => c.padStart(34)).join('')}   ${f(score / rec.phases.length).padStart(5)}`);
  }
}
