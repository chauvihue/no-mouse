// The live feed of the click detector, without any DOM: what the click tester does with the readings that
// arrive from the serial port. The detector is created on the first reading, with the measured board rate
// (the pipeline's rate probe), the sensitivity and the personal profile in force at that moment. Every
// reading goes in, in order, with its own device timestamp; nothing is resampled, batched or corrected.

import { ClickDetector } from './detector.ts';
import type { ClickEvent, ClickModel, ClickProfile, ImuReading } from './detector.ts';

export class ClickEngine {
  det: ClickDetector | null = null;
  sensitivity: number;
  profile: ClickProfile | null;
  private readonly model: ClickModel | null | undefined;

  constructor(opts: { sensitivity?: number; profile?: ClickProfile | null; model?: ClickModel | null } = {}) {
    this.sensitivity = opts.sensitivity ?? 1;
    this.profile = opts.profile ?? null;
    this.model = opts.model;
  }

  /** Drops the detector: the next reading starts a new one (new noise estimate). */
  reset(): void { this.det = null; }

  setSensitivity(v: number): void {
    this.sensitivity = v;
    if (this.det) this.det.sensitivity = v;
  }

  setProfile(p: ClickProfile | null): void {
    this.profile = p;
    this.det?.setProfile(p);
  }

  /** One live reading; rateHz is the measured board rate. Returns a confirmed tap, or null. */
  feed(s: ImuReading, rateHz: number): ClickEvent | null {
    if (!(rateHz > 0)) return null;
    this.det ??= new ClickDetector({ sampleRateHz: rateHz, sensitivity: this.sensitivity, profile: this.profile, model: this.model });
    return this.det.step(s);
  }
}
