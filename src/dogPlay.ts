import * as THREE from "three";
import { createDogBrain } from "./dog/brain";
import { createPetFx } from "./dog/fx";
import { TRICK_LABEL, type DogBrain, type DogCharacter, type DogCommand, type DogMode, type TrickKind } from "./dog/types";
import { createVisionDetector } from "./vision/detector";
import { HAND_BONES, createHandOccluder } from "./vision/handOccluder";
import { liftObservation } from "./vision/lift";
import type { CameraModel, Observation, Perception, VisionDetector } from "./vision/types";

/*
 * Everything the two "play with the dog" modes share (WebXR AR in webxr.ts and the camera
 * fallback in cameraMode.ts): the cached hand/face detector, the single dog's brain, the hand
 * occluder, petting hearts + haptics, the command / trick / vision buttons, the status chip and
 * the "Show vision" debug drawing.
 *
 * Per rendered frame a mode calls, in this order:
 *   if (play.wantsFrame(timeMs)) play.see(image, timeMs, cam)   // fresh camera image only
 *   play.update(dt, viewer)                                      // brain → dog.update(t) → occluder/fx/UI
 */

/** The overlay elements dog play drives (a subset of webxr.ts's ARUI). */
export type PlayUI = {
  status: HTMLElement;
  visionCanvas: HTMLCanvasElement;
  cmdSit: HTMLButtonElement;
  cmdLie: HTMLButtonElement;
  cmdCome: HTMLButtonElement;
  cmdMode: HTMLButtonElement;
  trickRollOver: HTMLButtonElement;
  trickJump: HTMLButtonElement;
  trickSpin: HTMLButtonElement;
  visionToggle: HTMLButtonElement;
};

/** Maps camera-image uv (v down, 0..1) to overlay CSS pixels of a width × height box. */
export type UVToScreen = (u: number, v: number, width: number, height: number) => { x: number; y: number };

export type Viewer = { position: THREE.Vector3; forward: THREE.Vector3 };

export type DetectorState = "idle" | "loading" | "ready" | "failed";

export const TRICKS: TrickKind[] = ["rollOver", "jump", "spin"];

export const MODE_LABEL: Record<DogMode, string> = { follow: "Follow", free: "Free roam", stay: "Stay" };

// ---- Detector: loaded once per page and kept (MediaPipe models are several MB) ----
let detectorPromise: Promise<VisionDetector> | null = null;
function loadDetector(): Promise<VisionDetector> {
  if (!detectorPromise) {
    detectorPromise = createVisionDetector({ maxHands: 2, maxFaces: 2 });
    detectorPromise.catch(() => (detectorPromise = null)); // a later session may retry
  }
  return detectorPromise;
}

/** Detection cadence: fast while a hand is around, slower otherwise (saves battery / heat). */
const FAST_INTERVAL_MS = 66; // ~15 Hz
const SLOW_INTERVAL_MS = 125; // ~8 Hz
const HAND_RECENT_MS = 2000;
/** Perception older than this is dropped (the brain ignores hands > 0.4 s, faces > 0.5–2 s). */
const HAND_DROP_AGE = 1;
const FACE_DROP_AGE = 2.5;
const DRAW_AGE = 0.5; // s: keep drawing landmarks this long after the last detection
/** A mode note (e.g. "no camera image") shows alone this long, then the dog's status takes over. */
const NOTE_SOLO_S = 8;

export interface DogPlay {
  /** Give the placed dog a brain (anchor = the Group holding dog.root, owned by the brain from now on). */
  attach(dog: DogCharacter, anchor: THREE.Object3D, floorY: number): DogBrain;
  readonly brain: DogBrain | null;
  readonly dog: DogCharacter | null;
  readonly detectorState: DetectorState;
  /** Starts loading the detector (once per page; later sessions reuse it). */
  ensureDetector(): void;
  /** True when a new detection is due (cadence) and the detector is ready. */
  wantsFrame(timeMs: number): boolean;
  /** Feed a fresh camera image and the camera model for exactly that frame. */
  see(image: ImageData | HTMLVideoElement | HTMLCanvasElement, timeMs: number, cam: CameraModel): void;
  /** Once per rendered frame: brain, then dog pose, then occluder / hearts / UI. */
  update(dt: number, viewer: Viewer): void;
  /** Hand occlusion mesh on/off (off when the GPU depth buffer already occludes). Default on. */
  handOcclusion: boolean;
  /** A mode-specific message for the status chip (null clears it). */
  setNote(text: string | null): void;
  readonly perception: Perception;
  dispose(): void;
}

