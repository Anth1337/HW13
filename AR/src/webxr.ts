import * as THREE from "three";
import { createDogPlay, type PlayUI } from "./dogPlay";
import { getModel, type Character, type ModelInfo } from "./models";
import { isDogCharacter } from "./models/dog";
import { selection } from "./selection";
import { createShadowCatcher, shadowSizeFor } from "./shadow";
import { createXRVisionSource } from "./vision/xrCamera";
import type { XRVisionSource } from "./vision/types";

export type ARUI = PlayUI & {
  overlay: HTMLElement;
  hint: HTMLElement;
  /**
   * Bottom controls (trick buttons, character picker, vision toggle, toolbar). Taps on it must
   * not place a character.
   */
  controls: HTMLElement;
  undo: HTMLButtonElement;
  clear: HTMLButtonElement;
  exit: HTMLButtonElement;
};

const NO_CAMERA_ACCESS =
  "This phone's browser doesn't share the camera image with web pages, so the dog can't see people. Tricks still work.";
/** Seconds to wait for the first camera image before saying the browser doesn't share it. */
const CAMERA_ACCESS_GRACE = 3;

/**
 * Session features. "camera-access" (Raw Camera Access, Chrome 107+ on Android) lets the dog see
 * people; "depth-sensing" (cpu-optimized only: three.js leaves CPU depth alone) gives metric
 * distances to them. Both are optional, so AR still starts without them.
 */
function fullSessionInit(overlay: HTMLElement): XRSessionInit {
  return {
    requiredFeatures: ["hit-test"],
    optionalFeatures: ["dom-overlay", "camera-access", "depth-sensing"],
    domOverlay: { root: overlay },
    depthSensing: {
      usagePreference: ["cpu-optimized"],
      dataFormatPreference: ["luminance-alpha", "float32"],
    },
  } as XRSessionInit;
}

/** The original feature set, for browsers that reject the newer optional features outright. */
function minimalSessionInit(overlay: HTMLElement): XRSessionInit {
  return {
    requiredFeatures: ["hit-test"],
    optionalFeatures: ["dom-overlay"],
    domOverlay: { root: overlay },
  };
}

/** True where WebXR "immersive-ar" works: Chrome on an ARCore Android phone. */
export async function isWebXRARSupported(): Promise<boolean> {
  if (!window.isSecureContext || !navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-ar");
  } catch {
    return false;
  }
}

/**
 * Starts a WebXR AR session. The camera feed fills the screen, a ring shows the
 * surface in the middle of the view, and tapping the screen places the selected
 * character there, facing you. Every placed character plays its idle animation.
 *
 * Placed dogs also get a brain: the AR camera image (Raw Camera Access) goes through the
 * people detector, people are lifted into world space, and each dog reacts to petting, makes
 * eye contact with one person at a time and does tricks from the trick buttons.
 *
 * Call this from a click handler (browsers require a user gesture). `onEnd`
 * runs when the session ends, whether from the Exit button or the system back gesture.
 */
