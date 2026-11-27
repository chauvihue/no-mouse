// Stroke tracker: hand motion as a series of strokes instead of one endless
// double integration.
//
// Moving a mouse is a string of point-to-point strokes. In each one the hand
// speeds up (acceleration points the way it is going), slows down (acceleration
// points back), and stops. The tracker follows those phases:
//
//   idle      wait for the acceleration, measured against what the sensor reads
//             at rest, to pass a threshold. That first push gives the direction.
//   speed-up  integrate acceleration into velocity (2-D, so the heading can still
//             settle); heading = direction of the velocity built up so far.
//   slow-down acceleration now points backwards. The heading is locked and only
//             the part of the acceleration along it counts; speed can't go below
//             zero, because a stroke doesn't reverse.
//   halt      once the braking has faded (or speed is back to zero) the hand has
//             stopped: velocity is set to exactly zero, so whatever error the
//             integration collected can't carry on as drift.
//   settle    after a halt the wrist wobbles a little; that is ignored until it
//             has been quiet for a moment.
//
// The cursor still moves by velocity × time, but only while a stroke is under
// way, and every stroke starts and ends at exactly zero velocity.
// Pure TS, no allocation per sample.

import { G } from '../shared/math.ts';

export type StrokePhase = 'idle' | 'speedup' | 'slowdown' | 'settle';

export interface StrokeConfig {
  strokeOnsetG: number;       // a stroke starts when accel relative to rest passes this, g…
  strokeOnsetMs: number;      // …in a steady direction for this long (a noise blip doesn't)
  strokeBrakeG: number;       // speed-up turns into slow-down once accel points back by this much, g
  strokeEndFrac: number;      // halt once braking has faded below this fraction of its peak…
  strokeEndMs: number;        // …for this long…
  strokeEndSpeedFrac: number; // …with the speed below this fraction of the stroke's top speed
  strokeCruiseMs: number;     // pushed, then no push and no braking for this long: stopped…
  strokeGlideMaxMs: number;   // …or this long while the sliding detector says the hand slides
  strokeGlideHoldMs: number;  // …and a dropout of the sliding detector shorter than this still counts as sliding (0 = off)
  strokeSettleMs: number;     // after a halt, this long of quiet before the next stroke can start
  strokeMaxSpeedupMs: number; // speeding up for longer than this isn't a hand stroke: cancel it
  strokeRestTauS: number;     // time constant for learning the at-rest acceleration
  strokeLpHz: number;         // low-pass for the phase decisions (the integration uses the raw signal)
  strokeRelFrac: number;      // braking / pushing again must exceed this fraction of the stroke's own peak
  strokeLeakGain: number;     // how much of each measured gravity leak is learned (0 = off)
  sampleRateHz: number;
}
const RING = 64;          // recent samples, to recover the start of a stroke before the threshold
const ONSET_BACK = 40;    // look back at most this many samples
const SETTLE_MAX_S = 0.3; // after this long without going quiet, settling is over
const SLIDE_START_MS = 80;    // sliding this long without a clear push starts a stroke anyway
const SLIDE_REST_TAU_S = 2; // not sliding: learn the at-rest reading (absorbs a tilt; slow enough not to eat the start of a slow push)

export class StrokeTracker {
  phase: StrokePhase = 'idle';
  /** Heading of the current (or last) stroke, unit vector. */
  ux = 1; uy = 0;
  /** Velocity, m/s. */
  vx = 0; vy = 0;
  /** True on the sample a stroke started / was cancelled as not-a-stroke. */
  started = false;
  cancelled = false;
  count = 0;                 // strokes started since reset

