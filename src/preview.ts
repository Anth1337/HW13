import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { PetCharacter } from "./dog/types";
import { createPetCharacter } from "./models/pet";
import type { Pet } from "./pets";
import { createShadowCatcher, shadowSizeFor } from "./shadow";

const BASE_FOV = 40;
/** Direction from the dog towards the camera: in front, a little to the side and above. */
const VIEW_DIR = new THREE.Vector3(0.75, 0.32, 1).normalize();

/** Screen pixels covered by the creator panel: along the bottom (portrait) or the right (wide). */
export type PreviewInsets = { bottom: number; right: number };

/**
 * The start screen: a Blender-viewport-style view of the pet being customised, which you can
 * orbit. The pet is rebuilt (and the old one disposed) whenever it changes; the camera glides to
 * frame the new size, so a kitten, a dachshund and a shepherd all fill the view above the panel.
 * setPet(null) empties the stage (the menu), leaving just the grid.
 */
export function createPreview(renderer: THREE.WebGLRenderer, initial: Pet | null) {
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

  const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.01, 50);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.2;

  let dog: PetCharacter | null = null;
  let shadow: THREE.Mesh | null = null;
  let grid: THREE.GridHelper | null = null;
  let gridSize = 0;
  /** Dog size in meters, for framing. */
  const extent = { height: 0.6, footprint: 1 };
  let width = window.innerWidth;
  let height = window.innerHeight;
  /** Measured by main.ts; null until known (then a guess is used). */
  let insets: PreviewInsets | null = null;

  /** Where the camera framing is gliding to (target height + distance), or null when settled. */
  let glide: { x: number; y: number; z: number; distance: number } | null = null;
  controls.addEventListener("start", () => {
    controls.autoRotate = false;
    glide = null; // the user takes over the zoom
  });

  // Idle behaviour: every few seconds the pet glances at the camera and/or wags (any species: controls).
  let now = performance.now() / 1000;
  let lastTime = now;
  let nextEvent = now + 1.5;
  let lookUntil = 0;
  let wagUntil = 0;
  let lookWeight = 0;
  let excitement = 0.2;
  const camLocal = new THREE.Vector3();
  /** Horizontal centre of the dog's bounding box (y unused). */
  const center = new THREE.Vector3();

  function setPet(pet: Pet | null) {
    const next = pet ? createPetCharacter(pet) : null;
    if (dog) {
      scene.remove(dog.root);
      dog.dispose();
    }
    dog = next;
    if (shadow) scene.remove(shadow); // shared geometry/material: nothing to dispose
    shadow = null;
    if (!dog) return; // empty stage: keep the grid and the current framing
    scene.add(dog.root);

    shadow = createShadowCatcher(shadowSizeFor(dog));
    scene.add(shadow);

    extent.height = Math.max(0.1, dog.height);
    extent.footprint = Math.max(0.15, dog.length * 1.05);
    // Orbit around the middle of the dog (its origin is under the body; head and tail stick out).
    dog.update(now);
    const box = new THREE.Box3().setFromObject(dog.root);
    box.getCenter(center);
    if (!Number.isFinite(center.x + center.z)) center.set(0, 0, 0);

    // A grid with 10 cm cells, a few dog-lengths across: the scale reference while resizing.
    const size = Math.max(2, Math.ceil(Math.max(extent.height, extent.footprint) * 4));
    if (size !== gridSize) {
      if (grid) {
        scene.remove(grid);
        grid.geometry.dispose();
        (grid.material as THREE.Material).dispose();
      }
      grid = new THREE.GridHelper(size, size * 10, 0x555555, 0x444444);
      grid.position.y = -0.0005; // under the shadow catcher
      scene.add(grid);
      gridSize = size;
    }

    // Shadow camera around the dog.
    const r = Math.max(extent.height, extent.footprint) * 1.2;
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.near = 0.1;
    cam.far = sun.position.length() + r * 2;
    cam.updateProjectionMatrix();

    frame(true);
  }

  /** Distance that fits the dog in the uncovered part of the screen. */
  function fitDistance(aspect: number, visibleH: number, visibleW: number) {
    const tanV = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2));
    const halfH = extent.height * 0.62; // plus margin
    // Seen from the side at an angle, the dog's projected width is a bit less than its length.
    const halfW = extent.footprint * 0.5;
    return Math.max(halfH / (tanV * visibleH * 0.9), halfW / (tanV * aspect * visibleW * 0.9)) + extent.footprint * 0.3;
  }

  /**
   * Fit the dog in the area not covered by the creator panel (via a view offset), sized from
   * its height and length. `glideTo`: animate there (config change / panel resize) instead of
   * only updating the limits (window resize keeps the user's zoom).
   */
  function frame(glideTo: boolean) {
    const aspect = width / height;
    const portrait = aspect < 1;
    const bottom = insets ? insets.bottom : portrait ? height * 0.55 : 0;
    const right = insets ? insets.right : portrait ? 0 : Math.min(420, width * 0.4);
    // Never let the visible area shrink to nothing.
    const coveredY = Math.min(0.72, bottom / height);
    const coveredX = Math.min(0.6, right / width);

    camera.aspect = aspect;
    camera.fov = BASE_FOV;
    // Shift the picture so the dog sits in the middle of the uncovered area.
    camera.setViewOffset(width, height, (coveredX * width) / 2, (coveredY * height) / 2, width, height);
    camera.near = Math.max(0.01, extent.height * 0.02);
    camera.far = Math.max(50, extent.height * 30);
    camera.updateProjectionMatrix();

    const distance = fitDistance(aspect, 1 - coveredY, 1 - coveredX);
    controls.minDistance = distance * 0.35;
    controls.maxDistance = distance * 2.5;
    const targetY = extent.height * 0.45;

    if (camera.position.lengthSq() === 0) {
      controls.target.set(center.x, targetY, center.z);
      camera.position.copy(controls.target).addScaledVector(VIEW_DIR, distance);
    } else if (glideTo) {
      glide = { x: center.x, y: targetY, z: center.z, distance };
    }
    controls.update();
  }

  function idle(dt: number) {
    if (!dog) return;
    if (now >= nextEvent) {
      const r = Math.random();
      if (r < 0.45) lookUntil = now + 1.5 + Math.random() * 1.5;
      else if (r < 0.75) wagUntil = now + 1.2 + Math.random();
      else {
        lookUntil = now + 2;
        wagUntil = now + 1.6;
      }
      nextEvent = now + 3 + Math.random() * 4;
    }
    const k = 1 - Math.exp(-dt * 4);
    lookWeight += ((now < lookUntil ? 1 : 0) - lookWeight) * k;
    excitement += ((now < wagUntil ? 0.85 : 0.2) - excitement) * k;

    const c = dog.controls;
    c.lookWeight = lookWeight;
    if (lookWeight > 0.01) {
      dog.root.updateWorldMatrix(true, false);
      c.lookAt = dog.root.worldToLocal(camLocal.copy(camera.position));
    } else {
      c.lookAt = null;
    }
    c.excitement = excitement;
  }

  setPet(initial);
  if (!initial) frame(true); // place the camera even with nothing on stage

  return {
    setPet,
    render(time: number) {
      now = time / 1000;
      const dt = Math.min(0.1, Math.max(0, now - lastTime));
      lastTime = now;
      if (glide) {
        const k = 1 - Math.exp(-dt * 6);
        const dir = camera.position.clone().sub(controls.target);
        const d = dir.length();
        dir.divideScalar(d || 1);
        controls.target.x += (glide.x - controls.target.x) * k;
        controls.target.y += (glide.y - controls.target.y) * k;
        controls.target.z += (glide.z - controls.target.z) * k;
        const nd = d + (glide.distance - d) * k;
        camera.position.copy(controls.target).addScaledVector(dir, nd);
        if (Math.abs(glide.distance - nd) < glide.distance * 0.002 && controls.target.distanceTo(new THREE.Vector3(glide.x, glide.y, glide.z)) < 0.001) {
          glide = null;
        }
      }
      idle(dt);
      dog?.update(now);
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
    /** How much of the screen the creator panel covers; re-frames the dog beside / above it. */
    setInsets(next: PreviewInsets) {
      if (insets && Math.abs(next.bottom - insets.bottom) < 1 && Math.abs(next.right - insets.right) < 1) return;
      insets = { ...next };
      frame(true);
    },
    resize(w: number, h: number) {
      width = w;
      height = h;
      frame(false); // keep the user's zoom; controls clamp it to the new limits
    },
  };
}
