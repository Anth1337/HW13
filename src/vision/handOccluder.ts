import * as THREE from "three";
import type { CameraModel, HandOccluder, PerceivedHand } from "./types";

/*
 * Depth-only hand proxy so the virtual dog is hidden behind the user's real hand.
 * Design goal: UNDER-mask. A sliver of fur showing over a finger edge is fine; a dog hidden
 * by a glove-shaped blob is not. Every dimension is therefore biased below real anatomy.
 *
 * Primary silhouette = the HULL (accurate in x/y because it comes from the landmarks), per hand
 * slot (max 2):
 *   - InstancedMesh of unit cylinders, one per bone, scaled (r, length, r), plus an InstancedMesh
 *     of unit spheres at the joints => capsules along the bones. MediaPipe landmarks are joint
 *     CENTRES (inside the finger), so radii are skeleton-inside-the-silhouette values: adult
 *     finger 14-18 mm wide (r 7-9 mm), tapering base -> tip, thumb wider, then multiplied by
 *     BIAS (0.85). The joint spheres take the radius of the thicker adjoining bone, no extra growth.
 *   - a palm slab: polygon 0-1-5-9-13-17 grown 3 mm, extruded +-8 mm at the knuckles and thinner
 *     towards the wrist.
 *   All dimensions scale with the detected hand span (wrist -> middle MCP, 9.5 cm adult), clamped
 *   0.8..1.15, so a small / child hand is not over-masked.
 *   Material: colorWrite false, depthWrite true; renderOrder -10 so the proxy fills the depth
 *   buffer before the opaque dog (renderOrder 0). It must live in the same scene as the dog.
 *
 * DEPTH PATH (optional, when setCamera() was given a cam with cam.depthMap: ARCore Depth API / ToF
 * through WebXR cpu-optimized depth sensing; iOS Safari exposes no WebXR depth, so iPhone LiDAR
 * is unreachable from the web and iPhones run hull-only). The depth map is low-res (~160x90) and
 * noisy at edges, so it must not define the silhouette. It contributes two things, once per
 * fresh detection:
 *   (a) hull re-seating: the median depth over the palm interior gives the measured palm surface;
 *       the whole hull is scaled about the camera (image position unchanged) so that its palm
 *       centre sits half a palm-thickness behind that surface. Fixes lift depth error, which
 *       is what makes the dog poke through (too far) or vanish early (too near).
 *   (b) forearm continuation: the arm behind the wrist is not covered by the landmarks. A small
 *       grid (8x8 cells) is laid over the image region behind the wrist (0.9 hand spans long,
 *       0.7 palm widths wide), vertices are unprojected at the measured depth (+8 mm, i.e. biased
 *       away from the camera), and only quads whose four corners lie within +-7 cm of the palm
 *       surface depth and agree to 3 cm are kept (the surface IS the arm, not floor/wall/dog).
 *       If fewer than half the cells survive, or the region is implausibly large, the forearm
 *       mesh is dropped and only the hull remains. The mesh can never exceed that small region,
 *       so a depth glitch cannot hide the dog broadly.
 *
 * Latency: points are shifted by velocity x lead, lead = min(age + 0.03, 0.06) s, damped to 0
 * for very slow motion (jitter). Quasi-static hands are lightly smoothed over detections to avoid
 * mask flicker. A slot is hidden 0.25 s after its hand was last detected.
 * update() allocates nothing in steady state.
 */

/** Bone list (landmark index pairs). */
export const HAND_BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

/** Anatomical (skeleton-to-silhouette) radius in meters per bone, same order as HAND_BONES. */
export const ANATOMICAL_BONE_RADII: readonly number[] = [
  0.0105, 0.0105, 0.0095, 0.0085, // thumb
  0.0075, 0.0082, 0.0074, 0.0064, // wrist-index edge, index
  0.0085, 0.0088, 0.0078, 0.0068, // knuckle line, middle
  0.0085, 0.0082, 0.0072, 0.0062, // knuckle line, ring
  0.008, 0.0072, 0.0062, 0.0053, // knuckle line, pinky
  0.007, // wrist-pinky edge
];
/** Deliberate under-mask bias applied to every radius and the palm. */
export const BIAS = 0.85;
/** Per-bone radius in meters used by the hull (anatomy x BIAS). */
export const BONE_RADII: readonly number[] = ANATOMICAL_BONE_RADII.map((r) => r * BIAS);

