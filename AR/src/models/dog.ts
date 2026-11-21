import * as THREE from "three";
import type { Character, ModelInfo } from "./types";
import type { DogCharacter, DogControls, DogZones, TrickKind } from "../dog/types";

/*
 * A medium, labrador-ish dog (~0.57 m tall at the head, ~0.8 m nose to tail tip),
 * built from primitives with flat colours. Faces +Z (head towards +Z).
 *
 * Joint hierarchy (every joint is a THREE.Group so rotations pivot naturally):
 *   root (ground, centred under the body, faces +Z)
 *   └─ turn (turnYaw + spin trick, about the dog's centre)
 *      └─ body ─┬─ torsoShape (breathing / squash scale only)
 *               ├─ legFL / legFR / legBL / legBR (hip) ─ knee ─ paw
 *               ├─ tailBase (wag, yaw) ─ tailPitch ─ tailTip
 *               └─ neck ─ head ─┬─ jaw ─ tongue
 *                               ├─ earL / earR
 *                               └─ eyes (+ catch-lights)
 *
 * The pose is a pure function of (t, controls) plus a per-instance phase: every frame sets
 * absolute rotations / positions. Legs are placed with a 2-bone IK towards paw targets, so the
 * paws stay planted while the body sways, wiggles, crouches or pitches. Tricks blend in and
 * out with envelopes that are exactly 0 at progress 0 and 1, so they start and end in the
 * idle pose. A final "floor guard" measures the lowest point of the posed meshes (ellipsoid /
 * capsule probes) and lifts the body if anything would go below y = 0.
 */

// ---- Dimensions (meters) -------------------------------------------------------------

const BODY_Y = 0.33; // torso centre height
const LEG_PIVOT_Y = -0.03; // shoulder / hip joints, relative to body
const LEG_X = 0.07;
const LEG_Z = 0.17;
const UPPER_LEG = 0.15;
const LOWER_LEG = 0.13;
const PAW_HALF_H = 0.02;
const PAW_FWD = 0.015; // paw centre sits slightly in front of the lower leg
const NECK_PITCH = 0.6; // forward lean of the neck
const NECK_LEN = 0.13;
const TAIL_PITCH = -1.75; // tail points back, very slightly down
const HEIGHT = 0.58;

const LIE_Y = 0.125; // torso centre height while lying / rolling (torso radius ~0.11–0.12)
const LIE_NECK = 1.2; // neck pitch while lying (head low and forward)
const ROLL_NECK = 1.95; // neck pitch while rolling (head tucked close to the roll axis)

const DEG = Math.PI / 180;
const MAX_YAW = 80 * DEG;
const MAX_PITCH_UP = 50 * DEG;
const MAX_PITCH_DOWN = 35 * DEG;
const NECK_SHARE = 0.4; // fraction of the aim done by the neck (rest by the head)

// ---- Shared materials -----------------------------------------------------------------

function flat(color: number, roughness = 0.8): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
}

const furMat = flat(0xc8923f, 0.85);
const lightFurMat = flat(0xdcb06a, 0.85);
const noseMat = flat(0x2a1d16, 0.6);
const eyeMat = flat(0x1a120e, 0.6);
const glintMat = flat(0xffffff, 0.3);
const collarMat = flat(0xc0392b, 0.7);
const tagMat = flat(0xd4b13a, 0.6);
const tongueMat = flat(0xe07a8a, 0.7);
const mouthMat = flat(0x5a2a28, 0.8);

// ---- Shared geometries ----------------------------------------------------------------

/** A capsule whose overall length (caps included) is `total`, centred, along +Y. */
function capsule(radius: number, total: number, radial = 14): THREE.CapsuleGeometry {
  return new THREE.CapsuleGeometry(radius, Math.max(total - 2 * radius, 0.001), 4, radial);
}

// Torso: capsule lying along Z, 0.54 m long.
const torsoGeo = capsule(0.11, 0.54, 18).rotateX(Math.PI / 2);
const chestGeo = new THREE.SphereGeometry(0.12, 18, 12).scale(0.95, 1, 0.9);
const rumpGeo = new THREE.SphereGeometry(0.105, 16, 12);
const bellyGeo = new THREE.SphereGeometry(0.1, 16, 10).scale(0.9, 0.6, 1.6);

