// Glue between the simulator and the pipeline: shared by the live UI and the
// headless test runner, so both measure exactly the same thing.

import type { PipelineConfig } from '../../../algorithms/config.ts';
import { Pipeline } from '../../../algorithms/pipeline.ts';
import type { ImuSample, StepOutput, TapEvent } from '../../../algorithms/pipeline.ts';
import type { Finger } from '../../../algorithms/taps/classifier.ts';
import { TapClassifier } from '../../../algorithms/taps/classifier.ts';
import { ImuSim } from '../sim/imu.ts';
import type { SimConfig, Truth } from '../sim/imu.ts';

export type TapOutcome = 'correct' | 'wrong-finger' | 'missed' | 'false';

export interface TapRecord {
  tInjected: number | null;
  truth: Finger | null;
  pred: Finger | null;
  tDetected: number | null;
  confidence: number;
  features: number[] | null;
  outcome: TapOutcome;
}

/** Matches injected (ground-truth) taps with what the pipeline detected. */
export class TapTracker {
  pending: { t: number; finger: Finger }[] = [];
  records: TapRecord[] = [];
  matchWindowS = 0.04;
  onRecord: ((r: TapRecord) => void) | null = null;

  reset(): void { this.pending = []; this.records = []; }

  inject(t: number, finger: Finger): void { this.pending.push({ t, finger }); }

  detected(ev: TapEvent): TapRecord {
    let best = -1, bestD = Infinity;
    this.pending.forEach((p, i) => {
      const d = Math.abs(ev.tTrigger - p.t);
      if (d < this.matchWindowS && d < bestD) { best = i; bestD = d; }
    });
    let rec: TapRecord;
    if (best >= 0) {
      const p = this.pending.splice(best, 1)[0];
      rec = {
        tInjected: p.t, truth: p.finger, pred: ev.finger, tDetected: ev.tTrigger, confidence: ev.confidence,
        features: ev.features, outcome: p.finger === ev.finger ? 'correct' : 'wrong-finger',
      };
    } else {
      rec = {
        tInjected: null, truth: null, pred: ev.finger, tDetected: ev.tTrigger, confidence: ev.confidence,
        features: ev.features, outcome: 'false',
      };
    }
    this.push(rec);
    return rec;
  }

  /** Expire injected taps that were never detected. */
  tick(t: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (t - this.pending[i].t > 0.15) {
        const p = this.pending.splice(i, 1)[0];
        this.push({ tInjected: p.t, truth: p.finger, pred: null, tDetected: null, confidence: 0, features: null, outcome: 'missed' });
      }
    }
  }

  private push(r: TapRecord): void { this.records.push(r); this.onRecord?.(r); }

  stats() {
    const cm = [[0, 0], [0, 0]];
    let falseN = 0, missed = 0;
    for (const r of this.records) {
      if (r.outcome === 'false') falseN++;
      else if (r.outcome === 'missed') missed++;
      else cm[r.truth === 'index' ? 0 : 1][r.pred === 'index' ? 0 : 1]++;
    }
    const n = cm[0][0] + cm[0][1] + cm[1][0] + cm[1][1];
    return { confusion: cm, falseN, missed, classified: n, accuracy: n ? (cm[0][0] + cm[1][1]) / n : NaN };
  }
}

export interface SessionStep { sample: ImuSample; truth: Truth | null; out: StepOutput }

export class Session {
  readonly sim: ImuSim;
  readonly pipe: Pipeline;
  readonly tracker = new TapTracker();
  private stepOut: SessionStep;

  constructor(simCfg: SimConfig, pipeCfg: PipelineConfig, classifier?: TapClassifier) {
    this.sim = new ImuSim(simCfg);
    this.pipe = new Pipeline(pipeCfg);
    if (classifier) copyClassifier(classifier, this.pipe.classifier);
    this.stepOut = { sample: this.sim.sample, truth: this.sim.truth, out: this.pipe.out };
  }

  reset(x: number, y: number, cursorX?: number, cursorY?: number): void {
    this.sim.reset(x, y);
    this.pipe.reset(cursorX, cursorY);
    this.tracker.reset();
  }

  injectTap(finger: Finger): void {
    this.sim.injectTap(finger);
    this.tracker.inject(this.sim.k / this.sim.cfg.sampleRateHz, finger);
  }

  /** One 1 kHz tick with the true hand at (px, py) metres. */
  step(px: number, py: number): SessionStep {
    const s = this.sim.step(px, py);
    const o = this.pipe.step(s);
    if (o.tap) this.tracker.detected(o.tap);
    if ((this.sim.k & 15) === 0) this.tracker.tick(s.t);
    return this.stepOut;
  }
}

export function copyClassifier(from: TapClassifier, to: TapClassifier): void {
  to.kind = from.kind; to.trained = from.trained; to.source = from.source;
  to.mean = [...from.mean]; to.std = [...from.std]; to.w = [...from.w]; to.b = from.b;
  to.cIndex = [...from.cIndex]; to.cPinky = [...from.cPinky];
}
