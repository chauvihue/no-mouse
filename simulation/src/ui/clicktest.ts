// Click tester: checks the left (index) and right (pinky) click detector live on the real IMU.
// It runs the streaming detector and models that scripts/train-clicks.ts fits
// (algorithms/clicks/detector.ts, algorithms/clicks/model.ts), fed beside the normal live pipeline, which is
// not changed. Opened from the Live IMU card while the ESP32 is connected. "Teach" adapts the detector to
// the user (algorithms/clicks/teach.ts) and keeps the result in localStorage.

import { DECISION_DELAY_S } from '../../../algorithms/clicks/detector.ts';
import type { ClickDetector, ClickEvent, ClickProfile, ImuReading, Side } from '../../../algorithms/clicks/detector.ts';
import { ClickEngine } from '../../../algorithms/clicks/engine.ts';
import { CLICK_MODEL } from '../../../algorithms/clicks/model.ts';
import { buildProfile, parseProfile } from '../../../algorithms/clicks/teach.ts';
import type { TeachSummary } from '../../../algorithms/clicks/teach.ts';
import { theme } from './theme.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const STRIP_S = 3;          // seconds shown in the live strip
const PROMPT_EVERY_S = 2.5; // quiz: time between prompts
const PROMPT_WIN_S = 1.5;   // quiz: a click counts for a prompt if it peaks within this window
const LABEL: Record<Side, string> = { L: 'LEFT · index', R: 'RIGHT · pinky' };
const SIDE_WORD: Record<Side, string> = { L: 'LEFT', R: 'RIGHT' };
const BEEP_HZ: Record<Side, number> = { L: 990, R: 660 }; // same pitches as the guided recording

interface Prompt { side: Side; t: number; hit: ClickEvent | null; done: boolean }
interface Result { truth: Side; pred: Side | 'missed' }

// Teach: 5 index taps, 5 pinky taps, a still hand, a moving hand. Times are device seconds.
type TeachKind = 'ready' | 'L' | 'R' | 'still' | 'move';
interface TeachStep { kind: TeachKind; dur: number; text: string; t0: number }
const TEACH_TAP_S = 2.2;        // one tap prompt; the tap may land up to ~1.4 s after the beep
const TEACH_SKIP_S = 0.4;       // events this soon after a still/move step starts are ignored
const TEACH_KEY = 'wml.clickProfile.v1';
interface Teach { steps: TeachStep[]; end: number; events: ClickEvent[]; prevSens: number }
interface Stored { profile: ClickProfile; summary: TeachSummary; taught: string }

function loadStored(): Stored | null {
  if (!CLICK_MODEL) return null;
  try {
    const raw = localStorage.getItem(TEACH_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { profile?: unknown; summary?: TeachSummary; taught?: string };
    const profile = parseProfile(o.profile, CLICK_MODEL);
    return profile && o.summary ? { profile, summary: o.summary, taught: String(o.taught ?? '') } : null;
  } catch { return null; }
}
function saveStored(v: Stored | null): void {
  try {
    if (v) localStorage.setItem(TEACH_KEY, JSON.stringify(v)); else localStorage.removeItem(TEACH_KEY);
  } catch { /* storage blocked: the profile lasts until the page closes */ }
}

/** One short tone, same envelope as the guided recording's beeps. */
function beepTone(ctx: AudioContext, freq: number): void {
  const at = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.3, at + 0.005);
  g.gain.setValueAtTime(0.3, at + 0.11);
  g.gain.linearRampToValueAtTime(0, at + 0.12);
  osc.connect(g).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.13);
}

export class ClickTester {
  private readonly btn = $<HTMLButtonElement>('clickTestBtn');
  private readonly overlay = $('clickOverlay');
  private readonly sensInput = $<HTMLInputElement>('ctSens');
  private readonly quizBox = $<HTMLInputElement>('ctQuiz');
  private readonly soundBox = $<HTMLInputElement>('ctSound');
  private readonly strip = $<HTMLCanvasElement>('ctStrip');

