import type * as THREE from "three";

export type ModelId = "woman" | "man" | "dog";

/**
 * A placeable character built from simple primitives with flat colours (no textures).
 *
 * Conventions every model follows:
 * - Real-world scale in meters (a person is ~1.6–1.8 m tall, the dog ~0.55 m at the head).
 * - `root` origin is on the ground between the feet, so placing it on a surface makes it stand there.
 * - Faces +Z (towards a camera placed in front of it).
 * - Every mesh has castShadow = true.
 * - Geometries and materials are created once at module scope and shared by every instance,
 *   so instances never need disposing.
 */
export interface Character {
  root: THREE.Group;
  /** Advance the procedural idle animation. `t` is elapsed seconds since creation, never reset. */
  update(t: number): void;
}

export interface ModelInfo {
  id: ModelId;
  label: string;
  /** Approximate overall height in meters, used to frame the camera in the preview. */
  height: number;
  create(): Character;
}
