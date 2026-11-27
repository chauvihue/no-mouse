import './style.css';
import { APP_PIPELINE_CONFIG, DEFAULT_PIPELINE_CONFIG, PIPELINE_STEPS } from '../pipeline/config.ts';
import type { FusionMode, MotionModel, PipelineConfig, StepKey, ClassifierKind } from '../pipeline/config.ts';
import type { StrokePhase } from '../pipeline/stroke.ts';
import type { Finger, LabeledFeatures } from '../pipeline/classifier.ts';
import { TapClassifier } from '../pipeline/classifier.ts';
import type { ImuSample, StepOutput } from '../pipeline/pipeline.ts';
import { Pipeline } from '../pipeline/pipeline.ts';
import { DEFAULT_SIM_CONFIG, PRESETS, cloneSimConfig } from '../sim/imu.ts';
import type { PresetName, SimConfig } from '../sim/imu.ts';
import { HandModel, DEFAULT_STROKES } from '../sim/hand.ts';
import { Session, TapTracker, copyClassifier } from '../harness/session.ts';
import type { TapRecord } from '../harness/session.ts';
import {
  DESK_W, DESK_H, START_X, START_Y, StrokeTestRunner, DriftTestRunner, runAB, trainSimulated,
  runStrokeTest, runDriftTest, runTapTest,
} from '../harness/scenarios.ts';
import type { StrokeRun, DriftRun, ABResult } from '../harness/scenarios.ts';
import { PlotBuffer, PlotView, CH } from './plots.ts';
import { Recorder, SessionRecorder, download, parseImuCsv } from './csv.ts';
import type { ReplayData } from './csv.ts';
import { BAUD_RATE, SerialImuLink } from './serial.ts';
import { PanningGuide, nextTake, storeTake, localStamp, guideFileName } from './guide.ts';
import type { GuideScript } from './guide.ts';
import type { WebSerialPort } from './serial.ts';
import { ClickTester } from './clicktest.ts';
import { theme, invalidateTheme, fingerColor, withAlpha } from './theme.ts';
import { buildPipelineSliders, buildSimSliders, buildTapSliders } from './settings.ts';
import type { Bound } from './settings.ts';
import { abChart, ablationChart, confusionHTML, scatterSVG, strokePathSVG, driftSVG, installTooltip, fmtNum } from './charts.ts';
import type { AblationRow } from './charts.ts';

// ───────────────────────── state ─────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// The app starts with the accelerometer-only Kalman mode (no gyro for cursor motion) and the
// stroke tracker; the headless checks in scripts/verify.ts keep the Madgwick + integrate default.
// Taps (detection and the click freeze) start switched off while the motion is being worked on:
// a fast flick, or just sliding vibration, sets off the tap detector, and the freeze then
// swallows the movement. The sliding detector (4c) is on. See APP_PIPELINE_CONFIG.
const session = new Session(cloneSimConfig(DEFAULT_SIM_CONFIG), { ...APP_PIPELINE_CONFIG });
const S = (): SimConfig => session.sim.cfg;
const STROKE_PHASE_TEXT: Record<StrokePhase, string> = { idle: 'at rest', speedup: 'stroke: speeding up', slowdown: 'stroke: slowing down', settle: 'stroke over' };
const P = (): PipelineConfig => session.pipe.cfg;
const hand = new HandModel(S().handOmega);
const plotBuf = new PlotBuffer(6, 1000);
const plotView = new PlotView($<HTMLCanvasElement>('plots'));
const recorder = new Recorder(120, 1000);
const sessionRec = new SessionRecorder(600, 1000); // the Record button: up to 10 min at 1 kHz
/** Guided panning recording: starts/stops sessionRec at the script's ends, and labels each sample with its step. */
const guide = new PanningGuide({
  startRecording: script => { if (!sessionRec.recording) toggleRecording(script); },
  stopRecording: aborted => { if (sessionRec.recording) stopAndSave(aborted); },
});

let target: [number, number] = [START_X, START_Y];
let prevTarget: [number, number] = [START_X, START_Y];
hand.setPosition(START_X, START_Y);
session.reset(START_X, START_Y);

let paused = false;
let clock = 0;              // global display clock (s), monotonic across resets
let stepAcc = 0;
let lastNow = performance.now();
let wasRunning = false;
let anchor: [number, number] = [START_X, START_Y];
const truePath: [number, number][] = [];
const estPath: [number, number][] = [];
const cursorTrail: [number, number][] = [];
let flash: { x: number; y: number; t: number; finger: Finger | null; hit?: boolean } | null = null;
let lastTruth: { px: number; py: number } | null = null;

type TargetTrial = { n: number; w: number; d: number; id: number; time: number; err: number; hit: boolean; finger: Finger | null };
interface TargetTest {
  kind: 'target'; phase: 'calib' | 'run' | 'done'; total: number; idx: number;
  cur: { x: number; y: number; w: number; d: number; t0: number } | null;
  trials: TargetTrial[]; wrongFinger: number; falseClicks: number; missed: number; rightClicks: number;
  plan: { w: number; d: number }[];
}
interface StrokeTest { kind: 'stroke'; runner: StrokeTestRunner }
interface DriftTest { kind: 'drift'; runner: DriftTestRunner }
let test: TargetTest | StrokeTest | DriftTest | null = null;

let lastTarget: { trials: TargetTrial[]; summary: Record<string, number> } | null = null;
let lastStroke: StrokeRun | null = null;
let lastDrift: DriftRun | null = null;
let lastAB: ABResult | null = null;
let lastAblation: AblationRow[] | null = null;

let trainingData: LabeledFeatures[] = [];
let training: { finger: Finger; n: number; per: number; data: LabeledFeatures[] } | null = null;

let source: 'sim' | 'replay' | 'live' = 'sim';
let replay: { data: ReplayData; idx: number; playing: boolean; tracker: TapTracker; nextLabel: number } | null = null;

// Live input from the real IMU. rateHz stays 0 until the board's sample rate has been
// measured from the first readings; the pipeline only starts after that.
const link = new SerialImuLink();
const clickTest = new ClickTester(); // Live IMU card's "Click tester" (src/ui/clicktest.ts)
let live: { tracker: TapTracker; dts: number[]; prevT: number | null; rateHz: number; n: number; lastT: number } | null = null;

/** Pipeline settings for simulated runs (A/B, auto-train): always at the simulator's rate. */
/** The real-board accelerometer correction applies to live input only: headless runs always use the defaults. */
const noAccelCal = (c: PipelineConfig): PipelineConfig => ({ ...c, accelBias: DEFAULT_PIPELINE_CONFIG.accelBias, accelScale: DEFAULT_PIPELINE_CONFIG.accelScale });
const simPipeCfg = (): PipelineConfig => noAccelCal({ ...P(), sampleRateHz: S().sampleRateHz });

const isPrecisionTest = () => test?.kind === 'target';
const debugOn = () => $<HTMLInputElement>('chkDebug').checked && !isPrecisionTest();

// ───────────────────────── stepping ─────────────────────────

function record(sample: ImuSample, out: StepOutput, truth: { px: number; py: number; vx: number; vy: number; tap: Finger | null } | null): void {
  clock += source === 'sim' ? 0.001 : Math.max(0.0001, sample.t - (lastSampleT ?? sample.t - 0.001));
  lastSampleT = sample.t;
  const o = plotBuf.push(clock), d = plotBuf.d;
  d[o + CH.ax] = sample.ax; d[o + CH.ay] = sample.ay; d[o + CH.az] = sample.az;
  d[o + CH.gx] = sample.gx; d[o + CH.gy] = sample.gy; d[o + CH.gz] = sample.gz;
  d[o + CH.lx] = out.lin[0]; d[o + CH.ly] = out.lin[1];
  d[o + CH.vx] = out.vel[0] * 100; d[o + CH.vy] = out.vel[1] * 100;
  d[o + CH.tvx] = truth ? truth.vx * 100 : 0; d[o + CH.tvy] = truth ? truth.vy * 100 : 0;
  d[o + CH.still] = out.still ? 1 : 0; d[o + CH.frozen] = out.frozen ? 1 : 0; d[o + CH.hp] = out.hpMag;

  const running = out.phase === 'running';
  if (running && !wasRunning) {
    anchor = truth ? [truth.px, truth.py] : [DESK_W / 2, DESK_H / 2];
    estPath.length = 0; truePath.length = 0;
  }
  wasRunning = running;
  const ex = anchor[0] + out.pos[0], ey = anchor[1] + out.pos[1];
  recorder.push(sample, truth?.tap ?? null, truth?.px ?? NaN, truth?.py ?? NaN, out.pos[0], out.pos[1], out.cursor[0], out.cursor[1], out.still);
  sessionRec.push(sample, out, truth?.px ?? NaN, truth?.py ?? NaN, guide.stepIndexAt(performance.now()));
  if (plotBuf.n % 10 === 0) {
    if (truth) { truePath.push([truth.px, truth.py]); if (truePath.length > 1000) truePath.shift(); }
    if (running) { estPath.push([ex, ey]); if (estPath.length > 1000) estPath.shift(); }
    cursorTrail.push([out.cursor[0], out.cursor[1]]); if (cursorTrail.length > 150) cursorTrail.shift();
  }
  if (truth) lastTruth = truth;
}
let lastSampleT: number | null = null;

function simStepLive(px: number, py: number): void {
  const r = session.step(px, py);
  record(r.sample, r.out, r.truth);
}

