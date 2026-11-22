import type { MotionPermission, TrackedPose, TrackerState, WorldTracker, WorldTrackerOptions } from "./types";
import { FloorOdometry, GrayFrameGrabber } from "./floorOdometry";
import { OrientationFilter, type Quat } from "./orientation";
import { VideoSyncCalibrator } from "./videoSync";

/*
 * WorldTracker for browsers without WebXR (iOS Safari): gyro rotation (orientation.ts) +
 * floor-plane visual odometry (floorOdometry.ts). See types.ts for the contract and the world
 * frame. Summary of behaviour and assumptions:
 *
 *  - The video frame passed to processFrame is assumed UPRIGHT w.r.t. the screen (what iOS
 *    delivers for the back camera) and `setFov` takes the long-side FOV of the WHOLE video frame
 *    (not the cropped part shown on screen). Default 65 deg.
 *  - Frame timestamps: every frame gets a REFERENCE time: when the browser presented it
 *    (requestVideoFrameCallback's presentationTime, else the callback time) or, without that API,
 *    when processFrame grabbed it. Its capture time is reference - latency, where the latency is
 *    MEASURED continuously (videoSync.ts: image shift vs gyro rotation) starting from
 *    CAMERA_LATENCY_MS (or the browser's captureTime when it reports a plausible one). The
 *    orientation at the capture instant is looked up in the history ring. A wrong latency shows
 *    up as spurious translation during turns and as the dog swimming against the video.
 *  - Display sync: the video element shows a frame that is already `latency` old. getDisplayPose
 *    returns the pose AT THAT FRAME's capture time (rotation from the gyro history, position
 *    interpolated between filtered odometry samples), so virtual content and the image agree on
 *    every turn instead of the dog leading the room. This is how native AR frameworks render too.
 *  - The FOV (setFov / WorldTrackerOptions) is a starting value; the measured focal length
 *    replaces it once there has been enough rotation (fovLongSideDeg reports the current value).
 *  - Camera height is the constructor value; no estimation (see README note): an error in it is
 *    a proportional error in all distances.
 *  - Position when nothing can be tracked is HELD (no accelerometer integration: double
 *    integrating phone accelerometers drifts meters within seconds and could not be validated).
 *  - 'unavailable' = no orientation sample with real numbers within 1.5 s of creation (desktop,
 *    permission denied). It can leave that state if events start arriving later.
 */

const CAMERA_LATENCY_MS = 80; // starting guess until measured (phones: ~60-150 ms)
const NO_SENSOR_MS = 1500;
const MIN_INTERVAL_MS = 30; // <= 33 Hz: every frame of a 30 fps camera when the work is cheap
const MAX_INTERVAL_MS = 120;
const POS_RING = 64;
/** Relative FOV disagreement before the measured FOV replaces the configured one. */
const FOV_OVERRIDE = 0.04;
const FOV_OVERRIDE_LANDSCAPE = 0.1;
/** Accepted (smoothed) estimates needed before the measured FOV may replace the configured one. */
const FOV_MIN_ESTIMATES = 3;
/** Longest the display pose extrapolates position past the newest odometry sample. */
const MAX_POS_EXTRAPOLATION_MS = 80;

export interface TrackerEnv {
  /** Event target for deviceorientation / devicemotion / orientationchange (default: window). */
  target?: EventTarget;
  now?: () => number;
  screenAngle?: () => number;
  /** Frame source; default: a GrayFrameGrabber at 192 px long side. */
  grabber?: { width: number; height: number; gray: Uint8Array; grab(video: HTMLVideoElement): boolean };
}

export function motionSensorsLikelyAvailable(): boolean {
  if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return false;
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  if (!nav) return false;
  const touch = (nav.maxTouchPoints ?? 0) > 0;
  const mobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(nav.userAgent || "");
  // A touch screen alone is not enough (touch laptops have DeviceOrientationEvent but no sensor);
  // iPadOS reports a desktop UA but is the one place that exposes requestPermission.
  const needsPermission = typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission === "function";
  return mobileUA || (touch && needsPermission);
}

type PermFn = () => Promise<string>;

