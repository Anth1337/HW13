import type * as THREE from "three";
import { TRICK_DURATION, type DogCommand, type DogControls, type TrickKind } from "../dog/types";

/*
 * What phones tell each other about their pets: the `d` of protocol.ts "s" (state) and "e"
 * (event) messages. Everything received is validated here before anything uses it.
 *
 * The model's pose is a pure function of (config, DogControls), so a pet on someone else's
 * phone is built once from its pet card and then driven by these snapshots; no brain runs there.
 * Position is relative to where the owner placed the pet, in that placement's frame (+z points
 * at the owner as it was at placement), so every phone can stand friends' pets next to its own.
 * Once both phones are lined up (SharedFrame below) `w` puts the pet where it really is instead.
 */

export interface PetState {
  /** Sender's clock (performance.now(), ms), for spacing snapshots during playback. */
  t: number;
  /** Position (m) and heading (rad) relative to the placement point and heading. */
  x: number;
  z: number;
  h: number;
  /** Gait phase (cycles, never wrapped), speed, turn. */
  g: [number, number, number];
  /** sit, lie, sniff, excitement, petHead, petBody, lookWeight. */
  c: [number, number, number, number, number, number, number];
  /** lookAt in the pet's local space, or null. */
  l: [number, number, number] | null;
  /** petPoint in the pet's local space, or null. */
  p: [number, number, number] | null;
  /** Running trick and its progress, or null. */
  k: [TrickKind, number] | null;
  /** Position and heading in the room's shared floor frame (toShared), or null: this phone isn't lined up. */
  w: [number, number, number] | null;
}

/**
 * The room's shared floor frame ("line up", party.ts): every phone taps the same two real floor
 * spots A then B. Origin A, +x towards B, and the unit is |AB| as measured on that phone, so a
 * phone whose tracking scale is off (iOS: assumed camera height) still lands on the same spots.
 * Position/yaw use the same convention as a placement Stage (three.js rotation.y).
 */
export type SharedFrame = { x: number; y: number; z: number; yaw: number; unit: number };

export function sharedFrame(a: { x: number; y: number; z: number }, b: { x: number; z: number }): SharedFrame | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const unit = Math.hypot(dx, dz);
  return unit > 1e-6 ? { x: a.x, y: a.y, z: a.z, yaw: Math.atan2(-dz, dx), unit } : null;
}

/** World floor point + heading on this phone → shared [x, z, heading]. */
export function toShared(f: SharedFrame, x: number, z: number, yaw: number): [number, number, number] {
  const dx = x - f.x;
  const dz = z - f.z;
  const cs = Math.cos(f.yaw);
  const sn = Math.sin(f.yaw);
  return [r3((cs * dx - sn * dz) / f.unit), r3((sn * dx + cs * dz) / f.unit), r3(wrapAngle(yaw - f.yaw))];
}

/** Shared x, z → this phone's world floor point (writes out.x / out.z). */
export function fromShared<T extends { x: number; z: number }>(f: SharedFrame, sx: number, sz: number, out: T): T {
  const cs = Math.cos(f.yaw);
  const sn = Math.sin(f.yaw);
  out.x = f.x + f.unit * (cs * sx + sn * sz);
  out.z = f.z + f.unit * (-sn * sx + cs * sz);
  return out;
}

export type PetEvent =
  /** A command. No `to`: the sender commanded their own pet (for the feed). Else: that player's pet. */
  | { k: "cmd"; c: DogCommand; to?: string }
  /** The sender's hand is on `to`'s pet; repeated every PET_REPEAT_MS while it stays there. */
  | { k: "pet"; to: string; z: "head" | "body" }
  /**
   * The sender's pet goes to say hi to `to`'s pet (party.ts plays it on every phone). `stay`: the
   * other pet is sitting / lying, so only the sender's pet walks over.
   */
  | { k: "meet"; to: string; stay: boolean }
  /** The sender left AR: their pet disappears now instead of after a timeout. */
  | { k: "away" };

export const PET_REPEAT_MS = 250;

const TRICKS = new Set<string>(Object.keys(TRICK_DURATION));
const COMMANDS = new Set<string>(["sit", "lie", "stand", "come", "follow", "free", ...TRICKS]);

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const vec = (v: THREE.Vector3 | null): [number, number, number] | null => (v ? [r3(v.x), r3(v.y), r3(v.z)] : null);

export function writeState(t: number, x: number, z: number, h: number, c: DogControls, w: PetState["w"] = null): PetState {
  return {
    t: Math.round(t),
    x: r3(x),
    z: r3(z),
    h: r3(h),
    g: [r3(c.gait.phase), r3(c.gait.speed), r3(c.gait.turn)],
    c: [r3(c.sit), r3(c.lie), r3(c.sniff), r3(c.excitement), r3(c.petHead), r3(c.petBody), r3(c.lookWeight)],
    l: vec(c.lookAt),
    p: vec(c.petPoint),
    k: c.trick ? [c.trick.kind, r3(c.trick.progress)] : null,
    w,
  };
}

