import { clips, type Clip } from "./samples";
import type { Shot } from "./shot";
import * as synth from "./synth";

/*
 * What a pet says, played from real recordings (samples.ts, public/sounds/).
 *
 * - Each sound picks a clip from its category: per pet, a stable subset of the clips (so one dog
 *   doesn't bark with five different dogs' voices), never the same clip twice in a row.
 * - Size: dogs bark from the small / medium / big pool their shoulder height falls in; on top, a
 *   gentle playbackRate shift (Voice.rate / Voice.body, kept within ~0.85–1.2 so nothing sounds
 *   chipmunked or slowed down) plus a ±5 % pitch and a small loudness jitter on every play.
 * - The clips are all normalized to about -16 LUFS: LEVEL sets how loud each kind is in the mix
 *   (a purr or a pant is much quieter than a bark).
 * - Every method returns when the sound ends, or null when it plays nothing: while the clips are
 *   still loading it stays quiet (they will be there in a moment); if they couldn't be loaded the
 *   core noises (barks, meows) fall back to synth.ts and the rest stay silent. Cat sniffs and
 *   grooming licks have no recording and are always synthesized.
 */

export type Size = "small" | "medium" | "big";

/** A pet's voice: the synth Tone (fallbacks) plus how recordings are picked and pitched. */
export type Voice = synth.Tone & {
  /** Which dog.bark.* pool. */
  size: Size;
  /** playbackRate for barks, relative to the pool (≈1 = the pool's typical dog). */
  rate: number;
  /** playbackRate for everything else (whines, growls, meows, purrs …). */
  body: number;
};

type End = number | null;
type Got = Clip | null | undefined; // undefined: still loading

const RATE_MIN = 0.85;
const RATE_MAX = 1.22;

/** Mix level per kind of sound (the clips themselves are loudness-matched). */
const LEVEL = {
  bark: 0.8,
  whine: 0.5,
  growl: 0.6,
  howl: 0.5,
  sigh: 0.55,
  huff: 0.55,
  yawn: 0.5,
  sniff: 0.35,
  pant: 0.2,
  meow: 0.7,
  trill: 0.65,
  chatter: 0.9,
  purr: 0.4,
} as const;

/** Cat meow kinds → clip pool, rate and loudness. */
const MEOWS: Record<synth.MeowKind, { keys: string[]; rate: number; gain: number }> = {
  mew: { keys: ["cat.meow.short"], rate: 1, gain: 0.9 },
  meow: { keys: ["cat.meow"], rate: 1, gain: 1 },
  question: { keys: ["cat.meow.question"], rate: 1, gain: 0.95 },
  long: { keys: ["cat.meow.long"], rate: 1, gain: 1 },
  wary: { keys: ["cat.meow.short", "cat.meow"], rate: 0.93, gain: 0.6 }, // quiet and a bit low
  yawn: { keys: ["cat.meow.long"], rate: 0.9, gain: 0.45 }, // a sleepy, drawn-out mrraow
};

const R = (a: number, b: number) => a + Math.random() * (b - a);
const clampRate = (r: number) => Math.min(RATE_MAX, Math.max(RATE_MIN, r));
/** A recipe's `pitch` (1.3 = excited yip) as a playbackRate factor, much gentler on real clips. */
const pitchRate = (p = 1) => 1 + (p - 1) * 0.5;
/** The latest of several ends (null: none of them plays). */
export const latest = (...ends: End[]): End => ends.reduce<End>((a, b) => (b === null ? a : a === null ? b : Math.max(a, b)), null);

export class Vocals {
  private readonly pools = new Map<string, { set: Clip[]; last: number }>();

  constructor(readonly v: Voice) {}

  private get dog() {
    return this.v.species === "dog";
  }

  /** A clip from these categories / ids (see the header). */
  private pick(keys: readonly string[]): Got {
    const name = keys.join("|");
    let p = this.pools.get(name);
    if (!p) {
      const all: Clip[] = [];
      for (const k of keys) {
        const c = clips(k);
        if (!c) return undefined;
        all.push(...c);
      }
      if (!all.length) return null;
      // This pet's own subset (~60 %, at least 2), so its voice stays recognisable.
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      p = { set: all.slice(0, Math.max(Math.min(2, all.length), Math.ceil(all.length * 0.6))), last: -1 };
      this.pools.set(name, p);
    }
    const n = p.set.length;
    let i = Math.floor(Math.random() * n);
    if (n > 1 && i === p.last) i = (i + 1 + Math.floor(Math.random() * (n - 1))) % n;
    p.last = i;
    return p.set[i];
  }