/** Called for every tap outcome (detections, wrong fingers, false triggers and misses). */
function onTapRecord(r: TapRecord, simT: number): void {
  const evClock = clock - (simT - (r.tDetected ?? r.tInjected ?? simT));
  if (r.outcome !== 'missed') {
    plotBuf.event({ t: evClock, kind: 'tap', finger: r.pred, note: `${r.pred === 'index' ? 'I' : 'P'} ${(r.confidence * 100).toFixed(0)}%${r.outcome === 'wrong-finger' ? ' ✕' : r.outcome === 'false' ? ' ?' : ''}` });
    const c = session.pipe.out.cursor;
    flash = { x: c[0], y: c[1], t: performance.now(), finger: r.pred };
  }
  tapLog.unshift({ ...r, clock: evClock });
  if (tapLog.length > 40) tapLog.pop();
  dirty.clf = true;

  if (training && r.features && r.outcome !== 'missed') collectTraining(r);
  if (test?.kind === 'target') targetOnTap(test, r);
}
const tapLog: (TapRecord & { clock: number })[] = [];
session.tracker.onRecord = r => onTapRecord(r, session.sim.k / S().sampleRateHz);

function injectTap(f: Finger): void {
  if (source !== 'sim' || paused) return;
  if (test && test.kind !== 'target') return;
  if (session.pipe.out.phase !== 'running') { setStatusHint('Wait for calibration to finish before tapping.'); return; }
  // with tap detection off, don't put tap jolts into the simulated signal either
  if (!P().enableTaps) { setStatusHint('Taps are switched off. Tick "9. Tap detection" under Pipeline steps to use them.'); return; }
  session.injectTap(f);
  plotBuf.event({ t: clock, kind: 'inject', finger: f });
}

function frame(now: number): void {
  const elapsed = Math.min(250, now - lastNow); // catch up after slow frames, but never spiral
  lastNow = now;
  hand.omega = S().handOmega;
  if (!paused) {
    if (source === 'sim') {
      stepAcc += elapsed;
      const n = Math.floor(stepAcc);
      stepAcc -= n;
      for (let i = 0; i < n; i++) {
        if (test?.kind === 'stroke' || test?.kind === 'drift') {
          const r = test.runner.step();
          record(r.sample, r.out, r.truth);
          if (test.runner.done) { finishScripted(); break; }
        } else {
          const f = (i + 1) / n;
          const p = hand.step(prevTarget[0] + (target[0] - prevTarget[0]) * f, prevTarget[1] + (target[1] - prevTarget[1]) * f, 0.001);
          simStepLive(p[0], p[1]);
        }
      }
      prevTarget = [target[0], target[1]];
      if (test?.kind === 'target') targetTick(test);
    } else if (source === 'live') {
      liveFrame();
    } else if (replay?.playing) {
      replayFrame(elapsed);
    }
  } else if (source === 'live') {
    link.queue.length = 0; // paused: drop real readings instead of replaying them later
  }
  render();
}
function rafLoop(now: number): void { frame(now); requestAnimationFrame(rafLoop); }
// watchdog: if animation frames stall (hidden/throttled window), keep the simulation going
setInterval(() => { const now = performance.now(); if (now - lastNow > 150) frame(now); }, 100);

// ───────────────────────── desk input ─────────────────────────

const desk = $<HTMLCanvasElement>('desk');
const sens = () => Number($<HTMLInputElement>('deskSens').value);
const clampDesk = (x: number, y: number): [number, number] => [Math.min(DESK_W - 0.01, Math.max(0.01, x)), Math.min(DESK_H - 0.01, Math.max(0.01, y))];

desk.addEventListener('mousemove', e => {
  if (document.pointerLockElement === desk) {
    target = clampDesk(target[0] + e.movementX * sens() / 1000, target[1] - e.movementY * sens() / 1000);
  } else if (!test || test.kind === 'target') {
    const r = desk.getBoundingClientRect();
    target = clampDesk((e.clientX - r.left) / r.width * DESK_W, (1 - (e.clientY - r.top) / r.height) * DESK_H);
  }
});
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement === desk && e.target !== desk) {
    target = clampDesk(target[0] + e.movementX * sens() / 1000, target[1] - e.movementY * sens() / 1000);
  }
});
desk.addEventListener('mousedown', e => {
  if (source === 'live') return; // the real IMU moves the cursor, not the desk pad
  if (document.pointerLockElement !== desk) { desk.requestPointerLock(); e.preventDefault(); return; }
  if (e.button === 0) injectTap('index');
  if (e.button === 2) injectTap('pinky');
});
desk.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === desk;
  desk.classList.toggle('locked', locked);
  $('deskMode').textContent = locked ? 'grabbed — Esc to release' : 'hover or click';
  if (locked) target = lastTruth ? [lastTruth.px, lastTruth.py] : target;
});
const sensOut = () => { $('deskSensV').textContent = `${sens().toFixed(2)} mm/count`; };
$<HTMLInputElement>('deskSens').addEventListener('input', sensOut); sensOut();

document.addEventListener('keydown', e => {
  const tg = e.target as HTMLElement;
  if (tg && (tg.tagName === 'SELECT' || (tg.tagName === 'INPUT' && (tg as HTMLInputElement).type !== 'range' && (tg as HTMLInputElement).type !== 'checkbox'))) return;
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'j') { injectTap('index'); e.preventDefault(); }
  else if (k === 'l') { injectTap('pinky'); e.preventDefault(); }
  else if (k === ' ') { togglePause(); e.preventDefault(); }
  else if (k === 'r' && !e.metaKey && !e.ctrlKey) { recalibrate(); }
});

// ───────────────────────── controls ─────────────────────────

function togglePause(): void {
  paused = !paused;
  $('btnPause').textContent = paused ? 'Resume' : 'Pause';
}
$('btnPause').addEventListener('click', togglePause);

function recalibrate(): void {
  if (source === 'replay') return;
  session.pipe.reset();
  session.tracker.reset();
  live?.tracker.reset();
  wasRunning = false;
}
$('btnRecal').addEventListener('click', recalibrate);

$('btnPower').addEventListener('click', () => {
  S().seed = 1 + Math.floor(Math.random() * 1e6);
  const p = lastTruth ?? { px: target[0], py: target[1] };
  session.sim.reset(p.px, p.py);
  hand.setPosition(p.px, p.py); target = [p.px, p.py]; prevTarget = [p.px, p.py];
  recalibrate();
  showOffsets();
});
function showOffsets(): void {
  const a = session.sim.accelOffsetG.map(v => (v * 1000).toFixed(0)).join(', ');
  const g = session.sim.gyroOffsetDps.map(v => v.toFixed(1)).join(', ');
  $('offsetInfo').textContent = `offsets: accel [${a}] mg, gyro [${g}] °/s (seed ${S().seed})`;
}

// ── session recording: every IMU reading + what the pipeline / cursor did with it ──
/** The guided run being recorded: its script, take number and local start time (null for ordinary recordings). */
let guidedRun: { script: GuideScript; take: number; started: Date } | null = null;

function toggleRecording(guided: GuideScript | null = null): void {
  if (!sessionRec.recording) {
    const mode = `${$<HTMLSelectElement>('fusionMode').selectedOptions[0]?.textContent ?? P().fusionMode}, ${$<HTMLSelectElement>('motionModel').selectedOptions[0]?.textContent ?? P().motionModel}`;
    const cal = `accel cal: bias [${P().accelBias.map(v => (v * 1000).toFixed(1)).join(', ')}] mg, scale [${P().accelScale.map(v => (v * 100).toFixed(2)).join(', ')}] %`;
    const meta = `${new Date().toISOString()} · input: ${source === 'live' ? 'live IMU' : source === 'replay' ? 'replayed file' : 'simulation'} · cursor mode: ${mode} · ${P().sampleRateHz} Hz · ${cal}`;
    if (guided) {
      const started = new Date();
      const take = nextTake(guided.id);
      guidedRun = { script: guided, take, started };
      const note = `${guided.note} · script ${guided.id} · take ${String(take).padStart(2, '0')} · started ${localStamp(started, ' ')} (local)`;
      sessionRec.start(meta, note, guided.steps);
    } else {
      guidedRun = null;
      sessionRec.start(meta);
    }
  } else {
    stopAndSave(true); // a manual stop during a guided run counts as aborted
  }
  updateRecordButton();
}

