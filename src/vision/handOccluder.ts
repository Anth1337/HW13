import * as THREE from "three";
import type { HandOccluder, PerceivedHand } from "./types";

/*
 * Depth-only hand proxy so the virtual dog is hidden behind the user's real hand.
 *
 * Per hand slot (max 2) a Group with:
 *   - one InstancedMesh of unit cylinders (one instance per bone, scaled (r, length, r)),
 *   - one InstancedMesh of unit spheres (one per landmark, radius = thickest adjoining bone),
 *     which together form exact capsules along the bones,
 *   - a palm slab: the convex polygon 0-1-5-9-13-17 (grown 8 mm outward) extruded ±1.5 cm along
 *     the palm normal (positions rewritten in place each frame).
 * Material: colorWrite false, depthWrite true, depthTest true; renderOrder -10 so the proxy fills
 * the depth buffer before the (opaque, renderOrder 0) dog draws and the dog fails the depth test
 * where the hand is in front of it. Note: the proxy must sit in the SAME scene that renders the
 * dog; nothing else is needed (the camera feed is the XR compositor background).
 *
 * Latency compensation: every point is shifted by velocity × min(age + 0.05, 0.2) s.
 * A hand slot is hidden once it has not been detected for 0.25 s.
 * update() allocates nothing (pre-allocated temporaries, index loops only).
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
const INFLATE = 1.25;
const R_THUMB = 0.0125;
const R_PALM = 0.013;
const R_FINGER = 0.011;
/** Per-bone radius in meters (already inflated). */
export const BONE_RADII: readonly number[] = HAND_BONES.map(([a, b]) => {
  const palm = (a === 0 && b !== 1) || (a === 5 && b === 9) || (a === 9 && b === 13) || (a === 13 && b === 17);
  if (palm) return R_PALM * INFLATE;
  if (b <= 4) return R_THUMB * INFLATE;
  return R_FINGER * INFLATE;
});
const JOINT_RADII: number[] = new Array(21).fill(0);
HAND_BONES.forEach(([a, b], i) => {
  JOINT_RADII[a] = Math.max(JOINT_RADII[a], BONE_RADII[i]);
  JOINT_RADII[b] = Math.max(JOINT_RADII[b], BONE_RADII[i]);
});

const PALM_RING = [0, 1, 5, 9, 13, 17] as const;
const PALM_HALF_THICK = 0.015;
const PALM_GROW = 0.008;
const LOST_AFTER = 0.25;
const PREDICT_LEAD = 0.05;
const PREDICT_MAX = 0.2;
const MAX_HANDS = 2;

interface Slot {
  group: THREE.Group;
  bones: THREE.InstancedMesh;
  joints: THREE.InstancedMesh;
  palm: THREE.Mesh;
  palmPos: THREE.BufferAttribute;
  /** Last detected points + velocity (copied, so prediction works after the hand is gone). */
  pts: THREE.Vector3[];
  vel: THREE.Vector3;
  id: number;
  /** Seconds since last detection; Infinity = free. */
  since: number;
  /** Assigned during the current update. */
  claimed: boolean;
}

export function createHandOccluder(scene: THREE.Scene): HandOccluder {
  const material = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
  });
  const palmMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  // Unit cylinder along +Y, height 1 (−0.5..0.5), radius 1; open-ended (spheres cap it).
  const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  const sphGeo = new THREE.SphereGeometry(1, 10, 8);

  // Palm slab topology: ring vertices 0..5 on the + side, 6..11 on the − side.
  const palmIndex: number[] = [];
  for (let i = 1; i < 5; i++) {
    palmIndex.push(0, i, i + 1); // top fan
    palmIndex.push(6, 6 + i + 1, 6 + i); // bottom fan
  }
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    palmIndex.push(i, 6 + i, j, j, 6 + i, 6 + j);
  }

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
    for (const m of [bones, joints, palm]) {
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
    slots.push({ group, bones, joints, palm, palmPos, pts, vel: new THREE.Vector3(), id: -1, since: Infinity, claimed: false });
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

  function copyHand(slot: Slot, h: PerceivedHand) {
    for (let i = 0; i < 21; i++) slot.pts[i].copy(h.points[i]);
    slot.vel.copy(h.velocity);
    slot.id = h.id;
    slot.since = h.age;
  }

  function pose(slot: Slot) {
    const lead = Math.min(slot.since + PREDICT_LEAD, PREDICT_MAX);
    for (let i = 0; i < 21; i++) P[i].copy(slot.pts[i]).addScaledVector(slot.vel, lead);

    for (let b = 0; b < HAND_BONES.length; b++) {
      const a = P[HAND_BONES[b][0]];
      const c = P[HAND_BONES[b][1]];
      dir.subVectors(c, a);
      const len = dir.length();
      const r = BONE_RADII[b];
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
      const r = JOINT_RADII[i];
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
      if (d > 1e-6) tmpA.addScaledVector(dir, PALM_GROW / d);
      tmpB.copy(tmpA).addScaledVector(normal, PALM_HALF_THICK);
      arr[k * 3] = tmpB.x; arr[k * 3 + 1] = tmpB.y; arr[k * 3 + 2] = tmpB.z;
      tmpB.copy(tmpA).addScaledVector(normal, -PALM_HALF_THICK);
      const o = (k + 6) * 3;
      arr[o] = tmpB.x; arr[o + 1] = tmpB.y; arr[o + 2] = tmpB.z;
    }
    slot.palmPos.needsUpdate = true;
  }

  return {
    update(dt, hands, enabled) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
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
      // 2) New hands take a free slot, else the stalest unclaimed one.
      for (let i = 0; i < hands.length; i++) {
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
        if (best < 0) break;
        copyHand(slots[best], h);
        slots[best].claimed = true;
      }
      // 3) Show / hide.
      for (let s = 0; s < MAX_HANDS; s++) {
        const slot = slots[s];
        if (slot.since !== Infinity && slot.since >= LOST_AFTER) {
          slot.since = Infinity;
          slot.id = -1;
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
      }
      cylGeo.dispose();
      sphGeo.dispose();
      material.dispose();
      palmMaterial.dispose();
    },
  };
}