export async function requestMotionPermission(): Promise<MotionPermission> {
  if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") return "unavailable";
  // Both requests must be started synchronously inside the user gesture.
  const w = window as unknown as { DeviceMotionEvent?: { requestPermission?: PermFn } };
  const o = (DeviceOrientationEvent as unknown as { requestPermission?: PermFn }).requestPermission;
  const m = w.DeviceMotionEvent?.requestPermission;
  const pending: Promise<string>[] = [];
  try {
    if (typeof o === "function") pending.push(o.call(DeviceOrientationEvent));
    if (typeof m === "function") pending.push(m.call(w.DeviceMotionEvent));
  } catch {
    return "denied";
  }
  if (pending.length === 0) return "granted";
  try {
    const r = await Promise.all(pending);
    if (r.every((s) => s === "granted")) return "granted";
    console.warn("[tracking] motion permission not granted (orientation, motion):", r);
    return "denied";
  } catch (err) {
    console.warn("[tracking] motion permission request failed", err);
    return "denied";
  }
}

// ---- One Euro style position smoothing (velocity-aware low-pass) -------------------------
class PosFilter {
  x = 0;
  y = 0;
  z = 0;
  private vx = 0;
  private vz = 0;
  private t = -1;
  private init = false;
  reset(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = this.vz = 0;
    this.t = -1;
    this.init = true;
  }
  update(tx: number, ty: number, tz: number, now: number): void {
    if (!this.init || this.t < 0) {
      this.x = tx;
      this.y = ty;
      this.z = tz;
      this.t = now;
      this.init = true;
      return;
    }
    const dt = (now - this.t) / 1000;
    if (dt < 0.001) return;
    this.t = now;
    const d = Math.min(dt, 0.2);
    // speed of the target (low-passed derivative)
    const sx = (tx - this.x) / d,
      sz = (tz - this.z) / d;
    const ad = 1 - Math.exp(-d * 2 * Math.PI * 1.0);
    this.vx += (sx - this.vx) * ad;
    this.vz += (sz - this.vz) * ad;
    const speed = Math.hypot(this.vx, this.vz);
    const cutoff = 2.0 + 6.0 * speed; // Hz
    const a = 1 - Math.exp(-d * 2 * Math.PI * cutoff);
    this.x += (tx - this.x) * a;
    this.z += (tz - this.z) * a;
    this.y += (ty - this.y) * (1 - Math.exp(-d * 2 * Math.PI * 0.7));
  }
}

class WorldTrackerImpl implements WorldTracker {
  private frames = 0;
  // After an explicit permission grant (iOS) the sensor exists and the first event can lag
  // (camera warm-up, tab refocus after the prompt), so wait much longer before giving up.
  private readonly noSensorMs =
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission === "function"
      ? 6000
      : NO_SENSOR_MS;
  private _state: TrackerState = "starting";
  private _message: string | null = "Starting motion sensors…";
  private _quality = 0;
  private readonly h: number;
  private fovDeg: number;
  /** FOV from the options / setFov: the measured one only overrides it when clearly different. */
  private configuredFov: number;

  private readonly ori = new OrientationFilter();
  private odo: FloorOdometry | null = null;
  private readonly grabber: NonNullable<TrackerEnv["grabber"]>;
  private readonly target: EventTarget | null;
  private readonly nowFn: () => number;
  private readonly screenAngleFn: () => number;
  private readonly created: number;

  private readonly q: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly R = new Float64Array(9);
  private readonly pf = new PosFilter();
  private targetX = 0;
  private targetY: number;
  private targetZ = 0;

  // frame bookkeeping
  private lastStart = -1e9;
  private emaCost = 6;
  private frameCounter = 0;
  private seenCounter = 0;
  private lastCT = -1;
  private rvfcVideo: HTMLVideoElement | null = null;
  private rvfcId = 0;
  private rvfcCapture = NaN;
  private haveFrame = false;
  private readonly framePos = { x: 0, y: 0, z: 0 };
  private readonly frameQ: Quat = { x: 0, y: 0, z: 0, w: 1 };

  // Video sync: measured latency + focal length, presentation time of the frame on screen.
  private readonly sync: VideoSyncCalibrator;
  private rvfcPresent = NaN; // reference time of the latest presented frame (rVFC)
  private seededLatency = false;
  /** Odometry speed (m/s, smoothed): walking frames are down-weighted for the calibration. */
  private odoSpeed = 0;
  private lastTf = NaN;
  private readonly lastOdoPos = { x: 0, z: 0 };
  // Display-sync position ring: capture time + sample-filtered position.
  private readonly posRing = new Float64Array(POS_RING * 4);
  private posHead = 0;
  private posCount = 0;
  private readonly pfSample = new PosFilter();

  private good = 0;
  private bad = 0;
  private badReason = "Point the camera at the floor";
  private disposed = false;
  private lastScreenAngle = NaN;

