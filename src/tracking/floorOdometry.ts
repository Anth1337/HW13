/*
 * Visual odometry on the FLOOR PLANE (y = 0), pure TypeScript, no libraries.
 *
 * Idea: rotation comes from the gyro (orientation.ts) so only the 3 translation unknowns are
 * left. Corners found in the part of the image that sees the floor are back-projected onto the
 * plane with the assumed camera height -> metric LANDMARKS X_i (world). Each frame the landmarks
 * are tracked with pyramidal Lucas-Kanade (initial guess = the landmark projected with the gyro
 * rotation, so fast turns do not break tracking), and the camera position p is the point for
 * which every landmark X_i lies on its observed ray r_i:
 *
 *     minimise  sum_i w_i * |(I - r_i r_i^T)(X_i - p)|^2,   w_i = f^2 / |X_i - p|^2   (pixels^2)
 *
 * = a 3x3 linear system, wrapped in RANSAC (+ the "no motion" hypothesis p = previous p) and IRLS.
 * Absolute-to-landmarks (not frame-to-frame integration) => slow motion accumulates until it is
 * statistically significant instead of being lost in a per-frame dead band.
 *
 * Rotation-only / still: a significance test compares the residual at the old position with the
 * residual at the solved one. A reduction explained by pixel noise (plus an allowance
 * proportional to the angular speed, i.e. gyro inaccuracy) keeps the position EXACTLY.
 *
 * Observability notes (honest limits):
 *  - metric scale comes only from the assumed camera height; an error of 10% in height is a 10%
 *    error in distance walked. Motion only along the viewing axis of a far floor is weak.
 *  - gyro yaw / pitch error, or a timing offset between gyro and video, appears as spurious
 *    translation; the significance gate inflates with angular speed to suppress it.
 *  - height (y) is observable but fragile (confounded with pitch error): it is only allowed to
 *    drift slowly and within +-30% of the assumed height.
 *  - hands / pets moving in view are non-rigid: RANSAC + landmark rejection handle them.
 *  - no floor texture (polished concrete, plain carpet in dim light): reports few features.
 */

export interface OdometryOptions {
  width: number;
  height: number;
  /** Long-side field of view of the frame, degrees. */
  fovLongSideDeg: number;
  /** Camera height above y = 0, meters. */
  cameraHeight: number;
  maxFeatures?: number;
}

export interface OdometryResult {
  x: number;
  y: number;
  z: number;
  /** Landmarks tracked this frame (after LK). */
  tracked: number;
  /** RANSAC inliers of the final solution. */
  inliers: number;
  /** 0..1 */
  quality: number;
  /** 0..1: how widely the inliers are spread over the image. */
  spread: number;
  /** Position changed this frame (passed the significance test). */
  moved: boolean;
  /** Length of this frame's position step (m). */
  step: number;
  /** Fraction (0..1) of the image that sees floor at a usable range. */
  floorFraction: number;
  /** Many landmarks were lost at once while a fair number existed: fast motion / blur. */
  blurred: boolean;
  /** Too few landmarks to say anything: position is held. */
  lost: boolean;
  /** A solve was attempted with enough inliers (or confidently still). */
  valid: boolean;
}

const LEVELS = 3;
const PR = 3; // LK patch half size -> 7x7
const PW = 2 * PR + 1;
const SIN_E_MIN = 0.2; // floor rays must dip > ~11.5 deg below the horizon
const RANGE_MAX = 6.5;
const CELLS_X = 8;
const CELLS_Y = 6;
const MAX_SPEED = 3.2; // m/s
const PX_SIGMA = 0.5;
const TAU_IN = 1.6; // inlier threshold (px)
const MAX_OMEGA = 1.5; // rad/s (~86 deg/s): above this a few ms of timing error is several degrees
const GATE_K = 5; // cost reduction must exceed GATE_K * sigma_eff^2 (20 held ~1 cm/frame walking steps while turning: 30-40% of the distance lost)

export class FloorOdometry {
  readonly width: number;
  readonly height: number;
  private f: number;
  private readonly cx: number;
  private readonly cy: number;
  private h: number;
  private readonly maxF: number;

  // pose
  private px = 0;
  private py: number;
  private pz = 0;
  private lastT = -1;
  private frameNo = 0;

  // pyramids: two slots x LEVELS
  private pyr: Uint8Array[][];
  private pw: number[] = [];
  private ph: number[] = [];
  private cur = 0;
  private havePrev = false;

