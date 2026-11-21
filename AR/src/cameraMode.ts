import * as THREE from "three";
import { createDogPlay } from "./dogPlay";
import { createDogCharacter, dogModel } from "./models/dog";
import { createShadowCatcher, shadowSizeFor } from "./shadow";
import type { CameraModel } from "./vision/types";
import type { ARUI } from "./webxr";

/*
 * Camera mode: the fallback for browsers without WebXR AR (iPhone Safari, a computer with a
 * webcam). The live camera video fills the screen (object-fit: cover) behind the transparent
 * three.js canvas, and one dog stands on a virtual floor in front of the phone.
 *
 * There is no tracking or hit test, so the 3D camera is fixed: at the origin, pitched down a
 * little, with a field of view assumed from typical phone / webcam lenses. The dog stays put on
 * the screen while the phone is held still. People in the video go through the same detector,
 * lift and brain as in WebXR, using a CameraModel that maps video uv through the cover crop.
 */

/** Assumed horizontal field of view across the LONG side of the camera image (typical phone main camera / webcam). */
const LONG_SIDE_FOV_DEG = 65;
/** Virtual floor: the phone is held about chest height. */
const FLOOR_Y = -1.3;
const DOG_DISTANCE = 1.6;
const MIN_DISTANCE = 0.6;
const MAX_DISTANCE = 5;
/** Run the detector at most this often (ms); MediaPipe on a full video frame is not free. */
const DETECT_INTERVAL_MS = 100;

