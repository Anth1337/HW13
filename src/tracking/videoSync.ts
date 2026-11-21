/*
 * Online calibration of the two numbers that decide whether virtual content "sticks" to the
 * camera image when the phone turns:
 *
 *  1. LATENCY: how long before it is shown / grabbed a video frame was captured. The gyro is
 *     nearly instantaneous; the camera image is 60–150 ms old by the time we see it, and that
 *     varies by device, resolution and load. Render with the gyro of "now" and the dog leads
 *     the image on every turn (it swims); feed the odometry the wrong instant and rotation
 *     leaks into translation (it drifts).
 *  2. FOCAL LENGTH (field of view): with the wrong FOV the background moves f_true·θ pixels for
 *     a turn of θ but the dog moves f_assumed·θ, so it slides across the floor while turning.
 *
 * Both are measured by comparing the image's global shift between consecutive frames with the
 * rotation the gyro history reports over the same interval, for a range of candidate latencies:
 *
 *    image shift (px)  ≈  f · rotation (rad)      for the true latency
 *
 * (for a camera rotating by a small θy about its own up axis the scene moves +f·θy along image x,
 * and for θx about its right axis +f·θx along image y, with v pointing down).
 *
 * Translation (walking) also shifts the image. It is handled twice: callers down-weight frames
 * taken while the odometry says the phone is moving (pushFrame's `weight`), and both series are
 * high-passed (see HP_MS) so slow floor flow cancels out.
 *
 * Global shift: the classic stabilisation trick of integral projections. Column sums and row
 * sums of the small grayscale frame are differentiated (removes lighting gradients) and matched
 * against the previous frame's over ±MAX_SHIFT px with sub-pixel parabolic refinement. Cheap
 * (O(w·h) once, then O(shift·(w+h))) and robust to the floor's translation flow, which is small
 * next to rotation at hand-held turning speeds. The fit is weighted and outlier-trimmed, and an
 * estimate is only accepted with enough rotation in the window and a good fit.
 *
 * Pure TypeScript, no DOM; times in milliseconds (performance.now() timebase).
 */

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Camera orientation at a (past) time — e.g. OrientationFilter.quaternionAt. */
export type RotationAt = (out: QuatLike, tMs: number) => QuatLike;

export interface VideoSyncEstimate {
  /** Capture-to-reference latency (ms): frame captured at tRef - latencyMs. */
  latencyMs: number;
  /** Focal length in pixels of the frames passed to pushFrame. */
  focalPx: number;
  /** 0..1 fit quality of the latest accepted estimate (1 - normalised residual). */
  fit: number;
}

const MAX_SHIFT = 18; // px at the grab resolution (~192 long side): ~110 deg/s at 30 fps
const WINDOW_MS = 6000;
const MAX_SAMPLES = 240;
const LAG_MIN = 0;
const LAG_MAX = 260;
const LAG_STEP = 4;
const GRID_MS = 4; // rotation history resampling step (= LAG_STEP so lags are integer grid offsets)
/** Minimum RMS (px) of the high-passed measured shift: below this it is mostly matching noise. */
const MIN_SHIFT_RMS = 0.4;
const MIN_FIT = 0.55;
const ESTIMATE_EVERY_MS = 700;
/** Central band (fraction of the frame) used for the projections. */
const BAND_LO = 0.2;
const BAND_HI = 0.8;
/**
 * High-pass half window (ms). Walking makes the floor flow through the image: a large but SLOW
 * shift that is not rotation. Subtracting the local mean (±HP_MS) from both the measured shifts
 * and the predicted rotations keeps the faster hand-held wobble, which is what pins the timing.
 */
const HP_MS = 300;

interface Sample {
  t0: number; // reference time of the previous frame
  t1: number; // reference time of this frame
  dx: number; // global image shift (px), +x right
  dy: number; // +y down
  w: number; // confidence weight 0..1
}

export class VideoSyncCalibrator {
  private prevCols: Float32Array | null = null;
  private prevRows: Float32Array | null = null;
  private cols = new Float32Array(0);
  private rows = new Float32Array(0);
  private prevT = NaN;
  private prevW = 0;
  private prevH = 0;
  private readonly samples: Sample[] = [];
  private lastEstimate = -Infinity;

  /** Current best values (starts from the supplied defaults until data proves otherwise). */
  latencyMs: number;
  focalPx: number;
  /** Number of accepted estimates so far (0 = still on the defaults). */
  accepted = 0;
  fit = 0;

