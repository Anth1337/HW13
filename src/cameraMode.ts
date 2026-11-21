import * as THREE from "three";
import {
  FrameCam,
  MAX_GOTO_DIST,
  Press,
  Reticle,
  projectionOf,
  rayToFloor,
  type Projection,
} from "./cameraPlacement";
import type { PetCharacter } from "./dog/types";
import { createDogPlay } from "./dogPlay";
import { createPetCharacter } from "./models/pet";
import { petName, petStore, type Pet } from "./pets";
import { createShadowCatcher, shadowSizeFor } from "./shadow";
import {
  createWorldTracker,
  motionSensorsLikelyAvailable,
  requestMotionPermission,
} from "./tracking";
import type {
  MotionPermission,
  TrackedPose,
  WorldTracker,
} from "./tracking/types";
import type { ARUI } from "./webxr";

/*
 * Camera mode: the experience for browsers without WebXR AR (iPhone Safari, a computer with a
 * webcam). The live camera video fills the screen (object-fit: cover) behind the transparent
 * three.js canvas.
 *
 * TRACKED mode (phones with motion sensors, the default there) mirrors the Android WebXR flow in
 * webxr.ts: scan (point down, move slowly) -> reticle on the floor -> first tap places the dog at
 * real size facing you -> tap the floor to send it, hold (0.6 s) to re-place it at the reticle.
 * The three.js camera follows src/tracking's pose every frame (gyro rotation + visual odometry on
 * the floor plane at an assumed camera height), so the dog stays where it is in the room. World:
 * y up, floor at y = 0. HONEST LIMITS: there is no ARKit / depth on iOS web. Rotation is solid;
 * translation is an estimate from floor features and the assumed height (real phones will drift
 * and lose it over featureless floors; the tracker then reports "limited" and holds position).
 *
 * FALLBACK mode (no motion sensors, permission refused, or the tracker gives up): the old fixed
 * camera. It sits at the origin, pitched down a little, over a virtual floor at -1.3 m; the dog
 * is placed ahead and tapping the floor sends it. The brain's "user" is then a point on the
 * virtual floor in front of the camera, so following / coming stops the dog where it's on screen.
 *
 * Both modes share scene, dog, shadow, vision and UI; only the pose source and the placement flow
 * differ. Hands in the video go through the same detector, lift, brain and hand occluder as in
 * WebXR, with a per-detection CameraModel built from the pose of the video frame.
 */

/** Assumed horizontal field of view across the LONG side of the camera image (typical phone main camera / webcam). */
const LONG_SIDE_FOV_DEG = 65;
/** Fallback virtual floor: the phone is held about chest height. */
const FALLBACK_FLOOR_Y = -1.3;
const DOG_DISTANCE = 1.6;
const MIN_DISTANCE = 0.6;
const MAX_DISTANCE = 5;
/** Fallback: where the brain thinks the user is, metres ahead of the camera. */
const USER_AHEAD_FOLLOW = 0.75;
const USER_AHEAD_FREE = 1.9;
const MARKER_LIFE = 1.2;
const SCAN_HINT = "Point the camera at the floor and move slowly";
const DENIED_HINT =
  "Motion access was refused, so the dog stays in front of the camera. Allow Motion & Orientation Access in Safari settings, then reload.";
const OFF_FLOOR_HINT = (name: string) =>
  `Tap the floor near ${name} (hold to move ${name})`;
const NO_SENSORS_HINT =
  "Motion sensors unavailable — the dog stays in front of the camera";
const HOLD_STEPS = 32;

