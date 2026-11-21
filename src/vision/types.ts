import type * as THREE from "three";

/*
 * Vision pipeline (camera image → world space):
 *
 *   camera image ──► detector (MediaPipe HandLandmarker + FaceLandmarker) ──► Observation (image space)
 *   Observation + CameraModel ──► lift ──► Perception (world space) ──► DogBrain, HandOccluder
 *
 * HANDS are the primary input (petting, sniffing, luring). FACES drive eye contact and tell us who
 * is speaking (mouth movement). BODIES (MediaPipe pose, several people) tie hands and faces to
 * PEOPLE so the dog can interact with several people at once without mixing them up: every hand
 * and face is attributed to a stable PerceivedPerson (see people.ts). A hand alone (no body, no
 * face visible) still works exactly as before: it becomes a person of its own.
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
  /** Axis-aligned face box in image space (from all face-mesh landmarks), for hand/body association. */
  box: { u0: number; v0: number; u1: number; v1: number };
  /** Mouth openness 0..1 (the jawOpen blendshape, 0 when unavailable). Speaker attribution uses its variation over time. */
  mouthOpen: number;
}

/**
 * MediaPipe pose (33 landmarks) of one person. Only the landmarks that matter are guaranteed:
 * 0 nose, 11/12 shoulders, 15/16 wrists, 23/24 hips (indices as in MediaPipe BlazePose).
 */
export interface Pose2D {
  /** Stable across frames (nearest-match tracking on the torso centre, ≤ 0.5 s gaps). */
  id: number;
  score: number;
  /** 33 image-space landmarks (u right, v down, 0..1; may lie slightly outside the image). */
  landmarks: UV[];
  /** Per-landmark visibility 0..1 (MediaPipe's visibility). */
  visibility: number[];
  /** 33 metric world landmarks (meters, hip-centred, x right, y DOWN, z away from camera) — body size → depth. */
  world: { x: number; y: number; z: number }[];
}

export interface Observation {
  hands: Hand2D[];
  faces: Face2D[];
  /** People's bodies (may be empty when the pose model is unavailable or nobody is in view). */
  bodies: Pose2D[];
  /**
   * True when `faces` / `bodies` are repeated from an earlier model run (the detector runs the
   * face and pose models only on some calls). lift reuses the world-space result lifted back
   * then (same ids) instead of unprojecting the old image position through the newer camera pose.
   */
  facesStale?: boolean;
  bodiesStale?: boolean;
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
  /**
   * Optional raw depth image for this frame (the same buffer depthAt reads), for the hand mask.
   * null/absent when the device has no depth sensing (no ARCore depth / ToF / LiDAR exposed).
   */
  readonly depthMap?: DepthMap | null;
}

/**
 * A metric depth image (WebXR cpu-optimized depth sensing), already converted to METERS along the
 * camera's forward axis. Immutable snapshot for one camera frame.
 */
export interface DepthMap {
  width: number;
  height: number;
  /** width*height meters, row-major, row 0 = top of the VIEW (image v = 0); 0 = no data. Same orientation as the camera image. */
  data: Float32Array;
  /** Depth (m, forward axis) at image point (u, v), v down 0..1; null where there is no data. Bilinear-free nearest lookup is fine. */
  at(u: number, v: number): number | null;
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
  /** Which person this hand belongs to (PerceivedPerson.id), or null before people.ts has attributed it. */
  personId: number | null;
  /** Image-space (u, v 0..1) palm centre of this detection — used by people.ts for association. */
  uv: UV;
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
  /** Which person this face belongs to (PerceivedPerson.id), or null before attribution. */
  personId: number | null;
  /** 0..1 jawOpen of this detection. */
  mouthOpen: number;
  /** Image-space (u, v 0..1) eye midpoint of this detection. */
  uv: UV;
  /** Image-space face box of this detection. */
  box: { u0: number; v0: number; u1: number; v1: number };
}