  constructor(defaultLatencyMs: number, defaultFocalPx: number) {
    this.latencyMs = defaultLatencyMs;
    this.focalPx = defaultFocalPx;
  }

  /** Forget the motion history (e.g. after recenter or a resolution change). Keeps the estimates. */
  reset(): void {
    this.prevCols = this.prevRows = null;
    this.prevT = NaN;
    this.samples.length = 0;
  }

  /** Use a new default focal length (FOV change) if nothing has been measured yet. */
  setDefaultFocal(focalPx: number): void {
    if (this.accepted === 0 && Number.isFinite(focalPx) && focalPx > 0) this.focalPx = focalPx;
  }

  /**
   * Feed a grabbed grayscale frame. `tRef` is the frame's reference time: when it was presented
   * (requestVideoFrameCallback) or grabbed. The capture time is tRef - latencyMs.
   */
  pushFrame(gray: Uint8Array, w: number, h: number, tRef: number, weight = 1): void {
    if (!(w > 2 * MAX_SHIFT + 8 && h > 2 * MAX_SHIFT + 8) || !Number.isFinite(tRef)) return;
    if (w !== this.prevW || h !== this.prevH) {
      this.prevW = w;
      this.prevH = h;
      this.cols = new Float32Array(w);
      this.rows = new Float32Array(h);
      this.reset();
    }
    projections(gray, w, h, this.cols, this.rows);
    const pc = this.prevCols;
    const pr = this.prevRows;
    if (pc && pr && tRef > this.prevT && tRef - this.prevT < 200) {
      const sx = bestShift(pc, this.cols);
      const sy = bestShift(pr, this.rows);
      if (sx && sy) {
        this.samples.push({ t0: this.prevT, t1: tRef, dx: sx.shift, dy: sy.shift, w: Math.min(sx.conf, sy.conf) * Math.max(0, Math.min(1, weight)) });
        if (this.samples.length > MAX_SAMPLES) this.samples.shift();
      }
    }
    // swap buffers: current projections become "previous"
    if (!pc || !pr) {
      this.prevCols = new Float32Array(w);
      this.prevRows = new Float32Array(h);
    }
    this.prevCols!.set(this.cols);
    this.prevRows!.set(this.rows);
    this.prevT = tRef;
    while (this.samples.length && this.samples[0].t1 < tRef - WINDOW_MS) this.samples.shift();
  }

  /**
   * Re-fit latency + focal length from the recent window if due. `rotAt` must cover the window.
   * Returns true when a new estimate was accepted.
   */
  maybeEstimate(rotAt: RotationAt, nowMs: number): boolean {
    if (nowMs - this.lastEstimate < ESTIMATE_EVERY_MS || this.samples.length < 20) return false;
    this.lastEstimate = nowMs;
    const est = estimate(this.samples, rotAt);
    if (!est) return false;
    // Smooth: the first estimates move quickly, later ones settle.
    const k = this.accepted === 0 ? 1 : this.accepted < 4 ? 0.5 : 0.25;
    this.latencyMs += (est.latencyMs - this.latencyMs) * k;
    this.focalPx += (est.focalPx - this.focalPx) * k;
    this.fit = est.fit;
    this.accepted++;
    return true;
  }
}

// ---------------------------------------------------------------------------------------

/**
 * Differentiated, mean-free column and row sums (per-pixel averages). Columns are summed over the
 * central band of rows and rows over the central band of columns: away from the centre a camera
 * rotation moves the image more (pinhole magnification) and a turn while looking down adds roll,
 * whose shift is opposite at opposite edges; both would bias the shift and so the focal length.
 */
function projections(gray: Uint8Array, w: number, h: number, cols: Float32Array, rows: Float32Array): void {
  cols.fill(0);
  rows.fill(0);
  const y0 = Math.floor(h * BAND_LO);
  const y1 = Math.ceil(h * BAND_HI);
  const x0 = Math.floor(w * BAND_LO);
  const x1 = Math.ceil(w * BAND_HI);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const inRows = y >= y0 && y < y1;
    let s = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[o + x];
      if (inRows) cols[x] += v;
      if (x >= x0 && x < x1) s += v;
    }
    rows[y] = s / (x1 - x0);
  }
  for (let x = 0; x < w; x++) cols[x] /= y1 - y0;
  derivative(cols);
  derivative(rows);
}