// Neck & head
const neckGeo = new THREE.CylinderGeometry(0.055, 0.07, NECK_LEN + 0.02, 14);
const collarGeo = new THREE.TorusGeometry(0.068, 0.013, 8, 20).rotateX(Math.PI / 2);
const tagGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.004, 12).rotateX(Math.PI / 2);
const headGeo = new THREE.SphereGeometry(0.075, 18, 14).scale(0.9, 0.9, 1.05);
const snoutGeo = capsule(0.038, 0.13, 14).rotateX(Math.PI / 2);
const noseGeo = new THREE.SphereGeometry(0.02, 12, 8).scale(1.2, 0.85, 0.9);
const jawGeo = capsule(0.026, 0.1, 12).rotateX(Math.PI / 2).scale(1, 0.65, 1);
const tongueGeo = new THREE.BoxGeometry(0.034, 0.006, 0.075);
const mouthGeo = new THREE.SphereGeometry(0.03, 12, 8).scale(0.9, 0.5, 1.2);
const eyeGeo = new THREE.SphereGeometry(0.012, 12, 8);
const glintGeo = new THREE.SphereGeometry(0.0035, 8, 6);
const earGeo = new THREE.SphereGeometry(0.05, 14, 10).scale(0.25, 1, 0.7);

// Legs
const upperLegGeo = capsule(0.036, UPPER_LEG + 0.04, 12);
const lowerLegGeo = capsule(0.029, LOWER_LEG + 0.03, 12);
const pawGeo = new THREE.SphereGeometry(0.035, 14, 10).scale(1, PAW_HALF_H / 0.035, 1.3);
const thighGeo = new THREE.SphereGeometry(0.065, 14, 10).scale(0.7, 1.25, 1.05);
const shoulderGeo = new THREE.SphereGeometry(0.055, 14, 10).scale(0.7, 1.2, 1);

// Tail: tapered cylinder along +Y from its base.
const tailGeo = new THREE.CylinderGeometry(0.014, 0.028, 0.2, 10).translate(0, 0.1, 0);
const tailTipGeo = new THREE.SphereGeometry(0.014, 10, 6);

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function group(x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  return g;
}

// ---- Animation helpers -----------------------------------------------------------------

const TAU = Math.PI * 2;

/** 0..1..0 smooth bump that happens once per `period` seconds and lasts `width` (fraction). */
function pulse(t: number, period: number, width: number, offset: number): number {
  const u = (((t + offset) / period) % 1 + 1) % 1;
  if (u >= width) return 0;
  const s = Math.sin((Math.PI * u) / width);
  return s * s;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Smoothstep from 0 (x <= a) to 1 (x >= b); exactly 0 / 1 outside the range. */
function sm(a: number, b: number, x: number): number {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const u = (x - a) / (b - a);
  return u * u * (3 - 2 * u);
}

/** 0 → 1 over [a, b], 1 → 0 over [b, c]. */
function bump(a: number, b: number, c: number, x: number): number {
  return sm(a, b, x) * (1 - sm(b, c, x));
}

function lerp(a: number, b: number, w: number): number {
  return a + (b - a) * w;
}

/** How much a trick currently overrides everything else (0 at progress 0 and 1). */
function trickEnvelope(kind: TrickKind, p: number): number {
  switch (kind) {
    case "rollOver":
      return sm(0, 0.1, p) * (1 - sm(0.9, 1, p));
    case "jump":
      return sm(0, 0.08, p) * (1 - sm(0.88, 1, p));
    case "spin":
      return sm(0, 0.08, p) * (1 - sm(0.92, 1, p));
  }
}

// ---- Module-scope scratch (keeps update() allocation-free) ------------------------------

const _invBody = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _tb = new THREE.Vector3();
const _e = new THREE.Euler();
const _qIdle = new THREE.Quaternion();
const _qAim = new THREE.Quaternion();
const _qNeck = new THREE.Quaternion();
const _qExtra = new THREE.Quaternion();

// IK outputs (forward angles from straight down, radians; lam = sideways lean about body Z).
let ikThU = 0;
let ikThL = 0;
let ikLam = 0;

/**
 * Two-bone leg IK in the leg's plane. (sx, sy, sz) = body-frame vector from hip pivot to the
 * lower-leg end. Front legs bend with the elbow back, hind legs with the knee forward.
 */
function solveIK(sx: number, sy: number, sz: number, front: boolean, soft: number): void {
  // (the clamp keeps the lean stable when a leg is folded so the paw is near hip height)
  ikLam = Math.atan2(sx, Math.max(-sy, 0.06));
  const down = Math.sqrt(sx * sx + sy * sy); // distance below the hip inside the leaned plane
  const U = UPPER_LEG;
  const L = LOWER_LEG;
  let r = Math.sqrt(down * down + sz * sz);
  // Soft IK (tricks only): approach full extension asymptotically so the knee never snaps straight.
  const da = U + L - soft;
  if (soft > 0 && r > da) r = da + soft * (1 - Math.exp(-(r - da) / soft));
  r = clamp(r, U - L + 0.005, U + L);
  const phi0 = Math.atan2(sz, down);
  const d = Math.acos(clamp((U * U + r * r - L * L) / (2 * U * r), -1, 1));
  const e = Math.acos(clamp((L * L + r * r - U * U) / (2 * L * r), -1, 1));
  ikThU = front ? phi0 - d : phi0 + d;
  ikThL = front ? phi0 + e : phi0 - e;
}

// ---- Leg ------------------------------------------------------------------------------

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  paw: THREE.Mesh;
  side: number;
  front: boolean;
  /** Diagonal pair: FL+BR = 0, FR+BL = 1 (for stepping). */
  pair: number;
}

