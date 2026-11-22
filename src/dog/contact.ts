import * as THREE from "three";
import type { PerceivedHand } from "../vision/types";

/*
 * Depth-tolerant hand ↔ petting-zone contact, shared by the own pet (brain.ts) and friends' pets
 * (net/party.ts).
 *
 * Without a depth sensor (iOS / camera mode) a hand's depth comes from its apparent size alone.
 * That error lies ALONG the camera ray through the hand: a few cm at 0.5 m, more when the hand is
 * foreshortened or clipped by the image edge, which is as large as a head zone. A strict
 * point-in-sphere test then misses a hand that visibly covers the pet, and contact flickers.
 *
 * So each hand point is widened into a SEGMENT of its camera ray, spanning its depth ± a fraction
 * of the range (plus a little lateral slack), and the zone is touched when that segment comes
 * within the zone radius. It still requires the hand to be roughly at the pet's distance: a hand
 * next to the phone a metre in front of the pet does not count.
 *
 * With a measured depth (WebXR depth sensing) the tolerance starts at zero, i.e. exactly the old
 * containsPoint test, so Android behaves as before (a little hysteresis once a session runs).
 *
 * Allocation-free (module scratch vectors).
 */

/** How far contact may be off: lateral slack (m) and depth slab = depthFrac × range + depthAbs (m). */
export interface ContactTol {
  lateral: number;
  depthFrac: number;
  depthAbs: number;
}

/** Palm + these landmarks (MediaPipe fingertips) are tested. */
export const FINGERTIPS: readonly number[] = [4, 8, 12, 16, 20];

// Measured depth: strict to start (= containsPoint), a little slack while a session runs.
const TOL_MEASURED_START: Readonly<ContactTol> = { lateral: 0, depthFrac: 0, depthAbs: 0 };
const TOL_MEASURED_ACTIVE: Readonly<ContactTol> = { lateral: 0.03, depthFrac: 0, depthAbs: 0.04 };
// Size-based depth: about ±25 % of range to start, ±35 % (and more lateral slack) once petting.
const TOL_SIZE_START: Readonly<ContactTol> = { lateral: 0.03, depthFrac: 0.25, depthAbs: 0.05 };
const TOL_SIZE_ACTIVE: Readonly<ContactTol> = { lateral: 0.06, depthFrac: 0.35, depthAbs: 0.08 };
/** The depth segment never reaches nearer the lens than this (m). */
const MIN_RAY_T = 0.05;

/**
 * Contact tolerance for a hand. `active` = the session it is tested for is already running
 * (hysteresis: harder to lose a pet than to start one).
 */
export function contactTol(h: PerceivedHand, active: boolean): ContactTol {
  if (h.depthMeasured) return active ? TOL_MEASURED_ACTIVE : TOL_MEASURED_START;
  return active ? TOL_SIZE_ACTIVE : TOL_SIZE_START;
}

const _d = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Gap (m, <= 0 = touching) between `zone` and the segment of the camera ray from `origin` through
 * `p` that spans p's range ± the tolerance slab. `out` = the contact point: the segment point
 * nearest the zone centre, pulled onto the sphere surface when it lies outside.
 */
export function pointZoneGap(
  zone: THREE.Sphere,
  origin: THREE.Vector3,
  p: THREE.Vector3,
  tol: ContactTol,
  out: THREE.Vector3,
): number {
  const d = _d.subVectors(p, origin);
  const L = d.length();
  let gap: number;
  if (L < 1e-4) {
    out.copy(p);
    gap = p.distanceTo(zone.center) - (zone.radius + tol.lateral);
  } else {
    d.divideScalar(L);
    const slab = tol.depthFrac * L + tol.depthAbs;
    const t = THREE.MathUtils.clamp(_w.subVectors(zone.center, origin).dot(d), Math.max(MIN_RAY_T, L - slab), L + slab);
    out.copy(origin).addScaledVector(d, t);
    gap = out.distanceTo(zone.center) - (zone.radius + tol.lateral);
  }
  // Report a point ON the pet (the hit point drives lean / look / sound position).
  const dc = out.distanceTo(zone.center);
  if (dc > zone.radius && dc > 1e-6) out.sub(zone.center).multiplyScalar(zone.radius / dc).add(zone.center);
  return gap;
}

/**
 * Smallest gap between `zone` and the hand's palm / fingertips (see pointZoneGap), tested along
 * the rays of the hand's detection camera (h.origin). Points whose contact point fails `filter`
 * are skipped. `out` = the best contact point (untouched when nothing passes; returns Infinity).
 */
export function handZoneGap(
  zone: THREE.Sphere,
  h: PerceivedHand,
  tol: ContactTol,
  out: THREE.Vector3,
  filter?: (p: THREE.Vector3) => boolean,
): number {
  let best = Infinity;
  const n = FINGERTIPS.length;
  for (let i = -1; i < n; i++) {
    const p = i < 0 ? h.palm : h.points[FINGERTIPS[i]];
    if (!p) continue;
    const g = pointZoneGap(zone, h.origin, p, tol, _c);
    if (g >= best) continue;
    if (filter && !filter(_c)) continue;
    best = g;
    out.copy(_c);
  }
  return best;
}