/** In place: central difference, then remove the mean. Ends get 0. */
function derivative(a: Float32Array): void {
  const n = a.length;
  let prev = a[0];
  let mean = 0;
  for (let i = 1; i < n - 1; i++) {
    const cur = a[i];
    a[i] = (a[i + 1] - prev) * 0.5;
    prev = cur;
    mean += a[i];
  }
  a[0] = a[n - 1] = 0;
  mean /= Math.max(1, n - 2);
  for (let i = 1; i < n - 1; i++) a[i] -= mean;
}

/**
 * Shift s (px) such that cur[i] ≈ prev[i - s] (content moved by +s), by minimum mean absolute
 * difference over the overlap, refined with a parabola. null if there is no texture.
 * conf: how much better the best shift is than the typical one (0..1).
 */
function bestShift(prev: Float32Array, cur: Float32Array): { shift: number; conf: number } | null {
  const n = cur.length;
  const costs = new Float64Array(2 * MAX_SHIFT + 1);
  let energy = 0;
  for (let i = MAX_SHIFT; i < n - MAX_SHIFT; i++) energy += Math.abs(cur[i]);
  energy /= Math.max(1, n - 2 * MAX_SHIFT);
  if (energy < 0.05) return null; // flat image
  let best = 0;
  let bestCost = Infinity;
  for (let s = -MAX_SHIFT; s <= MAX_SHIFT; s++) {
    let c = 0;
    let m = 0;
    const lo = Math.max(MAX_SHIFT, s + 1);
    const hi = Math.min(n - MAX_SHIFT, n - 1 + s);
    for (let i = lo; i < hi; i++) {
      c += Math.abs(cur[i] - prev[i - s]);
      m++;
    }
    c = m > 0 ? c / m : Infinity;
    costs[s + MAX_SHIFT] = c;
    if (c < bestCost) {
      bestCost = c;
      best = s;
    }
  }
  // parabolic sub-pixel refinement
  let shift = best;
  if (best > -MAX_SHIFT && best < MAX_SHIFT) {
    const a = costs[best - 1 + MAX_SHIFT];
    const b = costs[best + MAX_SHIFT];
    const c = costs[best + 1 + MAX_SHIFT];
    const den = a - 2 * b + c;
    if (den > 1e-9) shift = best + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  } else {
    return null; // at the search edge: probably faster than we can measure
  }
  let median = 0;
  const sorted = Array.from(costs).sort((x, y) => x - y);
  median = sorted[sorted.length >> 1];
  const conf = median > 1e-9 ? Math.max(0, Math.min(1, 1 - bestCost / median)) : 0;
  return { shift, conf };
}

/** Relative rotation conj(a)*b as a small-angle rotation vector (rad), camera-local axes. */
function relRotation(a: QuatLike, b: QuatLike, out: { x: number; y: number; z: number }): void {
  // d = conj(a) * b
  let dx = a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y;
  let dy = a.w * b.y + a.x * b.z - a.y * b.w - a.z * b.x;
  let dz = a.w * b.z - a.x * b.y + a.y * b.x - a.z * b.w;
  const dw = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  if (dw < 0) {
    dx = -dx;
    dy = -dy;
    dz = -dz;
  }
  const sn = Math.hypot(dx, dy, dz);
  const ang = 2 * Math.atan2(sn, Math.abs(dw));
  const k = sn > 1e-12 ? ang / sn : 2;
  out.x = dx * k;
  out.y = dy * k;
  out.z = dz * k;
}