  // landmarks (SoA)
  private n = 0;
  private readonly fx: Float32Array; // pixel position (current frame)
  private readonly fy: Float32Array;
  private readonly X: Float64Array; // 3 per landmark
  private readonly age: Int32Array;
  private readonly maxAge: Int32Array;
  private readonly bad: Uint8Array;
  private readonly gxp: Float32Array; // LK guess
  private readonly gyp: Float32Array;
  private readonly okf: Uint8Array;

  // solve scratch
  private readonly rr: Float64Array; // unit world rays, 3/lm
  private readonly rw: Float64Array; // sqrt weight
  private readonly inl: Uint8Array;
  private readonly idx: Int32Array;
  private rng = 123456789;

  // detection scratch
  private readonly iXX: Float64Array;
  private readonly iXY: Float64Array;
  private readonly iYY: Float64Array;
  private readonly cellCount: Uint8Array;

  // LK scratch
  private readonly patch: Float32Array; // (PW+2)^2
  private readonly tmpl: Float32Array; // PW^2
  private readonly tgx: Float32Array;
  private readonly tgy: Float32Array;

  private readonly res: OdometryResult = {
    x: 0, y: 0, z: 0, tracked: 0, inliers: 0, quality: 0, spread: 0, moved: false, step: 0,
    floorFraction: 0, blurred: false, lost: true, valid: false,
  };

  constructor(o: OdometryOptions) {
    this.width = o.width;
    this.height = o.height;
    this.h = o.cameraHeight;
    this.py = o.cameraHeight;
    this.f = 1;
    this.setFov(o.fovLongSideDeg);
    this.cx = (o.width - 1) / 2;
    this.cy = (o.height - 1) / 2;
    const m = (this.maxF = o.maxFeatures ?? 80);
    this.pyr = [[], []];
    for (let s = 0; s < 2; s++) {
      for (let l = 0; l < LEVELS; l++) {
        const w = Math.max(8, o.width >> l),
          hh = Math.max(8, o.height >> l);
        this.pyr[s].push(new Uint8Array(w * hh));
        if (s === 0) {
          this.pw.push(w);
          this.ph.push(hh);
        }
      }
    }
    this.fx = new Float32Array(m);
    this.fy = new Float32Array(m);
    this.X = new Float64Array(m * 3);
    this.age = new Int32Array(m);
    this.maxAge = new Int32Array(m);
    this.bad = new Uint8Array(m);
    this.gxp = new Float32Array(m);
    this.gyp = new Float32Array(m);
    this.okf = new Uint8Array(m);
    this.rr = new Float64Array(m * 3);
    this.rw = new Float64Array(m);
    this.inl = new Uint8Array(m);
    this.idx = new Int32Array(m);
    const iz = (o.width + 1) * (o.height + 1);
    this.iXX = new Float64Array(iz);
    this.iXY = new Float64Array(iz);
    this.iYY = new Float64Array(iz);
    this.cellCount = new Uint8Array(CELLS_X * CELLS_Y);
    this.patch = new Float32Array((PW + 2) * (PW + 2));
    this.tmpl = new Float32Array(PW * PW);
    this.tgx = new Float32Array(PW * PW);
    this.tgy = new Float32Array(PW * PW);
    this.res.x = 0;
    this.res.y = this.py;
  }

  setFov(longSideFovDeg: number): void {
    const fov = Math.min(150, Math.max(20, longSideFovDeg)) * (Math.PI / 180);
    this.f = (Math.max(this.width, this.height) / 2) / Math.tan(fov / 2);
    // landmarks were metric, their pixel positions stay valid: nothing else to rebuild
  }

  /** Put the camera at (x, y, z) and forget all landmarks. */
  reset(x: number, y: number, z: number): void {
    this.px = x;
    this.py = y;
    this.pz = z;
    this.n = 0;
    this.havePrev = false;
    this.lastT = -1;
    this.h = y;
  }

  get position(): { x: number; y: number; z: number } {
    return { x: this.px, y: this.py, z: this.pz };
  }

