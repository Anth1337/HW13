import * as THREE from "three";
import { createDogBrain } from "./dog/brain";
import { createPetFx } from "./dog/fx";
import { TRICK_LABEL, type DogBrain, type DogCharacter, type DogZones, type TrickKind } from "./dog/types";
import { createHumanDetector } from "./vision/detector";
import { liftHumans } from "./vision/lift";
import type { CameraModel, Human2D, HumanDetector, PerceivedHuman } from "./vision/types";

/*
 * Everything the two "play with the dog" modes share (WebXR AR in webxr.ts and the camera
 * fallback in cameraMode.ts): the cached people detector, one brain per placed dog, the petting
 * hearts, the trick buttons, the status chip and the optional "vision" debug drawing.
 *
 * Per rendered frame a mode calls, in this order:
 *   play.see(image, timeMs, cam)      // only on frames with a fresh camera image
 *   play.update(dt, viewerWorld)      // BEFORE every character.update(t)
 */

/** The overlay elements dog play drives (part of webxr.ts's ARUI). */
export type PlayUI = {
  /** Short status line under the hint ("👀 2 people · eye contact"). */
  status: HTMLElement;
  /** One button per trick (inside the overlay's controls). */
  tricks: Record<TrickKind, HTMLButtonElement>;
  /** Toggles the landmark drawing (aria-pressed). */
  visionToggle: HTMLButtonElement;
  /** Full-screen 2D canvas in the overlay for the landmark drawing. */
  visionCanvas: HTMLCanvasElement;
};

/** Maps camera-image uv (v down, 0..1) to overlay CSS pixels. */
export type UVToScreen = (u: number, v: number, width: number, height: number) => { x: number; y: number };

export const TRICKS: TrickKind[] = ["rollOver", "jump", "spin"];

// ---- People detector: loaded once per page and kept (MediaPipe models are ~10 MB) ----
let detectorPromise: Promise<HumanDetector> | null = null;
function loadDetector(): Promise<HumanDetector> {
  if (!detectorPromise) {
    detectorPromise = createHumanDetector({ maxPeople: 3 });
    detectorPromise.catch(() => (detectorPromise = null)); // a later session may retry
  }
  return detectorPromise;
}

const FRESH_AGE = 0.6; // s: detections younger than this count as "in view"
const DROP_AGE = 2; // s: forget detections older than this
const DRAW_AGE = 0.5; // s: keep drawing landmarks this long after the last detection

type DogEntry = { dog: DogCharacter; brain: DogBrain; zones: DogZones; unsub: () => void };

export type DetectorState = "idle" | "loading" | "ready" | "failed";

