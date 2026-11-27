// Guided recording: a timed on-screen script that tells the user what to do while the live
// IMU is recorded. Two scripts: "panning" (slide between two marks 10 cm apart, with pauses)
// and "clicks" (hand stays on the paper, tap index = left click or pinky = right click).
// Every recorded sample is labelled with the step active when it was processed.
//
// All times are measured from one performance.now() reference: the countdown starts at the
// button click and every step boundary is an offset from the end of the countdown.

export type ScriptId = 'panning' | 'clicks';
export type StepKind = 'still' | 'move' | 'pause' | 'tilt' | 'click';

export interface GuideStep {
  kind: StepKind;
  section: string;   // 'start' | speed name | 'left' | 'right' | 'mixed' | 'tilt' | 'end'
  seconds: number;
  dir: 1 | -1 | 0;   // panning move direction: +1 left→right, -1 right→left, 0 for non-moves
  click: 'L' | 'R' | '';  // click steps: which button (index = L, pinky = R)
  unit: 'move' | 'click'; // what the index counts in its section
  n: number;         // index within the section (1..of); for pauses/rest, the one they follow
  of: number;        // how many in the section
  text: string;
}

export interface GuideScript {
  id: ScriptId;
  label: string;
  note: string;          // '#' comment line written at the top of a guided CSV
  steps: GuideStep[];
  starts: number[];      // start offset of each step, ms from the end of the countdown
  totalMs: number;
}

export const COUNTDOWN_S = 3;

// ── take numbers: one counter per script, kept in localStorage (memory if storage is unavailable) ──
const memTake: Partial<Record<ScriptId, number>> = {};
const takeKey = (id: ScriptId) => `wml.guideTake.${id}`;

/** The take number the next guided run of `id` will get (1 if nothing is known). */
export function nextTake(id: ScriptId): number {
  try {
    const v = Number(localStorage.getItem(takeKey(id)));
    if (Number.isInteger(v) && v >= 1) return v;
  } catch { /* storage blocked: use the in-memory value */ }
  return memTake[id] ?? 1;
}

/** Stores the next take number for `id`. */
export function storeTake(id: ScriptId, next: number): void {
  memTake[id] = next;
  try { localStorage.setItem(takeKey(id), String(next)); } catch { /* storage blocked */ }
}

