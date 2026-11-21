import * as THREE from "three";
import type { CameraModel, Human2D, LiftHints, PerceivedHuman, UV } from "./types";

/*
 * Human2D (image space) → PerceivedHuman (world space). Runs at ~10 Hz, so allocation is fine.
 *
 * Person distance (along the ray through the eyes, from the camera):
 *   1. cam.depthAt at the eyes (else shoulder midpoint). depthAt is forward-axis (view -z)
 *      depth, so along-ray distance = depth / (rayDir · cameraForward).
 *   2. Angular size: the angle between the rays through the two outer eye corners vs ≈0.09 m,
 *      else between the shoulder rays vs ≈0.38 m.  distance = (span/2) / tan(angle/2).
 *      The eye span is corrected for head yaw (foreshortening): the face's lateral axis is
 *      estimated as cross(up, gaze) in camera space, and the span seen from the eye ray is
 *      EYE_SPAN · sqrt(1 − (axis·ray)²) (floored at 0.5×). Without that, a head turned 50° away
 *      reads ~1.55× too far.
 *   Measured depth is a 5-tap median (anchor ± 0.01 in u and v) so a single pixel that slipped
 *   past a thin silhouette onto the background can't win; if it still disagrees with the
 *   angular estimate by more than 40 %, the angular estimate is used.
 *   Clamped to 0.3..8 m. With nothing usable, head is null (hands may still be found via
 *   reach targets).
 */

const EYE_SPAN_M = 0.09;
const SHOULDER_SPAN_M = 0.38;
const MIN_DIST = 0.3;
const MAX_DIST = 8;
const HAND_DEPTH_TOLERANCE = 1.2;
const REACH_SLACK = 0.25;
const REACH_DEPTH_TOLERANCE = 1.0;
const DEPTH_AGREEMENT = 0.4;
const DEPTH_TAP = 0.01;
const MIN_FORESHORTEN = 0.5;

