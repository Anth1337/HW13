import * as THREE from "three";
import type {
  CameraModel,
  Face2D,
  Hand2D,
  Observation,
  PerceivedBody,
  PerceivedFace,
  PerceivedHand,
  Perception,
  Pose2D,
  UV,
} from "./types";

/*
 * Observation (image space) → Perception (world space). Runs at ~15 Hz; allocation is fine
 * (~0.1 ms per hand).
 *
 * Notation: camera space = x right, y up, z toward the viewer (camera looks down -z).
 * "Depth" Z = forward distance (view-space -z), "distance" = Euclidean range from the camera.
 * For an image point with camera-space ray r, its tangent-plane coords are
 *   x = r.x / -r.z,  y = r.y / -r.z   (so a camera-space point P projects to (P.x/Z, P.y/Z)).
 *
 * HANDS
 * MediaPipe gives 21 metric "world" landmarks w_i around the hand's geometric centre with axes
 * aligned to the image: x right, y DOWN, z AWAY from the camera. In camera space that offset is
 *   o_i = (w.x, -w.y, -w.z),  so the landmark sits at P_i = C + o_i, with forward depth Zc + w.z.
 *
 * 1. Size-based depth: solve the hand centre C = (Xc, Yc, -Zc) by linear least squares over all
 *    42 projection equations (exact under full perspective, not just weak perspective):
 *        x_i (Zc + w.z_i) = Xc + w.x_i   →   x_i·Zc − Xc = w.x_i − x_i·w.z_i
 *        y_i (Zc + w.z_i) = Yc − w.y_i   →   y_i·Zc − Yc = −w.y_i − y_i·w.z_i
 *    (3 unknowns, 3x3 normal equations). This is the "translation-only PnP" of a known-shape hand
 *    and reduces to weak-perspective size matching when w.z is small.
 * 1b. Pose refinement (refineHandPose): MediaPipe's world-landmark ORIENTATION is a few degrees
 *    off, which for a hand seen near edge-on changes its projected spread a lot. 6 damped
 *    Gauss-Newton steps over rotation + centre (6-DoF PnP on the 21 points, prior σ 0.12 rad on
 *    the rotation correction) fix that: synthetic 4° orientation error at 1 m → palm error
 *    max 10.9 cm → 1.1 cm (mean 2.0 → 0.2 cm).
 * 2. Measured depth (cam.depthAt, WebXR cpu depth): median over the wrist + 4 MCPs of
 *    depthAt − w.z_i + HAND_SURFACE (depth sees the skin, landmarks are joint centres ~1 cm
 *    inside). Used instead of (1) only when it agrees within 40 %; a hand edge on the
 *    background/finger gap can easily read the wall behind it.
 * 2b. Temporal smoothing of the size-based depth against the previous palm (same id, re-expressed
 *    in the current camera): changes < 12 % are blended (new weight 0.35), larger ones are real
 *    motion and pass through. Realistic noise at 1 m: worst case 7.1 → 4.8 cm after a few frames.
 * 3. Placement. Two options were implemented and compared numerically (.scratch tests):
 *      "rays":  P_i = point on landmark i's own image ray at forward depth Zc + w.z_i.
 *      "rigid": P_i = C + o_i (the refined MediaPipe shape, rigidly translated).
 *    Both are exact with perfect data and have the same palm error with noise (≤ 0.01 cm apart).
 *    "rays" reprojects onto the detected pixels exactly (0 px vs 1.4–3 px for "rigid"), which is
 *    what the depth-only occluder needs to line up with the real hand; "rigid" keeps bone lengths
 *    slightly better (2.3 vs 3.1 mm mean error at 1 m). Occlusion alignment wins → "rays".
 * Clamp: Zc to 0.15..3 m. Accuracy (synthetic, 1 px landmark noise, 4° / 2 mm world-landmark
 * error, ±5 % hand size): palm mean 0.7 cm @ 0.3 m, 2.4 cm @ 1 m (single frame). Hand-size
 * variation is irreducible without measured depth: ±5 % size = ±5 cm at 1 m.
 *
 * Velocity: palm displacement vs `prev` (same id) / dtSincePrev, exponentially smoothed with the
 * previous velocity, capped at 4 m/s; zero when unmatched or dt is not in (0, 0.5] s.
 *
 * FACES
 *   1. cam.depthAt at the eyes (5-tap median, ±0.01 uv) as along-ray distance.
 *   2. Angular size of the outer eye corners vs ≈0.09 m, corrected for head yaw using
 *      headForwardCamera (the face's lateral axis ≈ cross(up, headForward); the span seen
 *      along the eye ray is EYE_SPAN · sqrt(1 − (axis·ray)²), floored at 0.5×).
 *   Measured depth is rejected if > 40 % off the angular estimate. Clamped to 0.3..8 m.
 *   gaze = gazeCamera rotated into world space.
 *   Also carries the image-space uv (eye midpoint), box and mouthOpen through for people.ts.
 *
 * BODIES (liftBody). Torso depth Zt (forward distance of the mean torso joint plane):
 *   1. size: the same full-perspective least squares as the hands (solveHandCenter) over the
 *      visible (>= 0.5) torso joints nose / shoulders / hips and MediaPipe's hip-centred metric
 *      world landmarks; Zt = Zc + mean(w.z of those joints).
 *   2. measured: cam.depthAt median over 3-6 points inside the torso (pulled 30 % from each
 *      shoulder/hip towards the torso centre so they do not land on the background) + BODY_SURFACE
 *      (the sensor sees the front of the chest, the joint plane is ~9 cm behind it). Used only
 *      when it agrees with (1) within 40 %, or when (1) failed.
 *   Size-based depth is blended with the previous torso of the same id like the hands. Every
 *   joint then sits on its own image ray at Zt + (w.z_i - mean w.z) (offset clamped to ±0.8 m).
 *   Joints with visibility < 0.5 are null. Rejected: fewer than 3 torso joints, no shoulder.
 *
 * Hands/faces/bodies come back with personId = null and people = []: src/vision/people.ts
 * attributes them. Hand and face depth are deliberately NOT cross-checked against a matched body
 * here (a pose-lite world scale is a coarser ruler than the hand/eye-corner span; people.ts
 * only compares them).
 */

