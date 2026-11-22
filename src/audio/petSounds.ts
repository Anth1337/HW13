import * as THREE from "three";
import { catBreedPreset } from "../cat/config";
import type { CatBreed } from "../cat/types";
import { breedPreset } from "../dog/config";
import { TRICK_DURATION, type Breed, type DogCommand, type PetCharacter, type TrickKind } from "../dog/types";
import { audioContext, audioOut, audioReady, claimShot, releaseShot, setAudioActive, setDuck } from "./engine";
import { clips, loadSamples } from "./samples";
import { Shot } from "./shot";
import type { Flavor } from "./synth";
import { Loop, Vocals, latest, type Voice } from "./vocals";

/*
 * The pets' voices during a play session (dogPlay.ts owns one PetSounds).
 *
 * Every pet this phone renders (its own pet and the friends' pets party.ts shows) gets a PetVoice:
 * a small "sound brain" that watches the pet's PetControls each frame and speaks on transitions
 * (petting starts / ends, a trick starts, sniffing starts, lying down, breaking into a run) plus
 * now and then by itself. Controls are all it needs, so friends' pets, posed from their snapshots,
 * sound exactly like this phone's pet, from where they stand here, without any sound being sent
 * over the network (and without double-playing: each phone voices only what it renders).
 * A few things controls can't tell are pushed in by dogPlay.ts: a command to this phone's pet, the
 * user talking, placement, and the start of a meeting between two pets (party.ts).
 *
 * The sounds themselves are real recordings (vocals.ts picks and pitches them per pet).
 * Each voice plays through its own HRTF PannerNode at the pet's head; the AudioListener follows
 * the phone camera (setEar). Rates are deliberately low and every category has a cooldown: pets
 * that never stop barking are annoying within a minute.
 */

/** The listener: the phone camera in world space (webxr.ts / cameraMode.ts pass their camera pose). */
export type Ear = { position: THREE.Vector3; quaternion: THREE.Quaternion };

export interface PetSounds {
  /** Once per frame after the pets were posed: voices for the pets shown, listener, triggers. */
  update(dt: number, own: PetCharacter | null, others: readonly PetCharacter[], ear: Ear): void;
  /** This phone's pet was given a command (button, voice or a friend). */
  commanded(cmd: DogCommand): void;
  /** The user said something to this phone's pet (no command recognised). */
  heard(): void;
  /** A pet was just placed / deployed. */
  placed(pet: PetCharacter): void;
  /** Two pets shown here start meeting (a walks over to b). */
  meet(a: PetCharacter, b: PetCharacter): void;
  /** Voice commands: mic listening (duck everything) / a phrase being heard right now (hold chatter). */
  setMic(listening: boolean, hearing: boolean): void;
  dispose(): void;
}