function num(v: unknown, lo: number, hi: number): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
}

/** `n` finite numbers clamped to [lo, hi], or null. */
function nums(v: unknown, n: number, lo: number, hi: number): number[] | null {
  if (!Array.isArray(v) || v.length !== n) return null;
  const out: number[] = [];
  for (const x of v) {
    const ok = num(x, lo, hi);
    if (ok === null) return null;
    out.push(ok);
  }
  return out;
}

export function readState(d: unknown): PetState | null {
  if (!d || typeof d !== "object") return null;
  const s = d as Record<string, unknown>;
  const t = num(s.t, -1e13, 1e13);
  const x = num(s.x, -50, 50);
  const z = num(s.z, -50, 50);
  const h = num(s.h, -10, 10);
  const g = nums(s.g, 3, -1e9, 1e9);
  const c = nums(s.c, 7, 0, 1);
  const l = s.l === null ? null : nums(s.l, 3, -20, 20);
  const p = s.p === null ? null : nums(s.p, 3, -20, 20);
  if (t === null || x === null || z === null || h === null || !g || !c) return null;
  if ((s.l !== null && !l) || (s.p !== null && !p)) return null;
  // Missing on phones from before "line up": not lined up.
  const w = s.w === undefined || s.w === null ? null : nums(s.w, 3, -100, 100);
  if (s.w !== undefined && s.w !== null && !w) return null;
  let k: [TrickKind, number] | null = null;
  if (s.k !== null) {
    const raw = s.k as unknown[];
    const progress = Array.isArray(raw) ? num(raw[1], 0, 1) : null;
    if (!Array.isArray(raw) || typeof raw[0] !== "string" || !TRICKS.has(raw[0]) || progress === null) return null;
    k = [raw[0] as TrickKind, progress];
  }
  return {
    t,
    x,
    z,
    h,
    g: [g[0], Math.min(1.5, Math.max(0, g[1])), Math.min(1, Math.max(-1, g[2]))],
    c: c as PetState["c"],
    l: l as PetState["l"],
    p: p as PetState["p"],
    k,
    w: w as PetState["w"],
  };
}

export function readEvent(d: unknown): PetEvent | null {
  if (!d || typeof d !== "object") return null;
  const e = d as Record<string, unknown>;
  if (e.k === "cmd" && typeof e.c === "string" && COMMANDS.has(e.c) && (e.to === undefined || typeof e.to === "string")) {
    return e.to === undefined ? { k: "cmd", c: e.c as DogCommand } : { k: "cmd", c: e.c as DogCommand, to: e.to as string };
  }
  if (e.k === "pet" && typeof e.to === "string" && (e.z === "head" || e.z === "body")) return { k: "pet", to: e.to, z: e.z };
  if (e.k === "meet" && typeof e.to === "string" && typeof e.stay === "boolean") return { k: "meet", to: e.to, stay: e.stay };
  if (e.k === "away") return { k: "away" };
  return null;
}

export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** Angle interpolation the short way round. */
export function lerpAngle(a: number, b: number, u: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * u;
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/**
 * Writes the blend of two snapshots (u = 0 → a, 1 → b) into a model's controls, reusing the
 * given objects for lookAt / petPoint / trick (no allocations per frame).
 */
export function applyControls(
  a: PetState,
  b: PetState,
  u: number,
  out: DogControls,
  look: THREE.Vector3,
  petPoint: THREE.Vector3,
  trick: { kind: TrickKind; progress: number },
): void {
  out.gait.phase = lerp(a.g[0], b.g[0], u);
  out.gait.speed = lerp(a.g[1], b.g[1], u);
  out.gait.turn = lerp(a.g[2], b.g[2], u);
  out.sit = lerp(a.c[0], b.c[0], u);
  out.lie = lerp(a.c[1], b.c[1], u);
  out.sniff = lerp(a.c[2], b.c[2], u);
  out.excitement = lerp(a.c[3], b.c[3], u);
  out.petHead = lerp(a.c[4], b.c[4], u);
  out.petBody = lerp(a.c[5], b.c[5], u);
  out.lookWeight = lerp(a.c[6], b.c[6], u);
  // While a target appears or disappears its weight fades, so keep whichever target exists.
  out.lookAt = blendVec(a.l, b.l, u, look);
  out.petPoint = blendVec(a.p, b.p, u, petPoint);
  const k = a.k && b.k && a.k[0] === b.k[0] ? a.k : u < 0.5 ? a.k : b.k;
  if (!k) {
    out.trick = null;
    return;
  }
  trick.kind = k[0];
  trick.progress = a.k && b.k && a.k[0] === b.k[0] ? lerp(a.k[1], b.k[1], u) : k[1];
  out.trick = trick;
}

function blendVec(
  a: [number, number, number] | null,
  b: [number, number, number] | null,
  u: number,
  out: THREE.Vector3,
): THREE.Vector3 | null {
  if (a && b) return out.set(lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u));
  const one = a ?? b;
  return one ? out.set(one[0], one[1], one[2]) : null;
}
