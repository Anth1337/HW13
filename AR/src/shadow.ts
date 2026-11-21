import * as THREE from "three";
import type { ModelInfo } from "./models";

// One shared 1 m plane, scaled per character. Never dispose these.
const unitPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.35, depthWrite: false });

/**
 * Side length (meters) of the shadow catcher for a character. The sun sits high,
 * so a shadow reaches about 0.25 x height sideways; this leaves room for that
 * without the plane hanging far off a table edge.
 */
export function shadowSizeFor(model: ModelInfo): number {
  return Math.max(0.6, model.height * 0.8);
}

/** An invisible square plane that only shows shadows, so a character appears to cast one on the real floor. */
export function createShadowCatcher(size: number): THREE.Mesh {
  const plane = new THREE.Mesh(unitPlane, shadowMaterial);
  plane.scale.set(size, 1, size);
  plane.position.y = 0.001; // avoid z-fighting with the reticle / grid
  plane.receiveShadow = true;
  return plane;
}
