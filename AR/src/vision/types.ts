import type * as THREE from "three";

/*
 * Vision pipeline (people in the camera feed → world space), in three steps:
 *
 *   camera image ──► detector (MediaPipe pose + face) ──► Human2D[]   (image coordinates)
 *   Human2D[] + CameraModel (+ optional depth) ──► lift ──► PerceivedHuman[]   (world space)
 *   PerceivedHuman[] ──► DogBrain (src/dog/types.ts)
 *
 * Image coordinates: u to the right, v DOWN, both 0..1 over the full image passed to detect().
 */

export interface UV {
  u: number;
  v: number;
}

/** One person found in a camera image. */
export interface Human2D {
  /** Stable across frames while the person stays in view (simple nearest-match tracking). */
  id: number;
  /** 0..1 overall detection confidence. */
  score: number;
  /** Midpoint between the eyes. null if the head isn't visible. */
  eyes: UV | null;
  /** Shoulder landmarks (for angular-size depth when no face / depth is available). */
  shoulders: { left: UV; right: UV } | null;
  /**
   * Hand points: for each visible hand, the midpoint of the index/pinky knuckle landmarks
   * (falls back to the wrist). 0–2 entries.
   */
  hands: UV[];
  /** Present when the face landmarker matched this person. */
  face: {
    /** Outer eye corners (for angular-size depth estimation; adult ≈ 0.09 m apart). */
    leftEyeOuter: UV;
    rightEyeOuter: UV;
    /**
     * Unit gaze direction in CAMERA space (x right, y up, z towards the viewer, i.e. the camera
     * looks down -z), from the head pose (facial transformation matrix) plus the eye-look
     * blendshapes. A person looking straight into the camera gives ≈ (0, 0, 1).
     */
    gazeCamera: { x: number; y: number; z: number };
  } | null;
}

/** Maps image coordinates to world-space rays for the frame the image came from. */
export interface CameraModel {
  /** Camera position + world-space unit ray through image point (u, v). */
  ray(u: number, v: number, outOrigin: THREE.Vector3, outDir: THREE.Vector3): void;
  /** Camera-space → world-space rotation for direction vectors (camera looks down its -z). */
  readonly cameraToWorld: THREE.Matrix4;
  /**
   * Optional metric depth (WebXR depth sensing): distance along the camera's forward axis
   * (view-space -z), in meters, at image point (u, v); null where unknown.
   */
  depthAt?(u: number, v: number): number | null;
}

/** A person in world space, ready for the dog's brain. */
export interface PerceivedHuman {
  id: number;
  confidence: number;
  /** World-space point between the eyes. null if the head wasn't seen. */
  head: THREE.Vector3 | null;
  /** World-space unit gaze direction. null if no face was matched. */
  gaze: THREE.Vector3 | null;
  /** World-space hand positions, 0–2. */
  hands: THREE.Vector3[];
  /** Seconds since this person was last detected (0 = this frame). */
  age: number;
}

/**
 * src/vision/detector.ts:
 *   export async function createHumanDetector(opts?: { maxPeople?: number }): Promise<HumanDetector>
 * Loads MediaPipe lazily (dynamic import) so the main bundle doesn't grow.
 */
export interface HumanDetector {
  /** Synchronous detection on a frame. timestampMs must strictly increase between calls. */
  detect(image: ImageData | HTMLVideoElement | HTMLCanvasElement, timestampMs: number): Human2D[];
  close(): void;
}

/**
 * src/vision/lift.ts:
 *   export function liftHumans(humans: readonly Human2D[], cam: CameraModel, hints: LiftHints): PerceivedHuman[]
 * Depth per person comes from cam.depthAt when available, otherwise from the angular size of
 * the eye-corner span (≈0.09 m) or shoulder span (≈0.38 m). Hands use depthAt when available;
 * otherwise, if the hand's ray passes close to a hint sphere (the dog) and the person's own
 * depth is compatible (within ~1 m), the hand is placed at the ray's closest point to that
 * sphere — people reach out to pet things in front of them.
 */
export interface LiftHints {
  /** World-space spheres hands are likely reaching for (dog petting zones). */
  reachTargets: readonly THREE.Sphere[];
}

/**
 * src/vision/xrCamera.ts:
 *   export function createXRVisionSource(renderer: THREE.WebGLRenderer, session: XRSession,
 *     opts?: { intervalMs?: number; maxSize?: number }): XRVisionSource
 * Reads the AR camera image through WebXR Raw Camera Access ("camera-access" session feature,
 * Chrome on Android) and, if the session granted "depth-sensing" with cpu-optimized usage,
 * snapshots the depth buffer too.
 */
export interface XRVisionSource {
  /**
   * Call inside the XR animation loop every frame. At most once per intervalMs (default 100)
   * it returns a downscaled (longest side <= maxSize, default 384) RGBA copy of the camera
   * image, upright (v down), and a CameraModel for exactly that frame. The CameraModel is a
   * SNAPSHOT (matrices and depth data copied), so it stays valid after the frame ends.
   * Returns null on other frames or when camera access isn't available.
   * Restores three.js GL state (renderer.resetState()) after touching GL directly.
   */
  grab(frame: XRFrame, timeMs: number): { image: ImageData; cam: CameraModel } | null;
  /** false until a camera image has been seen; stays false if the browser never provides one. */
  readonly available: boolean;
  /** true once depth data has been seen. */
  readonly hasDepth: boolean;
  dispose(): void;
}