  private readonly onOri = (e: Event) => {
    const ev = e as unknown as { alpha: number | null; beta: number | null; gamma: number | null; timeStamp: number };
    this.syncScreenAngle();
    this.ori.pushOrientation(ev.alpha, ev.beta, ev.gamma, this.stamp(ev.timeStamp));
  };
  private readonly onMotion = (e: Event) => {
    const ev = e as unknown as { rotationRate?: { alpha: number | null; beta: number | null; gamma: number | null } | null; timeStamp: number };
    const r = ev.rotationRate;
    if (r) this.ori.pushRotationRate(r.alpha, r.beta, r.gamma, this.stamp(ev.timeStamp));
  };
  private readonly onScreen = () => this.syncScreenAngle();

  constructor(opts: WorldTrackerOptions, env: TrackerEnv) {
    this.h = opts.cameraHeight ?? 1.3;
    this.fovDeg = opts.fovLongSideDeg ?? 65;
    this.configuredFov = this.fovDeg;
    this.targetY = this.h;
    this.nowFn = env.now ?? (() => performance.now());
    this.screenAngleFn =
      env.screenAngle ??
      (() => {
        try {
          const a = (screen as unknown as { orientation?: { angle?: number } }).orientation?.angle;
          if (typeof a === "number") return a;
          const w = (window as unknown as { orientation?: number }).orientation;
          return typeof w === "number" ? w : 0;
        } catch {
          return 0;
        }
      });
    this.grabber = env.grabber ?? new GrayFrameGrabber(192);
    this.sync = new VideoSyncCalibrator(CAMERA_LATENCY_MS, focalForFov(this.fovDeg, 192));
    this.target = env.target ?? (typeof window !== "undefined" ? window : null);
    this.created = this.nowFn();
    this.pf.reset(0, this.h, 0);
    this.pfSample.reset(0, this.h, 0);
    this.syncScreenAngle();
    if (this.target) {
      this.target.addEventListener("deviceorientation", this.onOri);
      this.target.addEventListener("devicemotion", this.onMotion);
      this.target.addEventListener("orientationchange", this.onScreen);
    }
    try {
      (screen as unknown as { orientation?: EventTarget }).orientation?.addEventListener("change", this.onScreen);
    } catch {
      /* no screen.orientation */
    }
  }

  get state(): TrackerState {
    this.refreshState(this.nowFn());
    return this._state;
  }
  get message(): string | null {
    this.refreshState(this.nowFn());
    return this._state === "tracking" ? null : this._message;
  }
  get quality(): number {
    return this._state === "tracking" || this._state === "limited" ? this._quality : 0;
  }
  get cameraHeight(): number {
    return this.h;
  }
  get fovLongSideDeg(): number {
    return this.fovDeg;
  }
  get latencyMs(): number {
    return this.sync.latencyMs;
  }

