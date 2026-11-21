import type * as THREE from "three";
import type { Character } from "../models/types";
import type { PerceivedHuman } from "../vision/types";

export type TrickKind = "rollOver" | "jump" | "spin";

/** Seconds each trick lasts, start to finish (including getting back up). */
export const TRICK_DURATION: Record<TrickKind, number> = {
  rollOver: 2.8,
  jump: 1.3,
  spin: 1.6,
};

export const TRICK_LABEL: Record<TrickKind, string> = {
  rollOver: "Roll over",
  jump: "Jump",
  spin: "Spin",
};

/**
 * What the dog should be doing right now. Written by the brain every frame (already smoothed),
 * read by the dog model's update(). The model stays stateless: its pose is a pure function of
 * (t, controls), so all easing / timing lives in the brain.
 */
export interface DogControls {
  /** Where to look, in the dog ROOT's local space (meters). null = idle look-around. */
  lookAt: THREE.Vector3 | null;
  /** 0..1 blend from the idle look-around to fully looking at `lookAt` (head + neck + eyes). */
  lookWeight: number;
  /**
   * Turn-in-place yaw in radians, relative to the root's +Z, applied inside the model so the
   * whole dog rotates about its own center. The brain slews it so the dog turns to face someone
   * that is outside the neck's range. Paws may step while it changes.
   */
  turnYaw: number;
  /** 0..1 how fast turnYaw is currently changing (drives a stepping-in-place leg animation). */
  turnStep: number;
  /** 0..1 general happiness: tail wag amplitude/speed, panting, ears perk. */
  excitement: number;
  /** 0..1 being petted on the head: eyes half-close, head leans up into the hand, ears relax. */
  petHead: number;
  /** 0..1 being petted on the back/body: wiggle, lean towards the hand, very fast tail wag. */
  petBody: number;
  /** World-free hint for the lean direction while petted: hand position in ROOT local space. */
  petPoint: THREE.Vector3 | null;
  /** Active trick or null. progress runs 0 → 1 over TRICK_DURATION[kind]. */
  trick: { kind: TrickKind; progress: number } | null;
}

/** World-space spheres used for petting hit tests, recomputed from the current pose. */
export interface DogZones {
  head: THREE.Sphere;
  body: THREE.Sphere;
}

/** The dog model with the extra hooks the brain needs. Still a normal Character. */
export interface DogCharacter extends Character {
  readonly controls: DogControls;
  /**
   * Petting zones in WORLD space for the pose produced by the last update() (call after update
   * and after the root's world matrix is current; the implementation calls updateWorldMatrix).
   */
  getZones(out: DogZones): DogZones;
  /** World-space point between the dog's eyes (for eye contact / where people look). */
  getEyesWorld(out: THREE.Vector3): THREE.Vector3;
}

/**
 * Turns perception into DogControls for one dog. Implemented in src/dog/brain.ts:
 *   export function createDogBrain(dog: DogCharacter): DogBrain
 */
export interface DogBrain {
  /**
   * Call once per rendered frame BEFORE dog.update(t).
   * @param dt seconds since the previous call (clamp internally to <= 0.1)
   * @param humans everyone currently seen, in world space (may be empty; may be stale by
   *               up to ~0.3 s — vision runs slower than rendering)
   * @param viewerWorld the phone camera position in world space (the user holding the phone)
   */
  update(dt: number, humans: readonly PerceivedHuman[], viewerWorld: THREE.Vector3): void;
  /** Start a trick now (interrupts petting / a running trick of another kind; ignored if the same trick is already running). */
  doTrick(kind: TrickKind): void;
  /** Short status for the UI, e.g. "Looking at someone", "Getting head pats", "Rolling over!" or "" when idle. */
  readonly status: string;
  /** Id of the human the dog is making eye contact with, or null. Only ever one at a time. */
  readonly eyeContactWith: number | null;
  /** Fires on a new petting session start (for hearts / haptics). Returns an unsubscribe. */
  onPetStart(fn: (zone: "head" | "body", worldPoint: THREE.Vector3) => void): () => void;
}
