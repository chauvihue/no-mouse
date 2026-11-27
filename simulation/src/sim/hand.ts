// True hand motion sources: (a) a smooth hand that follows the real mouse,
// (b) scripted, exactly repeatable strokes with a minimum-jerk profile.

/**
 * The hand follows the mouse target through two cascaded critically-damped
 * 2nd-order stages (ω each). Mouse events arrive at ~60–120 Hz in steps; this
 * gives a smooth, physically plausible 1 kHz trajectory with continuous
 * acceleration (a hand can't teleport, and its jerk is bounded).
 */
export class HandModel {
  omega: number;
  maxAccel = 25;   // m/s² (~2.5 g) — a fast but human flick
  maxSpeed = 1.5;  // m/s
  x = [0, 0]; // stage-2 output = true hand position (m)
  private x1 = [0, 0];
  private v1 = [0, 0];
  private v2 = [0, 0];
  constructor(omega = 45) { this.omega = omega; }

  setPosition(x: number, y: number): void {
    this.x = [x, y]; this.x1 = [x, y]; this.v1 = [0, 0]; this.v2 = [0, 0];
  }

  step(tx: number, ty: number, dt: number): [number, number] {
    const w = this.omega, w2 = w * w;
    const t = [tx, ty];
    // stage 1: critically damped, with the acceleration (vector) and speed limited
    let a1x = w2 * (t[0] - this.x1[0]) - 2 * w * this.v1[0];
    let a1y = w2 * (t[1] - this.x1[1]) - 2 * w * this.v1[1];
    const am = Math.hypot(a1x, a1y);
    if (am > this.maxAccel) { a1x *= this.maxAccel / am; a1y *= this.maxAccel / am; }
    this.v1[0] += a1x * dt; this.v1[1] += a1y * dt;
    const vm = Math.hypot(this.v1[0], this.v1[1]);
    if (vm > this.maxSpeed) { this.v1[0] *= this.maxSpeed / vm; this.v1[1] *= this.maxSpeed / vm; }
    this.x1[0] += this.v1[0] * dt; this.x1[1] += this.v1[1] * dt;
    for (let i = 0; i < 2; i++) {
      const a2 = w2 * (this.x1[i] - this.x[i]) - 2 * w * this.v2[i];
      this.v2[i] += a2 * dt; this.x[i] += this.v2[i] * dt;
    }
    return this.x as [number, number];
  }

  get speed(): number { return Math.hypot(this.v2[0], this.v2[1]); }
}

export interface Stroke { label: string; dx: number; dy: number; dur: number; rest: number }

/** Scripted strokes for the stroke-accuracy test (metres, seconds). */
export const DEFAULT_STROKES: Stroke[] = [
  { label: '5 cm right', dx: 0.05, dy: 0, dur: 0.35, rest: 0.8 },
  { label: '10 cm diagonal', dx: 0.0707, dy: 0.0707, dur: 0.5, rest: 0.8 },
  { label: '1 cm slow', dx: 0.01, dy: 0, dur: 0.5, rest: 0.8 },
  { label: '5 cm left (fast)', dx: -0.05, dy: 0, dur: 0.2, rest: 0.8 },
  { label: '3 cm toward you', dx: 0, dy: -0.03, dur: 0.3, rest: 0.8 },
  { label: '10 cm back diagonal', dx: -0.0707, dy: -0.0407, dur: 0.55, rest: 0.8 },
];

export interface ScriptSegment { kind: 'rest' | 'stroke'; t0: number; t1: number; x0: number; y0: number; x1: number; y1: number; stroke?: number }

/** A piecewise trajectory: rest → stroke → rest … with minimum-jerk strokes. */
export class Script {
  readonly segments: ScriptSegment[] = [];
  readonly duration: number;
  constructor(x0: number, y0: number, lead: number, strokes: Stroke[], tail = 0) {
    let t = 0, x = x0, y = y0;
    const push = (seg: ScriptSegment) => { this.segments.push(seg); t = seg.t1; x = seg.x1; y = seg.y1; };
    push({ kind: 'rest', t0: 0, t1: lead, x0: x, y0: y, x1: x, y1: y });
    strokes.forEach((s, i) => {
      push({ kind: 'stroke', t0: t, t1: t + s.dur, x0: x, y0: y, x1: x + s.dx, y1: y + s.dy, stroke: i });
      push({ kind: 'rest', t0: t, t1: t + s.rest, x0: x, y0: y, x1: x, y1: y, stroke: i });
    });
    if (tail > 0) push({ kind: 'rest', t0: t, t1: t + tail, x0: x, y0: y, x1: x, y1: y });
    this.duration = t;
  }

  /** Position at time t, plus the segment index. */
  at(t: number): [number, number, number] {
    let i = 0;
    while (i < this.segments.length - 1 && t >= this.segments[i].t1) i++;
    const s = this.segments[i];
    if (s.kind === 'rest') return [s.x1, s.y1, i];
    const tau = Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0)));
    const m = tau * tau * tau * (10 - 15 * tau + 6 * tau * tau); // minimum-jerk
    return [s.x0 + (s.x1 - s.x0) * m, s.y0 + (s.y1 - s.y0) * m, i];
  }
}
