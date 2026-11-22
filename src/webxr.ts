import * as THREE from "three";
import type { PetCharacter } from "./dog/types";
import { createDogPlay, type PlayUI } from "./dogPlay";
import { createPetCharacter } from "./models/pet";
import { petName, petStore, type Pet } from "./pets";
import { createShadowCatcher, shadowSizeFor } from "./shadow";
import { DEPTH_SENSING_INIT, createXRVisionSource, gpuDepthOcclusionActive } from "./vision/xrCamera";
import type { XRVisionSource } from "./vision/types";

/**
 * The AR overlay elements (DOM contract ids in comments). Build it with arUIFromDOM().
 * Every field is required; dogPlay.ts uses the PlayUI subset.
 */
export type ARUI = PlayUI & {
  /** #overlay — dom-overlay root; class "camera-mode" in camera mode. */
  overlay: HTMLElement;
  /** #hint */
  hint: HTMLElement;
  /** #status (status chip, hidden when empty) — from PlayUI. */
  /** #vision-canvas — from PlayUI. */
  /** #ar-controls — everything tappable; beforexrselect is prevented on it. */
  controls: HTMLElement;
  /** #cmd-sit, #cmd-lie, #cmd-come, #cmd-mode, #trick-rollOver, #trick-jump, #trick-spin, #btn-vision, #btn-voice, #voice-chip, #voice-hint, #btn-sound — from PlayUI. */
  /** #btn-exit */
  exit: HTMLButtonElement;
};

/** Queries the DOM contract ids. Throws if one is missing (index.html out of sync). */
export function arUIFromDOM(): ARUI {
  const get = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing #${id} in index.html`);
    return el as T;
  };
  return {
    overlay: get("overlay"),
    hint: get("hint"),
    status: get("status"),
    visionCanvas: get<HTMLCanvasElement>("vision-canvas"),
    controls: get("ar-controls"),
    cmdSit: get<HTMLButtonElement>("cmd-sit"),
    cmdLie: get<HTMLButtonElement>("cmd-lie"),
    cmdCome: get<HTMLButtonElement>("cmd-come"),
    cmdMode: get<HTMLButtonElement>("cmd-mode"),
    trick1: get<HTMLButtonElement>("trick-rollOver"),
    trick2: get<HTMLButtonElement>("trick-jump"),
    trick3: get<HTMLButtonElement>("trick-spin"),
    visionToggle: get<HTMLButtonElement>("btn-vision"),
    voiceToggle: get<HTMLButtonElement>("btn-voice"),
    voiceChip: get("voice-chip"),
    voiceHint: get("voice-hint"),
    soundToggle: get<HTMLButtonElement>("btn-sound"),
    exit: get<HTMLButtonElement>("btn-exit"),
  };
}

const NO_CAMERA_ACCESS =
  "This browser doesn't share the camera image — petting with your hand won't work, but commands and tricks do";
/** Seconds to wait for the first camera image before saying the browser doesn't share it. */
const CAMERA_ACCESS_GRACE = 3;
/** Hold the screen this long to re-place the pet at the reticle. */
const LONG_PRESS_S = 0.6;
/** Taps within this height of the dog's floor send it there. */
const SAME_FLOOR = 0.15;
const MAX_GOTO_DIST = 8;
const MARKER_LIFE = 1.2;

/*
 * Session features. "camera-access" (Raw Camera Access, Chrome on Android) gives the hand
 * detector the camera image. "depth-sensing" is requested cpu-optimized ONLY (DEPTH_SENSING_INIT
 * from xrCamera.ts): three r187's built-in GPU depth occlusion (WebXRDepthSensing) samples the
 * depth texture as a sampler2DArray and writes its raw .r into gl_FragDepth, which only works for
 * runtimes that hand out normalised texture-array depth (Quest). Chrome/ARCore hands out a
 * TEXTURE_2D of raw millimetres, so gpu-optimized there would write garbage depth over the whole
 * screen and hide the dog entirely. With cpu depth we get metric hand depth (lift.ts) and occlude
 * with the hand occluder mesh instead. If a runtime ever grants gpu depth anyway, three occludes
 * by itself and gpuDepthOcclusionActive() turns our occluder off.
 * (Note on that GPU path: the environment depth at the dog's feet equals the feet's own depth,
 * so the feet would z-fight with the floor there; nothing we can lift without floating the dog.)
 */
function sessionInits(overlay: HTMLElement): XRSessionInit[] {
  const domOverlay = { root: overlay };
  return [
    {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "camera-access", "depth-sensing"],
      domOverlay,
      depthSensing: DEPTH_SENSING_INIT,
    } as XRSessionInit,
    // Older Chrome can reject the depth-sensing dictionary outright.
    { requiredFeatures: ["hit-test"], optionalFeatures: ["dom-overlay", "camera-access"], domOverlay } as XRSessionInit,
    { requiredFeatures: ["hit-test"], optionalFeatures: ["dom-overlay"], domOverlay },
  ];
}