const JOINT_RADII: number[] = new Array(21).fill(0);
HAND_BONES.forEach(([a, b], i) => {
  JOINT_RADII[a] = Math.max(JOINT_RADII[a], BONE_RADII[i]);
  JOINT_RADII[b] = Math.max(JOINT_RADII[b], BONE_RADII[i]);
});

const PALM_RING = [0, 1, 5, 9, 13, 17] as const;
/** Slab half-thickness at each ring vertex (m, before BIAS): thinner at the wrist. */
const PALM_HALF_THICK = [0.0068, 0.0076, 0.0095, 0.0095, 0.0095, 0.0085];
const PALM_GROW = 0.003;
const HAND_SPAN = 0.095;
const SCALE_MIN = 0.8;
const SCALE_MAX = 1.15;
const LOST_AFTER = 0.25;
const LEAD_BASE = 0.03;
const LEAD_MAX = 0.06;
const SMOOTH_MAX = 0.3;
const MAX_HANDS = 2;
const EVICT_MARGIN = 0.3; // m: a near-camera hand takes the slot of a hand this much farther

// Depth refinement.
const DEPTH_CAM_MAX_AGE = 0.12;
const DEPTH_LIFT_TOLERANCE = 0.12;
const DEPTH_PALM_HALF_THICK = 0.009;
const RATIO_MIN = 0.9;
const RATIO_MAX = 1.1;
const ARM_N = 8;
const ARM_BAND = 0.07;
const ARM_STEP = 0.03;
const ARM_BACK = 0.008;
const ARM_MIN_KEPT = 0.5;
const ARM_MAX_AREA = 0.02;

interface Slot {
  group: THREE.Group;
  bones: THREE.InstancedMesh;
  joints: THREE.InstancedMesh;
  palm: THREE.Mesh;
  palmPos: THREE.BufferAttribute;
  arm: THREE.Mesh;
  armPos: THREE.BufferAttribute;
  armIndex: THREE.BufferAttribute;
  /** Last detected points + velocity (copied, so prediction works after the hand is gone). */
  pts: THREE.Vector3[];
  vel: THREE.Vector3;
  id: number;
  /** Seconds since last detection; Infinity = free. */
  since: number;
  /** h.age seen on the previous update (a drop means a new detection). */
  lastAge: number;
  /** Camera distance of the hand in the slot (m): the nearest hands get the slots. */
  dist: number;
  armOn: boolean;
  /** Assigned during the current update. */
  claimed: boolean;
}