export function createDogPlay(scene: THREE.Scene, ui: PlayUI, uvToScreen: UVToScreen): DogPlay {
  // ---- All state first (setup calls below use it; avoids temporal-dead-zone crashes) ----
  const fx = createPetFx(scene);
  const occluder = createHandOccluder(scene);
  const ctx = ui.visionCanvas.getContext("2d");
  const cleanups: (() => void)[] = [];
  let dog: DogCharacter | null = null;
  let brain: DogBrain | null = null;
  let unsubPet: (() => void) | null = null;
  let dogClock = 0;
  let perception: Perception = { hands: [], faces: [] };
  let observation: Observation = { hands: [], faces: [] };
  let observationAge = Infinity;
  let lastDetectMs = -Infinity;
  let lastHandSeenMs = -Infinity;
  let detector: VisionDetector | null = null;
  let detectorState: DetectorState = "idle";
  let note: string | null = null;
  let noteAge = 0;
  let disposed = false;
  let showVision = false;
  let handOcclusion = true;
  let lastStatus: string | null = null;
  let lastPosture = "";
  let lastMode = "";
  let lastEnabled: boolean | null = null;

  const commandButtons: { button: HTMLButtonElement; cmd: () => DogCommand }[] = [
    { button: ui.cmdSit, cmd: () => (brain?.posture === "sit" ? "stand" : "sit") },
    { button: ui.cmdLie, cmd: () => (brain?.posture === "lie" ? "stand" : "lie") },
    { button: ui.cmdCome, cmd: () => "come" },
    { button: ui.cmdMode, cmd: () => (brain?.mode === "follow" ? "free" : "follow") },
    { button: ui.trickRollOver, cmd: () => "rollOver" },
    { button: ui.trickJump, cmd: () => "jump" },
    { button: ui.trickSpin, cmd: () => "spin" },
  ];

  // ---- Helpers (function declarations: hoisted) ----
  function setStatus(text: string) {
    if (text === lastStatus) return;
    lastStatus = text;
    ui.status.textContent = text;
    ui.status.hidden = text === "";
  }

  function statusText(): string {
    if (note && (noteAge < NOTE_SOLO_S || !brain)) return note;
    if (detectorState === "failed" && !brain) return "Hand detection unavailable — commands and tricks still work";
    if (detectorState === "loading") return brain ? `Loading hand detection… · ${brain.status}` : "Loading hand detection…";
    return brain?.status ?? "";
  }

  function setVision(on: boolean) {
    showVision = on;
    ui.visionToggle.setAttribute("aria-pressed", String(on));
    ui.visionCanvas.hidden = !on;
    if (!on) ctx?.clearRect(0, 0, ui.visionCanvas.width, ui.visionCanvas.height);
  }

  function syncButtons() {
    const enabled = !!brain;
    if (enabled !== lastEnabled) {
      lastEnabled = enabled;
      for (const { button } of commandButtons) button.disabled = !enabled;
    }
    const posture = brain?.posture ?? "stand";
    if (posture !== lastPosture) {
      lastPosture = posture;
      ui.cmdSit.setAttribute("aria-pressed", String(posture === "sit"));
      ui.cmdLie.setAttribute("aria-pressed", String(posture === "lie"));
    }
    const mode = brain?.mode ?? "follow";
    if (mode !== lastMode) {
      lastMode = mode;
      ui.cmdMode.textContent = MODE_LABEL[mode];
      ui.cmdMode.title = mode === "follow" ? "Following you — tap for free roam" : "Tap to make it follow you";
    }
  }

  function drawVision() {
    if (!ctx) return;
    const canvas = ui.visionCanvas;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.font = "600 13px system-ui, sans-serif";
    if (detectorState !== "ready") {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(8, h - 150, 200, 22);
      ctx.fillStyle = "#fff";
      ctx.fillText(`vision: ${detectorState}`, 14, h - 134);
    }
    if (observationAge > DRAW_AGE) return;

    // Hands: skeleton + palm label (distance, near-camera).
    for (const hand of observation.hands) {
      const pts = hand.landmarks.map((p) => uvToScreen(p.u, p.v, w, h));
      const lifted = perception.hands.find((p) => p.id === hand.id);
      const near = lifted?.nearCamera ?? false;
      ctx.lineWidth = 3;
      ctx.strokeStyle = near ? "#ff9f1c" : "#ffd23f";
      ctx.beginPath();
      for (const [a, b] of HAND_BONES) {
        if (!pts[a] || !pts[b]) continue;
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      const wrist = pts[0];
      if (wrist) {
        const label = `✋${hand.id}${lifted ? ` ${lifted.distance.toFixed(2)} m` : ""}${near ? " near" : ""}`;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(wrist.x + 8, wrist.y + 4, ctx.measureText(label).width + 8, 18);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, wrist.x + 12, wrist.y + 18);
      }
    }

    // Faces: eye corners, eye midpoint, gaze line (pink = the dog's eye-contact partner).
    const contactId = brain?.eyeContactWith ?? null;
    for (const face of observation.faces) {
      const contact = face.id === contactId;
      const color = contact ? "#ff4d8d" : "#4dd2ff";
      ctx.fillStyle = color;
      for (const c of [face.leftEyeOuter, face.rightEyeOuter]) {
        const p = uvToScreen(c.u, c.v, w, h);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      const e = uvToScreen(face.eyes.u, face.eyes.v, w, h);
      ctx.beginPath();
      ctx.arc(e.x, e.y, contact ? 8 : 5, 0, Math.PI * 2);
      ctx.fill();
      const g = face.gazeCamera; // camera space: x right, y up
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.x + g.x * 90, e.y - g.y * 90);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`#${face.id}${contact ? " eye contact" : ""}`, e.x + 10, e.y - 10);
    }
  }

  // ---- Setup (everything above is initialised) ----
  for (const entry of commandButtons) {
    const onClick = () => {
      if (!brain) return;
      brain.command(entry.cmd());
      navigator.vibrate?.(12);
      syncButtons();
    };
    entry.button.addEventListener("click", onClick);
    cleanups.push(() => entry.button.removeEventListener("click", onClick));
  }
  ui.trickRollOver.textContent = TRICK_LABEL.rollOver;
  ui.trickJump.textContent = TRICK_LABEL.jump;
  ui.trickSpin.textContent = TRICK_LABEL.spin;

  const onToggle = () => setVision(!showVision);
  ui.visionToggle.addEventListener("click", onToggle);
  cleanups.push(() => ui.visionToggle.removeEventListener("click", onToggle));
  setVision(false);
  syncButtons();
  setStatus("");

  return {
    attach(newDog, anchor, floorY) {
      unsubPet?.();
      dog = newDog;
      dogClock = 0;
      brain = createDogBrain(newDog, anchor, floorY);
      unsubPet = brain.onPetStart((zone, point) => {
        fx.burst(point, zone);
        navigator.vibrate?.(zone === "head" ? 30 : [20, 40, 20]);
      });
      syncButtons();
      return brain;
    },
    get brain() {
      return brain;
    },
    get dog() {
      return dog;
    },
    get detectorState() {
      return detectorState;
    },
    get perception() {
      return perception;
    },
    get handOcclusion() {
      return handOcclusion;
    },
    set handOcclusion(on: boolean) {
      handOcclusion = on;
    },
    ensureDetector() {
      if (detectorState !== "idle" || disposed) return;
      detectorState = "loading";
      loadDetector().then(
        (d) => {
          if (disposed) return;
          detector = d;
          detectorState = "ready";
        },
        (err) => {
          console.warn("[dog] hand detection unavailable", err);
          if (!disposed) detectorState = "failed";
        },
      );
    },
    wantsFrame(timeMs) {
      if (!detector || disposed) return false;
      const interval = timeMs - lastHandSeenMs < HAND_RECENT_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
      return timeMs - lastDetectMs >= interval;
    },
    see(image, timeMs, cam) {
      if (!detector || disposed) return;
      const dtSincePrev = Number.isFinite(lastDetectMs) ? (timeMs - lastDetectMs) / 1000 : 0;
      lastDetectMs = timeMs;
      try {
        observation = detector.detect(image, timeMs);
        observationAge = 0;
        perception = liftObservation(observation, cam, perception, dtSincePrev);
      } catch (err) {
        console.warn("[dog] detection failed", err);
        return;
      }
      if (observation.hands.length > 0) lastHandSeenMs = timeMs;
    },
    update(dt, viewer) {
      if (disposed) return;
      // Age perception between detections and forget stale entries.
      observationAge += dt;
      noteAge += dt;
      for (const h of perception.hands) h.age += dt;
      for (const f of perception.faces) f.age += dt;
      if (perception.hands.some((h) => h.age > HAND_DROP_AGE) || perception.faces.some((f) => f.age > FACE_DROP_AGE)) {
        perception = {
          hands: perception.hands.filter((h) => h.age <= HAND_DROP_AGE),
          faces: perception.faces.filter((f) => f.age <= FACE_DROP_AGE),
        };
      }

      if (brain && dog) {
        dogClock += dt;
        brain.update(dt, perception, viewer);
        dog.update(dogClock);
      }
      occluder.update(dt, perception.hands, handOcclusion);
      fx.update(dt);
      syncButtons();
      setStatus(statusText());
      if (showVision) drawVision();
    },
    setNote(text) {
      if (text !== note) noteAge = 0;
      note = text;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubPet?.();
      unsubPet = null;
      for (const off of cleanups) off();
      setVision(false);
      setStatus("");
      for (const { button } of commandButtons) button.disabled = false;
      fx.dispose();
      occluder.dispose();
      brain = null;
      dog = null;
      detector = null; // the detector itself stays cached for the next session
    },
  };
}