export type HandPlacement = "rays" | "rigid";

const EYE_SPAN_M = 0.09;
const FACE_MIN_DIST = 0.3;
const FACE_MAX_DIST = 8;
const HAND_MIN_DEPTH = 0.15;
const HAND_MAX_DEPTH = 3;
const HAND_SURFACE = 0.01;
const NEAR_CAMERA = 0.45;
const DEPTH_AGREEMENT = 0.4;
const DEPTH_TAP = 0.01;
const MIN_FORESHORTEN = 0.5;
const VEL_SMOOTH = 0.5; // weight of the new velocity sample
const VEL_MAX = 4;
const VEL_MAX_DT = 0.5;
/** Prior σ of MediaPipe's world-landmark orientation error (rad) vs tangent-plane residual σ. */
const ROT_SIGMA = 0.12;
const RESID_SIGMA = 0.004;
/** Weight of the new size-based depth sample, and the relative band in which it is smoothed. */
const DEPTH_SMOOTH = 0.35;
const DEPTH_SMOOTH_BAND = 0.12;
const PALM_IDX = [0, 5, 9, 13, 17] as const;
const DEPTH_IDX = [0, 5, 9, 13, 17] as const;

export function liftObservation(
  obs: Observation,
  cam: CameraModel,
  prev: Perception | null,
  dtSincePrev: number,
  placement: HandPlacement = "rays",
  refine = true,
): Perception {
  const ctx = makeCtx(cam);
  const hands: PerceivedHand[] = [];
  for (const h of obs.hands) {
    const before = prev?.hands.find((q) => q.id === h.id);
    const recent = before && dtSincePrev > 0 && dtSincePrev <= VEL_MAX_DT ? before : undefined;
    const p = liftHand(h, ctx, placement, refine, recent?.palm);
    if (!p) continue;
    // Velocity from the previous perception (matched by id).
    if (before && dtSincePrev > 0 && dtSincePrev <= VEL_MAX_DT) {
      const raw = p.palm.clone().sub(before.palm).divideScalar(dtSincePrev);
      p.velocity.copy(before.velocity).lerp(raw, VEL_SMOOTH);
      if (p.velocity.length() > VEL_MAX) p.velocity.setLength(VEL_MAX);
    }
    hands.push(p);
  }
  const faces: PerceivedFace[] = [];
  for (const f of obs.faces) {
    if (obs.facesStale) {
      // Repeated detection: its image position belongs to an older camera pose, keep the old lift.
      const old = prev?.faces.find((q) => q.id === f.id);
      if (old) faces.push(old);
      continue;
    }
    const p = liftFace(f, ctx);
    if (p) faces.push(p);
  }
  const bodies: PerceivedBody[] = [];
  for (const b of obs.bodies ?? []) {
    if (obs.bodiesStale) {
      const old = prev?.bodies?.find((q) => q.id === b.id);
      if (old) bodies.push(old);
      continue;
    }
    const before = prev?.bodies?.find((q) => q.id === b.id);
    const recent = before?.torso && dtSincePrev > 0 && dtSincePrev <= VEL_MAX_DT ? before.torso : undefined;
    const p = liftBody(b, ctx, recent);
    if (p) bodies.push(p);
  }
  return { hands, faces, bodies, people: [], cameraPosition: ctx.origin.clone() };
}