  private bx = 0; private by = 0; // acceleration at rest (a leftover tilt error shows up here), m/s²
  private lx = 0; private ly = 0; // low-passed acceleration relative to rest, m/s²
  // 2nd-order Butterworth low-pass of the raw input, per axis: x1, x2, y1, y2
  private lpx = new Float64Array(4); private lpy = new Float64Array(4);
  private lpCoef = [1, 0, 0, 0, 0]; private lpKey = '';
  private lpPrime = true;
  // Gravity leak learning: the velocity integrated since the hand was last known to be at rest
  // should be zero when it is at rest again; what is left over, divided by the time, is leak.
  leakX = 0; leakY = 0;      // learned leak, subtracted from the input, m/s²
  private rvx = 0; private rvy = 0; private rT = 0; // raw velocity and time since the last rest
  private ring = new Float64Array(RING * 2);
  private k = 0;
  private phaseT = 0;        // s in the current phase
  private brakePeak = 0;     // strongest braking in this stroke, m/s²
  private peakSpeed = 0;     // fastest speed in this stroke, m/s
  private pushPeak = 0;      // strongest push (acceleration along the stroke) in this stroke, m/s²
  private age = 0;           // s since this stroke started
  private calmT = 0;         // s of neither pushing nor braking while speeding up
  private pushT = 0;         // s spent pushing (not calm) in this speed-up
  private fadeT = 0;         // s that braking has been below strokeEndFrac of its peak
  private quietT = 0;        // s of quiet while settling
  private armT = 0;          // s the push has stayed above the onset threshold, same direction
  private armX = 0; private armY = 0; // direction of that push
  private holdOff = false;   // ignore every push until the hand goes quiet (see hitWall / suspend)
  // Sliding (desk vibration, from the pipeline): the hand is moving even when it isn't accelerating.
  private slideT = 0;        // s of continuous sliding while idle
  private svx = 0; private svy = 0; // velocity integrated since sliding began, while idle
  private sinceSlide = 1e9;  // s since the sliding detector last said "sliding"

  reset(): void {
    this.phase = 'idle';
    this.vx = this.vy = 0;
    this.bx = this.by = this.lx = this.ly = 0;
    this.lpPrime = true;
    this.ring.fill(0);
    this.k = 0; this.phaseT = 0; this.brakePeak = 0; this.fadeT = 0; this.quietT = 0;
    this.peakSpeed = 0; this.age = 0; this.calmT = 0; this.armT = 0; this.holdOff = false;
    this.leakX = this.leakY = this.rvx = this.rvy = this.rT = 0;
    this.slideT = this.svx = this.svy = 0; this.sinceSlide = 1e9;
    this.started = this.cancelled = false;
    this.count = 0;
  }

  /** Stop now (the hand is known to be at rest, or the motion must be discarded). */
  halt(): void {
    this.vx = this.vy = 0;
    if (this.phase === 'speedup' || this.phase === 'slowdown') this.enter('settle');
  }

  /**
   * The cursor ran into the screen edge along the stroke. The stroke is over, but the hand
   * hasn't braked yet; that braking must not count as a push back off the edge.
   */
  hitWall(): void {
    if (this.moving) this.suspend();
  }

  /**
   * Stop and ignore all motion until the hand goes quiet. Used while the cursor is frozen
   * around a tap: a stroke the tracker didn't see must not be picked up halfway, where its
   * braking would look like a stroke the other way.
   */
  suspend(): void {
    this.vx = this.vy = 0;
    this.enter('settle');
    this.holdOff = true;
  }

  /** The input was re-zeroed upstream (gravity re-estimated): forget the learned rest offset. */
  rebase(): void {
    this.bx = this.by = this.lx = this.ly = 0; this.lpPrime = true; this.ring.fill(0);
    this.leakX = this.leakY = this.rvx = this.rvy = this.rT = 0;
  }

  get moving(): boolean { return this.phase === 'speedup' || this.phase === 'slowdown'; }