// ---- Rates (seconds) ----------------------------------------------------------------------
/** Idle bark / meow every IDLE_MIN..IDLE_MAX (×2.2 lying, ×0.6 excited). */
const IDLE_MIN = 20;
const IDLE_MAX = 60;
/** Minimum gap between two sounds of one pet, and between any two sounds at all. */
const PET_GAP = 0.8;
const ANY_GAP = 0.3;
/** Concurrent one-shots per pet (the engine also caps all pets together). */
const PET_SHOTS = 2;
const COOL = {
  pet: 5, // happy noise when petting starts
  murmur: 7, // sigh / whine / trill during long petting (randomised further)
  sniff: 1.8,
  run: 12,
  lie: 15,
  cmd: 2,
  perk: 10,
  hello: 3,
  greet: 6,
} as const;
type Category = keyof typeof COOL | "idle" | "trick" | "yawn";
/** Ducked master level while the voice-command mic listens. */
const MIC_DUCK = 0.45;
/** A purr / panting loop that has been silent this long is stopped (restarted when needed). */
const LOOP_STOP_AFTER = 3;
/** placed() while the recordings are still loading: try the hello again for this long. */
const HELLO_RETRY_MS = 4000;
const DOG_FLAVOR: Partial<Record<Breed, Flavor>> = { husky: "husky", beagle: "beagle", pug: "pug" };
const CAT_FLAVOR: Partial<Record<CatBreed, Flavor>> = { siamese: "siamese", persian: "persian", maineCoon: "maineCoon" };

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const chance = (p: number) => Math.random() < p;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const clampTo = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Pitch / formants / size from the species, breed height range and the size slider. */
function voiceFor(pet: PetCharacter): Voice {
  const cfg = pet.config as { breed?: string; size?: number };
  const size = clamp01(cfg.size ?? 0.5);
  if (pet.species === "dog") {
    const [lo, hi] = breedPreset((cfg.breed ?? "mutt") as Breed).heightRange;
    const h = lo + (hi - lo) * size; // shoulder height, 0.18 (dachshund) … 0.65 (shepherd)
    const flavor = DOG_FLAVOR[cfg.breed as Breed] ?? "none";
    const big = clamp01((h - 0.2) / 0.42);
    // Bark pool by height; within it, a gentle shift from the pool's typical dog (0.26 / 0.41 / 0.58 m).
    const pool = h < 0.34 ? "small" : h < 0.48 ? "medium" : "big";
    const ref = pool === "small" ? 0.26 : pool === "medium" ? 0.41 : 0.58;
    return {
      species: "dog",
      f0: (125 / h) * (flavor === "husky" ? 1.15 : 1),
      fk: Math.sqrt(0.4 / h),
      big,
      rasp: flavor === "pug" ? 0.7 : flavor === "husky" ? 0.5 : 0.2 + 0.2 * big,
      flavor,
      size: pool,
      rate: clampTo(Math.pow(ref / h, 0.4), 0.88, 1.15),
      body: clampTo(Math.pow(0.42 / h, 0.3), 0.88, 1.15),
    };
  }
  const [lo, hi] = catBreedPreset((cfg.breed ?? "shorthair") as CatBreed).heightRange;
  const h = lo + (hi - lo) * size; // 0.20 … 0.36
  const flavor = CAT_FLAVOR[cfg.breed as CatBreed] ?? "none";
  const body = clampTo(Math.pow(0.27 / h, 0.5), 0.92, 1.15); // little / kitten-ish cats a bit higher
  return {
    species: "cat",
    f0: 560 * Math.pow(0.25 / h, 0.6) * (flavor === "siamese" ? 0.8 : flavor === "persian" ? 1.1 : 1),
    fk: Math.pow(0.25 / h, 0.4),
    big: clamp01((h - 0.2) / 0.16),
    rasp: flavor === "siamese" ? 0.45 : flavor === "persian" ? 0.08 : 0.15,
    flavor,
    size: h < 0.24 ? "small" : h < 0.3 ? "medium" : "big",
    rate: body,
    body,
  };
}

/** Schedules a sound into the shot at t; returns its end, or null if nothing plays. */
type Recipe = (s: Shot, t: number) => number | null;
type SayOpts = { delay?: number; vol?: number; force?: boolean; cooldown?: number };

/** What all voices share: the clock gate between any two sounds, and the mic hush. */
type Shared = { lastAnyMs: number; hushed: boolean };

class PetVoice {
  private readonly v: Vocals;
  private readonly panner: PannerNode;
  private readonly bus: GainNode;
  private readonly shots = new Set<Shot>();
  private readonly cool: Partial<Record<Category, number>> = {};
  seen = true;
  private lastSayMs = -Infinity;
  // Edge trackers.
  private petOn = false;
  private petFor = 0;
  private nextMurmur = 0;
  private trick: TrickKind | null = null;
  private sniffOn = false;
  private nextSniffMs = 0;
  private lying = false;
  private lyingFor = 0;
  private yawnAt = Infinity;
  private running = false;
  private pantAfterMs = -Infinity; // keep panting until then (after a trick)
  private nextIdleMs: number;
  private helloUntil = 0; // placed while the recordings were loading: say hello once loaded, until then
  private loop: Loop | null = null; // purr (cats) / panting (dogs)
  private loopSilent = 0;

