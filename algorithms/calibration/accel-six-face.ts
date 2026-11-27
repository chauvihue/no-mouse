// Six-face accelerometer calibration: the maths only. The app (src/ui/main.ts) owns the guided
// flow, the still-detection over the sample window, the status text and localStorage.
//
// Rest the board on each of its six faces. For each axis: bias = (up + down) / 2 and
// scale = 2 / (up − down). The pipeline then uses (raw − bias) · scale (see applyAccelCorrection).

export const ACCEL_FACES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;
export type AccelFace = typeof ACCEL_FACES[number];

export type Vec3Tuple = [number, number, number];

/**
 * Which face the board rests on, from the mean accelerometer reading over a still window (g).
 * Returns null unless one axis reads about ±1 g and the other two are near zero.
 */
export function accelFaceFromMean(m: ArrayLike<number>): AccelFace | null {
  // which axis is near ±1 g, and are the other two near zero?
  let axis = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(m[i]) > Math.abs(m[axis])) axis = i;
  const others = [0, 1, 2].filter(i => i !== axis);
  if (Math.abs(m[axis]) <= 0.8 || others.some(i => Math.abs(m[i]) >= 0.3)) return null;
  return `${m[axis] > 0 ? '+' : '-'}${'XYZ'[axis]}` as AccelFace;
}

export interface AccelCalResult {
  bias: Vec3Tuple;   // g
  scale: Vec3Tuple;  // unitless
  problems: string[]; // empty when the result is acceptable
}

/**
 * Bias and scale per axis from the six face readings (each face: the mean [ax, ay, az] in g).
 * `problems` lists any axis whose bias is over 150 mg or whose scale is outside 90–110 %; the
 * caller should not apply the result when problems is non-empty.
 */
export function accelCalFromFaces(faces: Partial<Record<AccelFace, number[]>>): AccelCalResult {
  const f = faces as Record<AccelFace, number[]>;
  const bias: Vec3Tuple = [0, 0, 0], scale: Vec3Tuple = [1, 1, 1];
  const problems: string[] = [];
  for (let i = 0; i < 3; i++) {
    const ax = 'XYZ'[i];
    const up = f[`+${ax}` as AccelFace][i], down = f[`-${ax}` as AccelFace][i];
    bias[i] = (up + down) / 2;
    scale[i] = 2 / (up - down);
    if (Math.abs(bias[i]) > 0.15) problems.push(`${ax} bias ${(bias[i] * 1000).toFixed(0)} mg is over 150 mg`);
    if (!(scale[i] >= 0.9 && scale[i] <= 1.1)) problems.push(`${ax} scale ${(scale[i] * 100).toFixed(0)} % is outside 90–110 %`);
  }
  return { bias, scale, problems };
}

/** Applies a calibration to one raw accelerometer reading (g): (raw − bias) · scale per axis. */
export function applyAccelCorrection(raw: Vec3Tuple, bias: Vec3Tuple, scale: Vec3Tuple): Vec3Tuple {
  return [
    (raw[0] - bias[0]) * scale[0],
    (raw[1] - bias[1]) * scale[1],
    (raw[2] - bias[2]) * scale[2],
  ];
}
