// Quick personal calibration for the click detector ("Teach"): a few index taps, a few pinky taps, a
// still hand and a moving hand adapt the trained model to this user and this session. The trained
// model stays the prior; nothing here replaces it.
//
//   index / pinky centres   the class centres (in the side model's feature space) move towards the
//                           user's own taps: (PRIOR_N x trained centre + sum of own taps) / (PRIOR_N + n)
//   tap gate                the threshold is moved so that the user's softest tap passes with a margin
//                           and the strongest non-tap seen while teaching is refused, within +/-GATE_MAX
//   amplitude floor         0.6 x the softest tap, so a light pinky is not lost below the default floor
//
// DOM-free: the click tester collects the events (the detector with rejectedEvents on), this builds the profile.

import { AMP_MIN_G } from './detector.ts';
import type { ClickEvent, ClickModel, ClickProfile, Side } from './detector.ts';

export const PRIOR_N = 2;       // weight of the trained class centre, in taps
export const GATE_MAX = 3;      // largest change of the tap threshold, in score units
export const MIN_AMP_G = 0.03;  // never lower the amplitude floor below this
const MARGIN_TAP = 0.5;         // the softest taught tap must score this far above the threshold
const MARGIN_NEG = 0.25;        // the strongest non-tap must score this far below it

export interface TeachInput {
  taps: { side: Side; ev: ClickEvent }[];
  negatives: ClickEvent[];
}

export interface TeachSummary {
  nL: number; nR: number; nNeg: number;
  peakL: number | null;   // mean tap peak, g
  peakR: number | null;
  gateShift: number;
  ampMinG: number;
  overlap: boolean;       // some non-tap scored as high as the softest tap
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;

export function buildProfile(model: ClickModel, input: TeachInput): { profile: ClickProfile; summary: TeachSummary } {
  const feats = model.side.features;
  const vec = (e: ClickEvent): number[] => feats.map((f) => e.features[f]);
  const centre = (side: Side, prior: number[]): number[] => {
    const xs = input.taps.filter((t) => t.side === side).map((t) => vec(t.ev));
    if (xs.length === 0) return prior;
    return prior.map((p, q) => (PRIOR_N * p + xs.reduce((s, x) => s + x[q], 0)) / (PRIOR_N + xs.length));
  };
  const muL = centre('L', model.side.muL);
  const muR = centre('R', model.side.muR);

  const theta0 = model.tap.threshold;
  const tapScores = input.taps.map((t) => t.ev.tapScore).filter(Number.isFinite);
  const negScores = input.negatives.map((e) => e.tapScore).filter(Number.isFinite);
  const hi = tapScores.length ? Math.min(...tapScores) : Infinity;
  const lo = negScores.length ? Math.max(...negScores) : -Infinity;
  let theta = theta0;
  if (hi - MARGIN_TAP < theta) theta = hi - MARGIN_TAP;
  let overlap = false;
  if (lo + MARGIN_NEG > theta) {
    if (lo + MARGIN_NEG <= hi - MARGIN_TAP) theta = lo + MARGIN_NEG;
    else { theta = (lo + hi) / 2; overlap = true; }
  }
  theta = clamp(theta, theta0 - GATE_MAX, theta0 + GATE_MAX);

  const peaks = input.taps.map((t) => t.ev.peakG);
  const ampMinG = peaks.length ? clamp(0.6 * Math.min(...peaks), MIN_AMP_G, AMP_MIN_G) : AMP_MIN_G;
  const peakOf = (side: Side): number | null => {
    const v = input.taps.filter((t) => t.side === side).map((t) => t.ev.peakG);
    return v.length ? mean(v) : null;
  };
  const profile: ClickProfile = { muL, muR, gateShift: theta - theta0, ampMinG };
  return {
    profile,
    summary: {
      nL: input.taps.filter((t) => t.side === 'L').length,
      nR: input.taps.filter((t) => t.side === 'R').length,
      nNeg: input.negatives.length,
      peakL: peakOf('L'), peakR: peakOf('R'),
      gateShift: profile.gateShift!, ampMinG, overlap,
    },
  };
}

/** Checks a profile read back from storage; returns null if it does not fit the model's feature space. */
export function parseProfile(raw: unknown, model: ClickModel): ClickProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const k = model.side.features.length;
  const vecOk = (v: unknown): v is number[] => Array.isArray(v) && v.length === k && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!vecOk(r.muL) || !vecOk(r.muR)) return null;
  if (!num(r.gateShift, -GATE_MAX - 0.01, GATE_MAX + 0.01) || !num(r.ampMinG, MIN_AMP_G - 1e-9, AMP_MIN_G + 1e-9)) return null;
  return { muL: r.muL, muR: r.muR, gateShift: r.gateShift, ampMinG: r.ampMinG };
}