  constructor(
    readonly pet: PetCharacter,
    private readonly ac: AudioContext,
    out: AudioNode,
    private readonly shared: Shared,
  ) {
    this.v = new Vocals(voiceFor(pet));
    this.panner = ac.createPanner();
    this.panner.panningModel = "HRTF";
    this.panner.distanceModel = "inverse";
    this.panner.refDistance = 0.7;
    this.panner.rolloffFactor = 1;
    this.panner.maxDistance = 30;
    this.bus = ac.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(this.panner).connect(out);
    this.nextIdleMs = performance.now() + rand(8, 25) * 1000; // first one a bit sooner
  }

  private get dog() {
    return this.v.v.species === "dog";
  }

  /** Head position from the root's last world matrix (no matrix updates: one frame late is fine). */
  place(p: THREE.Vector3): void {
    const m = this.pet.root.matrixWorld.elements;
    const sy = Math.hypot(m[4], m[5], m[6]) || 1;
    const sz = Math.hypot(m[8], m[9], m[10]) || 1;
    const up = (this.pet.height * 0.8) / sy;
    const fwd = (this.pet.length * 0.4) / sz;
    p.set(m[12] + m[4] * up + m[8] * fwd, m[13] + m[5] * up + m[9] * fwd, m[14] + m[6] * up + m[10] * fwd);
    const pn = this.panner;
    if (pn.positionX) {
      pn.positionX.value = p.x;
      pn.positionY.value = p.y;
      pn.positionZ.value = p.z;
    } else {
      pn.setPosition(p.x, p.y, p.z);
    }
  }

  /** Plays a recipe if this pet may speak now. True if it started. */
  say(cat: Category, recipe: Recipe, o: SayOpts = {}): boolean {
    const now = performance.now();
    if (!audioReady()) return false;
    if ((this.cool[cat] ?? -Infinity) > now) return false;
    if (!o.force && (this.shared.hushed || now - this.lastSayMs < PET_GAP * 1000 || now - this.shared.lastAnyMs < ANY_GAP * 1000)) return false;
    if (this.shots.size >= PET_SHOTS || !claimShot()) return false;
    let shot: Shot | null = null;
    try {
      const s: Shot = (shot = new Shot(this.ac, this.bus, o.vol ?? 1, () => {
        this.shots.delete(s);
        releaseShot();
      }));
      this.shots.add(s);
      const t = this.ac.currentTime + 0.01 + (o.delay ?? 0);
      const end = recipe(s, t);
      if (end === null) {
        s.kill(); // nothing to play (clips still loading / missing): no cooldown either
        return false;
      }
      s.end(end);
    } catch (err) {
      console.warn("[sound] failed", err);
      if (shot) shot.kill(); // releases the slot
      else releaseShot();
      return false;
    }
    const cd = o.cooldown ?? (cat in COOL ? COOL[cat as keyof typeof COOL] : 0);
    this.cool[cat] = now + cd * 1000;
    this.lastSayMs = now + (o.delay ?? 0) * 1000;
    this.shared.lastAnyMs = now;
    return true;
  }