  /** `first`, or `then` if none of `first` could be loaded. */
  private pickPreferring(first: readonly string[], then: readonly string[]): Got {
    const c = this.pick(first);
    return c === null ? this.pick(then) : c;
  }

  private play(s: Shot, t: number, c: Clip, gain: number, rate: number): number {
    return s.clip(c.buffer, t, clampRate(rate * R(0.95, 1.05)), gain * R(0.88, 1.05));
  }

  // ---- Dog ----

  private get barkGain() {
    return LEVEL.bark * (0.85 + 0.3 * this.v.big); // big dogs are louder
  }

  bark(s: Shot, t: number, o: synth.BarkOpts = {}): End {
    const c = this.pick([`dog.bark.${this.v.size}`]);
    if (c === undefined) return null;
    if (c === null) return synth.bark(s, t, this.v, o);
    return this.play(s, t, c, this.barkGain * (o.vol ?? 1), this.v.rate * pitchRate(o.pitch));
  }

  /** n barks in a row: a recorded sequence now and then, else one bark of this dog's repeated. */
  barks(s: Shot, t: number, n: number, o: synth.BarkOpts = {}): End {
    const one = this.pick([`dog.bark.${this.v.size}`]);
    if (one === undefined) return null;
    if (one === null) return synth.barks(s, t, this.v, n, o);
    const gain = this.barkGain * (o.vol ?? 1);
    const rate = this.v.rate * pitchRate(o.pitch);
    if (n >= 2 && Math.random() < 0.4) {
      const seq = this.pick([`dog.barks.${this.v.size}`]);
      if (seq) return this.play(s, t, seq, gain, rate);
    }
    let at = t;
    let end = t;
    for (let i = 0; i < n; i++) {
      const last = i === n - 1 && n > 1;
      end = this.play(s, at, one, gain * (i ? R(0.8, 1) : 1), rate * (last ? 0.97 : 1));
      at = end + R(0.06, 0.18) + 0.1 * this.v.big;
    }
    return end;
  }

  /** `lift` 0..1: a rising, asking whine (slightly higher). */
  whine(s: Shot, t: number, o: { vol?: number; lift?: number } = {}): End {
    const c = this.pick(["dog.whine"]);
    return c ? this.play(s, t, c, LEVEL.whine * (o.vol ?? 1), this.v.body * (1 + 0.04 * (o.lift ?? 0.5))) : null;
  }

  /** Happy, excited greeting whimper. */
  whimper(s: Shot, t: number): End {
    const c = this.pick(["dog.whine.greet", "dog-whine-3"]);
    return c ? this.play(s, t, c, LEVEL.whine, this.v.body * 1.03) : null;
  }

  /** Play growl / happy grumble: a small dog's yappy grumble, a big dog's low one. */
  growl(s: Shot, t: number, vol = 1): End {
    const own = this.v.size === "small" ? ["dog-growl-1", "dog-growl-2"] : this.v.size === "big" ? ["dog-growl-2", "dog-growl-3"] : ["dog.growl"];
    const c = this.pickPreferring(own, ["dog.growl"]);
    return c ? this.play(s, t, c, LEVEL.growl * vol, this.v.body) : null;
  }

  /** A contented groan-sigh (`groan` false: softer). */
  sigh(s: Shot, t: number, groan: boolean, vol = 1): End {
    const c = this.pick(["dog.sigh"]);
    return c ? this.play(s, t, c, LEVEL.sigh * vol * (groan ? 1 : 0.7), this.v.body) : null;
  }

  huff(s: Shot, t: number, vol = 1): End {
    const c = this.pick(["dog.huff"]);
    return c ? this.play(s, t, c, LEVEL.huff * vol, this.v.body) : null;
  }

