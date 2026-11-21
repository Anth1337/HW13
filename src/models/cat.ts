import * as THREE from "three";
import type { Character } from "./types";
import type { PetControls, PetZones, TrickKind } from "../dog/types";
import type { CatBreed, CatCharacter, CatConfig, CatTailStyle } from "../cat/types";
import { catBreedPreset, sanitizeCatConfig } from "../cat/config";

/*
 * Parametric cat built from primitives with flat colours. Same architecture as src/models/dog.ts:
 * faces +Z, origin on the ground under the body centre, real-world scale from the breed height range.
 *
 * Joint hierarchy (every joint is a THREE.Group so rotations pivot naturally):
 *   root
 *   └─ turn (pounce lunge offset)
 *      └─ body (torso centre: position, pitch, roll)
 *         ├─ torsoShape (breathing scale) ─ torso / chest / pattern overlays
 *         ├─ loin (arch / sit curl / butt wiggle) ─ torsoRear, hind legs, tail
 *         ├─ hip ×4 ─ knee ─ paw            (2-bone IK towards paw targets)
 *         ├─ tailBase (sway / wrap yaw) ─ tailPitch ─ seg0 ─ seg1 … (per-segment curl + side wrap)
 *         └─ neck ─ head ─┬─ jaw ─ tongue
 *                         ├─ ear ×2
 *                         └─ eye ×2 (slit pupils)
 *
 * The pose is a pure function of (t, config, controls). Paws are IK targets in `turn` space so they
 * stay planted; tricks blend with envelopes that are exactly 0 at progress 0 and 1; a floor guard
 * lifts the body (or swings the tail / ears up) so nothing goes below y = 0.
 */

// ---- Breed proportions ------------------------------------------------------------------

interface CatShape {
  /** torso depth / shoulder height */
  chest: number;
  /** torso length / shoulder height */
  length: number;
  /** torso width / depth */
  width: number;
  /** cranium radius / shoulder height */
  head: number;
  /** neck length / shoulder height */
  neck: number;
  /** ear size multiplier */
  ear: number;
  /** tail length / shoulder height */
  tail: number;
  /** cheek (jowl) size multiplier */
  cheek: number;
}

const SHAPES: Record<CatBreed, CatShape> = {
  shorthair: { chest: 0.54, length: 1.38, width: 1.0, head: 0.26, neck: 0.22, ear: 1.0, tail: 1.15, cheek: 1.0 },
  siamese: { chest: 0.47, length: 1.45, width: 0.86, head: 0.22, neck: 0.27, ear: 1.15, tail: 1.3, cheek: 0.75 },
  maineCoon: { chest: 0.56, length: 1.48, width: 1.02, head: 0.25, neck: 0.24, ear: 1.1, tail: 1.15, cheek: 1.0 },
  persian: { chest: 0.6, length: 1.3, width: 1.12, head: 0.28, neck: 0.17, ear: 0.7, tail: 0.95, cheek: 1.25 },
  british: { chest: 0.6, length: 1.3, width: 1.12, head: 0.29, neck: 0.18, ear: 0.8, tail: 0.95, cheek: 1.3 },
  sphynx: { chest: 0.5, length: 1.38, width: 0.94, head: 0.25, neck: 0.25, ear: 1.2, tail: 1.15, cheek: 0.85 },
  bengal: { chest: 0.52, length: 1.48, width: 0.94, head: 0.235, neck: 0.24, ear: 0.95, tail: 1.1, cheek: 0.9 },
  ragdoll: { chest: 0.58, length: 1.45, width: 1.06, head: 0.26, neck: 0.22, ear: 0.95, tail: 1.1, cheek: 1.1 },
  scottishFold: { chest: 0.56, length: 1.36, width: 1.05, head: 0.28, neck: 0.2, ear: 0.85, tail: 1.0, cheek: 1.2 },
  moggy: { chest: 0.54, length: 1.4, width: 1.0, head: 0.26, neck: 0.22, ear: 1.0, tail: 1.1, cheek: 1.0 },
};

// ---- Gaits --------------------------------------------------------------------------------

/** Leg order everywhere: 0 LF, 1 RF, 2 LH, 3 RH (left = +X when facing +Z). */
interface GaitDef {
  duty: number;
  off: [number, number, number, number];
  exc: number;
  lift: number;
}

// Walk: 4-beat lateral sequence, low smooth steps (cats barely lift their paws).
const WALK: GaitDef = { duty: 0.64, off: [0.25, 0.75, 0, 0.5], exc: 0.72, lift: 0.09 };
// Trot: diagonal pairs.
const TROT: GaitDef = { duty: 0.46, off: [0, 0.5, 0.5, 0], exc: 0.86, lift: 0.15 };
// Half-bound: hind legs almost together, then the fronts, long reach.
const GALLOP: GaitDef = { duty: 0.3, off: [0.56, 0.46, 0, 0.06], exc: 1.15, lift: 0.24 };
const GAITS = [WALK, TROT, GALLOP];

function gaitWeights(speed: number, out: number[]): number[] {
  const trot = sm(0.42, 0.58, speed) * (1 - sm(0.74, 0.9, speed));
  const gallop = sm(0.74, 0.9, speed);
  out[0] = 1 - trot - gallop;
  out[1] = trot;
  out[2] = gallop;
  return out;
}

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
function sm(a: number, b: number, x: number): number {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const u = (x - a) / (b - a);
  return u * u * (3 - 2 * u);
}
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

/** Cat tricks only; dog trick kinds are no-ops (0). */
function trickEnvelope(kind: TrickKind, p: number): number {
  switch (kind) {
    case "pounce":
      return sm(0, 0.08, p) * (1 - sm(0.9, 1, p));
    case "stretch":
    case "groom":
      return sm(0, 0.1, p) * (1 - sm(0.9, 1, p));
    default:
      return 0;
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

// ---- Geometry helpers ---------------------------------------------------------------------

function ell(rx: number, ry: number, rz: number, w = 14, h = 10): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz);
}
function capY(radius: number, total: number, radial = 12, cap = 3): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(radius, Math.max(total - 2 * radius, 0.0005), cap, radial);
}
function capZ(radius: number, total: number, radial = 12, cap = 3): THREE.BufferGeometry {
  return capY(radius, total, radial, cap).rotateX(Math.PI / 2);
}
/** Open band around +Y (a stripe ring), `arc` radians centred on +Z. */
function band(radius: number, width: number, arc = TAU, radial = 12): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius, radius, width, radial, 1, true, -arc / 2, arc);
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

// ---- Leg IK (same solver as the dog) ------------------------------------------------------

let ikThU = 0;
let ikThL = 0;
let ikLam = 0;

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
  pair: number;
}

// ---- Module scratch -----------------------------------------------------------------------