  update(dt: number, now: number): void {
    const c = this.pet.controls;
    const dog = this.dog;

    // Petting: a happy noise as it starts, then panting / purring while it lasts.
    const p = Math.max(c.petHead, c.petBody);
    if (!this.petOn && p > 0.35) {
      this.petOn = true;
      this.petFor = 0;
      this.nextMurmur = now + rand(5, 9) * 1000;
      this.petStart();
    } else if (this.petOn && p < 0.12) {
      this.petOn = false;
      if (this.petFor > 2.5) this.petEnd();
    }
    if (this.petOn) {
      this.petFor += dt;
      if (now >= this.nextMurmur) {
        this.nextMurmur = now + rand(COOL.murmur, COOL.murmur * 1.8) * 1000;
        this.murmur();
      }
    }
    if (this.helloUntil && (now > this.helloUntil || !this.loading())) {
      if (now <= this.helloUntil) this.hello();
      this.helloUntil = 0;
    }

    // Tricks (also friends' pets: their snapshots carry the trick). Joined late: stay quiet.
    const tk = c.trick?.kind ?? null;
    if (tk !== this.trick) {
      this.trick = tk;
      if (tk && c.trick && c.trick.progress < 0.3) this.trickSounds(tk, c.trick.progress);
    }

    // Sniffing (the ground, a hand, another pet's nose).
    if (!this.sniffOn && c.sniff > 0.5 && !c.trick) {
      this.sniffOn = true;
      this.nextSniffMs = now + rand(100, 500);
    } else if (this.sniffOn && c.sniff < 0.3) {
      this.sniffOn = false;
    }
    if (this.sniffOn && now >= this.nextSniffMs) {
      this.nextSniffMs = now + rand(1.8, 3.5) * 1000;
      const n = 3 + Math.floor(Math.random() * 4);
      this.say("sniff", (s, t) => this.v.sniffs(s, t, n), { vol: dog ? 0.7 : 0.45 });
    }

    // Lying down: sometimes a sigh, and a yawn once it has been lying a while.
    if (!this.lying && c.lie > 0.7) {
      this.lying = true;
      this.lyingFor = 0;
      this.yawnAt = rand(20, 40);
      const groan = chance(0.5);
      if (chance(0.4)) this.say("lie", dog ? (s, t) => this.v.sigh(s, t, groan, 0.8) : (s, t) => this.v.trill(s, t, 0.5), { delay: 0.6 });
    } else if (this.lying && c.lie < 0.3) {
      this.lying = false;
    }
    if (this.lying && (this.lyingFor += dt) >= this.yawnAt) {
      this.yawnAt = Infinity;
      if (chance(0.55)) this.say("yawn", dog ? (s, t) => this.v.dogYawn(s, t) : (s, t) => this.v.meow(s, t, "yawn"));
    }

    // Breaking into a run while excited (coming when called, chasing): an excited bark / chirp.
    if (!this.running && c.gait.speed > 0.85) {
      this.running = true;
      if (c.excitement >= 0.5 && chance(0.35)) {
        const n = 1 + Math.floor(Math.random() * 2);
        this.say("run", dog ? (s, t) => this.v.barks(s, t, n, { pitch: 1.08 }) : (s, t) => this.v.chatter(s, t, 0.7));
      }
    } else if (this.running && c.gait.speed < 0.6) {
      this.running = false;
    }

    // Cats purr while petted; dogs pant while petted and for a few seconds after a trick (quiet
    // while they make another sound or someone is talking).
    if (dog) {
      const pant = ((this.petOn && this.petFor > 0.8) || now < this.pantAfterMs) && !c.trick && this.shots.size === 0 && !this.shared.hushed;
      this.updateLoop(dt, pant ? 1 : 0, 0.15, 0.25);
    } else {
      this.updateLoop(dt, this.petOn ? Math.max(0.6, clamp01(p * 1.1)) : clamp01((p - 0.1) / 0.5), 0.3, 0.6);
    }

    // Now and then, by itself.
    if (now >= this.nextIdleMs) {
      this.nextIdleMs = now + rand(IDLE_MIN, IDLE_MAX) * 1000 * (this.lying ? 2.2 : 1) * (c.excitement > 0.7 ? 0.6 : 1);
      if (!this.petOn && !c.trick && !this.sniffOn && now - this.lastSayMs > 4000) this.idle();
    }
  }