  /**
   * One sample of horizontal linear acceleration (m/s², hand-heading frame).
   * `still` is the pipeline's stillness flag: a stroke can't outlast it.
   * `sliding` is the desk-vibration detector (null when it is off). With it, a stroke can only
   * start while the hand slides (a wrist tilt makes no vibration, so it is ignored), and a
   * stroke may glide at steady speed while the vibration lasts.
   */
  step(ax: number, ay: number, dt: number, still: boolean, c: StrokeConfig, sliding: boolean | null = null): void {
    this.started = this.cancelled = false;
    const rx = ax - this.bx - this.leakX, ry = ay - this.by - this.leakY;
    // Real strokes carry strong vibration (sliding on the desk, the board rattling) well above
    // the < 10 Hz of hand motion, so the decisions look at a low-passed signal.
    this.lowpass(ax, ay, c);
    this.lx = this.fx - this.bx - this.leakX; this.ly = this.fy - this.by - this.leakY;
    if (this.phase === 'idle') { this.rvx = this.rvy = this.rT = 0; } // at rest: the reference point
    else { this.rvx += rx * dt; this.rvy += ry * dt; this.rT += dt; }
    const ri = (this.k++ % RING) * 2;
    this.ring[ri] = rx; this.ring[ri + 1] = ry;
    this.phaseT += dt;
    const onset = c.strokeOnsetG * G;
    const lm = Math.hypot(this.lx, this.ly);

    this.age += dt;
    const gate = sliding !== null;
    if (sliding) this.sinceSlide = 0; else this.sinceSlide += dt;

    switch (this.phase) {
      case 'idle':
        if (gate && !sliding) {
          // Not sliding, so whatever the accelerometer reads is rest: a wrist tilt is absorbed
          // here (quickly) instead of becoming a stroke.
          this.armT = 0; this.slideT = 0; this.svx = this.svy = 0;
          this.learnRest(dt, SLIDE_REST_TAU_S);
          break;
        }
        if (gate) {
          // Sliding but no clear push yet (a slow pan): integrate quietly, and start a stroke
          // after a moment of sliding with whatever velocity has built up.
          this.slideT += dt; this.svx += rx * dt; this.svy += ry * dt;
          if (this.slideT * 1000 >= SLIDE_START_MS && Math.hypot(this.svx, this.svy) > 1e-4) { this.startWith(this.svx, this.svy); break; }
        }
        if (lm > onset && (this.armT === 0 || this.lx * this.armX + this.ly * this.armY > 0.7 * lm)) {
          if (this.armT === 0) { this.armX = this.lx / lm; this.armY = this.ly / lm; }
          this.armT += dt;
          if (this.armT * 1000 >= c.strokeOnsetMs) this.start(dt);
        } else {
          this.armT = 0;
          if (lm < onset) this.learnRest(dt, c.strokeRestTauS);
        }
        break;

      case 'settle':
        this.quietT = lm < onset ? this.quietT + dt : 0;
        if (lm < onset) this.learnRest(dt, 0.1);
        if (this.quietT * 1000 >= c.strokeSettleMs || still) { this.learnLeak(c, false); this.enter('idle'); }
        else if (lm > 3 * onset && this.freshPush(lm)) this.start(dt); else if (this.phaseT > (this.holdOff ? 2 : 1) * SETTLE_MAX_S) {
          // Never went quiet. Treat it as motion; if it is really a tilt, the speed-up limit catches it.
          if (lm > onset) this.start(dt); else this.enter('idle');
        }
        break;

      case 'speedup': {
        this.vx += rx * dt; this.vy += ry * dt;
        const sp = Math.hypot(this.vx, this.vy);
        if (sp > 1e-6) { this.ux = this.vx / sp; this.uy = this.vy / sp; }
        if (sp > this.peakSpeed) this.peakSpeed = sp;
        const along = this.lx * this.ux + this.ly * this.uy;
        if (along > this.pushPeak) this.pushPeak = along;
        // "neither pushing nor braking", judged against this stroke's own push
        this.calmT = lm < Math.max(onset, 0.15 * this.pushPeak) ? this.calmT + dt : 0;
        if (this.calmT === 0) this.pushT += dt;
        if (along < -Math.max(c.strokeBrakeG * G, c.strokeRelFrac * this.pushPeak)) {
          this.enter('slowdown');
          this.brakePeak = Math.max(this.brakePeak, -along);
          this.fadeT = 0;
        } else if (this.pushT * 1000 > c.strokeMaxSpeedupMs) {
          // Pushing this long in one direction is a tilt (gravity leaking in), not a stroke.
          // (Only time spent pushing counts: a steady pan pushes briefly, then glides.)
          this.bx = this.fx; this.by = this.fy; this.lx = this.ly = 0;
          this.vx = this.vy = 0;
          this.cancelled = true;
          this.enter('settle');
        } else if (this.calmT * 1000 > (gate && (sliding || this.sinceSlide * 1000 < c.strokeGlideHoldMs) ? c.strokeGlideMaxMs : c.strokeCruiseMs)) {
          // Pushed, then neither pushing nor braking: take it that the hand has stopped and the
          // speed left over is error. While the sliding detector says the hand still slides, a
          // steady glide is real, so it may last much longer (strokeGlideMaxMs).
          this.halt();
        }
        break;
      }

      case 'slowdown': {
        const along = this.lx * this.ux + this.ly * this.uy;
        const cross = this.ly * this.ux - this.lx * this.uy;
        const s = this.vx * this.ux + this.vy * this.uy + (rx * this.ux + ry * this.uy) * dt;
        if (-along > this.brakePeak) this.brakePeak = -along;
        this.fadeT = -along < c.strokeEndFrac * this.brakePeak ? this.fadeT + dt : 0;
        const peak = Math.max(this.pushPeak, this.brakePeak);
        if (along > Math.max(onset, c.strokeRelFrac * peak)
          || (Math.abs(cross) > Math.max(2 * onset, 2 * c.strokeRelFrac * peak) && Math.abs(cross) > -along)) {
          // Pushing forward again, or sideways (turning): speed up again in 2-D.
          this.vx = Math.max(0, s) * this.ux; this.vy = Math.max(0, s) * this.uy;
          this.calmT = 0;
          this.enter('speedup');
        } else if (s <= 0) {
          if (-along > 0.5 * this.brakePeak) {
            // Speed is used up but the hand is still being pushed back hard: it is reversing.
            // Carry on as a new stroke the other way.
            this.learnLeak(c, true);
            this.ux = -this.ux; this.uy = -this.uy;
            this.vx = -s * this.ux; this.vy = -s * this.uy;
            this.newStroke();
          } else this.halt(); // speed used up as the braking fades: stopped
        } else if (this.fadeT * 1000 >= c.strokeEndMs && s < c.strokeEndSpeedFrac * this.peakSpeed) {
          this.halt(); // braking is over and most of the speed is gone: the hand has stopped
        } else {
          this.vx = s * this.ux; this.vy = s * this.uy; // pure braking: sideways noise is ignored
        }
        break;
      }
    }

    // Safety net: once the stillness detector says the hand is at rest, it is. (It lags the
    // start of a stroke by tens of ms, so early in a stroke it is ignored.)
    if (still && this.moving && this.age > 0.15) this.halt();
  }

