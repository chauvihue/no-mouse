// Small, allocation-free math helpers. Quaternions are [w, x, y, z] stored in
// plain arrays so the code ports 1:1 to C/C++ (float q[4]).
//
// Convention: q rotates SENSOR-frame vectors into the WORLD (desk) frame:
//   v_world = q ⊗ v_sensor ⊗ q*
// World frame: x = right, y = forward (away from the user), z = up.

export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];

export const G = 9.80665; // m/s² per g
export const DEG = Math.PI / 180;

export function quatNormalize(q: Quat): void {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
}

/** out = a ⊗ b (out may alias neither a nor b). */
export function quatMul(a: Quat, b: Quat, out: Quat): Quat {
  const w = a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3];
  const x = a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2];
  const y = a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1];
  const z = a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0];
  out[0] = w; out[1] = x; out[2] = y; out[3] = z;
  return out;
}

/** Rotate v (sensor frame) into world frame with q. */
export function rotateToWorld(q: Quat, v: Vec3, out: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
  const a = v[0], b = v[1], c = v[2];
  out[0] = r00 * a + r01 * b + r02 * c;
  out[1] = r10 * a + r11 * b + r12 * c;
  out[2] = r20 * a + r21 * b + r22 * c;
  return out;
}

/** Rotate v (world frame) into sensor frame with q (i.e. apply q*). */
export function rotateToSensor(q: Quat, v: Vec3, out: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
  const a = v[0], b = v[1], c = v[2];
  out[0] = r00 * a + r10 * b + r20 * c;
  out[1] = r01 * a + r11 * b + r21 * c;
  out[2] = r02 * a + r12 * b + r22 * c;
  return out;
}

/** Quaternion from ZYX Euler angles (yaw ψ about z, pitch θ about y, roll φ about x), radians. */
export function quatFromEuler(roll: number, pitch: number, yaw: number, out: Quat): Quat {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  out[0] = cr * cp * cy + sr * sp * sy;
  out[1] = sr * cp * cy - cr * sp * sy;
  out[2] = cr * sp * cy + sr * cp * sy;
  out[3] = cr * cp * sy - sr * sp * cy;
  return out;
}

export function quatYaw(q: Quat): number {
  const [w, x, y, z] = q;
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

export function quatRollPitch(q: Quat): [number, number] {
  const [w, x, y, z] = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const s = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  return [roll, Math.asin(s)];
}

/**
 * Orientation (roll & pitch only, yaw = 0) whose world "up" maps onto the
 * measured specific-force direction. Used to initialise the filter from a
 * stationary accelerometer reading.
 */
export function quatFromGravity(ax: number, ay: number, az: number, out: Quat): Quat {
  const roll = Math.atan2(ay, az);
  const pitch = Math.atan2(-ax, Math.hypot(ay, az));
  return quatFromEuler(roll, pitch, 0, out);
}
