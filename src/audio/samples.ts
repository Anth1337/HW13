/*
 * The recorded pet sounds (public/sounds/: real dog and cat recordings, CC0, see CREDITS.md),
 * decoded once and kept for the whole page.
 *
 * - loadSamples() runs on the first primeAudio() (the Deploy tap) and again from createPetSounds()
 *   (idempotent): it fetches manifest.json, then every clip in parallel, and decodes each into an
 *   AudioBuffer. ~0.8 MB, AAC (.m4a: native on iOS / Safari, Chrome, Firefox).
 * - clips(key) answers per category (or per clip id): undefined while any clip of it is still
 *   loading (callers then stay quiet rather than fall back), [] if none could be loaded (a 404,
 *   a decode error, no network: callers fall back to a synthesized recipe or silence), else the
 *   decoded clips.
 * - A failed manifest is retried on the next play session; a failed clip is not.
 */

type Entry = { file: string; category: string; duration?: number; loop?: boolean; loopStart?: number; loopEnd?: number };

export type Clip = {
  id: string;
  category: string;
  buffer: AudioBuffer;
  /** Loop body for looping clips (the purrs, the panting): seconds into the buffer. */
  loopStart: number;
  loopEnd: number;
};

const BASE = `${import.meta.env.BASE_URL}sounds/`;

let started = false;
let failed = false;
let manifest: Record<string, Entry> | null = null;
const loaded = new Map<string, Clip>();
const pending = new Set<string>();

/** Starts fetching + decoding every clip (once). `ac` decodes them (its state doesn't matter). */
export function loadSamples(ac: BaseAudioContext): void {
  if (started) return;
  started = true;
  failed = false;
  void (async () => {
    let m: Record<string, Entry>;
    try {
      const res = await fetch(BASE + "manifest.json");
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      m = (await res.json()) as Record<string, Entry>;
    } catch (err) {
      console.warn("[sound] no samples, using fallbacks", err);
      failed = true;
      started = false; // try again next session
      return;
    }
    const entries = Object.entries(m).filter(([, e]) => typeof e?.file === "string" && typeof e.category === "string");
    for (const [id] of entries) pending.add(id);
    manifest = Object.fromEntries(entries);
    await Promise.all(entries.map(([id, e]) => loadOne(ac, id, e)));
  })();
}

async function loadOne(ac: BaseAudioContext, id: string, e: Entry): Promise<void> {
  try {
    const res = await fetch(BASE + encodeURIComponent(e.file));
    if (!res.ok) throw new Error(`${res.status}`);
    const buffer = await decode(ac, await res.arrayBuffer());
    const d = buffer.duration;
    let loopStart = e.loop && typeof e.loopStart === "number" ? Math.max(0, e.loopStart) : 0;
    let loopEnd = e.loop && typeof e.loopEnd === "number" ? Math.min(d, e.loopEnd) : d;
    if (loopEnd - loopStart < 0.2) [loopStart, loopEnd] = [0, d];
    loaded.set(id, { id, category: e.category, buffer, loopStart, loopEnd });
  } catch (err) {
    console.warn(`[sound] ${e.file} unavailable`, err);
  } finally {
    pending.delete(id);
  }
}

/** decodeAudioData as a promise, also on old Safari (callback-only). */
function decode(ac: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const p = ac.decodeAudioData(data, resolve, (err) => reject(err ?? new Error("decode failed")));
    p?.then?.(resolve, reject);
  });
}

/** The clips of a category (e.g. "dog.bark.small") or the one clip with that id. See the header. */
export function clips(key: string): Clip[] | undefined {
  if (failed) return [];
  if (!manifest) return undefined;
  const out: Clip[] = [];
  for (const [id, e] of Object.entries(manifest)) {
    if (id !== key && e.category !== key) continue;
    if (pending.has(id)) return undefined;
    const c = loaded.get(id);
    if (c) out.push(c);
  }
  return out;
}