/** True when this browser can open a camera from a web page (needs HTTPS). */
export function isCameraModeSupported(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

async function resolveMotion(
  motion: Promise<MotionPermission> | undefined,
): Promise<MotionPermission> {
  try {
    // Without the launcher's promise a permission prompt can no longer be shown (the user gesture
    // is spent after awaiting the camera), but browsers that need none still answer "granted".
    return await (motion ?? requestMotionPermission());
  } catch {
    return "unavailable";
  }
}

/**
 * Starts camera mode. Call from a click handler (camera permission prompt). Throws if the camera
 * can't be opened or no pet is active (petStore.active()). `onEnd` runs after Exit, once the camera
 * is stopped and the render loop is free.
 *
 * `motion`: the promise from `requestMotionPermission()`, which the launcher must call
 * SYNCHRONOUSLY at the top of the click handler (iOS only shows the motion prompt from a user
 * gesture, which is gone after the first await). It is awaited here. "granted" starts tracked
 * mode; "denied" / "unavailable" (or a rejection) uses the fixed-camera fallback.
 */
export async function startCameraMode(
  renderer: THREE.WebGLRenderer,
  ui: ARUI,
  video: HTMLVideoElement,
  onEnd: () => void,
  motion?: Promise<MotionPermission>,
): Promise<void> {
  const active = petStore.active();
  if (!active) {
    void motion?.catch(() => {}); // don't leave an unhandled rejection behind
    throw new Error("No animal selected to deploy.");
  }
  const pet: Pet = active; // (a non-null const: callbacks below keep the narrowing)
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "environment", width: { ideal: 1280 } },
    });
  } catch (err) {
    void motion?.catch(() => {}); // don't leave an unhandled rejection behind
    throw err;
  }
  try {
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.hidden = false;
    document.documentElement.classList.add("camera-active");
    await video.play();
    if (!video.videoWidth) {
      await new Promise<void>((resolve) =>
        video.addEventListener("loadedmetadata", () => resolve(), {
          once: true,
        }),
      );
    }
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    video.hidden = true;
    document.documentElement.classList.remove("camera-active");
    void motion?.catch(() => {});
    throw err;
  }

  // Everything below runs with the camera open: on any throw, release it all before rethrowing.
  let tracker: WorldTracker | null = null;
  /** Long-side FOV the projection was last laid out with (the tracker refines it). */
  let layoutFov = LONG_SIDE_FOV_DEG;
  let playRef: { dispose(): void } | null = null;
  try {
    const permission = await resolveMotion(motion);
    if (permission === "granted" && motionSensorsLikelyAvailable()) {
      try {
        tracker = createWorldTracker({ fovLongSideDeg: LONG_SIDE_FOV_DEG });
      } catch (err) {
        console.warn(
          "[camera] tracker failed to start; using the fixed camera",
          err,
        );
      }
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

    // Reticle (same ring as webxr.ts), go-to marker and long-press progress ring.
    const reticleMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
    });
    const reticleMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
      reticleMat,
    );
    reticleMesh.visible = false;
    scene.add(reticleMesh);

    const markerMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.065, 40).rotateX(-Math.PI / 2),
      markerMat,
    );
    marker.visible = false;
    scene.add(marker);

    const holdMat = new THREE.MeshBasicMaterial({
      color: 0x7cd992,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const holdRing = new THREE.Mesh(new THREE.BufferGeometry(), holdMat);
    holdRing.visible = false;
    scene.add(holdRing);
    /** Progress-arc geometries, built lazily per step (no per-frame allocation). */
    const holdGeoms: (THREE.BufferGeometry | undefined)[] = new Array(
      HOLD_STEPS + 1,
    );
    let holdStep = -1;
    const holdGeometry = (step: number) =>
      (holdGeoms[step] ??= new THREE.RingGeometry(
        0.095,
        0.115,
        40,
        1,
        Math.PI / 2,
        (step / HOLD_STEPS) * Math.PI * 2,
      ).rotateX(-Math.PI / 2));

    const catcher = createShadowCatcher(1);
    catcher.visible = false;
    scene.add(catcher);

    // ---- State (declared before any setup call) ----
    const play = createDogPlay(scene, ui, videoUVToScreen, pet.species);
    playRef = play;
    let dog: PetCharacter | null = null;
    let anchor: THREE.Group | null = null;
    let tracked = tracker !== null;
    let floorY = tracked ? 0 : FALLBACK_FLOOR_Y;
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
    const reticle = new Reticle(0);
    const press = new Press();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const hitPoint = new THREE.Vector3();
    const viewer = {
      position: new THREE.Vector3(),
      forward: new THREE.Vector3(0, 0, -1),
    };
    const flatForward = new THREE.Vector3();
    const pose: TrackedPose = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
    };
    const framePose: TrackedPose = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
    };
    const proj: Projection = { w: 1, h: 1, tanX: 1, tanY: 1 };
    const canvas = renderer.domElement;
    let screenW = window.innerWidth;
    let screenH = window.innerHeight;
    let fallbackPitch = 0.3;
    let markerAge = Infinity;
    let now = performance.now() / 1000; // same time base as the rAF timestamps
    let last: number | null = null;
    let lastVideoTime = -1;
    let lastSeenFrames = -1;
    let lastHint = "";
    let hintOverride: { text: string; until: number } | null = null;
    let loopErrors = 0;
    let ended = false;

    const dogName = () => petName(pet);
    const setHint = (text: string) => {
      if (text !== lastHint) ui.hint.textContent = lastHint = text;
    };
    const flashHint = (text: string, seconds = 2.5) => {
      hintOverride = { text, until: now + seconds };
    };

    /** Video uv (v down) → CSS pixels of a w × h box that the video covers. */
    function videoUVToScreen(u: number, v: number, w: number, h: number) {
      const vw = video.videoWidth || w;
      const vh = video.videoHeight || h;
      const scale = Math.max(w / vw, h / vh);
      return {
        x: (w - vw * scale) / 2 + u * vw * scale,
        y: (h - vh * scale) / 2 + v * vh * scale,
      };
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
      // The tracker measures the real FOV once the phone has turned a bit (it starts from the default).
      layoutFov = tracker?.fovLongSideDeg ?? LONG_SIDE_FOV_DEG;
      const focal =
        Math.max(vw, vh) /
        2 /
        Math.tan(THREE.MathUtils.degToRad(layoutFov / 2));
      const visibleH = screenH / coverScale;
      const fov = 2 * Math.atan(visibleH / 2 / focal);
      camera.fov = THREE.MathUtils.radToDeg(fov);
      camera.aspect = screenW / screenH;
      // Fallback: pitch down so the dog's default spot sits a little below the middle of the screen.
      const toDogMid = Math.atan2(-(FALLBACK_FLOOR_Y + 0.3), DOG_DISTANCE);
      fallbackPitch = THREE.MathUtils.clamp(
        toDogMid - 0.15 * fov,
        THREE.MathUtils.degToRad(10),
        THREE.MathUtils.degToRad(30),
      );
      camera.updateProjectionMatrix();
      projectionOf(camera.fov, camera.aspect, screenW, screenH, proj);
      if (!tracked) applyFallbackPose();
    }

    function applyFallbackPose() {
      camera.position.set(0, 0, 0);
      camera.rotation.set(-fallbackPitch, 0, 0);
      camera.updateMatrixWorld(true);
    }

    function setFloor(y: number) {
      floorY = y;
      floor.constant = -y;
      reticle.setFloor(y);
    }

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
      const sc = sun.shadow.camera;
      if (sc.right !== radius) {
        sc.left = sc.bottom = -radius;
        sc.right = sc.top = radius;
        sc.far = SUN_OFFSET.length() + radius * 2;
        sc.updateProjectionMatrix();
      }
    }

    /** First placement (creates the dog) or re-placement at `point`, facing the camera. */
    function placeAt(point: THREE.Vector3, quiet = false) {
      if (!dog || !anchor) {
        dog = createPetCharacter(pet);
        anchor = new THREE.Group();
        anchor.add(dog.root);
        scene.add(anchor);
        play.attach(dog, anchor, floorY);
      }
      play.brain!.placeAt(point, camera.position, floorY);
      anchor.updateMatrixWorld(true);
      fitShadow();
      if (!quiet) navigator.vibrate?.(20);
    }

    function showMarker(point: THREE.Vector3) {
      marker.position.set(point.x, floorY + 0.003, point.z);
      markerAge = 0;
      marker.visible = true;
    }

    /**
     * Reads the pose source into the three.js camera. Tracked: the pose of the video frame on
     * screen (getDisplayPose), so the dog stays locked to the image instead of leading it on
     * every turn; fallback: fixed.
     */
    function updateCameraPose(time: number): boolean {
      if (!tracked || !tracker) return true;
      tracker.processFrame(video, time);
      if (Math.abs(tracker.fovLongSideDeg - layoutFov) > 0.5) layout(); // measured FOV changed
      tracker.getDisplayPose(pose);
      const p = pose.position;
      const q = pose.quaternion;
      if (!Number.isFinite(p.x + p.y + p.z + q.x + q.y + q.z + q.w))
        return false; // keep the last good pose
      camera.position.copy(p);
      camera.quaternion.copy(q);
      camera.updateMatrixWorld(true);
      return true;
    }

    /** The tracker gave up (or never worked): fixed camera, dog ahead, virtual floor. Idempotent. */
    function enterFallback() {
      if (!tracked) return;
      tracked = false;
      tracker?.dispose();
      tracker = null;
      reticle.reset();
      reticleMesh.visible = false;
      holdRing.visible = false;
      press.abort();
      setFloor(FALLBACK_FLOOR_Y);
      applyFallbackPose();
      placeAt(new THREE.Vector3(0, FALLBACK_FLOOR_Y, -DOG_DISTANCE), true);
      flashHint(NO_SENSORS_HINT, 4);
    }

    // ---- Setup ----
    layout();
    play.handOcclusion = true; // no depth API in camera mode
    play.ensureDetector();
    if (!tracked) {
      setFloor(FALLBACK_FLOOR_Y);
      placeAt(new THREE.Vector3(0, FALLBACK_FLOOR_Y, -DOG_DISTANCE), true);
      if (permission === "denied") flashHint(DENIED_HINT, 6);
      else if (permission === "granted" && motionSensorsLikelyAvailable())
        flashHint(NO_SENSORS_HINT, 4);
    }

    ui.overlay.classList.add("camera-mode");
    ui.overlay.hidden = false;

    // ---- Input ----
    const toNdc = (x: number, y: number) => {
      const rect = canvas.getBoundingClientRect();
      return pointer.set(
        ((x - rect.left) / rect.width) * 2 - 1,
        1 - ((y - rect.top) / rect.height) * 2,
      );
    };

    const onDown = (e: PointerEvent) => {
      press.begin(e.pointerId, e.timeStamp / 1000, e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent) =>
      press.move(e.pointerId, e.clientX, e.clientY);
    const onUp = (e: PointerEvent) => {
      const x = press.x;
      const y = press.y;
      const result = press.end(e.pointerId, e.type === "pointercancel");
      holdRing.visible = false;
      if (result !== "tap") return;
      try {
        onTap(x, y);
      } catch (err) {
        console.warn("[camera] tap failed", err);
      }
    };

    function onTap(x: number, y: number) {
      if (tracked) {
        if (!dog) {
          if (reticle.visible && reticle.locked) placeAt(reticle.point);
          return;
        }
        raycaster.setFromCamera(toNdc(x, y), camera);
        const ray = raycaster.ray;
        const t = rayToFloor(ray.origin, ray.direction, floorY, hitPoint);
        if (t === null || t > MAX_GOTO_DIST) {
          flashHint(OFF_FLOOR_HINT(dogName()));
          return;
        }
      } else {
        raycaster.setFromCamera(toNdc(x, y), camera);
        if (!raycaster.ray.intersectPlane(floor, hitPoint)) return;
        // Keep it in a sensible range in front of the camera.
        const dist = Math.hypot(hitPoint.x, hitPoint.z);
        if (dist < 1e-6) return;
        const clamped = THREE.MathUtils.clamp(dist, MIN_DISTANCE, MAX_DISTANCE);
        hitPoint.x *= clamped / dist;
        hitPoint.z *= clamped / dist;
        hitPoint.z = Math.min(hitPoint.z, -MIN_DISTANCE * 0.5);
      }
      if (!play.brain) return;
      hitPoint.y = floorY;
      play.brain.goTo(hitPoint);
      showMarker(hitPoint);
      navigator.vibrate?.(10);
    }
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    // ---- Per-frame work ----
    function frame(time: number) {
      now = time / 1000;
      const dt = last === null ? 0 : Math.min(0.1, Math.max(0, now - last));
      last = now;

      updateCameraPose(time);
      if (tracked && tracker?.state === "unavailable") enterFallback();

      // Reticle + long press (tracked only).
      if (tracked && tracker) {
        reticle.update(
          dt,
          camera.position,
          camera.quaternion,
          tracker.state === "tracking",
        );
        reticleMesh.visible = reticle.visible;
        if (reticle.visible) {
          reticleMesh.position.set(
            reticle.point.x,
            floorY + 0.002,
            reticle.point.z,
          );
          // Scanning feel: pulse until locked, then solid.
          reticleMat.opacity = reticle.locked
            ? 0.85
            : 0.3 + 0.2 * Math.sin(now * 6);
        }
        if (press.tick(now, !!dog && reticle.visible)) {
          placeAt(reticle.point);
          flashHint(`Moved ${dogName()}`, 1.5);
        }
        const frac = dog && reticle.visible ? press.progress(now) : 0;
        if (frac > 0) {
          const step = Math.max(1, Math.round(frac * HOLD_STEPS));
          if (step !== holdStep) {
            holdRing.geometry = holdGeometry(step);
            holdStep = step;
          }
          holdRing.position.copy(reticleMesh.position);
          holdRing.visible = true;
        } else holdRing.visible = false;
      }

      // Hints.
      if (hintOverride && now > hintOverride.until) hintOverride = null;
      if (hintOverride) setHint(hintOverride.text);
      else if (tracked && tracker) {
        if (!dog) {
          if (reticle.visible && reticle.locked)
            setHint(`Tap to place ${dogName()}`);
          else
            setHint(
              tracker.state === "limited" && tracker.message
                ? tracker.message
                : SCAN_HINT,
            );
        } else if (tracker.state === "limited" && tracker.message)
          setHint(tracker.message);
        else setHint(`Tap the floor to send ${dogName()} · hold to move`);
      } else setHint(`Tap the floor to send ${dogName()} there`);

      // Vision: a CameraModel snapshot with the pose of the video frame being detected.
      // Tracked: only on a frame the tracker has just processed, so getFramePose is exactly that frame's pose.
      const poseFresh =
        !tracked || !tracker || tracker.framesProcessed !== lastSeenFrames;
      if (
        video.readyState >= 2 &&
        video.currentTime !== lastVideoTime &&
        poseFresh &&
        play.wantsFrame(time)
      ) {
        lastVideoTime = video.currentTime;
        if (tracked && tracker) lastSeenFrames = tracker.framesProcessed;
        let p = camera.position;
        let q = camera.quaternion;
        if (tracked && tracker) {
          tracker.getFramePose(framePose);
          if (
            Number.isFinite(
              framePose.position.x +
                framePose.position.y +
                framePose.position.z +
                framePose.quaternion.w,
            )
          ) {
            p = framePose.position;
            q = framePose.quaternion;
          }
        }
        play.see(video, time, new FrameCam(p, q, proj, videoUVToScreen));
      }

      // The brain's viewer: the camera itself when tracked; a point ahead on the virtual floor otherwise.
      camera.getWorldDirection(viewer.forward);
      if (tracked) {
        viewer.position.copy(camera.position);
      } else {
        flatForward.set(viewer.forward.x, 0, viewer.forward.z).normalize();
        const ahead =
          play.brain?.mode === "free" ? USER_AHEAD_FREE : USER_AHEAD_FOLLOW;
        viewer.position
          .copy(camera.position)
          .addScaledVector(flatForward, ahead);
      }

      play.update(dt, viewer); // brain, then dog.update(t)
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
    }

    // ---- Loop (never throws into the render loop) ----
    renderer.setAnimationLoop((time) => {
      try {
        frame(time);
      } catch (err) {
        if (loopErrors++ < 3) console.warn("[camera] frame error", err);
      }
      renderer.render(scene, camera);
    });

    // ---- Exit ----
    const onResize = () => layout();
    const end = () => {
      if (ended) return;
      ended = true;
      renderer.setAnimationLoop(null);
      tracker?.dispose();
      tracker = null;
      for (const track of stream.getTracks()) track.stop();
      video.pause();
      video.srcObject = null;
      video.hidden = true;
      document.documentElement.classList.remove("camera-active");
      play.dispose();
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("resize", onResize);
      video.removeEventListener("resize", onResize);
      ui.exit.removeEventListener("click", end);
      for (const track of stream.getTracks())
        track.removeEventListener("ended", end);
      ui.overlay.hidden = true;
      ui.overlay.classList.remove("camera-mode");
      if (anchor) scene.remove(anchor);
      dog?.dispose();
      dog = null;
      anchor = null;
      for (const g of holdGeoms) g?.dispose();
      for (const m of [reticleMesh, marker, holdRing]) {
        if (m !== holdRing) m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      holdRing.geometry.dispose();
      sun.shadow.map?.dispose();
      onEnd();
    };
    window.addEventListener("resize", onResize);
    // The stream's intrinsic size can change without a window resize (resolution switch after
    // start, iOS swapping width/height on rotation): re-run the FOV / cover-crop / ray maths.
    video.addEventListener("resize", onResize);
    ui.exit.addEventListener("click", end);
    // The camera can be taken away (another app, permission revoked): leave cleanly.
    for (const track of stream.getTracks())
      track.addEventListener("ended", end);
  } catch (err) {
    renderer.setAnimationLoop(null);
    tracker?.dispose();
    tracker = null;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    video.hidden = true;
    document.documentElement.classList.remove("camera-active");
    ui.overlay.hidden = true;
    ui.overlay.classList.remove("camera-mode");
    try {
      playRef?.dispose();
    } catch {
      /* already torn down */
    }
    throw err;
  }
}