/** Local date and time as YYYY-MM-DD_HH-MM-SS (file names) or YYYY-MM-DD HH:MM:SS (header). */
export function localStamp(d: Date, sep: '_' | ' ' = '_'): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = sep === '_' ? `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}` : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${date}${sep}${time}`;
}

/** <script>_take<NN>_<YYYY-MM-DD>_<HH-MM-SS>[_aborted].csv, with the local start time. */
export function guideFileName(id: ScriptId, take: number, started: Date, aborted: boolean): string {
  return `${id}_take${String(take).padStart(2, '0')}_${localStamp(started)}${aborted ? '_aborted' : ''}.csv`;
}

function step(p: Partial<GuideStep> & Pick<GuideStep, 'kind' | 'section' | 'seconds' | 'text'>): GuideStep {
  return { dir: 0, click: '', unit: 'move', n: 0, of: 0, ...p };
}

function makeScript(id: ScriptId, label: string, note: string, steps: GuideStep[]): GuideScript {
  const starts: number[] = [];
  let total = 0;
  for (const s of steps) { starts.push(total); total += s.seconds * 1000; }
  return { id, label, note, steps, starts, totalMs: total };
}

// ── panning v1 ──────────────────────────────────────────────────────────────
const SPEEDS: { name: string; move: number }[] = [
  { name: 'quick', move: 0.3 },
  { name: 'normal', move: 0.6 },
  { name: 'slow', move: 1.5 },
  { name: 'very-slow', move: 3.5 },
];
const MOVES_PER_SPEED = 6;
const PAUSE_S = 1.5;   // hold after every move
const REST_S = 4;      // extra still step after the last pause of each speed

function panningSteps(): GuideStep[] {
  const steps: GuideStep[] = [
    step({ kind: 'still', section: 'start', seconds: 5, text: 'Hold still on the LEFT mark' }),
  ];
  for (const sp of SPEEDS) {
    for (let m = 1; m <= MOVES_PER_SPEED; m++) {
      const dir: 1 | -1 = m % 2 === 1 ? 1 : -1;
      steps.push(step({ kind: 'move', section: sp.name, seconds: sp.move, dir, n: m, of: MOVES_PER_SPEED, text: dir > 0 ? 'Move RIGHT →' : '← Move LEFT' }));
      steps.push(step({ kind: 'pause', section: sp.name, seconds: PAUSE_S, n: m, of: MOVES_PER_SPEED, text: `Hold still on the ${dir > 0 ? 'RIGHT' : 'LEFT'} mark` }));
    }
    steps.push(step({ kind: 'still', section: sp.name, seconds: REST_S, n: MOVES_PER_SPEED, of: MOVES_PER_SPEED, text: 'Rest on the LEFT mark' }));
  }
  steps.push(step({ kind: 'tilt', section: 'tilt', seconds: 8, text: 'Rock your wrist slowly (left/right, up/down) — do NOT slide' }));
  steps.push(step({ kind: 'still', section: 'end', seconds: 5, text: 'Hold still — finishing' }));
  return steps;
}

// ── clicks v1 ───────────────────────────────────────────────────────────────
const CLICK_S = 1.0;
const CLICK_PAUSE_S = 1.5;
const CLICKS_PER_SECTION = 10;
const MIXED_CLICKS = 20;
const CLICK_TEXT: Record<'L' | 'R', string> = { L: 'TAP with INDEX finger (LEFT click)', R: 'TAP with PINKY finger (RIGHT click)' };
export const CLICK_BIG: Record<'L' | 'R', string> = { L: 'LEFT · INDEX', R: 'RIGHT · PINKY' };

/** Fixed-seed PRNG (mulberry32) so the mixed order is the same in every run. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clickSection(name: string, order: ('L' | 'R')[]): GuideStep[] {
  const out: GuideStep[] = [];
  order.forEach((c, i) => {
    out.push(step({ kind: 'click', section: name, seconds: CLICK_S, click: c, unit: 'click', n: i + 1, of: order.length, text: CLICK_TEXT[c] }));
    out.push(step({ kind: 'pause', section: name, seconds: CLICK_PAUSE_S, unit: 'click', n: i + 1, of: order.length, text: 'Relax, hand still' }));
  });
  out.push(step({ kind: 'still', section: name, seconds: REST_S, unit: 'click', n: order.length, of: order.length, text: 'Rest your hand still' }));
  return out;
}

function clicksSteps(): GuideStep[] {
  const left: ('L' | 'R')[] = Array(CLICKS_PER_SECTION).fill('L');
  const right: ('L' | 'R')[] = Array(CLICKS_PER_SECTION).fill('R');
  const mixed: ('L' | 'R')[] = [...Array(MIXED_CLICKS / 2).fill('L'), ...Array(MIXED_CLICKS / 2).fill('R')];
  const rnd = seededRandom(1);
  for (let i = mixed.length - 1; i > 0; i--) {  // Fisher–Yates
    const j = Math.floor(rnd() * (i + 1));
    [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
  }
  return [
    step({ kind: 'still', section: 'start', seconds: 5, text: 'Rest your hand still' }),
    ...clickSection('left', left),
    ...clickSection('right', right),
    ...clickSection('mixed', mixed),
    step({ kind: 'still', section: 'end', seconds: 5, text: 'Hold still — finishing' }),
  ];
}

export const GUIDE_SCRIPTS: Record<ScriptId, GuideScript> = {
  panning: makeScript('panning', 'Panning (L/R, 4 speeds)',
    `# guide: panning v1, 10 cm, moves ${SPEEDS.map(s => `${s.name} ${s.move}`).join('/')} s, pause ${PAUSE_S} s, rest ${REST_S} s`,
    panningSteps()),
  clicks: makeScript('clicks', 'Clicks (index = left, pinky = right)',
    `# guide: clicks v1, hand still on the paper, tap ${CLICK_S} s, pause ${CLICK_PAUSE_S} s, rest ${REST_S} s, left ${CLICKS_PER_SECTION} L, right ${CLICKS_PER_SECTION} R, mixed ${MIXED_CLICKS / 2} L + ${MIXED_CLICKS / 2} R shuffled (seed 1)`,
    clicksSteps()),
};

/** Index of the step active at `relMs` after the countdown ended, or -1 outside the script. */
function stepAt(sc: GuideScript, relMs: number): number {
  if (relMs < 0 || relMs >= sc.totalMs) return -1;
  let lo = 0, hi = sc.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sc.starts[mid] <= relMs) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

export interface GuideHooks {
  /** Called when the countdown ends: start the CSV recording now, labelled with this script. */
  startRecording: (script: GuideScript) => void;
  /** Called when the script ends (aborted = false) or is stopped early (true): stop and save the CSV (no-op if not recording). */
  stopRecording: (aborted: boolean) => void;
}

interface Run {
  script: GuideScript;
  scriptStart: number;   // performance.now() when step 1 begins
  end: number;           // performance.now() when the script ends
  recording: boolean;
  raf: number;
  timers: number[];
  master: GainNode | null;
}

interface View {
  panel: 'count' | 'move' | 'pause' | 'tilt' | 'clickL' | 'clickR';
  head: string;
  text: string;
  time: number;          // seconds left in the current step
  next: string;
  pace: number | null;   // 0..1 position of the pacing dot, null when not a move
  overall: number;       // 0..1 of the whole script
}

