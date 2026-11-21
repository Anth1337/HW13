import * as THREE from "three";
import { dogConfigStore } from "./dog/config";
import { createDogPlay } from "./dogPlay";
import { createDogCharacter } from "./models/dog";
import { createShadowCatcher, shadowSizeFor } from "./shadow";
import type { CameraModel } from "./vision/types";
import type { ARUI } from "./webxr";

/*
 * Camera mode: the fallback for browsers without WebXR AR (iPhone Safari, a computer with a
 * webcam). The live camera video fills the screen (object-fit: cover) behind the transparent
 * three.js canvas, and the customised dog stands on a virtual floor in front of the phone.
 *
 * There is no tracking or hit test, so the 3D camera is fixed: at the origin, pitched down a
 * little, with a field of view assumed from typical phone / webcam lenses. Hands in the video go
 * through the same detector, lift, brain and hand occluder as in WebXR, using a CameraModel that
 * maps video uv through the cover crop. Tapping the virtual floor sends the dog there.
 *
 * The brain's "user" is not the camera itself but a point a little in front of it on the
 * virtual floor: following / coming then stops the dog where it's still on screen (a dog 0.8 m
 * from a camera held 1.3 m up would be below the bottom edge), and free roam wanders around a
 * spot further ahead so the dog mostly stays in view.
 */

