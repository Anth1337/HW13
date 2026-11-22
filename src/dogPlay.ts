import * as THREE from "three";
import { bindSoundButton, createPetSounds, type Ear } from "./audio";
import { createPetBrain } from "./dog/brain";
import { createPetFx } from "./dog/fx";
import { TRICK_LABEL, type DogBrain, type DogCommand, type DogMode, type PetCharacter, type TrickKind } from "./dog/types";
import { petStore, type Species } from "./pets";
import { createVisionDetector } from "./vision/detector";
import { createPeopleTracker } from "./vision/people";
import { createVoiceListener, parseVoiceCommand, type VoiceListener, type VoiceResult, type VoiceState } from "./voice";
import { HAND_BONES, createHandOccluder } from "./vision/handOccluder";
import { liftObservation } from "./vision/lift";
import type { CameraModel, Observation, Perception, PerceivedPerson, VisionDetector } from "./vision/types";
import { petBuzz } from "./net/kinds";
import { createPartyLink } from "./net/party";

/*
 * Everything the two "play with the pet" modes share (WebXR AR in webxr.ts and the camera
 * fallback in cameraMode.ts): the cached hand/face detector, the single pet's brain, the hand
 * occluder, petting hearts + haptics, the command / trick / vision buttons, the status chip,
 * the "Show vision" debug drawing, the pets' sound effects (src/audio: this pet and every friend's
 * pet shown here) and, when the page is in a room, friends' pets (net/party.ts).
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
  /** #trick-rollOver, #trick-jump, #trick-spin: the species' three tricks (PLAY_LABELS). */
  trick1: HTMLButtonElement;
  trick2: HTMLButtonElement;
  trick3: HTMLButtonElement;
  visionToggle: HTMLButtonElement;
  /** 🎤 button (#btn-voice): hidden when the browser has no speech recognition. */
  voiceToggle: HTMLButtonElement;
  /** #voice-chip: the last heard phrase and the command it was recognised as. */
  voiceChip: HTMLElement;
  /** #voice-hint: one-line "Say: …" hint, shown briefly the first time. */
  voiceHint: HTMLElement;
  /** 🔊 / 🔇 pet sounds toggle (#btn-sound). */
  soundToggle?: HTMLButtonElement;
};

/** Maps camera-image uv (v down, 0..1) to overlay CSS pixels of a width × height box. */
export type UVToScreen = (u: number, v: number, width: number, height: number) => { x: number; y: number };

export type Viewer = { position: THREE.Vector3; forward: THREE.Vector3 };

export type DetectorState = "idle" | "loading" | "ready" | "failed";

type PlayLabels = { sit: string; lie: string; come: string; tricks: [TrickKind, TrickKind, TrickKind] };

/** Command button labels and the three trick buttons' tricks, per species. */
export const PLAY_LABELS: Record<Species, PlayLabels> = {
  dog: { sit: "Sit", lie: "Lie down", come: "Come", tricks: ["rollOver", "jump", "spin"] },
  cat: { sit: "Sit", lie: "Loaf", come: "Here, kitty", tricks: ["pounce", "stretch", "groom"] },
};

export const MODE_LABEL: Record<DogMode, string> = { follow: "Follow", free: "Free roam", stay: "Stay" };

// ---- Detector: loaded once per page and kept (MediaPipe models are several MB) ----
let detectorPromise: Promise<VisionDetector> | null = null;
function loadDetector(): Promise<VisionDetector> {
  if (!detectorPromise) {
    detectorPromise = createVisionDetector({ maxHands: 4, maxFaces: 4, maxBodies: 3 });
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
const BODY_DROP_AGE = 2.5;
const DRAW_AGE = 0.5; // s: keep drawing landmarks this long after the last detection
/** A mode note (e.g. "no camera image") shows alone this long, then the dog's status takes over. */
const NOTE_SOLO_S = 8;

// ---- Voice ----
const VOICE_PREF_KEY = "ar-dog-voice";
const VOICE_HINT_KEY = "ar-dog-voice-hint-seen";
const VOICE_HINT_TEXT = "Say: sit · lie down · come · roll over · jump · spin";
const VOICE_HINT_S = 7;
const IS_APPLE_TOUCH =
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1));
const VOICE_CHIP_S = 2;
/** Same command inside one utterance (interim updates, then the final) fires once; also not again within this. */
const VOICE_REPEAT_MS = 1500;
const VOICE_HEAR_EVERY_MS = 1000;
/** Speech recognisers answer late; look back this far for the person whose mouth was moving. */
const SPEAKER_WINDOW_S = 1.5;
/** An interim match that could still grow into another command ("stay" -> "stay with me") waits this long for more words. */
const VOICE_EXTEND_WAIT_MS = 450;

