// Replays recordings through the live click path, minus the DOM, and checks it against the offline numbers.
//
// Run:  npm run replay:clicks
//
// The live path is: serial text -> SerialStreamParser (src/ui/serial.ts) -> queue -> liveFrame's rate probe
// and per-reading loop (src/ui/main.ts, copied below: 16 readings measure the board rate, the rest are
// fed) -> ClickEngine.feed (algorithms/clicks/engine.ts, what the click tester calls) -> ClickDetector.
// The recording's own t,ax..gz text is cut into random-sized chunks like serial reads, so the parser's
// held-back sample, the rate probe and the lazy detector construction are all exercised.
//
// Checks (exit code 1 if one fails):
//   1  live replay finds the same taps as the detector run directly on the CSV samples
//   2  detection and side accuracy on the click takes match the offline evaluation (train-clicks)
//   3  0.2 % of the lines lost in transit (the parser drops the readings around the gap) barely changes it
//   4  a hand that is moving while the noise level is learned (2.5 s of sliding, then the take) still works
//   5  sensitivity only moves thresholds: events at 0.5x / 2x keep the same side as at 1x
//   6  teaching (5 + 5 taps, a still and a moving hand) gives a valid profile that does not hurt a take

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SerialStreamParser } from '../src/ui/serial.ts';
import { ClickDetector } from '../../algorithms/clicks/detector.ts';
import type { ClickEvent, ClickProfile, ImuReading, Side } from '../../algorithms/clicks/detector.ts';
import { ClickEngine } from '../../algorithms/clicks/engine.ts';
import { CLICK_MODEL } from '../../algorithms/clicks/model.ts';
import { buildProfile, parseProfile } from '../../algorithms/clicks/teach.ts';

const DATA = fileURLToPath(new URL('../../data/', import.meta.url));
const RATE_PROBE_N = 16; // same as main.ts

interface Rec { name: string; lines: string[]; samples: ImuReading[]; step: string[]; sec: string[]; move: string[]; click: string[] }
function load(file: string): Rec {
  const raw = readFileSync(DATA + file, 'utf8').split(/\r?\n/);
  const h = raw.findIndex((l) => l.length > 0 && !l.startsWith('#'));
  const hd = raw[h].split(',');
  const ci = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'].map((n) => hd.indexOf(n));
  const g = ['guide_step', 'guide_section', 'guide_move', 'guide_click'].map((n) => hd.indexOf(n));
  const rec: Rec = { name: file, lines: [], samples: [], step: [], sec: [], move: [], click: [] };
  for (const row of raw.slice(h + 1)) {
    if (!row) continue;
    const f = row.split(',');
    const cells = ci.map((i) => f[i]);
    rec.lines.push(cells.join(','));
    const v = cells.map(Number);
    rec.samples.push({ t: v[0], ax: v[1], ay: v[2], az: v[3], gx: v[4], gy: v[5], gz: v[6] });
    rec.step.push(f[g[0]]); rec.sec.push(f[g[1]]); rec.move.push(f[g[2]]); rec.click.push(f[g[3]]);
  }
  return rec;
}

let rng = 12345;
const rand = (): number => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296; };

interface Live { events: ClickEvent[]; engine: ClickEngine; rateHz: number; parser: SerialStreamParser }
/** Pushes the lines through parser, rate probe and engine exactly as the live page does. dropEvery: lose that share of lines. */
function replayLive(lines: string[], opts: { sensitivity?: number; profile?: ClickProfile | null; drop?: number } = {}): Live {
  const queue: ImuReading[] = [];
  const parser = new SerialStreamParser((s) => queue.push(s));
  const engine = new ClickEngine({ sensitivity: opts.sensitivity ?? 1, profile: opts.profile ?? null });
  const live = { rateHz: 0, prevT: null as number | null, dts: [] as number[] };
  const events: ClickEvent[] = [];
  const frame = (): void => {            // main.ts liveFrame, click part only
    for (const s of queue) {
      if (!live.rateHz) {
        if (live.prevT !== null && s.t > live.prevT) live.dts.push(s.t - live.prevT);
        live.prevT = s.t;
        if (live.dts.length < RATE_PROBE_N) continue;
        const dts = [...live.dts].sort((a, b) => a - b);
        live.rateHz = Math.max(1, Math.round(1 / dts[dts.length >> 1]));
      }
      const e = engine.feed(s, live.rateHz);
      if (e) events.push(e);
    }
    queue.length = 0;
  };
  parser.push('t,ax,ay,az,gx,gy,gz\n');
  let text = '';
  const keep = lines.filter(() => !(opts.drop && rand() < opts.drop));
  for (const l of keep) {
    text += l + '\n';
    while (text.length > 0 && rand() < 0.02 + text.length / 400) {   // serial reads of 1..~400 characters
      const n = 1 + Math.floor(rand() * Math.min(text.length, 400));
      parser.push(text.slice(0, n));
      text = text.slice(n);
      if (rand() < 0.3) frame();
    }
  }
  parser.push(text);
  frame();
  return { events, engine, rateHz: live.rateHz, parser };
}

