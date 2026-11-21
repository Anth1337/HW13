import * as THREE from "three";
import type { Character, ModelInfo } from "./types";

// ---------------------------------------------------------------------------
// Shared materials (flat colours, no textures)
// ---------------------------------------------------------------------------
const mat = (color: number, roughness = 0.75) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });

const SKIN = mat(0xe0ac85, 0.7);
const HAIR = mat(0x5a3420, 0.85);
const BLOUSE = mat(0x2f8f83, 0.8);
const SKIRT = mat(0x6b3a7a, 0.8);
const BELT = mat(0x2b2b2b, 0.6);
const SHOE = mat(0x3a2626, 0.6);
const EYE = mat(0x1e1e1e, 0.6);
const LIPS = mat(0xb5485a, 0.7);

// ---------------------------------------------------------------------------
// Shared geometries
// ---------------------------------------------------------------------------
// Legs
const THIGH_LEN = 0.41;
const SHIN_LEN = 0.39;
const HIP_Y = 0.9; // hips group height (world)
const HIP_JOINT_Y = -0.03; // leg sockets relative to hips
const ANKLE_Y = 0.07; // world height of ankle joints
const LEG_X = 0.085; // leg sockets / feet either side of the centre

const thighGeo = new THREE.CapsuleGeometry(0.062, THIGH_LEN - 0.03, 6, 16);
const shinGeo = new THREE.CapsuleGeometry(0.046, SHIN_LEN - 0.04, 6, 16);
const shoeGeo = new THREE.BoxGeometry(0.085, 0.075, 0.23);
const toeGeo = new THREE.CylinderGeometry(0.0425, 0.0425, 0.075, 16, 1, false, -Math.PI / 2, Math.PI);

// Hips / skirt
const skirtGeo = new THREE.CylinderGeometry(0.145, 0.25, 0.4, 24);
const beltGeo = new THREE.CylinderGeometry(0.148, 0.148, 0.04, 24);