export function liftHumans(humans: readonly Human2D[], cam: CameraModel, hints: LiftHints): PerceivedHuman[] {
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(cam.cameraToWorld);
  const origin = new THREE.Vector3();
  const out: PerceivedHuman[] = [];

  const rayDir = (p: UV): THREE.Vector3 => {
    const o = new THREE.Vector3();
    const d = new THREE.Vector3();
    cam.ray(p.u, p.v, o, d);
    origin.copy(o);
    return d.normalize();
  };

  /** depthAt converted to along-ray distance, or null. */
  const rayDepth = (p: UV): number | null => {
    if (!cam.depthAt) return null;
    const z = cam.depthAt(p.u, p.v);
    if (z == null || !Number.isFinite(z) || z <= 0) return null;
    const cos = rayDir(p).dot(forward);
    if (!(cos > 0.05)) return null;
    return z / cos;
  };

  /** Median of rayDepth over the anchor and four neighbours (± DEPTH_TAP in u and v). */
  const medianRayDepth = (p: UV): number | null => {
    if (!cam.depthAt) return null;
    const vals: number[] = [];
    const taps: [number, number][] = [[0, 0], [DEPTH_TAP, 0], [-DEPTH_TAP, 0], [0, DEPTH_TAP], [0, -DEPTH_TAP]];
    for (const [du, dv] of taps) {
      const u = p.u + du;
      const v = p.v + dv;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const z = rayDepth({ u, v });
      if (z != null) vals.push(z);
    }
    if (vals.length === 0) return null;
    vals.sort((a, b) => a - b);
    const m = vals.length >> 1;
    return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  };

  const angularDistance = (a: UV, b: UV, span: number): number | null => {
    const da = rayDir(a);
    const db = rayDir(b);
    const angle = da.angleTo(db);
    if (!(angle > 1e-4)) return null;
    return span / 2 / Math.tan(angle / 2);
  };

  const worldToCamera = new THREE.Matrix4().copy(cam.cameraToWorld).invert();
  const UP = new THREE.Vector3(0, 1, 0);

  /** Eye-corner span as seen from the camera, shrunk by the head's yaw relative to the eye ray. */
  const effectiveEyeSpan = (face: NonNullable<Human2D["face"]>): number => {
    const g = new THREE.Vector3(face.gazeCamera.x, face.gazeCamera.y, face.gazeCamera.z);
    if (g.lengthSq() < 1e-12) return EYE_SPAN_M;
    const lateral = new THREE.Vector3().crossVectors(UP, g.normalize());
    if (lateral.lengthSq() < 1e-6) return EYE_SPAN_M; // looking straight up/down: no yaw info
    lateral.normalize();
    const mid: UV = { u: (face.leftEyeOuter.u + face.rightEyeOuter.u) / 2, v: (face.leftEyeOuter.v + face.rightEyeOuter.v) / 2 };
    const r = rayDir(mid).transformDirection(worldToCamera); // camera-space unit ray
    const c = lateral.dot(r);
    return EYE_SPAN_M * Math.max(MIN_FORESHORTEN, Math.sqrt(Math.max(0, 1 - c * c)));
  };

  for (const h of humans) {
    // --- person distance (along the eye ray, or shoulder-midpoint ray when no eyes) ---
    const anchor: UV | null = h.eyes
      ?? (h.shoulders ? { u: (h.shoulders.left.u + h.shoulders.right.u) / 2, v: (h.shoulders.left.v + h.shoulders.right.v) / 2 } : null);

    let angular: number | null = null;
    if (h.face) angular = angularDistance(h.face.leftEyeOuter, h.face.rightEyeOuter, effectiveEyeSpan(h.face));
    if (angular == null && h.shoulders) angular = angularDistance(h.shoulders.left, h.shoulders.right, SHOULDER_SPAN_M);
    let dist: number | null = anchor ? medianRayDepth(anchor) : null;
    if (dist != null && angular != null && Math.abs(dist - angular) / angular > DEPTH_AGREEMENT) dist = angular;
    if (dist == null) dist = angular;
    if (dist != null) dist = THREE.MathUtils.clamp(dist, MIN_DIST, MAX_DIST);

    // --- head ---
    let head: THREE.Vector3 | null = null;
    if (h.eyes && dist != null) {
      const d = rayDir(h.eyes);
      head = origin.clone().addScaledVector(d, dist);
    }

    // --- gaze ---
    let gaze: THREE.Vector3 | null = null;
    if (h.face) {
      const g = h.face.gazeCamera;
      const v = new THREE.Vector3(g.x, g.y, g.z);
      if (v.lengthSq() > 1e-12) gaze = v.transformDirection(cam.cameraToWorld); // normalises
    }

    // --- hands ---
    const hands: THREE.Vector3[] = [];
    for (const hp of h.hands) {
      const p = liftHand(hp, dist);
      if (p) hands.push(p);
    }

    if (!head && !gaze && hands.length === 0) continue;
    out.push({ id: h.id, confidence: h.score, head, gaze, hands, age: 0 });
  }
  return out;

  function liftHand(hp: UV, personDist: number | null): THREE.Vector3 | null {
    // 1. Measured depth, sanity-checked against the person's own distance.
    const hd = rayDepth(hp);
    if (hd != null && (personDist == null || Math.abs(hd - personDist) <= HAND_DEPTH_TOLERANCE)) {
      const d = rayDir(hp);
      return origin.clone().addScaledVector(d, hd);
    }

    // 2. Reach-target snapping: closest point on the hand ray to each sphere centre.
    const d = rayDir(hp);
    const o = origin.clone();
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    for (const s of hints.reachTargets) {
      const t = Math.max(0, s.center.clone().sub(o).dot(d));
      const p = o.clone().addScaledVector(d, t);
      const miss = p.distanceTo(s.center);
      if (miss > s.radius + REACH_SLACK) continue;
      if (personDist != null && Math.abs(t - personDist) > REACH_DEPTH_TOLERANCE) continue;
      const score = miss - s.radius;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) return best;

    // 3. Fallback: at the person's own depth (the brain still checks zone distances, so a hand
    //    placed at the body's depth won't pet a dog that's nearer the camera).
    if (personDist != null) return o.addScaledVector(d, personDist);
    return null;
  }
}
