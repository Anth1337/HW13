import type * as THREE from "three";

/*
 * World tracking for browsers WITHOUT WebXR (iPhone / iPad Safari). Contract between the tracker
 * (src/tracking/*) and tracked camera mode (src/cameraMode.ts). Goal: the same experience as the
 * Android WebXR session (src/webxr.ts): a floor found by pointing the phone down, the dog placed
 * ON it at real size, staying put in the room while the phone moves and turns.
 *
 * World frame (the one three.js renders in): right-handed, y up, the FLOOR is the plane y = 0.
 * At start() the camera sits at (0, cameraHeight, 0) looking horizontally along -z (yaw zeroed to
 * wherever the phone was pointing at start; pitch/roll come from gravity).
 *
 * How it works (see the module headers): rotation = device orientation (gyro + gravity), fused and
 * smoothed; translation = visual odometry on the floor plane (tracked image features on the
 * floor, rotation-compensated with the gyro, solved for metric translation using the known
 * camera height above the plane), with accelerometer / zero-velocity damping when there is
 * nothing to track. No depth sensing exists on iOS web, so scale comes from cameraHeight.
 */

export interface TrackedPose {
  /** World position of the camera (meters). */
  position: THREE.Vector3;
  /** World orientation of the camera (camera looks down its -z, y up in the image). */
  quaternion: THREE.Quaternion;
}

export type TrackerState =
  | "starting" // waiting for the first motion sensor events / video frames
  | "tracking" // good rotation + translation
  | "limited" // rotation only (no usable floor texture / moving too fast / pointing up); position held or damped
  | "unavailable"; // no motion sensors (desktop) or permission denied: the caller falls back to a fixed camera

export type MotionPermission = "granted" | "denied" | "unavailable";

/**
 * iOS 13+ needs DeviceOrientationEvent.requestPermission() (and DeviceMotionEvent's) called from a
 * user gesture (click) — call this FIRST in the Deploy click handler, before any other await.
 * "unavailable" = no sensor API at all (desktop). Other browsers: resolves "granted" without prompting.
 */
export type RequestMotionPermission = () => Promise<MotionPermission>;

export interface WorldTracker {
  readonly state: TrackerState;
  /** Human-readable reason when state != "tracking" ("Point the camera at the floor", "Move the phone slowly", ...), else null. */
  readonly message: string | null;
  /** 0..1 confidence of the translation estimate (feature count, inliers, motion blur). */
  readonly quality: number;
  /** Camera height above the floor the tracker assumes / has estimated (meters). */
  readonly cameraHeight: number;
  /**
   * Feed the current video frame. Cheap to call every rendered frame: the tracker decides
   * internally whether a new frame is due (≈ 20–30 Hz) and does its work at a small resolution.
   * Never throws.
   */
  processFrame(video: HTMLVideoElement, timeMs: number): void;
  /** Latest fused pose (rotation extrapolated to now from the gyro; position from the last odometry step). */
  getPose(out: TrackedPose): TrackedPose;
  /**
   * The pose at the moment the most recently PROCESSED video frame was captured (for the vision
   * CameraModel). Falls back to getPose when no frame has been processed yet.
   */
  getFramePose(out: TrackedPose): TrackedPose;
  /** Count of video frames the tracker has processed (getFramePose is the pose of the latest one). */
  readonly framesProcessed: number;
  /** Re-zero: camera at (0, cameraHeight, 0), yaw zeroed to the current heading. Dog placement should be redone. */
  recenter(): void;
  /** Tell the tracker the screen / video geometry (long-side FOV in degrees) — improves the translation scale. */
  setFov(longSideFovDeg: number): void;
  dispose(): void;
}

export interface WorldTrackerOptions {
  /** Assumed camera height above the floor, meters (phone held at chest/waist height). Default 1.3. */
  cameraHeight?: number;
  /** Long-side field of view of the video, degrees. Default 65. */
  fovLongSideDeg?: number;
}

/*
 * src/tracking/index.ts exports:
 *   export const requestMotionPermission: RequestMotionPermission
 *   export function createWorldTracker(opts?: WorldTrackerOptions): WorldTracker
 *   export function motionSensorsLikelyAvailable(): boolean   // sync heuristic (DeviceOrientationEvent exists and device is touch / mobile)
 */