// ---------------------------------------------------------------------------------------------

export interface Ctx {
  cam: CameraModel;
  origin: THREE.Vector3;
  forward: THREE.Vector3;
  worldToCamera: THREE.Matrix4;
  /** Upper 3x3 of cameraToWorld (rotation, no normalisation of the vector). */
  rot: THREE.Matrix3;
  /** World-space unit ray through (u, v) (also refreshes origin). */
  ray(p: UV, out?: THREE.Vector3): THREE.Vector3;
  /** Camera-space unit ray through (u, v). */
  camRay(p: UV, out?: THREE.Vector3): THREE.Vector3;
}

/** Exported for tests. */
export function makeCtx(cam: CameraModel): Ctx {
  const origin = new THREE.Vector3().setFromMatrixPosition(cam.cameraToWorld);
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(cam.cameraToWorld);
  const worldToCamera = new THREE.Matrix4().copy(cam.cameraToWorld).invert();
  const ctx: Ctx = {
    cam,
    origin,
    forward,
    worldToCamera,
    rot: new THREE.Matrix3().setFromMatrix4(cam.cameraToWorld),
    ray(p, out = new THREE.Vector3()) {
      cam.ray(p.u, p.v, origin, out);
      return out.normalize();
    },
    camRay(p, out = new THREE.Vector3()) {
      return ctx.ray(p, out).transformDirection(worldToCamera);
    },
  };
  return ctx;
}