  /** The purr / panting loop towards `level` (0..1), started on demand and stopped once silent a while. */
  private updateLoop(dt: number, level: number, up: number, down: number) {
    if (level > 0.02 && audioReady()) {
      this.loop ??= this.v.loop(this.ac, this.bus);
      this.loop?.set(level, up, down);
      this.loopSilent = 0;
    } else if (this.loop) {
      this.loop.set(0, up, down);
      if ((this.loopSilent += dt) > LOOP_STOP_AFTER || !audioReady()) {
        this.loop.stop();
        this.loop = null;
      }
    }
  }

  private petStart() {
    if (this.dog) {
      this.say("pet", chance(0.55) ? (s, t) => this.v.whimper(s, t) : (s, t) => this.v.bark(s, t, { vol: 0.5, len: 0.8, pitch: 1.12 }), {
        force: true,
        vol: 0.8,
      });
    } else {
      this.say("pet", chance(0.55) ? (s, t) => this.v.trill(s, t, 0.8) : (s, t) => this.v.meow(s, t, "mew", 0.8), { force: true });
    }
  }

  private murmur() {
    if (this.dog) {
      this.say("murmur", chance(0.5) ? (s, t) => this.v.sigh(s, t, true, 0.7) : (s, t) => this.v.whine(s, t, { vol: 0.45, lift: 0.3 }));
    } else if (chance(0.35)) {
      this.say("murmur", (s, t) => this.v.trill(s, t, 0.45));
    }
  }

  private petEnd() {
    if (this.dog && chance(0.35)) this.say("murmur", (s, t) => this.v.sigh(s, t, false, 0.7), { delay: 0.3 });
    else if (!this.dog && chance(0.25)) this.say("murmur", (s, t) => this.v.meow(s, t, "mew", 0.6), { delay: 0.4 });
  }

  /** Sounds timed to the trick's animation (TRICK_DURATION), all in one shot. */
  private trickSounds(kind: TrickKind, progress: number) {
    const D = TRICK_DURATION[kind];
    const at = (u: number) => Math.max(0, (u - progress) * D);
    let r: Recipe;
    switch (kind) {
      case "jump": // "hup!" at take-off
        if (!chance(0.85)) return;
        r = (s, t) => this.v.bark(s, t + at(0.22), { pitch: 1.08, len: 0.9 });
        this.pantAfterMs = performance.now() + (D + 4) * 1000;
        break;
      case "spin": {
        // Excited yips while turning.
        const n = 2 + Math.floor(Math.random() * 2);
        r = (s, t) => {
          let end: number | null = null;
          for (let i = 0; i < n; i++) end = latest(end, this.v.bark(s, t + at(0.08 + i * 0.3) + rand(0, 0.08), { pitch: 1.3, len: 0.55, vol: 0.8 }));
          return end;
        };
        this.pantAfterMs = performance.now() + (D + 4) * 1000;
        break;
      }
      case "rollOver": // happy grumble going over, sometimes a bark back on its feet
        r = (s, t) => {
          const end = this.v.growl(s, t + at(0.1), 0.75);
          return chance(0.5) ? latest(end, this.v.bark(s, t + at(0.82), { pitch: 1.1 })) : end;
        };
        this.pantAfterMs = performance.now() + (D + 4) * 1000;
        break;
      case "pounce": // chatter while wiggling, a little "mrrp" on landing
        r = (s, t) => {
          const end = this.v.chatter(s, t + at(0.04), 0.7);
          return chance(0.5) ? latest(end, this.v.trill(s, Math.max(t + at(0.6), end ?? 0), 0.6)) : end;
        };
        break;
      case "stretch": // stretch-yawn
        r = (s, t) => this.v.meow(s, t + at(0.2), "yawn");
        break;
      case "groom":
        r = (s, t) => this.v.licks(s, t + at(0.15), 6 + Math.floor(Math.random() * 4), D * 0.6, 0.5);
        break;
    }
    this.say("trick", r, { force: true });
  }