/** Stops the recorder and downloads the CSV (named by take for guided runs; the take counter moves on only when a file is saved). */
function stopAndSave(aborted: boolean): void {
  sessionRec.stop();
  const run = guidedRun;
  guidedRun = null;
  if (sessionRec.rows) {
    if (run) {
      download(guideFileName(run.script.id, run.take, run.started, aborted), sessionRec.toBlob());
      storeTake(run.script.id, run.take + 1);
    } else {
      download(`imu_session_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, sessionRec.toBlob());
    }
  }
  guide.abort(); // no-op when the guide itself is what stopped the recording
  guide.refreshTakes();
  updateRecordButton();
}
function updateRecordButton(): void {
  const b = $('btnRecord');
  b.classList.toggle('recording', sessionRec.recording);
  b.textContent = sessionRec.recording ? `■ Stop & save · ${(sessionRec.rows / P().sampleRateHz).toFixed(0)} s` : '● Record';
}
$('btnRecord').addEventListener('click', () => toggleRecording());

$<HTMLInputElement>('chkDebug').addEventListener('change', () => { /* read every frame */ });
$('btnTheme').addEventListener('click', () => {
  const dark = getComputedStyle(document.documentElement).getPropertyValue('color-scheme').trim() === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  try { localStorage.setItem('wml-theme', dark ? 'light' : 'dark'); } catch { /* ignore */ }
  invalidateTheme();
  $('plotLegend').innerHTML = plotView.legendHTML();
});
try { const t = localStorage.getItem('wml-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch { /* ignore */ }

// tabs
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab!)));
function selectTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'results') renderResults();
  if (name === 'clf') dirty.clf = true;
}

// pipeline step toggles
const toggleHost = $('stepToggles');
const stepChecks: HTMLInputElement[] = [];
for (const st of PIPELINE_STEPS) {
  const lab = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = P()[st.key];
  cb.addEventListener('change', () => {
    (P()[st.key] as boolean) = cb.checked;
    if (st.key === 'enableCalibration') recalibrate();
  });
  lab.append(document.createTextNode(st.label), cb);
  toggleHost.appendChild(lab);
  stepChecks.push(cb);
}
{
  const lab = document.createElement('label');
  const sel = document.createElement('select');
  sel.innerHTML = '<option value="accel-kalman">Accel only: Kalman (no gyro)</option><option value="accel-complementary">Accel only: complementary (no gyro)</option>' +
    '<option value="madgwick">Madgwick (gyro + accel)</option><option value="gyro-only">Gyro only (no accel correction)</option><option value="static">Static (frozen at start)</option>';
  sel.id = 'fusionMode';
  sel.value = P().fusionMode;
  // switching modes recalibrates, so the new mode starts from a fresh gravity / orientation estimate
  sel.addEventListener('change', () => { P().fusionMode = sel.value as FusionMode; recalibrate(); });
  lab.append(document.createTextNode('Fusion mode'), sel);
  const labM = document.createElement('label');
  const selM = document.createElement('select');
  selM.innerHTML = '<option value="stroke">Stroke tracker (push → brake → halt)</option><option value="integrate">Plain double integration</option><option value="segment">Stroke + rest-to-rest correction (gyro mode)</option>';
  selM.id = 'motionModel';
  selM.value = P().motionModel;
  selM.title = 'How acceleration becomes cursor motion. Stroke tracker: a stroke starts in the direction of the first push, ' +
    'only braking along that direction counts once the hand slows down, and velocity is set to exactly 0 when the braking is over.';
  selM.addEventListener('change', () => { P().motionModel = selM.value as MotionModel; session.pipe.stroke.reset(); });
  labM.append(document.createTextNode('Motion model'), selM);
  const lab2 = document.createElement('label');
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = P().adaptiveBeta;
  cb.addEventListener('change', () => { P().adaptiveBeta = cb.checked; });
  lab2.append(document.createTextNode('Adaptive β (trust accel when still)'), cb);
  const lab3 = document.createElement('label');
  const cb3 = document.createElement('input'); cb3.type = 'checkbox'; cb3.checked = P().biasTracking;
  cb3.addEventListener('change', () => { P().biasTracking = cb3.checked; });
  lab3.append(document.createTextNode('Gyro bias tracking while still'), cb3);
  toggleHost.append(lab, labM, lab2, lab3);
}

const pipeBounds: Bound[] = buildPipelineSliders($('pipeSliders'), P, () => {});
let simBounds: Bound[] = buildSimSliders($('simSliders'), S, () => { showOffsets(); });
let tapsChanged = false;
const tapBounds: Bound[] = buildTapSliders($('tapSliders'), S, () => { tapsChanged = true; dirty.clf = true; });
void pipeBounds; void tapBounds;

$<HTMLSelectElement>('preset').addEventListener('change', e => {
  const name = (e.target as HTMLSelectElement).value as PresetName;
  Object.assign(S(), PRESETS[name]);
  simBounds.forEach(b => b.refresh());
  showOffsets();
  recalibrate();
});

// ───────────────────────── scripted tests ─────────────────────────

function startScripted(kind: 'stroke' | 'drift'): void {
  if (source !== 'sim') useSimulation();
  stopTest(false);
  const x = kind === 'stroke' ? START_X : (lastTruth?.px ?? START_X), y = kind === 'stroke' ? START_Y : (lastTruth?.py ?? START_Y);
  // the scripted strokes wander right/up, so start the cursor left of centre to keep it on screen
  if (kind === 'stroke') session.reset(x, y, P().screenW * 0.25, P().screenH * 0.6);
  else session.reset(x, y);
  hand.setPosition(x, y); target = [x, y]; prevTarget = [x, y];
  wasRunning = false;
  test = kind === 'stroke'
    ? { kind, runner: new StrokeTestRunner(session, DEFAULT_STROKES, x, y) }
    : { kind, runner: new DriftTestRunner(session, x, y, 30) };
  showTestButtons(true);
  selectTab('live');
}

function finishScripted(): void {
  if (!test || (test.kind !== 'stroke' && test.kind !== 'drift')) return;
  const p = lastTruth ?? { px: START_X, py: START_Y };
  hand.setPosition(p.px, p.py); target = [p.px, p.py]; prevTarget = [p.px, p.py];
  if (test.kind === 'stroke') {
    lastStroke = test.runner.result();
    setStatusHint(`Stroke test done — mean end-point error ${fmtNum(lastStroke.meanEndErrCm, 'cm')}, mean |direction error| ${fmtNum(lastStroke.meanAbsDirErr, '°')}. See Results.`);
  } else {
    lastDrift = test.runner.result();
    setStatusHint(`Drift test done — ${fmtNum(lastDrift.driftCm, 'cm')} after 30 s (cursor moved ${fmtNum(lastDrift.cursorPx, 'px')}). See Results.`);
  }
  test = null;
  showTestButtons(false);
  dirty.results = true;
}

function stopTest(report = true): void {
  if (test?.kind === 'target' && report && test.trials.length) finishTarget(test);
  test = null;
  showTestButtons(false);
  if (report) setStatusHint('Test stopped.');
}

function showTestButtons(running: boolean): void {
  $('tStop').classList.toggle('hidden', !running);
  ['tTarget', 'tStroke', 'tDrift'].forEach(id => ($<HTMLButtonElement>(id).disabled = running));
}

$('tStroke').addEventListener('click', () => startScripted('stroke'));
$('tDrift').addEventListener('click', () => startScripted('drift'));
$('tStop').addEventListener('click', () => stopTest(true));
$('tTarget').addEventListener('click', startTarget);

// ───────────────────────── target (Fitts) test ─────────────────────────

function startTarget(): void {
  if (source !== 'sim') useSimulation();
  stopTest(false);
  const total = Math.max(3, Math.min(60, Number($<HTMLInputElement>('tN').value) || 15));
  const widths = [24, 40, 64], dists = [160, 320, 480];
  const combos: { w: number; d: number }[] = [];
  while (combos.length < total) for (const w of widths) for (const d of dists) combos.push({ w, d });
  combos.length = total;
  for (let i = combos.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [combos[i], combos[j]] = [combos[j], combos[i]]; }
  test = { kind: 'target', phase: 'calib', total, idx: 0, cur: null, trials: [], wrongFinger: 0, falseClicks: 0, missed: 0, rightClicks: 0, plan: combos };
  session.pipe.reset();
  session.tracker.reset();
  wasRunning = false;
  showTestButtons(true);
  selectTab('live');
  if (document.pointerLockElement !== desk) desk.requestPointerLock();
}

function spawnTarget(t: TargetTest): void {
  const { w, d } = t.plan[t.idx];
  const c = session.pipe.out.cursor;
  const m = 40, Wd = P().screenW, Hd = P().screenH;
  let x = 0, y = 0, ok = false;
  for (let k = 0; k < 60 && !ok; k++) {
    const a = Math.random() * 2 * Math.PI;
    x = c[0] + d * Math.cos(a); y = c[1] + d * Math.sin(a);
    ok = x > m && x < Wd - m && y > m && y < Hd - m;
  }
  if (!ok) { x = m + Math.random() * (Wd - 2 * m); y = m + Math.random() * (Hd - 2 * m); }
  t.cur = { x, y, w, d: Math.hypot(x - c[0], y - c[1]), t0: clock };
}

function targetTick(t: TargetTest): void {
  if (t.phase === 'calib' && session.pipe.out.phase === 'running') {
    t.phase = 'run';
    spawnTarget(t);
  }
}

function targetOnTap(t: TargetTest, r: TapRecord): void {
  if (t.phase !== 'run' || !t.cur) return;
  if (r.outcome === 'missed') { t.missed++; return; }
  if (r.outcome === 'wrong-finger') t.wrongFinger++;
  if (r.outcome === 'false') t.falseClicks++;
  if (r.pred !== 'index') { t.rightClicks++; return; } // a right click doesn't select
  const c = session.pipe.out.cursor;
  const err = Math.hypot(c[0] - t.cur.x, c[1] - t.cur.y);
  const hit = err <= t.cur.w / 2;
  t.trials.push({ n: t.idx + 1, w: t.cur.w, d: t.cur.d, id: Math.log2(t.cur.d / t.cur.w + 1), time: clock - t.cur.t0, err, hit, finger: r.truth });
  flash = { x: c[0], y: c[1], t: performance.now(), finger: 'index', hit };
  t.idx++;
  if (t.idx >= t.total) finishTarget(t);
  else spawnTarget(t);
}

function finishTarget(t: TargetTest): void {
  const tr = t.trials;
  const hits = tr.filter(x => x.hit);
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  const summary = {
    targets: tr.length,
    hitRatePct: tr.length ? hits.length / tr.length * 100 : NaN,
    meanTimeS: mean(tr.map(x => x.time)),
    meanErrPx: mean(tr.map(x => x.err)),
    throughputBps: mean(hits.map(x => x.id / x.time)),
    wrongFinger: t.wrongFinger, falseClicks: t.falseClicks, missedTaps: t.missed, rightClicks: t.rightClicks,
  };
  lastTarget = { trials: tr, summary };
  t.phase = 'done';
  test = null;
  showTestButtons(false);
  if (document.pointerLockElement === desk) document.exitPointerLock();
  setStatusHint(`Target test done — hit rate ${fmtNum(summary.hitRatePct, '%')}, ${fmtNum(summary.meanTimeS, 's')} per target, mean error ${fmtNum(summary.meanErrPx, 'px')}. See Results.`);
  dirty.results = true;
}

// ───────────────────────── classifier ─────────────────────────

function fitFrom(data: LabeledFeatures[], source: string): void {
  const kind = P().classifier;
  const c = new TapClassifier();
  c.fit(data, kind, source);
  if (c.trained) { copyClassifier(c, session.pipe.classifier); trainingData = data; }
  tapsChanged = false;
  dirty.clf = true;
}

function autoTrain(): void {
  const { data } = trainSimulated(S(), simPipeCfg(), 4242 + Math.floor(Math.random() * 1000), 20);
  fitFrom(data, `auto-trained on ${data.length} simulated taps (current signatures, ${(S().tapSimilarity * 100).toFixed(0)} % similarity)`);
}

$<HTMLSelectElement>('clfKind').addEventListener('change', e => {
  P().classifier = (e.target as HTMLSelectElement).value as ClassifierKind;
  if (trainingData.length) fitFrom(trainingData, session.pipe.classifier.source.replace(/^(logistic|centroid)\s*/, ''));
});
$('clfAuto').addEventListener('click', autoTrain);
$('clfClear').addEventListener('click', () => { session.tracker.reset(); tapLog.length = 0; dirty.clf = true; });
$('clfTrain').addEventListener('click', () => {
  if (source !== 'sim') useSimulation();
  const per = Math.max(3, Math.min(50, Number($<HTMLInputElement>('clfN').value) || 10));
  training = { finger: 'index', n: 0, per, data: [] };
  dirty.clf = true;
});

function collectTraining(r: TapRecord): void {
  if (!training) return;
  training.data.push({ x: r.features!, y: training.finger });
  training.n++;
  if (training.n >= training.per) {
    if (training.finger === 'index') { training.finger = 'pinky'; training.n = 0; }
    else {
      const data = training.data;
      training = null;
      fitFrom(data, `trained on your ${data.length} taps`);
    }
  }
  dirty.clf = true;
}

function renderClassifier(): void {
  const clf = session.pipe.classifier;
  const pr = $('clfPrompt');
  if (training) {
    pr.classList.remove('hidden');
    pr.innerHTML = `Tap <b style="color:${fingerColor(training.finger)}">${training.finger.toUpperCase()}</b> (${training.finger === 'index' ? 'J' : 'L'}) — ${training.n} / ${training.per}<div class="hint">Every detected tap is labelled "${training.finger}" — that is the ground truth the model learns from.</div>`;
  } else pr.classList.add('hidden');
  $('clfModelInfo').innerHTML = clf.trained
    ? `Model: <b>${clf.kind === 'logistic' ? 'logistic regression' : 'nearest centroid'}</b>, ${clf.source}.${tapsChanged ? ' <b>Tap signatures changed — retrain to adapt.</b>' : ''}`
    : 'Model: untrained.';
  if (trainingData.length) {
    const cm = TapClassifier.leaveOneOut(trainingData, P().classifier);
    $('clfLoo').innerHTML = confusionHTML(cm);
    $('clfScatter').innerHTML = scatterSVG(trainingData);
  } else { $('clfLoo').innerHTML = '<p class="hint">No training data yet.</p>'; $('clfScatter').innerHTML = ''; }
  const tr = replay && source === 'replay' ? replay.tracker : live && source === 'live' ? live.tracker : session.tracker;
  const st = tr.stats();
  const missI = tr.records.filter(r => r.outcome === 'missed' && r.truth === 'index').length;
  const missP = tr.records.filter(r => r.outcome === 'missed' && r.truth === 'pinky').length;
  $('clfLive').innerHTML = confusionHTML(st.confusion, { missedI: missI, missedP: missP, falseN: st.falseN });
  $('tapLog').innerHTML = tapLog.length ? `<table><tr><th>time</th><th>key</th><th>classified</th><th>conf.</th><th>outcome</th></tr>` +
    tapLog.slice(0, 25).map(r => `<tr><td>${r.clock.toFixed(2)} s</td><td>${r.truth ?? '—'}</td><td>${r.pred ? `<span class="dot" style="background:${fingerColor(r.pred)}"></span>${r.pred}` : '—'}</td><td>${r.pred ? (r.confidence * 100).toFixed(0) + ' %' : ''}</td><td><span class="tag ${r.outcome === 'correct' ? 'ok' : r.outcome === 'missed' ? 'warn' : 'bad'}">${r.outcome}</span></td></tr>`).join('') + '</table>'
    : '<p class="hint">Press J or L (or click while the hand is grabbed).</p>';
}

// ───────────────────────── A/B ─────────────────────────

const abSel = $<HTMLSelectElement>('abStep');
abSel.innerHTML = PIPELINE_STEPS.map(s => `<option value="${s.key}" ${s.key === 'enableZupt' ? 'selected' : ''}>${s.label}</option>`).join('');
const abOpts = () => ({
  strokes: $<HTMLInputElement>('abStrokes').checked, drift: $<HTMLInputElement>('abDrift').checked, taps: $<HTMLInputElement>('abTaps').checked,
  repeats: Math.max(1, Math.min(20, Number($<HTMLInputElement>('abRepeats').value) || 5)),
  driftS: Math.max(5, Math.min(120, Number($<HTMLInputElement>('abDriftS').value) || 30)), baseSeed: 101,
});
function setProgress(f: number | null): void {
  const el = $('abProgress');
  el.classList.toggle('hidden', f === null);
  (el.firstElementChild as HTMLElement).style.width = `${(f ?? 0) * 100}%`;
}
function abBusy(b: boolean): void { $<HTMLButtonElement>('abRun').disabled = b; $<HTMLButtonElement>('abSweep').disabled = b; }

$('abRun').addEventListener('click', async () => {
  const key = abSel.value as StepKey;
  const lab = PIPELINE_STEPS.find(s => s.key === key)!.label;
  abBusy(true); setProgress(0);
  const res = await runAB(key, lab, cloneSimConfig(S()), simPipeCfg(), session.pipe.classifier, abOpts(), f => setProgress(f));
  lastAB = res;
  setProgress(null); abBusy(false);
  $('abOut').insertAdjacentHTML('afterbegin', abChart(res));
  dirty.results = true;
});

$('abSweep').addEventListener('click', async () => {
  const o = abOpts();
  abBusy(true); setProgress(0);
  const sim = cloneSimConfig(S()), base = simPipeCfg();
  const clf = session.pipe.classifier;
  const configs: { label: string; cfg: PipelineConfig }[] = [{ label: 'All steps on', cfg: { ...base, ...Object.fromEntries(PIPELINE_STEPS.map(s => [s.key, true])) } as PipelineConfig }];
  for (const s of PIPELINE_STEPS) configs.push({ label: `${s.label} OFF`, cfg: { ...configs[0].cfg, [s.key]: false } as PipelineConfig });
  const rows: AblationRow[] = [];
  const total = configs.length * o.repeats;
  let done = 0;
  for (const c of configs) {
    let e = 0, d = 0, j = 0, a = 0, an = 0;
    for (let r = 0; r < o.repeats; r++) {
      e += runStrokeTest(sim, c.cfg, o.baseSeed + r, clf).meanEndErrCm;
      d += runDriftTest(sim, c.cfg, o.baseSeed + r, o.driftS).driftCm;
      const t = runTapTest(sim, c.cfg, o.baseSeed + r, clf, 10);
      j += t.meanJumpPx;
      if (isFinite(t.accuracy)) { a += t.accuracy * 100; an++; }
      done++; setProgress(done / total);
      await new Promise(res => setTimeout(res, 0));
    }
    rows.push({ label: c.label, endErrCm: e / o.repeats, driftCm: d / o.repeats, jumpPx: j / o.repeats, acc: an ? a / an : NaN });
  }
  lastAblation = rows;
  setProgress(null); abBusy(false);
  $('abOut').insertAdjacentHTML('afterbegin', ablationChart(rows, o.repeats, o.driftS));
  dirty.results = true;
});

// ───────────────────────── replay ─────────────────────────

$<HTMLInputElement>('csvFile').addEventListener('change', async e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const data = parseImuCsv(await f.text());
    replay = { data, idx: 0, playing: false, tracker: new TapTracker(), nextLabel: 0 };
    const dur = data.samples[data.samples.length - 1].t;
    $('replayInfo').innerHTML = `<b>${f.name}</b>: ${data.samples.length.toLocaleString()} samples, ${dur.toFixed(1)} s, ≈${data.rateHz} Hz, ${data.labeledTaps.length} labelled taps${data.notes.length ? ' · ' + data.notes.join(', ') : ''}${data.trueXY ? ' · has true position columns' : ''}`;
    ['rpPlay', 'rpTrain', 'rpExit', 'rpCompare'].forEach(id => ($<HTMLButtonElement>(id).disabled = false));
    $('rpCompareOut').innerHTML = '';
    $<HTMLButtonElement>('rpTrain').disabled = data.labeledTaps.length < 2;
  } catch (err) {
    $('replayInfo').textContent = `Could not read file: ${(err as Error).message}`;
  }
});

function startReplay(): void {
  if (!replay) return;
  stopLiveInput();
  stopTest(false);
  if (document.pointerLockElement === desk) document.exitPointerLock();
  source = 'replay';
  applyAccelCal(false);
  P().sampleRateHz = replay.data.rateHz;
  session.pipe.reset();
  replay.idx = 0; replay.nextLabel = 0; replay.tracker = new TapTracker();
  replay.tracker.onRecord = r => onTapRecord(r, replay!.data.samples[Math.max(0, replay!.idx - 1)].t);
  replay.playing = true;
  wasRunning = false; lastSampleT = null;
  $('rpPlay').textContent = 'Pause';
  selectTab('live');
}

function replayFrame(elapsedMs: number): void {
  const r = replay!;
  const sp = Number($<HTMLSelectElement>('rpSpeed').value);
  const n = sp === 0 ? 20000 : Math.max(1, Math.round(elapsedMs / 1000 * r.data.rateHz * sp));
  const pipe = session.pipe;
  for (let i = 0; i < n && r.idx < r.data.samples.length; i++) {
    const s = r.data.samples[r.idx];
    const lt = r.data.labeledTaps[r.nextLabel];
    if (lt && lt.index === r.idx) { r.tracker.inject(s.t, lt.finger); plotBuf.event({ t: clock + 0.001, kind: 'inject', finger: lt.finger }); r.nextLabel++; }
    const out = pipe.step(s);
    r.idx++;
    if (out.tap) r.tracker.detected(out.tap);
    if ((r.idx & 15) === 0) r.tracker.tick(s.t);
    const txy = r.data.trueXY?.[r.idx - 1];
    record(s, out, txy ? { px: txy[0], py: txy[1], vx: 0, vy: 0, tap: r.data.labels[r.idx - 1] } : null);
  }
  ($('rpProgress').firstElementChild as HTMLElement).style.width = `${r.idx / r.data.samples.length * 100}%`;
  if (r.idx >= r.data.samples.length) {
    r.tracker.tick(1e9);
    r.playing = false;
    $('rpPlay').textContent = 'Replay again';
    const st = r.tracker.stats();
    setStatusHint(`Replay finished — ${st.classified} taps classified${r.data.labeledTaps.length ? `, accuracy ${fmtNum(st.accuracy * 100, '%')}, ${st.missed} missed, ${st.falseN} false` : ''}; estimated displacement ${fmtNum(Math.hypot(pipe.out.pos[0], pipe.out.pos[1]) * 100, 'cm')}.`);
    dirty.clf = true;
  }
}

function exitReplay(): void {
  if (source !== 'replay') return;
  if (replay) replay.playing = false;
  source = 'sim';
  applyAccelCal(false);
  P().sampleRateHz = 1000;
  $('rpPlay').textContent = 'Play';
  recalibrate();
}

$('rpPlay').addEventListener('click', () => {
  if (!replay) return;
  if (source !== 'replay' || replay.idx >= replay.data.samples.length) { startReplay(); return; }
  replay.playing = !replay.playing;
  $('rpPlay').textContent = replay.playing ? 'Pause' : 'Play';
});
$('rpExit').addEventListener('click', exitReplay);

// Runs the loaded file through each cursor mode (current settings otherwise) and
// compares what the cursor did. Real recordings have no ground truth, so these
// are behaviour measures, not accuracy.
const COMPARE_MODES: [FusionMode, MotionModel, string][] = [
  ['accel-kalman', 'stroke', 'Accel only: Kalman · stroke tracker'], ['accel-kalman', 'integrate', 'Accel only: Kalman · plain integration'],
  ['accel-complementary', 'stroke', 'Accel only: complementary · stroke tracker'], ['accel-complementary', 'integrate', 'Accel only: complementary · plain integration'],
  ['madgwick', 'stroke', 'Madgwick (gyro + accel) · stroke tracker'], ['madgwick', 'integrate', 'Madgwick (gyro + accel) · plain integration'],
  ['madgwick', 'segment', 'Madgwick (gyro + accel) · rest-to-rest correction'],
];
function cursorBehaviour(d: ReplayData, cfg: PipelineConfig) {
  const pipe = new Pipeline(cfg);
  let run = 0, still = 0, edge = 0, path = 0, maxV = 0, x0 = NaN, y0 = NaN, px = NaN, py = NaN;
  for (const s of d.samples) {
    const o = pipe.step(s);
    if (o.phase !== 'running') continue;
    const [cx, cy] = o.cursor;
    if (!run) { x0 = cx; y0 = cy; px = cx; py = cy; }
    run++;
    if (o.still) still++;
    if (cx <= 0 || cy <= 0 || cx >= cfg.screenW || cy >= cfg.screenH) edge++;
    path += Math.hypot(cx - px, cy - py); px = cx; py = cy;
    maxV = Math.max(maxV, Math.hypot(o.vel[0], o.vel[1]));
  }
  return { stillPct: run ? still / run * 100 : NaN, edgeS: edge / cfg.sampleRateHz, pathPx: path, netPx: Math.hypot(px - x0, py - y0), maxCms: maxV * 100 };
}
$('rpCompare').addEventListener('click', () => {
  if (!replay) return;
  const d = replay.data;
  const rows = COMPARE_MODES.map(([m, mm, label]) => ({ label, ...cursorBehaviour(d, noAccelCal({ ...P(), fusionMode: m, motionModel: mm, sampleRateHz: d.rateHz })) }));
  $('rpCompareOut').innerHTML = `<table><tr><th>cursor mode</th><th>still</th><th>at screen edge</th><th>cursor path</th><th>start→end</th><th>top speed</th></tr>` +
    rows.map(r => `<tr><td>${r.label}</td><td>${fmtNum(r.stillPct, '%')}</td><td>${r.edgeS.toFixed(1)} s</td><td>${r.pathPx.toFixed(0)} px</td><td>${r.netPx.toFixed(0)} px</td><td>${fmtNum(r.maxCms, 'cm/s')}</td></tr>`).join('') +
    `</table><p class="hint"><b>At screen edge</b>: time the cursor was pinned to an edge. <b>Start→end</b>: if the recording ends with your hand back where it started, this should be small. <b>Top speed</b>: the highest estimated hand speed; tens of cm/s is normal, metres per second means it ran away.</p>`;
});
$('rpTrain').addEventListener('click', () => {
  if (!replay) return;
  const d = replay.data;
  const pipe = new Pipeline(noAccelCal({ ...P(), sampleRateHz: d.rateHz, screenW: 1e6, screenH: 1e6, enableTaps: true }));
  const tr = new TapTracker();
  let next = 0;
  d.samples.forEach((s, i) => {
    const lt = d.labeledTaps[next];
    if (lt && lt.index === i) { tr.inject(s.t, lt.finger); next++; }
    const out = pipe.step(s);
    if (out.tap) tr.detected(out.tap);
  });
  tr.tick(1e9);
  const data = tr.records.filter(r => r.features && r.truth).map(r => ({ x: r.features!, y: r.truth! }));
  if (data.filter(x => x.y === 'index').length && data.filter(x => x.y === 'pinky').length) {
    fitFrom(data, `trained on ${data.length} labelled taps from ${$<HTMLInputElement>('csvFile').files?.[0]?.name ?? 'CSV'}`);
    setStatusHint(`Classifier trained on ${data.length} labelled taps from the file (${tr.records.filter(r => r.outcome === 'missed').length} labelled taps were not detected).`);
  } else setStatusHint('Not enough detected labelled taps of both fingers to train.');
  selectTab('clf');
});

// ───────────────────────── live IMU (ESP32 over USB serial) ─────────────────────────

const RATE_PROBE_N = 16; // readings used to measure the board's sample rate before the pipeline starts

async function startLive(port?: WebSerialPort): Promise<void> {
  if (link.connected) return;
  const info = $('liveInfo');
  info.textContent = 'Connecting…';
  try {
    await link.connect(port);
  } catch (err) {
    const e = err as Error;
    info.textContent = e.name === 'NotFoundError' ? 'No port selected.'
      : e.name === 'InvalidStateError' || e.name === 'NetworkError'
        ? 'Could not open the port. Close anything else using it (e.g. the PlatformIO serial monitor) and try again.'
        : `Could not connect: ${e.message}`;
    updateLiveButtons();
    return;
  }
  stopTest(false);
  exitReplay();
  if (document.pointerLockElement === desk) document.exitPointerLock();
  source = 'live';
  applyAccelCal(true);
  live = { tracker: new TapTracker(), dts: [], prevT: null, rateHz: 0, n: 0, lastT: 0 };
  live.tracker.onRecord = r => onTapRecord(r, live?.lastT ?? 0);
  session.pipe.reset();
  wasRunning = false; lastSampleT = null;
  info.textContent = 'Connected. Waiting for readings…';
  updateLiveButtons();
  selectTab('live');
}

/** Feeds every reading that arrived since the last frame through the pipeline. */
function liveFrame(): void {
  const L = live!;
  const pipe = session.pipe;
  for (const s of link.queue) {
    if (!L.rateHz) {
      if (L.prevT !== null && s.t > L.prevT) L.dts.push(s.t - L.prevT);
      L.prevT = s.t;
      if (L.dts.length < RATE_PROBE_N) continue;
      const dts = [...L.dts].sort((a, b) => a - b);
      L.rateHz = Math.max(1, Math.round(1 / dts[dts.length >> 1]));
      P().sampleRateHz = L.rateHz; // window lengths and filters are defined in ms/Hz, so they follow the real rate
      pipe.reset();
      wasRunning = false; lastSampleT = null;
      showLiveInfo();
    }
    accelCalPush(s); // raw reading: the calibration is what changes the correction
    const out = pipe.step(s);
    L.lastT = s.t;
    if (out.tap) L.tracker.detected(out.tap);
    if ((++L.n & 15) === 0) L.tracker.tick(s.t);
    record(s, out, null);
    clickTest.feed(s, L.rateHz);
  }
  link.queue.length = 0;
}

function showLiveInfo(): void {
  if (!live?.rateHz) return;
  let msg = `Receiving ≈${live.rateHz} Hz from the ESP32. Press R to recalibrate (keep the IMU still).`;
  if (live.rateHz < 2.5 * P().tapHighpassHz) {
    msg += ` The pipeline is tuned for 1 kHz, so at this rate motion is coarse and tap detection is unreliable (untick "9. Tap detection" if hand motion triggers clicks).`;
  }
  // data health: anything non-zero means readings were lost or damaged on the way
  msg += ` Data: ${link.received.toLocaleString()} readings, ${link.badLines} garbled lines, ${link.serialErrors} receive errors, ${link.sensorNotes} sensor warnings${link.lastSensorNote ? ` (last: "${link.lastSensorNote}")` : ''}.`;
  $('liveInfo').textContent = msg;
}

/** Leaves live mode (without closing the port) and goes back to the simulator. */
function leaveLive(): void {
  guide.abort();
  if (source !== 'live') return;
  accelCal = null; accelWinN = 0;
  source = 'sim';
  live = null;
  applyAccelCal(false);
  P().sampleRateHz = S().sampleRateHz;
  recalibrate();
}

function stopLiveInput(): void {
  leaveLive();
  if (link.connected) void link.disconnect();
}

function useSimulation(): void {
  exitReplay();
  stopLiveInput();
}

function updateLiveButtons(): void {
  $<HTMLButtonElement>('liveConnect').disabled = !SerialImuLink.supported || link.connected;
  $<HTMLButtonElement>('liveStop').disabled = !link.connected;
  guide.setAvailable(link.connected);
  clickTest.setAvailable(link.connected);
}

link.onClose = err => {
  leaveLive();
  updateLiveButtons();
  $('liveInfo').textContent = err ? `Disconnected: ${err.replace(/\.$/, '')}. Back on the simulation.` : 'Disconnected. Back on the simulation.';
};
$('liveConnect').addEventListener('click', () => { void startLive(); });
$('liveStop').addEventListener('click', stopLiveInput);

// ───────────────────────── accelerometer calibration (6 faces) ─────────────────────────
// Rest the board on each of its six faces. For each axis: bias = (up + down) / 2 and
// scale = 2 / (up − down), and the pipeline then uses (raw − bias) · scale. Samples are the
// raw readings. A face counts once the board has been still for ACCEL_STILL_S seconds on it.

const ACCEL_CAL_KEY = 'wml-accel-cal';
const ACCEL_FACES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;
type AccelFace = typeof ACCEL_FACES[number];
const ACCEL_STILL_S = 2;     // still for this long = resting on a face
const ACCEL_WIN_CAP = 4096;  // ring buffer: ≥ 2 s at up to 2 kHz; fields per sample: t, ax, ay, az, gx, gy, gz
const accelWin = new Float64Array(ACCEL_WIN_CAP * 7);
let accelWinHead = 0, accelWinN = 0, accelSinceEval = 0;
let accelCal: { faces: Partial<Record<AccelFace, number[]>> } | null = null; // null: not running
/** The saved real-board calibration. It is copied into the pipeline only while live input runs. */
let savedAccelCal: { bias: [number, number, number]; scale: [number, number, number] } | null = null;

/** Puts the saved calibration into the pipeline for live input, or the defaults otherwise. */
function applyAccelCal(forLive: boolean): void {
  const useIt = forLive && savedAccelCal !== null;
  P().accelBias = useIt ? savedAccelCal!.bias : DEFAULT_PIPELINE_CONFIG.accelBias;
  P().accelScale = useIt ? savedAccelCal!.scale : DEFAULT_PIPELINE_CONFIG.accelScale;
}

const isTriple = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x));

function accelCalPush(s: ImuSample): void {
  if (!accelCal) return;
  const o = accelWinHead * 7;
  accelWin[o] = s.t; accelWin[o + 1] = s.ax; accelWin[o + 2] = s.ay; accelWin[o + 3] = s.az;
  accelWin[o + 4] = s.gx; accelWin[o + 5] = s.gy; accelWin[o + 6] = s.gz;
  accelWinHead = (accelWinHead + 1) % ACCEL_WIN_CAP;
  if (accelWinN < ACCEL_WIN_CAP) accelWinN++;
  if (++accelSinceEval >= 25) { accelSinceEval = 0; accelCalCheckRest(s.t); }
}

/** Offset of the k-th most recent sample in accelWin (k = 0 is the newest). */
const accelAt = (k: number): number => ((accelWinHead - 1 - k + 2 * ACCEL_WIN_CAP) % ACCEL_WIN_CAP) * 7;

/** If the last ACCEL_STILL_S seconds were still, record the face the board rests on. */
function accelCalCheckRest(tNow: number): void {
  if (!accelCal) return;
  // pass 1: means over the window
  let n = 0, oldest = Infinity;
  const m = [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < accelWinN; k++) {
    const o = accelAt(k);
    if (accelWin[o] < tNow - ACCEL_STILL_S) break;
    n++; oldest = accelWin[o];
    for (let j = 0; j < 6; j++) m[j] += accelWin[o + 1 + j];
  }
  if (n < 2 || oldest > tNow - ACCEL_STILL_S + 0.05) return; // not yet a full window of data
  for (let j = 0; j < 6; j++) m[j] /= n;
  // pass 2: accel vector spread (RMS over the three axes) and largest gyro deviation from its mean
  let va = 0, gDev = 0;
  for (let k = 0; k < n; k++) {
    const o = accelAt(k);
    const dx = accelWin[o + 1] - m[0], dy = accelWin[o + 2] - m[1], dz = accelWin[o + 3] - m[2];
    va += dx * dx + dy * dy + dz * dz;
    gDev = Math.max(gDev, Math.hypot(accelWin[o + 4] - m[3], accelWin[o + 5] - m[4], accelWin[o + 6] - m[5]));
  }
  if (Math.sqrt(va / n) >= 0.01 || gDev >= 2) return; // moving
  // which axis is near ±1 g, and are the other two near zero?
  let axis = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(m[i]) > Math.abs(m[axis])) axis = i;
  const others = [0, 1, 2].filter(i => i !== axis);
  if (Math.abs(m[axis]) <= 0.8 || others.some(i => Math.abs(m[i]) >= 0.3)) return;
  const face = `${m[axis] > 0 ? '+' : '-'}${'XYZ'[axis]}` as AccelFace;
  accelWinN = 0; // the next decision needs another full window of stillness
  if (accelCal.faces[face]) { accelCalShow(`${face.replace('-', '−')} is already done. Rest the board on another face.`); return; }
  accelCal.faces[face] = [m[0], m[1], m[2]];
  if (ACCEL_FACES.every(f => accelCal!.faces[f])) accelCalFinish();
  else accelCalShow(`${face.replace('-', '−')} recorded.`);
}

function accelCalStart(): void {
  accelCal = { faces: {} };
  accelWinN = 0; accelSinceEval = 0;
  accelCalShow();
}

function accelCalCancel(): void {
  accelCal = null; accelWinN = 0;
  accelCalShow('Calibration cancelled.');
}

/** The guided flow's status line: faces done so far, then an optional message. */
function accelCalShow(msg = ''): void {
  const el = $('accelCal');
  if (!accelCal) { el.textContent = msg; return; }
  const done = ACCEL_FACES.filter(f => accelCal!.faces[f]).length;
  const marks = ACCEL_FACES.map(f => `${f.replace('-', '−')} ${accelCal!.faces[f] ? '✓' : '…'}`).join('  ');
  el.textContent = `Rest the board on a face and keep it still (any order). Faces done: ${done}/6. ${marks}${msg ? ` ${msg}` : ''}`;
}

function accelCalFinish(): void {
  const f = accelCal!.faces as Record<AccelFace, number[]>;
  const bias: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1];
  const problems: string[] = [];
  for (let i = 0; i < 3; i++) {
    const ax = 'XYZ'[i];
    const up = f[`+${ax}` as AccelFace][i], down = f[`-${ax}` as AccelFace][i];
    bias[i] = (up + down) / 2;
    scale[i] = 2 / (up - down);
    if (Math.abs(bias[i]) > 0.15) problems.push(`${ax} bias ${(bias[i] * 1000).toFixed(0)} mg is over 150 mg`);
    if (!(scale[i] >= 0.9 && scale[i] <= 1.1)) problems.push(`${ax} scale ${(scale[i] * 100).toFixed(0)} % is outside 90–110 %`);
  }
  if (problems.length) {
    accelCal = null; accelWinN = 0;
    accelCalShow(`Not applied: ${problems.join('; ')}. Check the faces and try again.`);
    return;
  }
  savedAccelCal = { bias, scale };
  try { localStorage.setItem(ACCEL_CAL_KEY, JSON.stringify({ bias, scale })); } catch { /* storage blocked: applied for this page only */ }
  accelCal = null; accelWinN = 0;
  applyAccelCal(source === 'live');
  recalibrate();
  accelCalShow(`Applied. Bias ${bias.map(v => (v * 1000).toFixed(0)).join(', ')} mg, scale ${scale.map(v => (v * 100).toFixed(1)).join(', ')} %.`);
}

function accelCalReset(): void {
  if (accelCal) { accelCal = null; accelWinN = 0; }
  savedAccelCal = null;
  try { localStorage.removeItem(ACCEL_CAL_KEY); } catch { /* ignore */ }
  applyAccelCal(false);
  recalibrate();
  accelCalShow('Reset to the defaults (no correction).');
}

/** Restores a saved calibration on page load. */
function accelCalRestore(): void {
  try {
    const raw = localStorage.getItem(ACCEL_CAL_KEY);
    if (!raw) return;
    const v = JSON.parse(raw) as { bias?: unknown; scale?: unknown };
    if (!isTriple(v.bias) || !isTriple(v.scale)) return;
    savedAccelCal = { bias: v.bias, scale: v.scale };
    accelCalShow(`Using the saved calibration: bias ${v.bias.map(x => (x * 1000).toFixed(0)).join(', ')} mg, scale ${v.scale.map(x => (x * 100).toFixed(1)).join(', ')} %.`);
  } catch { /* storage blocked or corrupt: keep the defaults */ }
}

/** Enabled only while live readings are arriving (or while a calibration is running, to cancel it). */
function updateAccelCalButton(): void {
  const b = $<HTMLButtonElement>('accelCalBtn');
  const streaming = source === 'live' && !!live?.rateHz && performance.now() - link.lastDataAt < 1000;
  b.disabled = !accelCal && !streaming;
  const label = accelCal ? 'Cancel calibration' : 'Calibrate accelerometer (6 faces)';
  if (b.textContent !== label) b.textContent = label;
}

$('accelCalBtn').addEventListener('click', () => { if (accelCal) accelCalCancel(); else accelCalStart(); });
$('accelCalReset').addEventListener('click', accelCalReset);
accelCalRestore();

// ───────────────────────── rendering ─────────────────────────

const view = $<HTMLCanvasElement>('mainView');
const vctx = view.getContext('2d')!;
const dctx = desk.getContext('2d')!;
const dirty = { clf: true, results: true };
let lastSlow = 0;

function setStatusHint(s: string): void { $('testStatus').textContent = s; }

function render(): void {
  const th = theme();
  const out = session.pipe.out;
  updateAccelCalButton();
  drawMain(th, out);
  drawDesk(th, out);
  plotView.showTrue = debugOn() && source === 'sim';
  plotView.draw(plotBuf, P().tapThresholdG);

  // status pill & overlay
  const pill = $('statusPill');
  const ov = $('viewOverlay');
  let ovHTML = '';
  if (paused) { pill.textContent = 'Paused'; pill.className = 'pill'; }
  else if (source === 'replay') { pill.textContent = `Replay ${replay ? Math.round(replay.idx / replay.data.samples.length * 100) : 0} %`; pill.className = 'pill test'; }
  else if (source === 'live' && (!live?.rateHz || performance.now() - link.lastDataAt > 1000)) {
    const silentS = (performance.now() - link.lastDataAt) / 1000;
    pill.textContent = silentS > 1.5 ? 'Live IMU · no data' : 'Live IMU · starting'; pill.className = 'pill cal';
    ovHTML = silentS > 1.5
      ? `<div class="big">No data from the ESP32</div><div>Nothing received for ${silentS.toFixed(0)} s. Is the board running the IMU sketch at ${BAUD_RATE} baud?</div>`
      : '<div class="big">Waiting for the ESP32…</div><div>measuring its sample rate</div>';
  } else if (out.phase === 'calibrating') {
    pill.textContent = `Calibrating ${Math.round(out.calibProgress * 100)} %`; pill.className = 'pill cal';
    ovHTML = `<div class="big">Calibrating — keep the hand still</div><div>${Math.round(out.calibProgress * 100)} % · averaging gyro bias and gravity</div>`;
  } else if (test) { pill.textContent = test.kind === 'target' ? 'Target test' : test.kind === 'stroke' ? 'Stroke test' : 'Drift test'; pill.className = 'pill test'; }
  else {
    const motion = P().motionModel === 'stroke' ? STROKE_PHASE_TEXT[out.strokePhase] : out.still ? 'still' : 'moving';
    const slide = P().enableSlideDetect && out.sliding ? ' · sliding' : '';
    pill.textContent = `${source === 'live' ? 'Live IMU' : 'Running'} · ${motion}${slide}`; pill.className = 'pill run';
  }
  if (test?.kind === 'target' && test.phase === 'calib' && document.pointerLockElement !== desk && out.phase === 'running') {
    ovHTML = '<div class="big">Click the desk pad to grab the hand</div><div>Then steer the cursor onto each target and tap J (index)</div>';
  }
  ov.innerHTML = ovHTML;
  ov.classList.toggle('hidden', !ovHTML);

  const now = performance.now();
  if (now - lastSlow > 250) {
    lastSlow = now;
    if (sessionRec.recording && sessionRec.full) toggleRecording(); // 10 min limit: save what we have
    if (source === 'live') showLiveInfo();
    if (sessionRec.recording) updateRecordButton();
    if (dirty.clf && $('tab-clf').classList.contains('active')) { renderClassifier(); dirty.clf = false; }
    if (test?.kind === 'stroke') {
      const k = test.runner.currentStroke;
      setStatusHint(`Stroke test ${Math.round(test.runner.progress * 100)} % ${k >= 0 ? '— ' + DEFAULT_STROKES[k].label : ''}`);
    } else if (test?.kind === 'drift') {
      setStatusHint(`Drift test: ${test.runner.elapsedS.toFixed(1)} / 30 s — drift so far ${fmtNum(test.runner.currentCm, 'cm')}`);
    } else if (test?.kind === 'target') {
      const t = test;
      setStatusHint(t.phase === 'calib' ? 'Target test: calibrating…' : `Target ${Math.min(t.idx + 1, t.total)} / ${t.total} · hits ${t.trials.filter(x => x.hit).length} · wrong-finger ${t.wrongFinger} · false ${t.falseClicks} · missed ${t.missed}`);
    }
  }
}

function drawMain(th: ReturnType<typeof theme>, out: StepOutput): void {
  const W = view.width, H = view.height;
  const ctx = vctx;
  ctx.clearRect(0, 0, W, H);
  // grid
  ctx.fillStyle = th.grid;
  for (let x = 50; x < W; x += 50) for (let y = 50; y < H; y += 50) ctx.fillRect(x - 1, y - 1, 2, 2);

  // target
  if (test?.kind === 'target' && test.cur) {
    const c = test.cur;
    ctx.fillStyle = withAlpha(th.target, 0.18);
    ctx.strokeStyle = th.target; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c.x, c.y, c.w / 2, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(c.x, c.y, 2.5, 0, 2 * Math.PI); ctx.fillStyle = th.target; ctx.fill();
    ctx.fillStyle = th.ink2; ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(`target ${test.idx + 1}/${test.total} · ${c.w}px wide · ${Math.round(c.d)}px away`, 14, 22);
  }

  // cursor trail
  if (cursorTrail.length > 1) {
    ctx.strokeStyle = withAlpha(th.est, 0.35); ctx.lineWidth = 2;
    ctx.beginPath(); cursorTrail.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
  }

  // click flash
  if (flash) {
    const age = (performance.now() - flash.t) / 400;
    if (age > 1) flash = null;
    else {
      ctx.strokeStyle = flash.hit === false ? th.crit : fingerColor(flash.finger);
      ctx.globalAlpha = 1 - age; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(flash.x, flash.y, 8 + age * 26, 0, 2 * Math.PI); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // cursor (arrow)
  const [cx, cy] = out.cursor;
  ctx.save(); ctx.translate(cx, cy);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 20); ctx.lineTo(5, 15); ctx.lineTo(9, 23); ctx.lineTo(12, 21.5); ctx.lineTo(8.5, 14); ctx.lineTo(15, 14); ctx.closePath();
  ctx.fillStyle = th.cursor; ctx.strokeStyle = th.surface; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke();
  if (out.frozen) { ctx.strokeStyle = th.warn; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 11, 0, 2 * Math.PI); ctx.stroke(); }
  ctx.restore();

  // HUD
  ctx.fillStyle = th.ink2; ctx.font = '12px system-ui, sans-serif';
  const sp = Math.hypot(out.vOut[0], out.vOut[1]) * 100;
  ctx.textAlign = 'right';
  ctx.fillText(`speed ${sp.toFixed(1)} cm/s · gain ${(out.gain / 1000).toFixed(2)} px/mm${out.frozen ? ' · FROZEN' : ''}`, W - 12, 20);
  ctx.textAlign = 'left';

  // debug inset: true vs estimated path (desk metres)
  if (debugOn() && estPath.length > 2) {
    const iw = 250, ih = 160, ix = W - iw - 12, iy = H - ih - 12;
    ctx.fillStyle = withAlpha(th.surface2, 0.92); ctx.strokeStyle = th.axis; ctx.lineWidth = 1;
    ctx.fillRect(ix, iy, iw, ih); ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
    const pts = [...truePath.slice(-600), ...estPath.slice(-600)];
    let x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
    let y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
    const span = Math.max(0.04, x1 - x0, (y1 - y0) * iw / ih) * 1.15;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const sc = (iw - 20) / span;
    const tx = (x: number) => ix + iw / 2 + (x - mx) * sc, ty = (y: number) => iy + ih / 2 + 8 - (y - my) * sc;
    const pl = (arr: [number, number][], col: string, dash: number[]) => {
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash(dash);
      ctx.beginPath(); arr.forEach(([x, y], i) => (i ? ctx.lineTo(tx(x), ty(y)) : ctx.moveTo(tx(x), ty(y)))); ctx.stroke(); ctx.setLineDash([]);
    };
    if (source === 'sim' || truePath.length) pl(truePath.slice(-600), th.true, []);
    pl(estPath.slice(-600), th.est, [6, 3]);
    ctx.fillStyle = th.ink2; ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('debug · true (solid) vs estimate (dashed)', ix + 6, iy + 13);
    const cm = sc * 0.01;
    ctx.fillRect(ix + iw - 10 - cm, iy + ih - 8, cm, 2);
    ctx.textAlign = 'right'; ctx.fillText('1 cm', ix + iw - 10, iy + ih - 12); ctx.textAlign = 'left';
    void x0; void x1; void y0; void y1;
  }
}

function drawDesk(th: ReturnType<typeof theme>, out: StepOutput): void {
  const W = desk.width, H = desk.height;
  const ctx = dctx;
  ctx.clearRect(0, 0, W, H);
  const sx = (x: number) => x / DESK_W * W, sy = (y: number) => H - y / DESK_H * H;
  ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
  for (let x = 0.05; x < DESK_W; x += 0.05) { ctx.beginPath(); ctx.moveTo(sx(x) + 0.5, 0); ctx.lineTo(sx(x) + 0.5, H); ctx.stroke(); }
  for (let y = 0.05; y < DESK_H; y += 0.05) { ctx.beginPath(); ctx.moveTo(0, sy(y) + 0.5); ctx.lineTo(W, sy(y) + 0.5); ctx.stroke(); }
  ctx.fillStyle = th.ink2; ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('40 × 25 cm desk · 5 cm grid', 6, 14);
  if (source === 'replay') {
    ctx.fillText('replaying recorded data — estimated path only', 6, H - 8);
  } else if (source === 'live') {
    ctx.fillText('live IMU — estimated path only', 6, H - 8);
  }
  if (!debugOn()) {
    ctx.textAlign = 'center';
    ctx.fillStyle = th.ink2; ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(isPrecisionTest() ? 'true hand hidden during the test' : 'debug overlay off', W / 2, H / 2);
    ctx.textAlign = 'left';
    return;
  }
  const pl = (arr: [number, number][], col: string, dash: number[]) => {
    if (arr.length < 2) return;
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash(dash);
    ctx.beginPath(); arr.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y)))); ctx.stroke(); ctx.setLineDash([]);
  };
  pl(truePath, withAlpha(th.true, 0.8), []);
  pl(estPath, th.est, [6, 3]);
  if (out.phase === 'running') {
    const ex = anchor[0] + out.pos[0], ey = anchor[1] + out.pos[1];
    ctx.strokeStyle = th.est; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx(ex), sy(ey), 7, 0, 2 * Math.PI); ctx.stroke();
  }
  if (lastTruth && source === 'sim') {
    ctx.fillStyle = th.true;
    ctx.beginPath(); ctx.arc(sx(lastTruth.px), sy(lastTruth.py), 6, 0, 2 * Math.PI); ctx.fill();
  }
}

// ───────────────────────── results & export ─────────────────────────

function renderResults(): void {
  if (!dirty.results && $('resultsOut').innerHTML) return;
  dirty.results = false;
  let h = '';
  if (lastTarget) {
    const s = lastTarget.summary;
    h += `<div class="card chartcard"><h3>Target test (Fitts-style)</h3><div class="kpis">
      ${kpi('hit rate', fmtNum(s.hitRatePct, '%'))}${kpi('time / target', fmtNum(s.meanTimeS, 's'))}${kpi('mean error at click', fmtNum(s.meanErrPx, 'px'))}
      ${kpi('throughput (hits)', fmtNum(s.throughputBps, 'bit/s'))}${kpi('wrong-finger', String(s.wrongFinger))}${kpi('false clicks', String(s.falseClicks))}${kpi('missed taps', String(s.missedTaps))}</div>
      <table><tr><th>#</th><th>width (px)</th><th>distance (px)</th><th>ID (bits)</th><th>time (s)</th><th>error (px)</th><th>hit</th></tr>
      ${lastTarget.trials.map(t => `<tr><td>${t.n}</td><td>${t.w}</td><td>${t.d.toFixed(0)}</td><td>${t.id.toFixed(2)}</td><td>${t.time.toFixed(2)}</td><td>${t.err.toFixed(1)}</td><td><span class="tag ${t.hit ? 'ok' : 'bad'}">${t.hit ? 'hit' : 'miss'}</span></td></tr>`).join('')}</table></div>`;
  }
  if (lastStroke) {
    const r = lastStroke;
    h += `<div class="card chartcard"><h3>Stroke accuracy test</h3><div class="kpis">${kpi('mean end-point error', fmtNum(r.meanEndErrCm, 'cm'))}${kpi('mean |distance error|', fmtNum(r.meanAbsDistPct, '%'))}${kpi('mean |direction error|', fmtNum(r.meanAbsDirErr, '°'))}</div>
      <table><tr><th>stroke</th><th>true (cm)</th><th>estimated (cm)</th><th>distance err</th><th>direction err</th><th>end-point err</th><th>cursor travel</th></tr>
      ${r.strokes.map(s => `<tr><td>${s.label}</td><td>${Math.hypot(s.trueDx, s.trueDy).toFixed(2)}</td><td>${Math.hypot(s.estDx, s.estDy).toFixed(2)}</td><td>${s.distErrCm >= 0 ? '+' : ''}${s.distErrCm.toFixed(2)} cm (${s.distErrPct.toFixed(1)} %)</td><td>${fmtNum(s.dirErrDeg, '°')}</td><td>${s.endErrCm.toFixed(2)} cm</td><td>${s.cursorPx.toFixed(0)} px</td></tr>`).join('')}</table>
      ${strokePathSVG(r)}</div>`;
  }
  if (lastDrift) {
    h += `<div class="card chartcard"><h3>Drift test — hand still for ${lastDrift.durS} s</h3><div class="kpis">${kpi('final drift', fmtNum(lastDrift.driftCm, 'cm'))}${kpi('max drift', fmtNum(lastDrift.maxCm, 'cm'))}${kpi('cursor moved', fmtNum(lastDrift.cursorPx, 'px'))}</div>${driftSVG(lastDrift)}</div>`;
  }
  const st = session.tracker.stats();
  h += `<div class="card chartcard"><h3>Taps since last reset</h3>${confusionHTML(st.confusion, { falseN: st.falseN })}</div>`;
  if (lastAB) h += abChart(lastAB);
  if (lastAblation) h += ablationChart(lastAblation, abOpts().repeats, abOpts().driftS);
  if (!lastTarget && !lastStroke && !lastDrift && !lastAB) h = `<p class="hint">Run a test (right-hand panel) or an A/B comparison — results appear here.</p>` + h;
  $('resultsOut').innerHTML = h;
}
const kpi = (k: string, v: string) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div></div>`;

$('expImu').addEventListener('click', () => download(`imu_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, recorder.toCSV()));
$('expResults').addEventListener('click', () => {
  const L: string[] = [`# Wrist Mouse Lab results, ${new Date().toISOString()}`, `# preset-ish sensor config: ${JSON.stringify({ accelNoiseUg: S().accelNoiseUg, gyroNoiseDps: S().gyroNoiseDps, accelOffsetMg: S().accelOffsetMg, gyroOffsetDps: S().gyroOffsetDps, tilt: [S().baseRollDeg, S().basePitchDeg], wobble: S().wobbleDeg, similarity: S().tapSimilarity })}`];
  if (lastTarget) {
    L.push('', 'section,target_trials', 'trial,width_px,distance_px,id_bits,time_s,error_px,hit');
    lastTarget.trials.forEach(t => L.push([t.n, t.w, t.d.toFixed(1), t.id.toFixed(3), t.time.toFixed(3), t.err.toFixed(2), t.hit ? 1 : 0].join(',')));
    L.push('', 'section,target_summary', 'metric,value');
    Object.entries(lastTarget.summary).forEach(([k, v]) => L.push(`${k},${isFinite(v) ? v.toFixed(4) : ''}`));
  }
  if (lastStroke) {
    L.push('', 'section,stroke_test', 'stroke,true_dx_cm,true_dy_cm,est_dx_cm,est_dy_cm,dist_err_cm,dist_err_pct,dir_err_deg,endpoint_err_cm,cursor_px');
    lastStroke.strokes.forEach(s => L.push([s.label, s.trueDx, s.trueDy, s.estDx, s.estDy, s.distErrCm, s.distErrPct, s.dirErrDeg, s.endErrCm, s.cursorPx].map(v => (typeof v === 'number' ? v.toFixed(4) : v)).join(',')));
  }
  if (lastDrift) {
    L.push('', 'section,drift_test', 'metric,value', `duration_s,${lastDrift.durS}`, `drift_cm,${lastDrift.driftCm.toFixed(4)}`, `max_drift_cm,${lastDrift.maxCm.toFixed(4)}`, `cursor_px,${lastDrift.cursorPx.toFixed(2)}`);
    L.push('t_s,drift_cm'); lastDrift.series.forEach(p => L.push(`${p.t.toFixed(2)},${p.cm.toFixed(4)}`));
  }
  if (lastAB) {
    L.push('', `section,ab_${lastAB.step}`, 'metric,group,unit,A_off_mean,A_off_sd,B_on_mean,B_on_sd');
    lastAB.metrics.forEach(m => L.push([m.label, m.group, m.unit, m.a.mean, m.a.std, m.b.mean, m.b.std].map(v => (typeof v === 'number' ? v.toFixed(5) : `"${v}"`)).join(',')));
  }
  if (lastAblation) {
    L.push('', 'section,ablation', 'config,endpoint_err_cm,drift_cm,jump_px,finger_acc_pct');
    lastAblation.forEach(r => L.push([`"${r.label}"`, r.endErrCm.toFixed(4), r.driftCm.toFixed(4), r.jumpPx.toFixed(3), isFinite(r.acc) ? r.acc.toFixed(2) : ''].join(',')));
  }
  const st = session.tracker.stats();
  L.push('', 'section,taps', 'truth,pred_index,pred_pinky', `index,${st.confusion[0][0]},${st.confusion[0][1]}`, `pinky,${st.confusion[1][0]},${st.confusion[1][1]}`, `false_detections,${st.falseN}`, `missed,${st.missed}`);
  download(`results_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, L.join('\n'));
});

// ───────────────────────── boot ─────────────────────────

installTooltip();
$('plotLegend').innerHTML = plotView.legendHTML();
showOffsets();
autoTrain();
updateLiveButtons();
if (!SerialImuLink.supported) {
  $('liveInfo').textContent = 'Live input needs Chrome or Edge (Web Serial). Running the simulation.';
} else {
  // a board this page was already allowed to use becomes the input straight away
  void SerialImuLink.rememberedPort().then(p => { if (p) void startLive(p); });
}
requestAnimationFrame(t => { lastNow = t; requestAnimationFrame(rafLoop); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { invalidateTheme(); $('plotLegend').innerHTML = plotView.legendHTML(); });
// expose for debugging / scripted demos in the console
(window as unknown as { wml: object }).wml = { session, hand, recorder, sessionRec, link, get live() { return live; }, get source() { return source; }, get test() { return test; }, get target() { return target; }, injectTap, startTarget, startScripted };