export async function startARSession(
  renderer: THREE.WebGLRenderer,
  ui: ARUI,
  onEnd: () => void,
): Promise<void> {
  let session: XRSession;
  try {
    session = await navigator.xr!.requestSession("immersive-ar", fullSessionInit(ui.overlay));
  } catch (err) {
    // Older Chrome can reject the depth-sensing dictionary or unknown features: retry the old set.
    console.warn("[ar] full feature set rejected, retrying with the minimal one", err);
    session = await navigator.xr!.requestSession("immersive-ar", minimalSessionInit(ui.overlay));
  }

  // ---- Scene ----
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(); // WebXR drives the real camera pose and projection

  scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2.2));

  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 10;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.01;
  scene.add(sun, sun.target);
  const SUN_OFFSET = new THREE.Vector3(0.6, 3, 0.4);

  // Reticle: a flat ring that sits on the surface the phone points at.
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  type Placed = { anchor: THREE.Group; character: Character; info: ModelInfo; born: number };
  const placed: Placed[] = [];
  let now = 0; // seconds, from the XR frame time
  let lastNow: number | null = null;
  let firstFrame: number | null = null;

  // ---- Dog play: people detection, brains, hearts, tricks, status chip ----
  // Assumption: in handheld AR the XR view fills the screen and the camera image is aligned
  // with that view, so image uv maps straight onto the overlay for the vision drawing.
  const play = createDogPlay(scene, ui, (u, v, w, h) => ({ x: u * w, y: v * h }));
  let vision: XRVisionSource | null = null;
  const viewerWorld = new THREE.Vector3();

  // ---- Session setup ----
  let hitTestSource: XRHitTestSource | null = null;

  let lastHint = "";
  const setHint = (text: string) => {
    if (text !== lastHint) ui.hint.textContent = lastHint = text;
  };

  // Install the AR loop *before* the session starts. three.js stops its normal
  // (non-XR) loop when the session starts, so the loop only runs on XR frames.
  // Setting it before the session also keeps the preview scene from drawing
  // over the camera feed while the session is starting up.
  renderer.setAnimationLoop((time, frame) => {
    if (!frame || !hitTestSource) return;
    now = time / 1000;
    const dt = lastNow === null ? 0 : Math.min(0.1, Math.max(0, now - lastNow));
    lastNow = now;
    firstFrame ??= now;

    const refSpace = renderer.xr.getReferenceSpace();
    const hit = frame.getHitTestResults(hitTestSource)[0];
    const pose = hit && refSpace ? hit.getPose(refSpace) : undefined;
    if (pose) {
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
    } else {
      reticle.visible = false;
    }

    if (!reticle.visible) setHint("Slowly move your phone to find the floor or a table");
    else if (placed.length === 0) setHint(`Tap to place a ${getModel(selection.get()).label.toLowerCase()}`);
    else setHint(`${placed.length} placed · tap to place another`);

    // Vision: at most one camera image every ~100 ms. The (large) detector only loads once the
    // browser has actually shared a camera image.
    if (vision) {
      // Only read the camera back when the image can be used: until the first image proves
      // camera access works, then only once the detector is ready (not while it downloads, and
      // not at all if it failed to load). Each grab is a synchronous readPixels.
      const wantShot = !vision.available || play.detectorState === "ready";
      const shot = wantShot ? vision.grab(frame, time) : null;
      if (vision.available) {
        play.setNote(null);
        play.ensureDetector();
      } else if (now - firstFrame > CAMERA_ACCESS_GRACE) {
        play.setNote(NO_CAMERA_ACCESS);
      }
      if (shot) play.see(shot.image, time, shot.cam);
    } else if (now - firstFrame > CAMERA_ACCESS_GRACE) {
      play.setNote(NO_CAMERA_ACCESS);
    }

    const viewerPose = refSpace ? frame.getViewerPose(refSpace) : undefined;
    if (viewerPose) {
      const p = viewerPose.transform.position;
      viewerWorld.set(p.x, p.y, p.z);
    }
    play.update(dt, viewerWorld); // dog brains run before the dogs pose themselves
    for (const p of placed) p.character.update(now - p.born);

    renderer.render(scene, camera);
  });

  try {
    renderer.xr.setReferenceSpaceType("local");
    await renderer.xr.setSession(session);
    const viewerSpace = await session.requestReferenceSpace("viewer");
    const source = await session.requestHitTestSource?.({ space: viewerSpace });
    if (!source) throw new Error("This browser can't find surfaces (no WebXR hit-test).");
    hitTestSource = source;
  } catch (err) {
    play.dispose();
    await session.end().catch(() => {});
    throw err; // the caller shows the error on the start screen
  }
  try {
    vision = createXRVisionSource(renderer, session);
  } catch (err) {
    console.warn("[ar] no camera image for people detection", err); // tricks still work
  }
  ui.overlay.classList.remove("camera-mode");
  ui.overlay.hidden = false;

  // Taps on the overlay picker and buttons must not also count as "place a character".
  const blockSelect = (e: Event) => e.preventDefault();
  ui.controls.addEventListener("beforexrselect", blockSelect);

  // ---- Actions ----
  const camPos = new THREE.Vector3();
  const scratch = new THREE.Vector3();

  function place() {
    if (!reticle.visible) return;
    const info = getModel(selection.get());
    const character = info.create();
    const anchor = new THREE.Group();
    anchor.position.setFromMatrixPosition(reticle.matrix);
    // Stand upright and turn around Y so +Z (the character's front) faces the phone.
    camPos.setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
    anchor.rotation.y = Math.atan2(camPos.x - anchor.position.x, camPos.z - anchor.position.z);
    anchor.add(character.root);
    scene.add(anchor);
    anchor.updateMatrixWorld(true);
    character.update(0);
    if (isDogCharacter(character)) play.addDog(character);
    placed.push({ anchor, character, info, born: now });
    fitShadowToPlaced();
    updateButtons();
  }

  function remove(p: Placed) {
    scene.remove(p.anchor);
    if (isDogCharacter(p.character)) play.removeDog(p.character);
  }

  function undo() {
    const last = placed.pop();
    if (last) remove(last);
    fitShadowToPlaced();
    updateButtons();
  }

  function clear() {
    for (const p of placed) remove(p);
    placed.length = 0;
    fitShadowToPlaced();
    updateButtons();
  }

  /**
   * Keep the sun's shadow camera around every placed character (feet to head) so each
   * one casts a full shadow. A 1.8 m person needs a much bigger box than the dog.
   */
  function fitShadowToPlaced() {
    fitShadowCatchers();
    if (placed.length === 0) return;
    const box = new THREE.Box3();
    let tallest = 0;
    for (const p of placed) {
      box.expandByPoint(p.anchor.position);
      box.expandByPoint(scratch.copy(p.anchor.position).setY(p.anchor.position.y + p.info.height));
      tallest = Math.max(tallest, p.info.height);
    }
    const center = box.getCenter(new THREE.Vector3());
    // Extra margin: a jumping or rolling dog leaves its standing box.
    const radius = box.getSize(new THREE.Vector3()).length() / 2 + 0.5 + tallest * 0.3;

    sun.target.position.copy(center);
    sun.position.copy(center).add(SUN_OFFSET);
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.far = SUN_OFFSET.length() + radius * 2;
    cam.updateProjectionMatrix();
  }

  /**
   * One shadow catcher per surface height (floor, table, ...), sized to cover every character
   * standing on it. Separate per-character planes would overlap where characters stand close
   * together, drawing the shadow twice (too dark) and z-fighting.
   */
  const catchers: THREE.Mesh[] = [];
  const LEVEL_TOLERANCE = 0.03; // characters within 3 cm of height share a surface
  function fitShadowCatchers() {
    const levels: { y: number; box: THREE.Box3 }[] = [];
    for (const p of placed) {
      const { x, y, z } = p.anchor.position;
      const half = shadowSizeFor(p.info) / 2;
      let level = levels.find((l) => Math.abs(l.y - y) < LEVEL_TOLERANCE);
      if (!level) levels.push((level = { y, box: new THREE.Box3() }));
      level.box.expandByPoint(scratch.set(x - half, y, z - half));
      level.box.expandByPoint(scratch.set(x + half, y, z + half));
    }
    while (catchers.length > levels.length) scene.remove(catchers.pop()!);
    levels.forEach((level, i) => {
      if (!catchers[i]) scene.add((catchers[i] = createShadowCatcher(1)));
      const c = catchers[i];
      const { min, max } = level.box;
      c.scale.set(max.x - min.x, 1, max.z - min.z);
      c.position.set((min.x + max.x) / 2, level.y + 0.001, (min.z + max.z) / 2);
    });
  }

  function updateButtons() {
    ui.undo.disabled = placed.length === 0;
    ui.clear.disabled = placed.length === 0;
  }

  const onUndo = () => undo();
  const onClear = () => clear();
  const onExit = () => void session.end();
  ui.undo.addEventListener("click", onUndo);
  ui.clear.addEventListener("click", onClear);
  ui.exit.addEventListener("click", onExit);
  session.addEventListener("select", place);
  updateButtons();

  // ---- Teardown ----
  session.addEventListener("end", () => {
    hitTestSource?.cancel();
    hitTestSource = null;
    vision?.dispose();
    vision = null;
    play.dispose(); // the people detector itself stays cached for the next session
    session.removeEventListener("select", place);
    ui.controls.removeEventListener("beforexrselect", blockSelect);
    ui.undo.removeEventListener("click", onUndo);
    ui.clear.removeEventListener("click", onClear);
    ui.exit.removeEventListener("click", onExit);
    ui.overlay.hidden = true;
    reticle.geometry.dispose();
    (reticle.material as THREE.Material).dispose();
    sun.shadow.map?.dispose();
    renderer.setAnimationLoop(null);
    onEnd();
  });
}
