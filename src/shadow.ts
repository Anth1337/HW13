import * as THREE from "three";

// One shared 1 m plane, scaled per dog. Never dispose these.
const unitPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.35, depthWrite: false });

/** The size of the dog, as a DogCharacter reports it (meters). */
export type ShadowSizeSource = { height: number; length?: number };

/**
 * Side length (meters) of the shadow catcher for a dog. The plane is centred under the dog,
 * which turns, so it covers the nose-to-rump length in any direction plus the reach of the
 * shadow (the sun sits high: about 0.25 x height sideways), without hanging far off a table edge.
 */
export function shadowSizeFor(dog: ShadowSizeSource): number {
  const length = dog.length ?? dog.height * 1.2;
  return Math.max(0.5, length * 1.5, dog.height * 1.1);
}

/** An invisible square plane that only shows shadows, so the dog appears to cast one on the real floor. */
export function createShadowCatcher(size: number): THREE.Mesh {
  const plane = new THREE.Mesh(unitPlane, shadowMaterial);
  plane.scale.set(size, 1, size);
  plane.position.y = 0.001; // avoid z-fighting with the reticle / grid
  plane.receiveShadow = true;
  return plane;
}
