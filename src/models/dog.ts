import * as THREE from "three";
import type { Character } from "./types";
import type { Breed, CoatPattern, DogCharacter, DogConfig, DogControls, DogZones, TailStyle, TrickKind } from "../dog/types";
import { breedPreset, sanitizeDogConfig } from "../dog/config";

/*
 * Parametric dog built from primitives with flat colours. Faces +Z, origin on the ground under
 * the body centre, real-world scale from the breed height range.
 *
 * Joint hierarchy (every joint is a THREE.Group so rotations pivot naturally):
 *   root
 *   └─ turn (spin trick yaw about the dog's centre)
 *      └─ body (torso centre: position, pitch, roll, wiggle yaw)
 *         ├─ torsoShape (breathing scale) ─ torso / chest / rump / pattern overlays / spots / curls
 *         ├─ hip ×4 ─ knee ─ paw            (2-bone IK towards paw targets)
 *         ├─ tailBase (wag yaw) ─ tailPitch ─ seg0 ─ seg1 … (per-segment curl)
 *         └─ neck ─ head ─┬─ jaw ─ tongue
 *                         ├─ ear ×2 (─ fold)
 *                         └─ eye ×2
 *
 * The pose is a pure function of (t, config, controls): every frame sets absolute rotations and
 * positions. Paws are IK targets in `turn` space so they stay planted while the body breathes,
 * wiggles, sits or lies; the gait moves those targets along stance / swing trajectories. Tricks
 * blend with envelopes that are exactly 0 at progress 0 and 1. A floor guard evaluates the posed
 * mesh vertices and lifts the body (or swings dangling ears / tail up) so nothing is below y = 0.
 */

// ---- Breed proportions ------------------------------------------------------------------

interface BreedShape {
  /** torso depth / withers height */
  chest: number;
  /** torso length (capsule incl. caps) / withers height */
  length: number;
  /** torso width / depth */
  width: number;
  /** cranium radius / withers height */
  head: number;
  /** muzzle length beyond the cranium / cranium radius (at snoutLength 0.5) */
  muzzle: number;
  /** muzzle radius / cranium radius */
  muzzleW: number;
  /** neck length / withers height */
  neck: number;
  /** ear size multiplier */
  ear: number;
  /** tail length / withers height */
  tail: number;
  curly: boolean;
}

const SHAPES: Record<Breed, BreedShape> = {
  labrador: { chest: 0.44, length: 1.12, width: 1.0, head: 0.14, muzzle: 1.2, muzzleW: 0.5, neck: 0.32, ear: 0.95, tail: 0.62, curly: false },
  corgi: { chest: 0.62, length: 1.85, width: 1.05, head: 0.2, muzzle: 1.0, muzzleW: 0.44, neck: 0.28, ear: 1.15, tail: 0.3, curly: false },
  dachshund: { chest: 0.62, length: 2.3, width: 0.92, head: 0.2, muzzle: 1.6, muzzleW: 0.4, neck: 0.4, ear: 1.05, tail: 0.9, curly: false },
  husky: { chest: 0.44, length: 1.1, width: 0.95, head: 0.14, muzzle: 1.05, muzzleW: 0.45, neck: 0.31, ear: 0.95, tail: 0.6, curly: false },
  poodle: { chest: 0.4, length: 0.98, width: 0.9, head: 0.125, muzzle: 1.45, muzzleW: 0.36, neck: 0.42, ear: 1.0, tail: 0.45, curly: true },
  beagle: { chest: 0.48, length: 1.15, width: 1.0, head: 0.165, muzzle: 1.1, muzzleW: 0.46, neck: 0.32, ear: 1.05, tail: 0.62, curly: false },
  shepherd: { chest: 0.44, length: 1.2, width: 0.9, head: 0.13, muzzle: 1.35, muzzleW: 0.42, neck: 0.35, ear: 1.15, tail: 0.72, curly: false },
  dalmatian: { chest: 0.42, length: 1.08, width: 0.88, head: 0.13, muzzle: 1.25, muzzleW: 0.42, neck: 0.34, ear: 0.85, tail: 0.62, curly: false },
  pug: { chest: 0.6, length: 1.15, width: 1.15, head: 0.23, muzzle: 0.2, muzzleW: 0.6, neck: 0.24, ear: 0.6, tail: 0.35, curly: false },
  mutt: { chest: 0.46, length: 1.15, width: 1.0, head: 0.15, muzzle: 1.1, muzzleW: 0.46, neck: 0.32, ear: 0.9, tail: 0.6, curly: false },
};

// ---- Gaits --------------------------------------------------------------------------------

/** Leg order everywhere: 0 LF, 1 RF, 2 LH, 3 RH (left = +X when facing +Z). */
interface GaitDef {
  /** Fraction of the cycle each paw is on the ground. */
  duty: number;
  /** Phase (cycles) at which each paw touches down. */
  off: [number, number, number, number];
  /** Paw excursion during stance, × leg length. */
  exc: number;
  /** Swing height, × leg length. */
  lift: number;
}

// Walk: 4-beat lateral sequence LH → LF → RH → RF.
const WALK: GaitDef = { duty: 0.62, off: [0.25, 0.75, 0, 0.5], exc: 0.8, lift: 0.13 };
// Trot: diagonal pairs (LF + RH, then RF + LH).
const TROT: GaitDef = { duty: 0.45, off: [0, 0.5, 0.5, 0], exc: 0.9, lift: 0.2 };
// Rotary gallop: LH → RH → RF → LF, then a gathered suspension.
const GALLOP: GaitDef = { duty: 0.32, off: [0.5, 0.4, 0, 0.1], exc: 1.1, lift: 0.26 };
const GAITS = [WALK, TROT, GALLOP];

/** Blend weights [walk, trot, gallop] for a speed. */
function gaitWeights(speed: number, out: number[]): number[] {
  const trot = sm(0.42, 0.58, speed) * (1 - sm(0.74, 0.9, speed));
  const gallop = sm(0.74, 0.9, speed);
  out[0] = 1 - trot - gallop;
  out[1] = trot;
  out[2] = gallop;
  return out;
}

/** Step size ramps up linearly from standing to a walk (so slow walking = small steps). */
function gaitAmp(speed: number): number {
  return clamp01(speed / 0.3);
}

// ---- Math helpers -------------------------------------------------------------------------

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function lerp(a: number, b: number, w: number): number {
  return a + (b - a) * w;
}
function frac(x: number): number {
  return x - Math.floor(x);
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
/** 0..1..0 smooth bump once per `period` seconds lasting `width` (fraction of the period). */
function pulse(t: number, period: number, width: number, offset: number): number {
  const u = frac((t + offset) / period);
  if (u >= width) return 0;
  const s = Math.sin((Math.PI * u) / width);
  return s * s;
}

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

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Colour helpers -----------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixHex(a: string, b: string, w: number): string {
  const x = rgb(a);
  const y = rgb(b);
  const c = x.map((v, i) => Math.round(lerp(v, y[i], w)));
  return `#${((c[0] << 16) | (c[1] << 8) | c[2]).toString(16).padStart(6, "0")}`;
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// ---- Geometry helpers ---------------------------------------------------------------------

function ell(rx: number, ry: number, rz: number, w = 14, h = 10): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz);
}
/** Capsule along +Y, overall length `total` (caps included), centred. */
function capY(radius: number, total: number, radial = 12, cap = 3): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(radius, Math.max(total - 2 * radius, 0.0005), cap, radial);
}
function capZ(radius: number, total: number, radial = 12, cap = 3): THREE.BufferGeometry {
  return capY(radius, total, radial, cap).rotateX(Math.PI / 2);
}
function group(parent: THREE.Object3D | null, x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  if (parent) parent.add(g);
  return g;
}

// Part classes for the floor guard.
const P_NONE = 0;
const P_TORSO = 1;
const P_LEG = 2;
const P_HEAD = 4;
const P_NECK = 8;
const P_EAR = 16;
const P_TAIL = 32;
const P_BODY = P_TORSO | P_LEG | P_HEAD | P_NECK;

// ---- Leg IK -------------------------------------------------------------------------------

let ikThU = 0;
let ikThL = 0;
let ikLam = 0;

/**
 * Two-bone IK in the leg's plane. (sx, sy, sz) = body-frame vector from the hip pivot to the
 * lower-leg end. Front legs bend with the elbow back, hind legs with the knee forward.
 */
function solveIK(sx: number, sy: number, sz: number, U: number, L: number, front: boolean, soft: number): void {
  ikLam = Math.atan2(sx, Math.max(-sy, 0.2 * (U + L)));
  const down = Math.sqrt(sx * sx + sy * sy);
  let r = Math.sqrt(down * down + sz * sz);
  const da = U + L - soft;
  if (soft > 0 && r > da) r = da + soft * (1 - Math.exp(-(r - da) / soft));
  r = clamp(r, Math.abs(U - L) + 0.02 * (U + L), U + L);
  const phi0 = Math.atan2(sz, down);
  const d = Math.acos(clamp((U * U + r * r - L * L) / (2 * U * r), -1, 1));
  const e = Math.acos(clamp((L * L + r * r - U * U) / (2 * L * r), -1, 1));
  ikThU = front ? phi0 - d : phi0 + d;
  ikThL = front ? phi0 + e : phi0 - e;
}

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  paw: THREE.Mesh;
  side: number;
  front: boolean;
  /** Diagonal pair for stepping in place: LF+RH = 0, RF+LH = 1. */
  pair: number;
}

