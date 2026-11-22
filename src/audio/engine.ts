/*
 * The one shared AudioContext and everything global about pet sound (petSounds.ts plays the sounds):
 *
 *   sounds ─► per-pet PannerNode (HRTF) ─► master gain (mute · mic duck) ─► compressor ─► speakers
 *
 * - Created lazily and kept for the whole page (iOS allows only a few contexts, and creating one
 *   costs ~10 ms): later AR / camera sessions reuse it. Suspended between sessions and while the
 *   page is hidden, so it doesn't keep the audio hardware (and battery) busy.
 * - Browsers start a context "suspended" until a user gesture resumes it (iOS Safari also wants a
 *   sound played inside that gesture). primeAudio() is called from the Deploy tap and the mute
 *   button; a capture-phase pointerdown listener retries after iOS "interrupted" it (a call, Siri,
 *   another app taking the audio session) or after a resume that was refused.
 * - At most MAX_SHOTS one-shot sounds at once across all pets (claimShot / releaseShot): a party of
 *   pets never turns into a wall of noise, and old phones never run out of audio threads.
 * - Mute is remembered in localStorage (try/catch'd: private mode just doesn't remember).
 */

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

const MUTE_KEY = "ar-pet-sound-muted";
/** Master level: the synthesized voices peak near 1, several can overlap. */
const MASTER_LEVEL = 0.8;
const MAX_SHOTS = 6;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let muted = readMuted();
let duck = 1;
let wanted = false; // a play session is running: keep the context running while visible
let shots = 0;
let listenersOn = false;
const muteSubs = new Set<(muted: boolean) => void>();

function readMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/** The shared context (created on first use), or null when the browser has no Web Audio. */
export function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor({ latencyHint: "interactive" });
  } catch {
    return null;
  }
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 8;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.2;
  comp.connect(ctx.destination);
  master = ctx.createGain();
  master.gain.value = level();
  master.connect(comp);
  installListeners();
  return ctx;
}

/** Where every pet's panner connects. */
export function audioOut(): AudioNode | null {
  audioContext();
  return master;
}

/** Call synchronously inside a tap (Deploy, mute button): creates / resumes the context and unlocks iOS. */
export function primeAudio(): void {
  const ac = audioContext();
  if (!ac) return;
  resume();
  try {
    // iOS unlocks Web Audio for the page only after a sound starts inside a gesture: one silent sample.
    const src = ac.createBufferSource();
    src.buffer = ac.createBuffer(1, 1, ac.sampleRate);
    src.connect(ac.destination);
    src.start();
  } catch {
    /* already unlocked / closed */
  }
}

/** A play session started (true) or ended (false): the context is suspended outside sessions. */
export function setAudioActive(on: boolean): void {
  wanted = on;
  if (!ctx) return;
  if (on) resume();
  else void ctx.suspend().catch(() => {});
}

/** True when a new sound would be heard: context running, not muted. */
export function audioReady(): boolean {
  return !!ctx && ctx.state === "running" && !muted && wanted;
}

export function soundMuted(): boolean {
  return muted;
}

export function setSoundMuted(m: boolean): void {
  if (m === muted) return;
  muted = m;
  try {
    globalThis.localStorage?.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* storage blocked: the choice just isn't remembered */
  }
  applyLevel();
  for (const fn of muteSubs) fn(m);
}

export function onMuteChange(fn: (muted: boolean) => void): () => void {
  muteSubs.add(fn);
  return () => muteSubs.delete(fn);
}

/** 0..1 master duck (e.g. while the voice-command mic listens, so the pets don't talk over the user). */
export function setDuck(d: number): void {
  if (Math.abs(d - duck) < 1e-3) return;
  duck = d;
  applyLevel();
}

/** One more one-shot may start (false: too many playing). Pair every true with releaseShot(). */
export function claimShot(): boolean {
  if (shots >= MAX_SHOTS) return false;
  shots++;
  return true;
}
export function releaseShot(): void {
  shots = Math.max(0, shots - 1);
}

/** 2 s of white noise, shared by every noisy sound (looped, started at random offsets). */
export function noiseBuffer(ac: BaseAudioContext): AudioBuffer {
  if (noise && noise.sampleRate === ac.sampleRate) return noise;
  const n = Math.floor(ac.sampleRate * 2);
  noise = ac.createBuffer(1, n, ac.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

function level(): number {
  return muted ? 0 : MASTER_LEVEL * duck;
}

function applyLevel() {
  if (!ctx || !master) return;
  master.gain.setTargetAtTime(level(), ctx.currentTime, 0.08);
}

function resume() {
  if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
  if (typeof document !== "undefined" && document.hidden) return;
  void ctx.resume().catch(() => {}); // refused without a gesture: the next pointerdown retries
}

function installListeners() {
  if (listenersOn || typeof document === "undefined") return;
  listenersOn = true;
  // A tap anywhere resumes a context the browser suspended / interrupted (passive, capture: never in the way).
  const onTap = () => {
    if (wanted && ctx && ctx.state !== "running") primeAudio();
  };
  window.addEventListener("pointerdown", onTap, { capture: true, passive: true });
  window.addEventListener("touchend", onTap, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) void ctx.suspend().catch(() => {});
    else if (wanted) resume();
  });
}
