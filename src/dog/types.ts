import type * as THREE from "three";
import type { Character } from "../models/types";
import type { Perception } from "../vision/types";

/* ======================================================================================
 * Dog customisation (character creator)
 * ====================================================================================== */

export type Breed =
  | "labrador"
  | "corgi"
  | "dachshund"
  | "husky"
  | "poodle"
  | "beagle"
  | "shepherd"
  | "dalmatian"
  | "pug"
  | "mutt";

export type EarStyle = "floppy" | "pointy" | "folded" | "long";
export type TailStyle = "otter" | "curled" | "stub" | "plume" | "whip";
/** How `primary` / `secondary` coat colours are laid out. */
export type CoatPattern = "solid" | "twoTone" | "saddle" | "spots" | "mask" | "patches";
export type Sex = "female" | "male";

/**
 * Everything the creator can change. Plain JSON (saved to localStorage), colours as "#rrggbb".
 * Every 0..1 slider is relative to the breed's own proportions (0.5 = breed standard).
 */
export interface DogConfig {
  version: 1;
  name: string;
  breed: Breed;
  /** Males are slightly larger and broader-headed; females slightly finer. Nothing else. */
  sex: Sex;
  /** Overall scale within the breed's real size range (0 = small end, 1 = large end). */
  size: number;
  /** Slim (0) → stocky (1). */
  build: number;
  /** Short (0) → long (1) legs, relative to the breed. */
  legLength: number;
  coat: {
    primary: string;
    secondary: string;
    pattern: CoatPattern;
    /** 0 = sleek short coat, 1 = very fluffy (bigger, rounder silhouettes, ruff, feathering). */
    fluff: number;
  };
  face: {
    /** Flat (0, pug) → long (1, borzoi-ish) muzzle, relative to the breed. */
    snoutLength: number;
    earStyle: EarStyle;
    /** 0 small → 1 big eyes. */
    eyeSize: number;
    eyeColor: string;
    noseColor: string;
    /** Contrasting brow spots above the eyes (rottweiler / tri-colour look). */
    brows: boolean;
    tongueOut: boolean;
  };
  tail: TailStyle;
  collar: { color: string; tag: boolean };
}

/** Preset per breed: a full DogConfig minus name/sex, plus display info. src/dog/config.ts. */
export interface BreedPreset {
  breed: Breed;
  label: string;
  /** Real-world height at the withers in meters for size = 0 and size = 1. */
  heightRange: [number, number];
  /** Defaults applied when this breed is picked. */
  defaults: Omit<DogConfig, "version" | "name" | "sex" | "breed">;
  /** Colour swatches offered in the creator for this breed (primary/secondary pairs). */
  coatSwatches: { primary: string; secondary: string; label: string }[];
}

/*
 * src/dog/config.ts must export:
 *   export const BREEDS: BreedPreset[]
 *   export function breedPreset(breed: Breed): BreedPreset
 *   export function defaultDogConfig(): DogConfig            // a labrador named e.g. "Biscuit"
 *   export function configForBreed(breed: Breed, keep?: Partial<Pick<DogConfig, "name" | "sex">>): DogConfig
 *   export function randomDogConfig(): DogConfig             // the dice: random breed + plausible
 *                                                            // variations + random name; uses Math.random
 *   export function sanitizeDogConfig(raw: unknown): DogConfig   // validate / clamp / fill defaults
 *   export const dogConfigStore: {
 *     get(): DogConfig; set(c: DogConfig): void;              // set() saves to localStorage (try/catch)
 *     subscribe(fn: (c: DogConfig) => void): () => void;
 *   }
 *   export const DOG_NAMES: string[]
 */

/* ======================================================================================
 * Dog model ↔ brain
 * ====================================================================================== */

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
 * What the dog is doing right now. Written by the brain every frame (already smoothed),
 * read by the model's update(). The model stays stateless: its pose is a pure function of
 * (t, config, controls). All easing, timing and gait-phase integration live in the brain.
 */
export interface DogControls {
  /** Where to look, in the dog ROOT's local space (meters). null = idle look-around. */
  lookAt: THREE.Vector3 | null;
  /** 0..1 blend from the idle look-around to fully looking at `lookAt` (head + neck + eyes). */
  lookWeight: number;
  /**
   * Locomotion. `phase` is the gait cycle position in CYCLES (integrated by the brain:
   * phase += dt * cyclesPerSecond, never wrapped by the brain — the model uses phase mod 1).
   * `speed` 0 = standing, ~0.4 = walk, 1 = run/gallop; the model blends walk → trot → gallop
   * leg patterns and body bob by it. `turn` -1..1 = turning rate (lean / head into the turn).
   */
  gait: { phase: number; speed: number; turn: number };
  /** 0..1 blend into a sitting pose (haunches down, front legs straight). */
  sit: number;
  /** 0..1 blend into lying down (sphinx). If both sit and lie are > 0, lie wins. */
  lie: number;
  /** 0..1 nose down sniffing (towards lookAt if set, else the ground ahead). */
  sniff: number;
  /** 0..1 general happiness: tail wag amplitude/speed, panting, ears perk. */
  excitement: number;
  /** 0..1 being petted on the head: eyes half-close, head leans up into the hand, ears relax. */
  petHead: number;
  /** 0..1 being petted on the back/body: wiggle, lean towards the hand, very fast tail wag. */
  petBody: number;
  /** Hand position in ROOT local space while petted (lean direction), else null. */
  petPoint: THREE.Vector3 | null;
  /** Active trick or null. progress runs 0 → 1 over TRICK_DURATION[kind]. */
  trick: { kind: TrickKind; progress: number } | null;
}

