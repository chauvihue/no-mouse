import type { Quat } from '../shared/math.ts';

/**
 * Madgwick gradient-descent orientation filter, IMU (6-axis) variant.
 * Straight port of Madgwick's reference C implementation; q is sensor→world.
 *
 * gx..gz in rad/s, ax..az in any unit (normalised internally),
 * beta in rad/s (0 ⇒ pure gyro integration).
 */
export function madgwickUpdateIMU(
  q: Quat,
  gx: number, gy: number, gz: number,
  ax: number, ay: number, az: number,
  beta: number, dt: number,
): void {
  let q0 = q[0], q1 = q[1], q2 = q[2], q3 = q[3];

  // Rate of change of quaternion from gyroscope
  let qDot1 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
  let qDot2 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
  let qDot3 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
  let qDot4 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);

  const an = Math.hypot(ax, ay, az);
  if (beta > 0 && an > 1e-9) {
    ax /= an; ay /= an; az /= an;
    const _2q0 = 2 * q0, _2q1 = 2 * q1, _2q2 = 2 * q2, _2q3 = 2 * q3;
    const _4q0 = 4 * q0, _4q1 = 4 * q1, _4q2 = 4 * q2;
    const _8q1 = 8 * q1, _8q2 = 8 * q2;
    const q0q0 = q0 * q0, q1q1 = q1 * q1, q2q2 = q2 * q2, q3q3 = q3 * q3;

    // Gradient of the objective  f = q* ⊗ [0 0 1] ⊗ q − â
    let s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
    let s1 = _4q1 * q3q3 - _2q3 * ax + 4 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
    let s2 = 4 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
    let s3 = 4 * q1q1 * q3 - _2q1 * ax + 4 * q2q2 * q3 - _2q2 * ay;
    const sn = Math.hypot(s0, s1, s2, s3);
    if (sn > 1e-12) {
      s0 /= sn; s1 /= sn; s2 /= sn; s3 /= sn;
      qDot1 -= beta * s0;
      qDot2 -= beta * s1;
      qDot3 -= beta * s2;
      qDot4 -= beta * s3;
    }
  }

  q0 += qDot1 * dt;
  q1 += qDot2 * dt;
  q2 += qDot3 * dt;
  q3 += qDot4 * dt;
  const n = Math.hypot(q0, q1, q2, q3) || 1;
  q[0] = q0 / n; q[1] = q1 / n; q[2] = q2 / n; q[3] = q3 / n;
}
