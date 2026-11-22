import { onMuteChange, primeAudio, setSoundMuted, soundMuted } from "./engine";

/*
 * Pet sound effects: engine.ts (the shared AudioContext, unlock, mute, duck), samples.ts (the
 * recorded dog / cat sounds in public/sounds/, loaded once), vocals.ts (which clip a pet plays, and
 * how pitched), synth.ts (procedural fallbacks and the few sounds without a recording), shot.ts
 * (one sound's nodes) and petSounds.ts (per-pet "sound brains" that decide when to speak).
 */

export { primeAudio, soundMuted, setSoundMuted } from "./engine";
export { createPetSounds, type Ear, type PetSounds } from "./petSounds";

/** Wires the overlay's 🔊 / 🔇 button (#btn-sound). Returns an unbind. */
export function bindSoundButton(button: HTMLButtonElement): () => void {
  const sync = (muted: boolean) => {
    button.textContent = muted ? "🔇" : "🔊";
    button.dataset.muted = String(muted);
    const label = muted ? "Pet sounds off — tap to turn on" : "Pet sounds on — tap to mute";
    button.setAttribute("aria-label", label);
    button.title = label;
  };
  const onClick = () => {
    setSoundMuted(!soundMuted());
    primeAudio(); // inside the tap: also (re)unlocks audio
  };
  button.addEventListener("click", onClick);
  const off = onMuteChange(sync);
  sync(soundMuted());
  return () => {
    button.removeEventListener("click", onClick);
    off();
  };
}
