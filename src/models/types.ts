import type * as THREE from "three";

/**
 * Something placeable built from simple primitives with flat colours (no textures).
 * Real-world scale in meters, `root` origin on the ground, faces +Z, every mesh casts shadows.
 */
export interface Character {
  root: THREE.Group;
  /** Advance the procedural animation. `t` is elapsed seconds since creation, never reset. */
  update(t: number): void;
}
