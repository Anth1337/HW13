/*
 * Device orientation -> camera quaternion in OUR world frame (y up, camera looks down -z).
 *
 * Source data: DeviceOrientationEvent (alpha/beta/gamma, absolute gravity + gyro fusion done by
 * the OS) and, when present, DeviceMotionEvent.rotationRate (raw gyro, deg/s).
 *
 *  - raw quaternion: the standard three.js DeviceOrientationControls math
 *    (Euler YXZ(beta, alpha, -gamma) * Rx(-90deg) * Rz(-screenAngle)). It is built directly from
 *    the angles, so it has no gimbal singularity of its own at beta = 90 (phone upright); the
 *    quaternion stays continuous and we always slerp along the short arc.
 *  - complementary filter: the gyro rate propagates the fused quaternion between orientation
 *    events (smooth, low latency); each orientation event pulls it back to the absolute value
 *    (kills gyro bias). Without a (trustworthy) gyro, orientation alone is low-passed with a
 *    rate-adaptive slerp: light when moving (no lag), stronger when still (no jitter).
 *  - the gyro is SELF-CHECKED: its angular velocity must agree with the finite difference of the
 *    orientation samples (direction and magnitude). If not (axis convention differs on some
 *    browser), it is disabled for the session and orientation alone is used. If it is merely
 *    reported in rad/s instead of deg/s it is rescaled.
 *  - yaw is RELATIVE: recenter() zeroes the heading so the camera looks along -z; pitch / roll
 *    stay absolute (gravity). Compass drift of iOS yaw is not corrected here.
 *
 * Timestamps are milliseconds in the performance.now() timebase. No per-sample allocation.
 */

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

const DEG = Math.PI / 180;
const HALF_SQRT = Math.sqrt(0.5);
const HIST = 256;

function qMul(a: Quat, b: Quat, o: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x;
  o.y = y;
  o.z = z;
  o.w = w;
  return o;
}

function qNorm(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  q.x /= l;
  q.y /= l;
  q.z /= l;
  q.w /= l;
  return q;
}

/** Short-arc slerp (nlerp for tiny angles). o may alias a. */
function qSlerp(a: Quat, b: Quat, t: number, o: Quat): Quat {
  let bx = b.x,
    by = b.y,
    bz = b.z,
    bw = b.w;
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number, s1: number;
  if (dot > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const th = Math.acos(dot);
    const sn = Math.sin(th);
    s0 = Math.sin((1 - t) * th) / sn;
    s1 = Math.sin(t * th) / sn;
  }
  o.x = a.x * s0 + bx * s1;
  o.y = a.y * s0 + by * s1;
  o.z = a.z * s0 + bz * s1;
  o.w = a.w * s0 + bw * s1;
  return qNorm(o);
}

/** q = q * exp(rotation vector w*dt) (rotation about the quaternion's LOCAL axes). */
function qIntegrate(q: Quat, wx: number, wy: number, wz: number, dt: number): void {
  const rx = wx * dt,
    ry = wy * dt,
    rz = wz * dt;
  const ang = Math.hypot(rx, ry, rz);
  if (ang < 1e-9) return;
  const half = ang * 0.5;
  const k = Math.sin(half) / ang;
  const dx = rx * k,
    dy = ry * k,
    dz = rz * k,
    dw = Math.cos(half);
  const x = q.w * dx + q.x * dw + q.y * dz - q.z * dy;
  const y = q.w * dy - q.x * dz + q.y * dw + q.z * dx;
  const z = q.w * dz + q.x * dy - q.y * dx + q.z * dw;
  const w = q.w * dw - q.x * dx - q.y * dy - q.z * dz;
  q.x = x;
  q.y = y;
  q.z = z;
  q.w = w;
  qNorm(q);
}

/**
 * three.js DeviceOrientationControls: device orientation (degrees) + screen angle (degrees)
 * -> camera quaternion (camera looks out of the BACK of the phone, y up in the image).
 */