  private stamp(ts: number): number {
    const now = this.nowFn();
    return typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts - now) < 1000 ? ts : now;
  }

  private syncScreenAngle(): void {
    const a = this.screenAngleFn();
    if (a !== this.lastScreenAngle) {
      this.lastScreenAngle = a;
      this.ori.setScreenAngle(a);
    }
  }

  private refreshState(now: number): void {
    if (this.disposed) return;
    if (!this.ori.hasData) {
      if (now - this.created > this.noSensorMs) {
        this._state = "unavailable";
        this._message = "Motion sensors unavailable";
      } else {
        this._state = "starting";
        this._message = "Starting motion sensors…";
      }
      return;
    }
    if (this._state === "unavailable" || (this._state === "starting" && !this.haveFrame && now - this.created > 3000)) {
      this._state = "limited";
      this._message = this.badReason;
    }
  }

  setFov(longSideFovDeg: number): void {
    if (!Number.isFinite(longSideFovDeg)) return;
    this.configuredFov = longSideFovDeg;
    if (this.fovDeg !== this.configuredFov && this.sync.accepted > 0) return; // a clearly different measured FOV stays
    this.fovDeg = longSideFovDeg;
    this.odo?.setFov(longSideFovDeg);
    this.sync.setDefaultFocal(focalForFov(longSideFovDeg, Math.max(this.grabber.width, this.grabber.height) || 192));
  }

  recenter(): void {
    this.ori.recenter();
    this.odo?.reset(0, this.h, 0);
    this.targetX = 0;
    this.targetY = this.h;
    this.targetZ = 0;
    this.pf.reset(0, this.h, 0);
    this.pfSample.reset(0, this.h, 0);
    this.posCount = 0;
    this.posHead = 0;
    this.lastTf = NaN;
    this.sync.reset(); // the orientation history restarted: old motion samples no longer line up
    this.haveFrame = false;
    this.good = 0;
    this.bad = 0;
    if (this._state === "tracking") {
      this._state = "limited";
      this._message = "Re-centering…";
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.target) {
      this.target.removeEventListener("deviceorientation", this.onOri);
      this.target.removeEventListener("devicemotion", this.onMotion);
      this.target.removeEventListener("orientationchange", this.onScreen);
    }
    try {
      (screen as unknown as { orientation?: EventTarget }).orientation?.removeEventListener("change", this.onScreen);
    } catch {
      /* ignore */
    }
    if (this.rvfcVideo && this.rvfcId) {
      try {
        (this.rvfcVideo as unknown as { cancelVideoFrameCallback?: (id: number) => void }).cancelVideoFrameCallback?.(this.rvfcId);
      } catch {
        /* ignore */
      }
    }
    this.rvfcVideo = null;
  }

  // ---------------------------------------------------------------------------------------

  private hookFrameCallback(video: HTMLVideoElement): void {
    const v = video as unknown as {
      requestVideoFrameCallback?: (cb: (now: number, meta: { captureTime?: number; presentationTime?: number }) => void) => number;
    };
    if (this.rvfcVideo === video || typeof v.requestVideoFrameCallback !== "function") return;
    this.rvfcVideo = video;
    const cb = (now: number, meta: { captureTime?: number; presentationTime?: number }) => {
      if (this.disposed || this.rvfcVideo !== video) return;
      this.frameCounter++;
      this.rvfcCapture = typeof meta?.captureTime === "number" ? meta.captureTime : NaN;
      const pt = meta?.presentationTime;
      this.rvfcPresent = typeof pt === "number" && Number.isFinite(pt) && Math.abs(pt - now) < 500 ? pt : now;
      this.rvfcId = v.requestVideoFrameCallback!(cb);
    };
    this.rvfcId = v.requestVideoFrameCallback(cb);
  }

  processFrame(video: HTMLVideoElement, timeMs: number): void {
    if (this.disposed) return;
    try {
      void timeMs;
      const now = this.nowFn();
      if (!this.ori.hasData) return;
      this.hookFrameCallback(video);
      // a new video frame since the last time?
      if (this.rvfcVideo === video) {
        if (this.frameCounter === this.seenCounter) return;
      } else {
        const ct = video.currentTime;
        if (ct === this.lastCT) return;
        this.lastCT = ct;
      }
      if (now - this.lastStart < Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, this.emaCost * 3.5))) return;
      this.lastStart = now;
      this.seenCounter = this.frameCounter;

      const t0 = this.nowFn();
      if (!this.grabber.grab(video)) return;
      const w = this.grabber.width,
        h = this.grabber.height;
      if (!this.odo || this.odo.width !== w || this.odo.height !== h) {
        const prev = this.odo?.position;
        this.odo = new FloorOdometry({ width: w, height: h, fovLongSideDeg: this.fovDeg, cameraHeight: this.h });
        this.odo.reset(prev ? prev.x : this.targetX, this.h, prev ? prev.z : this.targetZ);
      }
      // Reference time of this frame, then its capture time from the measured latency.
      const tRef = this.referenceTime(video, now);
      if (!this.seededLatency && this.rvfcVideo === video && Number.isFinite(this.rvfcCapture)) {
        // A browser-reported capture time is a better starting point than the generic guess.
        const reported = tRef - this.rvfcCapture;
        if (reported > 10 && reported < 300 && this.sync.accepted === 0) this.sync.latencyMs = reported;
        this.seededLatency = true;
      }
      this.sync.pushFrame(this.grabber.gray, w, h, tRef, Math.exp(-this.odoSpeed / 0.25));
      if (this.sync.maybeEstimate((o, t) => this.ori.quaternionAt(o as Quat, t), now)) this.applyMeasuredFocal(w, h);
      let tf = tRef - this.sync.latencyMs;
      if (!(tf > now - 500 && tf <= now)) tf = now - CAMERA_LATENCY_MS;
      this.ori.quaternionAt(this.q, tf);
      quatToMat(this.q, this.R);
      const r = this.odo.process(this.grabber.gray, this.R, tf / 1000, this.ori.angularSpeed);
      this.targetX = r.x;
      this.targetY = r.y;
      this.targetZ = r.z;
      this.pf.update(r.x, r.y, r.z, now);
      // Display-sync samples: filtered at their own capture times, so interpolating them adds no lag.
      if (Number.isFinite(this.lastTf) && tf > this.lastTf) {
        const sp = Math.hypot(r.x - this.lastOdoPos.x, r.z - this.lastOdoPos.z) / ((tf - this.lastTf) / 1000);
        this.odoSpeed += (Math.min(sp, 3) - this.odoSpeed) * 0.3;
      }
      this.lastTf = tf;
      this.lastOdoPos.x = r.x;
      this.lastOdoPos.z = r.z;
      this.pfSample.update(r.x, r.y, r.z, tf);
      this.pushPos(tf, this.pfSample.x, this.pfSample.y, this.pfSample.z);
      this.framePos.x = this.pf.x;
      this.framePos.y = this.pf.y;
      this.framePos.z = this.pf.z;
      this.frameQ.x = this.q.x;
      this.frameQ.y = this.q.y;
      this.frameQ.z = this.q.z;
      this.frameQ.w = this.q.w;
      this.haveFrame = true;
      this.frames++;

      // classification with hysteresis
      let reason: string | null = null;
      if (r.floorFraction < 0.08) reason = "Point the camera at the floor";
      else if (r.blurred) reason = "Move the phone slowly";
      else if (r.tracked < 8 && r.inliers < 8) reason = "Not much to see on the floor — keep rotation steady";
      this._quality += (r.quality - this._quality) * 0.3;
      if (reason) {
        this.bad++;
        this.good = 0;
        this.badReason = reason;
        if (this.bad >= 3 || this._state === "starting") {
          this._state = "limited";
          this._message = reason;
        }
      } else {
        this.good++;
        this.bad = 0;
        if (this.good >= 4) {
          this._state = "tracking";
          this._message = null;
        } else if (this._state === "starting") {
          this._message = "Move the phone slowly to scan the floor";
        }
      }
      const cost = this.nowFn() - t0;
      this.emaCost += (cost - this.emaCost) * 0.2;
    } catch {
      /* never throw into the render loop */
    }
  }

  getPose(out: TrackedPose): TrackedPose {
    const now = this.nowFn();
    this.pf.update(this.targetX, this.targetY, this.targetZ, now);
    out.position.set(this.pf.x, this.pf.y, this.pf.z);
    if (this.ori.hasData) {
      this.ori.getQuaternion(this.q, now);
      out.quaternion.set(this.q.x, this.q.y, this.q.z, this.q.w);
    } else {
      out.quaternion.set(0, 0, 0, 1);
    }
    return out;
  }

  /**
   * Pose matching the video frame ON SCREEN: rotation and position at that frame's capture time.
   * Use this for the rendered three.js camera so the dog stays locked to the image.
   */
  getDisplayPose(out: TrackedPose): TrackedPose {
    if (!this.ori.hasData) return this.getPose(out);
    const now = this.nowFn();
    const t = this.referenceTime(this.rvfcVideo, now) - this.sync.latencyMs;
    this.ori.quaternionAt(this.q, t);
    out.quaternion.set(this.q.x, this.q.y, this.q.z, this.q.w);
    if (!this.posAt(t, out.position)) {
      this.pf.update(this.targetX, this.targetY, this.targetZ, now);
      out.position.set(this.pf.x, this.pf.y, this.pf.z);
    }
    return out;
  }

  /** Presentation time of the frame now on screen (rVFC), else `now`. */
  private referenceTime(video: HTMLVideoElement | null, now: number): number {
    const p = this.rvfcPresent;
    return video && this.rvfcVideo === video && Number.isFinite(p) && p <= now && p > now - 500 ? p : now;
  }

  private pushPos(t: number, x: number, y: number, z: number): void {
    const o = this.posHead * 4;
    this.posRing[o] = t;
    this.posRing[o + 1] = x;
    this.posRing[o + 2] = y;
    this.posRing[o + 3] = z;
    this.posHead = (this.posHead + 1) % POS_RING;
    if (this.posCount < POS_RING) this.posCount++;
  }

  /** Position at time t from the sample ring (interpolated; short linear extrapolation past the newest). */
  private posAt(t: number, out: { set(x: number, y: number, z: number): unknown }): boolean {
    const n = this.posCount;
    if (n === 0) return false;
    const r = this.posRing;
    const newest = (this.posHead - 1 + POS_RING) % POS_RING;
    const tn = r[newest * 4];
    if (t >= tn) {
      if (n >= 2) {
        const prev = (newest - 1 + POS_RING) % POS_RING;
        const dt = tn - r[prev * 4];
        const ahead = Math.min(t - tn, MAX_POS_EXTRAPOLATION_MS);
        if (dt > 1 && dt < 200 && ahead > 0) {
          const k = ahead / dt;
          out.set(
            r[newest * 4 + 1] + (r[newest * 4 + 1] - r[prev * 4 + 1]) * k,
            r[newest * 4 + 2],
            r[newest * 4 + 3] + (r[newest * 4 + 3] - r[prev * 4 + 3]) * k,
          );
          return true;
        }
      }
      out.set(r[newest * 4 + 1], r[newest * 4 + 2], r[newest * 4 + 3]);
      return true;
    }
    let i = newest;
    for (let k = 0; k < n - 1; k++) {
      const j = (i - 1 + POS_RING) % POS_RING;
      const t0 = r[j * 4];
      if (t0 <= t) {
        const t1 = r[i * 4];
        const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
        out.set(
          r[j * 4 + 1] + (r[i * 4 + 1] - r[j * 4 + 1]) * u,
          r[j * 4 + 2] + (r[i * 4 + 2] - r[j * 4 + 2]) * u,
          r[j * 4 + 3] + (r[i * 4 + 3] - r[j * 4 + 3]) * u,
        );
        return true;
      }
      i = j;
    }
    out.set(r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]); // older than the ring: the oldest sample
    return true;
  }

  /**
   * A new focal length was measured. Each raw estimate is good to roughly ±5 % (scene-dependent:
   * turning while looking down adds image roll), but videoSync smooths them, so once a few are in
   * (FOV_MIN_ESTIMATES) a disagreement above FOV_OVERRIDE replaces the configured guess. A real
   * phone's video FOV is often 5-10 % off the 65 deg default, and that much makes the pet swim on
   * pans. The latency estimate is much tighter and is always used.
   */
  private applyMeasuredFocal(w: number, h: number): void {
    const long = Math.max(w, h);
    const fov = (2 * Math.atan(long / 2 / this.sync.focalPx) * 180) / Math.PI;
    if (!(fov > 40 && fov < 95)) return; // implausible for a phone's main camera: ignore
    const base = this.configuredFov;
    // Portrait (the normal iPhone grab) measures accurately; a landscape grab reads ~5-7 % low in
    // simulation, so it keeps the old 10 %. Hysteresis: once overriding, it only lets go well
    // inside the threshold, so a FOV near the edge can't flip back and forth.
    const engage = h > w ? FOV_OVERRIDE : FOV_OVERRIDE_LANDSCAPE;
    const limit = this.fovDeg !== base ? engage * 0.6 : engage;
    if (this.sync.accepted < FOV_MIN_ESTIMATES || Math.abs(fov - base) / base < limit) {
      if (this.fovDeg !== base) {
        this.fovDeg = base; // back within tolerance of the configured value: keep that
        this.odo?.setFov(base);
      }
      return;
    }
    this.fovDeg = fov;
    this.odo?.setFov(fov);
  }

  get framesProcessed(): number {
    return this.frames;
  }

  getFramePose(out: TrackedPose): TrackedPose {
    if (!this.haveFrame) return this.getPose(out);
    out.position.set(this.framePos.x, this.framePos.y, this.framePos.z);
    out.quaternion.set(this.frameQ.x, this.frameQ.y, this.frameQ.z, this.frameQ.w);
    return out;
  }
}

function quatToMat(q: Quat, m: Float64Array): void {
  const x = q.x,
    y = q.y,
    z = q.z,
    w = q.w;
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y - z * w);
  m[2] = 2 * (x * z + y * w);
  m[3] = 2 * (x * y + z * w);
  m[4] = 1 - 2 * (x * x + z * z);
  m[5] = 2 * (y * z - x * w);
  m[6] = 2 * (x * z - y * w);
  m[7] = 2 * (y * z + x * w);
  m[8] = 1 - 2 * (x * x + y * y);
}

/** `env` is for tests (injected event target / clock / frame source); the app passes only opts. */
export function createWorldTracker(opts: WorldTrackerOptions = {}, env: TrackerEnv = {}): WorldTracker {
  return new WorldTrackerImpl(opts, env);
}

/** Focal length (px) of a frame whose long side is `longPx` pixels and spans `fovDeg`. */
function focalForFov(fovDeg: number, longPx: number): number {
  return longPx / 2 / Math.tan((fovDeg * Math.PI) / 360);
}
