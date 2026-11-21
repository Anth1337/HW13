import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Character, ModelId, ModelInfo } from "./models";
import { createShadowCatcher, shadowSizeFor } from "./shadow";

const BASE_FOV = 40;
/** Direction from the model towards the camera: in front, a little to the side and above. */
const VIEW_DIR = new THREE.Vector3(0.55, 0.3, 1).normalize();

type Shown = { info: ModelInfo; character: Character; born: number; group: THREE.Group };

/** The non-AR start screen: a Blender-viewport-style view of the selected character you can orbit. */
export function createPreview(renderer: THREE.WebGLRenderer, initial: ModelInfo) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x393939); // Blender viewport grey

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(1, 3, 1.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.01;
  scene.add(sun, sun.target);

  let grid: THREE.GridHelper | null = null;

  const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.01, 50);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.5;
  controls.addEventListener("start", () => (controls.autoRotate = false));

  // Characters are built once per model and kept, so switching back is instant
  // (geometries and materials are shared at module scope anyway).
  const cache = new Map<ModelId, Shown>();
  let shown: Shown | null = null;
  let now = performance.now() / 1000;
  let width = window.innerWidth;
  let height = window.innerHeight;
  /** Pixels at the bottom of the screen covered by the start-screen UI (measured by main.ts). */
  let coveredPx: number | null = null;

  /** Model size in meters: vertical from ModelInfo.height, horizontal from its footprint. */
  const extent = { height: 1, footprint: 0.5 };

  function setModel(info: ModelInfo) {
    if (shown?.info === info) return;
    if (shown) scene.remove(shown.group);

    let next = cache.get(info.id);
    if (!next) {
      const character = info.create();
      const group = new THREE.Group();
      group.add(character.root, createShadowCatcher(shadowSizeFor(info)));
      next = { info, character, born: now, group };
      cache.set(info.id, next);
    }
    shown = next;
    scene.add(next.group);

    // Footprint: the widest horizontal diagonal, since the view orbits around it.
    next.character.update(now - next.born);
    const box = new THREE.Box3().setFromObject(next.character.root);
    const size = box.getSize(new THREE.Vector3());
    extent.height = info.height;
    extent.footprint = Math.hypot(size.x, size.z) || info.height * 0.5;

    // A grid with 10 cm cells, a few model-heights across.
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    }
    const gridSize = Math.max(2, Math.ceil(info.height * 3));
    grid = new THREE.GridHelper(gridSize, gridSize * 10, 0x555555, 0x444444);
    grid.position.y = -0.0005; // under the shadow catcher
    scene.add(grid);

    // Shadow camera around the model.
    const r = Math.max(info.height, extent.footprint) * 1.2;
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.near = 0.1;
    cam.far = sun.position.length() + r * 2;
    cam.updateProjectionMatrix();

    frame(true);
  }

  /**
   * Fit the model on screen. The start screen's text and buttons cover the bottom of the
   * view, so the model is centered in the area above them (via a view offset) and sized
   * to fit both its height and its footprint, in portrait and landscape.
   */
  function frame(resetDistance: boolean) {
    const aspect = width / height;
    const portrait = aspect < 1;
    // Fraction of the screen height (from the bottom) covered by the start-screen UI:
    // measured when known, otherwise a guess. Capped so the model never shrinks to nothing.
    const covered = Math.min(0.7, coveredPx !== null ? coveredPx / height : portrait ? 0.45 : 0.3);
    const visible = 1 - covered;

    camera.aspect = aspect;
    camera.fov = BASE_FOV;
    // Shift the picture up so the model sits in the middle of the uncovered area.
    camera.setViewOffset(width, height, 0, (covered * height) / 2, width, height);
    camera.near = Math.max(0.01, extent.height * 0.02);
    camera.far = Math.max(50, extent.height * 30);
    camera.updateProjectionMatrix();

    const tanV = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2));
    const halfH = extent.height * 0.6; // plus 20% margin
    const halfW = extent.footprint * 0.6;
    const distance =
      Math.max(halfH / (tanV * visible * 0.9), halfW / (tanV * aspect * 0.9)) + extent.footprint / 2;

    controls.target.set(0, extent.height / 2, 0);
    controls.minDistance = distance * 0.35;
    controls.maxDistance = distance * 2.5;

    if (resetDistance || camera.position.lengthSq() === 0) {
      // Keep the current viewing direction if the user has orbited, otherwise use the default.
      const dir = camera.position.lengthSq() === 0
        ? VIEW_DIR.clone()
        : camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(dir, distance);
    }
    controls.update();
  }

  setModel(initial);

  return {
    setModel,
    render(time: number) {
      now = time / 1000;
      if (shown) shown.character.update(now - shown.born);
      controls.update();
      renderer.render(scene, camera);
    },
    /**
     * Attach/detach the orbit controls. Off while AR / camera mode owns the canvas, so drags
     * there don't orbit the hidden preview (or cancel its auto-rotate).
     */
    setInteractive(on: boolean) {
      controls.enabled = on;
    },
    /** Tell the preview how much of the bottom of the screen the UI covers, and re-frame the model above it. */
    setCovered(px: number) {
      if (coveredPx !== null && Math.abs(px - coveredPx) < 1) return;
      coveredPx = px;
      frame(true);
    },
    resize(w: number, h: number) {
      width = w;
      height = h;
      frame(false); // keep the user's zoom; controls clamp it to the new limits
    },
  };
}