function estimate(samples: readonly Sample[], rotAt: RotationAt): VideoSyncEstimate | null {
  // Resample the rotation history on a uniform grid covering every sample at every lag.
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const s of samples) {
    tMin = Math.min(tMin, s.t0);
    tMax = Math.max(tMax, s.t1);
  }
  const g0 = tMin - LAG_MAX - GRID_MS;
  const n = Math.ceil((tMax - g0) / GRID_MS) + 2;
  const grid = new Float64Array(n * 4);
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  for (let i = 0; i < n; i++) {
    rotAt(q, g0 + i * GRID_MS);
    grid[i * 4] = q.x;
    grid[i * 4 + 1] = q.y;
    grid[i * 4 + 2] = q.z;
    grid[i * 4 + 3] = q.w;
  }
  const qa: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  const qb: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  const r = { x: 0, y: 0, z: 0 };
  const at = (t: number, o: QuatLike) => {
    const f = (t - g0) / GRID_MS;
    const i = Math.max(0, Math.min(n - 2, Math.floor(f)));
    const u = Math.max(0, Math.min(1, f - i));
    // nlerp between grid points (4 ms apart: plenty accurate)
    let bx = grid[i * 4 + 4],
      by = grid[i * 4 + 5],
      bz = grid[i * 4 + 6],
      bw = grid[i * 4 + 7];
    const ax = grid[i * 4],
      ay = grid[i * 4 + 1],
      az = grid[i * 4 + 2],
      aw = grid[i * 4 + 3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    o.x = ax + (bx - ax) * u;
    o.y = ay + (by - ay) * u;
    o.z = az + (bz - az) * u;
    o.w = aw + (bw - aw) * u;
    const l = Math.hypot(o.x, o.y, o.z, o.w) || 1;
    o.x /= l;
    o.y /= l;
    o.z /= l;
    o.w /= l;
  };

  const m = samples.length;
  const px = new Float64Array(m);
  const py = new Float64Array(m);
  // High-pass neighbourhoods (same for observations and predictions) and detrended observations.
  const lo = new Int32Array(m);
  const hi = new Int32Array(m);
  for (let i = 0, a = 0, b = 0; i < m; i++) {
    const t = samples[i].t1;
    while (samples[a].t1 < t - HP_MS) a++;
    if (b < i) b = i;
    while (b + 1 < m && samples[b + 1].t1 <= t + HP_MS) b++;
    lo[i] = a;
    hi[i] = b;
  }
  const ox = new Float64Array(m);
  const oy = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    ox[i] = samples[i].dx;
    oy[i] = samples[i].dy;
  }
  highPass(ox, lo, hi);
  highPass(oy, lo, hi);
  let best: VideoSyncEstimate | null = null;
  let bestCost = Infinity;
  let bestShiftVar = 0;
  for (let lag = LAG_MIN; lag <= LAG_MAX; lag += LAG_STEP) {
    // predicted rotation per sample at this lag
    let spp = 0;
    let spo = 0;
    let soo = 0;
    for (let i = 0; i < m; i++) {
      const s = samples[i];
      at(s.t0 - lag, qa);
      at(s.t1 - lag, qb);
      relRotation(qa, qb, r);
      px[i] = r.y; // yaw about camera up  -> +x image shift
      py[i] = r.x; // pitch about camera right -> +y (down) image shift
    }
    highPass(px, lo, hi);
    highPass(py, lo, hi);
    for (let i = 0; i < m; i++) {
      const w = samples[i].w;
      spp += w * (px[i] * px[i] + py[i] * py[i]);
      spo += w * (px[i] * ox[i] + py[i] * oy[i]);
      soo += w * (ox[i] * ox[i] + oy[i] * oy[i]);
    }
    if (spp < 1e-12 || soo < 1e-9) continue;
    let f = spo / spp;
    if (!(f > 0)) continue; // wrong sign: not this lag
    // One trimming pass: drop the worst 15 % residuals (hands, translation bursts, mis-matches).
    const res = new Float64Array(m);
    for (let i = 0; i < m; i++) res[i] = (ox[i] - f * px[i]) ** 2 + (oy[i] - f * py[i]) ** 2;
    const cut = Array.from(res).sort((a, b) => a - b)[Math.floor(m * 0.85)];
    spp = spo = soo = 0;
    let sw = 0;
    let sres = 0;
    for (let i = 0; i < m; i++) {
      if (res[i] > cut) continue;
      const w = samples[i].w;
      sw += w;
      spp += w * (px[i] * px[i] + py[i] * py[i]);
      spo += w * (px[i] * ox[i] + py[i] * oy[i]);
      soo += w * (ox[i] * ox[i] + oy[i] * oy[i]);
    }
    if (spp < 1e-12 || soo < 1e-9 || sw < 1e-6) continue;
    f = spo / spp;
    if (!(f > 0)) continue;
    for (let i = 0; i < m; i++) {
      if (res[i] > cut) continue;
      sres += samples[i].w * ((ox[i] - f * px[i]) ** 2 + (oy[i] - f * py[i]) ** 2);
    }
    const cost = sres / soo; // normalised residual
    if (cost < bestCost) {
      bestCost = cost;
      bestShiftVar = soo / sw;
      best = { latencyMs: lag, focalPx: f, fit: 1 - cost };
    }
  }
  if (!best || bestShiftVar < MIN_SHIFT_RMS * MIN_SHIFT_RMS || best.fit < MIN_FIT) return null;
  return best;
}

/** In place: subtract each element's neighbourhood mean (indices lo[i]..hi[i], inclusive). */
function highPass(a: Float64Array, lo: Int32Array, hi: Int32Array): void {
  const n = a.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] - (pre[hi[i] + 1] - pre[lo[i]]) / (hi[i] - lo[i] + 1);
  a.set(out);
}
