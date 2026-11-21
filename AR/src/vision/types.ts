import type * as THREE from "three";

/*
 * Vision pipeline (camera image → world space):
 *
 *   camera image ──► detector (MediaPipe HandLandmarker + FaceLandmarker) ──► Observation (image space)
 *   Observation + CameraModel ──► lift ──► Perception (world space) ──► DogBrain, HandOccluder
 *
 * HANDS are the primary input: the phone user's own hand in front of the camera (no full body
 * needed). Faces are only used for eye contact.
 *
 * Image coordinates: u to the right, v DOWN, both 0..1 over the full image passed to detect().
 */

export interface UV {
  u: number;
  v: number;
}

/** MediaPipe hand: 21 landmarks (0 wrist, 1-4 thumb, 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky). */
export interface Hand2D {
  /** Stable across frames while the hand stays in view (nearest-match tracking, ≤ 0.5 s gaps). */
  id: number;
  score: number;
  handedness: "Left" | "Right";
  /** 21 image-space landmarks. */
  landmarks: UV[];
  /**
   * 21 metric landmarks from MediaPipe's world output: meters, origin at the hand's
   * approximate geometric centre, axes aligned with the camera image (x right, y DOWN,
   * z away from the camera). Used to recover real depth from apparent size.
   */
  world: { x: number; y: number; z: number }[];
}

export interface Face2D {
  id: number;
  score: number;
  /** Midpoint between the eyes. */
  eyes: UV;
  /** Outer eye corners (face mesh 33 / 263) — adult ≈ 0.09 m apart, for depth. */
  leftEyeOuter: UV;
  rightEyeOuter: UV;
  /**
   * Unit gaze direction in CAMERA space (x right, y up, z towards the viewer; the camera looks
   * down -z): head pose (facial transformation matrix) + eye-look blendshapes.
   */
  gazeCamera: { x: number; y: number; z: number };
  /** Unit head-forward direction (head pose only, no eye offset), camera space as above. */
  headForwardCamera: { x: number; y: number; z: number };
}

export interface Observation {
  hands: Hand2D[];
  faces: Face2D[];
}

/** Maps image coordinates to world-space rays for the frame the image came from. */
export interface CameraModel {
  /** Camera position + world-space unit ray through image point (u, v). */
  ray(u: number, v: number, outOrigin: THREE.Vector3, outDir: THREE.Vector3): void;
  /** Camera-space → world-space rotation for direction vectors (camera looks down its -z). */
  readonly cameraToWorld: THREE.Matrix4;
  /**
   * Optional metric depth (WebXR cpu-optimized depth sensing): distance along the camera's
   * forward axis (view-space -z), in meters, at image point (u, v); null where unknown.
   */
  depthAt?(u: number, v: number): number | null;
}

/** A hand in world space. */
export interface PerceivedHand {
  id: number;
  confidence: number;
  /** World-space palm centre (mean of wrist + index/middle/ring/pinky MCPs). */
  palm: THREE.Vector3;
  /** All 21 landmarks in world space (same order as MediaPipe). */
  points: THREE.Vector3[];
  /** World-space velocity of the palm (m/s), from recent detections; zero if unknown. */
  velocity: THREE.Vector3;
  /** Distance from the camera to the palm, meters. */
  distance: number;
  /** True when the hand is very close to the camera (distance < 0.45 m). */
  nearCamera: boolean;
  /** Seconds since this hand was last detected (0 = this frame). */
  age: number;
}

/** A face in world space (someone who might be looking at the dog). */
export interface PerceivedFace {
  id: number;
  confidence: number;
  /** World-space point between the eyes. */
  head: THREE.Vector3;
  /** World-space unit gaze direction. */
  gaze: THREE.Vector3;
  age: number;
}

export interface Perception {
  hands: PerceivedHand[];
  faces: PerceivedFace[];
}

/**
 * src/vision/detector.ts:
 *   export async function createVisionDetector(opts?: { maxHands?: number; maxFaces?: number }): Promise<VisionDetector>
 * Loads MediaPipe lazily (dynamic import → separate chunk). Hands run every call; faces may
 * run every other call (they only drive eye contact).
 */
export interface VisionDetector {
  /** Synchronous detection on a frame. timestampMs is made strictly increasing internally. */
  detect(image: ImageData | HTMLVideoElement | HTMLCanvasElement, timestampMs: number): Observation;
  close(): void;
}

/**
 * src/vision/lift.ts:
 *   export function liftObservation(obs: Observation, cam: CameraModel, prev: Perception | null, dtSincePrev: number): Perception
 * Hand depth: prefer cam.depthAt (median of a few samples on the palm, sanity-checked);
 * otherwise solve depth from the metric `world` landmarks vs their image spread
 * (weak-perspective least squares over all 21 points using the ray angles). Every landmark is
 * then placed in world space at that depth + its own metric z offset. Velocity from `prev`
 * (matched by id). Faces: depth from the eye-corner span (corrected for head yaw using
 * headForwardCamera), gaze rotated into world space. age = 0 for everything returned.
 */

/**
 * src/vision/handOccluder.ts:
 *   export function createHandOccluder(scene: THREE.Scene): HandOccluder
 * Fallback occlusion when the phone has no GPU depth sensing: an invisible, depth-only mesh
 * shaped like each detected hand (capsules along the finger bones + a palm slab, slightly
 * inflated), placed at the hand's world position, so the virtual dog is hidden behind the
 * real hand. Predicts ahead by the hand velocity to hide vision latency; fades out
 * (disables) a hand ~0.25 s after it is lost.
 */
export interface HandOccluder {
  /** Call every frame. `enabled=false` hides everything (e.g. when GPU depth occlusion works). */
  update(dt: number, hands: readonly PerceivedHand[], enabled: boolean): void;
  dispose(): void;
}

/**
 * src/vision/xrCamera.ts:
 *   export function createXRVisionSource(renderer: THREE.WebGLRenderer, session: XRSession,
 *     opts?: { intervalMs?: number; maxSize?: number }): XRVisionSource
 * Reads the AR camera image through WebXR Raw Camera Access ("camera-access") and, only when
 * the session granted cpu-optimized depth sensing, snapshots the depth buffer too. When depth
 * is gpu-optimized, three.js itself uses it for occlusion and depthAt is absent.
 */
export interface XRVisionSource {
  /**
   * Call inside the XR animation loop every frame. At most once per intervalMs (default 66)
   * returns a downscaled (longest side <= maxSize, default 384) RGBA copy of the camera image,
   * upright (v down), and a SNAPSHOT CameraModel for exactly that frame. null otherwise.
   * Never throws. Restores three.js GL state after touching GL directly.
   */
  grab(frame: XRFrame, timeMs: number): { image: ImageData; cam: CameraModel } | null;
  readonly available: boolean;
  readonly hasDepth: boolean;
  dispose(): void;
}