const _invBody = new THREE.Matrix4();
const _invRear = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _tb = new THREE.Vector3();
const _lick = new THREE.Vector3();
const _wipe = new THREE.Vector3();
const _e = new THREE.Euler();
const _qIdle = new THREE.Quaternion();
const _qAim = new THREE.Quaternion();
const _qNeck = new THREE.Quaternion();
const _qExtra = new THREE.Quaternion();
const _gw = [1, 0, 0];

const gaitInfo = new WeakMap<CatCharacter, { leg: number; height: number }>();

/**
 * Same contract as dogGaitInfo: stride (meters per gait cycle) at `speed`, a suggested ground
 * speed and the matching cycle rate, so paws don't slide.
 */
export function catGaitInfo(
  cat: CatCharacter,
  speed: number,
): { stride: number; metersPerSecond: number; cyclesPerSecond: number } {
  const info = gaitInfo.get(cat) ?? { leg: 0.17, height: 0.25 };
  const s = clamp(speed, 0, 1.2);
  const w = gaitWeights(s, [0, 0, 0]);
  const a = gaitAmp(s);
  let stride = 0;
  for (let g = 0; g < 3; g++) stride += (w[g] * GAITS[g].exc) / GAITS[g].duty;
  stride *= info.leg * a;
  const mps = info.height * 3.8 * s;
  return { stride, metersPerSecond: mps, cyclesPerSecond: stride > 1e-6 ? mps / stride : 0 };
}

// ---- Cat ----------------------------------------------------------------------------------