// ---- Module scratch -----------------------------------------------------------------------

const _invBody = new THREE.Matrix4();
const _invRear = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _tb = new THREE.Vector3();
const _e = new THREE.Euler();
const _qIdle = new THREE.Quaternion();
const _qAim = new THREE.Quaternion();
const _qNeck = new THREE.Quaternion();
const _qExtra = new THREE.Quaternion();
const _gw = [1, 0, 0];

/** Per-dog numbers the gait helper needs. */
const gaitInfo = new WeakMap<DogCharacter, { leg: number; height: number }>();

/**
 * Gait numbers for the brain so paws don't slide: the stride (meters travelled per gait cycle)
 * at `speed`, a suggested ground speed for that `speed` value, and the matching cycle rate.
 * Use `phase += dt * cyclesPerSecond` while the anchor moves at `metersPerSecond`
 * (or, for any ground speed v, `phase += dt * v / stride`).
 */
export function dogGaitInfo(
  dog: DogCharacter,
  speed: number,
): { stride: number; metersPerSecond: number; cyclesPerSecond: number } {
  const info = gaitInfo.get(dog) ?? { leg: 0.4, height: 0.55 };
  const s = clamp(speed, 0, 1.2);
  const w = gaitWeights(s, [0, 0, 0]);
  const a = gaitAmp(s);
  let stride = 0;
  for (let g = 0; g < 3; g++) stride += (w[g] * GAITS[g].exc) / GAITS[g].duty;
  stride *= info.leg * a;
  const mps = info.height * 3.4 * s;
  return { stride, metersPerSecond: mps, cyclesPerSecond: stride > 1e-6 ? mps / stride : 0 };
}

// ---- Dog ----------------------------------------------------------------------------------