/**
 * One speech listener shared by primeVoice() (the Deploy tap, before the AR / camera session
 * exists) and the dog play session that follows: Chrome in an AR session may refuse the first mic
 * request, and a tap is the only thing that may start it.
 */
let sharedVoice: VoiceListener | null = null;
function acquireVoice(): VoiceListener | null {
  if (!sharedVoice) {
    try {
      sharedVoice = createVoiceListener();
    } catch (err) {
      console.warn("[dog] voice unavailable", err);
    }
  }
  return sharedVoice;
}
function releaseVoice() {
  try {
    sharedVoice?.stop(); // releases the mic (the browser's recording indicator turns off)
    sharedVoice?.dispose();
  } catch {
    /* nothing useful to do */
  }
  sharedVoice = null;
}
/** Call synchronously from the tap that starts AR / camera mode: restarts voice commands if the user left them on. */
export function primeVoice() {
  if (storageGet(VOICE_PREF_KEY) !== "1") return;
  const v = acquireVoice();
  if (v?.supported) v.start();
}
/** Counterpart of primeVoice() when the session could not start (releases the mic). */
export function releasePrimedVoice() {
  releaseVoice();
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage: the choice just isn't remembered */
  }
}

const PERSON_COLORS = ["#4dd2ff", "#ff9f1c", "#7cd992", "#c58bff", "#ff6b6b", "#ffe066"];
const personColor = (id: number | null | undefined) => (id == null ? "#bbbbbb" : PERSON_COLORS[Math.abs(id) % PERSON_COLORS.length]);
/** MediaPipe pose skeleton (upper body + legs); landmark index pairs. */
const POSE_BONES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12],
];

export interface DogPlay {
  /** Give the placed pet a brain (anchor = the Group holding pet.root, owned by the brain from now on). */
  attach(pet: PetCharacter, anchor: THREE.Object3D, floorY: number): DogBrain;
  readonly brain: DogBrain | null;
  readonly dog: PetCharacter | null;
  readonly detectorState: DetectorState;
  /** Starts loading the detector (once per page; later sessions reuse it). */
  ensureDetector(): void;
  /** True when a new detection is due (cadence) and the detector is ready. */
  wantsFrame(timeMs: number): boolean;
  /** Feed a fresh camera image and the camera model for exactly that frame. */
  see(image: ImageData | HTMLVideoElement | HTMLCanvasElement, timeMs: number, cam: CameraModel): void;
  /**
   * Once per rendered frame: brain, then dog pose, then occluder / hearts / sounds / UI.
   * `ear` = the camera pose for spatial sound (defaults to `viewer`, which camera mode may move ahead of the camera).
   */
  update(dt: number, viewer: Viewer, ear?: Ear): void;
  /** Hand occlusion mesh on/off (off when the GPU depth buffer already occludes). Default on. */
  handOcclusion: boolean;
  /** A mode-specific message for the status chip (null clears it). */
  setNote(text: string | null): void;
  readonly perception: Perception;
  dispose(): void;
}