export function deviceQuaternion(alphaDeg: number, betaDeg: number, gammaDeg: number, screenAngleDeg: number, out: Quat): Quat {
  const x = betaDeg * DEG * 0.5;
  const y = alphaDeg * DEG * 0.5;
  const z = -gammaDeg * DEG * 0.5;
  const c1 = Math.cos(x),
    c2 = Math.cos(y),
    c3 = Math.cos(z);
  const s1 = Math.sin(x),
    s2 = Math.sin(y),
    s3 = Math.sin(z);
  // Euler 'YXZ'
  out.x = s1 * c2 * c3 + c1 * s2 * s3;
  out.y = c1 * s2 * c3 - s1 * c2 * s3;
  out.z = c1 * c2 * s3 - s1 * s2 * c3;
  out.w = c1 * c2 * c3 + s1 * s2 * s3;
  // * Rx(-90deg): the camera looks out of the back of the device
  const bx = -HALF_SQRT,
    bw = HALF_SQRT;
  let qx = out.x * bw + out.w * bx;
  let qy = out.y * bw + out.z * bx;
  let qz = out.z * bw - out.y * bx;
  let qw = out.w * bw - out.x * bx;
  // * Rz(-screenAngle)
  const h = -screenAngleDeg * DEG * 0.5;
  const zs = Math.sin(h),
    zw = Math.cos(h);
  const ox = qx * zw + qy * zs;
  const oy = qy * zw - qx * zs;
  const oz = qz * zw + qw * zs;
  const ow = qw * zw - qz * zs;
  qx = ox;
  qy = oy;
  qz = oz;
  qw = ow;
  out.x = qx;
  out.y = qy;
  out.z = qz;
  out.w = qw;
  return qNorm(out);
}

export class OrientationFilter {
  /** True after the first valid orientation sample. */
  hasData = false;
  /** Timestamp (ms) of the last orientation sample. */
  lastSampleTime = -Infinity;
  /** False once the gyro self-check rejected rotationRate. */
  gyroEnabled = true;
  private gyroBad = 0;

  private screenAngle = 0;
  private resync = true;

  private readonly qf: Quat = { x: 0, y: 0, z: 0, w: 1 }; // fused (before yaw zero)
  private readonly qRaw: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly qPrevRaw: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly yz: Quat = { x: 0, y: 0, z: 0, w: 1 }; // yaw zero (pre-multiplied)
  private readonly tmp: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly tmp2: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private tF = 0;
  private tPrevRaw = 0;
  private havePrevRaw = false;

  // gyro (camera-local axes, rad/s)
  private wx = 0;
  private wy = 0;
  private wz = 0;
  private tGyro = -Infinity;
  private gyroScale = 1;
  // gyro self-check accumulators
  private sDot = 0;
  private sGG = 0;
  private sOO = 0;
  private sEnergy = 0;
  // orientation-derived angular speed (rad/s, EMA)
  private woSpeed = 0;

  // history ring: t, x, y, z, w
  private readonly hist = new Float64Array(HIST * 5);
  private histHead = 0;
  private histCount = 0;

  setScreenAngle(deg: number): void {
    if (!Number.isFinite(deg)) return;
    const a = ((deg % 360) + 360) % 360;
    if (a === this.screenAngle) return;
    this.screenAngle = a;
    this.resync = true; // the raw quaternion jumps by a roll of 90 deg: re-sync instead of slerping
    this.havePrevRaw = false;
  }

  /** alpha/beta/gamma in degrees (event values), t in ms. Ignores null/NaN samples. */
  pushOrientation(alpha: number | null, beta: number | null, gamma: number | null, t: number): void {
    if (alpha == null || beta == null || gamma == null) return;
    if (!(Number.isFinite(alpha) && Number.isFinite(beta) && Number.isFinite(gamma) && Number.isFinite(t))) return;
    if (this.hasData && t <= this.lastSampleTime) return;
    const raw = deviceQuaternion(alpha, beta, gamma, this.screenAngle, this.qRaw);

    if (!this.hasData) {
      this.qf.x = raw.x;
      this.qf.y = raw.y;
      this.qf.z = raw.z;
      this.qf.w = raw.w;
      this.tF = t;
      this.hasData = true;
      this.resync = false;
      this.zeroYaw();
      this.lastSampleTime = t;
      this.qPrevRaw.x = raw.x;
      this.qPrevRaw.y = raw.y;
      this.qPrevRaw.z = raw.z;
      this.qPrevRaw.w = raw.w;
      this.tPrevRaw = t;
      this.havePrevRaw = true;
      this.record(t);
      return;
    }

    // 1) orientation-derived angular velocity (also feeds the gyro self-check)
    let oSpeed = this.woSpeed;
    if (this.havePrevRaw) {
      const dtr = (t - this.tPrevRaw) / 1000;
      if (dtr > 0.002 && dtr < 0.2) this.observeRaw(raw, dtr, t);
      oSpeed = this.woSpeed;
    }
    this.qPrevRaw.x = raw.x;
    this.qPrevRaw.y = raw.y;
    this.qPrevRaw.z = raw.z;
    this.qPrevRaw.w = raw.w;
    this.tPrevRaw = t;
    this.havePrevRaw = true;

    // 2) propagate with the gyro up to t, then correct toward the absolute orientation
    if (this.resync || t - this.lastSampleTime > 500) {
      this.qf.x = raw.x;
      this.qf.y = raw.y;
      this.qf.z = raw.z;
      this.qf.w = raw.w;
      this.tF = t;
      this.resync = false;
    } else {
      this.propagate(t);
      const dt = Math.max(0.001, (t - this.lastSampleTime) / 1000);
      const gyroOk = this.gyroActive(t);
      let tau: number;
      if (gyroOk) {
        // gyro carries the motion; the absolute value only removes bias / jitter
        tau = oSpeed < 0.05 ? 0.5 : 0.25;
      } else {
        // orientation only: light when moving (no lag), strong when still (no jitter)
        const k = Math.min(1, Math.max(0, (oSpeed - 0.03) / 0.57));
        tau = 0.12 + (0.012 - 0.12) * k;
      }
      qSlerp(this.qf, raw, 1 - Math.exp(-dt / tau), this.qf);
    }
    this.lastSampleTime = t;
    this.record(t);
  }