/** Assumed horizontal field of view across the LONG side of the camera image (typical phone main camera / webcam). */
const LONG_SIDE_FOV_DEG = 65;
/** Virtual floor: the phone is held about chest height. */
const FLOOR_Y = -1.3;
const DOG_DISTANCE = 1.6;
const MIN_DISTANCE = 0.6;
const MAX_DISTANCE = 5;
/** Where the brain thinks the user is, metres ahead of the camera (see header). */
const USER_AHEAD_FOLLOW = 0.75;
const USER_AHEAD_FREE = 1.9;
const MARKER_LIFE = 1.2;

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
  sun.shadow.camera.near = 0.1;
  scene.add(sun, sun.target);
  const SUN_OFFSET = new THREE.Vector3(0.6, 3, 0.4);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50);
  camera.position.set(0, 0, 0);

  const dog = createDogCharacter(dogConfigStore.get());
  const anchor = new THREE.Group();
  anchor.add(dog.root);
  scene.add(anchor);
  const catcher = createShadowCatcher(shadowSizeFor(dog));
  scene.add(catcher);

  const markerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.065, 40).rotateX(-Math.PI / 2), markerMat);
  marker.visible = false;
  scene.add(marker);

  // ---- State (declared before any setup call) ----
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hitPoint = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const viewer = { position: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1) };
  const flatForward = new THREE.Vector3();
  const canvas = renderer.domElement;
  let screenW = window.innerWidth;
  let screenH = window.innerHeight;
  let markerAge = Infinity;
  let last: number | null = null;
  let lastVideoTime = -1;
  let ended = false;

  /** Same fixed camera for every detection, so one CameraModel serves all frames. */
  const camModel: CameraModel = {
    cameraToWorld: new THREE.Matrix4(),
    ray(u, v, outOrigin, outDir) {
      const p = videoUVToScreen(u, v, screenW, screenH);
      ndc.set((p.x / screenW) * 2 - 1, 1 - (p.y / screenH) * 2, 0.5).unproject(camera);
      outOrigin.copy(camera.position);
      outDir.copy(ndc).sub(outOrigin).normalize();
    },
  };

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
    // Pitch down so the dog's default spot sits a little below the middle of the screen.
    const toDogMid = Math.atan2(-(FLOOR_Y + 0.3), DOG_DISTANCE);
    const pitch = THREE.MathUtils.clamp(toDogMid - 0.15 * fov, THREE.MathUtils.degToRad(10), THREE.MathUtils.degToRad(30));
    camera.rotation.set(-pitch, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    camModel.cameraToWorld.extractRotation(camera.matrixWorld);
  }

  function followShadow() {
    const p = anchor.position;
    catcher.position.set(p.x, FLOOR_Y + 0.001, p.z);
    sun.target.position.set(p.x, FLOOR_Y, p.z);
    sun.position.copy(sun.target.position).add(SUN_OFFSET);
    sun.target.updateMatrixWorld();
  }

  layout();
  const radius = Math.max(0.6, dog.length * 0.8 + dog.height * 0.6 + 0.25);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -radius;
  sc.right = sc.top = radius;
  sc.far = SUN_OFFSET.length() + radius * 2;
  sc.updateProjectionMatrix();

  // ---- Dog play ----
  const play = createDogPlay(scene, ui, videoUVToScreen);
  const brain = play.attach(dog, anchor, FLOOR_Y);
  brain.placeAt(new THREE.Vector3(0, FLOOR_Y, -DOG_DISTANCE), camera.position, FLOOR_Y);
  play.handOcclusion = true; // no depth API in camera mode
  play.ensureDetector();
  followShadow();

  ui.overlay.classList.add("camera-mode");
  ui.overlay.hidden = false;
  const name = dogConfigStore.get().name.trim() || "your dog";
  ui.hint.textContent = `Tap the floor to send ${name} there`;

  // ---- Tap the virtual floor → go there ----
  const onDown = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((e.clientY - rect.top) / rect.height) * 2);
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(floor, hitPoint)) return;
    // Keep it in a sensible range in front of the camera.
    const dist = Math.hypot(hitPoint.x, hitPoint.z);
    if (dist < 1e-6) return;
    const clamped = THREE.MathUtils.clamp(dist, MIN_DISTANCE, MAX_DISTANCE);
    hitPoint.x *= clamped / dist;
    hitPoint.z *= clamped / dist;
    hitPoint.z = Math.min(hitPoint.z, -MIN_DISTANCE * 0.5);
    hitPoint.y = FLOOR_Y;
    brain.goTo(hitPoint);
    marker.position.set(hitPoint.x, FLOOR_Y + 0.003, hitPoint.z);
    markerAge = 0;
    marker.visible = true;
    navigator.vibrate?.(10);
  };
  canvas.addEventListener("pointerdown", onDown);

  // ---- Loop ----
  renderer.setAnimationLoop((time) => {
    const now = time / 1000;
    const dt = last === null ? 0 : Math.min(0.1, Math.max(0, now - last));
    last = now;

    if (video.readyState >= 2 && video.currentTime !== lastVideoTime && play.wantsFrame(time)) {
      lastVideoTime = video.currentTime;
      play.see(video, time, camModel);
    }

    // The brain's "user": a point on the virtual floor ahead of the camera (see header).
    camera.getWorldDirection(viewer.forward);
    flatForward.set(viewer.forward.x, 0, viewer.forward.z).normalize();
    const ahead = brain.mode === "free" ? USER_AHEAD_FREE : USER_AHEAD_FOLLOW;
    viewer.position.copy(camera.position).addScaledVector(flatForward, ahead);

    play.update(dt, viewer); // brain, then dog.update(t)
    followShadow();

    if (marker.visible) {
      markerAge += dt;
      const k = markerAge / MARKER_LIFE;
      if (k >= 1) marker.visible = false;
      else {
        marker.scale.setScalar(1 + k * 1.5);
        markerMat.opacity = 0.9 * (1 - k);
      }
    }
    renderer.render(scene, camera);
  });

  // ---- Exit ----
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
    window.removeEventListener("resize", onResize);
    video.removeEventListener("resize", onResize);
    ui.exit.removeEventListener("click", end);
    for (const track of stream.getTracks()) track.removeEventListener("ended", end);
    ui.overlay.hidden = true;
    ui.overlay.classList.remove("camera-mode");
    scene.remove(anchor);
    dog.dispose();
    marker.geometry.dispose();
    markerMat.dispose();
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