  /**
   * @param gray   width*height luma (copied; may be reused by the caller)
   * @param R      camera->world rotation, row-major 3x3 (camera looks down -z, y up)
   * @param tSec   frame time (s)
   * @param omega  angular speed (rad/s) around the frame time
   */
  process(gray: Uint8Array, R: ArrayLike<number>, tSec: number, omega: number): OdometryResult {
    const res = this.res;
    res.moved = false;
    res.step = 0;
    res.blurred = false;
    res.valid = false;
    res.inliers = 0;
    res.tracked = 0;
    res.spread = 0;
    res.quality = 0;
    try {
      this.frameNo++;
      const dt = this.lastT < 0 ? 0 : Math.min(1, Math.max(0.001, tSec - this.lastT));
      this.lastT = tSec;
      this.buildPyramid(gray);
      res.floorFraction = this.floorFraction(R);
      if (this.havePrev && this.n > 0 && dt > 0) {
        const before = this.n;
        this.track(R);
        res.tracked = this.n;
        if (before >= 12 && this.n < before * 0.35) res.blurred = true;
        this.solve(R, dt, omega);
      }
      this.seed(R);
      res.lost = this.n < 8;
      this.cur ^= 1;
      this.havePrev = true;
    } catch (e) {
      this.n = 0;
      this.havePrev = false;
      res.lost = true;
    }
    res.x = this.px;
    res.y = this.py;
    res.z = this.pz;
    return res;
  }

  // ------------------------------------------------------------------ pyramid

  private buildPyramid(gray: Uint8Array): void {
    const P = this.pyr[this.cur ^ 0];
    // `cur` slot holds the NEW frame; the other slot holds the previous one.
    P[0].set(gray.length === P[0].length ? gray : gray.subarray(0, P[0].length));
    for (let l = 1; l < LEVELS; l++) {
      const src = P[l - 1],
        dst = P[l];
      const sw = this.pw[l - 1],
        dw = this.pw[l],
        dh = this.ph[l];
      for (let y = 0; y < dh; y++) {
        let s0 = y * 2 * sw;
        let d = y * dw;
        for (let x = 0; x < dw; x++, s0 += 2) {
          dst[d++] = (src[s0] + src[s0 + 1] + src[s0 + sw] + src[s0 + sw + 1] + 2) >> 2;
        }
      }
    }
  }

  // ------------------------------------------------------------------ geometry

  private floorFraction(R: ArrayLike<number>): number {
    let cnt = 0;
    const w = this.width,
      h = this.height;
    for (let j = 0; j < 5; j++) {
      const y = ((j + 0.5) / 5) * h;
      for (let i = 0; i < 5; i++) {
        const x = ((i + 0.5) / 5) * w;
        if (this.sinElev(R, x, y) > SIN_E_MIN) cnt++;
      }
    }
    return cnt / 25;
  }

  /** sin of the elevation below the horizon of pixel (x,y)'s ray (positive = looking down). */
  private sinElev(R: ArrayLike<number>, x: number, y: number): number {
    const dx = (x - this.cx) / this.f,
      dy = -(y - this.cy) / this.f;
    const ry = R[3] * dx + R[4] * dy - R[5];
    return -ry / Math.sqrt(dx * dx + dy * dy + 1);
  }

  // ------------------------------------------------------------------ LK tracking

  private track(R: ArrayLike<number>): void {
    const prevP = this.pyr[this.cur ^ 1];
    const curP = this.pyr[this.cur];
    const w = this.width,
      h = this.height,
      f = this.f;
    const R0 = R[0], R1 = R[1], R2 = R[2], R3 = R[3], R4 = R[4], R5 = R[5], R6 = R[6], R7 = R[7], R8 = R[8];
    const n = this.n;
    const X = this.X;
    for (let i = 0; i < n; i++) {
      // predicted pixel: project landmark with the NEW rotation and the (old) position
      const ex = X[i * 3] - this.px,
        ey = X[i * 3 + 1] - this.py,
        ez = X[i * 3 + 2] - this.pz;
      const vx = R0 * ex + R3 * ey + R6 * ez;
      const vy = R1 * ex + R4 * ey + R7 * ez;
      const vz = R2 * ex + R5 * ey + R8 * ez;
      let ok = 0;
      if (vz < -0.05) {
        const gx = this.cx + (f * vx) / -vz,
          gy = this.cy - (f * vy) / -vz;
        this.gxp[i] = gx;
        this.gyp[i] = gy;
        ok = gx > PR + 3 && gx < w - PR - 4 && gy > PR + 3 && gy < h - PR - 4 ? 1 : 0;
      }
      this.okf[i] = ok;
    }
    let m = 0;
    for (let i = 0; i < n; i++) {
      let ok = this.okf[i] === 1;
      let gx = this.gxp[i],
        gy = this.gyp[i];
      if (ok) {
        const r = this.lk(prevP, curP, this.fx[i], this.fy[i], gx, gy);
        if (r) {
          gx = this.lkX;
          gy = this.lkY;
          // sanity: LK must stay near the gyro prediction (translation flow is small)
          const dxp = gx - this.gxp[i],
            dyp = gy - this.gyp[i];
          ok = dxp * dxp + dyp * dyp < 14 * 14;
        } else ok = false;
      }
      if (!ok) continue;
      if (m !== i) {
        this.X[m * 3] = this.X[i * 3];
        this.X[m * 3 + 1] = this.X[i * 3 + 1];
        this.X[m * 3 + 2] = this.X[i * 3 + 2];
        this.age[m] = this.age[i];
        this.maxAge[m] = this.maxAge[i];
        this.bad[m] = this.bad[i];
      }
      this.fx[m] = gx;
      this.fy[m] = gy;
      this.age[m]++;
      m++;
    }
    this.n = m;
  }