export function createHandOccluder(scene: THREE.Scene): HandOccluder {
  const material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true });
  const palmMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  // Unit cylinder along +Y, height 1 (-0.5..0.5), radius 1; open-ended (spheres cap it).
  const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  const sphGeo = new THREE.SphereGeometry(1, 10, 8);

  // Palm slab topology: ring vertices 0..5 on the + side, 6..11 on the - side.
  const palmIndex: number[] = [];
  for (let i = 1; i < 5; i++) {
    palmIndex.push(0, i, i + 1); // top fan
    palmIndex.push(6, 6 + i + 1, 6 + i); // bottom fan
  }
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    palmIndex.push(i, 6 + i, j, j, 6 + i, 6 + j);
  }

  const ARM_V = (ARM_N + 1) * (ARM_N + 1);
  const slots: Slot[] = [];
  for (let s = 0; s < MAX_HANDS; s++) {
    const group = new THREE.Group();
    group.name = `hand-occluder-${s}`;
    group.visible = false;
    const bones = new THREE.InstancedMesh(cylGeo, material, HAND_BONES.length);
    const joints = new THREE.InstancedMesh(sphGeo, material, 21);
    const palmGeo = new THREE.BufferGeometry();
    const palmPos = new THREE.BufferAttribute(new Float32Array(12 * 3), 3);
    palmPos.setUsage(THREE.DynamicDrawUsage);
    palmGeo.setAttribute("position", palmPos);
    palmGeo.setIndex(palmIndex);
    const palm = new THREE.Mesh(palmGeo, palmMaterial);
    const armGeo = new THREE.BufferGeometry();
    const armPos = new THREE.BufferAttribute(new Float32Array(ARM_V * 3), 3);
    armPos.setUsage(THREE.DynamicDrawUsage);
    const armIndex = new THREE.BufferAttribute(new Uint16Array(ARM_N * ARM_N * 6), 1);
    armIndex.setUsage(THREE.DynamicDrawUsage);
    armGeo.setAttribute("position", armPos);
    armGeo.setIndex(armIndex);
    armGeo.setDrawRange(0, 0);
    const arm = new THREE.Mesh(armGeo, palmMaterial);
    arm.visible = false;
    for (const m of [bones, joints, palm, arm]) {
      m.renderOrder = -10;
      m.frustumCulled = false; // bounds change every frame
      m.castShadow = false;
      m.receiveShadow = false;
      m.matrixAutoUpdate = false; // positions are world-space already
      group.add(m);
    }
    bones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    joints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.renderOrder = -10;
    group.matrixAutoUpdate = false;
    scene.add(group);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 21; i++) pts.push(new THREE.Vector3());
    slots.push({
      group, bones, joints, palm, palmPos, arm, armPos, armIndex, pts,
      vel: new THREE.Vector3(), id: -1, since: Infinity, lastAge: Infinity, dist: Infinity, armOn: false, claimed: false,
    });
  }

  // Temporaries (no allocation in update).
  const P: THREE.Vector3[] = [];
  for (let i = 0; i < 21; i++) P.push(new THREE.Vector3());
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const mat = new THREE.Matrix4();
  const Y = new THREE.Vector3(0, 1, 0);

  // ---- camera model for the depth path ------------------------------------------------------
  let cam: CameraModel | null = null;
  let camAge = Infinity;
  const camOrigin = new THREE.Vector3();
  const camForward = new THREE.Vector3();
  const camInv = new THREE.Matrix4(); // world -> view rotation
  let txA = 0, txB = 1, tyA = 0, tyB = 1;
  // Output of projTan.
  let pTx = 0, pTy = 0, pDepth = 0;
  const viewDir = new THREE.Vector3();

  function tanAt(u: number, v: number, axis: "x" | "y"): number {
    cam!.ray(u, v, tmpA, viewDir);
    viewDir.applyMatrix4(camInv);
    return axis === "x" ? viewDir.x / -viewDir.z : viewDir.y / -viewDir.z;
  }

  function setCamera(next: CameraModel | null) {
    cam = null;
    camAge = Infinity;
    if (!next) return;
    try {
      if (!next.depthMap) return;
      next.ray(0.5, 0.5, camOrigin, dir);
      camInv.copy(next.cameraToWorld).transpose();
      camForward.set(0, 0, -1).transformDirection(next.cameraToWorld);
      cam = next;
      txA = tanAt(0, 0.5, "x");
      txB = tanAt(1, 0.5, "x");
      tyA = tanAt(0.5, 0, "y");
      tyB = tanAt(0.5, 1, "y");
      if (!(Math.abs(txB - txA) > 1e-6 && Math.abs(tyB - tyA) > 1e-6)) cam = null;
      else camAge = 0;
    } catch {
      cam = null;
    }
  }

  /** World point -> tangent-space image coords (pTx, pTy) and view depth (pDepth). */
  function projTan(p: THREE.Vector3) {
    tmpA.subVectors(p, camOrigin).applyMatrix4(camInv);
    pDepth = -tmpA.z;
    const inv = pDepth > 1e-4 ? 1 / pDepth : 0;
    pTx = tmpA.x * inv;
    pTy = tmpA.y * inv;
  }
  const uOf = (tx: number) => (tx - txA) / (txB - txA);
  const vOf = (ty: number) => (ty - tyA) / (tyB - tyA);

  const samples = new Float32Array(8);
  const armD = new Float32Array((ARM_N + 1) * (ARM_N + 1));
  const armOk = new Uint8Array((ARM_N + 1) * (ARM_N + 1));
  const SAMPLE_PTS = [0, 5, 9, 13, 17] as const;

  /** Re-seats slot.pts at the measured palm depth; returns the palm surface depth or 0. */
  function refineDepth(slot: Slot): number {
    const map = cam!.depthMap!;
    centroid.set(0, 0, 0);
    for (let k = 0; k < SAMPLE_PTS.length; k++) centroid.add(slot.pts[SAMPLE_PTS[k]]);
    centroid.multiplyScalar(1 / SAMPLE_PTS.length);
    projTan(centroid);
    const lifted = pDepth;
    if (!(lifted > 0.1)) return 0;
    let n = 0;
    for (let k = -1; k < SAMPLE_PTS.length; k++) {
      // The centroid itself, then each landmark pulled 30% towards it (away from silhouette edges).
      if (k < 0) tmpB.copy(centroid);
      else tmpB.copy(slot.pts[SAMPLE_PTS[k]]).sub(centroid).multiplyScalar(0.7).add(centroid);
      projTan(tmpB);
      const d = map.at(uOf(pTx), vOf(pTy));
      if (d != null && Math.abs(d - lifted) < DEPTH_LIFT_TOLERANCE) samples[n++] = d;
    }
    if (n < 3) return 0;
    // Median (n <= 6, insertion sort in place).
    for (let i = 1; i < n; i++) {
      const v = samples[i];
      let j = i - 1;
      while (j >= 0 && samples[j] > v) { samples[j + 1] = samples[j]; j--; }
      samples[j + 1] = v;
    }
    const surface = n & 1 ? samples[n >> 1] : 0.5 * (samples[(n >> 1) - 1] + samples[n >> 1]);
    const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, (surface + DEPTH_PALM_HALF_THICK) / lifted));
    for (let i = 0; i < 21; i++) {
      slot.pts[i].sub(camOrigin).multiplyScalar(ratio).add(camOrigin);
    }
    return surface;
  }

  /** Builds the forearm depth-band grid behind the wrist (slot.armOn tells whether it is usable). */
  function buildArm(slot: Slot, surface: number) {
    slot.armOn = false;
    slot.arm.visible = false;
    const map = cam!.depthMap!;
    projTan(slot.pts[0]);
    const wx = pTx, wy = pTy;
    projTan(slot.pts[9]);
    let ax = wx - pTx, ay = wy - pTy;
    const span = Math.hypot(ax, ay);
    if (!(span > 1e-4)) return;
    ax /= span; ay /= span;
    projTan(slot.pts[5]);
    const x5 = pTx, y5 = pTy;
    projTan(slot.pts[17]);
    const width = Math.hypot(x5 - pTx, y5 - pTy) * 0.7;
    const length = span * 0.9;
    if (length * width * surface * surface > ARM_MAX_AREA) return;
    const cx = -ay, cy = ax;
    const arr = slot.armPos.array as Float32Array;
    const N1 = ARM_N + 1;
    for (let gi = 0; gi < N1; gi++) {
      const s = span * -0.1 + (gi / ARM_N) * length;
      for (let gj = 0; gj < N1; gj++) {
        const t = (gj / ARM_N - 0.5) * width;
        const k = gi * N1 + gj;
        const u = uOf(wx + ax * s + cx * t);
        const v = vOf(wy + ay * s + cy * t);
        const d = map.at(u, v);
        const ok = d != null && Math.abs(d - surface) <= ARM_BAND;
        armOk[k] = ok ? 1 : 0;
        if (!ok) { armD[k] = 0; continue; }
        armD[k] = d!;
        cam!.ray(u, v, tmpA, dir);
        const f = dir.dot(camForward);
        if (!(f > 0.1)) { armOk[k] = 0; continue; }
        const dist = d! / f + ARM_BACK;
        arr[k * 3] = tmpA.x + dir.x * dist;
        arr[k * 3 + 1] = tmpA.y + dir.y * dist;
        arr[k * 3 + 2] = tmpA.z + dir.z * dist;
      }
    }
    const idx = slot.armIndex.array as Uint16Array;
    let count = 0;
    for (let gi = 0; gi < ARM_N; gi++) {
      for (let gj = 0; gj < ARM_N; gj++) {
        const a = gi * N1 + gj, b = a + 1, c = a + N1, e = c + 1;
        if (!(armOk[a] && armOk[b] && armOk[c] && armOk[e])) continue;
        const lo = Math.min(armD[a], armD[b], armD[c], armD[e]);
        const hi = Math.max(armD[a], armD[b], armD[c], armD[e]);
        if (hi - lo > ARM_STEP) continue;
        idx[count++] = a; idx[count++] = c; idx[count++] = b;
        idx[count++] = b; idx[count++] = c; idx[count++] = e;
      }
    }
    if (count / 6 < ARM_MIN_KEPT * ARM_N * ARM_N) return;
    slot.armPos.needsUpdate = true;
    slot.armIndex.needsUpdate = true;
    slot.arm.geometry.setDrawRange(0, count);
    slot.armOn = true;
  }

  function copyHand(slot: Slot, h: PerceivedHand) {
    // Fresh detection: the age dropped (or this slot was just claimed for a different hand).
    const fresh = slot.id !== h.id || slot.since === Infinity || h.age < slot.lastAge - 1e-4 || h.age < 1e-4;
    slot.lastAge = h.age;
    slot.dist = h.distance;
    slot.since = h.age;
    if (!fresh) return;
    // Light smoothing of near-static hands only (a moving hand would lag).
    let w = 0;
    if (slot.id === h.id) {
      const speed = h.velocity.length();
      if (h.points[9].distanceTo(slot.pts[9]) < 0.05 && speed < 0.25) w = SMOOTH_MAX * (1 - speed / 0.25);
    }
    for (let i = 0; i < 21; i++) {
      if (w > 0) slot.pts[i].lerp(h.points[i], 1 - w);
      else slot.pts[i].copy(h.points[i]);
    }
    slot.vel.copy(h.velocity);
    slot.id = h.id;
    slot.armOn = false;
    slot.arm.visible = false;
    if (cam && camAge < DEPTH_CAM_MAX_AGE && h.age < 0.1) {
      try {
        const surface = refineDepth(slot);
        if (surface > 0) buildArm(slot, surface);
      } catch {
        slot.armOn = false;
      }
    }
  }

  function pose(slot: Slot) {
    const speed = slot.vel.length();
    const damp = Math.min(1, Math.max(0, (speed - 0.03) / 0.12));
    const lead = Math.min(slot.since + LEAD_BASE, LEAD_MAX) * damp;
    for (let i = 0; i < 21; i++) P[i].copy(slot.pts[i]).addScaledVector(slot.vel, lead);

    // Dimensions follow the detected hand size.
    const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, P[0].distanceTo(P[9]) / HAND_SPAN));

    for (let b = 0; b < HAND_BONES.length; b++) {
      const a = P[HAND_BONES[b][0]];
      const c = P[HAND_BONES[b][1]];
      dir.subVectors(c, a);
      const len = dir.length();
      const r = BONE_RADII[b] * scale;
      if (len > 1e-6) quat.setFromUnitVectors(Y, dir.divideScalar(len));
      else quat.identity();
      tmpA.addVectors(a, c).multiplyScalar(0.5);
      scl.set(r, Math.max(len, 1e-6), r);
      mat.compose(tmpA, quat, scl);
      slot.bones.setMatrixAt(b, mat);
    }
    slot.bones.instanceMatrix.needsUpdate = true;

    quat.identity();
    for (let i = 0; i < 21; i++) {
      const r = JOINT_RADII[i] * scale;
      scl.set(r, r, r);
      mat.compose(P[i], quat, scl);
      slot.joints.setMatrixAt(i, mat);
    }
    slot.joints.instanceMatrix.needsUpdate = true;

    // Palm slab.
    centroid.set(0, 0, 0);
    for (let k = 0; k < PALM_RING.length; k++) centroid.add(P[PALM_RING[k]]);
    centroid.multiplyScalar(1 / PALM_RING.length);
    tmpA.subVectors(P[5], P[0]);
    tmpB.subVectors(P[17], P[0]);
    normal.crossVectors(tmpA, tmpB);
    if (normal.lengthSq() > 1e-12) normal.normalize();
    else normal.set(0, 0, 0);
    const arr = slot.palmPos.array as Float32Array;
    for (let k = 0; k < PALM_RING.length; k++) {
      tmpA.copy(P[PALM_RING[k]]);
      dir.subVectors(tmpA, centroid);
      const d = dir.length();
      if (d > 1e-6) tmpA.addScaledVector(dir, (PALM_GROW * scale) / d);
      const half = PALM_HALF_THICK[k] * BIAS * scale;
      tmpB.copy(tmpA).addScaledVector(normal, half);
      arr[k * 3] = tmpB.x; arr[k * 3 + 1] = tmpB.y; arr[k * 3 + 2] = tmpB.z;
      tmpB.copy(tmpA).addScaledVector(normal, -half);
      const o = (k + 6) * 3;
      arr[o] = tmpB.x; arr[o + 1] = tmpB.y; arr[o + 2] = tmpB.z;
    }
    slot.palmPos.needsUpdate = true;

    slot.arm.visible = slot.armOn;
    if (slot.armOn) {
      // The grid is in world space at detection time: carry it along with the same prediction.
      slot.arm.matrix.makeTranslation(slot.vel.x * lead, slot.vel.y * lead, slot.vel.z * lead);
      slot.arm.matrixWorldNeedsUpdate = true;
    }
  }

  return {
    setCamera,
    update(dt, hands, enabled) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      camAge += step;
      for (let s = 0; s < MAX_HANDS; s++) {
        slots[s].claimed = false;
        if (slots[s].since !== Infinity) slots[s].since += step;
      }
      // 1) Hands whose id already owns a slot.
      for (let i = 0; i < hands.length; i++) {
        const h = hands[i];
        if (!h || h.points.length < 21 || !(h.age < LOST_AFTER)) continue;
        for (let s = 0; s < MAX_HANDS; s++) {
          const slot = slots[s];
          if (!slot.claimed && slot.id === h.id && slot.since !== Infinity) {
            copyHand(slot, h);
            slot.claimed = true;
            break;
          }
        }
      }
      // 2) New hands (nearest first: the user's own hand beats bystanders) take a free slot, else
      // the stalest unclaimed one; a hand near the camera may displace a claimed, far hand.
      const order = hands.map((_h, i) => i).sort((a, b) => (hands[a]?.distance ?? Infinity) - (hands[b]?.distance ?? Infinity));
      for (const i of order) {
        const h = hands[i];
        if (!h || h.points.length < 21 || !(h.age < LOST_AFTER)) continue;
        let owned = false;
        for (let s = 0; s < MAX_HANDS; s++) if (slots[s].claimed && slots[s].id === h.id) owned = true;
        if (owned) continue;
        let best = -1;
        for (let s = 0; s < MAX_HANDS; s++) {
          if (slots[s].claimed) continue;
          if (best < 0 || slots[s].since > slots[best].since) best = s;
        }
        if (best < 0 && h.nearCamera) {
          for (let s = 0; s < MAX_HANDS; s++) {
            if (slots[s].dist > h.distance + EVICT_MARGIN && (best < 0 || slots[s].dist > slots[best].dist)) best = s;
          }
        }
        if (best < 0) continue; // nearest first: the rest are even farther
        slots[best].id = -1; // a reused slot never smooths against another hand's points
        copyHand(slots[best], h);
        slots[best].claimed = true;
      }
      // 3) Show / hide.
      for (let s = 0; s < MAX_HANDS; s++) {
        const slot = slots[s];
        if (slot.since !== Infinity && slot.since >= LOST_AFTER) {
          slot.since = Infinity;
          slot.id = -1;
          slot.armOn = false;
        }
        const show = enabled && slot.since < LOST_AFTER;
        slot.group.visible = show;
        if (show) pose(slot);
      }
    },
    dispose() {
      for (const slot of slots) {
        scene.remove(slot.group);
        slot.bones.dispose();
        slot.joints.dispose();
        slot.palm.geometry.dispose();
        slot.arm.geometry.dispose();
      }
      cylGeo.dispose();
      sphGeo.dispose();
      material.dispose();
      palmMaterial.dispose();
      cam = null;
    },
  };
}