export function createCatCharacter(input: CatConfig): CatCharacter {
  const cfg = sanitizeCatConfig(input);
  const shape = SHAPES[cfg.breed];
  const preset = catBreedPreset(cfg.breed);
  const male = cfg.sex === "male";
  const fl = cfg.coat.fluff;
  const build = cfg.build;
  const rng = mulberry32(hashString(`${cfg.name}|${cfg.breed}|${cfg.coat.pattern}`));

  // ---- Dimensions (meters) ----
  const H = lerp(preset.heightRange[0], preset.heightRange[1], cfg.size) * (male ? 1.03 : 0.97);
  const r0 = (shape.chest * H) / 2;
  const legF = 1 + 0.4 * (cfg.legLength - 0.5);
  const pivH = clamp((H - 1.25 * r0) * legF, 0.3 * H, H - 1.25 * 0.12 * H);
  const r = (H - pivH) / 1.25;
  const pivY = -0.25 * r;
  const sx = shape.width * (0.86 + 0.3 * build) * (male ? 1.03 : 0.98) * (1 + 0.15 * fl);
  const sy = 1 + 0.05 * fl;
  const TL = shape.length * H;
  const LX = 0.55 * r * sx;
  const LZ = Math.max(TL / 2 - 0.85 * r, 0.3 * r);
  const ru = 0.3 * r * (0.85 + 0.3 * build) * (1 + 0.15 * fl);
  const rl = 0.8 * ru;
  const pawR = 1.15 * ru;
  const pawH = 0.62 * ru;
  const PAW_FWD = 0.3 * pawR;
  const S = (pivH - pawH) / 0.96;
  const U = 0.5 * S;
  const L = 0.5 * S;

  const hr = shape.head * H * (male ? 1.05 : 0.97) * (1 + 0.06 * fl);
  const mz = cfg.face.muzzle;
  const csx = 0.95 + 0.1 * build;
  const csy = 0.88;
  const csz = 0.88 + 0.22 * mz;
  const CY = 0.1 * hr;
  const CZ = 0.3 * hr;
  const nl = shape.neck * H;
  const nr = 0.62 * hr * (0.9 + 0.2 * build) * (1 + 0.2 * fl);
  const NP = 0.85;
  const NBY = 0.3 * r;
  const NBZ = TL / 2 - 0.65 * r;
  const es = shape.ear * hr;
  const tailStyle: CatTailStyle = cfg.tail;
  const bob = tailStyle === "bob";
  const tl = shape.tail * H * (bob ? 0.22 : 1);

  // ---- Colours / materials (one per colour) ----
  const primary = cfg.coat.primary;
  const secondary = cfg.coat.secondary;
  const pattern = cfg.coat.pattern;
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
  const lightM = mat(mixHex(primary, "#fbf6ee", 0.4));
  const whiteM = mat("#f4f1ea");
  const calico = pattern === "calico";
  const point = pattern === "colorpoint";
  const white2 = pattern === "bicolor" || pattern === "tuxedo";
  const lighter = pattern === "tabby" || pattern === "spotted";
  const baseM = calico ? whiteM : furM;
  const bellyM = white2 ? secM : lighter ? lightM : baseM;
  const sockM = pattern === "bicolor" || point ? secM : baseM;
  const pawM = white2 || point ? secM : baseM;
  const muzzleM = white2 || point ? secM : lighter ? lightM : baseM;
  const earM = point ? secM : calico ? furM : baseM;
  const tailM = point ? secM : calico ? furM : baseM;
  const ringM = tailStyle === "ringed" || pattern === "tabby" ? secM : tailM;
  const tuftM = pattern === "tabby" ? secM : mat(mixHex(primary, "#1a1412", 0.55));
  const noseM = mat(cfg.face.noseColor, 0.5);
  const eyeM = mat(cfg.face.eyeColor, 0.3);
  const pupilM = mat("#0b0a09", 0.3);
  const glintM = mat("#ffffff", 0.3);
  const innerEarM = mat(mixHex(point ? secondary : primary, "#e8a6a0", 0.6));
  const collarM = mat(cfg.collar.color, 0.6);
  const bellM = mat("#d4b13a", 0.35);
  const mouthM = mat("#4a2224");
  const tongueM = mat("#e58a98", 0.7);
  const whiskerM = mat("#f2efe8", 0.6);

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
  root.name = `cat:${cfg.name}`;
  const turn = group(root);
  const body = group(turn, 0, H - r, 0);
  body.rotation.order = "YXZ";
  const torsoShape = group(body);
  torsoShape.name = "torso";
  const zJ = Math.min(-LZ + 0.9 * r, -0.05 * TL);
  const loin = group(body, 0, 0, zJ);
  const torsoRear = group(loin);
  torsoRear.name = "torsoRear";
  const addT = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh =>
    z < zJ ? add(torsoRear, geo, m, P_TORSO, x, y, z - zJ) : add(torsoShape, geo, m, P_TORSO, x, y, z);

  // ---- Torso ----
  {
    const zf0 = zJ - 0.6 * r;
    const zr1 = zJ + 0.6 * r;
    addT(capZ(r, TL / 2 - zf0, 20, 5).scale(sx, sy, 1), baseM, 0, 0, (TL / 2 + zf0) / 2);
    addT(capZ(r, zr1 + TL / 2, 20, 5).scale(sx, sy, 1), baseM, 0, 0, (zr1 - TL / 2) / 2 - 1e-4);
  }
  const chestZ = LZ + 0.05 * r;
  const chestR = [1.02 * r * sx, 1.18 * r * sy, 0.95 * r];
  const chestY = -0.16 * r;
  addT(ell(chestR[0], chestR[1], chestR[2], 18, 12), baseM, 0, chestY, chestZ);
  const rumpZ = -LZ - 0.05 * r;
  const rumpR = [1.0 * r * sx, 1.0 * r * sy, 0.92 * r];
  addT(ell(rumpR[0], rumpR[1], rumpR[2], 16, 12), baseM, 0, 0.04 * r, rumpZ);

  const span = (a: number, b: number): [number, number] => [(a + b) / 2, (b - a) / 2];
  if (bellyM !== baseM) {
    const [fc, fr] = span(zJ - 0.03 * TL, 0.4 * TL);
    const [rc, rr] = span(-0.34 * TL, zJ + 0.03 * TL);
    addT(ell(0.72 * r * sx, 0.5 * r, fr, 16, 10), bellyM, 0, -0.62 * r, fc);
    addT(ell(0.7 * r * sx, 0.48 * r, rr, 14, 8), bellyM, 0, -0.6 * r, rc - 1e-4);
    // Chest bib.
    addT(ell(0.7 * r * sx, 0.85 * r, 0.5 * r, 14, 10), bellyM, 0, -0.28 * r, chestZ + 0.52 * r);
  }

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
        const c = fr ? new THREE.Vector3(0, chestY, chestZ) : new THREE.Vector3(0, 0.04 * r, rumpZ);
        const R = fr ? chestR : rumpR;
        const cz = rng() * 0.9 + 0.1;
        const szz = Math.sqrt(1 - cz * cz);
        const dir = new THREE.Vector3(szz * Math.cos(phi), szz * Math.sin(phi), fr ? cz : -cz);
        p = new THREE.Vector3(c.x + R[0] * dir.x, c.y + R[1] * dir.y, c.z + R[2] * dir.z);
        n = new THREE.Vector3(dir.x / R[0], dir.y / R[1], dir.z / R[2]).normalize();
      }
      if (n.y >= minUp) return { p, n };
    }
    return { p: new THREE.Vector3(0, r * sy, 0), n: new THREE.Vector3(0, 1, 0) };
  };
  const spotGeos = new Map<number, THREE.BufferGeometry>();
  const spot = (parent: THREE.Object3D | null, s: SurfPt, radius: number, m: THREE.Material, part: number, sink = 0.55): void => {
    const key = Math.round(radius * 4000);
    let g = spotGeos.get(key);
    if (!g) {
      g = ell(key / 4000, key / 4000, key / 4000, 10, 7);
      spotGeos.set(key, g);
    }
    const c = s.p.clone().addScaledVector(s.n, -sink * radius);
    if (parent) add(parent, g, m, part, c.x, c.y, c.z);
    else addT(g, m, c.x, c.y, c.z);
  };

  if (pattern === "spotted") {
    for (let i = 0; i < 28; i++) spot(null, torsoSurface(-0.45), r * (0.09 + 0.07 * rng()), secM, P_TORSO);
  } else if (calico) {
    for (let i = 0; i < 5; i++) spot(null, torsoSurface(-0.1), r * (0.42 + 0.2 * rng()), i % 2 ? secM : furM, P_TORSO, 0.72);
  } else if (pattern === "tabby") {
    // Thin darker bands over the back and sides, plus a dorsal stripe.
    const zA = rumpZ + 0.3 * r;
    const zB = chestZ - 0.5 * r;
    const nb = 7;
    for (let i = 0; i < nb; i++) {
      const z = lerp(zA, zB, (i + 0.5) / nb);
      const arc = (1.05 + 0.25 * rng()) * Math.PI;
      // band() is centred on +Z; rotateX(-π/2) turns its axis to +Z and its centre to +Y (the back).
      addT(band(1.015 * r, 0.13 * r, arc, 18).rotateX(-Math.PI / 2).scale(sx, sy, 1), secM, 0, 0, z);
    }
    const [dc, dr] = span(zA, zB);
    addT(ell(0.14 * r * sx, 0.06 * r, dr, 10, 6), secM, 0, 0.99 * r * sy, dc);
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
    if (front) add(hip, ell(1.15 * ru, 1.9 * ru, 1.5 * ru, 12, 9), baseM, P_LEG, 0, -0.07 * U, 0);
    else add(hip, ell(1.45 * ru * (1 + 0.3 * fl), 2.4 * ru, 2.1 * ru * (1 + 0.25 * fl), 12, 9), baseM, P_LEG, 0, -0.16 * U, -0.1 * ru);
    add(hip, capY(ru, U + 1.1 * ru, 10), baseM, P_LEG, 0, -U / 2, 0);
    if (fl > 0.5 && !front) {
      // Britches.
      const f = sm(0.5, 1, fl);
      add(hip, ell(1.1 * ru, 0.5 * U, (1 + 0.8 * f) * ru, 8, 6), baseM, P_LEG, 0, -0.45 * U, -0.9 * ru);
    }
    const knee = group(hip, 0, -U, 0);
    add(knee, capY(rl, L + 0.2 * rl, 10), sockM, P_LEG, 0, -L / 2 + 0.25 * rl, 0);
    const paw = add(knee, ell(pawR, pawH, 1.15 * pawR, 12, 8), pawM, P_LEG, 0, -L, PAW_FWD);
    if (pattern === "tabby") {
      for (const y of [0.35, 0.7]) {
        add(hip, band(1.07 * ru, 0.12 * U, TAU, 10), secM, P_LEG, 0, -U * y, 0);
        if (sockM === baseM) add(knee, band(1.08 * rl, 0.12 * L, TAU, 10), secM, P_LEG, 0, -L * y, 0);
      }
    } else if (pattern === "spotted") {
      const a = rng() * TAU;
      spot(hip, { p: new THREE.Vector3(ru * Math.cos(a), -U * 0.5, ru * Math.sin(a)), n: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)) }, ru * 0.5, secM, P_LEG);
    }
    paw.name = `paw${hip.name}`;
    legs.push({ hip, knee, paw, side, front, pair: (front ? side > 0 : side < 0) ? 0 : 1 });
  }

  // ---- Neck ----
  const neck = group(body, 0, NBY, NBZ);
  neck.rotation.order = "YXZ";
  add(neck, new THREE.SphereGeometry(1.25 * nr, 14, 10), baseM, P_NECK);
  add(neck, new THREE.CylinderGeometry(0.9 * nr, 1.1 * nr, nl * 1.1, 14).translate(0, nl * 0.48, 0), baseM, P_NECK);
  if (bellyM !== baseM) add(neck, ell(0.8 * nr, 0.55 * nl + 0.3 * nr, 0.6 * nr, 10, 8), bellyM, P_NECK, 0, 0.4 * nl, 0.45 * nr);
  const ruff = fl > 0.35;
  if (ruff) {
    const f = sm(0.35, 1, fl);
    add(neck, ell(nr * (1.3 + 0.6 * f), nr * (1.15 + 0.5 * f), nr * (1.25 + 0.55 * f), 14, 10), bellyM, P_NECK, 0, 0.2 * nl, 0.2 * nr);
  }
  if (cfg.collar.enabled) {
    const collarY = 0.45 * nl;
    const collarR = nr * (1.1 - 0.2 * 0.45) + 0.1 * nr + (ruff ? 0.15 * nr * fl : 0);
    const tube = 0.12 * nr + 0.002;
    add(neck, new THREE.TorusGeometry(collarR, tube, 6, 22).rotateX(Math.PI / 2), collarM, P_NECK, 0, collarY, 0);
    if (cfg.collar.bell) {
      const br = 0.3 * nr;
      const bz = collarR + 0.6 * br;
      const by = collarY - tube - 0.75 * br;
      add(neck, new THREE.SphereGeometry(br, 10, 8), bellM, P_NECK, 0, by, bz);
      add(neck, new THREE.BoxGeometry(0.15 * br, 0.9 * br, 0.3 * br), pupilM, P_NONE, 0, by - 0.35 * br, bz + 0.8 * br);
    }
  }

  // ---- Head ----
  const head = group(neck, 0, nl, 0);
  add(head, ell(csx * hr, csy * hr, csz * hr, 18, 14), baseM, P_HEAD, 0, CY, CZ);
  const craniumZ = (x: number, y: number): number =>
    CZ + csz * hr * Math.sqrt(Math.max(0, 1 - (x / (csx * hr)) ** 2 - ((y - CY) / (csy * hr)) ** 2));

  // Cheeks (jowls): wider for toms and cobby breeds, puffier when fluffy.
  const cheekF = shape.cheek * (male ? 1.12 : 1) * (1 + 0.3 * fl);
  for (const side of [-1, 1]) {
    add(head, ell(0.5 * hr * cheekF, 0.4 * hr * Math.sqrt(cheekF), 0.48 * hr, 12, 9), point ? secM : baseM, P_HEAD, side * 0.42 * hr * csx, CY - 0.3 * hr, CZ + 0.18 * hr);
  }
  // Colourpoint: darker mask over the front of the face.
  if (point) add(head, ell(csx * hr * 0.78, csy * hr * 0.74, csz * hr * 0.72, 16, 12), secM, P_HEAD, 0, CY - 0.17 * hr, CZ + 0.31 * csz * hr);

  // Muzzle: two whisker pads + chin, pushed forward by the muzzle slider (flat → wedge).
  const MY = CY - 0.38 * hr;
  const pr = 0.24 * hr;
  const zFace = craniumZ(0, MY);
  const mlen = hr * (0.02 + 0.42 * mz);
  const padZ = zFace - 0.55 * pr + mlen;
  if (mlen > 0.12 * hr) {
    const [bc, brz] = span(CZ, padZ + 0.3 * pr);
    add(head, ell(0.3 * hr, 0.26 * hr, brz, 12, 8), point ? secM : baseM, P_HEAD, 0, MY + 0.16 * hr, bc);
  }
  for (const side of [-1, 1]) add(head, new THREE.SphereGeometry(pr, 12, 9), muzzleM, P_HEAD, side * 0.16 * hr, MY, padZ);
  if (pattern === "bicolor") {
    // White blaze up the nose bridge.
    add(head, ell(0.13 * hr, 0.42 * hr, 0.1 * hr, 10, 8), secM, P_HEAD, 0, CY + 0.05 * hr, craniumZ(0, CY + 0.05 * hr) - 0.05 * hr);
  } else if (pattern === "tabby") {
    // Forehead "M" and cheek stripes.
    for (const x of [-0.2, 0, 0.2]) {
      const y = CY + (x === 0 ? 0.5 : 0.42) * hr;
      const m = add(head, ell(0.045 * hr, 0.25 * hr, 0.05 * hr, 8, 6), secM, P_NONE, x * hr, y, craniumZ(x * hr, y) - 0.01 * hr);
      m.rotation.set(-0.6, 0, -x * 1.2);
    }
    for (const side of [-1, 1]) {
      const m = add(head, ell(0.3 * hr, 0.04 * hr, 0.05 * hr, 8, 6), secM, P_NONE, side * 0.62 * hr * csx, CY - 0.08 * hr, CZ + 0.5 * hr);
      m.rotation.set(0, side * 0.9, side * 0.25);
    }
  } else if (calico) {
    const side = rng() < 0.5 ? -1 : 1;
    add(head, new THREE.SphereGeometry(0.62 * hr, 14, 10), furM, P_HEAD, side * 0.42 * hr, CY + 0.22 * hr, CZ + 0.05 * hr);
    add(head, new THREE.SphereGeometry(0.55 * hr, 14, 10), secM, P_HEAD, -side * 0.45 * hr, CY + 0.35 * hr, CZ - 0.12 * hr);
  } else if (pattern === "spotted") {
    for (let i = 0; i < 4; i++) {
      const x = (rng() - 0.5) * 0.9 * hr;
      const y = CY + (0.25 + 0.4 * rng()) * hr;
      add(head, new THREE.SphereGeometry(0.07 * hr, 8, 6), secM, P_NONE, x, y, craniumZ(x, y) - 0.04 * hr);
    }
  }
  // Nose: small inverted triangle on top of the pads.
  const noseR = 0.11 * hr * (0.9 + 0.2 * mz);
  const noseY = MY + 0.17 * hr;
  const noseZ = padZ + 0.72 * pr;
  const nose = add(head, new THREE.ConeGeometry(noseR, 0.9 * noseR, 3).rotateX(Math.PI).scale(1, 1, 0.6), noseM, P_HEAD, 0, noseY, noseZ);

  // Whiskers: three thin rods per side fanning out from the pads.
  if (cfg.face.whiskers) {
    const wl = 1.25 * hr;
    const wg = new THREE.CylinderGeometry(0.006 * hr + 0.0002, 0.02 * hr + 0.0003, wl, 4).translate(0, wl / 2, 0).rotateZ(-Math.PI / 2);
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const wm = add(head, wg, whiskerM, P_NONE, side * 0.26 * hr, MY + (0.04 - 0.06 * k) * hr, padZ + 0.3 * pr);
        wm.castShadow = false;
        // Fan out sideways, slightly back and down.
        wm.rotation.set(0, side > 0 ? 0.3 : Math.PI - 0.3, 0.15 - 0.15 * k);
      }
    }
  }

  const jawZ = CZ + 0.35 * hr;
  const jaw = group(head, 0, MY - 0.17 * hr, jawZ);
  const chinLen = Math.max(padZ + 0.2 * pr - jawZ, 0.3 * hr);
  add(jaw, ell(0.2 * hr, 0.11 * hr, chinLen / 2, 10, 7), muzzleM, P_HEAD, 0, -0.03 * hr, chinLen / 2);
  add(jaw, ell(0.15 * hr, 0.05 * hr, chinLen * 0.4, 8, 6), mouthM, P_NONE, 0, 0.06 * hr, chinLen * 0.5);
  const tongue = group(jaw, 0, 0.07 * hr, chinLen * 0.75);
  add(tongue, ell(0.1 * hr, 0.03 * hr, 0.14 * hr, 8, 6), tongueM, P_NONE, 0, 0, 0.12 * hr);

  // Eyes: big almonds with vertical slit pupils, set facing forward.
  const er = hr * (0.15 + 0.07 * cfg.face.eyeSize);
  const EYE_X = 0.38 * hr * csx;
  const EYE_Y = CY + 0.04 * hr;
  const EYE_Z = craniumZ(EYE_X, EYE_Y) - 0.4 * er;
  const eyes: THREE.Group[] = [];
  const pupils: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const eye = group(head, side * EYE_X, EYE_Y, EYE_Z);
    eye.rotation.set(0, side * 0.2, side * 0.16);
    add(eye, ell(er, 0.8 * er, 0.6 * er, 14, 10), eyeM, P_NONE);
    pupils.push(add(eye, ell(0.2 * er, 0.72 * er, 0.15 * er, 8, 8), pupilM, P_NONE, 0, 0, 0.5 * er));
    const glint = add(eye, new THREE.SphereGeometry(0.15 * er, 6, 5), glintM, P_NONE, -0.3 * er, 0.3 * er, 0.58 * er);
    glint.castShadow = false;
    eyes.push(eye);
  }

  // ---- Ears ----
  const earStyle = cfg.face.earStyle;
  const folded = earStyle === "folded";
  const earBase = (earStyle === "large" ? 0.72 : earStyle === "folded" ? 0.5 : 0.56) * es;
  const earLen = (earStyle === "large" ? 1.35 : earStyle === "folded" ? 0.6 : earStyle === "tufted" ? 1.12 : 1.0) * es;
  const earSplay = earStyle === "large" ? 0.45 : 0.28;
  const ears: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const ear = group(head, side * csx * hr * (earStyle === "large" ? 0.6 : 0.5), CY + (folded ? 0.7 : 0.62) * hr, CZ - 0.06 * hr);
    ear.rotation.order = "ZXY";
    const g = new THREE.ConeGeometry(earBase, earLen, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.38).translate(0, earLen / 2, 0);
    add(ear, g, earM, P_EAR);
    const gi = new THREE.ConeGeometry(earBase * 0.62, earLen * 0.74, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.2).translate(0, earLen * 0.37, 0);
    add(ear, gi, innerEarM, P_NONE, 0, 0.03 * earLen, earBase * 0.15);
    if (earStyle === "tufted") add(ear, new THREE.ConeGeometry(0.12 * es, 0.45 * es, 5).translate(0, earLen + 0.15 * es, 0), tuftM, P_EAR);
    ears.push(ear);
  }

  // ---- Tail ----
  const tailBase = group(loin, 0, 0.45 * r, -TL / 2 + 0.25 * r - zJ);
  const tailPitch = group(tailBase);
  const nSeg = bob ? 2 : 8;
  const segLen = tl / nSeg;
  const plume = tailStyle === "plume";
  const tr0 = ru * 0.62 * (1 + 0.5 * fl) * (bob ? 1.4 : 1);
  const trTip = tr0 * (bob ? 0.95 : 0.72);
  const tailSegs: THREE.Group[] = [];
  {
    let parent: THREE.Object3D = tailPitch;
    const plumeF = plume ? 0.5 + 0.5 * fl : sm(0.5, 1, fl) * 0.8;
    for (let i = 0; i < nSeg; i++) {
      const seg = group(parent, 0, i === 0 ? 0 : segLen, 0);
      const ra = lerp(tr0, trTip, i / nSeg);
      const rb = lerp(tr0, trTip, (i + 1) / nSeg);
      const m = i % 2 === 1 || i === nSeg - 1 ? ringM : tailM;
      add(seg, new THREE.CylinderGeometry(rb, ra, segLen, 9, 1).translate(0, segLen / 2, 0), m, P_TAIL);
      add(seg, new THREE.SphereGeometry(ra, 9, 6), i === 0 ? tailM : m, P_TAIL);
      if (plumeF > 0.05 && i > 0) {
        const tuft = ra * (1.2 + 1.1 * plumeF);
        add(seg, ell(tuft, segLen * 0.5 + tuft * 0.7, tuft, 8, 6), m, P_TAIL, 0, segLen * 0.5, 0);
      }
      tailSegs.push(seg);
      parent = seg;
    }
    add(tailSegs[nSeg - 1], new THREE.SphereGeometry(trTip * (plumeF > 0.05 ? 1.2 + 1.1 * plumeF : 1), 9, 6), ringM, P_TAIL, 0, segLen, 0);
  }
  /** Tail base pitch (rotation.x): 0 = straight up, -π/2 = straight back. */
  const TAIL_DOWN = bob ? -1.5 : -2.2;
  const TAIL_UP = -0.22;

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
  function isDescendant(i: number, anc: number): boolean {
    while (i >= 0) {
      if (i === anc) return true;
      i = parentIdx[i];
    }
    return false;
  }
  /** Lowest y (turn space) of the meshes in `mask`; computeMats() first. */
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

  // ---- Leg posing ----
  const tgx = [0, 0, 0, 0];
  const tgy = [0, 0, 0, 0];
  const tgz = [0, 0, 0, 0];
  let tuckAirW = 0;
  let softIK = 0;
  function solveLeg(leg: Leg, px: number, py: number, pz: number, soft: number): void {
    const hp = leg.hip.position;
    const dx = px - hp.x;
    const dy = py - hp.y;
    const dz = pz - hp.z;
    solveIK(dx, dy, dz - PAW_FWD, U, L, leg.front, soft);
    for (let k = 0; k < 3; k++) solveIK(dx, dy - PAW_FWD * Math.sin(ikThL), dz - PAW_FWD * Math.cos(ikThL), U, L, leg.front, soft);
  }
  function poseLegs(bodyPitch: number): void {
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
      if (tuckAirW > 0) {
        solveLeg(leg, leg.side * LX, -0.6 * S, leg.front ? 0.9 * LZ : -0.7 * LZ, 0);
        thU = lerp(thU, ikThU, tuckAirW);
        thL = lerp(thL, ikThL, tuckAirW);
        lam = lerp(lam, ikLam, tuckAirW);
      }
      leg.hip.rotation.set(-thU, 0, lam);
      leg.knee.rotation.set(thU - thL, 0, 0);
      leg.paw.rotation.set(thL - bodyPitch - (leg.front ? 0 : loin.rotation.x), 0, 0);
    }
  }

  // ---- Precomputed postures ----
  const restY = (dzz: number): number => pawH - pivY + Math.min(0.96 * S, Math.sqrt(Math.max(0, (0.975 * S) ** 2 - (dzz / 2) ** 2)));
  const standY = restY(0);
  const rockPitch = 0.1 * Math.min(1, S / (2.5 * LZ));
  const rotX = (y: number, z: number, a: number): [number, number] => [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];

  // Sit: haunches on the floor, front legs straight and close together, upright (up to ~55°).
  const sitPose = { y: standY, z: 0, pitch: 0, bend: 0 };
  let sitHipZ = -LZ;
  let sitShoulderZ = LZ;
  {
    const frontReach = 0.975 * S + pawH;
    const hipTargetZ = -LZ - 0.2 * U;
    const iHip = nodeIndex.get(legs[2].hip) ?? 0;
    const iSh = nodeIndex.get(legs[0].hip) ?? 0;
    let done = false;
    for (let th = 55 * DEG; th >= 14 * DEG && !done; th -= 2 * DEG) {
      for (let bend = 0; bend <= 0.6 * th + 1e-6; bend += 0.025) {
        const a = -(th - bend);
        loin.rotation.set(-bend, 0, 0);
        body.position.set(0, 0, 0);
        body.rotation.set(a, 0, 0);
        computeMats();
        const bz = hipTargetZ - nodeMats[iHip].elements[14];
        body.position.set(0, 0, bz);
        computeMats();
        const by = -lowestOf(P_TORSO) + 0.004 * H;
        sitPose.y = by;
        sitPose.z = bz;
        sitPose.pitch = a;
        sitPose.bend = bend;
        sitHipZ = hipTargetZ;
        sitShoulderZ = nodeMats[iSh].elements[14];
        if (by + nodeMats[iSh].elements[13] <= frontReach) {
          done = true;
          break;
        }
      }
    }
    loin.rotation.set(0, 0, 0);
  }

  // Lie = loaf: torso on the floor, all four paws tucked underneath.
  const liePose = { y: standY, z: 0, pitch: 0.02 };
  {
    body.position.set(0, 0, liePose.z);
    body.rotation.set(liePose.pitch, 0, 0);
    computeMats();
    liePose.y = -lowestOf(P_TORSO) + 0.003 * H;
  }
  let torsoDepth = 0;
  {
    body.position.set(0, 0, 0);
    body.rotation.set(0, 0, 0);
    computeMats();
    torsoDepth = Math.max(0, -lowestOf(P_TORSO, torsoShape));
  }

  // Ground sniff: front lowered by `crouch`, neck pitched to `alpha`, head pitched down to `beta`.
  const NOSE_HZ = noseZ + 0.5 * noseR;
  const sniffPose = { crouch: 0, alpha: NP, beta: 1.25 };
  {
    const noseYAt = (crouch: number, alpha: number, beta: number): number => {
      const dF = crouch * 0.38 * S;
      const pitch = Math.asin(clamp(dF / (2 * LZ), -0.5, 0.5));
      const by = standY - dF / 2;
      const nb = rotX(NBY, NBZ, pitch);
      const nt = rotX(nl * Math.cos(alpha), nl * Math.sin(alpha), pitch);
      const no = rotX(noseY, NOSE_HZ, beta);
      return by + nb[0] + nt[0] + no[0];
    };
    const target = 0.015;
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

  const EYE0_Y = NBY + nl * Math.cos(NP) + EYE_Y;
  const EYE0_Z = NBZ + nl * Math.sin(NP) + EYE_Z;
  const MAX_YAW = 85 * DEG;
  const MAX_PITCH_UP = 55 * DEG;
  const MAX_PITCH_DOWN = 40 * DEG;
  const LOAF_NECK = 0.45;
  /** Arch: hips stay at the same height while the spine bends up at the loin joint. */
  const archLift = LZ + 2 * zJ;

  const controls: PetControls = {
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
    let crouchW = 0; // pounce: low stalking crouch
    let rearWig = 0;
    let air = 0;
    let lunge = 0;
    let squash = 0;
    let tuckAir = 0;
    let st = 0; // stretch
    let yawn = 0;
    let sitT = 0; // groom sits down
    let raise = 0;
    let lickW = 0;
    let wipe = 0;
    let stepAmp = 0;
    let stepFreq = 2.4;
    if (c.trick) {
      const kind = c.trick.kind;
      const p = clamp01(c.trick.progress);
      env = trickEnvelope(kind, p);
      if (kind === "pounce") {
        crouchW = sm(0.02, 0.2, p) * (1 - sm(0.42, 0.48, p));
        rearWig = 0.22 * bump(0.16, 0.26, 0.42, p) * Math.sin(p * TAU * 11);
        const s = clamp01((p - 0.44) / 0.2);
        air = s <= 0 || s >= 1 ? 0 : 0.3 * H * Math.sin(Math.PI * s);
        tuckAir = 0.7 * bump(0.44, 0.52, 0.64, p);
        lunge = 0.55 * TL * sm(0.44, 0.64, p) * (1 - sm(0.72, 0.97, p));
        squash = bump(0.62, 0.66, 0.8, p);
        stepAmp = bump(0.7, 0.78, 0.97, p);
      } else if (kind === "stretch") {
        st = sm(0.05, 0.32, p) * (1 - sm(0.65, 0.92, p));
        yawn = bump(0.28, 0.42, 0.62, p);
      } else if (kind === "groom") {
        sitT = env;
        raise = sm(0.12, 0.25, p) * (1 - sm(0.8, 0.9, p));
        lickW = sm(0.22, 0.3, p) * (1 - sm(0.56, 0.62, p));
        wipe = sm(0.58, 0.64, p) * (1 - sm(0.76, 0.82, p));
      }
    }
    const free = 1 - env;

    // ---- Posture weights ----
    const lieAll = clamp01(c.lie) * free;
    const sitW = Math.max(clamp01(c.sit) * free, sitT) * (1 - lieAll);
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
    const archW = pBody * (1 - post);
    const exc = clamp01(c.excitement);

    const turnStep = clamp01(Math.abs(turnRate) * 2) * (1 - amp) * free * (1 - post);
    if (turnStep > stepAmp) {
      stepAmp = turnStep;
      stepFreq = 2.4;
    }

    let petSide = 0;
    if (c.petPoint && (pHead > 0 || pBody > 0)) petSide = clamp(c.petPoint.x / (0.5 * TL), -1, 1);

    // ---- Breathing (cats breathe slowly; no panting) ----
    const breath = Math.sin(t * TAU * 0.4) * 0.018;
    torsoShape.scale.set((1 + breath) * (1 + 0.05 * squash), (1 + breath * 1.2) * (1 - 0.1 * squash), 1 + breath * 0.3);
    torsoRear.scale.copy(torsoShape.scale);

    // ---- Gait trajectories ----
    let E = 0;
    for (let g = 0; g < 3; g++) E += w[g] * GAITS[g].exc;
    E *= S * amp;
    const ph1 = frac(phase);
    const bobAmp = 0.014 * S * amp * (w[0] + 0.7 * w[1]);
    const gallopRock = w[2] * amp;
    const bobY = -bobAmp * Math.cos(2 * TAU * ph1) + gallopRock * 0.05 * S * Math.sin(TAU * (ph1 - 0.15));
    const pitchG = gallopRock * rockPitch * Math.sin(TAU * (ph1 - 0.05));

    // ---- Body pose (turn space) ----
    const sway = 0.008 * r * Math.sin(t * 0.53) + 0.004 * r * Math.sin(t * 1.37);
    let bx = sway * (1 - amp) + 0.1 * r * pBody * petSide;
    let bz = 0;
    let by = restY(E) - bobAmp - gallopRock * (0.05 * S + LZ * Math.sin(rockPitch)) + bobY;
    let bp = pitchG + 0.03; // hind legs a touch longer: rump slightly higher
    const dF = snG * sniffPose.crouch * 0.38 * S + 0.5 * S * st;
    by -= dF / 2;
    bp += Math.asin(clamp(dF / (2 * LZ), -0.6, 0.6));
    // Back arch while stroked.
    const archA = 0.13 * archW;
    bp += archA;
    by += archLift * Math.sin(archA);
    // Postures.
    by = lerp(by, sitPose.y, sitW);
    bz = lerp(bz, sitPose.z, sitW);
    bp = lerp(bp, sitPose.pitch, sitW);
    by = lerp(by, liePose.y + torsoDepth * (torsoShape.scale.y - 1), lieAll);
    bz = lerp(bz, liePose.z, lieAll);
    bp = lerp(bp, liePose.pitch, lieAll);
    bx *= 1 - 0.7 * post;
    // Pounce: low crouch, front lower than the rear, then the leap.
    by += air - 0.3 * S * crouchW - 0.08 * S * squash;
    bp += 0.06 * crouchW;
    const roll = -0.08 * pBody * petSide - turnRate * 0.1 * amp;
    body.position.set(bx, by, bz);
    body.rotation.set(bp, 0, roll);
    loin.rotation.set(-sitPose.bend * sitW - 2 * archA, rearWig, 0);
    turn.position.set(0, 0, lunge);
    body.updateMatrix();
    _invBody.copy(body.matrix).invert();

    // ---- Neck & head ----
    let neckX = NP + 0.03 * Math.sin(t * 0.37) + breath * 0.4 + 0.04 * amp * (w[0] + 0.5 * w[1]) * Math.cos(2 * TAU * ph1);
    neckX += 0.2 * gallopRock;
    neckX = lerp(neckX, sniffPose.alpha, snG);
    neckX += sitW * -sitPose.pitch * 0.6;
    neckX = lerp(neckX, LOAF_NECK, lieAll);
    neckX += -0.15 * pHead + 0.3 * crouchW - 0.6 * st + 0.45 * raise;
    let neckY = turnRate * 0.3 * Math.max(amp, turnStep);

    const idleW = (1 - 0.7 * amp) * (1 - snG) * free;
    const look = (0.4 * Math.sin(t * 0.29) * Math.sin(t * 0.11 + 1.1) + 0.06 * Math.sin(t * 0.83)) * idleW;
    const tilt = 0.22 * pulse(t, 8.1, 0.25, 0) * (Math.sin(t * 0.07) >= 0 ? 1 : -1) * idleW;
    const sniffBob = 0.03 * sn * Math.sin(t * TAU * 7) * (Math.sin(t * 1.7) > -0.2 ? 1 : 0);
    const lap = Math.sin(t * TAU * 3.2);
    _qIdle.setFromEuler(
      _e.set(
        -neckX - bp + 0.06 * Math.sin(t * 0.29 + 2) * idleW + snG * sniffPose.beta + sniffBob - 0.35 * st + (0.55 + 0.08 * lap) * lickW + 0.25 * wipe,
        look * (1 - 0.6 * lw) + turnRate * 0.2 + 0.25 * wipe,
        tilt + 0.45 * wipe,
        "XYZ",
      ),
    );

    let eyeDX = 0;
    let eyeDY = 0;
    if (lw > 0 && c.lookAt) {
      const T = c.lookAt;
      _tb.set(T.x, T.y, T.z - lunge).applyMatrix4(_invBody);
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
      // Pushes up into the hand and rubs a cheek against it.
      const rub = Math.sin(t * TAU * 0.8);
      _qExtra.setFromEuler(_e.set(-0.35 * pHead, 0.18 * rub * pHead, (-0.25 * petSide + 0.22 * rub) * pHead, "XYZ"));
      head.quaternion.multiply(_qExtra);
    }

    // Jaw: closed; yawns during the stretch, laps while grooming.
    jaw.rotation.x = 0.02 + 0.6 * yawn + lickW * (0.1 + 0.06 * lap);
    const tongueW = Math.max(lickW, 0.7 * yawn);
    tongue.visible = tongueW > 0.01;
    tongue.scale.set(1, 1, Math.max(0.001, tongueW * (1 + 0.35 * lickW * lap)));

    // ---- Paw targets (turn space) ----
    if (raise > 0) {
      neck.updateMatrix();
      head.updateMatrix();
      _m.multiplyMatrices(body.matrix, neck.matrix).multiply(head.matrix);
      _lick.set(0, MY - 0.3 * hr, padZ + pr + 0.9 * pawR).applyMatrix4(_m);
      _wipe.set(0.5 * hr, CY + (0.1 + 0.15 * Math.sin(t * TAU * 1.6)) * hr, CZ + 0.6 * hr).applyMatrix4(_m);
      _lick.lerp(_wipe, wipe);
    }
    for (let i = 0; i < 4; i++) {
      const leg = legs[i];
      let gx = leg.side * LX;
      let gz = (leg.front ? LZ : -LZ) + PAW_FWD;
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
        gy += stepAmp * 0.1 * S * (s > 0 ? s : 0);
      }
      if (leg.front) gz += 0.55 * S * st + 0.3 * S * tuckAir;
      if (sitW > 0) {
        const sxp = leg.front ? leg.side * LX * 0.7 : leg.side * (LX + 0.5 * ru);
        const szp = leg.front ? sitShoulderZ + PAW_FWD + 0.03 * S : sitHipZ + 0.55 * U;
        gx = lerp(gx, sxp, sitW);
        gy = lerp(gy, pawH, sitW);
        gz = lerp(gz, szp, sitW);
      }
      if (lieAll > 0) {
        // Loaf: front paws tucked under the chest, hind paws folded beside the belly.
        const lxp = leg.front ? leg.side * LX * 0.7 : leg.side * r * sx * 0.75;
        const lzp = leg.front ? liePose.z + LZ - 0.1 * r : liePose.z - LZ + 0.6 * U;
        gx = lerp(gx, lxp, lieAll);
        gy = lerp(gy, pawH, lieAll);
        gz = lerp(gz, lzp, lieAll);
      }
      if (i === 0 && raise > 0) {
        gx = lerp(gx, _lick.x, raise);
        gy = lerp(gy, _lick.y, raise);
        gz = lerp(gz, _lick.z, raise);
      }
      tgx[i] = gx;
      tgy[i] = gy;
      tgz[i] = gz;
    }
    tuckAirW = tuckAir;
    softIK = 0.05 * S * env;
    poseLegs(bp);

    // ---- Ears ----
    const flickL = pulse(t, 5.3, 0.06, 1.7);
    const flickR = pulse(t, 6.9, 0.06, 4.1);
    const fwd = 0.2 * exc + 0.2 * crouchW - 0.45 * pHead - 0.25 * Math.max(lickW, wipe, yawn);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const flick = i === 0 ? flickL : flickR;
      if (folded) ears[i].rotation.set(1.45 + 0.1 * fwd - 0.15 * flick, 0, -side * 0.2);
      else ears[i].rotation.set(0.05 + fwd - 0.25 * flick, side * 0.35 * flick, -side * (earSplay + 0.3 * pHead));
    }

    // ---- Eyes ----
    const blink = 1 - 0.95 * pulse(t, 4.7, 0.045, 0.5);
    const slowBlink = 1 - 0.9 * exc * pulse(t, 6.1, 0.22, 2);
    const closed = 1 - 0.95 * pHead;
    const squint = 1 - 0.85 * Math.max(yawn, 0.75 * lickW, wipe);
    const eyeS = Math.max(0.06, Math.min(blink, slowBlink, closed, squint));
    const dilate = 1 + 1.6 * Math.max(0.6 * exc, crouchW, 0.3 * lw);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      eyes[i].scale.set(1, eyeS, 1);
      eyes[i].position.set(side * EYE_X + 0.1 * er * eyeDX, EYE_Y + 0.08 * er * eyeDY, EYE_Z);
      pupils[i].scale.set(dilate, 1, 1);
    }

    // ---- Tail ----
    // Up = happy / greeting (question-mark tip), straight up + quiver when stroked, low and
    // twitching when stalking, streaming back at a run, wrapped round the paws when sitting.
    const slow = Math.sin(t * 0.19 + 0.5) * 0.5 + 0.5;
    const upW = clamp01(Math.max(0.9 * exc, pBody, 0.75 * st, 0.5 * sm(0.05, 0.5, spd) * (1 - w[2])));
    const flatW = Math.max(crouchW, gallopRock, 0.6 * tuckAir);
    const flickRate = 0.9 + 1.8 * Math.max(exc, crouchW);
    const tipFlick = Math.sin(t * TAU * flickRate) * (0.1 + 0.25 * Math.max(exc, crouchW)) * (1 - pBody);
    let tailA = lerp(TAIL_DOWN, TAIL_UP, upW);
    tailA = lerp(tailA, -1.75, flatW) + 0.05 * Math.sin(t * 0.6);
    const swayY = (0.2 + 0.12 * slow) * Math.sin(t * TAU * 0.22) * (1 - 0.7 * upW) * (1 - pBody);
    const groundW = post;
    /** On the floor: the first FLAT segments drop to the floor, the rest lie flat and wrap round. */
    const FLAT = Math.min(3, nSeg - 1);
    let delta = 0;
    if (groundW > 0) {
      _m.multiplyMatrices(body.matrix, loin.matrix);
      _v.copy(tailBase.position).applyMatrix4(_m);
      delta = Math.asin(clamp((_v.y - 1.1 * tr0) / Math.max(FLAT * segLen, 1e-3), 0, 0.95));
      tailA = lerp(tailA, -(Math.PI / 2 + delta) - bp - loin.rotation.x, groundW);
    }
    tailBase.rotation.set(0, swayY * (1 - groundW), 0);
    tailPitch.rotation.set(tailA, 0, 0.05 * pBody * Math.sin(t * TAU * 12));
    for (let i = 1; i < nSeg; i++) {
      const u = i / nSeg;
      const rest = 0.04 + 0.3 * u * u; // J-curve: droops, tip curls up
      const up = i >= nSeg - 2 ? 0.55 : 0.03; // question mark
      let bend = lerp(rest, up, upW);
      bend = lerp(bend, 0.05, Math.max(flatW, pBody));
      if (i >= nSeg - 2) bend += tipFlick;
      bend += 0.04 * Math.sin(t * 1.3 + i);
      // Segment FLAT levels the tail out; from there local Z is world-up, so Z bends wrap it sideways.
      const flat = i === FLAT ? delta : 0.02;
      const wrap = i === FLAT ? 1.1 : i > FLAT ? 0.5 : 0;
      tailSegs[i].rotation.set(lerp(bend, flat, groundW), 0, wrap * groundW);
    }

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
    for (let k = 0; k < 8; k++) {
      if (lowestOf(P_TAIL) >= 0) break;
      tailPitch.rotation.x += 0.12;
      for (let i = 1; i < nSeg; i++) tailSegs[i].rotation.x *= 0.8;
      computeMats();
    }
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < 8; k++) {
        if (lowestOf(P_EAR, ears[i]) >= 0) break;
        ears[i].rotation.x -= 0.15;
        computeMats();
      }
    }
  }

  // ---- Queries ----
  function getZones(out: PetZones): PetZones {
    root.updateWorldMatrix(true, true);
    const s = root.matrixWorld.getMaxScaleOnAxis();
    head.localToWorld(out.head.center.set(0, CY, CZ + 0.15 * hr + 0.3 * mlen));
    out.head.radius = (1.5 * hr + 0.3 * mlen) * s;
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
    return head.localToWorld(out.set(0, noseY, NOSE_HZ));
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

  const cat: CatCharacter = {
    species: "cat",
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
  gaitInfo.set(cat, { leg: S, height: H });
  return cat;
}

export function isCatCharacter(c: Character): c is CatCharacter {
  return (c as Partial<CatCharacter>).species === "cat";
}