// Torso
const waistGeo = new THREE.CylinderGeometry(0.13, 0.145, 0.2, 20);
const chestGeo = new THREE.CylinderGeometry(0.165, 0.135, 0.22, 20);
const shoulderCapGeo = new THREE.SphereGeometry(0.165, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
const bustGeo = new THREE.SphereGeometry(0.055, 14, 10);

// Arms
const UPPER_ARM_LEN = 0.27;
const FOREARM_LEN = 0.24;
const shoulderBallGeo = new THREE.SphereGeometry(0.05, 14, 10);
const upperArmGeo = new THREE.CapsuleGeometry(0.044, UPPER_ARM_LEN - 0.05, 6, 14);
const forearmGeo = new THREE.CapsuleGeometry(0.036, FOREARM_LEN - 0.04, 6, 14);
const handGeo = new THREE.SphereGeometry(0.042, 14, 10);

// Neck / head
const neckGeo = new THREE.CylinderGeometry(0.042, 0.048, 0.11, 14);
const headGeo = new THREE.SphereGeometry(0.105, 20, 16);
// Hair cap: spherical cap tilted back so the hairline sits high on the forehead
// and low at the nape.
const HAIR_THETA = 1.7;
const HAIR_TILT = -0.74;
const hairCapGeo = new THREE.SphereGeometry(0.113, 20, 14, 0, Math.PI * 2, 0, HAIR_THETA);
const hairTieGeo = new THREE.SphereGeometry(0.026, 12, 8);
const ponytailGeo = new THREE.CapsuleGeometry(0.038, 0.13, 6, 14);
const eyeGeo = new THREE.SphereGeometry(0.0135, 10, 8);
const noseGeo = new THREE.SphereGeometry(0.014, 10, 8);
const lipsGeo = new THREE.CapsuleGeometry(0.008, 0.026, 4, 8);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mesh(
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  parent: THREE.Object3D,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function joint(parent: THREE.Object3D, x: number, y: number, z: number, name: string): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

interface Leg {
  side: 1 | -1;
  hip: THREE.Group;
  knee: THREE.Group;
  ankle: THREE.Group;
}

function buildLeg(hips: THREE.Group, side: 1 | -1): Leg {
  const hip = joint(hips, LEG_X * side, HIP_JOINT_Y, 0, side > 0 ? "hipL" : "hipR");
  hip.rotation.order = "ZYX"; // pitch first, then roll the whole leg plane sideways
  mesh(thighGeo, SKIN, hip, 0, -THIGH_LEN / 2, 0);

  const knee = joint(hip, 0, -THIGH_LEN, 0, side > 0 ? "kneeL" : "kneeR");
  mesh(shinGeo, SKIN, knee, 0, -SHIN_LEN / 2 - 0.01, 0);

  const ankle = joint(knee, 0, -SHIN_LEN, 0, side > 0 ? "ankleL" : "ankleR");
  // Shoe: box with a rounded toe; sole exactly at the ankle-local -ANKLE_Y (world y = 0).
  const shoeY = -ANKLE_Y + 0.0375;
  mesh(shoeGeo, SHOE, ankle, 0, shoeY, 0.03);
  mesh(toeGeo, SHOE, ankle, 0, shoeY, 0.145);
  return { side, hip, knee, ankle };
}

interface Arm {
  shoulder: THREE.Group;
  elbow: THREE.Group;
  wrist: THREE.Group;
}

function buildArm(chest: THREE.Group, side: 1 | -1): Arm {
  const shoulder = joint(chest, 0.185 * side, 0.2, 0, side > 0 ? "shoulderL" : "shoulderR");
  mesh(shoulderBallGeo, BLOUSE, shoulder);
  mesh(upperArmGeo, BLOUSE, shoulder, 0, -UPPER_ARM_LEN / 2, 0);

  const elbow = joint(shoulder, 0, -UPPER_ARM_LEN, 0, side > 0 ? "elbowL" : "elbowR");
  mesh(forearmGeo, SKIN, elbow, 0, -FOREARM_LEN / 2, 0);

  const wrist = joint(elbow, 0, -FOREARM_LEN, 0, side > 0 ? "wristL" : "wristR");
  const hand = mesh(handGeo, SKIN, wrist, 0, -0.04, 0.005);
  hand.scale.set(0.7, 1.35, 1.0);
  return { shoulder, elbow, wrist };
}

// Scratch objects for the per-frame leg IK (module scope, no per-frame allocation).
const _target = new THREE.Vector3();
const _local = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createWoman(): Character {
  const root = new THREE.Group();
  root.name = "woman";

  // --- Hips (pelvis) ---------------------------------------------------------
  const hips = joint(root, 0, HIP_Y, 0, "hips");
  const skirt = mesh(skirtGeo, SKIRT, hips, 0, -0.14, 0);
  skirt.scale.z = 0.85;
  const belt = mesh(beltGeo, BELT, hips, 0, 0.06, 0);
  belt.scale.z = 0.8;
  const legs = [buildLeg(hips, 1), buildLeg(hips, -1)];

  // --- Spine / chest ---------------------------------------------------------
  const spine = joint(hips, 0, 0.06, 0, "spine");
  const waist = mesh(waistGeo, BLOUSE, spine, 0, 0.09, 0);
  waist.scale.z = 0.75;

  const chest = joint(spine, 0, 0.18, 0, "chest");
  const chestBody = new THREE.Group(); // breathing scales this, not the arm/neck joints
  chest.add(chestBody);
  const torso = mesh(chestGeo, BLOUSE, chestBody, 0, 0.11, 0);
  torso.scale.z = 0.72;
  const cap = mesh(shoulderCapGeo, BLOUSE, chestBody, 0, 0.2, 0);
  cap.scale.set(1.0, 0.3, 0.72);
  mesh(bustGeo, BLOUSE, chestBody, 0.06, 0.1, 0.065).scale.set(1, 0.9, 0.9);
  mesh(bustGeo, BLOUSE, chestBody, -0.06, 0.1, 0.065).scale.set(1, 0.9, 0.9);

  const armL = buildArm(chest, 1);
  const armR = buildArm(chest, -1);

  // --- Neck / head -----------------------------------------------------------
  const neck = joint(chest, 0, 0.21, 0, "neck");
  mesh(neckGeo, SKIN, neck, 0, 0.04, 0);

  const head = joint(neck, 0, 0.08, 0, "head");
  const skull = mesh(headGeo, SKIN, head, 0, 0.1, 0);
  skull.scale.set(0.9, 1.1, 0.95);

  const hair = mesh(hairCapGeo, HAIR, head, 0, 0.108, -0.008);
  hair.rotation.x = HAIR_TILT;
  hair.scale.set(0.93, 1.06, 1.0);

  const eyes: THREE.Mesh[] = [
    mesh(eyeGeo, EYE, head, 0.034, 0.11, 0.088),
    mesh(eyeGeo, EYE, head, -0.034, 0.11, 0.088),
  ];
  mesh(noseGeo, SKIN, head, 0, 0.085, 0.1);
  const lips = mesh(lipsGeo, LIPS, head, 0, 0.052, 0.09);
  lips.rotation.z = Math.PI / 2;

  // Ponytail hangs from a tie at the back of the head; its group swings.
  const tieY = 0.15;
  const tieZ = -0.112;
  mesh(hairTieGeo, HAIR, head, 0, tieY, tieZ);
  const ponytail = joint(head, 0, tieY, tieZ, "ponytail");
  const tail = mesh(ponytailGeo, HAIR, ponytail, 0, -0.1 * Math.cos(0.3), -0.1 * Math.sin(0.3));
  tail.rotation.x = 0.3;
  tail.scale.z = 0.8;

  // --- Idle animation --------------------------------------------------------
  const phase = Math.random() * 100;
  const TAU = Math.PI * 2;

  function update(time: number): void {
    const t = time + phase;

    // Breathing (~15 breaths/min)
    const breath = Math.sin(t * TAU * 0.25);
    chestBody.scale.set(1 + 0.018 * breath, 1 + 0.008 * breath, 1 + 0.03 * breath);
    chest.rotation.x = -0.012 * breath;

    // Weight shift: the pelvis shifts towards the standing leg, drops a little and rolls;
    // the upper body counter-leans so the head stays roughly over the feet.
    const sway = 0.022 * Math.sin(t * TAU * 0.071) + 0.008 * Math.sin(t * TAU * 0.173 + 1.3);
    const w = sway / 0.03; // -1..1
    hips.position.set(0.012 * w, HIP_Y - (0.006 + 0.004 * Math.abs(w)), 0);
    hips.rotation.set(0, 0, sway);
    spine.rotation.z = -sway * 1.3;
    spine.rotation.y = 0.04 * Math.sin(t * TAU * 0.053 + 0.7);
    spine.rotation.x = 0.01 * Math.sin(t * TAU * 0.091 + 2.1);

    // Two-bone IK per leg: ankles stay fixed at (+-LEG_X, ANKLE_Y, 0) in root space, so the
    // soles stay flat on the ground however the pelvis moves. Knees bend forward (+Z).
    for (const leg of legs) {
      _target.set(leg.side * LEG_X, ANKLE_Y, 0);
      // Into hips space (hips only translate + roll about Z).
      _local.copy(_target).sub(hips.position).applyAxisAngle(_zAxis, -sway);
      const vx = _local.x - leg.hip.position.x;
      const vy = _local.y - leg.hip.position.y;
      const d = Math.min(Math.hypot(vx, vy), THIGH_LEN + SHIN_LEN - 1e-4);
      const roll = Math.atan2(vx, -vy);
      // Law of cosines: thigh angle off the hip-ankle line, and shin angle off it.
      const a1 = Math.acos(Math.min(1, (THIGH_LEN ** 2 + d * d - SHIN_LEN ** 2) / (2 * THIGH_LEN * d)));
      const a2 = Math.acos(Math.min(1, (SHIN_LEN ** 2 + d * d - THIGH_LEN ** 2) / (2 * SHIN_LEN * d)));
      leg.hip.rotation.set(-a1, 0, roll); // order ZYX: pitch first, then roll the leg plane
      leg.knee.rotation.set(a1 + a2, 0, 0);
      leg.ankle.rotation.set(-a2, 0, -roll - sway); // undo all pitch and roll: sole flat
    }

    // Arms hang relaxed with a gentle swing.
    const swingL = 0.04 * Math.sin(t * TAU * 0.13 + 0.4) + 0.01 * breath;
    const swingR = 0.04 * Math.sin(t * TAU * 0.117 + 2.2) + 0.01 * breath;
    armL.shoulder.rotation.set(swingL, 0, 0.1 + 0.015 * Math.sin(t * TAU * 0.09) + 0.01 * breath);
    armR.shoulder.rotation.set(swingR, 0, -0.1 - 0.015 * Math.sin(t * TAU * 0.083 + 1) - 0.01 * breath);
    armL.elbow.rotation.x = -0.14 - 0.04 * Math.sin(t * TAU * 0.11 + 1.1);
    armR.elbow.rotation.x = -0.14 - 0.04 * Math.sin(t * TAU * 0.097 + 3.0);
    armL.wrist.rotation.z = 0.05 * Math.sin(t * TAU * 0.15);
    armR.wrist.rotation.z = -0.05 * Math.sin(t * TAU * 0.14 + 0.5);

    // Occasional look around (cubed sine dwells near centre, then turns).
    const look = Math.sin(t * TAU * 0.041 + 0.9);
    const yaw = 0.45 * look * look * look + 0.04 * Math.sin(t * TAU * 0.19);
    const tilt = 0.06 * Math.sin(t * TAU * 0.067 + 2.4);
    const nod = 0.04 * Math.sin(t * TAU * 0.081 + 0.3) - 0.01 * breath;
    neck.rotation.set(nod * 0.4, yaw * 0.35, tilt * 0.4 + sway * 0.3);
    head.rotation.set(nod * 0.6, yaw * 0.65, tilt * 0.6);

    // Ponytail lags behind head motion and sways gently.
    ponytail.rotation.x = 0.05 * Math.sin(t * TAU * 0.21 + 1.7) - nod * 0.5;
    ponytail.rotation.z = 0.06 * Math.sin(t * TAU * 0.17) - tilt * 0.5 - sway;

    // Blink roughly every 3-4 s.
    const blinkPhase = (t * 0.29) % 1;
    const blink = blinkPhase < 0.04 ? 1 - 0.9 * Math.sin((Math.PI * blinkPhase) / 0.04) : 1;
    eyes[0].scale.y = blink;
    eyes[1].scale.y = blink;
  }

  update(0);
  return { root, update };
}

export const womanModel: ModelInfo = {
  id: "woman",
  label: "Woman",
  height: 1.65,
  create: createWoman,
};
