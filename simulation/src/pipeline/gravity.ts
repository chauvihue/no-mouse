// Accelerometer-only gravity tracking (no gyro).
//
// The accelerometer measures gravity + hand acceleration. These filters estimate
// the gravity part so it can be subtracted; what remains is the hand's own
// acceleration. Because the gravity estimate keeps following the accelerometer,
// a tilt left over after a wrist rotation fades out by itself instead of being
// integrated into an ever-growing velocity.
//
//  - complementary: gravity = low-pass(accel), hand accel = the high-passed rest.
//    One fixed time constant.
//  - kalman: gravity is a slowly wandering state; the accelerometer is a
//    measurement of it whose noise grows with how much the hand is moving
//    (accel spread over ~100 ms). Still, even if tilted → follows the new tilt in
//    a fraction of a second; moving → barely updates, so strokes aren't absorbed.
//
// The remaining acceleration is expressed in a level frame: up = the direction
// the accelerometer reads at rest (it measures +1 g upward), right = the sensor's
// x axis projected onto the horizontal plane, forward = up × right.
// Pure TS, no allocation per sample.

import type { Vec3 } from './math.ts';

export interface GravityConfig {
  compTauS: number;        // complementary: low-pass time constant
  kalmanTiltRate: number;  // Kalman process noise: how fast gravity may wander, g/√s
  kalmanNoiseG: number;    // Kalman: accelerometer noise at rest, g
  kalmanSpreadFloorG: number; // Kalman: spread below this is sensor noise, not hand motion, g
  kalmanMotionK: number;   // Kalman: measurement noise added per g of spread above the floor
}

export class GravityTracker {
  /** Gravity estimate in the sensor frame, g. */
  readonly g: Vec3 = [0, 0, 1];
  /** Spread of the accelerometer over ~100 ms (g): ~noise when still (tilted or not), large while moving. */
  spread = 0;
  private P = 1e-4;              // Kalman variance of each gravity component, g²
  private mean: Vec3 = [0, 0, 1];
  private varA = 0;
  private useY = false;          // sensor x is nearly vertical: build the frame from y instead
  private r: Vec3 = [1, 0, 0];   // level frame axes in sensor coordinates
  private f: Vec3 = [0, 1, 0];
  private u: Vec3 = [0, 0, 1];

  /** Starts from a stationary reading (the calibration mean). */
  reset(ax: number, ay: number, az: number): void {
    this.g[0] = ax; this.g[1] = ay; this.g[2] = az;
    this.mean[0] = ax; this.mean[1] = ay; this.mean[2] = az;
    this.varA = 0; this.spread = 0; this.P = 1e-4;
    // Pick the frame-defining axis once, so it can't flip back and forth with noise.
    this.useY = Math.abs(ax) / (Math.hypot(ax, ay, az) || 1) > 0.9;
    this.updateFrame();
  }

  /**
   * Take the recent average reading (~100 ms) as gravity: used once a "stroke" has turned out
   * to be a wrist tilt. Never a single reading: with real vibration one sample can be 0.1 g off.
   */
  retake(): void {
    this.g[0] = this.mean[0]; this.g[1] = this.mean[1]; this.g[2] = this.mean[2];
    this.P = 1e-4;
    this.updateFrame();
  }

  /**
   * Updates `spread` from one reading. The pipeline calls this on every sample in
   * every mode: besides driving the Kalman gain, it's the tilt-independent half of
   * the rest test (a tilted but motionless sensor reads a steady accel vector).
   */
  observe(ax: number, ay: number, az: number, dt: number): void {
    // ~100 ms windows: long enough to see a smooth stroke, short enough to settle soon after it
    const am = Math.min(1, dt / 0.1), av = Math.min(1, dt / 0.1);
    this.mean[0] += (ax - this.mean[0]) * am;
    this.mean[1] += (ay - this.mean[1]) * am;
    this.mean[2] += (az - this.mean[2]) * am;
    const dx = ax - this.mean[0], dy = ay - this.mean[1], dz = az - this.mean[2];
    this.varA += (dx * dx + dy * dy + dz * dz - this.varA) * av;
    this.spread = Math.sqrt(this.varA);
  }

  complementary(ax: number, ay: number, az: number, dt: number, c: GravityConfig): void {
    const k = Math.min(1, dt / c.compTauS);
    this.g[0] += (ax - this.g[0]) * k;
    this.g[1] += (ay - this.g[1]) * k;
    this.g[2] += (az - this.g[2]) * k;
    this.updateFrame();
  }

  /** Call observe() for this reading first: the gain depends on the current spread. */
  kalman(ax: number, ay: number, az: number, dt: number, c: GravityConfig): void {
    // predict: gravity (in the sensor frame) drifts as a random walk
    const Pp = this.P + c.kalmanTiltRate * c.kalmanTiltRate * dt;
    // update: accel = gravity + hand acceleration; the hand part counts as measurement noise
    const m = c.kalmanMotionK * Math.max(0, this.spread - c.kalmanSpreadFloorG);
    const R = c.kalmanNoiseG * c.kalmanNoiseG + m * m;
    const K = Pp / (Pp + R);
    this.g[0] += (ax - this.g[0]) * K;
    this.g[1] += (ay - this.g[1]) * K;
    this.g[2] += (az - this.g[2]) * K;
    this.P = (1 - K) * Pp;
    this.updateFrame();
  }

  private updateFrame(): void {
    const n = Math.hypot(this.g[0], this.g[1], this.g[2]) || 1;
    const u = this.u; u[0] = this.g[0] / n; u[1] = this.g[1] / n; u[2] = this.g[2] / n;
    if (!this.useY) {
      // right = sensor x with its vertical part removed; forward = up × right
      const d = u[0];
      const r = this.r; r[0] = 1 - d * u[0]; r[1] = -d * u[1]; r[2] = -d * u[2];
      const rn = Math.hypot(r[0], r[1], r[2]) || 1; r[0] /= rn; r[1] /= rn; r[2] /= rn;
      cross(u, r, this.f);
    } else {
      // forward = sensor y with its vertical part removed; right = forward × up
      const d = u[1];
      const f = this.f; f[0] = -d * u[0]; f[1] = 1 - d * u[1]; f[2] = -d * u[2];
      const fn = Math.hypot(f[0], f[1], f[2]) || 1; f[0] /= fn; f[1] /= fn; f[2] /= fn;
      cross(f, u, this.r);
    }
  }

  /** Hand acceleration (g) in the level frame: out = [right, forward, up]. */
  linear(ax: number, ay: number, az: number, out: Vec3): Vec3 {
    const dx = ax - this.g[0], dy = ay - this.g[1], dz = az - this.g[2];
    const r = this.r, f = this.f, u = this.u;
    out[0] = dx * r[0] + dy * r[1] + dz * r[2];
    out[1] = dx * f[0] + dy * f[1] + dz * f[2];
    out[2] = dx * u[0] + dy * u[1] + dz * u[2];
    return out;
  }
}

function cross(a: Vec3, b: Vec3, out: Vec3): void {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
}
