import * as THREE from "three";

/** Edge length of a cube, in meters (20 cm). Blender's default cube is 2 m, which is huge in a room. */
export const CUBE_SIZE = 0.2;

// Shared by every cube. Never dispose these.
const cubeGeometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
const cubeMaterial = new THREE.MeshStandardMaterial({
  color: 0xcccccc, // Blender's default light grey
  roughness: 0.5,
  metalness: 0,
});
// Small enough that shadows from nearby cubes rarely double up, or hang off a table edge.
const shadowGeometry = new THREE.PlaneGeometry(CUBE_SIZE * 3, CUBE_SIZE * 3).rotateX(-Math.PI / 2);
const shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.35, depthWrite: false });

/**
 * A Blender-style default cube. Its origin is the center of the bottom face,
 * so placing the group on a surface makes the cube sit on it.
 */
export function createCube(): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(cubeGeometry, cubeMaterial);
  mesh.position.y = CUBE_SIZE / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

/** An invisible plane that only shows shadows, so the cube appears to cast one on the real floor. */
export function createShadowCatcher(): THREE.Mesh {
  const plane = new THREE.Mesh(shadowGeometry, shadowMaterial);
  plane.position.y = 0.001; // avoid z-fighting with the reticle
  plane.receiveShadow = true;
  return plane;
}