export function createDogCharacter(input: DogConfig): DogCharacter {
  const cfg = sanitizeDogConfig(input);
  const shape = SHAPES[cfg.breed];
  const preset = breedPreset(cfg.breed);
  const male = cfg.sex === "male";
  const fl = cfg.coat.fluff;
  const build = cfg.build;
  const curly = shape.curly && fl > 0.5;
  const rng = mulberry32(hashString(`${cfg.name}|${cfg.breed}|${cfg.coat.pattern}`));

  // ---- Dimensions (meters) ----
  const H = lerp(preset.heightRange[0], preset.heightRange[1], cfg.size) * (male ? 1.02 : 0.98);
  const r0 = (shape.chest * H) / 2;
  const legF = 1 + 0.4 * (cfg.legLength - 0.5);
  const pivH = clamp((H - 1.25 * r0) * legF, 0.25 * H, H - 1.25 * 0.12 * H); // leg pivot height
  const r = (H - pivH) / 1.25; // torso radius (vertical)
  const pivY = -0.25 * r; // leg pivots relative to the torso centre
  const sx = shape.width * (0.86 + 0.28 * build) * (male ? 1.03 : 0.98) * (1 + 0.12 * fl);
  const sy = 1 + 0.03 * fl;
  const TL = shape.length * H;
  const LX = 0.6 * r * sx;
  const LZ = Math.max(TL / 2 - 0.85 * r, 0.3 * r);
  const ru = 0.34 * r * (0.85 + 0.3 * build) * (1 + 0.12 * fl);
  const rl = 0.78 * ru;
  const pawR = 1.12 * ru;
  const pawH = 0.62 * ru;
  const PAW_FWD = 0.35 * pawR;
  const pawFwd = PAW_FWD;
  /** Front paws drop the forward offset while lying (forearm flat on the floor). */
  let frontPawFwd = PAW_FWD;
  const S = (pivH - pawH) / 0.96; // upper + lower leg
  const U = 0.5 * S;
  const L = 0.5 * S;

  const hr = shape.head * H * (male ? 1.04 : 0.97);
  const csx = 0.9 * (0.94 + 0.12 * build);
  const csy = 0.86;
  const csz = 1.0;
  const CY = 0.15 * hr;
  const CZ = 0.25 * hr;
  const snoutF = Math.pow(2, (cfg.face.snoutLength - 0.5) * 1.6);
  const mlen = shape.muzzle * hr * snoutF;
  const mr = shape.muzzleW * hr * (0.92 + 0.16 * build);
  const nl = shape.neck * H;
  const nr = 0.68 * hr * (0.9 + 0.2 * build) * (1 + 0.15 * fl);
  const NP = 0.72; // neck forward pitch
  const NBY = 0.28 * r;
  const NBZ = TL / 2 - 0.62 * r;
  const es = shape.ear * hr;
  const tl = shape.tail * H * (cfg.tail === "stub" ? 0.3 : cfg.tail === "curled" ? 0.75 : 1);

  // ---- Colours / materials (one per colour) ----
  const primary = cfg.coat.primary;
  const secondary = cfg.coat.secondary;
  const pattern: CoatPattern = cfg.coat.pattern;
  const light = mixHex(primary, "#fbf6ee", 0.62);
  const secLighter = luminance(secondary) > luminance(primary);
  const matCache = new Map<string, THREE.MeshStandardMaterial>();
  const mat = (hex: string, rough = 0.85): THREE.MeshStandardMaterial => {
    const key = `${hex}|${rough}`;
    let m = matCache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: rough, metalness: 0 });
      matCache.set(key, m);
    }
    return m;
  };
  const furM = mat(primary);
  const secM = mat(secondary);
  const lightM = mat(light);
  const bellyM = pattern === "twoTone" || (pattern === "mask" && secLighter) ? secM : pattern === "saddle" ? lightM : furM;
  const muzzleM = pattern === "twoTone" || pattern === "mask" ? secM : pattern === "saddle" ? lightM : furM;
  const sockM = pattern === "twoTone" || (pattern === "mask" && secLighter) ? secM : pattern === "saddle" ? lightM : furM;
  const earM = pattern === "mask" && !secLighter ? secM : pattern === "patches" ? secM : furM;
  const noseM = mat(cfg.face.noseColor, 0.5);
  const eyeM = mat(cfg.face.eyeColor, 0.35);
  const pupilM = mat("#0d0b0a", 0.3);
  const glintM = mat("#ffffff", 0.3);
  const browM = mat(luminance(primary) < 0.3 ? "#c8843c" : mixHex(primary, "#1a1210", 0.65));
  const collarM = mat(cfg.collar.color, 0.6);
  const tagM = mat("#d4b13a", 0.4);
  const tongueM = mat("#e07a8a", 0.7);
  const mouthM = mat("#4a2224", 0.85);
  const innerEarM = mat(pattern === "mask" && secLighter ? secondary : mixHex(primary, "#e8a6a0", 0.55));

  // ---- Mesh registry (floor guard + dispose) ----
  interface MeshRec {
    mesh: THREE.Mesh;
    part: number;
    pos: Float32Array;
  }
  const meshRecs: MeshRec[] = [];
  const add = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    m: THREE.Material,
    part: number,
    x = 0,
    y = 0,
    z = 0,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    meshRecs.push({ mesh, part, pos: geo.getAttribute("position").array as Float32Array });
    return mesh;
  };

  // ---- Skeleton ----
  const root = new THREE.Group();
  root.name = `dog:${cfg.name}`;
  const turn = group(root);
  const body = group(turn, 0, H - r, 0);
  body.rotation.order = "YXZ";
  const torsoShape = group(body);
  torsoShape.name = "torso";
  // Loin (spine) joint: the rear half of the torso, hind legs and tail hang off it so long dogs
  // can curl the spine when sitting.
  const zJ = Math.min(-LZ + 0.9 * r, -0.05 * TL); // lumbosacral joint, just in front of the hips
  const loin = group(body, 0, 0, zJ);
  const torsoRear = group(loin, 0, 0, 0);
  torsoRear.name = "torsoRear";
  /** Add a torso mesh at body-space z: front half on `torsoShape`, rear half on `torsoRear`. */
  const addT = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh =>
    z < zJ ? add(torsoRear, geo, m, P_TORSO, x, y, z - zJ) : add(torsoShape, geo, m, P_TORSO, x, y, z);

  // ---- Torso ----
  {
    const zf0 = zJ - 0.6 * r;
    const zr1 = zJ + 0.6 * r;
    addT(capZ(r, TL / 2 - zf0, 20, 5).scale(sx, sy, 1), furM, 0, 0, (TL / 2 + zf0) / 2);
    addT(capZ(r, zr1 + TL / 2, 20, 5).scale(sx, sy, 1), furM, 0, 0, (zr1 - TL / 2) / 2 - 1e-4);
  }
  const chestZ = LZ + 0.05 * r;
  const chestR = [1.05 * r * sx, 1.22 * r * sy, 1.0 * r];
  const chestY = -0.18 * r;
  addT(ell(chestR[0], chestR[1], chestR[2], 18, 12), furM, 0, chestY, chestZ);
  const rumpZ = -LZ - 0.05 * r;
  const rumpR = [0.98 * r * sx, 0.98 * r * sy, 0.9 * r];
  addT(ell(rumpR[0], rumpR[1], rumpR[2], 16, 12), furM, 0, 0.03 * r, rumpZ);

  if (bellyM !== furM) {
    const span = (a: number, b: number): [number, number] => [(a + b) / 2, (b - a) / 2];
    const [fc, fr] = span(zJ - 0.03 * TL, 0.4 * TL);
    const [rc, rr] = span(-0.32 * TL, zJ + 0.03 * TL);
    addT(ell(0.72 * r * sx, 0.5 * r, fr, 16, 10), bellyM, 0, -0.62 * r, fc);
    addT(ell(0.7 * r * sx, 0.48 * r, rr, 14, 8), bellyM, 0, -0.6 * r, rc - 1e-4);
    addT(ell(0.74 * r * sx, 0.9 * r, 0.5 * r, 14, 10), bellyM, 0, -0.3 * r, chestZ + 0.57 * r);
  }
  if (pattern === "saddle") {
    const span = (a: number, b: number): [number, number] => [(a + b) / 2, (b - a) / 2];
    const [rc, rr] = span(-0.46 * TL, zJ + 0.04 * TL);
    const [fc, fr] = span(zJ - 0.04 * TL, 0.3 * TL);
    addT(ell(1.03 * r * sx, 1.0 * r * sy, rr, 18, 12), secM, 0, 0.1 * r, rc - 1e-4);
    addT(ell(1.03 * r * sx, 1.0 * r * sy, fr, 18, 12), secM, 0, 0.1 * r, fc);
  }

  // Points on the torso surface (for spots, patches, curls): cylinder part + chest + rump.
  type SurfPt = { p: THREE.Vector3; n: THREE.Vector3 };
  const torsoSurface = (minUp: number): SurfPt => {
    for (let k = 0; k < 20; k++) {
      const u = rng();
      let p: THREE.Vector3;
      let n: THREE.Vector3;
      const phi = rng() * TAU;
      if (u < 0.7) {
        const z = lerp(rumpZ + 0.3 * r, chestZ - 0.3 * r, rng());
        p = new THREE.Vector3(r * sx * Math.cos(phi), r * sy * Math.sin(phi), z);
        n = new THREE.Vector3(Math.cos(phi) / sx, Math.sin(phi) / sy, 0).normalize();
      } else {
        const fr = u < 0.85;
        const c = fr ? new THREE.Vector3(0, chestY, chestZ) : new THREE.Vector3(0, 0.03 * r, rumpZ);
        const R = fr ? chestR : rumpR;
        const cz = rng() * 0.9 + 0.1;
        const sz = Math.sqrt(1 - cz * cz);
        const dir = new THREE.Vector3(sz * Math.cos(phi), sz * Math.sin(phi), fr ? cz : -cz);
        p = new THREE.Vector3(c.x + R[0] * dir.x, c.y + R[1] * dir.y, c.z + R[2] * dir.z);
        n = new THREE.Vector3(dir.x / R[0], dir.y / R[1], dir.z / R[2]).normalize();
      }
      if (n.y >= minUp) return { p, n };
    }
    return { p: new THREE.Vector3(0, r * sy, 0), n: new THREE.Vector3(0, 1, 0) };
  };
  const spotGeos = new Map<number, THREE.BufferGeometry>();
  const spot = (parent: THREE.Object3D | null, s: SurfPt, radius: number, m: THREE.Material, part: number, sink = 0.55): void => {
    const key = Math.round(radius * 2000);
    let g = spotGeos.get(key);
    if (!g) {
      g = ell(key / 2000, key / 2000, key / 2000, 10, 7);
      spotGeos.set(key, g);
    }
    const c = s.p.clone().addScaledVector(s.n, -sink * radius);
    if (parent) add(parent, g, m, part, c.x, c.y, c.z);
    else addT(g, m, c.x, c.y, c.z);
  };

  if (pattern === "spots") {
    for (let i = 0; i < 30; i++) spot(null, torsoSurface(-0.5), r * (0.1 + 0.1 * rng()), secM, P_TORSO);
  } else if (pattern === "patches") {
    for (let i = 0; i < 3; i++) spot(null, torsoSurface(-0.1), r * (0.5 + 0.2 * rng()), secM, P_TORSO, 0.72);
  }
  if (curly) {
    for (let i = 0; i < 34; i++) spot(null, torsoSurface(-0.85), r * (0.28 + 0.08 * rng()), furM, P_TORSO, 0.35);
  }

  // ---- Legs ----
  const legs: Leg[] = [];
  const legDefs: [number, boolean][] = [
    [1, true],
    [-1, true],
    [1, false],
    [-1, false],
  ];
  for (const [side, front] of legDefs) {
    const hip = front ? group(body, side * LX, pivY, LZ) : group(loin, side * LX, pivY, -LZ - zJ);
    hip.name = `${side > 0 ? "L" : "R"}${front ? "F" : "H"}`;
    hip.rotation.order = "ZXY";
    if (front) add(hip, ell(1.1 * ru, 1.9 * ru, 1.55 * ru, 12, 9), furM, P_LEG, 0, -0.07 * U, 0);
    else add(hip, ell(1.25 * ru * (1 + 0.25 * fl), 2.2 * ru, 1.9 * ru * (1 + 0.2 * fl), 12, 9), furM, P_LEG, 0, -0.14 * U, -0.1 * ru);
    add(hip, capY(ru, U + 1.1 * ru, 10), furM, P_LEG, 0, -U / 2, 0);
    if (fl > 0.4 && front) {
      const f = sm(0.4, 1, fl);
      add(hip, ell(0.7 * ru, 0.45 * U, (0.6 + 0.6 * f) * ru, 8, 6), furM, P_LEG, 0, -0.55 * U, -0.75 * ru);
    }
    const knee = group(hip, 0, -U, 0);
    // Ends inside the paw so an inclined lower leg never pokes below the paw sole.
    add(knee, capY(rl, L + 0.2 * rl, 10), sockM, P_LEG, 0, -L / 2 + 0.25 * rl, 0);
    if (curly) add(knee, ell(1.75 * rl, 2.1 * rl, 1.75 * rl, 10, 8), furM, P_LEG, 0, -L + 2.9 * rl, 0);
    const paw = add(knee, ell(pawR, pawH, 1.3 * pawR, 12, 8), sockM, P_LEG, 0, -L, pawFwd);
    if (pattern === "spots") {
      for (let i = 0; i < 2; i++) {
        const a = rng() * TAU;
        const y = -U * (0.25 + 0.6 * rng());
        spot(hip, { p: new THREE.Vector3(ru * Math.cos(a), y, ru * Math.sin(a)), n: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)) }, ru * 0.45, secM, P_LEG);
      }
      const a = rng() * TAU;
      spot(knee, { p: new THREE.Vector3(rl * Math.cos(a), -L * 0.5, rl * Math.sin(a)), n: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)) }, rl * 0.45, secM, P_LEG);
    }
    paw.name = `paw${hip.name}`;
    legs.push({ hip, knee, paw, side, front, pair: (front ? side > 0 : side < 0) ? 0 : 1 });
  }

  // ---- Neck ----
  const neck = group(body, 0, NBY, NBZ);
  neck.rotation.order = "YXZ";
  add(neck, new THREE.SphereGeometry(1.3 * nr, 14, 10), furM, P_NECK);
  add(neck, new THREE.CylinderGeometry(0.85 * nr, 1.1 * nr, nl * 1.1, 14).translate(0, nl * 0.48, 0), furM, P_NECK);
  if (bellyM !== furM) add(neck, ell(0.8 * nr, 0.55 * nl, 0.6 * nr, 10, 8), bellyM, P_NECK, 0, 0.42 * nl, 0.42 * nr);
  if (pattern === "spots") {
    for (let i = 0; i < 4; i++) {
      const a = rng() * TAU;
      const y = nl * (0.15 + 0.7 * rng());
      const rad = nr * (1.1 - 0.25 * (y / nl));
      spot(neck, { p: new THREE.Vector3(rad * Math.cos(a), y, rad * Math.sin(a)), n: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)) }, nr * 0.25, secM, P_NECK);
    }
  }
  if (fl > 0.3 || curly) {
    const f = curly ? 1 : sm(0.3, 1, fl);
    add(neck, ell(nr * (1.25 + 0.45 * f), nr * (1.1 + 0.4 * f), nr * (1.2 + 0.45 * f), 14, 10), curly ? furM : bellyM === furM ? furM : bellyM, P_NECK, 0, 0.12 * nl, 0.12 * nr);
  }
  const collarY = 0.42 * nl;
  const collarR = nr * (1.1 - 0.25 * 0.42) + 0.12 * nr;
  const collarTube = 0.16 * nr + 0.003;
  add(neck, new THREE.TorusGeometry(collarR + 0.04 * (fl > 0.3 ? nr * fl : 0), collarTube, 6, 22).rotateX(Math.PI / 2), collarM, P_NECK, 0, collarY, 0);
  if (cfg.collar.tag) {
    const tag = add(
      neck,
      new THREE.CylinderGeometry(0.3 * nr, 0.3 * nr, 0.15 * collarTube + 0.002, 12).rotateX(Math.PI / 2),
      tagM,
      P_NECK,
      0,
      collarY - collarTube - 0.25 * nr,
      collarR + collarTube * 0.9,
    );
    tag.rotation.x = -NP;
  }

  // ---- Head ----
  const head = group(neck, 0, nl, 0);
  add(head, ell(csx * hr, csy * hr, csz * hr, 18, 14), furM, P_HEAD, 0, CY, CZ);
  /** z of the cranium surface at (x, y) in head space (front side). */
  const craniumZ = (x: number, y: number): number =>
    CZ + csz * hr * Math.sqrt(Math.max(0.0, 1 - (x / (csx * hr)) ** 2 - ((y - CY) / (csy * hr)) ** 2));

  const MY = CY - 0.4 * hr; // muzzle centre height
  const zb = CZ + 0.25 * hr; // muzzle back
  const zf = CZ + 0.9 * csz * hr + mlen; // muzzle front
  const mTot = Math.max(zf - zb, 2 * mr + 0.002);
  const mzc = zf - mTot / 2;
  add(head, capZ(mr, mTot, 14, 4).scale(1, 0.9, 1), muzzleM, P_HEAD, 0, MY, mzc);
  const noseR = 0.45 * mr * (cfg.breed === "pug" ? 1.1 : 1);
  const noseY = MY + 0.62 * mr;
  const noseZ = zf - 0.1 * mr;
  const nose = add(head, ell(1.2 * noseR, 0.85 * noseR, 0.9 * noseR, 12, 8), noseM, P_HEAD, 0, noseY, noseZ);
  add(head, ell(0.72 * mr, 0.32 * mr, mTot * 0.42, 10, 6), mouthM, P_NONE, 0, MY - 0.62 * mr, mzc + 0.05 * mTot);
  // Husky-style light face mask: a cranium-shaped overlay shifted forward / down.
  if (pattern === "mask" && secLighter) {
    add(head, ell(csx * hr * 1.0, csy * hr * 0.9, csz * hr * 1.0, 18, 12), secM, P_HEAD, 0, CY - 0.17 * hr, CZ + 0.09 * hr);
  }
  if (pattern === "spots") {
    for (let i = 0; i < 5; i++) {
      const a = (rng() - 0.5) * 2.6;
      const b = (rng() - 0.3) * 1.4;
      const dir = new THREE.Vector3(Math.sin(a) * Math.cos(b), Math.sin(b), -Math.cos(a) * Math.cos(b) * 0.4 + 0.3);
      dir.normalize();
      const p = new THREE.Vector3(csx * hr * dir.x, CY + csy * hr * dir.y, CZ + csz * hr * dir.z);
      const n = new THREE.Vector3(dir.x / csx, dir.y / csy, dir.z / csz).normalize();
      spot(head, { p, n }, hr * 0.16, secM, P_HEAD);
    }
  }

  const jaw = group(head, 0, MY - 0.5 * mr, zb + 0.15 * hr);
  const jawLen = Math.max(zf - (zb + 0.15 * hr) - 0.25 * mr, 1.4 * mr);
  add(jaw, capZ(0.66 * mr, jawLen, 12, 3).scale(1, 0.62, 1), muzzleM, P_HEAD, 0, -0.1 * mr, jawLen / 2);
  add(jaw, new THREE.BoxGeometry(0.85 * mr, 0.1 * mr, jawLen * 0.72), tongueM, P_NONE, 0, 0.18 * mr, jawLen * 0.5);
  const tongueOut = group(jaw, 0, 0.14 * mr, jawLen * 0.78);
  tongueOut.visible = cfg.face.tongueOut;
  if (cfg.face.tongueOut) {
    const tLen = Math.max(0.9 * mr, 0.35 * hr);
    add(tongueOut, ell(0.42 * mr, 0.07 * mr, tLen / 2, 10, 6), tongueM, P_NONE, 0, 0, tLen / 2);
  }

  // Eyes (group per eye so blinking scales iris + pupil + glint together).
  let er = hr * (0.12 + 0.08 * cfg.face.eyeSize);
  if (cfg.breed === "pug") er *= 1.15;
  const EYE_X = (cfg.breed === "pug" ? 0.47 : 0.4) * hr;
  const EYE_Y = CY + 0.18 * hr;
  const EYE_Z = craniumZ(EYE_X, EYE_Y) - 0.35 * er;
  const eyes: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const eye = group(head, side * EYE_X, EYE_Y, EYE_Z);
    eye.rotation.y = side * 0.25;
    add(eye, new THREE.SphereGeometry(er, 12, 9), eyeM, P_NONE);
    add(eye, new THREE.SphereGeometry(0.62 * er, 10, 7), pupilM, P_NONE, 0, 0, 0.48 * er);
    const glint = add(eye, new THREE.SphereGeometry(0.2 * er, 6, 5), glintM, P_NONE, -0.3 * er, 0.35 * er, 0.82 * er);
    glint.castShadow = false;
    if (pattern === "mask" && !secLighter) {
      // Pug: dark rims around the eyes.
      add(head, new THREE.SphereGeometry(1.45 * er, 10, 8), secM, P_NONE, side * EYE_X, EYE_Y, EYE_Z - 0.55 * er);
    }
    if (cfg.face.brows) {
      const bx = side * (EYE_X - 0.05 * hr);
      const by = EYE_Y + 1.55 * er + 0.02 * hr;
      add(head, ell(0.8 * er, 0.45 * er, 0.4 * er, 10, 6), browM, P_NONE, bx, by, craniumZ(bx, by) - 0.15 * er);
    }
    eyes.push(eye);
  }
  if (pattern === "patches") {
    const side = rng() < 0.5 ? -1 : 1;
    const p = new THREE.Vector3(side * EYE_X, EYE_Y, EYE_Z);
    add(head, new THREE.SphereGeometry(0.55 * hr, 14, 10), secM, P_HEAD, p.x * 1.05, p.y + 0.05 * hr, p.z - 0.45 * hr);
  }
  if (fl > 0.5 && !curly) {
    const f = sm(0.5, 1, fl);
    for (const side of [-1, 1]) {
      add(head, ell(0.45 * hr, 0.5 * hr, 0.5 * hr, 10, 8), pattern === "mask" && secLighter ? secM : furM, P_HEAD, side * (csx * hr * (0.68 + 0.12 * f)), CY - 0.28 * hr, CZ - 0.12 * hr);
    }
  }
  if (curly) add(head, ell(0.85 * hr, 0.7 * hr, 0.85 * hr, 14, 10), furM, P_HEAD, 0, CY + 0.6 * hr, CZ - 0.12 * hr);

  // ---- Ears ----
  const style = cfg.face.earStyle;
  const hanging = style === "floppy" || style === "long";
  const ears: THREE.Group[] = [];
  const earFolds: THREE.Group[] = [];
  const earLen = style === "long" ? 1.9 * es : style === "floppy" ? 1.45 * es : style === "pointy" ? 1.1 * es : 0.45 * es;
  for (const side of [-1, 1]) {
    const ear = group(head, side * csx * hr * (hanging ? 0.78 : 0.55), CY + (hanging ? 0.5 : 0.68) * hr, CZ - (hanging ? 0.04 : 0.12) * hr);
    ear.rotation.order = "ZXY";
    if (hanging) {
      const w = (style === "long" ? 0.85 : 0.95) * es * (1 + 0.25 * fl);
      const th = 0.16 * es * (1 + 0.8 * fl);
      add(ear, ell(th, earLen / 2, w / 2, 10, 10), earM, P_EAR, side * 0.1 * es, -earLen * 0.46, 0.04 * es);
      if (fl > 0.45 || curly) {
        const f = curly ? 1 : sm(0.45, 1, fl);
        add(ear, ell(th * 1.6, earLen * 0.3 * (1 + 0.3 * f), w * 0.58, 8, 7), earM, P_EAR, side * 0.12 * es, -earLen * 0.72, 0.04 * es);
      }
      if (pattern === "spots") spot(ear, { p: new THREE.Vector3(side * (0.1 * es + th), -earLen * 0.55, 0), n: new THREE.Vector3(side, 0, 0) }, 0.22 * es, secM, P_EAR);
    } else if (style === "pointy") {
      const base = 0.5 * es;
      const g = new THREE.ConeGeometry(base, earLen, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.42).translate(0, earLen / 2, 0);
      add(ear, g, earM, P_EAR);
      const gi = new THREE.ConeGeometry(base * 0.62, earLen * 0.72, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.2).translate(0, earLen * 0.36, 0);
      add(ear, gi, innerEarM, P_NONE, 0, 0.02 * earLen, base * 0.2);
    } else {
      // folded (button / semi-prick): short upright base, tip folded forward.
      add(ear, ell(0.42 * es, earLen * 0.6, 0.14 * es, 10, 8), earM, P_EAR, 0, earLen * 0.4, 0);
      const fold = group(ear, 0, earLen * 0.85, 0.02 * es);
      add(fold, ell(0.4 * es, 0.42 * es, 0.12 * es, 10, 8), earM, P_EAR, 0, 0.36 * es, 0);
      earFolds.push(fold);
    }
    ears.push(ear);
  }

  // ---- Tail ----
  const tailStyle: TailStyle = cfg.tail;
  const tailBase = group(loin, 0, 0.5 * r, -TL / 2 + 0.28 * r - zJ);
  const tailPitch = group(tailBase);
  const nSeg = tailStyle === "stub" ? 2 : tailStyle === "otter" ? 5 : 6;
  const segLen = tl / nSeg;
  const tr0 =
    ru *
    (tailStyle === "otter" ? 0.75 : tailStyle === "whip" ? 0.42 : tailStyle === "plume" ? 0.55 : tailStyle === "curled" ? 0.6 : 0.7) *
    (1 + 0.3 * fl);
  const trTip = tr0 * (tailStyle === "otter" ? 0.45 : tailStyle === "stub" ? 0.8 : 0.35);
  const tailSegs: THREE.Group[] = [];
  const tailTipM = pattern === "saddle" ? lightM : furM;
  {
    let parent: THREE.Object3D = tailPitch;
    for (let i = 0; i < nSeg; i++) {
      const seg = group(parent, 0, i === 0 ? 0 : segLen, 0);
      const ra = lerp(tr0, trTip, i / nSeg);
      const rb = lerp(tr0, trTip, (i + 1) / nSeg);
      const m = i >= nSeg - 1 && nSeg > 2 ? tailTipM : furM;
      add(seg, new THREE.CylinderGeometry(rb, ra, segLen, 9, 1).translate(0, segLen / 2, 0), m, P_TAIL);
      add(seg, new THREE.SphereGeometry(ra, 9, 6), i === 0 ? furM : m, P_TAIL);
      const plumeF = tailStyle === "plume" ? 0.5 + 0.5 * fl : tailStyle === "curled" ? sm(0.3, 1, fl) : sm(0.55, 1, fl) * 0.7;
      if (plumeF > 0.05 && i > 0 && !curly) {
        const tuft = ra * (1.4 + 1.6 * plumeF);
        add(seg, ell(tuft * 0.95, segLen * 0.5 + tuft * 0.9, tuft, 8, 6), m, P_TAIL, 0, segLen * 0.5, -tuft * 0.3);
      }
      tailSegs.push(seg);
      parent = seg;
    }
    const last = tailSegs[nSeg - 1];
    if (curly) add(last, new THREE.SphereGeometry(Math.max(3.2 * trTip, 0.5 * ru), 10, 8), furM, P_TAIL, 0, segLen, 0);
    else add(last, new THREE.SphereGeometry(trTip, 8, 6), tailTipM, P_TAIL, 0, segLen, 0);
  }
  /** Rest carriage: base pitch (rotation.x; -π/2 = straight back) and curl per segment. */
  const TAIL_REST: Record<TailStyle, [number, number]> = {
    otter: [-1.95, 0.09],
    whip: [-0.95, 0.12],
    plume: [-2.45, 0.16],
    curled: [-0.35, 0.62],
    stub: [-0.75, 0.0],
  };
  const [tailA0, tailBend] = TAIL_REST[tailStyle];
  const tailWagAmp = tailStyle === "curled" ? 0.4 : tailStyle === "stub" ? 0.8 : 1;

  // ---- Floor-guard frames ----
  const nodes: THREE.Object3D[] = [];
  const parentIdx: number[] = [];
  const nodeMats: THREE.Matrix4[] = [];
  const nodeIndex = new Map<THREE.Object3D, number>();
  const visit = (o: THREE.Object3D, p: number): void => {
    const i = nodes.length;
    nodes.push(o);
    parentIdx.push(p);
    nodeMats.push(new THREE.Matrix4());
    nodeIndex.set(o, i);
    for (const ch of o.children) visit(ch, i);
  };
  visit(body, -1);
  const guardRecs = meshRecs.filter((m) => m.part !== P_NONE).map((m) => ({ ...m, node: nodeIndex.get(m.mesh) ?? 0 }));

  function computeMats(): void {
    for (let i = 0; i < nodes.length; i++) {
      const o = nodes[i];
      o.updateMatrix();
      const p = parentIdx[i];
      if (p < 0) nodeMats[i].copy(o.matrix);
      else nodeMats[i].multiplyMatrices(nodeMats[p], o.matrix);
    }
  }
  /** Lowest y (turn / root space) of the meshes in `mask`; computeMats() first. */
  function lowestOf(mask: number, only?: THREE.Object3D): number {
    let min = Infinity;
    const onlyIdx = only ? nodeIndex.get(only) ?? -1 : -1;
    for (const rec of guardRecs) {
      if ((rec.part & mask) === 0) continue;
      if (onlyIdx >= 0 && !isDescendant(rec.node, onlyIdx)) continue;
      const e = nodeMats[rec.node].elements;
      const a = e[1];
      const b = e[5];
      const c = e[9];
      const d = e[13];
      const pos = rec.pos;
      for (let k = 0; k < pos.length; k += 3) {
        const y = a * pos[k] + b * pos[k + 1] + c * pos[k + 2] + d;
        if (y < min) min = y;
      }
    }
    return min;
  }
  function isDescendant(i: number, anc: number): boolean {
    while (i >= 0) {
      if (i === anc) return true;
      i = parentIdx[i];
    }
    return false;
  }

  // ---- Leg posing ----
  const tgx = [0, 0, 0, 0];
  const tgy = [0, 0, 0, 0];
  const tgz = [0, 0, 0, 0];
  let tuckRollW = 0;
  let tuckAirW = 0;
  let softIK = 0;
  let lieShift = 0;
  let sitShift = 0;
  const SIT_SHOULDER = 0.3;
  function solveLeg(leg: Leg, px: number, py: number, pz: number, soft: number): void {
    const pawFwd = leg.front ? frontPawFwd : PAW_FWD;
    const hp = leg.hip.position;
    const dx = px - hp.x;
    const dy = py - hp.y;
    const dz = pz - hp.z;
    // The paw sits pawFwd ahead of the lower-leg end (in the lower leg's frame): iterate the
    // offset correction a few times so the paw centre lands on the target.
    solveIK(dx, dy, dz - pawFwd, U, L, leg.front, soft);
    for (let k = 0; k < 3; k++) {
      solveIK(dx, dy - pawFwd * Math.sin(ikThL), dz - pawFwd * Math.cos(ikThL), U, L, leg.front, soft);
    }
  }
  function poseLegs(bodyPitch: number): void {
    for (const leg of legs) {
      if (!leg.front) continue;
      // Shoulder (scapula) slides up / forward when lying so the forearms can lie flat.
      leg.hip.position.y = pivY + 0.45 * r * lieShift + SIT_SHOULDER * r * sitShift;
      leg.hip.position.z = LZ + 0.25 * r * lieShift;
      leg.paw.position.z = frontPawFwd;
    }
    body.updateMatrix();
    loin.updateMatrix();
    _invBody.copy(body.matrix).invert();
    _invRear.multiplyMatrices(body.matrix, loin.matrix).invert();
    for (let i = 0; i < 4; i++) {
      const leg = legs[i];
      _v.set(tgx[i], tgy[i], tgz[i]).applyMatrix4(leg.front ? _invBody : _invRear);
      solveLeg(leg, _v.x, _v.y, _v.z, softIK);
      let thU = ikThU;
      let thL = ikThL;
      let lam = ikLam;
      const tuck = tuckRollW > 0 ? tuckRollW : tuckAirW;
      if (tuck > 0) {
        if (tuckRollW > 0) solveLeg(leg, leg.side * LX * 0.9, -0.28 * S, leg.front ? 0.75 * LZ : -0.45 * LZ, 0);
        else solveLeg(leg, leg.side * LX, -0.6 * S, leg.front ? 0.7 * LZ : -0.6 * LZ, 0);
        thU = lerp(thU, ikThU, tuck);
        thL = lerp(thL, ikThL, tuck);
        lam = lerp(lam, ikLam, tuck);
      }
      leg.hip.rotation.set(-thU, 0, lam);
      leg.knee.rotation.set(thU - thL, 0, 0);
      const pa = thL - bodyPitch - (leg.front ? 0 : loin.rotation.x);
      leg.paw.rotation.set(pa, 0, 0);
      if (leg.front) {
        // Sphinx: the forearm rests on its own thickness, the paw drops flat onto the floor.
        const d = (lieFrontY - pawH) * lieShift;
        leg.paw.position.y = -L - d * Math.cos(pa);
        leg.paw.position.z = frontPawFwd - d * Math.sin(pa);
      }
    }
  }

  // ---- Precomputed postures ----
  const restY = (dzz: number): number => pawH - pivY + Math.min(0.96 * S, Math.sqrt(Math.max(0, (0.975 * S) ** 2 - (dzz / 2) ** 2)));
  const standY = restY(0);
  /** Gallop spine rocking, limited so long / short-legged dogs keep their paws reaching. */
  const rockPitch = 0.09 * Math.min(1, S / (2.5 * LZ));

  /** Rotate (y, z) about X by a. */
  const rotX = (y: number, z: number, a: number): [number, number] => [
    y * Math.cos(a) - z * Math.sin(a),
    y * Math.sin(a) + z * Math.cos(a),
  ];

  // Sit: haunches on the ground just behind the hind paws, front legs straight, rear half pitched
  // up ~42° (less if the legs can't reach). Long-backed dogs curl the spine (loin bend) so the
  // chest can stay up on short front legs.
  const sitPose = { y: standY, z: 0, pitch: 0, bend: 0 };
  let sitHipZ = -LZ;
  let sitShoulderZ = LZ;
  {
    const frontReach = 0.975 * S + pawH;
    const hipTargetZ = -LZ - 0.22 * U;
    const iHip = nodeIndex.get(legs[2].hip) ?? 0;
    const iSh = nodeIndex.get(legs[0].hip) ?? 0;
    let done = false;
    for (const leg of legs) if (leg.front) leg.hip.position.y = pivY + SIT_SHOULDER * r;
    for (let th = 42 * DEG; th >= 14 * DEG && !done; th -= 2 * DEG) {
      for (let bend = 0; bend <= 0.8 * th + 1e-6; bend += 0.025) {
        const a = -(th - bend);
        loin.rotation.set(-bend, 0, 0);
        body.position.set(0, 0, 0);
        body.rotation.set(a, 0, 0);
        computeMats();
        const bz = hipTargetZ - nodeMats[iHip].elements[14];
        body.position.set(0, 0, bz);
        computeMats();
        const by = -lowestOf(P_TORSO) + 0.004 * H;
        const shoulderY = by + nodeMats[iSh].elements[13];
        sitPose.y = by;
        sitPose.z = bz;
        sitPose.pitch = a;
        sitPose.bend = bend;
        sitHipZ = hipTargetZ;
        sitShoulderZ = nodeMats[iSh].elements[14];
        if (shoulderY <= frontReach) {
          done = true;
          break;
        }
      }
    }
    loin.rotation.set(0, 0, 0);
    for (const leg of legs) if (leg.front) leg.hip.position.y = pivY;
  }

  // Lie (sphinx): chest and belly on the ground, front legs forward, hind legs folded at the sides.
  const liePose = { y: standY, z: -0.1 * LZ, pitch: -0.03 };
  {
    body.position.set(0, 0, liePose.z);
    body.rotation.set(liePose.pitch, 0, 0);
    computeMats();
    liePose.y = -lowestOf(P_TORSO) + 0.003 * H;
  }
  /** Torso depth below the body origin: breathing grows the back, not the belly, when lying. */
  let torsoDepth = 0;
  {
    body.position.set(0, 0, 0);
    body.rotation.set(0, 0, 0);
    computeMats();
    torsoDepth = Math.max(0, -lowestOf(P_TORSO, torsoShape));
  }
  // Front paws in the sphinx: elbow resting on the floor, forearm flat forward.
  const lieFrontZ = (() => {
    const sh = rotX(pivY + 0.45 * r, LZ + 0.25 * r, liePose.pitch);
    const h = liePose.y + sh[0] - 1.05 * ru;
    const back = Math.sqrt(Math.max(0, U * U - h * h));
    return liePose.z + sh[1] + 0.97 * L - back;
  })();
  const lieFrontY = Math.max(pawH, rl, curly ? 1.75 * rl : 0);

  // Ground sniff: front lowered by `crouch`, neck pitched to `alpha`, head pitched down to `beta`.
  const NOSE_HY = noseY;
  const NOSE_HZ = noseZ + 0.9 * noseR;
  const sniffPose = { crouch: 0, alpha: NP, beta: 1.25 };
  {
    const noseYAt = (crouch: number, alpha: number, beta: number): number => {
      const dF = crouch * 0.38 * S;
      const pitch = Math.asin(clamp(dF / (2 * LZ), -0.5, 0.5));
      const by = standY - dF / 2;
      const nb = rotX(NBY, NBZ, pitch);
      const nt = rotX(nl * Math.cos(alpha), nl * Math.sin(alpha), pitch);
      const no = rotX(NOSE_HY, NOSE_HZ, beta);
      return by + nb[0] + nt[0] + no[0];
    };
    const target = 0.02;
    let found = false;
    for (let c = 0; c <= 1.0001 && !found; c += 0.05) {
      for (const beta of [1.2, 1.4, 1.6]) {
        if (noseYAt(c, 2.85, beta) > target) continue;
        let lo = NP;
        let hi = 2.85;
        for (let k = 0; k < 30; k++) {
          const mid = (lo + hi) / 2;
          if (noseYAt(c, mid, beta) > target) lo = mid;
          else hi = mid;
        }
        sniffPose.crouch = c;
        sniffPose.alpha = (lo + hi) / 2;
        sniffPose.beta = beta;
        found = true;
        break;
      }
    }
    if (!found) {
      sniffPose.crouch = 1;
      sniffPose.alpha = 2.7;
      sniffPose.beta = 1.45;
    }
  }

  // Neutral eye position in body space (first pass of the look-at aim).
  const EYE0_Y = NBY + nl * Math.cos(NP) + EYE_Y;
  const EYE0_Z = NBZ + nl * Math.sin(NP) + EYE_Z;
  const MAX_YAW = 80 * DEG;
  const MAX_PITCH_UP = 50 * DEG;
  const MAX_PITCH_DOWN = 40 * DEG;
  const LIE_NECK = 0.8;
  const ROLL_NECK = 1.95;

  const controls: DogControls = {
    lookAt: null,
    lookWeight: 0,
    gait: { phase: 0, speed: 0, turn: 0 },
    sit: 0,
    lie: 0,
    sniff: 0,
    excitement: 0,
    petHead: 0,
    petBody: 0,
    petPoint: null,
    trick: null,
  };

  const ph = (hashString(cfg.name) % 10000) / 100;

  function update(time: number): void {
    const t = time + ph;
    const c = controls;

    // ---- Trick parameters (all exactly neutral at progress 0 and 1) ----
    let env = 0;
    let lieT = 0;
    let tuckRoll = 0;
    let tuckAir = 0;
    let rollAngle = 0;
    let spin = 0;
    let lead = 0;
    let crouch = 0;
    let air = 0;
    let pitchT = 0;
    let squash = 0;
    let stepAmp = 0;
    let stepFreq = 2.4;
    if (c.trick) {
      const kind = c.trick.kind;
      const p = clamp01(c.trick.progress);
      env = trickEnvelope(kind, p);
      if (kind === "rollOver") {
        lieT = sm(0.02, 0.22, p) * (1 - sm(0.8, 0.97, p));
        tuckRoll = sm(0.17, 0.26, p) * (1 - sm(0.74, 0.83, p));
        rollAngle = (TAU * sm(0.24, 0.76, p)) % TAU;
      } else if (kind === "jump") {
        crouch = 0.14 * H * bump(0.0, 0.22, 0.32, p) + 0.1 * H * bump(0.62, 0.7, 0.95, p);
        const s = clamp01((p - 0.3) / 0.36);
        air = s <= 0 || s >= 1 ? 0 : 0.48 * H * Math.sin(Math.PI * s);
        tuckAir = bump(0.3, 0.42, 0.62, p);
        pitchT = 0.08 * bump(0.0, 0.2, 0.3, p) - 0.3 * bump(0.2, 0.32, 0.45, p) + 0.25 * bump(0.42, 0.58, 0.72, p);
        squash = bump(0.62, 0.68, 0.85, p);
      } else {
        spin = (TAU * sm(0.08, 0.92, p)) % TAU;
        lead = env;
        stepAmp = env;
        stepFreq = 3.2;
      }
    }
    const free = 1 - env;

    // ---- Posture weights ----
    const lieC = clamp01(c.lie) * free;
    const lieAll = Math.max(lieC, lieT);
    const sitW = clamp01(c.sit) * (1 - lieAll) * free;
    const post = Math.max(sitW, lieAll);
    const spd = clamp(c.gait.speed, 0, 1.2) * free * (1 - post);
    const w = gaitWeights(spd, _gw);
    const amp = gaitAmp(spd);
    const phase = c.gait.phase;
    const turnRate = clamp(c.gait.turn, -1, 1);
    const lw = c.lookAt ? clamp01(c.lookWeight) * free : 0;
    const sn = clamp01(c.sniff) * free * (1 - post);
    const snG = sn * (1 - lw);
    const pHead = clamp01(c.petHead) * free;
    const pBody = clamp01(c.petBody) * free * (1 - 0.6 * post);
    const exc = clamp01(c.excitement);

    // Turning on the spot: step in place so the paws don't visibly skate.
    const turnStep = clamp01(Math.abs(turnRate) * 2) * (1 - amp) * free * (1 - post);
    if (turnStep > stepAmp) {
      stepAmp = turnStep;
      stepFreq = 2.4;
    }

    let petSide = 0;
    if (c.petPoint && (pHead > 0 || pBody > 0)) {
      const lx = c.petPoint.x * Math.cos(spin) - c.petPoint.z * Math.sin(spin);
      petSide = clamp(lx / (0.5 * TL), -1, 1);
    }

    // ---- Breathing ----
    const pantIdle = THREE.MathUtils.smoothstep(Math.sin(t * 0.21) * 0.5 + 0.5, 0.35, 0.75);
    const pant = Math.max(pantIdle * (1 - 0.5 * snG), exc, 0.6 * pHead, 0.8 * sm(0.4, 1, spd));
    const calm = Math.sin(t * TAU * 0.28);
    const fast = Math.sin(t * TAU * 2.6);
    const breath = (1 - pant) * calm * 0.02 + pant * fast * 0.012;
    torsoShape.scale.set(
      (1 + breath) * (1 + 0.05 * squash),
      (1 + breath * 1.2) * (1 - 0.1 * squash),
      (1 + breath * 0.3) * (1 + 0.05 * squash),
    );
    torsoRear.scale.copy(torsoShape.scale);

    // ---- Gait trajectories ----
    let E = 0;
    for (let g = 0; g < 3; g++) E += w[g] * GAITS[g].exc;
    E *= S * amp;
    const ph1 = frac(phase);
    const bobAmp = 0.022 * S * amp * (w[0] + 0.7 * w[1]);
    const gallopRock = w[2] * amp;
    const bob = -bobAmp * Math.cos(2 * TAU * ph1) + gallopRock * 0.04 * S * Math.sin(TAU * (ph1 - 0.15));
    const pitchG = gallopRock * rockPitch * Math.sin(TAU * (ph1 - 0.05));

    // ---- Body pose (turn space) ----
    const sway = 0.01 * r * Math.sin(t * 0.53) + 0.005 * r * Math.sin(t * 1.37);
    const wiggle = 0.13 * pBody * Math.sin(t * TAU * 2.3);
    const PIV = 0.85 * LZ;
    let bx = sway * (1 - amp) - PIV * Math.sin(wiggle) + 0.1 * r * pBody * petSide;
    let bz = PIV * (1 - Math.cos(wiggle));
    // Highest body point of the cycle must still let the extreme paws reach the ground.
    let by = restY(E) - bobAmp - gallopRock * (0.04 * S + LZ * Math.sin(rockPitch)) + bob - 0.1 * r * pBody;
    let bp = pitchG;
    // Ground sniff: lower the front so the neck can reach.
    const dF = snG * sniffPose.crouch * 0.38 * S;
    by -= dF / 2;
    bp += Math.asin(clamp(dF / (2 * LZ), -0.5, 0.5));
    // Postures.
    by = lerp(by, sitPose.y, sitW);
    bz = lerp(bz, sitPose.z, sitW);
    bp = lerp(bp, sitPose.pitch, sitW);
    by = lerp(by, liePose.y + torsoDepth * (torsoShape.scale.y - 1), lieAll);
    bz = lerp(bz, liePose.z, lieAll);
    bp = lerp(bp, liePose.pitch, lieAll);
    bx *= 1 - 0.7 * post;
    // Tricks.
    by += air - crouch;
    bp += pitchT;
    const roll = rollAngle - 0.08 * pBody * petSide - 0.06 * lead - turnRate * 0.12 * amp;
    body.position.set(bx, by, bz);
    body.rotation.set(bp, wiggle, roll);
    loin.rotation.set(-sitPose.bend * sitW, 0, 0);
    turn.rotation.set(0, spin, 0);

    // ---- Paw targets (turn space) ----
    for (let i = 0; i < 4; i++) {
      const leg = legs[i];
      const zRest = (leg.front ? LZ : -LZ) + pawFwd;
      let gx = leg.side * LX;
      let gz = zRest;
      let gy = pawH;
      if (amp > 0) {
        let oz = 0;
        let oy = 0;
        for (let g = 0; g < 3; g++) {
          if (w[g] <= 0) continue;
          const G = GAITS[g];
          const u = frac(ph1 - G.off[i]);
          const e = G.exc * S * amp;
          if (u < G.duty) {
            oz += w[g] * e * (0.5 - u / G.duty);
          } else {
            const s = (u - G.duty) / (1 - G.duty);
            oz += w[g] * e * (-0.5 + s * s * (3 - 2 * s));
            oy += w[g] * G.lift * S * amp * Math.sqrt(Math.sin(Math.PI * s));
          }
        }
        gz += oz;
        gy += oy;
      }
      if (stepAmp > 0) {
        const s = Math.sin(t * TAU * stepFreq + leg.pair * Math.PI);
        gy += stepAmp * 0.12 * S * (s > 0 ? s : 0);
      }
      // Sit.
      if (sitW > 0) {
        const sxp = leg.front ? leg.side * LX * 0.95 : leg.side * (LX + 0.5 * ru);
        const szp = leg.front ? sitShoulderZ + pawFwd + 0.04 * S : sitHipZ + 0.5 * U;
        gx = lerp(gx, sxp, sitW);
        gy = lerp(gy, pawH, sitW);
        gz = lerp(gz, szp, sitW);
      }
      if (lieAll > 0) {
        const lxp = leg.front ? leg.side * LX * 0.95 : leg.side * (r * sx * 0.92 + 0.3 * ru);
        const lzp = leg.front ? lieFrontZ : liePose.z - LZ + 0.75 * U;
        gx = lerp(gx, lxp, lieAll);
        gy = lerp(gy, leg.front ? lieFrontY : pawH + 0.08 * ru, lieAll);
        gz = lerp(gz, lzp, lieAll);
      }
      tgx[i] = gx;
      tgy[i] = gy;
      tgz[i] = gz;
    }
    lieShift = lieAll;
    frontPawFwd = PAW_FWD * (1 - lieAll);
    sitShift = sitW;
    tuckRollW = tuckRoll;
    tuckAirW = tuckAir;
    softIK = 0.05 * S * env;
    poseLegs(bp);

    // ---- Neck & head ----
    let neckX = NP + 0.03 * Math.sin(t * 0.37) + breath * 0.5 + 0.05 * amp * (w[0] + 0.5 * w[1]) * Math.cos(2 * TAU * ph1);
    neckX += 0.25 * gallopRock;
    neckX = lerp(neckX, sniffPose.alpha, snG);
    neckX += sitW * -sitPose.pitch * 0.55;
    neckX = lerp(neckX, LIE_NECK, lieAll);
    neckX = lerp(neckX, ROLL_NECK, tuckRoll);
    neckX -= 0.12 * pHead;
    let neckY = 0.4 * lead + turnRate * 0.3 * Math.max(amp, turnStep);

    const idleW = (1 - 0.7 * amp) * (1 - snG);
    const look = (0.35 * Math.sin(t * 0.31) * Math.sin(t * 0.13 + 1.1) + 0.06 * Math.sin(t * 0.83)) * idleW;
    const tilt = 0.3 * pulse(t, 7.3, 0.28, 0) * (Math.sin(t * 0.07) >= 0 ? 1 : -1) * idleW;
    const sniffBob = 0.04 * sn * Math.sin(t * TAU * 6) * (Math.sin(t * 1.7) > -0.2 ? 1 : 0);
    _qIdle.setFromEuler(
      _e.set(
        -neckX - bp + 0.08 * Math.sin(t * 0.29 + 2) * idleW + snG * sniffPose.beta + sniffBob,
        look * (1 - 0.6 * lw) + 0.5 * lead + turnRate * 0.2,
        tilt,
        "XYZ",
      ),
    );

    let eyeDX = 0;
    let eyeDY = 0;
    if (lw > 0 && c.lookAt) {
      const ca = Math.cos(spin);
      const sa = Math.sin(spin);
      const T = c.lookAt;
      _tb.set(T.x * ca - T.z * sa, T.y, T.x * sa + T.z * ca).applyMatrix4(_invBody);
      const share = 0.4 + 0.35 * sn;

      let dx = _tb.x;
      let dy = _tb.y - EYE0_Y;
      let dz = _tb.z - EYE0_Z;
      let yaw = clamp(Math.atan2(dx, dz), -MAX_YAW, MAX_YAW);
      let pit = clamp(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)), -MAX_PITCH_DOWN - 0.4 * sn, MAX_PITCH_UP);
      neckX = lerp(neckX, neckX - share * pit - (1 - post) * 0.3 * sn * Math.min(0, pit), lw);
      neckY = lerp(neckY, share * yaw, lw);

      const snx = Math.sin(neckX);
      let hx = neck.position.x + nl * snx * Math.sin(neckY);
      let hy = neck.position.y + nl * Math.cos(neckX);
      let hz = neck.position.z + nl * snx * Math.cos(neckY);
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
      pit = clamp(rawPit, -MAX_PITCH_DOWN - 0.5 * sn, MAX_PITCH_UP);
      eyeDX = clamp((rawYaw - yaw) / 0.4, -1, 1) * lw;
      eyeDY = clamp((rawPit - pit) / 0.4, -1, 1) * lw;

      _qNeck.setFromEuler(_e.set(neckX, neckY, 0, "YXZ"));
      _qAim.setFromEuler(_e.set(-pit + sniffBob, yaw, 0, "YXZ"));
      _qAim.premultiply(_qNeck.invert());
      head.quaternion.copy(_qIdle).slerp(_qAim, lw);
    } else {
      head.quaternion.copy(_qIdle);
    }
    neck.rotation.set(neckX, neckY, 0);
    if (pHead > 0) {
      _qExtra.setFromEuler(_e.set(-0.3 * pHead, 0, -0.25 * petSide * pHead, "XYZ"));
      head.quaternion.multiply(_qExtra);
    }

    // Jaw: almost closed when calm, open & panting otherwise; closed while sniffing.
    jaw.rotation.x = 0.04 + pant * (1 - 0.8 * sn) * (0.22 + 0.08 * fast) + (cfg.face.tongueOut ? 0.06 : 0);
    tongueOut.rotation.x = 1.0 - 0.3 * pant + 0.05 * fast * pant;
    tongueOut.scale.setScalar(Math.max(0.001, 1 - snG));

    // ---- Ears ----
    // Head orientation in turn space: world-down expressed in head space, for hanging ears.
    body.updateMatrix();
    neck.updateMatrix();
    head.updateMatrix();
    _m.multiplyMatrices(body.matrix, neck.matrix).multiply(head.matrix);
    const me = _m.elements;
    const dxh = -me[1];
    const dyh = -me[5];
    const dzh = -me[9];
    const flickL = pulse(t, 5.9, 0.08, 1.7);
    const flickR = pulse(t, 6.7, 0.08, 4.1);
    const airN = air / (0.48 * H);
    for (let i = 0; i < 2; i++) {
      const ear = ears[i];
      const side = i === 0 ? -1 : 1;
      const flick = i === 0 ? flickL : flickR;
      if (hanging) {
        const gx = clamp(Math.atan2(-dzh, -dyh), -1.6, 1.6);
        const gz = clamp(Math.atan2(dxh, -dyh), -1.2, 1.2);
        const earX = -0.25 * exc + 0.6 * pHead - 0.5 * airN + 0.05 * Math.sin(t * 1.1 + i) - 0.3 * flick;
        const splay = (style === "long" ? 0.1 : 0.16) + 0.2 * flick + 0.15 * exc * (1 - pHead);
        ear.rotation.set(0.8 * gx + earX, 0, 0.7 * gz + side * splay);
      } else if (style === "pointy") {
        ear.rotation.set(0.1 + 0.12 * exc - 0.75 * pHead - 0.35 * airN - 0.2 * flick, side * 0.15 * flick, -side * (0.2 + 0.25 * pHead));
      } else {
        ear.rotation.set(0.05 + 0.1 * exc - 0.6 * pHead - 0.2 * flick, 0, -side * (0.25 + 0.2 * pHead));
        earFolds[i].rotation.set(2.0 - 0.35 * exc + 0.3 * pHead - 0.3 * airN, 0, 0);
      }
    }

    // ---- Eyes ----
    const blink = 1 - 0.9 * pulse(t, 4.3, 0.04, 0.5);
    const squint = 1 - 0.65 * pHead;
    const eyeS = Math.max(0.08, Math.min(blink, squint));
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      eyes[i].scale.set(1, eyeS, 1);
      eyes[i].position.set(side * EYE_X + 0.1 * er * eyeDX, EYE_Y + 0.08 * er * eyeDY, EYE_Z);
    }

    // ---- Tail ----
    const slow = Math.sin(t * 0.17 + 0.5) * 0.5 + 0.5;
    const wagE = Math.max(exc, 0.8 * pHead);
    const wag =
      ((1 - wagE) * (1 - pBody) * (0.15 + 0.2 * slow) * Math.sin(t * TAU * 1.5) +
        wagE * (1 - pBody) * 0.75 * Math.sin(t * TAU * 4) +
        pBody * 0.6 * Math.sin(t * TAU * 6.5)) *
      tailWagAmp;
    const groundW = Math.max(sitW, lieAll) * (1 - tuckRoll);
    let tailA = tailA0 + 0.1 * slow * (1 - wagE) + 0.35 * Math.max(wagE, pBody) * (tailStyle === "curled" ? 0.3 : 1) + 0.04 * Math.sin(t * 0.7);
    tailA -= 0.25 * amp * w[2]; // streams out behind at a gallop
    let bend = tailBend;
    if (groundW > 0 && tailStyle !== "curled") {
      // Lie the tail along the floor behind the dog.
      _m.multiplyMatrices(body.matrix, loin.matrix);
      _v.copy(tailBase.position).applyMatrix4(_m);
      const delta = Math.asin(clamp((_v.y - 1.1 * tr0) / Math.max(tl, 1e-3), 0, 0.95));
      const groundA = -(Math.PI / 2 + delta) - bp - loin.rotation.x;
      tailA = lerp(tailA, groundA, groundW);
      bend = lerp(bend, 0, groundW);
    }
    if (tuckRoll > 0) {
      tailA = lerp(tailA, -Math.PI / 2, tuckRoll);
      bend = lerp(bend, 0, tuckRoll);
    }
    tailBase.rotation.set(0, wag * (1 - 0.7 * env) * (1 - 0.5 * groundW) - 0.5 * lead + 0.5 * lieC * (1 - wagE), 0);
    tailPitch.rotation.set(tailA, 0, 0);
    for (let i = 1; i < nSeg; i++) tailSegs[i].rotation.set(bend + 0.04 * Math.sin(t * 1.3 + i) * (1 - groundW), 0, 0);

    // ---- Floor guard ----
    computeMats();
    let minY = lowestOf(P_BODY);
    if (minY < 0) {
      body.position.y -= minY;
      poseLegs(bp);
      computeMats();
      minY = lowestOf(P_BODY);
      if (minY < 0) {
        body.position.y -= minY;
        computeMats();
      }
    }
    // Dangling parts swing up instead of lifting the dog.
    for (let k = 0; k < 8; k++) {
      if (lowestOf(P_TAIL) >= 0) break;
      tailPitch.rotation.x += Math.cos(roll) >= 0 ? 0.12 : -0.12;
      for (let i = 1; i < nSeg; i++) tailSegs[i].rotation.x *= 0.8;
      computeMats();
    }
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < 8; k++) {
        if (lowestOf(P_EAR, ears[i]) >= 0) break;
        const side = i === 0 ? -1 : 1;
        if (hanging) ears[i].rotation.z += side * 0.15;
        else ears[i].rotation.x -= 0.15;
        computeMats();
      }
    }
  }

  // ---- Queries ----
  function getZones(out: DogZones): DogZones {
    root.updateWorldMatrix(true, true);
    const s = root.matrixWorld.getMaxScaleOnAxis();
    head.localToWorld(out.head.center.set(0, CY, CZ + 0.3 * hr + 0.25 * mlen));
    out.head.radius = (1.45 * hr + 0.25 * mlen) * s;
    body.localToWorld(out.body.center.set(0, 0.25 * r, -0.05 * TL));
    out.body.radius = Math.max(0.42 * TL + 0.2 * r, 1.6 * r) * s;
    return out;
  }
  function getEyesWorld(out: THREE.Vector3): THREE.Vector3 {
    root.updateWorldMatrix(true, true);
    return head.localToWorld(out.set(0, EYE_Y, EYE_Z + 0.5 * er));
  }
  function getNoseWorld(out: THREE.Vector3): THREE.Vector3 {
    root.updateWorldMatrix(true, true);
    return head.localToWorld(out.set(0, noseY, noseZ + 0.9 * noseR));
  }

  function dispose(): void {
    const geos = new Set<THREE.BufferGeometry>();
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) geos.add(o.geometry as THREE.BufferGeometry);
    });
    for (const g of geos) g.dispose();
    for (const m of matCache.values()) m.dispose();
    matCache.clear();
    root.removeFromParent();
  }

  // Neutral pose for measurements.
  update(0);
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  const height = box.max.y;
  nose.updateWorldMatrix(true, false);
  const noseWorld = getNoseWorld(new THREE.Vector3());
  const length = noseWorld.z - (body.position.z - TL / 2 - 0.02 * r);

  const dog: DogCharacter = {
    root,
    update,
    config: cfg,
    controls,
    height,
    length,
    getZones,
    getEyesWorld,
    getNoseWorld,
    dispose,
  };
  gaitInfo.set(dog, { leg: S, height: H });
  return dog;
}

export function isDogCharacter(c: Character): c is DogCharacter {
  return "controls" in c && "getZones" in c && "getEyesWorld" in c && "dispose" in c;
}