async function requestARSession(overlay: HTMLElement): Promise<XRSession> {
  let lastErr: unknown;
  for (const init of sessionInits(overlay)) {
    try {
      return await navigator.xr!.requestSession("immersive-ar", init);
    } catch (err) {
      // A SecurityError (no user activation) won't get better on retry.
      if (err instanceof DOMException && err.name === "SecurityError") throw err;
      console.warn("[ar] session init rejected, retrying with fewer features", err);
      lastErr = err;
    }
  }
  throw lastErr;
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
 * Starts a WebXR AR session with the active pet (petStore.active(); throws if there is none).
 *
 * Flow: scanning → reticle on a surface → first tap places the dog there facing you. Then a tap
 * on the floor sends the dog to that spot, a long press (≥ 0.6 s) re-places it at the reticle,
 * and the overlay buttons command it. The camera image (Raw Camera Access) goes through the hand
 * detector so the dog reacts to the user's hand; a hand occluder hides the dog behind the hand.
 *
 * Call from a click handler (user gesture). `onEnd` runs when the session ends (Exit button or
 * the system back gesture). Throws (after cleaning up) if the session can't start.
 */
export async function startARSession(renderer: THREE.WebGLRenderer, ui: ARUI, onEnd: () => void): Promise<void> {
  const active = petStore.active();
  if (!active) throw new Error("No animal selected to deploy.");
  const pet: Pet = active; // (a non-null const: callbacks below keep the narrowing)
  const session = await requestARSession(ui.overlay);

  // ---- Scene ----
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(); // WebXR drives the real camera pose and projection

  scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.01;
  sun.shadow.camera.near = 0.1;
  scene.add(sun, sun.target);
  const SUN_OFFSET = new THREE.Vector3(0.6, 3, 0.4);

  // Reticle: a flat ring on the surface the phone points at.
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Go-to marker: a ring that expands and fades where the user tapped.
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.065, 40).rotateX(-Math.PI / 2), markerMat);
  marker.visible = false;
  scene.add(marker);
  let markerAge = Infinity;

  // Long-press progress ring around the reticle.
  const holdMat = new THREE.MeshBasicMaterial({ color: 0x7cd992, transparent: true, opacity: 0.9, depthWrite: false });
  const holdRing = new THREE.Mesh(new THREE.RingGeometry(0.095, 0.11, 40, 1, 0, 0.001), holdMat);
  holdRing.matrixAutoUpdate = false;
  holdRing.visible = false;
  scene.add(holdRing);

  const catcher = createShadowCatcher(1);
  catcher.visible = false;
  scene.add(catcher);

  // ---- State (all declared before anything below can call into it) ----
  const play = createDogPlay(scene, ui, (u, v, w, h) => ({ x: u * w, y: v * h }), pet.species);
  let dog: PetCharacter | null = null;
  let anchor: THREE.Group | null = null;
  let floorY = 0;
  let hitTestSource: XRHitTestSource | null = null;
  let transientSource: XRTransientInputHitTestSource | null = null;
  let vision: XRVisionSource | null = null;
  let now = 0;
  let lastNow: number | null = null;
  let firstFrame: number | null = null;
  let lastHint = "";
  let hintOverride: { text: string; until: number } | null = null;
  /** Active press: when it started and whether the long press already fired. */
  let press: { source: XRInputSource; start: number; fired: boolean } | null = null;
  /** Latest transient (touch) hit per input source, refreshed every frame. */
  const touchHits = new Map<XRInputSource, THREE.Vector3>();
  const viewer = { position: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1) };
  const viewerQuat = new THREE.Quaternion();
  const ear = { position: viewer.position, quaternion: viewerQuat };
  const reticlePos = new THREE.Vector3();
  const rayO = new THREE.Vector3();
  const rayD = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();

  const dogName = () => petName(pet);
  const setHint = (text: string) => {
    if (text !== lastHint) ui.hint.textContent = lastHint = text;
  };
  const flashHint = (text: string, seconds = 2.5) => {
    hintOverride = { text, until: now + seconds };
  };

  function fitShadow() {
    if (!dog || !anchor) return;
    const p = anchor.position;
    const size = shadowSizeFor(dog);
    catcher.visible = true;
    catcher.scale.set(size, 1, size);
    catcher.position.set(p.x, floorY + 0.001, p.z);
    sun.target.position.set(p.x, floorY, p.z);
    sun.position.copy(sun.target.position).add(SUN_OFFSET);
    sun.target.updateMatrixWorld();
    const radius = Math.max(0.5, dog.length * 0.8 + dog.height * 0.6 + 0.25); // margin for jumps / rolls
    const cam = sun.shadow.camera;
    if (cam.right !== radius) {
      cam.left = cam.bottom = -radius;
      cam.right = cam.top = radius;
      cam.far = SUN_OFFSET.length() + radius * 2;
      cam.updateProjectionMatrix();
    }
  }

  /** First placement (creates the dog) or re-placement at `point`, facing the phone. */
  function placeAt(point: THREE.Vector3) {
    floorY = point.y;
    if (!dog || !anchor) {
      dog = createPetCharacter(pet);
      anchor = new THREE.Group();
      anchor.add(dog.root);
      scene.add(anchor);
      play.attach(dog, anchor, floorY);
    }
    play.brain!.placeAt(point, viewer.position, floorY);
    anchor.updateMatrixWorld(true);
    fitShadow();
    navigator.vibrate?.(20);
  }

  function showMarker(point: THREE.Vector3) {
    marker.position.set(point.x, floorY + 0.003, point.z);
    markerAge = 0;
    marker.visible = true;
  }

  /** Where did this tap land? Touch hit test first, else the tap ray against the dog's floor plane. */
  function tapPoint(source: XRInputSource, frame: XRFrame | undefined): { point: THREE.Vector3; onFloor: boolean } | null {
    const hit = touchHits.get(source);
    if (hit) return { point: hit.clone(), onFloor: Math.abs(hit.y - floorY) <= SAME_FLOOR };
    const refSpace = renderer.xr.getReferenceSpace();
    const pose = frame && refSpace ? frame.getPose(source.targetRaySpace, refSpace) : undefined;
    if (!pose) return null;
    const { position: p, orientation: q } = pose.transform;
    rayO.set(p.x, p.y, p.z);
    rayD.set(0, 0, -1).applyQuaternion(tmpQ.set(q.x, q.y, q.z, q.w));
    if (rayD.y > -1e-3) return null; // pointing at or above the horizon: never reaches the floor
    const t = (floorY - rayO.y) / rayD.y;
    if (t <= 0 || t > MAX_GOTO_DIST) return null;
    return { point: rayO.clone().addScaledVector(rayD, t), onFloor: true };
  }

  // ---- Input ----
  const onSelectStart = (e: XRInputSourceEvent) => {
    press = { source: e.inputSource, start: now, fired: false };
  };
  const onSelectEnd = (e: XRInputSourceEvent) => {
    if (press?.source === e.inputSource) {
      // Keep `press` until "select" (fired after selectend in some browsers, before in others).
      const p = press;
      setTimeout(() => {
        if (press === p) press = null;
      }, 0);
    }
  };
  const onSelect = (e: XRInputSourceEvent) => {
    const longPress = press?.source === e.inputSource && press.fired;
    press = null;
    holdRing.visible = false;
    if (longPress) return; // already re-placed while held
    if (!dog) {
      if (reticle.visible) placeAt(reticlePos);
      return;
    }
    const tap = tapPoint(e.inputSource, e.frame);
    if (!tap) return;
    if (!tap.onFloor) {
      flashHint(`Tap the floor near ${dogName()} (hold to move ${dogName()})`);
      return;
    }
    tap.point.y = floorY;
    play.brain!.goTo(tap.point);
    showMarker(tap.point);
    navigator.vibrate?.(10);
  };

  // ---- Frame loop (installed before setSession so the preview loop never draws over the camera) ----
  renderer.setAnimationLoop((time, frame) => {
    if (!frame || !hitTestSource) return;
    now = time / 1000;
    const dt = lastNow === null ? 0 : Math.min(0.1, Math.max(0, now - lastNow));
    lastNow = now;
    firstFrame ??= now;

    const refSpace = renderer.xr.getReferenceSpace();
    const viewerPose = refSpace ? frame.getViewerPose(refSpace) : undefined;
    if (viewerPose) {
      const { position: p, orientation: q } = viewerPose.transform;
      viewer.position.set(p.x, p.y, p.z);
      viewerQuat.set(q.x, q.y, q.z, q.w);
      viewer.forward.set(0, 0, -1).applyQuaternion(viewerQuat);
    }

    const hit = frame.getHitTestResults(hitTestSource)[0];
    const pose = hit && refSpace ? hit.getPose(refSpace) : undefined;
    reticle.visible = !!pose;
    if (pose) {
      reticle.matrix.fromArray(pose.transform.matrix);
      reticlePos.setFromMatrixPosition(reticle.matrix);
    }

    touchHits.clear();
    if (transientSource && refSpace) {
      for (const r of frame.getHitTestResultsForTransientInput(transientSource)) {
        const first = r.results[0]?.getPose(refSpace);
        if (first) {
          const p = first.transform.position;
          touchHits.set(r.inputSource, new THREE.Vector3(p.x, p.y, p.z));
        }
      }
    }

    // Long press → re-place at the reticle (fires while still held, with a progress ring).
    holdRing.visible = false;
    if (press && !press.fired && dog && reticle.visible) {
      const held = now - press.start;
      if (held >= LONG_PRESS_S) {
        press.fired = true;
        placeAt(reticlePos);
        flashHint(`Moved ${dogName()}`, 1.5);
      } else if (held > 0.15) {
        const frac = (held - 0.15) / (LONG_PRESS_S - 0.15);
        holdRing.geometry.dispose();
        holdRing.geometry = new THREE.RingGeometry(0.095, 0.115, 40, 1, Math.PI / 2, frac * Math.PI * 2).rotateX(
          -Math.PI / 2,
        );
        holdRing.matrix.copy(reticle.matrix);
        holdRing.visible = true;
      }
    }

    // Hints.
    if (hintOverride && now > hintOverride.until) hintOverride = null;
    if (hintOverride) setHint(hintOverride.text);
    else if (!dog) setHint(reticle.visible ? `Tap to place ${dogName()}` : "Slowly move your phone to find the floor");
    else setHint(`Tap the floor to send ${dogName()} · hold to move`);

    // Vision: grab the camera image only when it can be used (to discover camera access, then
    // only when the detector is ready and a detection is due). Each grab is a readPixels.
    if (vision) {
      const due = vision.available ? play.wantsFrame(time) : true;
      const shot = due ? vision.grab(frame, time) : null;
      if (vision.available) {
        play.setNote(null);
        play.ensureDetector();
      } else if (now - firstFrame > CAMERA_ACCESS_GRACE) {
        play.setNote(NO_CAMERA_ACCESS);
      }
      if (shot && play.detectorState === "ready") play.see(shot.image, time, shot.cam);
    } else if (now - firstFrame > CAMERA_ACCESS_GRACE) {
      play.setNote(NO_CAMERA_ACCESS);
    }

    play.handOcclusion = !gpuDepthOcclusionActive(renderer);
    play.update(dt, viewer, ear); // brain, then dog.update(t); ear: the pets' sounds
    if (dog) fitShadow();

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

  try {
    renderer.xr.setReferenceSpaceType("local");
    await renderer.xr.setSession(session);
    const viewerSpace = await session.requestReferenceSpace("viewer");
    const source = await session.requestHitTestSource?.({ space: viewerSpace });
    if (!source) throw new Error("This browser can't find surfaces (no WebXR hit-test).");
    hitTestSource = source;
    try {
      transientSource =
        (await session.requestHitTestSourceForTransientInput?.({ profile: "generic-touchscreen" })) ?? null;
    } catch (err) {
      console.warn("[ar] no touch hit test; taps use the floor plane", err);
    }
  } catch (err) {
    renderer.setAnimationLoop(null);
    play.dispose();
    disposeScene();
    await session.end().catch(() => {});
    throw err; // the caller shows the error on the start screen
  }
  try {
    vision = createXRVisionSource(renderer, session);
  } catch (err) {
    console.warn("[ar] no camera image for hand detection", err); // commands still work
  }
  ui.overlay.classList.remove("camera-mode");
  ui.overlay.hidden = false;

  // Taps on the overlay buttons must not also count as a tap in the scene.
  const blockSelect = (e: Event) => e.preventDefault();
  ui.controls.addEventListener("beforexrselect", blockSelect);
  const onExit = () => void session.end();
  ui.exit.addEventListener("click", onExit);
  session.addEventListener("selectstart", onSelectStart);
  session.addEventListener("selectend", onSelectEnd);
  session.addEventListener("select", onSelect);

  function disposeScene() {
    if (anchor) scene.remove(anchor);
    dog?.dispose();
    dog = null;
    anchor = null;
    for (const m of [reticle, marker, holdRing]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    sun.shadow.map?.dispose();
  }

  // ---- Teardown ----
  session.addEventListener("end", () => {
    hitTestSource?.cancel();
    hitTestSource = null;
    transientSource?.cancel();
    transientSource = null;
    vision?.dispose();
    vision = null;
    renderer.setAnimationLoop(null);
    play.dispose(); // the detector itself stays cached for the next session
    session.removeEventListener("selectstart", onSelectStart);
    session.removeEventListener("selectend", onSelectEnd);
    session.removeEventListener("select", onSelect);
    ui.controls.removeEventListener("beforexrselect", blockSelect);
    ui.exit.removeEventListener("click", onExit);
    ui.overlay.hidden = true;
    disposeScene();
    onEnd();
  });
}