  private idle() {
    const dog = this.dog;
    const fl = this.v.v.flavor;
    const x = Math.random();
    if (this.lying) {
      if (dog) this.say("idle", x < 0.6 ? (s, t) => this.v.sigh(s, t, true, 0.6) : (s, t) => this.v.whine(s, t, { vol: 0.4 }));
      else if (x < 0.6) this.say("idle", (s, t) => this.v.trill(s, t, 0.45));
      return;
    }
    if (dog) {
      const n = 1 + Math.floor(Math.random() * 2);
      if ((fl === "husky" && x < 0.3) || (fl === "beagle" && x < 0.2)) this.say("idle", (s, t) => this.v.howl(s, t, 0.8));
      else if (x < 0.55) this.say("idle", (s, t) => this.v.barks(s, t, n));
      else if (x < 0.75) this.say("idle", (s, t) => this.v.whine(s, t, { lift: 0.7 }));
      else if (x < 0.9) this.say("idle", (s, t) => this.v.huff(s, t));
      else this.say("idle", (s, t) => this.v.sigh(s, t, true, 0.7));
    } else {
      const trills = fl === "maineCoon" ? 0.5 : 0.25;
      const kind = chance(0.3) ? "long" : chance(0.4) ? "question" : "meow";
      if (x < trills) this.say("idle", (s, t) => this.v.trill(s, t));
      else if (x < 0.85) this.say("idle", (s, t) => this.v.meow(s, t, kind));
      else this.say("idle", (s, t) => this.v.meow(s, t, "mew"));
    }
  }

  // ---- Pushed in by dogPlay.ts / party.ts ----

  ack(cmd: DogCommand) {
    if (cmd in TRICK_DURATION) return; // the trick makes its own noise
    const o: SayOpts = { force: true, delay: 0.15 };
    if (this.dog) {
      if (cmd === "come" && chance(0.75)) this.say("cmd", chance(0.5) ? (s, t) => this.v.barks(s, t, 2, { pitch: 1.1 }) : (s, t) => this.v.whimper(s, t), o);
      else if (cmd === "sit" && chance(0.5)) this.say("cmd", chance(0.5) ? (s, t) => this.v.huff(s, t) : (s, t) => this.v.bark(s, t, { vol: 0.55, len: 0.7 }), o);
      else if (cmd === "lie" && chance(0.6)) this.say("cmd", (s, t) => this.v.sigh(s, t, true, 0.8), { ...o, delay: 0.9 });
      else if (chance(0.35)) this.say("cmd", (s, t) => this.v.huff(s, t, 0.8), o);
    } else {
      if (cmd === "come" && chance(0.8)) this.say("cmd", chance(0.5) ? (s, t) => this.v.trill(s, t) : (s, t) => this.v.meow(s, t, "question"), o);
      else if (cmd === "sit" && chance(0.35)) this.say("cmd", (s, t) => this.v.meow(s, t, "mew", 0.6), o);
      else if (cmd === "lie" && chance(0.35)) this.say("cmd", (s, t) => this.v.trill(s, t, 0.5), { ...o, delay: 0.8 });
      else if (chance(0.25)) this.say("cmd", (s, t) => this.v.meow(s, t, "mew", 0.55), o);
    }
  }

  /** Spoken to: sometimes a questioning "hm?". Never forced: held while a phrase is being heard. */
  perk() {
    if (!chance(0.3)) return;
    if (this.dog) this.say("perk", chance(0.5) ? (s, t) => this.v.huff(s, t, 0.6) : (s, t) => this.v.whine(s, t, { vol: 0.45, lift: 1 }));
    else this.say("perk", chance(0.5) ? (s, t) => this.v.meow(s, t, "question", 0.6) : (s, t) => this.v.trill(s, t, 0.55));
  }

  /** The recordings are still loading. */
  private loading(): boolean {
    return clips(this.dog ? "dog.bark.medium" : "cat.meow") === undefined;
  }