function buildLeg(body: THREE.Group, side: number, front: boolean): Leg {
  const z = front ? LEG_Z : -LEG_Z;
  const hip = group(side * LEG_X, LEG_PIVOT_Y, z);
  hip.rotation.order = "ZXY"; // sagittal swing first, then the sideways lean
  // Muscle mass at the top of the leg, blended into the torso.
  hip.add(front ? mesh(shoulderGeo, furMat, 0, -0.01, 0) : mesh(thighGeo, furMat, 0, -0.02, -0.005));
  hip.add(mesh(upperLegGeo, furMat, 0, -UPPER_LEG / 2, 0));

  const knee = group(0, -UPPER_LEG, 0);
  hip.add(knee);
  knee.add(mesh(lowerLegGeo, furMat, 0, -LOWER_LEG / 2, 0));
  // Paw: bottom exactly at the ground (pivot to ground is UPPER_LEG + LOWER_LEG + PAW_HALF_H).
  const paw = mesh(pawGeo, lightFurMat, 0, -LOWER_LEG, PAW_FWD);
  knee.add(paw);

  body.add(hip);
  const pair = (front ? side < 0 : side > 0) ? 0 : 1;
  return { hip, knee, paw, side, front, pair };
}

/**
 * Solve a leg so its paw centre lands on (px, py, pz) in BODY space. Results in ikThU/ikThL/ikLam.
 */
function solveLeg(leg: Leg, px: number, py: number, pz: number, soft: number): void {
  const hp = leg.hip.position;
  const dx = px - hp.x;
  const dy = py - hp.y;
  const dz = pz - hp.z;
  // Pass 1 assumes a level paw offset, pass 2 corrects for the lower leg's actual tilt.
  solveIK(dx, dy, dz - PAW_FWD, leg.front, soft);
  const s = Math.sin(ikThL);
  const c = Math.cos(ikThL);
  solveIK(dx, dy - PAW_FWD * s, dz - PAW_FWD * c, leg.front, soft);
}

/** Apply leg angles; the paw is counter-rotated to stay level with the ground. */
function applyLeg(leg: Leg, thU: number, thL: number, lam: number, bodyPitch: number): void {
  leg.hip.rotation.set(-thU, 0, lam);
  leg.knee.rotation.set(thU - thL, 0, 0);
  leg.paw.rotation.set(thL - bodyPitch, 0, 0);
}

// ---- Floor guard probes -----------------------------------------------------------------

interface Frame {
  obj: THREE.Object3D;
  parent: number; // -1 = body (its matrix relative to `turn`)
  m: THREE.Matrix4;
}

/** An ellipsoid (semi-axes in the frame's local axes) whose lowest point we track. */
interface Probe {
  f: number;
  x: number;
  y: number;
  z: number;
  ax: number;
  ay: number;
  az: number;
}

// ---- Dog ------------------------------------------------------------------------------