/** True when this browser can open a camera from a web page (needs HTTPS). */
export function isCameraModeSupported(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Starts camera mode. Call from a click handler (camera permission prompt). Throws if the camera
 * can't be opened. `onEnd` runs after Exit, once the camera is stopped and the render loop is free.
 */
export async function startCameraMode(
  renderer: THREE.WebGLRenderer,
  ui: ARUI,
  video: HTMLVideoElement,
  onEnd: () => void,
): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: "environment", width: { ideal: 1280 } },
  });
  try {
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.hidden = false;
    document.documentElement.classList.add("camera-active");
    await video.play();
    if (!video.videoWidth) {
      await new Promise<void>((resolve) => video.addEventListener("loadedmetadata", () => resolve(), { once: true }));
    }
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    video.hidden = true;
    document.documentElement.classList.remove("camera-active");
    throw err;
  }

  // ---- Scene ----
  const scene = new THREE.Scene(); // no background: the video shows through the canvas
  scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.01;
  const shadowCam = sun.shadow.camera;
  shadowCam.left = shadowCam.bottom = -1.2;
  shadowCam.right = shadowCam.top = 1.2;
  shadowCam.near = 0.1;
  shadowCam.far = 8;
  shadowCam.updateProjectionMatrix();
  scene.add(sun, sun.target);
  const SUN_OFFSET = new THREE.Vector3(0.6, 3, 0.4);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50);
  camera.position.set(0, 0, 0);

  const dog = createDogCharacter();
  const anchor = new THREE.Group();
  anchor.add(dog.root, createShadowCatcher(shadowSizeFor(dogModel) * 1.4));
  scene.add(anchor);

  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y);
  function moveDog(x: number, z: number) {
    // Keep it in a sensible range in front of the camera.
    const dist = Math.hypot(x, z);
    const clamped = THREE.MathUtils.clamp(dist, MIN_DISTANCE, MAX_DISTANCE);
    if (dist > 1e-6) {
      x *= clamped / dist;
      z *= clamped / dist;
    }
    if (z > -MIN_DISTANCE * 0.5) z = -MIN_DISTANCE * 0.5; // never behind the camera
    anchor.position.set(x, FLOOR_Y, z);
    // Turn so +Z (the dog's front) faces the camera.
    anchor.rotation.y = Math.atan2(camera.position.x - x, camera.position.z - z);
    anchor.updateMatrixWorld(true);
    sun.target.position.copy(anchor.position);
    sun.position.copy(anchor.position).add(SUN_OFFSET);
    sun.target.updateMatrixWorld();
  }
  moveDog(0, -DOG_DISTANCE);
  dog.update(0);

  // ---- Video uv ↔ screen (object-fit: cover crops the video to fill the screen) ----
  let screenW = window.innerWidth;
  let screenH = window.innerHeight;

  /** Video uv (v down) → CSS pixels of a w × h box that the video covers. */
  function videoUVToScreen(u: number, v: number, w: number, h: number) {
    const vw = video.videoWidth || w;
    const vh = video.videoHeight || h;
    const scale = Math.max(w / vw, h / vh);
    return { x: (w - vw * scale) / 2 + u * vw * scale, y: (h - vh * scale) / 2 + v * vh * scale };
  }

  function layout() {
    screenW = window.innerWidth;
    screenH = window.innerHeight;
    renderer.setSize(screenW, screenH);
    const vw = video.videoWidth || screenW;
    const vh = video.videoHeight || screenH;
    const coverScale = Math.max(screenW / vw, screenH / vh);

    // Focal length in video pixels from the assumed lens FOV, then the vertical FOV of the part
    // of the video that is actually on screen after the cover crop.
    const focal = Math.max(vw, vh) / 2 / Math.tan(THREE.MathUtils.degToRad(LONG_SIDE_FOV_DEG / 2));
    const visibleH = screenH / coverScale;
    const fov = 2 * Math.atan(visibleH / 2 / focal);
    camera.fov = THREE.MathUtils.radToDeg(fov);
    camera.aspect = screenW / screenH;
    // Pitch down so the dog's default spot sits a little below the middle of the screen
    // (≈ 20° on a portrait phone, a bit more on a wide, narrow-FOV landscape webcam).
    const toDogMid = Math.atan2(-(FLOOR_Y + 0.3), DOG_DISTANCE);
    const pitch = THREE.MathUtils.clamp(toDogMid - 0.15 * fov, THREE.MathUtils.degToRad(10), THREE.MathUtils.degToRad(30));
    camera.rotation.set(-pitch, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    camModel.cameraToWorld.extractRotation(camera.matrixWorld);
  }

  /** Same fixed camera for every detection, so one CameraModel serves all frames. */
  const ndc = new THREE.Vector3();
  const camModel: CameraModel = {
    cameraToWorld: new THREE.Matrix4(),
    ray(u, v, outOrigin, outDir) {
      const p = videoUVToScreen(u, v, screenW, screenH);
      ndc.set((p.x / screenW) * 2 - 1, 1 - (p.y / screenH) * 2, 0.5).unproject(camera);
      outOrigin.copy(camera.position);
      outDir.copy(ndc).sub(outOrigin).normalize();
    },
  };
  layout();

  // ---- Dog play ----
  const play = createDogPlay(scene, ui, videoUVToScreen);
  play.addDog(dog);
  play.ensureDetector();

  ui.overlay.classList.add("camera-mode");
  ui.overlay.hidden = false;
  ui.hint.textContent = "Hold the phone still — the dog stays on the screen. Drag to move it.";

  // ---- Drag to move the dog on the virtual floor ----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hitPoint = new THREE.Vector3();
  let dragId: number | null = null;
  const canvas = renderer.domElement;
  function dragTo(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((e.clientY - rect.top) / rect.height) * 2);
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.ray.intersectPlane(floor, hitPoint)) moveDog(hitPoint.x, hitPoint.z);
  }
  const onDown = (e: PointerEvent) => {
    if (dragId !== null) return;
    dragId = e.pointerId;
    canvas.setPointerCapture?.(e.pointerId);
    dragTo(e);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId === dragId) dragTo(e);
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId === dragId) dragId = null;
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  // ---- Loop ----
  const viewerWorld = new THREE.Vector3(); // the phone is the camera at the origin
  const born = performance.now() / 1000;
  let last: number | null = null;
  let lastDetect = -Infinity;
  let lastVideoTime = -1;
  renderer.setAnimationLoop((time) => {
    const now = time / 1000;
    const dt = last === null ? 0 : Math.min(0.1, Math.max(0, now - last));
    last = now;

    if (
      play.detectorState === "ready" &&
      video.readyState >= 2 &&
      time - lastDetect >= DETECT_INTERVAL_MS &&
      video.currentTime !== lastVideoTime
    ) {
      lastDetect = time;
      lastVideoTime = video.currentTime;
      play.see(video, time, camModel);
    }

    play.update(dt, viewerWorld.copy(camera.position));
    dog.update(now - born);
    renderer.render(scene, camera);
  });

  // ---- Exit ----
  let ended = false;
  const onResize = () => layout();
  const end = () => {
    if (ended) return;
    ended = true;
    renderer.setAnimationLoop(null);
    for (const track of stream.getTracks()) track.stop();
    video.pause();
    video.srcObject = null;
    video.hidden = true;
    document.documentElement.classList.remove("camera-active");
    play.dispose();
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    window.removeEventListener("resize", onResize);
    video.removeEventListener("resize", onResize);
    ui.exit.removeEventListener("click", end);
    for (const track of stream.getTracks()) track.removeEventListener("ended", end);
    ui.overlay.hidden = true;
    ui.overlay.classList.remove("camera-mode");
    sun.shadow.map?.dispose();
    onEnd();
  };
  window.addEventListener("resize", onResize);
  // The stream's intrinsic size can change without a window resize (resolution switch after
  // start, iOS swapping width/height on rotation): re-run the FOV / cover-crop / ray maths.
  video.addEventListener("resize", onResize);
  ui.exit.addEventListener("click", end);
  // The camera can be taken away (another app, permission revoked): leave cleanly.
  for (const track of stream.getTracks()) track.addEventListener("ended", end);
}