  /**
   * While settling: is this strong push the next stroke, rather than the last one's braking?
   * Normally a push the other way only counts if it is stronger than the braking was. After a
   * halt at the screen edge (or a freeze) the braking is still to come, so nothing counts until
   * the hand has gone quiet.
   */
  private freshPush(lm: number): boolean {
    if (this.holdOff) return false;
    const along = this.lx * this.ux + this.ly * this.uy;
    return along > -0.5 * lm || lm > 0.5 * this.brakePeak;
  }

  /**
   * The hand is at rest again (or, crossOnly, reversing: at rest along the stroke, but that
   * moment was found from the speed itself, so only the sideways part says anything).
   * The raw velocity built up since the last rest should be zero; the rest is leak.
   */
  private learnLeak(c: StrokeConfig, crossOnly: boolean): void {
    if (c.strokeLeakGain > 0 && this.rT > 0.1) {
      let ex = this.rvx / this.rT, ey = this.rvy / this.rT;
      if (crossOnly) { const cr = -ex * this.uy + ey * this.ux; ex = -cr * this.uy; ey = cr * this.ux; }
      this.leakX += c.strokeLeakGain * ex; this.leakY += c.strokeLeakGain * ey;
      const m = Math.hypot(this.leakX, this.leakY), cap = 0.1 * G; // never more than a 0.1 g correction
      if (m > cap) { this.leakX *= cap / m; this.leakY *= cap / m; }
    }
    if (!crossOnly || c.strokeLeakGain > 0) { this.rvx = this.rvy = this.rT = 0; }
  }

