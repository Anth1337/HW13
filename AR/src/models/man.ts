import * as THREE from "three";
import type { Character, ModelInfo } from "./types";

/*
 * A stylized adult man, ~1.78 m tall, built from primitives with flat colours.
 *
 * Joint hierarchy (every joint is a THREE.Group so rotations pivot naturally):
 *   root (ground, between the feet, faces +Z)
 *   └─ hips ─┬─ hipL / hipR ─ kneeL / kneeR ─ ankleL / ankleR (shoe)
 *            └─ spine ─ chest ─┬─ chestShape (breathing scale only)
 *                              ├─ shoulderL / shoulderR ─ elbow ─ wrist (hand)
 *                              └─ neck ─ head ─ eyes
 *
 * The legs are solved with a tiny two-bone IK every frame, so the hips can shift
 * their weight while the feet stay planted exactly where they are.
 */

// ---- Dimensions (meters) -------------------------------------------------------------

const THIGH = 0.43;
const SHIN = 0.43;
const ANKLE_Y = 0.08; // ankle joint height above the ground (shoe height)
const HIP_X = 0.09; // half distance between hip joints / feet
const HIPS_Y = 0.935; // slightly under THIGH + SHIN + ANKLE_Y, so the knees are softly bent
const SHOULDER_X = 0.2;
const UPPER_ARM = 0.3;
const FOREARM = 0.27;
const HEIGHT = 1.78;

// ---- Shared materials -----------------------------------------------------------------

function flat(color: number, roughness = 0.8): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
}

const skinMat = flat(0xd9a27e, 0.75);
const hairMat = flat(0x3a2a1d, 0.9);
const shirtMat = flat(0x3a78c2, 0.8);
const trousersMat = flat(0x3b404a, 0.85);
const beltMat = flat(0x2b1d14, 0.6);
const shoeMat = flat(0x5a3820, 0.65);
const soleMat = flat(0x2a2a2a, 0.9);
const eyeMat = flat(0x1b1b1b, 0.6);
const lipMat = flat(0xa8655a, 0.8);

// ---- Shared geometries ----------------------------------------------------------------

/** A capsule whose overall length (caps included) is `total`, centred on its origin. */
function capsule(radius: number, total: number, radial = 12): THREE.CapsuleGeometry {
  return new THREE.CapsuleGeometry(radius, Math.max(total - 2 * radius, 0.001), 4, radial);
}

// Torso
const pelvisGeo = new THREE.CylinderGeometry(0.155, 0.16, 0.18, 16).scale(1, 1, 0.7);
const beltGeo = new THREE.CylinderGeometry(0.162, 0.162, 0.035, 16).scale(1, 1, 0.7);
const abdomenGeo = new THREE.CylinderGeometry(0.17, 0.155, 0.2, 16).scale(1, 1, 0.68);
const chestGeo = new THREE.CylinderGeometry(0.215, 0.17, 0.22, 16).scale(1, 1, 0.62);
const shoulderDomeGeo = new THREE.SphereGeometry(0.215, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.33, 0.62);
const collarGeo = new THREE.CylinderGeometry(0.058, 0.062, 0.03, 12);

// Legs
const thighGeo = capsule(0.07, THIGH + 0.05);
const shinGeo = capsule(0.056, SHIN + 0.04);
const shoeGeo = new THREE.BoxGeometry(0.11, 0.065, 0.25);
const toeGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.065, 12, 1, false, -Math.PI / 2, Math.PI);
const soleGeo = new THREE.BoxGeometry(0.115, 0.02, 0.29);

// Arms
const deltoidGeo = new THREE.SphereGeometry(0.066, 12, 10);
const sleeveGeo = new THREE.CylinderGeometry(0.064, 0.058, 0.16, 12);
const upperArmGeo = capsule(0.045, UPPER_ARM + 0.04);
const forearmGeo = capsule(0.04, FOREARM + 0.03);
const handGeo = new THREE.SphereGeometry(0.05, 12, 10).scale(0.62, 1.35, 1);
const thumbGeo = capsule(0.016, 0.07, 8);