  private open = false;
  private readonly engine = new ClickEngine();
  private det: ClickDetector | null = null;   // the engine's detector, once the first reading has arrived
  private stored: Stored | null = loadStored();
  private teach: Teach | null = null;
  private lastT = 0;                       // device time of the newest reading
  private raf = 0;
  private counts: Record<Side, number> = { L: 0, R: 0 };
  private last: ClickEvent | null = null;
  private markers: { t: number; side: Side }[] = [];
  private quiz = { on: false, next: 0, prompt: null as Prompt | null, results: [] as Result[], extra: 0 };
  private audio: AudioContext | null = null;

  constructor() {
    this.btn.addEventListener('click', () => this.openTester());
    $('ctClose').addEventListener('click', () => this.close());
    $('ctRecal').addEventListener('click', () => this.det?.recalibrate());
    $('ctTeach').addEventListener('click', () => { if (this.teach) this.endTeach(false); else this.startTeach(); });
    $('ctForget').addEventListener('click', () => this.forget());
    this.engine.setProfile(this.stored?.profile ?? null);
    $('ctReset').addEventListener('click', () => this.resetStats());
    this.sensInput.addEventListener('input', () => {
      const v = Number(this.sensInput.value);
      if (!this.teach) this.engine.setSensitivity(v);
      $('ctSensV').textContent = `${v.toFixed(2)}×`;
    });
    this.quizBox.addEventListener('change', () => this.setQuiz(this.quizBox.checked));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) this.close(); });
    this.renderScore();
  }

  /** Enabled only while the live IMU is connected (like the guided recording button). */
  setAvailable(ok: boolean): void {
    this.btn.disabled = !ok;
    if (!ok) this.close();
  }

  /** Called for every live reading that goes through the pipeline. rateHz is the measured board rate. */
  feed(s: ImuReading, rateHz: number): void {
    if (!this.open || !(rateHz > 0)) return;
    const e = this.engine.feed(s, rateHz);
    this.det = this.engine.det;
    this.lastT = s.t;
    if (this.teach) this.teachTick(s.t);
    if (this.quiz.on) this.quizTick(s.t);
    if (!e) return;
    if (this.teach) this.teach.events.push(e);   // teaching sees every candidate, accepted or not, and counts none as clicks
    else this.onClick(e);
  }

  private openTester(): void {
    if (this.open || this.btn.disabled) return;
    this.open = true;
    this.engine.reset();
    this.engine.setSensitivity(Number(this.sensInput.value));
    this.det = null;
    this.resetStats();
    this.showTeachInfo();
    this.overlay.classList.remove('hidden');
    this.raf = requestAnimationFrame(this.frame);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    cancelAnimationFrame(this.raf);
    this.overlay.classList.add('hidden');
    if (this.teach) this.endTeach(false);
    this.engine.reset();
    this.det = null;
    this.quiz.on = false;
    this.quiz.prompt = null;
    this.quizBox.checked = false;
  }

  private readonly frame = (): void => {
    if (!this.open) return;
    this.render();
    this.raf = requestAnimationFrame(this.frame);
  };

  private onClick(e: ClickEvent): void {
    this.counts[e.side]++;
    this.last = e;
    this.markers.push({ t: e.t, side: e.side });
    this.markers = this.markers.filter(m => m.t > this.lastT - STRIP_S - 1);
    this.flash(e.side);
    if (this.quiz.on) {
      const p = this.quiz.prompt;
      if (p && e.t >= p.t && e.t <= p.t + PROMPT_WIN_S) {
        if (!p.hit) p.hit = e;
      } else {
        this.quiz.extra++;
        this.renderScore();
      }
    }
  }

  // ── quiz ──────────────────────────────────────────────────────────────────

  private setQuiz(on: boolean): void {
    if (on && this.teach) { this.quizBox.checked = false; return; }
    this.quiz.on = on;
    this.quiz.prompt = null;
    this.quiz.next = 0;
    if (on) {
      try {
        this.audio ??= new AudioContext();   // created from the checkbox click, so audio is allowed
        void this.audio.resume();
      } catch { /* no audio: prompts are shown without beeps */ }
    }
    this.renderScore();
  }

  /** Starts a prompt every PROMPT_EVERY_S of device time, and scores each one once its window is over. */
  private quizTick(t: number): void {
    const q = this.quiz;
    if (!this.det || this.det.calibrating) return;
    const p = q.prompt;
    if (p && !p.done && t >= p.t + PROMPT_WIN_S + DECISION_DELAY_S + 0.05) {
      p.done = true;
      q.results.push({ truth: p.side, pred: p.hit ? p.hit.side : 'missed' });
      this.renderScore();
    }
    if (t >= q.next) {
      const side: Side = Math.random() < 0.5 ? 'L' : 'R';
      q.prompt = { side, t, hit: null, done: false };
      q.next = t + PROMPT_EVERY_S;
      if (this.soundBox.checked && this.audio) {
        try { beepTone(this.audio, BEEP_HZ[side]); } catch { /* audio blocked */ }
      }
    }
  }

  private renderScore(): void {
    const r = this.quiz.results;
    const n = r.length;
    const ok = r.filter(x => x.pred === x.truth).length;
    const wrong = r.filter(x => x.pred !== 'missed' && x.pred !== x.truth).length;
    const missed = r.filter(x => x.pred === 'missed').length;
    const cell = (truth: Side, pred: Side | 'missed') => r.filter(x => x.truth === truth && x.pred === pred).length;
    const head = n
      ? `Quiz accuracy ${(100 * ok / n).toFixed(0)} % (${ok}/${n} correct · ${wrong} wrong side · ${missed} missed) · ${this.quiz.extra} extra click${this.quiz.extra === 1 ? '' : 's'} outside the windows`
      : `Quiz: no prompts scored yet${this.quiz.extra ? ` · ${this.quiz.extra} extra click${this.quiz.extra === 1 ? '' : 's'} outside the windows` : ''}`;
    const row = (truth: Side) => `<tr><th>${SIDE_WORD[truth]}</th><td>${cell(truth, 'L')}</td><td>${cell(truth, 'R')}</td><td>${cell(truth, 'missed')}</td></tr>`;
    $('ctScore').innerHTML = `<div>${head}</div>` + (n
      ? `<table class="ct-conf"><tr><th>prompt \\ heard</th><th>LEFT</th><th>RIGHT</th><th>missed</th></tr>${row('L')}${row('R')}</table>`
      : '');
  }

  // ── teach ─────────────────────────────────────────────────────────────────

  private startTeach(): void {
    const det = this.det;
    if (!CLICK_MODEL || !det || det.calibrating) { $('ctTeachInfo').textContent = 'Wait for the start-up to finish, then press Teach again.'; return; }
    this.quizBox.checked = false;
    this.setQuiz(false);
    try {
      this.audio ??= new AudioContext();
      void this.audio.resume();
    } catch { /* no audio: the prompts are shown without beeps */ }
    const steps: TeachStep[] = [{ kind: 'ready', dur: 2, text: 'Rest your hand on the desk', t0: 0 }];
    for (const side of ['L', 'R'] as const) {
      for (let k = 1; k <= 5; k++) steps.push({ kind: side, dur: TEACH_TAP_S, text: `Tap ${LABEL[side]} (${k}/5)`, t0: 0 });
    }
    steps.push({ kind: 'still', dur: 3, text: 'Keep the hand completely still', t0: 0 });
    steps.push({ kind: 'move', dur: 3, text: 'Lift, slide and rotate your hand around — no taps', t0: 0 });
    let t = this.lastT + 0.5;
    for (const st of steps) { st.t0 = t; t += st.dur; }
    // every candidate is wanted while teaching: lower the amplitude floor, relax the gate, return refused ones too
    this.teach = { steps, end: t, events: [], prevSens: this.engine.sensitivity };
    this.engine.sensitivity = 2;
    this.engine.setSensitivity(2);
    this.engine.setProfile({ ampMinG: 0.03 });
    det.rejectedEvents = true;
    this.beepedStep = -1;
    this.markers = [];
    $('ctTeach').textContent = 'Cancel teaching';
  }

  private beepedStep = -1;

  private teachStepAt(t: number): number {
    const tc = this.teach!;
    for (let i = tc.steps.length - 1; i >= 0; i--) if (t >= tc.steps[i].t0) return i;
    return -1;
  }

  private teachTick(t: number): void {
    const tc = this.teach;
    if (!tc) return;
    const i = this.teachStepAt(t);
    if (i >= 0 && i !== this.beepedStep) {
      this.beepedStep = i;
      const k = tc.steps[i].kind;
      if ((k === 'L' || k === 'R') && this.soundBox.checked && this.audio) {
        try { beepTone(this.audio, BEEP_HZ[k]); } catch { /* audio blocked */ }
      }
    }
    if (t >= tc.end + DECISION_DELAY_S + 0.05) this.endTeach(true);
  }

  /** Stops teaching; with `finished` the events collected are turned into a profile and saved. */
  private endTeach(finished: boolean): void {
    const tc = this.teach;
    if (!tc) return;
    this.teach = null;
    $('ctTeach').textContent = 'Teach…';
    if (this.det) this.det.rejectedEvents = false;
    this.engine.setProfile(this.stored?.profile ?? null);
    this.engine.setSensitivity(tc.prevSens);
    if (!finished || !CLICK_MODEL) { this.showTeachInfo(finished ? '' : 'Teaching cancelled.'); return; }

    const taps: { side: Side; ev: ClickEvent }[] = [];
    const negatives: ClickEvent[] = [];
    for (const st of tc.steps) {
      const inStep = tc.events.filter(e => e.t >= st.t0 && e.t < st.t0 + st.dur);
      if (st.kind === 'L' || st.kind === 'R') {
        if (inStep.length) taps.push({ side: st.kind, ev: inStep.reduce((a, e) => (e.peakG > a.peakG ? e : a)) });
      } else if (st.kind === 'still' || st.kind === 'move') {
        negatives.push(...inStep.filter(e => e.t >= st.t0 + TEACH_SKIP_S));
      }
    }
    const nL = taps.filter(x => x.side === 'L').length, nR = taps.filter(x => x.side === 'R').length;
    if (nL < 3 || nR < 3) {
      this.showTeachInfo(`Teaching failed: heard ${nL} index and ${nR} pinky taps (need at least 3 of each). The previous setting is kept — try again with firmer taps or a higher sensitivity.`);
      return;
    }
    const { profile, summary } = buildProfile(CLICK_MODEL, { taps, negatives });
    this.stored = { profile, summary, taught: new Date().toISOString() };
    saveStored(this.stored);
    this.engine.setProfile(profile);
    this.showTeachInfo();
  }

  private forget(): void {
    if (this.teach) this.endTeach(false);
    this.stored = null;
    saveStored(null);
    this.engine.setProfile(null);
    this.showTeachInfo('Back to the trained default.');
  }

  private showTeachInfo(note = ''): void {
    const st = this.stored;
    let text = st
      ? (() => {
        const s = st.summary;
        const g = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)} g`);
        return `Personal setting taught ${st.taught.slice(0, 16).replace('T', ' ')} UTC: index ${g(s.peakL)} (${s.nL} taps), pinky ${g(s.peakR)} (${s.nR} taps), ${s.nNeg} non-tap events seen, tap test ${s.gateShift >= 0 ? '+' : ''}${s.gateShift.toFixed(1)}, amplitude floor ${s.ampMinG.toFixed(3)} g${s.overlap ? ' — some non-taps looked like your softest tap, so those may still count' : ''}.`;
      })()
      : (CLICK_MODEL ? 'Using the trained default. Teach… adapts it to you in about 40 s.' : 'No trained model: run npm run train:clicks.');
    if (note) text = `${note} ${text}`;
    $('ctTeachInfo').textContent = text;
    $('ctForget').classList.toggle('hidden', !st);
    ($('ctTeach') as HTMLButtonElement).disabled = !CLICK_MODEL;
  }

  // ── per-frame drawing ─────────────────────────────────────────────────────

  private resetStats(): void {
    this.counts = { L: 0, R: 0 };
    this.last = null;
    this.markers = [];
    this.quiz.results = [];
    this.quiz.extra = 0;
    this.quiz.prompt = null;
    this.quiz.next = 0;
    this.renderScore();
  }

  private flash(side: Side): void {
    const pad = $(side === 'L' ? 'ctLeft' : 'ctRight');
    pad.classList.add('hit');
    setTimeout(() => pad.classList.remove('hit'), 350);
  }

  private render(): void {
    const det = this.det;
    const calibrating = !det || det.calibrating;
    $('ctCal').classList.toggle('hidden', !calibrating);
    $('ctCalBar').style.width = `${(det ? det.calibrationProgress() : 0) * 100}%`;

    let state = 'Waiting for readings…';
    if (det && calibrating) state = 'Starting up · rest the hand';
    else if (det) {
      const noise = det.noiseUnitG();
      state = `Live · ${det.fs} Hz · peak threshold ${det.threshold().toFixed(3)} g · noise ${noise === null ? '—' : noise.toFixed(4)} g · ${this.stored ? 'personal setting' : 'trained default'}`;
    }
    $('ctState').textContent = state;

    $('ctLeftN').textContent = String(this.counts.L);
    $('ctRightN').textContent = String(this.counts.R);
    $('ctLast').textContent = this.last
      ? `Last: ${LABEL[this.last.side]} · peak ${this.last.peakG.toFixed(2)} g · confidence ${(this.last.prob * 100).toFixed(0)}% · ${(this.lastT - this.last.t).toFixed(1)} s ago`
      : 'No click yet.';

    const prompt = $('ctPrompt');
    prompt.classList.toggle('hidden', !this.quiz.on && !this.teach);
    const p = this.quiz.prompt;
    if (this.teach) {
      const i = this.teachStepAt(this.lastT);
      const st = i >= 0 ? this.teach.steps[i] : null;
      prompt.className = `ct-prompt${st && (st.kind === 'L' || st.kind === 'R') ? ' ' + st.kind.toLowerCase() : ''}`;
      prompt.textContent = st ? `Teach ${Math.max(0, i)}/${this.teach.steps.length - 1} · ${st.text}` : 'Teach: get ready…';
    } else if (this.quiz.on) {
      prompt.className = `ct-prompt${p ? ' ' + p.side.toLowerCase() : ''}`;
      prompt.textContent = !p ? (calibrating ? 'Quiz starts after calibration' : 'Get ready…')
        : !p.done ? `Click ${LABEL[p.side]} now`
          : p.hit ? (p.hit.side === p.side ? `✓ ${SIDE_WORD[p.side]} counted` : `✕ heard ${SIDE_WORD[p.hit.side]}, wanted ${SIDE_WORD[p.side]}`)
            : `✕ missed (wanted ${SIDE_WORD[p.side]})`;
    }
    this.drawStrip();
  }

  private drawStrip(): void {
    const cv = this.strip;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    if (!g || !this.det) return;
    const t = theme();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const { t: ts, acc: acc5 } = this.det.recent(STRIP_S);
    const thr = this.det.threshold();
    const tEnd = this.lastT, tStart = tEnd - STRIP_S;
    let top = 0;
    for (const v of acc5) if (v > top) top = v;
    if (isFinite(thr)) top = Math.max(top, thr * 2);
    top = top > 0 ? top * 1.1 : 1;
    const X = (x: number) => ((x - tStart) / STRIP_S) * w;
    const Y = (v: number) => h - 16 - (v / top) * (h - 24);

    // grid: the baseline and the top of the scale
    g.strokeStyle = t.grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, h - 16 + 0.5); g.lineTo(w, h - 16 + 0.5);
    g.stroke();

    // tap-band accel magnitude trace
    g.strokeStyle = t.ink2;
    g.lineWidth = 1.2;
    g.beginPath();
    for (let k = 0; k < ts.length; k++) {
      const x = X(ts[k]), y = Y(acc5[k]);
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();

    // detection threshold
    if (isFinite(thr)) {
      g.strokeStyle = t.warn;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(0, Y(thr)); g.lineTo(w, Y(thr));
      g.stroke();
      g.setLineDash([]);
    }

    // detected taps, coloured by side
    g.font = '600 11px system-ui, sans-serif';
    g.textBaseline = 'top';
    for (const m of this.markers) {
      if (m.t < tStart) continue;
      const x = X(m.t);
      const col = m.side === 'L' ? t.s7 : t.s5;
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x, h - 16);
      g.stroke();
      g.fillStyle = col;
      g.textAlign = x > w - 14 ? 'right' : 'left';
      g.fillText(m.side, x + (x > w - 14 ? -4 : 4), 2);
    }
    g.fillStyle = t.muted;
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.fillText('-3 s', 4, h - 2);
    g.textAlign = 'right';
    g.fillText('now', w - 4, h - 2);
  }
}
