// Live scrolling plots: a ring buffer of the last few seconds at 1 kHz and a
// canvas renderer that draws min/max per pixel column (no aliasing at 1 kHz).

import type { Finger } from '../../../algorithms/taps/classifier.ts';
import { theme, withAlpha, fingerColor } from './theme.ts';

export const CH = { ax: 0, ay: 1, az: 2, gx: 3, gy: 4, gz: 5, lx: 6, ly: 7, vx: 8, vy: 9, tvx: 10, tvy: 11, still: 12, frozen: 13, hp: 14 } as const;
const NCH = 15;

export interface PlotEvent { t: number; kind: 'tap' | 'inject'; finger: Finger | null; note?: string }

export class PlotBuffer {
  readonly cap: number;
  readonly t: Float64Array;
  readonly d: Float32Array;
  n = 0; // total samples pushed
  events: PlotEvent[] = [];
  constructor(seconds = 6, rate = 1000) {
    this.cap = seconds * rate;
    this.t = new Float64Array(this.cap);
    this.d = new Float32Array(this.cap * NCH);
  }
  clear(): void { this.n = 0; this.events = []; }
  /** Returns the row offset to write NCH values into. */
  push(t: number): number {
    const i = this.n % this.cap;
    this.t[i] = t;
    this.n++;
    return i * NCH;
  }
  event(e: PlotEvent): void {
    this.events.push(e);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }
  get latestT(): number { return this.n ? this.t[(this.n - 1) % this.cap] : 0; }
}

interface Lane { title: string; unit: string; chans: { ch: number; color: () => string; label: string; dash?: boolean }[]; minSpan: number; lo: number; hi: number; fixed?: [number, number] }