  /** rotationRate in deg/s (alpha = about z, beta = about x, gamma = about y of the device). */
  pushRotationRate(alpha: number | null, beta: number | null, gamma: number | null, t: number): void {
    if (!this.hasData || !this.gyroEnabled) return;
    if (alpha == null || beta == null || gamma == null) return;
    if (!(Number.isFinite(alpha) && Number.isFinite(beta) && Number.isFinite(gamma) && Number.isFinite(t))) return;
    this.propagate(t);
    const k = DEG * this.gyroScale;
    const fx = beta * k,
      fy = gamma * k,
      fz = alpha * k;
    // device axes -> camera axes: rotate about z by +screenAngle
    const c = Math.cos(this.screenAngle * DEG),
      s = Math.sin(this.screenAngle * DEG);
    this.wx = fx * c - fy * s;
    this.wy = fx * s + fy * c;
    this.wz = fz;
    this.tGyro = t;
  }

  /** Zero the yaw: the camera's current heading becomes -z. Pitch / roll stay absolute. */
  recenter(): void {
    if (this.hasData) this.zeroYaw();
    this.histCount = 0;
    this.histHead = 0;
    if (this.hasData) this.record(this.lastSampleTime);
  }

  /** Angular speed (rad/s), gyro if fresh else from the orientation samples. */
  get angularSpeed(): number {
    return this.gyroActive(this.tF) ? Math.hypot(this.wx, this.wy, this.wz) : this.woSpeed;
  }

  get gyroActiveNow(): boolean {
    return this.gyroActive(this.tF);
  }

  /** World camera quaternion now (gyro-extrapolated by <= 50 ms). */
  getQuaternion(out: Quat, tMs: number): Quat {
    const q = this.tmp;
    q.x = this.qf.x;
    q.y = this.qf.y;
    q.z = this.qf.z;
    q.w = this.qf.w;
    const dt = (tMs - this.tF) / 1000;
    if (dt > 0 && this.gyroActive(tMs)) qIntegrate(q, this.wx, this.wy, this.wz, Math.min(dt, 0.05));
    return qMul(this.yz, q, out);
  }

  /** World camera quaternion at the (past) time tMs, from the history ring. */
  quaternionAt(out: Quat, tMs: number): Quat {
    const n = this.histCount;
    if (n === 0) return this.getQuaternion(out, tMs);
    const h = this.hist;
    const newest = (this.histHead - 1 + HIST) % HIST;
    if (tMs >= h[newest * 5]) return this.getQuaternion(out, Math.min(tMs, h[newest * 5] + 100));
    const q = this.tmp;
    // walk back from the newest entry to the first one with time <= tMs
    let i = newest;
    for (let k = 0; k < n - 1; k++) {
      const j = (i - 1 + HIST) % HIST;
      if (h[j * 5] <= tMs) {
        const t0 = h[j * 5],
          t1 = h[i * 5];
        const a = this.tmp2;
        a.x = h[j * 5 + 1];
        a.y = h[j * 5 + 2];
        a.z = h[j * 5 + 3];
        a.w = h[j * 5 + 4];
        q.x = h[i * 5 + 1];
        q.y = h[i * 5 + 2];
        q.z = h[i * 5 + 3];
        q.w = h[i * 5 + 4];
        qSlerp(a, q, t1 > t0 ? (tMs - t0) / (t1 - t0) : 1, q);
        return qMul(this.yz, q, out);
      }
      i = j;
    }
    q.x = h[i * 5 + 1];
    q.y = h[i * 5 + 2];
    q.z = h[i * 5 + 3];
    q.w = h[i * 5 + 4];
    return qMul(this.yz, q, out);
  }

