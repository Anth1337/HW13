import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CUBE_SIZE, createCube } from "./cube";

/** The non-AR start screen: a Blender-viewport-style view of the cube you can orbit. */
export function createPreview(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x393939); // Blender viewport grey

  const grid = new THREE.GridHelper(2, 20, 0x555555, 0x444444);
  scene.add(grid);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);

  scene.add(createCube());

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 50);
  camera.position.set(0.5, 0.4, 0.6);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, CUBE_SIZE / 2, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 0.3;
  controls.maxDistance = 3;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.5;
  controls.addEventListener("start", () => (controls.autoRotate = false));
  controls.update();

  return {
    render() {
      controls.update();
      renderer.render(scene, camera);
    },
    resize(width: number, height: number) {
      camera.aspect = width / height;
      // Portrait phones: widen the view so the cube fits across and sits above the text.
      camera.fov = camera.aspect < 1 ? Math.min(75, 40 / Math.sqrt(camera.aspect)) : 40;
      controls.target.y = camera.aspect < 1 ? CUBE_SIZE * 0.1 : CUBE_SIZE / 2;
      camera.updateProjectionMatrix();
    },
  };
}