// Head
const neckGeo = new THREE.CylinderGeometry(0.05, 0.055, 0.11, 12);
const HEAD_R = 0.11;
const HEAD_SCALE = new THREE.Vector3(0.92, 1.1, 1.0);
const HEAD_Y = 0.11; // head centre above the head joint
const headGeo = new THREE.SphereGeometry(HEAD_R, 20, 16).scale(HEAD_SCALE.x, HEAD_SCALE.y, HEAD_SCALE.z);
// Short hair: an upper cap slightly larger than the head, tilted back to cover the back of the skull.
const hairGeo = new THREE.SphereGeometry(HEAD_R + 0.008, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(
  HEAD_SCALE.x,
  HEAD_SCALE.y,
  HEAD_SCALE.z,
);
const hairBackGeo = new THREE.SphereGeometry(HEAD_R + 0.006, 16, 8, Math.PI * 1.12, Math.PI * 0.76, Math.PI * 0.3, Math.PI * 0.35).scale(
  HEAD_SCALE.x,
  HEAD_SCALE.y,
  HEAD_SCALE.z,
);
const earGeo = new THREE.SphereGeometry(0.026, 10, 8).scale(0.45, 1, 0.75);
const noseGeo = new THREE.ConeGeometry(0.018, 0.045, 10).rotateX(Math.PI / 2 + 0.35);
const eyeGeo = new THREE.SphereGeometry(0.013, 10, 8);
const browGeo = new THREE.BoxGeometry(0.038, 0.009, 0.012);
const mouthGeo = new THREE.BoxGeometry(0.04, 0.008, 0.01);

// ---- Helpers ----------------------------------------------------------------------------

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function joint(parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

interface Leg {
  side: number; // -1 right, +1 left (character's left is +X when facing +Z)
  hip: THREE.Group;
  knee: THREE.Group;
  ankle: THREE.Group;
}

function buildLeg(hips: THREE.Group, side: number): Leg {
  const hip = joint(hips, side * HIP_X, 0, 0);
  hip.rotation.order = "ZYX"; // pitch first, then roll the whole leg plane sideways
  addMesh(hip, thighGeo, trousersMat, 0, -THIGH / 2 + 0.01, 0);

  const knee = joint(hip, 0, -THIGH, 0);
  addMesh(knee, shinGeo, trousersMat, 0, -SHIN / 2 + 0.01, 0);

  const ankle = joint(knee, 0, -SHIN, 0);
  // Shoe: sole on the ground (ankle local y = -ANKLE_Y), toe pointing +Z.
  addMesh(ankle, soleGeo, soleMat, 0, -ANKLE_Y + 0.01, 0.045);
  addMesh(ankle, shoeGeo, shoeMat, 0, -ANKLE_Y + 0.02 + 0.0325, 0.02);
  addMesh(ankle, toeGeo, shoeMat, 0, -ANKLE_Y + 0.02 + 0.0325, 0.145);
  return { side, hip, knee, ankle };
}

interface Arm {
  side: number;
  shoulder: THREE.Group;
  elbow: THREE.Group;
  wrist: THREE.Group;
}

function buildArm(chest: THREE.Group, side: number): Arm {
  const shoulder = joint(chest, side * SHOULDER_X, 0.2, 0);
  addMesh(shoulder, deltoidGeo, shirtMat, 0, -0.01, 0);
  addMesh(shoulder, sleeveGeo, shirtMat, 0, -0.08, 0);
  addMesh(shoulder, upperArmGeo, skinMat, 0, -UPPER_ARM / 2 + 0.005, 0);

  const elbow = joint(shoulder, 0, -UPPER_ARM, 0);
  addMesh(elbow, forearmGeo, skinMat, 0, -FOREARM / 2 + 0.005, 0);

  const wrist = joint(elbow, 0, -FOREARM, 0);
  const hand = addMesh(wrist, handGeo, skinMat, 0, -0.06, 0.005);
  hand.rotation.y = side * 0.15;
  const thumb = addMesh(wrist, thumbGeo, skinMat, -side * 0.012, -0.035, 0.035);
  thumb.rotation.x = 0.35;
  return { side, shoulder, elbow, wrist };
}

// Scratch objects for the per-frame leg IK (module scope, no per-frame allocation).
const _target = new THREE.Vector3();
const _local = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);

// ---- Model ------------------------------------------------------------------------------

function createMan(): Character {
  const root = new THREE.Group();
  root.name = "man";

  const hips = joint(root, 0, HIPS_Y, 0);
  addMesh(hips, pelvisGeo, trousersMat, 0, 0, 0);
  addMesh(hips, beltGeo, beltMat, 0, 0.075, 0);

  const legs = [buildLeg(hips, 1), buildLeg(hips, -1)];

  const spine = joint(hips, 0, 0.07, 0);
  addMesh(spine, abdomenGeo, shirtMat, 0, 0.08, 0);

  const chest = joint(spine, 0, 0.17, 0);
  const chestShape = joint(chest);
  addMesh(chestShape, chestGeo, shirtMat, 0, 0.11, 0);
  addMesh(chestShape, shoulderDomeGeo, shirtMat, 0, 0.22, 0);
  addMesh(chestShape, collarGeo, shirtMat, 0, 0.285, 0.0);

  const arms = [buildArm(chest, 1), buildArm(chest, -1)];

  const NECK_Y = 0.29;
  const neck = joint(chest, 0, NECK_Y, 0);
  addMesh(neck, neckGeo, skinMat, 0, 0.03, 0);

  const head = joint(neck, 0, 0.08, 0);
  addMesh(head, headGeo, skinMat, 0, HEAD_Y, 0);
  const hair = addMesh(head, hairGeo, hairMat, 0, HEAD_Y + 0.004, -0.006);
  hair.rotation.x = -0.55; // tilt back: hairline ~6.5 cm above head centre (brows on skin), covers the crown and back
  addMesh(head, hairBackGeo, hairMat, 0, HEAD_Y, 0);
  for (const s of [1, -1]) {
    addMesh(head, earGeo, skinMat, s * HEAD_R * HEAD_SCALE.x, HEAD_Y, -0.005);
  }
  addMesh(head, noseGeo, skinMat, 0, HEAD_Y - 0.005, HEAD_R * HEAD_SCALE.z + 0.01);
  addMesh(head, mouthGeo, lipMat, 0, HEAD_Y - 0.05, 0.101); // front face just proud of the skin

  // Eyes in their own group so a blink is a single scale.y.
  const eyes = joint(head, 0, HEAD_Y + 0.018, 0);
  for (const s of [1, -1]) {
    addMesh(eyes, eyeGeo, eyeMat, s * 0.036, 0, 0.096);
    const brow = addMesh(head, browGeo, hairMat, s * 0.038, HEAD_Y + 0.045, 0.094);
    brow.rotation.z = s * -0.12;
    brow.rotation.y = s * 0.25;
  }

  // Per-instance variation so several men never move in lockstep.
  const phase = Math.random() * 100;
  const rate = 0.92 + Math.random() * 0.16;
  const blinkPeriod = 3.4 + Math.random() * 2.2;
  const TAU = Math.PI * 2;

  function update(time: number): void {
    const t = time * rate + phase;
    const wave = (freq: number, offset = 0) => Math.sin(TAU * freq * t + offset);

    // Breathing (~13 breaths/min).
    const breath = wave(0.22);
    chestShape.scale.set(1 + 0.012 * breath, 1 + 0.012 * breath, 1 + 0.025 * breath);
    chest.rotation.x = -0.012 * breath;

    // Slow weight shift from foot to foot, with a little hip drop and counter-lean.
    const w = 0.8 * wave(0.061) + 0.2 * wave(0.149, 1.3);
    const hipShift = 0.02 * w;
    const hipDrop = 0.004 + 0.003 * Math.abs(w);
    const hipRoll = -0.035 * w;
    hips.position.set(hipShift, HIPS_Y - hipDrop, 0);
    hips.rotation.set(0, 0, hipRoll);
    spine.rotation.set(0.01 * wave(0.11, 2), 0.04 * wave(0.047, 0.7), -hipRoll * 1.25 - 0.012 * w);

    // Two-bone IK per leg: ankles stay fixed at (±HIP_X, ANKLE_Y, 0) in root space.
    for (const leg of legs) {
      _target.set(leg.side * HIP_X, ANKLE_Y, 0);
      // Into hips space (hips only translate + roll about Z).
      _local.copy(_target).sub(hips.position).applyAxisAngle(_zAxis, -hipRoll);
      const vx = _local.x - leg.hip.position.x;
      const vy = _local.y - leg.hip.position.y;
      const d = Math.min(Math.hypot(vx, vy), THIGH + SHIN - 1e-4);
      const roll = Math.atan2(vx, -vy);
      const bend = Math.acos(d / (THIGH + SHIN)); // thigh/shin are equal length
      leg.hip.rotation.set(-bend, 0, roll); // knee forward (+Z)
      leg.knee.rotation.set(2 * bend, 0, 0);
      leg.ankle.rotation.set(-bend, 0, -roll - hipRoll); // keep the sole flat on the ground
    }

    // Arms hang with a gentle, slightly asymmetric swing; shoulders rise a touch on inhale.
    for (const arm of arms) {
      const o = arm.side > 0 ? 0 : 2.1;
      arm.shoulder.position.y = 0.2 + 0.004 * breath;
      arm.shoulder.rotation.set(
        0.04 * wave(0.13, o) + 0.02 * w * arm.side,
        0.05 * arm.side,
        arm.side * (0.085 + 0.008 * breath) - spine.rotation.z * 0.6,
      );
      arm.elbow.rotation.set(-0.14 - 0.04 * wave(0.17, o + 1), 0, 0);
      arm.wrist.rotation.set(-0.05 + 0.04 * wave(0.21, o + 2), 0, arm.side * 0.04);
    }

    // Head: mostly forward, occasionally turning to look around, with a little tilt.
    const look = wave(0.043, 0.5);
    const yaw = 0.38 * look * look * look + 0.06 * wave(0.19, 1.1);
    neck.position.y = NECK_Y + 0.003 * breath;
    neck.rotation.set(0.015 * breath, yaw * 0.35, -spine.rotation.z * 0.5);
    head.rotation.set(0.04 * wave(0.071, 3) - 0.02, yaw * 0.65, 0.05 * wave(0.053, 0.2));

    // Blink: a quick 0.16 s close/open once per blink period.
    const u = (((time + phase) % blinkPeriod) + blinkPeriod) % blinkPeriod;
    eyes.scale.y = u < 0.16 ? 1 - 0.9 * Math.sin((Math.PI * u) / 0.16) : 1;
  }

  update(0);
  return { root, update };
}

export const manModel: ModelInfo = {
  id: "man",
  label: "Man",
  height: HEIGHT,
  create: createMan,
};