  private lkX = 0;
  private lkY = 0;

  /** Pyramidal LK of the patch at (tx,ty) in prev toward guess (gx,gy) in cur. Result in lkX/lkY. */
  private lk(prevP: Uint8Array[], curP: Uint8Array[], tx0: number, ty0: number, gx0: number, gy0: number): boolean {
    let gx = gx0,
      gy = gy0;
    const patch = this.patch,
      tmpl = this.tmpl,
      tgx = this.tgx,
      tgy = this.tgy;
    const PP = PW + 2;
    let lastErr = 0;
    for (let l = LEVELS - 1; l >= 0; l--) {
      const s = 1 / (1 << l);
      const W = this.pw[l],
        H = this.ph[l];
      const pi = prevP[l],
        ci = curP[l];
      const tx = tx0 * s,
        ty = ty0 * s;
      const m = PR + 3;
      if (tx < m || ty < m || tx >= W - m || ty >= H - m) {
        if (l === 0) return false;
        continue;
      }
      // template patch with 1px border (for gradients), constant bilinear weights
      const x0 = Math.floor(tx),
        y0 = Math.floor(ty);
      const ax = tx - x0,
        ay = ty - y0;
      const w00 = (1 - ax) * (1 - ay),
        w10 = ax * (1 - ay),
        w01 = (1 - ax) * ay,
        w11 = ax * ay;
      let k = 0;
      for (let j = -PR - 1; j <= PR + 1; j++) {
        let o = (y0 + j) * W + x0 - PR - 1;
        for (let i = -PR - 1; i <= PR + 1; i++, o++) {
          patch[k++] = pi[o] * w00 + pi[o + 1] * w10 + pi[o + W] * w01 + pi[o + W + 1] * w11;
        }
      }
      let hxx = 0,
        hxy = 0,
        hyy = 0;
      k = 0;
      for (let j = 0; j < PW; j++) {
        let o = (j + 1) * PP + 1;
        for (let i = 0; i < PW; i++, o++, k++) {
          const gxv = (patch[o + 1] - patch[o - 1]) * 0.5;
          const gyv = (patch[o + PP] - patch[o - PP]) * 0.5;
          tmpl[k] = patch[o];
          tgx[k] = gxv;
          tgy[k] = gyv;
          hxx += gxv * gxv;
          hxy += gxv * gyv;
          hyy += gyv * gyv;
        }
      }
      const N = PW * PW;
      const tr = (hxx + hyy) / N;
      const det = hxx * hyy - hxy * hxy;
      const minEig = tr / 2 - Math.sqrt(Math.max(0, (tr / 2) * (tr / 2) - det / (N * N)));
      if (minEig < 2) return l === LEVELS - 1 ? false : l === 0 ? false : false;
      const idet = 1 / det;
      // iterate
      let cxl = gx * s,
        cyl = gy * s;
      for (let it = 0; it < 6; it++) {
        if (cxl < m || cyl < m || cxl >= W - m || cyl >= H - m) return false;
        const cx0 = Math.floor(cxl),
          cy0 = Math.floor(cyl);
        const bx = cxl - cx0,
          by = cyl - cy0;
        const v00 = (1 - bx) * (1 - by),
          v10 = bx * (1 - by),
          v01 = (1 - bx) * by,
          v11 = bx * by;
        let b0 = 0,
          b1 = 0,
          ae = 0;
        k = 0;
        for (let j = -PR; j <= PR; j++) {
          let o = (cy0 + j) * W + cx0 - PR;
          for (let i = -PR; i <= PR; i++, o++, k++) {
            const e = ci[o] * v00 + ci[o + 1] * v10 + ci[o + W] * v01 + ci[o + W + 1] * v11 - tmpl[k];
            b0 += tgx[k] * e;
            b1 += tgy[k] * e;
            ae += e < 0 ? -e : e;
          }
        }
        const dx = -(hyy * b0 - hxy * b1) * idet;
        const dy = -(-hxy * b0 + hxx * b1) * idet;
        cxl += dx;
        cyl += dy;
        lastErr = ae / N;
        if (dx * dx + dy * dy < 0.0004) break;
      }
      gx = cxl / s;
      gy = cyl / s;
    }
    if (lastErr > 22) return false;
    this.lkX = gx;
    this.lkY = gy;
    return true;
  }