  /** Just placed: a greeting (placed while the clips are still loading: once they are, if soon enough). */
  hello() {
    if (this.loading()) {
      this.helloUntil = performance.now() + HELLO_RETRY_MS;
      return;
    }
    const o: SayOpts = { force: true, delay: 0.5 };
    if (this.dog) this.say("hello", chance(0.6) ? (s, t) => this.v.barks(s, t, 2) : (s, t) => this.v.whimper(s, t), o);
    else this.say("hello", chance(0.5) ? (s, t) => this.v.trill(s, t) : (s, t) => this.v.meow(s, t), o);
  }

  /** A meeting starts: the visitor calls out, the other answers a moment later. */
  greet(other: "dog" | "cat", visitor: boolean) {
    const o: SayOpts = { force: true, delay: visitor ? 0.2 : rand(1, 1.6) };
    let r: Recipe;
    if (this.dog) {
      if (other === "dog") r = visitor ? (s, t) => this.v.barks(s, t, 2, { pitch: 1.05 }) : chance(0.6) ? (s, t) => this.v.bark(s, t) : (s, t) => this.v.whimper(s, t);
      // A cat! Curious and excited, but polite: a whine, then a single bark.
      else
        r = (s, t) => {
          const w = this.v.whine(s, t, { vol: 0.8, lift: 0.9 });
          return latest(w, this.v.bark(s, (w ?? t) + 0.15, { vol: 0.7 }));
        };
    } else {
      if (other === "cat") r = (s, t) => this.v.trill(s, t);
      else r = (s, t) => this.v.meow(s, t, "wary"); // a dog: a short, wary meow
    }
    this.say("greet", r, o);
  }

  dispose() {
    this.loop?.stop();
    this.loop = null;
    for (const s of [...this.shots]) s.kill();
    this.bus.disconnect();
    this.panner.disconnect();
  }
}

export function createPetSounds(): PetSounds {
  const ac = audioContext();
  const out = audioOut();
  setAudioActive(true);
  if (ac) loadSamples(ac);
  const voices: PetVoice[] = [];
  const shared: Shared = { lastAnyMs: -Infinity, hushed: false };
  let own: PetVoice | null = null;
  let disposed = false;
  const pos = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();

  function petVoice(pet: PetCharacter): PetVoice | null {
    if (!ac || !out || disposed) return null;
    for (const v of voices) if (v.pet === pet) return v;
    const v = new PetVoice(pet, ac, out, shared);
    voices.push(v);
    return v;
  }

  function setEar(ear: Ear) {
    if (!ac) return;
    const l = ac.listener;
    const p = ear.position;
    fwd.set(0, 0, -1).applyQuaternion(ear.quaternion);
    up.set(0, 1, 0).applyQuaternion(ear.quaternion);
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = fwd.x;
      l.forwardY.value = fwd.y;
      l.forwardZ.value = fwd.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  return {
    update(dt, ownPet, others, ear) {
      if (disposed || !ac) return;
      for (const v of voices) v.seen = false;
      own = ownPet ? petVoice(ownPet) : null;
      if (own) own.seen = true;
      for (const pet of others) {
        const v = petVoice(pet);
        if (v) v.seen = true;
      }
      // Pets no longer shown (friend left, hidden, re-created) go quiet at once.
      for (let i = voices.length - 1; i >= 0; i--) {
        if (voices[i].seen) continue;
        voices[i].dispose();
        voices.splice(i, 1);
      }
      setEar(ear);
      const now = performance.now();
      for (const v of voices) {
        v.place(pos);
        v.update(dt, now);
      }
    },
    commanded(cmd) {
      own?.ack(cmd);
    },
    heard() {
      own?.perk();
    },
    placed(pet) {
      petVoice(pet)?.hello();
    },
    meet(a, b) {
      petVoice(a)?.greet(b.species, true);
      petVoice(b)?.greet(a.species, false);
    },
    setMic(listening, hearing) {
      setDuck(listening ? MIC_DUCK : 1);
      shared.hushed = hearing;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const v of voices) v.dispose();
      voices.length = 0;
      own = null;
      setDuck(1);
      setAudioActive(false);
    },
  };
}