  howl(s: Shot, t: number, vol = 1): End {
    const c = this.pick(["dog.howl"]);
    return c ? this.play(s, t, c, LEVEL.howl * vol * (0.8 + 0.4 * this.v.big), this.v.body) : null;
  }

  dogYawn(s: Shot, t: number): End {
    const c = this.pick(["dog.yawn"]);
    return c ? this.play(s, t, c, LEVEL.yawn, this.v.body) : null;
  }

  /** A burst of `n` sniffs (dogs: a recorded sniffing bout; cats: soft synthesized puffs). */
  sniffs(s: Shot, t: number, n: number, vol = 1): End {
    if (!this.dog) return synth.sniffs(s, t, this.v, n, vol);
    const c = this.pick(["dog.sniff"]);
    if (c === undefined) return null;
    if (c === null) return synth.sniffs(s, t, this.v, n, vol);
    return this.play(s, t, c, LEVEL.sniff * vol, this.v.body);
  }

  // ---- Cat ----

  meow(s: Shot, t: number, kind: synth.MeowKind = "meow", vol = 1): End {
    const m = MEOWS[kind];
    const c = this.pick(m.keys);
    if (c === undefined) return null;
    if (c === null) return synth.meow(s, t, this.v, kind, vol);
    return this.play(s, t, c, LEVEL.meow * m.gain * vol * (this.v.flavor === "persian" ? 0.85 : 1), this.v.body * m.rate);
  }

  /** "Mrrp↑" greeting trill (no trills loaded: a little mew instead). */
  trill(s: Shot, t: number, vol = 1): End {
    const c = this.pick(["cat.trill"]);
    if (c === undefined) return null;
    if (c === null) return synth.meow(s, t, this.v, "mew", vol * 0.6);
    return this.play(s, t, c, LEVEL.trill * vol, this.v.body);
  }

  /** "Ek-ek-ek" chattering (watching prey, pouncing). */
  chatter(s: Shot, t: number, vol = 1): End {
    const c = this.pick(["cat.chatter"]);
    return c ? this.play(s, t, c, LEVEL.chatter * vol, this.v.body) : null;
  }

  licks(s: Shot, t: number, n: number, span: number, vol = 1): End {
    return synth.licks(s, t, n, span, vol);
  }

  // ---- Loops ----

  /** The purr (cats) or the panting (dogs) as a fading loop; null while / if there is no clip. */
  loop(ac: BaseAudioContext, dest: AudioNode): Loop | null {
    const c = this.dog
      ? this.pickPreferring([this.v.size === "small" ? "dog-pant-2" : "dog-pant-1"], ["dog.pant"]) // Shih Tzu / retriever
      : this.pick(["cat.purr"]);
    if (!c) return null;
    return new Loop(ac, dest, c, clampRate(this.v.body * R(0.97, 1.03)), this.dog ? LEVEL.pant : LEVEL.purr);
  }
}

/** A seamlessly looping clip whose level fades with set(); runs until stop(). */
export class Loop {
  private readonly level: GainNode;
  private readonly src: AudioBufferSourceNode;
  private stopped = false;

  constructor(
    private readonly ac: BaseAudioContext,
    dest: AudioNode,
    c: Clip,
    rate: number,
    private readonly gain: number,
  ) {
    this.level = ac.createGain();
    this.level.gain.value = 0;
    this.level.connect(dest);
    this.src = ac.createBufferSource();
    this.src.buffer = c.buffer;
    this.src.loop = true;
    this.src.loopStart = c.loopStart;
    this.src.loopEnd = c.loopEnd;
    this.src.playbackRate.value = rate;
    this.src.connect(this.level);
    // Start anywhere in the loop body: two purring cats never breathe in sync.
    this.src.start(ac.currentTime, c.loopStart + Math.random() * (c.loopEnd - c.loopStart));
  }

  /** Fade towards `v` (0..1), with time constants for fading up / down. */
  set(v: number, up = 0.3, down = 0.6): void {
    if (this.stopped) return;
    const target = v * this.gain;
    const now = this.ac.currentTime;
    this.level.gain.setTargetAtTime(target, now, target > this.level.gain.value ? up : down);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.src.stop();
    } catch {
      /* already stopped */
    }
    this.level.disconnect();
  }
}