function direct(samples: ImuReading[], sensitivity = 1, profile: ClickProfile | null = null): ClickEvent[] {
  const det = new ClickDetector({ sampleRateHz: 1000, sensitivity, profile });
  const out: ClickEvent[] = [];
  for (const s of samples) { const e = det.step(s); if (e) out.push(e); }
  return out;
}

interface Win { t0: number; t1: number; label: Side }
function windowsOf(rec: Rec): Win[] {
  const out: Win[] = [];
  let open: { i0: number; i1: number } | null = null;
  const close = (): void => {
    if (!open) return;
    out.push({ t0: rec.samples[open.i0].t - 0.05, t1: rec.samples[open.i1 - 1].t + 0.5, label: rec.click[open.i0] as Side });
    open = null;
  };
  for (let i = 0; i < rec.samples.length; i++) {
    if (rec.step[i] !== 'click') { close(); continue; }
    const same = open && rec.move[i] === rec.move[i - 1] && rec.sec[i] === rec.sec[i - 1] && rec.step[i - 1] === 'click';
    if (same) open!.i1 = i + 1; else { close(); open = { i0: i, i1: i + 1 }; }
  }
  close();
  return out;
}
function score(events: ClickEvent[], wins: Win[], tShift = 0): { det: number; ok: number; n: number } {
  let det = 0, ok = 0;
  for (const w of wins) {
    const inW = events.filter((e) => e.t >= w.t0 + tShift && e.t <= w.t1 + tShift);
    if (!inW.length) continue;
    det++;
    const best = inW.reduce((a, e) => (e.peakG > a.peakG ? e : a));
    if (best.side === w.label) ok++;
  }
  return { det, ok, n: wins.length };
}

let failed = 0;
const check = (name: string, pass: boolean, detail: string): void => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};

if (!CLICK_MODEL) throw new Error('no trained model: run npm run train:clicks first');
const files = ['clicks_take01_2026-11-27_13-58-32.csv', 'clicks_take02_2026-11-27_14-05-43.csv'];
const pans = ['panning_take01_2026-11-27_13-52-33.csv', 'panning_take02_2026-11-27_13-55-28.csv'];
if (![...files, ...pans].every((f) => existsSync(DATA + f))) throw new Error('recordings missing in ../data');
const clicks = files.map(load);
const pan = pans.map(load);

// 1 + 2: same taps as the direct run; same numbers as the offline evaluation
for (const rec of [...clicks, ...pan]) {
  const live = replayLive(rec.lines);
  const dir = direct(rec.samples);
  const sameTimes = live.events.length === dir.length && live.events.every((e, i) => Math.abs(e.t - dir[i].t) < 1e-6 && e.side === dir[i].side);
  // the first RATE_PROBE_N readings are used up by the rate probe and the last one is held back by the parser
  const near = live.events.filter((e) => dir.some((d) => Math.abs(d.t - e.t) < 1e-6 && d.side === e.side)).length;
  check(`1 live == direct (${rec.name.slice(0, 14)})`, live.rateHz === 1000 && near >= dir.length - 1 && near >= live.events.length - 1,
    `rate ${live.rateHz} Hz, ${live.events.length} live events, ${dir.length} direct, ${near} identical${sameTimes ? '' : ' (start-up filter state differs slightly)'}`);
}
for (const rec of clicks) {
  const wins = windowsOf(rec);
  const live = score(replayLive(rec.lines).events, wins), dir = score(direct(rec.samples), wins);
  check(`2 accuracy (${rec.name.slice(0, 14)})`, live.det === dir.det && live.ok === dir.ok,
    `live ${live.det}/${live.n} detected, ${live.ok} right side | offline ${dir.det}/${dir.n}, ${dir.ok}`);
}

// 3: lost lines
{
  let det = 0, ok = 0, n = 0, lost = 0;
  for (const rec of clicks) {
    const live = replayLive(rec.lines, { drop: 0.002 });
    lost += live.parser.badLines;
    const s = score(live.events, windowsOf(rec));
    det += s.det; ok += s.ok; n += s.n;
  }
  check('3 lost lines (0.2 %)', det >= 0.9 * n && ok >= 0.9 * det, `${det}/${n} detected, ${ok} right side, ${lost} lines the parser dropped`);
}