/** `species` labels the buttons for this session's animal; dispose() puts the dog labels back. */
export function createDogPlay(scene: THREE.Scene, ui: PlayUI, uvToScreen: UVToScreen, species: Species): DogPlay {
  const labels = PLAY_LABELS[species];
  // ---- All state first (setup calls below use it; avoids temporal-dead-zone crashes) ----
  const fx = createPetFx(scene);
  const occluder = createHandOccluder(scene);
  const ctx = ui.visionCanvas.getContext("2d");
  const cleanups: (() => void)[] = [];
  let dog: PetCharacter | null = null;
  let brain: DogBrain | null = null;
  let unsubPet: (() => void) | null = null;
  let dogClock = 0;
  const people = createPeopleTracker();
  let perception: Perception = { hands: [], faces: [], bodies: [], people: [] };
  let observation: Observation = { hands: [], faces: [], bodies: [] };
  let lastCamHadDepth = false;
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

  // Voice state.
  let voice: VoiceListener | null = null;
  let voiceState: VoiceState = "off";
  let voiceWanted = storageGet(VOICE_PREF_KEY) === "1"; // remembered choice; only armed until a tap
  let voiceChipLeft = 0;
  let voiceHintLeft = 0;
  let lastHearMs = -Infinity;
  /** The command fired from the utterance in progress (null once its final result arrived). */
  let firedCmd: DogCommand | null = null;
  let firedMs = -Infinity;
  let utteranceOpen = false;
  let extendTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last speech result (interim or final): pets hold their chatter while someone is talking. */
  let lastSpeechMs = -Infinity;

  // Sound: one voice per pet shown (this one + friends'), spatialised at the camera.
  const sounds = createPetSounds();
  const shownPets: PetCharacter[] = [];
  const fallbackEar: Ear = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  const AHEAD = new THREE.Vector3(0, 0, -1);

  const party = createPartyLink(scene, {
    burst: (point, zone) => fx.burst(point, zone),
    command: (cmd) => {
      if (!brain) return;
      // A friend's command may be their species' trick: do ours in the same slot (a cat can't roll over).
      if (cmd in TRICK_LABEL && !labels.tricks.includes(cmd as TrickKind)) {
        const i = Object.values(PLAY_LABELS).map((l) => l.tricks.indexOf(cmd as TrickKind)).find((j) => j >= 0) ?? 0;
        cmd = labels.tricks[i];
      }
      brain.command(cmd);
      sounds.commanded(cmd);
      syncButtons();
    },
    social: (s) => brain?.social(s),
    sociable: () => !!brain?.sociable,
    meet: (a, b) => sounds.meet(a, b),
  });

  const commandButtons: { button: HTMLButtonElement; cmd: () => DogCommand }[] = [
    { button: ui.cmdSit, cmd: () => (brain?.posture === "sit" ? "stand" : "sit") },
    { button: ui.cmdLie, cmd: () => (brain?.posture === "lie" ? "stand" : "lie") },
    { button: ui.cmdCome, cmd: () => "come" },
    { button: ui.cmdMode, cmd: () => (brain?.mode === "follow" ? "free" : "follow") },
    { button: ui.trick1, cmd: () => labels.tricks[0] },
    { button: ui.trick2, cmd: () => labels.tricks[1] },
    { button: ui.trick3, cmd: () => labels.tricks[2] },
  ];

  // ---- Helpers (function declarations: hoisted) ----
  function setLabels(l: PlayLabels) {
    ui.cmdSit.textContent = l.sit;
    ui.cmdLie.textContent = l.lie;
    ui.cmdCome.textContent = l.come;
    ui.trick1.textContent = TRICK_LABEL[l.tricks[0]];
    ui.trick2.textContent = TRICK_LABEL[l.tricks[1]];
    ui.trick3.textContent = TRICK_LABEL[l.tricks[2]];
  }

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

  function showChip(text: string, seconds = VOICE_CHIP_S) {
    ui.voiceChip.textContent = text;
    ui.voiceChip.hidden = text === "";
    voiceChipLeft = text === "" ? 0 : seconds;
  }

  function syncVoiceUI() {
    const on = voiceState === "starting" || voiceState === "listening";
    ui.voiceToggle.hidden = !voice || !voice.supported;
    ui.voiceToggle.setAttribute("aria-pressed", String(on));
    ui.voiceToggle.dataset.state = voiceState === "off" && voiceWanted ? "armed" : voiceState;
    ui.voiceToggle.title =
      voiceState === "denied"
        ? IS_APPLE_TOUCH
          ? "Voice blocked — turn on Dictation in iOS Settings → General → Keyboard and allow the microphone"
          : "Microphone blocked — allow it in the browser's site settings"
        : on
          ? "Listening for commands — tap to turn off"
          : voiceWanted
            ? "Tap to turn voice commands back on"
            : "Voice commands";
  }

  function startVoice() {
    if (!voice || !voice.supported || disposed) return;
    voiceWanted = true;
    storageSet(VOICE_PREF_KEY, "1");
    voice.start(); // synchronously inside the tap: browsers need the gesture for the mic prompt
    if (storageGet(VOICE_HINT_KEY) !== "1") {
      storageSet(VOICE_HINT_KEY, "1");
      ui.voiceHint.textContent = VOICE_HINT_TEXT;
      ui.voiceHint.hidden = false;
      voiceHintLeft = VOICE_HINT_S;
    }
    syncVoiceUI();
  }

  function stopVoice() {
    voiceWanted = false;
    storageSet(VOICE_PREF_KEY, "0");
    voice?.stop();
    utteranceOpen = false;
    firedCmd = null;
    clearExtendTimer();
    syncVoiceUI();
  }

  /** The pet's name for addressing it by voice; "" when it has none (a placeholder would count as the name). */
  function dogName(): string {
    return (dog?.config.name ?? petStore.active()?.config.name ?? "").trim();
  }

  function clearExtendTimer() {
    if (extendTimer !== null) {
      clearTimeout(extendTimer);
      extendTimer = null;
    }
  }

  function fireIntent(command: DogCommand, phrase: string, speaker: number | null, nowMs: number) {
    if (!brain) return;
    // Each species only animates its own three tricks (PLAY_LABELS): a dog trick said to a cat
    // (or the reverse) would freeze it for the trick's duration, so say so instead.
    if (command in TRICK_LABEL && !labels.tricks.includes(command as TrickKind)) {
      showChip(`“${phrase}”: ${dogName() || "your pet"} doesn't know that trick`);
      return;
    }
    brain.command(command, speaker);
    sounds.commanded(command);
    party?.commanded(command);
    firedCmd = command;
    firedMs = nowMs;
    utteranceOpen = true;
    navigator.vibrate?.(12);
    syncButtons();
    showChip(`“${phrase}”  →  ${command in TRICK_LABEL ? TRICK_LABEL[command as TrickKind].toLowerCase() : command}`);
  }

  function onVoiceResult(r: VoiceResult) {
    if (!brain || disposed) return;
    const nowMs = performance.now();
    const speaker = people.speakerWithin(SPEAKER_WINDOW_S);
    const text = r.transcript.trim();
    if (!text) return;
    lastSpeechMs = r.final ? -Infinity : nowMs;

    // Any speech: the dog perks up and looks at whoever is talking (rate limited).
    if (nowMs - lastHearMs >= VOICE_HEAR_EVERY_MS) {
      lastHearMs = nowMs;
      brain.hearVoice(speaker);
    }

    const name = dogName();
    let intent = parseVoiceCommand(text, name);
    if (!intent && r.alternatives) {
      for (const alt of r.alternatives) {
        intent = parseVoiceCommand(alt, name);
        if (intent) break;
      }
    }

    clearExtendTimer(); // newer words supersede a waiting interim match
    if (intent) {
      // Interim results fire as soon as they match; the same command again from the same utterance
      // (more interim updates, then the final) or within VOICE_REPEAT_MS is ignored. An interim
      // that could still become another command ("play" -> "play dead") waits for more words.
      const run = (at: number) => {
        const duplicate = firedCmd === intent.command && (utteranceOpen || at - firedMs < VOICE_REPEAT_MS);
        if (!duplicate) fireIntent(intent.command, intent.phrase, speaker, at);
      };
      if (intent.mayExtend && !r.final) {
        showChip(`“${text}”`);
        extendTimer = setTimeout(() => {
          extendTimer = null;
          if (!brain || disposed) return;
          run(performance.now());
        }, VOICE_EXTEND_WAIT_MS);
      } else {
        run(nowMs);
      }
    } else {
      showChip(`“${text}”`);
      if (r.final) sounds.heard(); // talked to: sometimes a "hm?" (commands get their own reply)
    }
    if (r.final) utteranceOpen = false; // the next utterance may repeat the command (after VOICE_REPEAT_MS)
  }

  function onVoiceState(s: VoiceState) {
    voiceState = s;
    if (s === "denied") {
      voiceWanted = false;
      storageSet(VOICE_PREF_KEY, "0");
      // iOS Safari reports both a refused mic and disabled Dictation/Siri ("service-not-allowed") as a
      // first-time refusal, so the message names both fixes. Longer than a normal chip: it needs reading.
      showChip(
        IS_APPLE_TOUCH
          ? "Voice needs Dictation: Settings → General → Keyboard → Enable Dictation (and allow the microphone for Safari)"
          : "Microphone blocked — allow it in site settings",
        7,
      );
    } else if (s === "off" && voiceWanted && voice && !(typeof document !== "undefined" && document.hidden)) {
      // Recogniser gave up (e.g. repeated network errors): say so rather than silently doing nothing.
      showChip("Voice stopped — tap 🎤 to retry");
    }
    syncVoiceUI();
  }

  function personLabelPoint(person: PerceivedPerson, w: number, h: number): { x: number; y: number } | null {
    const face = perception.faces.find((f) => f.id === person.faceId);
    if (face) return uvToScreen(face.uv.u, face.box.v0, w, h);
    const body = perception.bodies.find((b) => b.id === person.bodyId);
    const bp = body?.noseUV ?? body?.torsoUV;
    if (bp) return uvToScreen(bp.u, bp.v, w, h);
    const hand = perception.hands.find((x) => person.handIds.includes(x.id));
    return hand ? uvToScreen(hand.uv.u, hand.uv.v, w, h) : null;
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
    const hud = `vision: ${detectorState} · depth ${lastCamHadDepth ? "✓" : "✗"} · mask ${lastCamHadDepth ? "hull+depth" : "hull"} · people ${perception.people.length} · mic ${voiceState}`;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(8, h - 176, ctx.measureText(hud).width + 12, 22);
    ctx.fillStyle = "#fff";
    ctx.fillText(hud, 14, h - 160);
    if (observationAge > DRAW_AGE) return;

    // Bodies: skeleton + wrists, coloured by person.
    for (const body of observation.bodies) {
      const pb = perception.bodies.find((b) => b.id === body.id);
      const color = personColor(pb?.personId);
      const vis = (i: number) => (body.visibility[i] ?? 0) >= 0.5 && !!body.landmarks[i];
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const [a, b] of POSE_BONES) {
        if (!vis(a) || !vis(b)) continue;
        const pa = uvToScreen(body.landmarks[a].u, body.landmarks[a].v, w, h);
        const pc = uvToScreen(body.landmarks[b].u, body.landmarks[b].v, w, h);
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pc.x, pc.y);
      }
      ctx.stroke();
      ctx.fillStyle = color;
      for (const i of [15, 16]) {
        if (!vis(i)) continue;
        const p = uvToScreen(body.landmarks[i].u, body.landmarks[i].v, w, h);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Hands: skeleton + palm label (distance, near-camera).
    for (const hand of observation.hands) {
      const pts = hand.landmarks.map((p) => uvToScreen(p.u, p.v, w, h));
      const lifted = perception.hands.find((p) => p.id === hand.id);
      const near = lifted?.nearCamera ?? false;
      ctx.lineWidth = 3;
      ctx.strokeStyle = personColor(lifted?.personId);
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
        const label = `✋${hand.id}${lifted?.personId != null ? ` P${lifted.personId}` : ""}${lifted ? ` ${lifted.distance.toFixed(2)} m` : ""}${near ? " near" : ""}`;
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
      const pf = perception.faces.find((f) => f.id === face.id);
      const color = contact ? "#ff4d8d" : personColor(pf?.personId);
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

    // People: id badge (speaking indicator, viewer, who the dog is attending to).
    const attending = brain?.attentionPerson ?? null;
    for (const person of perception.people) {
      const pt = personLabelPoint(person, w, h);
      if (!pt) continue;
      const speaking = person.speaking >= 0.3;
      const label = `P${person.id}${person.isViewer ? " you" : ""}${speaking ? " 🗣" : ""}${person.id === attending ? " ◀dog" : ""}`;
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = personColor(person.id);
      ctx.fillRect(pt.x - tw / 2, pt.y - 44, tw, 20);
      ctx.fillStyle = "#000";
      ctx.fillText(label, pt.x - tw / 2 + 5, pt.y - 29);
      if (speaking) {
        ctx.strokeStyle = personColor(person.id);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 18 + 10 * person.speaking, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // ---- Setup (everything above is initialised) ----
  for (const entry of commandButtons) {
    const onClick = () => {
      if (voiceWanted && voiceState === "off") startVoice(); // remembered choice resumes on the first tap
      if (!brain) return;
      const cmd = entry.cmd();
      brain.command(cmd);
      sounds.commanded(cmd);
      party?.commanded(cmd);
      navigator.vibrate?.(12);
      syncButtons();
    };
    entry.button.addEventListener("click", onClick);
    cleanups.push(() => entry.button.removeEventListener("click", onClick));
  }
  setLabels(labels);

  const onToggle = () => setVision(!showVision);
  ui.visionToggle.addEventListener("click", onToggle);
  cleanups.push(() => ui.visionToggle.removeEventListener("click", onToggle));
  setVision(false);
  syncButtons();
  setStatus("");

  // Voice: only a tap starts the mic, so the listener is idle unless primeVoice() already started it from the Deploy tap.
  voice = acquireVoice();
  if (voice) {
    cleanups.push(voice.onResult(onVoiceResult), voice.onState(onVoiceState));
    if (voice.state !== "off") {
      voiceWanted = voice.state === "starting" || voice.state === "listening" || voiceWanted;
      onVoiceState(voice.state);
    }
  }
  ui.voiceChip.hidden = true;
  ui.voiceHint.hidden = true;
  const onVoiceToggle = () => {
    if (voiceState === "starting" || voiceState === "listening") stopVoice();
    else startVoice();
  };
  ui.voiceToggle.addEventListener("click", onVoiceToggle);
  cleanups.push(() => ui.voiceToggle.removeEventListener("click", onVoiceToggle));
  syncVoiceUI();
  if (ui.soundToggle) cleanups.push(bindSoundButton(ui.soundToggle));
  if (voice?.supported && voiceWanted && voiceState === "off") {
    // Remembered "on": a browser only lets a tap start the mic, so wait for the first button press.
    ui.voiceHint.textContent = "Tap 🎤 to turn voice commands back on";
    ui.voiceHint.hidden = false;
    voiceHintLeft = VOICE_HINT_S;
  }

  return {
    attach(newDog, anchor, floorY) {
      unsubPet?.();
      dog = newDog;
      dogClock = 0;
      brain = createPetBrain(newDog, anchor, floorY);
      party?.attach(newDog, anchor);
      sounds.placed(newDog);
      unsubPet = brain.onPetStart((zone, point) => {
        fx.burst(point, zone);
        navigator.vibrate?.(petBuzz(newDog.species, zone));
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
          console.warn("[pet] hand detection unavailable", err);
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
        // Only hands pick the fast cadence (the mask is the only thing that profits from it).
        if (observation.hands.length > 0) lastHandSeenMs = timeMs;
        perception = liftObservation(observation, cam, perception, dtSincePrev);
        perception = people.update(perception, 0); // fresh items: attribute, no time passes
        lastCamHadDepth = !!cam.depthAt; // depthMap itself is a lazy conversion: not touched here
        occluder.setCamera?.(cam);
      } catch (err) {
        console.warn("[pet] detection failed", err);
        return;
      }
    },
    update(dt, viewer, ear) {
      if (disposed) return;
      // Age perception between detections and forget stale entries.
      observationAge += dt;
      noteAge += dt;
      for (const h of perception.hands) h.age += dt;
      for (const f of perception.faces) f.age += dt;
      for (const b of perception.bodies) b.age += dt;
      if (
        perception.hands.some((h) => h.age > HAND_DROP_AGE) ||
        perception.faces.some((f) => f.age > FACE_DROP_AGE) ||
        perception.bodies.some((b) => b.age > BODY_DROP_AGE)
      ) {
        perception.hands = perception.hands.filter((h) => h.age <= HAND_DROP_AGE);
        perception.faces = perception.faces.filter((f) => f.age <= FACE_DROP_AGE);
        perception.bodies = perception.bodies.filter((b) => b.age <= BODY_DROP_AGE);
      }
      perception = people.update(perception, dt); // stale items: persons age / expire, speech window moves on

      // Voice chip / hint timers.
      if (voiceChipLeft > 0 && (voiceChipLeft -= dt) <= 0) showChip("");
      if (voiceHintLeft > 0 && (voiceHintLeft -= dt) <= 0) ui.voiceHint.hidden = true;

      if (brain && dog) {
        dogClock += dt;
        brain.update(dt, perception, viewer);
        party?.beforeDogUpdate(dt);
        dog.update(dogClock);
      }
      party?.update(dt, perception);
      if (!ear) {
        fallbackEar.position.copy(viewer.position);
        fallbackEar.quaternion.setFromUnitVectors(AHEAD, viewer.forward);
      }
      // Mic on: duck the pets; someone mid-phrase: no chatter (it would talk over them / into the recogniser).
      sounds.setMic(voiceState === "listening", performance.now() - lastSpeechMs < 1500);
      sounds.update(dt, dog, party ? party.shownPets(shownPets) : shownPets, ear ?? fallbackEar);
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
      party?.dispose();
      sounds.dispose();
      clearExtendTimer();
      releaseVoice();
      voice = null;
      ui.voiceChip.hidden = true;
      ui.voiceHint.hidden = true;
      people.reset();
      occluder.setCamera?.(null);
      setVision(false);
      setStatus("");
      for (const { button } of commandButtons) button.disabled = false;
      setLabels(PLAY_LABELS.dog); // index.html's labels: nothing species-specific left for the next session
      fx.dispose();
      occluder.dispose();
      brain = null;
      dog = null;
      detector = null; // the detector itself stays cached for the next session
    },
  };
}