  // ------------------------------------------------------------------ solve

  private solve(R: ArrayLike<number>, dt: number, omega: number): void {
    const res = this.res;
    const n = this.n;
    if (n < 6) return;
    const f = this.f;
    const X = this.X,
      rr = this.rr,
      rw = this.rw;
    const px0 = this.px,
      py0 = this.py,
      pz0 = this.pz;
    for (let i = 0; i < n; i++) {
      const dx = (this.fx[i] - this.cx) / f,
        dy = -(this.fy[i] - this.cy) / f;
      let rx = R[0] * dx + R[1] * dy - R[2];
      let ry = R[3] * dx + R[4] * dy - R[5];
      let rz = R[6] * dx + R[7] * dy - R[8];
      const l = 1 / Math.hypot(rx, ry, rz);
      rr[i * 3] = rx * l;
      rr[i * 3 + 1] = ry * l;
      rr[i * 3 + 2] = rz * l;
      const ex = X[i * 3] - px0,
        ey = X[i * 3 + 1] - py0,
        ez = X[i * 3 + 2] - pz0;
      const rho = Math.max(0.3, Math.hypot(ex, ey, ez));
      rw[i] = f / rho; // sqrt of w
    }
    const maxStep = Math.min(1, MAX_SPEED * dt + 0.02);

    // hypothesis scoring: truncated cost at candidate p
    const tau2 = 2.2 * 2.2;
    const score = (qx: number, qy: number, qz: number): number => {
      let c = 0;
      for (let i = 0; i < n; i++) {
        const e = this.resid(i, qx, qy, qz);
        c += e < tau2 ? e : tau2;
      }
      return c;
    };
    let bx = px0,
      by = py0,
      bz = pz0;
    let bestCost = score(px0, py0, pz0) - 1e-6 * n; // slight preference for "no motion"
    const LAMBDA = 50;
    for (let it = 0; it < 28; it++) {
      this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
      const a = this.rng % n;
      this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
      let b = this.rng % n;
      if (a === b) b = (b + 1) % n;
      this.idx[0] = a;
      this.idx[1] = b;
      if (!this.lsq(2, px0, py0, pz0, LAMBDA, null)) continue;
      const qx = this.sx,
        qy = this.sy,
        qz = this.sz;
      if (Math.hypot(qx - px0, qy - py0, qz - pz0) > maxStep) continue;
      const c = score(qx, qy, qz);
      if (c < bestCost) {
        bestCost = c;
        bx = qx;
        by = qy;
        bz = qz;
      }
    }
    // refine on inliers (IRLS)
    let qx = bx,
      qy = by,
      qz = bz;
    let cnt = 0;
    for (let pass = 0; pass < 3; pass++) {
      cnt = 0;
      const thr = pass === 0 ? 2.2 * 2.2 : TAU_IN * TAU_IN;
      for (let i = 0; i < n; i++) {
        if (this.resid(i, qx, qy, qz) < thr) this.idx[cnt++] = i;
      }
      if (cnt < 6) break;
      if (!this.lsq(cnt, px0, py0, pz0, LAMBDA, null)) break;
      qx = this.sx;
      qy = this.sy;
      qz = this.sz;
    }
    // final inlier set at the solved position
    let nin = 0;
    for (let i = 0; i < n; i++) {
      const e = this.resid(i, qx, qy, qz);
      if (e < TAU_IN * TAU_IN * 1.5) {
        this.inl[i] = 1;
        nin++;
      } else this.inl[i] = 0;
    }
    res.inliers = nin;
    // landmark hygiene: persistent outliers and over-age landmarks are dropped
    let sx = 0,
      sy = 0,
      sxx = 0,
      syy = 0;
    let c0 = 0,
      c1 = 0;
    for (let i = 0; i < n; i++) {
      if (this.inl[i]) {
        this.bad[i] = 0;
        sx += this.fx[i];
        sy += this.fy[i];
        sxx += this.fx[i] * this.fx[i];
        syy += this.fy[i] * this.fy[i];
        c0 += this.resid(i, px0, py0, pz0);
        c1 += this.resid(i, qx, qy, qz);
      } else if (this.bad[i] < 255) this.bad[i]++;
    }
    const nn = Math.max(1, nin);
    const vx = Math.max(0, sxx / nn - (sx / nn) ** 2),
      vy = Math.max(0, syy / nn - (sy / nn) ** 2);
    const spread = Math.min(1, Math.sqrt(vx + vy) / (0.22 * Math.max(this.width, this.height)));
    res.spread = spread;
    const ratio = nin / n;
    res.quality = Math.min(1, nin / 25) * (0.5 + 0.5 * spread) * Math.sqrt(ratio);

    if (nin >= 8 && spread > 0.12) {
      res.valid = true;
      // Gyro inaccuracy allowance: ~30 ms of uncertainty in the gyro<->video timing (exact
      // latency of the camera pipeline is unknown) plus 3% rotation-increment error.
      const rotAllow = (0.05 + 0.03 * dt) * omega * f;
      const sig2 = PX_SIGMA * PX_SIGMA + rotAllow * rotAllow;
      // Above MAX_OMEGA a timing error of a few ms is several degrees: translation is not
      // observable reliably, hold the position (landmarks keep it consistent afterwards).
      const significant = omega < MAX_OMEGA && c0 - c1 > GATE_K * sig2;
      if (significant) {
        const step = Math.hypot(qx - px0, qy - py0, qz - pz0);
        if (step <= maxStep) {
          // height: slow and bounded (confounded with pitch error)
          const ny = Math.min(this.h * 1.3, Math.max(this.h * 0.7, py0 + 0.01 * (qy - py0)));
          this.px = qx;
          this.pz = qz;
          this.py = ny;
          res.moved = true;
          res.step = Math.hypot(qx - px0, ny - py0, qz - pz0);
        }
      }
    }
    // drop persistent outliers / old landmarks (compaction)
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (this.bad[i] >= 3 || this.age[i] > this.maxAge[i]) continue;
      if (m !== i) {
        this.fx[m] = this.fx[i];
        this.fy[m] = this.fy[i];
        this.X[m * 3] = this.X[i * 3];
        this.X[m * 3 + 1] = this.X[i * 3 + 1];
        this.X[m * 3 + 2] = this.X[i * 3 + 2];
        this.age[m] = this.age[i];
        this.maxAge[m] = this.maxAge[i];
        this.bad[m] = this.bad[i];
      }
      m++;
    }
    this.n = m;
  }

  /** squared pixel residual of landmark i if the camera were at q. */
  private resid(i: number, qx: number, qy: number, qz: number): number {
    const ex = this.X[i * 3] - qx,
      ey = this.X[i * 3 + 1] - qy,
      ez = this.X[i * 3 + 2] - qz;
    const rx = this.rr[i * 3],
      ry = this.rr[i * 3 + 1],
      rz = this.rr[i * 3 + 2];
    const d = ex * rx + ey * ry + ez * rz;
    const cx = ex - d * rx,
      cy = ey - d * ry,
      cz = ez - d * rz;
    const w = this.rw[i];
    return (cx * cx + cy * cy + cz * cz) * w * w;
  }

  private sx = 0;
  private sy = 0;
  private sz = 0;

  /** Weighted LSQ over landmarks idx[0..cnt) with a weak ridge toward (p0). Result in sx,sy,sz. */
  private lsq(cnt: number, p0x: number, p0y: number, p0z: number, lambda: number, _u: null): boolean {
    let a00 = lambda, a01 = 0, a02 = 0, a11 = lambda, a12 = 0, a22 = lambda;
    let b0 = lambda * p0x,
      b1 = lambda * p0y,
      b2 = lambda * p0z;
    for (let k = 0; k < cnt; k++) {
      const i = this.idx[k];
      const rx = this.rr[i * 3],
        ry = this.rr[i * 3 + 1],
        rz = this.rr[i * 3 + 2];
      const w = this.rw[i] * this.rw[i];
      const m00 = (1 - rx * rx) * w,
        m01 = -rx * ry * w,
        m02 = -rx * rz * w,
        m11 = (1 - ry * ry) * w,
        m12 = -ry * rz * w,
        m22 = (1 - rz * rz) * w;
      a00 += m00;
      a01 += m01;
      a02 += m02;
      a11 += m11;
      a12 += m12;
      a22 += m22;
      const Xx = this.X[i * 3],
        Xy = this.X[i * 3 + 1],
        Xz = this.X[i * 3 + 2];
      b0 += m00 * Xx + m01 * Xy + m02 * Xz;
      b1 += m01 * Xx + m11 * Xy + m12 * Xz;
      b2 += m02 * Xx + m12 * Xy + m22 * Xz;
    }
    const c00 = a11 * a22 - a12 * a12,
      c01 = a02 * a12 - a01 * a22,
      c02 = a01 * a12 - a02 * a11;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    if (!(Math.abs(det) > 1e-9)) return false;
    const c11 = a00 * a22 - a02 * a02,
      c12 = a01 * a02 - a00 * a12,
      c22 = a00 * a11 - a01 * a01;
    const id = 1 / det;
    this.sx = (c00 * b0 + c01 * b1 + c02 * b2) * id;
    this.sy = (c01 * b0 + c11 * b1 + c12 * b2) * id;
    this.sz = (c02 * b0 + c12 * b1 + c22 * b2) * id;
    return Number.isFinite(this.sx + this.sy + this.sz);
  }

  // ------------------------------------------------------------------ seeding

  private seed(R: ArrayLike<number>): void {
    const maxF = this.maxF;
    if (this.n >= maxF) return;
    if (this.res.floorFraction < 0.04) return;
    const w = this.width,
      h = this.height;
    const cc = this.cellCount;
    cc.fill(0);
    const cw = w / CELLS_X,
      ch = h / CELLS_Y;
    for (let i = 0; i < this.n; i++) {
      const cxi = Math.min(CELLS_X - 1, (this.fx[i] / cw) | 0),
        cyi = Math.min(CELLS_Y - 1, (this.fy[i] / ch) | 0);
      cc[cyi * CELLS_X + cxi]++;
    }
    // is a detection pass worth it? count floor cells lacking landmarks
    let missing = 0;
    for (let cy = 0; cy < CELLS_Y; cy++) {
      for (let cx = 0; cx < CELLS_X; cx++) {
        if (cc[cy * CELLS_X + cx] < 2 && this.sinElev(R, (cx + 0.5) * cw, (cy + 0.5) * ch) > SIN_E_MIN) missing++;
      }
    }
    if (missing < 3 && this.n >= 30) return;
    if (missing < 6 && this.n >= 20 && this.frameNo % 3 !== 0) return;

    // rows that can contain floor: bounding rows by sampling
    let yMin = h;
    for (let y = 0; y < h; y += 4) {
      if (this.sinElev(R, w / 2, y) > SIN_E_MIN || this.sinElev(R, 0, y) > SIN_E_MIN || this.sinElev(R, w - 1, y) > SIN_E_MIN) {
        yMin = y;
        break;
      }
    }
    yMin = Math.max(1, yMin - 4);
    const img = this.pyr[this.cur][0];
    this.integrals(img, yMin);
    const W1 = w + 1;
    const rowBase = yMin;
    const half = 2; // 5x5 window
    const minEigThr = 25 * 24; // sum over 25 px (gradient = 2x true): ~ 24 per px
    let added = 0;
    const f = this.f;
    for (let cy = 0; cy < CELLS_Y && added < 20; cy++) {
      for (let cx = 0; cx < CELLS_X && added < 20; cx++) {
        let have = cc[cy * CELLS_X + cx];
        while (have < 2 && this.n < maxF) {
          let bestE = minEigThr,
            bx = -1,
            by = -1;
          const x0 = Math.max(PR + 5, Math.floor(cx * cw)),
            x1 = Math.min(w - PR - 6, Math.floor((cx + 1) * cw));
          const y0 = Math.max(PR + 5, yMin + 3, Math.floor(cy * ch)),
            y1 = Math.min(h - PR - 6, Math.floor((cy + 1) * ch));
          for (let y = y0; y < y1; y += 2) {
            for (let x = x0; x < x1; x += 2) {
              const sinE = this.sinElev(R, x, y);
              if (sinE < SIN_E_MIN || this.py / sinE > RANGE_MAX) continue;
              // window sums via integral images (rows offset by rowBase)
              const ia = (y - half - rowBase) * W1 + (x - half),
                ib = ia + 5,
                ic = ia + 5 * W1,
                id = ic + 5;
              const a = this.iXX[id] - this.iXX[ib] - this.iXX[ic] + this.iXX[ia];
              const b = this.iXY[id] - this.iXY[ib] - this.iXY[ic] + this.iXY[ia];
              const c = this.iYY[id] - this.iYY[ib] - this.iYY[ic] + this.iYY[ia];
              const e = (a + c) / 2 - Math.sqrt(((a - c) / 2) * ((a - c) / 2) + b * b);
              if (e <= bestE) continue;
              // non-max suppression against existing landmarks
              let near = false;
              for (let i = 0; i < this.n; i++) {
                const ddx = this.fx[i] - x,
                  ddy = this.fy[i] - y;
                if (ddx * ddx + ddy * ddy < 49) {
                  near = true;
                  break;
                }
              }
              if (near) continue;
              bestE = e;
              bx = x;
              by = y;
            }
          }
          if (bx < 0) break;
          // back-project onto the floor
          const dx = (bx - this.cx) / f,
            dy = -(by - this.cy) / f;
          const rx = R[0] * dx + R[1] * dy - R[2],
            ry = R[3] * dx + R[4] * dy - R[5],
            rz = R[6] * dx + R[7] * dy - R[8];
          const s = -this.py / ry;
          const i = this.n++;
          this.fx[i] = bx;
          this.fy[i] = by;
          this.X[i * 3] = this.px + s * rx;
          this.X[i * 3 + 1] = 0;
          this.X[i * 3 + 2] = this.pz + s * rz;
          this.age[i] = 0;
          this.maxAge[i] = 55 + ((this.frameNo * 7 + i * 13) % 40);
          this.bad[i] = 0;
          have++;
          added++;
        }
      }
    }
  }

  /** Integral images of the structure tensor terms for rows [y0, height). */
  private integrals(img: Uint8Array, y0: number): void {
    const w = this.width,
      h = this.height,
      W1 = w + 1;
    const ixx = this.iXX,
      ixy = this.iXY,
      iyy = this.iYY;
    const rows = h - y0;
    ixx.fill(0, 0, W1);
    ixy.fill(0, 0, W1);
    iyy.fill(0, 0, W1);
    for (let r = 0; r < rows; r++) {
      const y = y0 + r;
      const o = y * w;
      let sxx = 0,
        sxy = 0,
        syy = 0;
      const base = (r + 1) * W1,
        up = r * W1;
      ixx[base] = 0;
      ixy[base] = 0;
      iyy[base] = 0;
      const edgeRow = y === 0 || y === h - 1;
      for (let x = 0; x < w; x++) {
        let gx = 0,
          gy = 0;
        if (!edgeRow && x > 0 && x < w - 1) {
          gx = img[o + x + 1] - img[o + x - 1];
          gy = img[o + x + w] - img[o + x - w];
        }
        sxx += gx * gx;
        sxy += gx * gy;
        syy += gy * gy;
        ixx[base + x + 1] = ixx[up + x + 1] + sxx;
        ixy[base + x + 1] = ixy[up + x + 1] + sxy;
        iyy[base + x + 1] = iyy[up + x + 1] + syy;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Frame grabber: video -> small grayscale buffer.

export class GrayFrameGrabber {
  width = 0;
  height = 0;
  gray: Uint8Array = new Uint8Array(0);
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  constructor(private readonly longSide = 192) {}

  /** Draws the whole video frame (no crop) at ~longSide px and converts to luma. False on failure. */
  grab(video: HTMLVideoElement): boolean {
    try {
      const vw = video.videoWidth,
        vh = video.videoHeight;
      if (!(vw > 0 && vh > 0) || video.readyState < 2) return false;
      const L = this.longSide;
      const w = vw >= vh ? L : Math.max(16, Math.round((L * vw) / vh));
      const h = vw >= vh ? Math.max(16, Math.round((L * vh) / vw)) : L;
      if (!this.canvas || w !== this.width || h !== this.height) {
        this.width = w;
        this.height = h;
        this.gray = new Uint8Array(w * h);
        if (typeof document !== "undefined") {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          this.canvas = c;
        } else if (typeof OffscreenCanvas !== "undefined") {
          this.canvas = new OffscreenCanvas(w, h);
        } else return false;
        this.ctx = this.canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
      }
      const ctx = this.ctx;
      if (!ctx) return false;
      ctx.drawImage(video, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      const g = this.gray;
      for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
      return true;
    } catch {
      return false;
    }
  }
}