// 4: moving hand while the noise level is learned
{
  const slide = pan[0];
  const mv = slide.step.map((s, i) => (s === 'move' && slide.sec[i] === 'slow' ? i : -1)).filter((i) => i >= 0).slice(0, 2500);
  let det = 0, ok = 0, n = 0, thrMax = 0;
  for (const rec of clicks) {
    const shift = slide.samples[mv[mv.length - 1]].t + 0.001 - rec.samples[0].t;
    const lines = [...mv.map((i) => slide.lines[i])];
    const shifted = rec.samples.map((s, i) => ({ ...s, t: s.t + shift, line: i }));
    for (const s of shifted) lines.push([s.t.toFixed(4), rec.samples[s.line].ax, rec.samples[s.line].ay, rec.samples[s.line].az, rec.samples[s.line].gx, rec.samples[s.line].gy, rec.samples[s.line].gz].join(','));
    const live = replayLive(lines);
    thrMax = Math.max(thrMax, live.engine.det!.threshold());
    const s = score(live.events, windowsOf(rec), shift);
    det += s.det; ok += s.ok; n += s.n;
  }
  check('4 moving hand at start', det >= 0.9 * n && ok >= 0.9 * det && thrMax < 0.15, `${det}/${n} detected, ${ok} right side, final threshold ${thrMax.toFixed(3)} g`);
}

// 5: sensitivity only moves thresholds
{
  const rec = clicks[1];
  const e1 = direct(rec.samples, 1), eLo = direct(rec.samples, 0.5), eHi = direct(rec.samples, 2);
  const ref = (list: ClickEvent[]) => e1.filter((a) => list.some((b) => Math.abs(b.t - a.t) < 0.002));
  const sameSide = (list: ClickEvent[]) => e1.filter((a) => { const b = list.find((x) => Math.abs(x.t - a.t) < 0.002); return b && b.side === a.side; }).length;
  const det = new ClickDetector({ sampleRateHz: 1000, sensitivity: 1 });
  for (const s of rec.samples.slice(0, 4000)) det.step(s);
  const t1 = det.threshold(); det.sensitivity = 2; const t2 = det.threshold(); det.sensitivity = 0.5; const t05 = det.threshold();
  check('5 sensitivity direction', t2 < t1 && t1 < t05 && Math.abs(t1 / t2 - 2) < 0.01, `threshold ${t05.toFixed(3)} g at 0.5x, ${t1.toFixed(3)} at 1x, ${t2.toFixed(3)} at 2x`);
  check('5 sensitivity keeps the side', sameSide(eHi) === ref(eHi).length && sameSide(eLo) === ref(eLo).length,
    `of ${e1.length} taps at 1x: ${ref(eHi).length} also at 2x (${sameSide(eHi)} same side), ${ref(eLo).length} also at 0.5x (${sameSide(eLo)} same side)`);
}

// 6: teaching from take 1's first taps (a still hand and a moving hand from the panning take), tested on take 2
{
  const rec = clicks[0], wins = windowsOf(rec);
  const det = new ClickDetector({ sampleRateHz: 1000, emitRejected: true, sensitivity: 2 });
  const evs: ClickEvent[] = [];
  for (const s of rec.samples) { const e = det.step(s); if (e) evs.push(e); }
  const pick = (label: Side): { side: Side; ev: ClickEvent }[] => wins.filter((w) => w.label === label).slice(0, 5)
    .map((w) => ({ side: label, ev: evs.filter((e) => e.t >= w.t0 && e.t <= w.t1).reduce((a, e) => (e.peakG > a.peakG ? e : a)) }));
  const negDet = new ClickDetector({ sampleRateHz: 1000, emitRejected: true, sensitivity: 2 });
  const negs: ClickEvent[] = [];
  for (const s of pan[1].samples.slice(0, 30000)) { const e = negDet.step(s); if (e) negs.push(e); }
  const { profile, summary } = buildProfile(CLICK_MODEL, { taps: [...pick('L'), ...pick('R')], negatives: negs });
  const parsed = parseProfile(JSON.parse(JSON.stringify(profile)), CLICK_MODEL);
  const test = windowsOf(clicks[1]);
  const base = score(direct(clicks[1].samples), test), taught = score(direct(clicks[1].samples, 1, parsed), test);
  const panBase = direct(pan[1].samples).length, panTaught = direct(pan[1].samples, 1, parsed).length;
  check('6 teach', parsed !== null && taught.det >= base.det - 1 && taught.ok >= base.ok - 1,
    `profile ${parsed ? 'round-trips' : 'REJECTED'}; shift ${summary.gateShift.toFixed(2)}, amp floor ${summary.ampMinG.toFixed(3)} g, mean peaks L ${summary.peakL?.toFixed(2)} R ${summary.peakR?.toFixed(2)} g; take 2: default ${base.det}/${base.n} det, ${base.ok} side; taught ${taught.det}/${taught.n} det, ${taught.ok} side; panning events ${panBase} -> ${panTaught}`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