export function createDogCharacter(): DogCharacter {
  const root = new THREE.Group();
  root.name = "dog";

  const turn = group();
  root.add(turn);

  const body = group(0, BODY_Y, 0);
  body.rotation.order = "YXZ"; // roll about the long axis first, then pitch, then yaw
  turn.add(body);

  // Torso (only this part scales with breathing).
  const torsoShape = group();
  body.add(torsoShape);
  torsoShape.add(mesh(torsoGeo, furMat));
  torsoShape.add(mesh(chestGeo, furMat, 0, 0.0, 0.15));
  torsoShape.add(mesh(rumpGeo, furMat, 0, 0.01, -0.17));
  torsoShape.add(mesh(bellyGeo, lightFurMat, 0, -0.05, 0.03));

  const legs = [
    buildLeg(body, -1, true),
    buildLeg(body, 1, true),
    buildLeg(body, -1, false),
    buildLeg(body, 1, false),
  ];

  // Neck rises forward from the front of the chest.
  const neck = group(0, 0.05, 0.2);
  neck.rotation.order = "YXZ"; // yaw about the body's vertical, then pitch
  neck.rotation.x = NECK_PITCH;
  body.add(neck);
  neck.add(mesh(neckGeo, furMat, 0, NECK_LEN / 2, 0));
  neck.add(mesh(collarGeo, collarMat, 0, 0.035, 0));
  const tag = mesh(tagGeo, tagMat, 0, 0.012, 0.074); // hangs from the collar's lower front edge
  tag.rotation.x = -NECK_PITCH;
  neck.add(tag);

  // Head: pivot at top of neck, counter-pitched so the head is level.
  const head = group(0, NECK_LEN, 0);
  neck.add(head);
  head.add(mesh(headGeo, furMat, 0, 0.015, 0.01));
  head.add(mesh(snoutGeo, lightFurMat, 0, -0.018, 0.085));
  head.add(mesh(noseGeo, noseMat, 0, -0.004, 0.15));
  head.add(mesh(mouthGeo, mouthMat, 0, -0.045, 0.075));

  const jaw = group(0, -0.045, 0.035);
  head.add(jaw);
  jaw.add(mesh(jawGeo, lightFurMat, 0, -0.004, 0.06));
  jaw.add(mesh(tongueGeo, tongueMat, 0, 0.008, 0.07));

  const EYE_Y = 0.03;
  const EYE_Z = 0.072;
  const EYE_X = 0.033;
  const eyes: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const eye = mesh(eyeGeo, eyeMat, side * EYE_X, EYE_Y, EYE_Z);
    // Tiny catch-light so eye contact reads at a distance (blinks with the eye).
    const glint = mesh(glintGeo, glintMat, -0.003, 0.005, 0.0095);
    glint.castShadow = false;
    eye.add(glint);
    head.add(eye);
    eyes.push(eye);
  }

  const ears: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const ear = group(side * 0.062, 0.05, -0.005);
    ear.add(mesh(earGeo, furMat, 0, -0.045, 0));
    head.add(ear);
    ears.push(ear);
  }

  // Tail: yaw joint for the wag, then pitch joint pointing it backwards.
  const tailBase = group(0, 0.05, -0.25);
  body.add(tailBase);
  const tailPitch = group();
  tailBase.add(tailPitch);
  tailPitch.add(mesh(tailGeo, furMat));
  tailPitch.add(mesh(tailTipGeo, furMat, 0, 0.2, 0));

  // ---- Floor guard setup (per instance, built once) ----
  const frames: Frame[] = [];
  const addFrame = (obj: THREE.Object3D, parent: number): number => {
    frames.push({ obj, parent, m: new THREE.Matrix4() });
    return frames.length - 1;
  };
  const probes: Probe[] = [];
  const probe = (f: number, x: number, y: number, z: number, ax: number, ay = ax, az = ax): void => {
    probes.push({ f, x, y, z, ax, ay, az });
  };
  const fBody = addFrame(body, -1);
  const fTorso = addFrame(torsoShape, fBody);
  probe(fTorso, 0, 0, 0.16, 0.11);
  probe(fTorso, 0, 0, -0.16, 0.11);
  probe(fTorso, 0, 0, 0.15, 0.114, 0.12, 0.108);
  probe(fTorso, 0, 0.01, -0.17, 0.105);
  probe(fTorso, 0, -0.05, 0.03, 0.09, 0.06, 0.16);
  const fNeck = addFrame(neck, fBody);
  probe(fNeck, 0, -0.01, 0, 0.07);
  probe(fNeck, 0, 0.14, 0, 0.055);
  probe(fNeck, 0, 0.035, 0, 0.081, 0.013, 0.081);
  const fHead = addFrame(head, fNeck);
  probe(fHead, 0, 0.015, 0.01, 0.0675, 0.0675, 0.079);
  probe(fHead, 0, -0.018, 0.058, 0.038);
  probe(fHead, 0, -0.018, 0.112, 0.038);
  probe(fHead, 0, -0.004, 0.15, 0.024, 0.017, 0.018);
  probe(fHead, 0, -0.045, 0.075, 0.027, 0.015, 0.036);
  const fJaw = addFrame(jaw, fHead);
  probe(fJaw, 0, -0.004, 0.036, 0.026, 0.017, 0.026);
  probe(fJaw, 0, -0.004, 0.084, 0.026, 0.017, 0.026);
  for (const ear of ears) probe(addFrame(ear, fHead), 0, -0.045, 0, 0.0125, 0.05, 0.035);
  const fTailBase = addFrame(tailBase, fBody);
  const fTail = addFrame(tailPitch, fTailBase);
  probe(fTail, 0, 0, 0, 0.028);
  probe(fTail, 0, 0.2, 0, 0.014);
  for (const leg of legs) {
    const fHip = addFrame(leg.hip, fBody);
    if (leg.front) probe(fHip, 0, -0.01, 0, 0.0385, 0.066, 0.055);
    else probe(fHip, 0, -0.02, -0.005, 0.0455, 0.08125, 0.06825);
    probe(fHip, 0, -0.016, 0, 0.036);
    probe(fHip, 0, -0.134, 0, 0.036);
    const fKnee = addFrame(leg.knee, fHip);
    probe(fKnee, 0, -0.014, 0, 0.029);
    probe(fKnee, 0, -0.116, 0, 0.029);
    probe(addFrame(leg.paw, fKnee), 0, 0, 0, 0.035, PAW_HALF_H, 0.0455);
  }

  /** Lowest point of all probes, in turn (= root, for y) space, for the current pose. */
  function lowestY(): number {
    for (const fr of frames) {
      fr.obj.updateMatrix();
      if (fr.parent < 0) fr.m.copy(fr.obj.matrix);
      else fr.m.multiplyMatrices(frames[fr.parent].m, fr.obj.matrix);
    }
    let min = Infinity;
    for (const p of probes) {
      const e = frames[p.f].m.elements;
      const cy = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
      const a = p.ax * e[1];
      const b = p.ay * e[5];
      const c = p.az * e[9];
      const y = cy - Math.sqrt(a * a + b * b + c * c);
      if (y < min) min = y;
    }
    return min;
  }

  const controls: DogControls = {
    lookAt: null,
    lookWeight: 0,
    turnYaw: 0,
    turnStep: 0,
    excitement: 0,
    petHead: 0,
    petBody: 0,
    petPoint: null,
    trick: null,
  };

  // Per-instance phase so several dogs don't move in lockstep.
  const ph = Math.random() * 100;

  function update(time: number): void {
    const t = time + ph;
    const c = controls;

    // ---- Trick parameters (all exactly neutral at progress 0 and 1) ----
    let env = 0;
    let lie = 0; // lying down weight
    let tuckRoll = 0; // legs/head tucked for the roll
    let tuckAir = 0; // legs tucked mid-jump
    let rollAngle = 0;
    let spin = 0;
    let lead = 0; // head leading / tail outwards during the spin
    let crouch = 0;
    let air = 0; // jump height above the normal stance
    let pitch = 0;
    let squash = 0;
    let stepAmp = 0;
    let stepFreq = 2.4;
    if (c.trick) {
      const kind = c.trick.kind;
      const p = clamp01(c.trick.progress);
      env = trickEnvelope(kind, p);
      if (kind === "rollOver") {
        lie = sm(0.02, 0.22, p) * (1 - sm(0.8, 0.97, p));
        tuckRoll = sm(0.17, 0.26, p) * (1 - sm(0.74, 0.83, p));
        rollAngle = (TAU * sm(0.24, 0.76, p)) % TAU;
      } else if (kind === "jump") {
        crouch = 0.08 * bump(0.0, 0.22, 0.32, p) + 0.06 * bump(0.62, 0.7, 0.95, p);
        const s = clamp01((p - 0.3) / 0.36);
        air = s <= 0 || s >= 1 ? 0 : 0.28 * Math.sin(Math.PI * s);
        tuckAir = bump(0.3, 0.42, 0.62, p);
        pitch = 0.08 * bump(0.0, 0.2, 0.3, p) - 0.3 * bump(0.2, 0.32, 0.45, p) + 0.25 * bump(0.42, 0.58, 0.72, p);
        squash = bump(0.62, 0.68, 0.85, p);
      } else {
        spin = (TAU * sm(0.08, 0.92, p)) % TAU;
        lead = env;
        stepAmp = env;
        stepFreq = 3.2;
      }
    }
    const free = 1 - env;
    const lw = c.lookAt ? clamp01(c.lookWeight) * free : 0;
    const pHead = clamp01(c.petHead) * free;
    const pBody = clamp01(c.petBody) * free;
    const exc = clamp01(c.excitement);
    if (c.turnStep > 0 && clamp01(c.turnStep) * free > stepAmp) {
      stepAmp = clamp01(c.turnStep) * free;
      stepFreq = 2.4;
    }

    // Side of the dog the petting hand is on (-1 right .. +1 left in the dog's +X), smoothed.
    let petSide = 0;
    if (c.petPoint && (pHead > 0 || pBody > 0)) {
      const a = c.turnYaw + spin;
      const lx = c.petPoint.x * Math.cos(a) - c.petPoint.z * Math.sin(a);
      petSide = clamp(lx / 0.12, -1, 1);
    }

    // ---- Breathing: calm breaths ↔ panting (excitement pushes towards panting) ----
    const pantIdle = THREE.MathUtils.smoothstep(Math.sin(t * 0.21) * 0.5 + 0.5, 0.35, 0.75);
    const pant = Math.max(pantIdle, exc, 0.6 * pHead);
    const calm = Math.sin(t * TAU * 0.28);
    const fast = Math.sin(t * TAU * 2.6);
    const breath = (1 - pant) * calm * 0.02 + pant * fast * 0.012;
    torsoShape.scale.set(
      (1 + breath) * (1 + 0.05 * squash),
      (1 + breath * 1.2) * (1 - 0.1 * squash),
      (1 + breath * 0.3) * (1 + 0.05 * squash),
    );

    // ---- Body ----
    const sway = 0.006 * Math.sin(t * 0.53) + 0.003 * Math.sin(t * 1.37);
    // Wiggle while petted on the body: yaw about a pivot at the chest so the rump sways.
    const wiggle = 0.13 * pBody * Math.sin(t * TAU * 2.3);
    const PIV = 0.15;
    const bx = sway - PIV * Math.sin(wiggle) + 0.025 * pBody * petSide;
    const bz = PIV * (1 - Math.cos(wiggle));
    // Standing height that keeps the (fully straight) legs' paws exactly on the ground.
    const LL = UPPER_LEG + LOWER_LEG;
    const standY = PAW_HALF_H - LEG_PIVOT_Y + Math.sqrt(LL * LL - sway * sway);
    // A happy wiggle sinks a little so the straight legs can still reach the planted paws.
    const by = lerp(standY, LIE_Y, lie) - crouch - 0.03 * pBody + air;
    const roll = rollAngle - 0.08 * pBody * petSide - 0.06 * lead;
    body.position.set(bx, by, bz);
    body.rotation.set(pitch, wiggle, roll);
    turn.rotation.set(0, c.turnYaw + spin, 0);
    body.updateMatrix();
    _invBody.copy(body.matrix).invert();

    // ---- Legs (IK to paw targets) ----
    const soft = 0.015 * env;
    for (const leg of legs) {
      // Ground target in turn space (rest spot under the hip), adjusted for lying / stepping.
      let gx = leg.side * LEG_X;
      let gz = (leg.front ? LEG_Z : -LEG_Z) + PAW_FWD;
      if (leg.front) gz += 0.25 * lie;
      else {
        gx += leg.side * 0.03 * lie;
        gz += 0.1 * lie;
      }
      let gy = PAW_HALF_H;
      if (stepAmp > 0) {
        const s = Math.sin(t * TAU * stepFreq + leg.pair * Math.PI);
        gy += stepAmp * 0.035 * (s > 0 ? s : 0);
      }
      _v.set(gx, gy, gz).applyMatrix4(_invBody);
      solveLeg(leg, _v.x, _v.y, _v.z, soft);
      let thU = ikThU;
      let thL = ikThL;
      let lam = ikLam;
      // Tucks blend in joint-angle space (blending targets would swing the leg past the hip).
      const tuck = tuckRoll > 0 ? tuckRoll : tuckAir;
      if (tuck > 0) {
        if (tuckRoll > 0) solveLeg(leg, leg.side * 0.065, -0.07, leg.front ? 0.13 : -0.08, 0);
        else solveLeg(leg, leg.side * 0.075, -0.17, leg.front ? 0.12 : -0.1, 0);
        thU = lerp(thU, ikThU, tuck);
        thL = lerp(thL, ikThL, tuck);
        lam = lerp(lam, ikLam, tuck);
      }
      applyLeg(leg, thU, thL, lam, pitch);
    }

    // ---- Neck & head ----
    let neckX = NECK_PITCH + 0.03 * Math.sin(t * 0.37) + breath * 0.5;
    neckX = lerp(neckX, LIE_NECK, lie);
    neckX = lerp(neckX, ROLL_NECK, tuckRoll);
    neckX -= 0.12 * pHead;
    let neckY = 0.4 * lead;

    const look = 0.35 * Math.sin(t * 0.31) * Math.sin(t * 0.13 + 1.1) + 0.06 * Math.sin(t * 0.83);
    const tilt = 0.3 * pulse(t, 7.3, 0.28, 0) * (Math.sin(t * 0.07) >= 0 ? 1 : -1);
    _qIdle.setFromEuler(
      _e.set(-neckX + 0.08 * Math.sin(t * 0.29 + 2), look * (1 - 0.6 * lw) + 0.5 * lead, tilt, "XYZ"),
    );

    let eyeDX = 0;
    let eyeDY = 0;
    if (lw > 0 && c.lookAt) {
      // Target: root space → turn space (undo turn yaw) → body space.
      const a = c.turnYaw + spin;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const T = c.lookAt;
      _tb.set(T.x * ca - T.z * sa, T.y, T.x * sa + T.z * ca).applyMatrix4(_invBody);

      // Pass 1: direction from the neutral eye position.
      let dx = _tb.x;
      let dy = _tb.y - 0.187;
      let dz = _tb.z - 0.345;
      let yaw = clamp(Math.atan2(dx, dz), -MAX_YAW, MAX_YAW);
      let pit = clamp(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)), -MAX_PITCH_DOWN, MAX_PITCH_UP);
      const aimNX = NECK_PITCH - NECK_SHARE * pit;
      const aimNY = NECK_SHARE * yaw;
      neckX = lerp(neckX, aimNX, lw);
      neckY = lerp(neckY, aimNY, lw);

      // Pass 2: from the eyes given the actual neck and the aimed head orientation.
      const snx = Math.sin(neckX);
      let hx = neck.position.x + NECK_LEN * snx * Math.sin(neckY);
      let hy = neck.position.y + NECK_LEN * Math.cos(neckX);
      let hz = neck.position.z + NECK_LEN * snx * Math.cos(neckY);
      const ey = EYE_Y * Math.cos(pit) + EYE_Z * Math.sin(pit);
      const ez = -EYE_Y * Math.sin(pit) + EYE_Z * Math.cos(pit);
      hx += ez * Math.sin(yaw);
      hy += ey;
      hz += ez * Math.cos(yaw);
      dx = _tb.x - hx;
      dy = _tb.y - hy;
      dz = _tb.z - hz;
      const rawYaw = Math.atan2(dx, dz);
      const rawPit = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
      yaw = clamp(rawYaw, -MAX_YAW, MAX_YAW);
      pit = clamp(rawPit, -MAX_PITCH_DOWN, MAX_PITCH_UP);
      eyeDX = clamp((rawYaw - yaw) / 0.4, -1, 1) * lw;
      eyeDY = clamp((rawPit - pit) / 0.4, -1, 1) * lw;

      // Head local = inverse(neck) * desired (desired = yaw about body Y, then pitch).
      _qNeck.setFromEuler(_e.set(neckX, neckY, 0, "YXZ"));
      _qAim.setFromEuler(_e.set(-pit, yaw, 0, "YXZ"));
      _qAim.premultiply(_qNeck.invert());
      head.quaternion.copy(_qIdle).slerp(_qAim, lw);
    } else {
      head.quaternion.copy(_qIdle);
    }
    neck.rotation.set(neckX, neckY, 0);
    if (pHead > 0) {
      // Push up into the hand and tilt towards it.
      _qExtra.setFromEuler(_e.set(-0.3 * pHead, 0, -0.25 * petSide * pHead, "XYZ"));
      head.quaternion.multiply(_qExtra);
    }

    // Jaw: almost closed when calm, open & panting otherwise.
    jaw.rotation.x = 0.04 + pant * (0.22 + 0.08 * fast);

    // ---- Ears: hang loosely, flick, perk up when excited, flatten back when petted ----
    const flickL = pulse(t, 5.9, 0.08, 1.7);
    const flickR = pulse(t, 6.7, 0.08, 4.1);
    const airN = air / 0.28;
    const earX = -0.25 * exc + 0.7 * pHead - 0.5 * airN;
    const perk = 0.2 * exc * (1 - pHead);
    ears[0].rotation.set(0.05 * Math.sin(t * 1.1) - 0.35 * flickL + earX, 0, -0.15 - 0.25 * flickL - perk + tilt * 0.4);
    ears[1].rotation.set(0.05 * Math.sin(t * 1.1 + 1) - 0.35 * flickR + earX, 0, 0.15 + 0.25 * flickR + perk + tilt * 0.4);

    // ---- Eyes: blink, squint while petted, shift towards an out-of-range target ----
    const blink = 1 - 0.9 * pulse(t, 4.3, 0.04, 0.5);
    const squint = 1 - 0.65 * pHead;
    const eyeS = Math.min(blink, squint);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      eyes[i].scale.set(1, eyeS, 1);
      eyes[i].position.set(side * EYE_X + 0.004 * eyeDX, EYE_Y + 0.003 * eyeDY, EYE_Z);
    }

    // ---- Tail: three oscillators blended (calm 1.5 Hz, excited 4 Hz, petted 6.5 Hz) ----
    const slow = Math.sin(t * 0.17 + 0.5) * 0.5 + 0.5;
    const wagE = Math.max(exc, 0.8 * pHead);
    const wag =
      (1 - wagE) * (1 - pBody) * (0.15 + 0.2 * slow) * Math.sin(t * TAU * 1.5) +
      wagE * (1 - pBody) * 0.75 * Math.sin(t * TAU * 4) +
      pBody * 0.6 * Math.sin(t * TAU * 6.5);
    tailBase.rotation.set(0, wag * (1 - 0.7 * env) - 0.5 * lead, 0);
    tailPitch.rotation.set(
      TAIL_PITCH + 0.1 + 0.15 * slow * (1 - wagE) + 0.3 * Math.max(wagE, pBody) + 0.05 * Math.sin(t * 0.7),
      0,
      0,
    );

    // ---- Floor guard: never let any part sink below the ground ----
    const minY = lowestY();
    if (minY < 0) body.position.y -= minY;
  }

  function getZones(out: DogZones): DogZones {
    root.updateWorldMatrix(true, true);
    const s = root.matrixWorld.getMaxScaleOnAxis();
    head.localToWorld(out.head.center.set(0, 0.015, 0.03));
    out.head.radius = 0.11 * s;
    body.localToWorld(out.body.center.set(0, 0.05, -0.02));
    out.body.radius = 0.2 * s;
    return out;
  }

  function getEyesWorld(out: THREE.Vector3): THREE.Vector3 {
    root.updateWorldMatrix(true, true);
    return head.localToWorld(out.set(0, EYE_Y, EYE_Z));
  }

  update(0);
  return { root, update, controls, getZones, getEyesWorld };
}

export function isDogCharacter(c: Character): c is DogCharacter {
  return "controls" in c && "getZones" in c && "getEyesWorld" in c;
}

export const dogModel: ModelInfo = {
  id: "dog",
  label: "Dog",
  height: HEIGHT,
  create: createDogCharacter,
};