export function createDogPlay(scene: THREE.Scene, ui: PlayUI, uvToScreen: UVToScreen) {
  const fx = createPetFx(scene);
  const dogs: DogEntry[] = [];
  let perceived: PerceivedHuman[] = [];
  let humans2d: Human2D[] = [];
  let humans2dAge = Infinity;
  let detector: HumanDetector | null = null;
  let detectorState: DetectorState = "idle";
  let note: string | null = null;
  let disposed = false;
  let showVision = false;

  // ---- Trick buttons ----
  const trickHandlers = TRICKS.map((kind) => {
    const button = ui.tricks[kind];
    button.textContent = TRICK_LABEL[kind];
    const onClick = () => {
      for (const d of dogs) d.brain.doTrick(kind);
      navigator.vibrate?.(15);
    };
    button.addEventListener("click", onClick);
    return () => button.removeEventListener("click", onClick);
  });

  // ---- Vision toggle ----
  // Declared before setVision(false) below, which clears the canvas through it.
  const ctx = ui.visionCanvas.getContext("2d");
  const setVision = (on: boolean) => {
    showVision = on;
    ui.visionToggle.setAttribute("aria-pressed", String(on));
    ui.visionCanvas.hidden = !on;
    if (!on) clearCanvas();
  };
  const onToggle = () => setVision(!showVision);
  ui.visionToggle.addEventListener("click", onToggle);
  setVision(false);

  function syncButtons() {
    for (const kind of TRICKS) ui.tricks[kind].disabled = dogs.length === 0;
  }
  syncButtons();

  let lastStatus: string | null = null;
  function setStatus(text: string) {
    if (text === lastStatus) return;
    lastStatus = text;
    ui.status.textContent = text;
    ui.status.hidden = text === "";
  }
  setStatus("");

  function statusText(): string {
    if (detectorState === "failed") return "People detection unavailable — tricks still work";
    if (note) return note;
    if (detectorState === "loading") return "Loading people detection…";
    const latest = dogs[dogs.length - 1];
    const parts: string[] = [];
    if (detectorState === "ready") {
      const n = perceived.filter((p) => p.age < FRESH_AGE).length;
      parts.push(n === 0 ? "👀 No one in view" : `👀 ${n} ${n === 1 ? "person" : "people"}`);
      if (latest && latest.brain.eyeContactWith !== null && !/look|eye/i.test(latest.brain.status)) {
        parts.push("eye contact");
      }
    }
    if (latest?.brain.status) parts.push(latest.brain.status);
    return parts.join(" · ");
  }

  // ---- Vision debug drawing ----
  function clearCanvas() {
    ctx?.clearRect(0, 0, ui.visionCanvas.width, ui.visionCanvas.height);
  }
  function drawVision() {
    if (!ctx) return;
    const canvas = ui.visionCanvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (humans2dAge > DRAW_AGE) return;

    const contactId = dogs[dogs.length - 1]?.brain.eyeContactWith ?? null;
    const dot = (u: number, v: number, r: number, color: string) => {
      const p = uvToScreen(u, v, w, h);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.stroke();
    };
    for (const hmn of humans2d) {
      const contact = hmn.id === contactId;
      const eyeColor = contact ? "#ff4d8d" : "#4dd2ff";
      if (hmn.shoulders) {
        dot(hmn.shoulders.left.u, hmn.shoulders.left.v, 5, "#bbbbbb");
        dot(hmn.shoulders.right.u, hmn.shoulders.right.v, 5, "#bbbbbb");
      }
      for (const hand of hmn.hands) dot(hand.u, hand.v, 9, "#ffd23f");
      if (hmn.face) {
        dot(hmn.face.leftEyeOuter.u, hmn.face.leftEyeOuter.v, 4, eyeColor);
        dot(hmn.face.rightEyeOuter.u, hmn.face.rightEyeOuter.v, 4, eyeColor);
      }
      if (hmn.eyes) {
        dot(hmn.eyes.u, hmn.eyes.v, contact ? 9 : 6, eyeColor);
        const p = uvToScreen(hmn.eyes.u, hmn.eyes.v, w, h);
        if (hmn.face) {
          // Gaze in camera space (x right, y up): draw its on-screen component.
          const g = hmn.face.gazeCamera;
          const len = 90;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + g.x * len, p.y - g.y * len);
          ctx.lineWidth = 3;
          ctx.strokeStyle = eyeColor;
          ctx.stroke();
        }
        ctx.font = "600 13px system-ui, sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(`#${hmn.id}${contact ? " 👁" : ""}`, p.x + 10, p.y - 10);
      }
    }
  }

  return {
    /** Adds a placed dog: gives it a brain, hearts + haptics on petting, and enables the tricks. */
    addDog(dog: DogCharacter): DogBrain {
      const brain = createDogBrain(dog);
      const unsub = brain.onPetStart((zone, point) => {
        fx.burst(point, zone);
        navigator.vibrate?.(30);
      });
      dogs.push({
        dog,
        brain,
        zones: { head: new THREE.Sphere(), body: new THREE.Sphere() },
        unsub,
      });
      syncButtons();
      return brain;
    },
    removeDog(dog: DogCharacter) {
      const i = dogs.findIndex((d) => d.dog === dog);
      if (i < 0) return;
      dogs[i].unsub();
      dogs.splice(i, 1);
      syncButtons();
    },
    get dogCount() {
      return dogs.length;
    },
    get detectorState(): DetectorState {
      return detectorState;
    },
    /** Starts loading the people detector (once per page; later sessions reuse it). */
    ensureDetector() {
      if (detectorState !== "idle") return;
      detectorState = "loading";
      loadDetector().then(
        (d) => {
          if (disposed) return;
          detector = d;
          detectorState = "ready";
        },
        (err) => {
          console.warn("[dog] people detection unavailable", err);
          if (!disposed) detectorState = "failed";
        },
      );
    },
    /** A mode-specific message for the status chip (null clears it). */
    setNote(text: string | null) {
      note = text;
    },
    /** Feed a fresh camera image and the camera model for exactly that frame. */
    see(image: ImageData | HTMLVideoElement | HTMLCanvasElement, timeMs: number, cam: CameraModel) {
      if (!detector) return;
      humans2d = detector.detect(image, timeMs);
      humans2dAge = 0;
      const reachTargets: THREE.Sphere[] = [];
      for (const d of dogs) {
        d.dog.getZones(d.zones);
        reachTargets.push(d.zones.head, d.zones.body);
      }
      perceived = liftHumans(humans2d, cam, { reachTargets });
    },
    /** Once per rendered frame, before the characters' update(t). */
    update(dt: number, viewerWorld: THREE.Vector3) {
      for (const p of perceived) p.age += dt;
      humans2dAge += dt;
      if (perceived.length && perceived.every((p) => p.age > DROP_AGE)) perceived = [];
      for (const d of dogs) d.brain.update(dt, perceived, viewerWorld);
      fx.update(dt);
      setStatus(statusText());
      if (showVision) drawVision();
    },
    dispose() {
      disposed = true;
      for (const d of dogs) d.unsub();
      dogs.length = 0;
      for (const off of trickHandlers) off();
      ui.visionToggle.removeEventListener("click", onToggle);
      setVision(false);
      setStatus("");
      fx.dispose();
    },
  };
}

export type DogPlay = ReturnType<typeof createDogPlay>;