function panelOf(s: GuideStep): View['panel'] {
  if (s.kind === 'click') return s.click === 'L' ? 'clickL' : 'clickR';
  if (s.kind === 'move') return 'move';
  if (s.kind === 'tilt') return 'tilt';
  return 'pause';
}

function headLabel(s: GuideStep): string {
  const sec = s.section.toUpperCase();
  const unit = s.unit;
  if (s.kind === 'move' || s.kind === 'click') return `${sec} · ${unit} ${s.n} / ${s.of}`;
  if (s.kind === 'pause') return `${sec} · pause after ${unit} ${s.n} / ${s.of}`;
  if (s.kind === 'still' && s.section !== 'start' && s.section !== 'end') return `${sec} · rest`;
  return sec;
}

function beep(ctx: AudioContext, dest: AudioNode, at: number, freq: number, ms: number, peak = 0.35): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const d = ms / 1000;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.005);
  g.gain.setValueAtTime(peak, at + Math.max(0.006, d - 0.01));
  g.gain.linearRampToValueAtTime(0, at + d);
  osc.connect(g).connect(dest);
  osc.start(at);
  osc.stop(at + d + 0.01);
}

/** Pitch of the beep at the start of a step: high for panning moves, L/R pitches for clicks, low otherwise. */
function beepFreq(s: GuideStep): number {
  if (s.kind === 'click') return s.click === 'L' ? 990 : 660;
  return s.kind === 'move' ? 880 : 440;
}

export class PanningGuide {
  private run: Run | null = null;
  private audio: AudioContext | null = null;
  private available = false;
  private last: Record<string, string> = {};
  private readonly hooks: GuideHooks;
  private readonly btn = byId<HTMLButtonElement>('guideBtn');
  private readonly select = byId<HTMLSelectElement>('guideScript');
  private readonly sound = byId<HTMLInputElement>('guideSound');
  private readonly overlay = byId<HTMLElement>('guideOverlay');
  private readonly panel = byId<HTMLElement>('guidePanel');
  private readonly head = byId<HTMLElement>('guideHead');
  private readonly text = byId<HTMLElement>('guideText');
  private readonly time = byId<HTMLElement>('guideTime');
  private readonly pace = byId<HTMLElement>('guidePace');
  private readonly dot = byId<HTMLElement>('guideDot');
  private readonly next = byId<HTMLElement>('guideNext');
  private readonly bar = byId<HTMLElement>('guideBar');
  private readonly stopBtn = byId<HTMLButtonElement>('guideStop');
  private readonly takeInfo = byId<HTMLElement>('guideTake');
  private readonly takeReset = byId<HTMLButtonElement>('guideTakeReset');

  constructor(hooks: GuideHooks) {
    this.hooks = hooks;
    this.btn.addEventListener('click', () => { if (this.run) this.abort(); else this.start(); });
    this.stopBtn.addEventListener('click', () => this.abort());
    this.sound.addEventListener('change', () => {
      if (this.run?.master) this.run.master.gain.value = this.sound.checked ? 1 : 0;
    });
    this.select.addEventListener('change', () => this.refreshTakes());
    this.takeReset.addEventListener('click', () => {
      for (const id of Object.keys(GUIDE_SCRIPTS) as ScriptId[]) storeTake(id, 1);
      this.refreshTakes();
    });
    this.refreshTakes();
  }

  /** Shows the next take number of the selected script. */
  refreshTakes(): void {
    const id = this.select.value as ScriptId;
    this.takeInfo.textContent = `next: take ${String(nextTake(id)).padStart(2, '0')}`;
    this.takeReset.disabled = this.run !== null;
  }

  /** The script that the Start button would run now. */
  get selected(): GuideScript {
    return GUIDE_SCRIPTS[(this.select.value as ScriptId)] ?? GUIDE_SCRIPTS.panning;
  }

  get running(): boolean { return this.run !== null; }

  /** Enables the button only while the live IMU is connected (a run in progress keeps it enabled). */
  setAvailable(ok: boolean): void {
    this.available = ok;
    this.btn.disabled = !ok && !this.run;
  }

  /** Starts the countdown of the selected script; recording and the script begin when it ends. Must run from a click (AudioContext). */
  start(): void {
    if (this.run || !this.available) return;
    const script = this.selected;
    const t0 = performance.now();
    const r: Run = {
      script,
      scriptStart: t0 + COUNTDOWN_S * 1000,
      end: t0 + COUNTDOWN_S * 1000 + script.totalMs,
      recording: false, raf: 0, timers: [], master: null,
    };
    this.run = r;
    this.last = {};
    this.scheduleSounds(r, t0);
    r.timers.push(window.setTimeout(() => this.beginRecording(), r.scriptStart - performance.now()));
    r.timers.push(window.setTimeout(() => this.finish(false), r.end - performance.now()));
    this.overlay.classList.remove('hidden');
    this.btn.textContent = '■ Stop guide';
    this.btn.classList.add('recording');
    this.btn.disabled = false;
    this.select.disabled = true;
    this.refreshTakes();
    r.raf = requestAnimationFrame(this.frame);
  }

