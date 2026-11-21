import * as THREE from "three";
import type { CameraModel } from "./vision/types";

/*
 * Pure (DOM-free, renderer-free) helpers for camera mode (src/cameraMode.ts): where the camera's
 * centre ray meets the floor (the reticle), the long-press state machine, and the per-detection
 * CameraModel snapshot. Kept separate so they can be run and tested headlessly.
 */

/** Reticle is only shown when the camera looks at least this far below the horizon. */
export const MIN_PITCH_DEG = 15;
/** Floor hits closer / farther than this (horizontal metres from the camera) are ignored. */
export const RETICLE_MIN_DIST = 0.15;
export const RETICLE_MAX_DIST = 6;
/** Seconds of valid pitch after which the reticle counts as locked even if the tracker is not "tracking". */
export const LOCK_AFTER_S = 1;
/** Hold this long to re-place the dog. */
export const LONG_PRESS_S = 0.6;
/** A press that moves farther than this (CSS px) is a drag, not a tap. */
export const TAP_SLOP_PX = 24;
/** Taps farther than this (metres, along the ray) from the camera are ignored (as in webxr.ts). */
export const MAX_GOTO_DIST = 8;

const SIN_MIN_PITCH = Math.sin(THREE.MathUtils.degToRad(MIN_PITCH_DEG));

/**
 * Intersects a ray with the horizontal plane y = floorY. Returns the distance along the ray, or
 * null when the ray points at/above the horizon or the hit is behind the origin.
 */
export function rayToFloor(origin: THREE.Vector3, dir: THREE.Vector3, floorY: number, out: THREE.Vector3): number | null {
  if (dir.y > -1e-3) return null;
  const t = (floorY - origin.y) / dir.y;
  if (!(t > 0) || !Number.isFinite(t)) return null;
  out.copy(origin).addScaledVector(dir, t);
  return t;
}

/**
 * The reticle: the camera's centre ray against the floor plane, validated (pitch, distance),
 * smoothed, and "locked" once the tracker is tracking or the view has been valid for a while.
 */
export class Reticle {
  visible = false;
  locked = false;
  /** Smoothed floor point (y = floorY). Only meaningful while visible. */
  readonly point = new THREE.Vector3();
  private validTime = 0;
  private readonly fwd = new THREE.Vector3();
  private readonly raw = new THREE.Vector3();

  constructor(private floorY = 0) {}

  setFloor(y: number) {
    this.floorY = y;
  }

  reset() {
    this.visible = false;
    this.locked = false;
    this.validTime = 0;
  }

  update(dt: number, camPos: THREE.Vector3, camQuat: THREE.Quaternion, trackerTracking: boolean) {
    this.fwd.set(0, 0, -1).applyQuaternion(camQuat);
    let ok = this.fwd.y < -SIN_MIN_PITCH && rayToFloor(camPos, this.fwd, this.floorY, this.raw) !== null;
    if (ok) {
      const d = Math.hypot(this.raw.x - camPos.x, this.raw.z - camPos.z);
      ok = d >= RETICLE_MIN_DIST && d <= RETICLE_MAX_DIST;
    }
    if (!ok) {
      this.visible = false;
      this.validTime = 0;
      this.locked = false;
      return;
    }
    if (!this.visible || this.point.distanceToSquared(this.raw) > 0.6 * 0.6) {
      this.point.copy(this.raw); // first sighting or a jump: snap
    } else {
      this.point.lerp(this.raw, 1 - Math.exp(-Math.max(0, dt) * 12));
    }
    this.point.y = this.floorY;
    this.visible = true;
    this.validTime += dt;
    this.locked = trackerTracking || this.validTime >= LOCK_AFTER_S;
  }
}

export type PressEnd = "tap" | "consumed" | "cancelled";

/** One finger: tap vs long press (fires once while still held) vs drag. */
export class Press {
  active = false;
  private pointerId = -1;
  private start = 0;
  private x0 = 0;
  private y0 = 0;
  private fired = false;
  private moved = false;
  /** Screen position where the press began. */
  x = 0;
  y = 0;

  begin(id: number, t: number, x: number, y: number): boolean {
    if (this.active) return false;
    this.active = true;
    this.pointerId = id;
    this.start = t;
    this.x0 = this.x = x;
    this.y0 = this.y = y;
    this.fired = false;
    this.moved = false;
    return true;
  }

  move(id: number, x: number, y: number) {
    if (!this.active || id !== this.pointerId) return;
    if (Math.hypot(x - this.x0, y - this.y0) > TAP_SLOP_PX) this.moved = true;
  }

  /** Seconds held, or 0 when idle. */
  held(now: number): number {
    return this.active ? Math.max(0, now - this.start) : 0;
  }

  /** 0..1 progress for the hold ring (starts after 0.15 s); 0 when not showing. */
  progress(now: number): number {
    if (!this.active || this.fired || this.moved) return 0;
    const h = this.held(now);
    return h > 0.15 ? Math.min(1, (h - 0.15) / (LONG_PRESS_S - 0.15)) : 0;
  }

  /** True exactly once when a long press completes (call each frame with `armed` = can re-place now). */
  tick(now: number, armed: boolean): boolean {
    if (!this.active || this.fired || this.moved || !armed) return false;
    if (this.held(now) < LONG_PRESS_S) return false;
    this.fired = true;
    return true;
  }

  end(id: number, cancelled = false): PressEnd | null {
    if (!this.active || id !== this.pointerId) return null;
    this.active = false;
    if (cancelled || this.moved) return "cancelled";
    return this.fired ? "consumed" : "tap";
  }

  abort() {
    this.active = false;
  }
}

/** Projection numbers a snapshot needs: screen size and tan(half FOV). */
export interface Projection {
  w: number;
  h: number;
  tanY: number;
  tanX: number;
}

export function projectionOf(fovYDeg: number, aspect: number, w: number, h: number, out: Projection): Projection {
  out.tanY = Math.tan(THREE.MathUtils.degToRad(fovYDeg) / 2);
  out.tanX = out.tanY * aspect;
  out.w = w;
  out.h = h;
  return out;
}

type UVToScreen = (u: number, v: number, w: number, h: number) => { x: number; y: number };

/**
 * CameraModel for ONE detection: freezes the camera pose of the video frame (not the live camera,
 * which has moved on by the time the detector finishes) and the projection of that moment.
 * No depthAt / depthMap (iOS has no depth API): lift falls back to apparent hand size.
 * Allocated per detection (a few times a second), never per rendered frame.
 */
export class FrameCam implements CameraModel {
  readonly cameraToWorld = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly proj: Projection;

  constructor(
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    proj: Projection,
    private readonly uvToScreen: UVToScreen,
  ) {
    this.pos.copy(position);
    this.quat.copy(quaternion);
    this.proj = { ...proj };
    this.cameraToWorld.makeRotationFromQuaternion(this.quat);
  }

  ray(u: number, v: number, outOrigin: THREE.Vector3, outDir: THREE.Vector3): void {
    const { w, h, tanX, tanY } = this.proj;
    const p = this.uvToScreen(u, v, w, h);
    outDir
      .set((p.x / w) * 2 - 1, 1 - (p.y / h) * 2, 0)
      .set(outDir.x * tanX, outDir.y * tanY, -1)
      .normalize()
      .applyQuaternion(this.quat);
    outOrigin.copy(this.pos);
  }
}