  private enter(p: StrokePhase): void {
    this.phase = p; this.phaseT = 0; this.quietT = 0; this.armT = 0; this.pushT = 0;
    if (p !== 'settle') this.holdOff = false;
  }

  private learnRest(dt: number, tau: number): void {
    const a = Math.min(1, dt / tau);
    const dx = this.lx * a, dy = this.ly * a;
    this.bx += dx; this.by += dy; this.lx -= dx; this.ly -= dy;
  }

  private fx = 0; private fy = 0; // low-passed raw input, m/s²

  /** 2nd-order Butterworth low-pass (RBJ biquad) of the raw input. */
  private lowpass(ax: number, ay: number, c: StrokeConfig): void {
    const key = `${c.strokeLpHz}/${c.sampleRateHz}`;
    if (key !== this.lpKey) {
      this.lpKey = key;
      const w0 = 2 * Math.PI * Math.min(c.strokeLpHz, 0.45 * c.sampleRateHz) / c.sampleRateHz;
      const al = Math.sin(w0) / (2 * Math.SQRT1_2), cw = Math.cos(w0), a0 = 1 + al;
      this.lpCoef = [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0];
    }
    if (this.lpPrime) { // start in steady state: no start-up transient
      this.lpPrime = false;
      this.lpx.set([ax, ax, ax, ax]); this.lpy.set([ay, ay, ay, ay]);
    }
    this.fx = biquad(this.lpx, this.lpCoef, ax);
    this.fy = biquad(this.lpy, this.lpCoef, ay);
  }

  /** Start a stroke with a velocity already built up (slow sliding without a clear push). */
  private startWith(vx: number, vy: number): void {
    const m = Math.hypot(vx, vy);
    this.vx = vx; this.vy = vy; this.ux = vx / m; this.uy = vy / m;
    this.slideT = 0; this.svx = this.svy = 0;
    this.newStroke();
  }

  /** Start a stroke along the current push, including the part before it crossed the threshold. */
  private start(dt: number): void {
    const m = Math.hypot(this.lx, this.ly) || 1;
    const dx = this.lx / m, dy = this.ly / m;
    let vx = 0, vy = 0;
    for (let j = 0; j < ONSET_BACK; j++) {
      const i = ((this.k - 1 - j + RING * 1000) % RING) * 2;
      const x = this.ring[i], y = this.ring[i + 1];
      if (j > 0 && x * dx + y * dy <= 0) break; // walked back to before the push began
      vx += x * dt; vy += y * dt;
    }
    this.vx = vx; this.vy = vy;
    this.ux = dx; this.uy = dy;
    this.newStroke();
  }

  private newStroke(): void {
    this.brakePeak = 0; this.fadeT = 0; this.calmT = 0; this.age = 0; this.pushPeak = 0;
    this.slideT = 0; this.svx = this.svy = 0;
    this.peakSpeed = Math.hypot(this.vx, this.vy);
    this.started = true;
    this.count++;
    this.enter('speedup');
  }
}

function biquad(st: Float64Array, k: number[], x: number): number {
  const y = k[0] * x + k[1] * st[0] + k[2] * st[1] - k[3] * st[2] - k[4] * st[3];
  st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y;
  return y;
}