  // ---------------------------------------------------------------------------------------

  private gyroActive(t: number): boolean {
    return this.gyroEnabled && t - this.tGyro < 150;
  }

  private propagate(t: number): void {
    const dt = (t - this.tF) / 1000;
    if (dt <= 0) return;
    if (dt < 0.2 && this.gyroActive(t)) qIntegrate(this.qf, this.wx, this.wy, this.wz, dt);
    this.tF = t;
  }

  private record(t: number): void {
    const o = this.histHead * 5;
    this.hist[o] = t;
    this.hist[o + 1] = this.qf.x;
    this.hist[o + 2] = this.qf.y;
    this.hist[o + 3] = this.qf.z;
    this.hist[o + 4] = this.qf.w;
    this.histHead = (this.histHead + 1) % HIST;
    if (this.histCount < HIST) this.histCount++;
  }

  private zeroYaw(): void {
    const q = this.qf;
    // forward (0,0,-1) and up (0,1,0) of the camera in the device-world frame
    const fx = -2 * (q.x * q.z + q.w * q.y);
    const fy = -2 * (q.y * q.z - q.w * q.x);
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const ux = 2 * (q.x * q.y - q.w * q.z);
    const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
    const uz = 2 * (q.y * q.z + q.w * q.x);
    let hx: number, hz: number;
    if (Math.abs(fy) < 0.9) {
      hx = fx;
      hz = fz;
    } else if (fy < 0) {
      // looking down: the image-up vector points along the heading
      hx = ux;
      hz = uz;
    } else {
      hx = -ux;
      hz = -uz;
    }
    void uy;
    const l = Math.hypot(hx, hz);
    if (l < 1e-6) {
      this.yz.x = 0;
      this.yz.y = 0;
      this.yz.z = 0;
      this.yz.w = 1;
      return;
    }
    hx /= l;
    hz /= l;
    // Ry(a) maps (hx,hz) to (0,-1) for cos a = -hz, sin a = hx
    const a = Math.atan2(hx, -hz);
    this.yz.x = 0;
    this.yz.y = Math.sin(a / 2);
    this.yz.z = 0;
    this.yz.w = Math.cos(a / 2);
  }

  /** Finite-difference angular velocity of the raw samples, gyro self-check. */
  private observeRaw(raw: Quat, dt: number, t: number): void {
    // d = conj(prev) * raw  (local-frame increment)
    const p = this.qPrevRaw;
    let dx = p.w * raw.x - p.x * raw.w - p.y * raw.z + p.z * raw.y;
    let dy = p.w * raw.y + p.x * raw.z - p.y * raw.w - p.z * raw.x;
    let dz = p.w * raw.z - p.x * raw.y + p.y * raw.x - p.z * raw.w;
    const dw = p.w * raw.w + p.x * raw.x + p.y * raw.y + p.z * raw.z;
    if (dw < 0) {
      dx = -dx;
      dy = -dy;
      dz = -dz;
    }
    const sn = Math.hypot(dx, dy, dz);
    const ang = 2 * Math.atan2(sn, Math.abs(dw));
    const k = sn > 1e-9 ? ang / sn / dt : 0;
    const ox = dx * k,
      oy = dy * k,
      oz = dz * k;
    const sp = ang / dt;
    this.woSpeed += (sp - this.woSpeed) * 0.35;

    if (!this.gyroEnabled || t - this.tGyro > 60) return;
    const gx = this.wx,
      gy = this.wy,
      gz = this.wz;
    this.sDot += (gx * ox + gy * oy + gz * oz) * dt;
    this.sGG += (gx * gx + gy * gy + gz * gz) * dt;
    this.sOO += (ox * ox + oy * oy + oz * oz) * dt;
    this.sEnergy += sp * dt;
    if (this.sEnergy >= 0.8) {
      const den = Math.sqrt(this.sGG * this.sOO);
      const cos = den > 1e-12 ? this.sDot / den : 0;
      const ratio = this.sOO > 1e-12 ? Math.sqrt(this.sGG / this.sOO) : 0;
      if (ratio > 0.012 && ratio < 0.025 && cos > 0.5) {
        // rotationRate delivered in rad/s: rescale and re-evaluate
        this.gyroScale *= 57.29578;
      } else if (cos < 0.5 || ratio < 0.5 || ratio > 2) {
        // a single bad window (shake, stale vector) is not proof; need 3 in a row
        if (++this.gyroBad >= 3) this.gyroEnabled = false;
      } else {
        this.gyroBad = 0;
      }
      this.sDot = this.sGG = this.sOO = this.sEnergy = 0;
    }
  }
}