export class PlotView {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  windowS = 4;
  showTrue = true;
  private lanes: Lane[];
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    const t = () => theme();
    this.lanes = [
      { title: 'Raw accelerometer', unit: 'g', minSpan: 0.3, lo: -1, hi: 1, chans: [
        { ch: CH.ax, color: () => t().s1, label: 'ax' }, { ch: CH.ay, color: () => t().s2, label: 'ay' }, { ch: CH.az, color: () => t().s3, label: 'az' }] },
      { title: 'Raw gyroscope', unit: '°/s', minSpan: 10, lo: -10, hi: 10, chans: [
        { ch: CH.gx, color: () => t().s1, label: 'gx' }, { ch: CH.gy, color: () => t().s2, label: 'gy' }, { ch: CH.gz, color: () => t().s3, label: 'gz' }] },
      { title: 'Linear accel (gravity removed, hand frame)', unit: 'm/s²', minSpan: 0.4, lo: -1, hi: 1, chans: [
        { ch: CH.lx, color: () => t().s1, label: 'x' }, { ch: CH.ly, color: () => t().s2, label: 'y' }] },
      { title: 'Velocity estimate', unit: 'cm/s', minSpan: 4, lo: -5, hi: 5, chans: [
        { ch: CH.vx, color: () => t().s1, label: 'vx' }, { ch: CH.vy, color: () => t().s2, label: 'vy' },
        { ch: CH.tvx, color: () => t().s1, label: 'true vx', dash: true }, { ch: CH.tvy, color: () => t().s2, label: 'true vy', dash: true }] },
      { title: 'Tap trigger |high-passed accel|, still / frozen state, taps', unit: 'g', minSpan: 0.4, lo: 0, hi: 0.5, chans: [
        { ch: CH.hp, color: () => t().muted, label: '|hp a|' }] },
    ];
  }

  legendHTML(): string {
    const t = theme();
    return [
      `<span><i style="background:${t.s1}"></i>x</span>`, `<span><i style="background:${t.s2}"></i>y</span>`,
      `<span><i style="background:${t.s3}"></i>z</span>`, `<span><i style="background:${t.s1};opacity:.5"></i>dashed = true value (debug)</span>`,
      `<span><i style="background:${withAlpha(t.good, 0.5)};height:9px"></i>still → zero-velocity reset</span>`,
      `<span><i style="background:${withAlpha(t.warn, 0.6)};height:9px"></i>cursor frozen</span>`,
      `<span><i style="background:${t.s7};width:3px;height:10px"></i>index tap</span>`,
      `<span><i style="background:${t.s5};width:3px;height:10px"></i>pinky tap</span>`,
      `<span>▲ = key press (ground truth)</span>`,
    ].join('');
  }

  draw(buf: PlotBuffer, threshold: number): void {
    const cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth, cssH = 470;
    if (cv.width !== Math.round(cssW * dpr)) { cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr); cv.style.height = cssH + 'px'; }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const th = theme();
    ctx.clearRect(0, 0, cssW, cssH);
    const left = 8, right = 56, top = 4;
    const W = cssW - left - right;
    const laneH = (cssH - top) / this.lanes.length;
    const tEnd = buf.latestT, tStart = tEnd - this.windowS;
    const count = Math.min(buf.n, buf.cap);
    // first sample index (absolute) inside window
    let first = buf.n - count;
    // binary-ish skip: walk forward until t >= tStart
    const fs = 1000;
    first = Math.max(first, buf.n - Math.ceil(this.windowS * fs) - 2);
    const xOf = (t: number) => left + ((t - tStart) / this.windowS) * W;

    this.lanes.forEach((lane, li) => {
      const y0 = top + li * laneH, h = laneH - 18;
      const yTop = y0 + 14;
      // auto-range
      let lo = Infinity, hi = -Infinity;
      for (const c of lane.chans) {
        if (!this.showTrue && (c.ch === CH.tvx || c.ch === CH.tvy)) continue;
        for (let k = first; k < buf.n; k++) {
          const v = buf.d[(k % buf.cap) * NCH + c.ch];
          if (v < lo) lo = v; if (v > hi) hi = v;
        }
      }
      if (li === 4) { lo = 0; hi = Math.max(hi, threshold * 1.3); }
      if (!isFinite(lo)) { lo = -1; hi = 1; }
      const mid = (lo + hi) / 2;
      let span = Math.max(lane.minSpan, (hi - lo) * 1.15);
      let tlo = li === 4 ? 0 : mid - span / 2, thi = li === 4 ? span : mid + span / 2;
      // ease the axis so it doesn't jitter; expand instantly, shrink slowly
      lane.lo = tlo < lane.lo ? tlo : lane.lo + (tlo - lane.lo) * 0.05;
      lane.hi = thi > lane.hi ? thi : lane.hi + (thi - lane.hi) * 0.05;
      const yOf = (v: number) => yTop + h - ((v - lane.lo) / (lane.hi - lane.lo)) * h;

      // frame & zero line
      ctx.fillStyle = th.ink; ctx.font = '600 11.5px system-ui, sans-serif';
      ctx.fillText(lane.title, left, y0 + 11);
      ctx.fillStyle = th.ink2; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${fmt(lane.hi)} ${lane.unit}`, left + W + 4, yTop + 8);
      ctx.fillText(`${fmt(lane.lo)}`, left + W + 4, yTop + h);
      ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, yTop + 0.5); ctx.lineTo(left + W, yTop + 0.5); ctx.moveTo(left, yTop + h + 0.5); ctx.lineTo(left + W, yTop + h + 0.5); ctx.stroke();
      if (lane.lo < 0 && lane.hi > 0) {
        ctx.strokeStyle = th.axis; ctx.beginPath(); ctx.moveTo(left, Math.round(yOf(0)) + 0.5); ctx.lineTo(left + W, Math.round(yOf(0)) + 0.5); ctx.stroke();
      }

      if (li === 4) {
        // still / frozen bands
        this.bands(buf, first, CH.still, withAlpha(th.good, 0.22), xOf, yTop, h);
        this.bands(buf, first, CH.frozen, withAlpha(th.warn, 0.45), xOf, yTop + h * 0.55, h * 0.45);
        ctx.setLineDash([4, 3]); ctx.strokeStyle = th.crit;
        ctx.beginPath(); ctx.moveTo(left, yOf(threshold)); ctx.lineTo(left + W, yOf(threshold)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = th.ink2; ctx.fillText('tap threshold', left + W - 74, yOf(threshold) - 3);
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(left, yTop - 1, W, h + 2); ctx.clip();
      for (const c of lane.chans) {
        if (!this.showTrue && (c.ch === CH.tvx || c.ch === CH.tvy)) continue;
        ctx.strokeStyle = c.dash ? withAlpha(c.color(), 0.55) : c.color();
        ctx.lineWidth = c.dash ? 1.5 : 1.25;
        ctx.setLineDash(c.dash ? [5, 4] : []);
        ctx.beginPath();
        let col = -1, mn = 0, mx = 0, started = false;
        const flush = () => {
          if (col < 0) return;
          const ya = yOf(mn), yb = yOf(mx);
          if (!started) { ctx.moveTo(col, ya); started = true; } else ctx.lineTo(col, ya);
          if (yb !== ya) ctx.lineTo(col, yb);
        };
        for (let k = first; k < buf.n; k++) {
          const i = k % buf.cap;
          const x = Math.round(xOf(buf.t[i]));
          const v = buf.d[i * NCH + c.ch];
          if (x !== col) { flush(); col = x; mn = v; mx = v; } else { if (v < mn) mn = v; if (v > mx) mx = v; }
        }
        flush();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();

      if (li === 4) {
        for (const e of buf.events) {
          if (e.t < tStart) continue;
          const x = xOf(e.t);
          ctx.fillStyle = fingerColor(e.finger);
          if (e.kind === 'inject') {
            ctx.beginPath(); ctx.moveTo(x, yTop + h + 1); ctx.lineTo(x - 5, yTop + h + 8); ctx.lineTo(x + 5, yTop + h + 8); ctx.fill();
          } else {
            ctx.fillRect(x - 1.5, yTop, 3, h);
            ctx.font = '600 11.5px system-ui, sans-serif';
            ctx.fillStyle = th.ink;
            ctx.fillText(e.note ?? (e.finger ?? ''), x + 4, yTop + 10);
          }
        }
      }
    });
  }

  private bands(buf: PlotBuffer, first: number, ch: number, color: string, xOf: (t: number) => number, y: number, h: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    let start = -1;
    for (let k = first; k < buf.n; k++) {
      const i = k % buf.cap;
      const on = buf.d[i * NCH + ch] > 0.5;
      if (on && start < 0) start = xOf(buf.t[i]);
      if ((!on || k === buf.n - 1) && start >= 0) {
        ctx.fillRect(start, y, Math.max(1, xOf(buf.t[i]) - start), h);
        start = -1;
      }
    }
  }
}

function fmt(v: number): string {
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
}