/** Forward depth (view −z) from cam.depthAt, or null. */
function depthAt(ctx: Ctx, u: number, v: number): number | null {
  if (!ctx.cam.depthAt || !(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
  const z = ctx.cam.depthAt(u, v);
  return z != null && Number.isFinite(z) && z > 0 ? z : null;
}

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  const m = vals.length >> 1;
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
}

/**
 * Hand centre in camera space from image rays + metric landmarks (see header, step 1).
 * Returns null when degenerate. Exported for tests.
 */
export function solveHandCenter(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  world: readonly { x: number; y: number; z: number }[],
): { X: number; Y: number; Z: number } | null {
  // Unknowns q = (Xc, Yc, Zc). Rows: [-1, 0, x_i]·q = w.x − x·w.z ; [0, -1, y_i]·q = −w.y − y·w.z
  let a00 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  const n = world.length;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], w = world[i];
    const rx = w.x - x * w.z;
    const ry = -w.y - y * w.z;
    a00 += 1; a02 += -x; a22 += x * x; b0 += -rx; b2 += x * rx;
    a11 += 1; a12 += -y; a22 += y * y; b1 += -ry; b2 += y * ry;
  }
  // Symmetric [[a00,0,a02],[0,a11,a12],[a02,a12,a22]]; eliminate X and Y.
  const s = a22 - (a02 * a02) / a00 - (a12 * a12) / a11;
  if (!(Math.abs(s) > 1e-12)) return null;
  const Z = (b2 - (a02 * b0) / a00 - (a12 * b1) / a11) / s;
  const X = (b0 - a02 * Z) / a00;
  const Y = (b1 - a12 * Z) / a11;
  if (!Number.isFinite(Z) || !(Z > 0)) return null;
  return { X, Y, Z };
}

/**
 * Full-perspective pose refinement (translation-only solve → 6-DoF PnP). MediaPipe's world
 * landmarks have a few degrees of orientation error; for a hand seen near edge-on that changes
 * the projected spread a lot and so the size-based depth (4° error → up to 11 cm at 1 m).
 * A few damped Gauss-Newton steps over (rotation ω, centre C) minimise the reprojection error
 * of R·o_i + C in tangent-plane units, with a Gaussian prior keeping ω near 0 (σ ≈ ROT_SIGMA).
 * Returns the rotated offsets (back in MediaPipe convention) + the refined centre.
 * Exported for tests.
 */
export function refineHandPose(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  world: readonly { x: number; y: number; z: number }[],
  init: { X: number; Y: number; Z: number },
  iterations = 6,
): { world: { x: number; y: number; z: number }[]; X: number; Y: number; Z: number } {
  const n = world.length;
  const R = new THREE.Matrix3(); // identity
  const dR = new THREE.Matrix3();
  const q = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  // camera-space offsets o_i = (w.x, -w.y, -w.z)
  const o = world.map((w) => new THREE.Vector3(w.x, -w.y, -w.z));
  const qv = new THREE.Vector3();
  let C = new THREE.Vector3(init.X, init.Y, -init.Z);
  const omega = new THREE.Vector3(); // accumulated rotation (small-angle), for the prior
  const lambdaPrior = (RESID_SIGMA / ROT_SIGMA) ** 2;
  const A = new Float64Array(36);
  const b = new Float64Array(6);
  const J = new Float64Array(12); // 2 rows x 6
  for (let it = 0; it < iterations; it++) {
    A.fill(0); b.fill(0);
    for (let i = 0; i < n; i++) {
      qv.copy(o[i]).applyMatrix3(R);
      const Px = qv.x + C.x, Py = qv.y + C.y, Pz = qv.z + C.z;
      const D = -Pz;
      if (!(D > 0.02)) continue;
      const rx = Px / D - xs[i];
      const ry = Py / D - ys[i];
      // d(x,y)/dP
      const ax0 = 1 / D, ax2 = Px / (D * D);
      const ay1 = 1 / D, ay2 = Py / (D * D);
      // dP/dω = -[q]x = [[0, q.z, -q.y], [-q.z, 0, q.x], [q.y, -q.x, 0]]
      // row x: ax0 * row0 + ax2 * row2
      J[0] = ax2 * qv.y; J[1] = ax0 * qv.z - ax2 * qv.x; J[2] = -ax0 * qv.y;
      J[3] = ax0; J[4] = 0; J[5] = ax2;
      // row y: ay1 * row1 + ay2 * row2
      J[6] = -ay1 * qv.z + ay2 * qv.y; J[7] = -ay2 * qv.x; J[8] = ay1 * qv.x;
      J[9] = 0; J[10] = ay1; J[11] = ay2;
      for (let r = 0; r < 6; r++) {
        b[r] -= J[r] * rx + J[6 + r] * ry;
        for (let c2 = 0; c2 < 6; c2++) A[r * 6 + c2] += J[r] * J[c2] + J[6 + r] * J[6 + c2];
      }
    }
    // Prior on the accumulated rotation: λ|ω + δ|²
    for (let r = 0; r < 3; r++) {
      A[r * 6 + r] += lambdaPrior;
      b[r] -= lambdaPrior * omega.getComponent(r);
    }
    for (let r = 0; r < 6; r++) A[r * 6 + r] += 1e-9;
    const d = solve6(A, b);
    if (!d) break;
    axis.set(d[0], d[1], d[2]);
    const ang = axis.length();
    if (ang > 1e-12) {
      // cap a single step at ~10°
      const a2 = Math.min(ang, 0.18);
      q.setFromAxisAngle(axis.divideScalar(ang), a2);
      dR.setFromMatrix4(m4.makeRotationFromQuaternion(q));
      R.premultiply(dR);
      omega.add(axis.multiplyScalar(a2));
    }
    C = C.add(new THREE.Vector3(d[3], d[4], d[5]));
    if (!(-C.z > 0.05)) return { world: [...world], ...init }; // diverged: keep the linear solve
    if (ang < 1e-6 && Math.hypot(d[3], d[4], d[5]) < 1e-6) break;
  }
  const out = o.map((v) => {
    v.applyMatrix3(R);
    return { x: v.x, y: -v.y, z: -v.z };
  });
  return { world: out, X: C.x, Y: C.y, Z: -C.z };
}