/** World-space spheres used for petting hit tests, recomputed from the current pose. */
export interface DogZones {
  head: THREE.Sphere;
  body: THREE.Sphere;
}

/**
 * The dog model (src/models/dog.ts):
 *   export function createDogCharacter(config: DogConfig): DogCharacter
 *   export function isDogCharacter(c: Character): c is DogCharacter
 * Geometry/materials depend on the config, so each DogCharacter owns them and must be
 * disposed (dispose()) when replaced. Origin on the ground under the body centre, faces +Z,
 * real-world scale from the breed height range and `size`.
 */
export interface DogCharacter extends Character {
  readonly config: DogConfig;
  readonly controls: DogControls;
  /** Height at the head top when standing (meters), for camera framing. */
  readonly height: number;
  /** Nose-to-rump length (meters), for spacing / follow distances. */
  readonly length: number;
  /** Petting zones in WORLD space for the pose produced by the last update(). */
  getZones(out: DogZones): DogZones;
  /** World-space point between the eyes. */
  getEyesWorld(out: THREE.Vector3): THREE.Vector3;
  /** World-space tip of the nose (sniffing hands). */
  getNoseWorld(out: THREE.Vector3): THREE.Vector3;
  /** Free GPU resources (geometries, materials). The object must not be used afterwards. */
  dispose(): void;
}

/* ======================================================================================
 * Brain: behaviour, movement, commands
 * ====================================================================================== */

/**
 * Persistent behaviour mode:
 * - follow: stays near the phone user; when the user walks more than ~1.6 m away the dog
 *   trots after them and stops ~0.8 m away, facing them. Idles / sniffs around when close.
 * - free: autonomous — wanders, sniffs, sometimes lies down, within ~2.5 m of the user.
 * - stay: holds its spot (sitting or lying if told to; standing after a goTo).
 */
export type DogMode = "follow" | "free" | "stay";

export type DogCommand =
  | "sit" // mode stay + sit pose (until another command)
  | "lie" // mode stay + lie down
  | "stand" // get up, keep the current mode (stay stays stay)
  | "come" // walk to the user, then mode follow
  | "follow" // mode follow
  | "free" // mode free (autonomous)
  | TrickKind; // perform a trick in place, then resume

/**
 * One brain per dog (src/dog/brain.ts):
 *   export function createDogBrain(dog: DogCharacter, anchor: THREE.Object3D, floorY: number): DogBrain
 * The brain OWNS the anchor's transform: it moves anchor.position.x/z on the floor plane
 * y = floorY and sets anchor.rotation.y to the dog's heading (+Z of the dog = forward).
 * The dog's root is a child of the anchor at the origin.
 *
 * Priorities each frame (highest first):
 *   1. A running trick.
 *   2. The phone user's hand (the user's own hand in front of the camera): petting when a hand
 *      is in a zone; otherwise if a hand is near the dog (< ~0.6 m) or held out low in front of
 *      it, the dog looks at it, comes over to sniff it (unless in stay mode — then it only
 *      looks/leans), and follows a slowly moving hand with its head/body (lure).
 *      A hand very close to the camera (nearCamera) gets looked at too.
 *   3. Explicit goTo target / "come".
 *   4. Mode behaviour (follow / free / stay).
 *   5. Eye contact with a face looking at the dog (one at a time, hysteresis) — head only,
 *      layered on top of 3/4 when not walking fast.
 */
export interface DogBrain {
  /**
   * Call once per rendered frame BEFORE dog.update(t).
   * @param dt seconds since the previous call (clamped internally to <= 0.1)
   * @param perception hands + faces in world space (may be stale by up to ~0.3 s; ages tell)
   * @param viewer the phone camera: world position and world forward (unit) vector
   */
  update(dt: number, perception: Perception, viewer: { position: THREE.Vector3; forward: THREE.Vector3 }): void;
  /**
   * Run a command. `by` = who gave it: a PerceivedPerson.id (from a spoken command attributed to a
   * speaker) or null/omitted (the phone holder / a button). "come" walks to THAT person (their
   * floor position) instead of the phone, then follows them while mode is follow; the dog also
   * turns its attention (head / eye contact) to them for a few seconds.
   */
  command(cmd: DogCommand, by?: number | null): void;
  /**
   * Someone spoke (any words, recognised as a command or not): the dog perks up and looks at the
   * speaker `personId` (null = unknown speaker → the phone holder) for ~2 s. Does not change mode.
   */
  hearVoice(personId: number | null): void;
  /** Id of the person the dog is currently paying attention to (eye contact / petting / sniffing their hand / following), or null. */
  readonly attentionPerson: number | null;
  /** Walk to a point on the floor (y ignored), then wait there in stay mode, standing. */
  goTo(worldPoint: THREE.Vector3): void;
  /** Teleport (placement / re-placement) — sets position + faces the given world point. */
  placeAt(worldPoint: THREE.Vector3, faceToward: THREE.Vector3, floorY: number): void;
  readonly mode: DogMode;
  /** Current posture for UI highlighting. */
  readonly posture: "stand" | "sit" | "lie";
  /** Short status for the UI ("Following you", "Sniffing your hand", "Loves the head pats",
   *  "Sitting", "Rolling over!", "Exploring", "Making eye contact", ...). */
  readonly status: string;
  /** Id of the FACE the dog is making eye contact with, or null. Only ever one. */
  readonly eyeContactWith: number | null;
  /** Fires when a petting session starts (hearts / haptics). Returns an unsubscribe. */
  onPetStart(fn: (zone: "head" | "body", worldPoint: THREE.Vector3) => void): () => void;
}