  /** Ends the run now: stops recording, saves the CSV and closes the overlay. */
  abort(): void { this.finish(true); }

  /** Label for a sample processed at `now` (performance.now()): index into the running script's steps, or -1. */
  stepIndexAt(now: number): number {
    const r = this.run;
    if (!r || now < r.scriptStart || now >= r.end) return -1;
    return stepAt(r.script, now - r.scriptStart);
  }

  private scheduleSounds(r: Run, t0: number): void {
    try {
      this.audio ??= new AudioContext();
      void this.audio.resume();
      const ctx = this.audio;
      const master = ctx.createGain();
      master.gain.value = this.sound.checked ? 1 : 0;
      master.connect(ctx.destination);
      r.master = master;
      // times are scheduled on the audio clock, so they don't drift with the display
      const at = (ms: number) => ctx.currentTime + (t0 + ms - performance.now()) / 1000;
      for (let k = 0; k < COUNTDOWN_S; k++) beep(ctx, master, at(k * 1000), 1000, 40, 0.25);
      r.script.steps.forEach((s, i) => {
        beep(ctx, master, at(COUNTDOWN_S * 1000 + r.script.starts[i]), beepFreq(s), 80);
      });
    } catch {
      /* no audio available: the guide still runs silently */
    }
  }

  private beginRecording(): void {
    const r = this.run;
    if (!r || r.recording) return;
    r.recording = true;
    this.hooks.startRecording(r.script);
  }

  private finish(aborted: boolean): void {
    const r = this.run;
    if (!r) return;
    this.run = null; // cleared first: the stop hook may call back into the recorder
    cancelAnimationFrame(r.raf);
    r.timers.forEach(t => clearTimeout(t));
    r.master?.disconnect(); // drops any beeps still queued for this run
    this.overlay.classList.add('hidden');
    this.btn.textContent = '▶ Start guided recording';
    this.btn.classList.remove('recording');
    this.btn.disabled = !this.available;
    this.select.disabled = false;
    this.refreshTakes();
    this.hooks.stopRecording(aborted);
  }

  private frame = (): void => {
    const r = this.run;
    if (!r) return;
    this.render(r, performance.now());
    r.raf = requestAnimationFrame(this.frame);
  };

  private render(r: Run, now: number): void {
    const sc = r.script;
    if (now < r.scriptStart) {
      this.show({
        panel: 'count', head: 'GET READY', text: 'Get ready', time: (r.scriptStart - now) / 1000,
        next: `Next: ${sc.steps[0].text}`, pace: null, overall: 0,
      });
      return;
    }
    const rel = now - r.scriptStart;
    const i = stepAt(sc, rel);
    if (i < 0) return; // the end timer finishes the run
    const s = sc.steps[i];
    const inStep = rel - sc.starts[i];
    const stepMs = s.seconds * 1000;
    const p = Math.min(1, inStep / stepMs);
    const isClick = s.kind === 'click';
    this.show({
      panel: panelOf(s),
      head: headLabel(s),
      text: isClick ? CLICK_BIG[s.click as 'L' | 'R'] : s.text,
      time: (stepMs - inStep) / 1000,
      next: `Next: ${i + 1 < sc.steps.length ? sc.steps[i + 1].text : 'end of script'}`,
      pace: s.kind === 'move' ? (s.dir > 0 ? p : 1 - p) : null,
      overall: rel / sc.totalMs,
    });
  }

  /** Writes only what changed since the last frame. */
  private show(v: View): void {
    this.put('panel', `guide-panel ${v.panel}`, t => { this.panel.className = t; });
    this.put('head', v.head, t => { this.head.textContent = t; });
    this.put('text', v.text, t => { this.text.textContent = t; });
    this.put('time', `${Math.max(0, v.time).toFixed(1)} s`, t => { this.time.textContent = t; });
    this.put('next', v.next, t => { this.next.textContent = t; });
    this.put('pace', v.pace === null ? 'hide' : 'show', t => this.pace.classList.toggle('hidden', t === 'hide'));
    if (v.pace !== null) this.put('dot', `${(v.pace * 100).toFixed(2)}%`, t => { this.dot.style.left = t; });
    this.put('bar', `${(Math.min(1, v.overall) * 100).toFixed(2)}%`, t => { this.bar.style.width = t; });
  }

  private put(key: string, value: string, apply: (v: string) => void): void {
    if (this.last[key] === value) return;
    this.last[key] = value;
    apply(value);
  }
}