/** A body in world space (only the joints that were visible; null = unknown). */
export interface PerceivedBody {
  id: number;
  confidence: number;
  age: number;
  /** World-space joints (null when not visible / not trustworthy). */
  nose: THREE.Vector3 | null;
  leftShoulder: THREE.Vector3 | null;
  rightShoulder: THREE.Vector3 | null;
  leftWrist: THREE.Vector3 | null;
  rightWrist: THREE.Vector3 | null;
  /** Torso centre (mean of shoulders + hips when visible, else shoulders), world space. */
  torso: THREE.Vector3 | null;
  /** Image-space torso centre / wrist positions, for association. */
  torsoUV: UV | null;
  leftWristUV: UV | null;
  rightWristUV: UV | null;
  noseUV: UV | null;
  /** Which person this body belongs to (PerceivedPerson.id); set by people.ts, undefined/null before. */
  personId?: number | null;
}

/**
 * One human around the dog. Ids are STABLE: they persist while the person stays in view and
 * across short dropouts (≤ ~3 s), survive people crossing each other (world-space tracking with
 * velocity prediction, not just image-space nearest match), and are never reused for a different
 * person while the first could still return. Built by src/vision/people.ts from hands + faces +
 * bodies; every PerceivedHand/PerceivedFace/PerceivedBody carries its person's id.
 */
export interface PerceivedPerson {
  id: number;
  confidence: number;
  /** World-space position of the person: head if known, else torso, else the hand(s). */
  position: THREE.Vector3;
  /** World-space head (between the eyes / nose) if a face or body gave one, else null. */
  head: THREE.Vector3 | null;
  /** ids of this person's PerceivedHands (0..2), PerceivedFace id (or null), PerceivedBody id (or null). */
  handIds: number[];
  faceId: number | null;
  bodyId: number | null;
  /** 0..1: how much this person's mouth has been moving in the last ~1.2 s (speaking). */
  speaking: number;
  /** Seconds since any part of this person was last detected. */
  age: number;
  /** True when this is the phone holder (the viewer): the person nearest the camera whose hands/face are right at it. Best effort; usually false. */
  isViewer: boolean;
}

export interface Perception {
  hands: PerceivedHand[];
  faces: PerceivedFace[];
  bodies: PerceivedBody[];
  /** All people currently (or very recently) around, most recently seen first. */
  people: PerceivedPerson[];
  /** World-space camera position for the frame this perception was lifted from (set by lift.ts; people.ts uses it to tell the phone holder's hands from other people's). */
  cameraPosition?: THREE.Vector3;
}

/**
 * src/vision/detector.ts:
 *   export async function createVisionDetector(opts?: { maxHands?: number; maxFaces?: number; maxBodies?: number }): Promise<VisionDetector>
 * Loads MediaPipe lazily (dynamic import → separate chunk). Defaults: 4 hands, 4 faces, 3 bodies.
 * Hands run every call; faces on calls 0 and 2 of 6 and the optional pose model (bodies) on 1 and 4,
 * staggered so no call runs all three; the last results (same ids) are repeated in between.
 * Ids come from createTracker (constant-velocity prediction + size-aware gate + optimal global
 * assignment, ≤ 0.5 s gaps for hands/faces, ≤ 1 s for bodies).
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
 * headForwardCamera), gaze rotated into world space. Bodies: torso depth from cam.depthAt
 * (median of torso samples) or from the pose world landmarks' size; joints with visibility < 0.5
 * are null. age = 0 for everything returned; personId = null and people = [] until
 * src/vision/people.ts (createPeopleTracker().update(perception, dt)) attributes them.
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
  /**
   * Optional: the CameraModel of the frame the newest detections came from (pass the `cam` returned
   * by XRVisionSource.grab, BEFORE update, on the frames that carry a new detection; later frames
   * may skip it). When cam.depthMap exists the hull is re-seated at the measured palm depth and the
   * forearm is occluded from the depth map. null clears it. Omitting it = capsule hull only.
   */
  setCamera?(cam: CameraModel | null): void;
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