/** Gaussian elimination with partial pivoting on a 6x6 system (A, b are overwritten). */
function solve6(A: Float64Array, b: Float64Array): number[] | null {
  const N = 6;
  for (let col = 0; col < N; col++) {
    let piv = col;
    for (let r = col + 1; r < N; r++) if (Math.abs(A[r * N + col]) > Math.abs(A[piv * N + col])) piv = r;
    if (Math.abs(A[piv * N + col]) < 1e-18) return null;
    if (piv !== col) {
      for (let c = 0; c < N; c++) { const t = A[col * N + c]; A[col * N + c] = A[piv * N + c]; A[piv * N + c] = t; }
      const t = b[col]; b[col] = b[piv]; b[piv] = t;
    }
    for (let r = col + 1; r < N; r++) {
      const f = A[r * N + col] / A[col * N + col];
      if (f === 0) continue;
      for (let c = col; c < N; c++) A[r * N + c] -= f * A[col * N + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(N).fill(0);
  for (let r = N - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < N; c++) s -= A[r * N + c] * x[c];
    x[r] = s / A[r * N + r];
    if (!Number.isFinite(x[r])) return null;
  }
  return x;
}

/** Exported for tests. */
export function liftHand(
  h: Hand2D,
  ctx: Ctx,
  placement: HandPlacement = "rays",
  refine = true,
  prevPalm?: THREE.Vector3,
): PerceivedHand | null {
  const n = h.landmarks.length;
  if (n < 21 || h.world.length < 21) return null;

  // Camera-space rays + tangent-plane coords for every landmark.
  const rays: THREE.Vector3[] = new Array(n);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = ctx.camRay(h.landmarks[i]);
    if (!(r.z < -1e-3)) return null; // behind / at 90° to the camera: invalid
    rays[i] = r;
    xs[i] = r.x / -r.z;
    ys[i] = r.y / -r.z;
  }
  const lin = solveHandCenter(xs, ys, h.world);
  const refined = lin && refine ? refineHandPose(xs, ys, h.world, lin) : null;
  const c = refined ?? lin;
  const world = refined ? refined.world : h.world;
  let Zc = c ? c.Z : null;

  // Measured depth, sanity-checked against the size-based estimate.
  let measuredUsed = false;
  if (ctx.cam.depthAt) {
    const vals: number[] = [];
    for (const i of DEPTH_IDX) {
      const lm = h.landmarks[i];
      const z = depthAt(ctx, lm.u, lm.v);
      if (z != null) vals.push(z - world[i].z + HAND_SURFACE);
    }
    const measured = median(vals);
    if (measured != null && (Zc == null || Math.abs(measured - Zc) / Zc <= DEPTH_AGREEMENT)) {
      Zc = measured;
      measuredUsed = true;
      prevPalm = undefined; // measured depth needs no smoothing
    }
  }
  if (Zc == null) return null;
  // Temporal smoothing of the size-based depth (per-frame landmark noise → depth jitter). The
  // palm's forward depth is Zc + mean(w.z over palm points); compare with the previous palm
  // re-expressed in the current camera. Small changes are blended, large ones (real motion)
  // pass through untouched.
  if (prevPalm) {
    let palmDz = 0;
    for (const i of PALM_IDX) palmDz += world[i].z;
    palmDz /= PALM_IDX.length;
    const now = Zc + palmDz;
    const before = new THREE.Vector3().subVectors(prevPalm, ctx.origin).dot(ctx.forward);
    if (before > 0 && Math.abs(now - before) < DEPTH_SMOOTH_BAND * now) {
      Zc += (before + (now - before) * DEPTH_SMOOTH) - now;
    }
  }
  Zc = THREE.MathUtils.clamp(Zc, HAND_MIN_DEPTH, HAND_MAX_DEPTH);

  // Camera-space landmark positions.
  const pts: THREE.Vector3[] = new Array(n);
  if (placement === "rigid" && c) {
    // Recentre X/Y for the (possibly measured/clamped) depth: keep the solved image position.
    const k = Zc / c.Z;
    for (let i = 0; i < n; i++) {
      const w = world[i];
      pts[i] = new THREE.Vector3(c.X * k + w.x, c.Y * k - w.y, -(Zc + w.z));
    }
  } else {
    for (let i = 0; i < n; i++) {
      const z = Math.max(0.05, Zc + world[i].z);
      pts[i] = rays[i].clone().multiplyScalar(z / -rays[i].z);
    }
  }

  // → world space.
  const origin = ctx.origin; // refreshed by camRay()
  const points = pts.map((p) => p.applyMatrix3(ctx.rot).add(origin));
  const palm = new THREE.Vector3();
  for (const i of PALM_IDX) palm.add(points[i]);
  palm.divideScalar(PALM_IDX.length);
  const distance = palm.distanceTo(origin);
  return {
    id: h.id,
    confidence: h.score,
    palm,
    points,
    velocity: new THREE.Vector3(),
    distance,
    nearCamera: distance < NEAR_CAMERA,
    age: 0,
    personId: null,
    uv: palmUV(h.landmarks),
    // The detection frame's camera (camRay refreshed ctx.origin above); contact tests widen
    // along the ray from here when the depth is size-based.
    origin: origin.clone(),
    depthMeasured: measuredUsed,
  };
}

function palmUV(lm: readonly UV[]): UV {
  let u = 0, v = 0;
  for (const i of PALM_IDX) { u += lm[i].u; v += lm[i].v; }
  return { u: u / PALM_IDX.length, v: v / PALM_IDX.length };
}

function liftFace(f: Face2D, ctx: Ctx): PerceivedFace | null {
  const UP = new THREE.Vector3(0, 1, 0);
  // Angular distance from the eye-corner span, yaw-corrected with the head pose.
  const ra = ctx.ray(f.leftEyeOuter);
  const rb = ctx.ray(f.rightEyeOuter);
  const angle = ra.angleTo(rb);
  let span = EYE_SPAN_M;
  const hf = new THREE.Vector3(f.headForwardCamera.x, f.headForwardCamera.y, f.headForwardCamera.z);
  if (hf.lengthSq() > 1e-12) {
    const lateral = new THREE.Vector3().crossVectors(UP, hf.normalize());
    if (lateral.lengthSq() > 1e-6) {
      lateral.normalize();
      const mid: UV = { u: (f.leftEyeOuter.u + f.rightEyeOuter.u) / 2, v: (f.leftEyeOuter.v + f.rightEyeOuter.v) / 2 };
      const cr = ctx.camRay(mid);
      const cdot = lateral.dot(cr);
      span = EYE_SPAN_M * Math.max(MIN_FORESHORTEN, Math.sqrt(Math.max(0, 1 - cdot * cdot)));
    }
  }
  const angular = angle > 1e-4 ? span / 2 / Math.tan(angle / 2) : null;

  // Measured along-ray distance at the eyes (5-tap median).
  const eyeRay = ctx.ray(f.eyes);
  const cos = eyeRay.dot(ctx.forward);
  let dist: number | null = null;
  if (ctx.cam.depthAt && cos > 0.05) {
    const vals: number[] = [];
    const taps: [number, number][] = [[0, 0], [DEPTH_TAP, 0], [-DEPTH_TAP, 0], [0, DEPTH_TAP], [0, -DEPTH_TAP]];
    for (const [du, dv] of taps) {
      const z = depthAt(ctx, f.eyes.u + du, f.eyes.v + dv);
      if (z != null) vals.push(z / cos);
    }
    dist = median(vals);
  }
  if (dist != null && angular != null && Math.abs(dist - angular) / angular > DEPTH_AGREEMENT) dist = angular;
  if (dist == null) dist = angular;
  if (dist == null) return null;
  dist = THREE.MathUtils.clamp(dist, FACE_MIN_DIST, FACE_MAX_DIST);

  ctx.ray(f.eyes, eyeRay); // refresh origin
  const head = ctx.origin.clone().addScaledVector(eyeRay, dist);
  const g = new THREE.Vector3(f.gazeCamera.x, f.gazeCamera.y, f.gazeCamera.z);
  if (g.lengthSq() < 1e-12) return null;
  const gaze = g.transformDirection(ctx.cam.cameraToWorld); // normalises
  return {
    id: f.id,
    confidence: f.score,
    head,
    gaze,
    age: 0,
    personId: null,
    mouthOpen: f.mouthOpen,
    uv: { u: f.eyes.u, v: f.eyes.v },
    box: { u0: f.box.u0, v0: f.box.v0, u1: f.box.u1, v1: f.box.v1 },
  };
}

const BODY_VIS = 0.5;
const BODY_SURFACE = 0.09;
const BODY_MIN_DEPTH = 0.3;
const BODY_MAX_DEPTH = 8;
const BODY_JOINT_DZ = 0.8;
const BODY_MIN_SPAN = 0.02; // tangent-plane span below which the size solve is degenerate
const P_NOSE = 0, P_LS = 11, P_RS = 12, P_LW = 15, P_RW = 16, P_LH = 23, P_RH = 24;
const TORSO_SIZE_IDX = [P_NOSE, P_LS, P_RS, P_LH, P_RH] as const;
const depthScratch: number[] = [];

/** Exported for tests. */
export function liftBody(b: Pose2D, ctx: Ctx, prevTorso?: THREE.Vector3): PerceivedBody | null {
  const lm = b.landmarks, w = b.world, vis = b.visibility;
  if (lm.length < 33 || w.length < 33 || vis.length < 33) return null;
  const seen = (i: number) => vis[i] >= BODY_VIS;
  if (!seen(P_LS) && !seen(P_RS)) return null;

  // Size-based torso depth (least squares over the visible torso joints).
  const sx: number[] = [], sy: number[] = [], sw: { x: number; y: number; z: number }[] = [];
  const r = new THREE.Vector3();
  let zt = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const i of TORSO_SIZE_IDX) {
    if (!seen(i)) continue;
    ctx.camRay(lm[i], r);
    if (!(r.z < -1e-3)) continue;
    const x = r.x / -r.z, y = r.y / -r.z;
    sx.push(x); sy.push(y); sw.push(w[i]);
    zt += w[i].z;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (sx.length < 3) return null;
  zt /= sx.length;
  const sol = Math.max(maxX - minX, maxY - minY) >= BODY_MIN_SPAN ? solveHandCenter(sx, sy, sw) : null;
  let Zt: number | null = sol ? sol.Z + zt : null;
  let measuredUsed = false;

  // Measured torso depth: points inside the torso, pulled towards its centre.
  if (ctx.cam.depthAt) {
    let cu = 0, cv = 0, cn = 0;
    for (const i of [P_LS, P_RS, P_LH, P_RH]) if (seen(i)) { cu += lm[i].u; cv += lm[i].v; cn++; }
    cu /= cn; cv /= cn;
    depthScratch.length = 0;
    const tap = (u: number, v: number) => {
      const z = depthAt(ctx, u, v);
      if (z != null) depthScratch.push(z + BODY_SURFACE);
    };
    tap(cu, cv);
    for (const i of [P_LS, P_RS, P_LH, P_RH]) if (seen(i)) tap(lm[i].u + 0.3 * (cu - lm[i].u), lm[i].v + 0.3 * (cv - lm[i].v));
    if (seen(P_LS) && seen(P_RS)) tap((lm[P_LS].u + lm[P_RS].u) / 2, (lm[P_LS].v + lm[P_RS].v) / 2);
    const measured = depthScratch.length >= 3 ? median(depthScratch) : null;
    if (measured != null && (Zt == null || Math.abs(measured - Zt) / Zt <= DEPTH_AGREEMENT)) {
      Zt = measured;
      measuredUsed = true;
    }
  }
  if (Zt == null) return null;
  if (!measuredUsed && prevTorso) {
    const before = new THREE.Vector3().subVectors(prevTorso, ctx.origin).dot(ctx.forward);
    if (before > 0 && Math.abs(Zt - before) < DEPTH_SMOOTH_BAND * Zt) Zt += (before - Zt) * (1 - DEPTH_SMOOTH);
  }
  Zt = THREE.MathUtils.clamp(Zt, BODY_MIN_DEPTH, BODY_MAX_DEPTH);

  const place = (i: number): THREE.Vector3 | null => {
    if (!seen(i)) return null;
    const ray = ctx.camRay(lm[i]);
    if (!(ray.z < -1e-3)) return null;
    const dz = THREE.MathUtils.clamp(w[i].z - zt, -BODY_JOINT_DZ, BODY_JOINT_DZ);
    const z = Math.max(0.05, Zt! + dz);
    return ray.multiplyScalar(z / -ray.z).applyMatrix3(ctx.rot).add(ctx.origin);
  };
  const uvOf = (i: number): UV | null => (seen(i) ? { u: lm[i].u, v: lm[i].v } : null);

  const ls = place(P_LS), rs = place(P_RS), lh = place(P_LH), rh = place(P_RH);
  const torso = new THREE.Vector3();
  let tu = 0, tv = 0, tn = 0;
  const addTorso = (p: THREE.Vector3 | null, i: number) => {
    if (!p) return;
    torso.add(p); tu += lm[i].u; tv += lm[i].v; tn++;
  };
  addTorso(ls, P_LS); addTorso(rs, P_RS);
  if (lh && rh) { addTorso(lh, P_LH); addTorso(rh, P_RH); }
  if (tn === 0) return null;
  torso.divideScalar(tn);

  return {
    id: b.id,
    confidence: b.score,
    age: 0,
    nose: place(P_NOSE),
    leftShoulder: ls,
    rightShoulder: rs,
    leftWrist: place(P_LW),
    rightWrist: place(P_RW),
    torso,
    torsoUV: { u: tu / tn, v: tv / tn },
    leftWristUV: uvOf(P_LW),
    rightWristUV: uvOf(P_RW),
    noseUV: uvOf(P_NOSE),
  };
}
