import { noiseBuffer } from "./engine";

/*
 * Procedural pet voices (Web Audio only: no samples, nothing downloaded). Each recipe builds a
 * tiny one-shot graph inside a Shot, schedules it on the audio clock and returns when it ends
 * (the caller passes that to Shot.end(); several recipes may share one Shot, e.g. barks()).
 *
 * Vocal model, roughly source → filter like a real throat:
 *  - source: a sawtooth (vocal folds; rich in harmonics) plus filtered noise (breath), through a
 *    soft-clip waveshaper for rasp. Pitch contours are what make a bark a bark (sharp rise, fast
 *    drop) and a meow a meow (rise, hold, glide down).
 *  - filter: 2–3 band-pass "formants" whose centre frequencies glide during the sound: the mouth
 *    opening and closing. "Woof" = F1 opens then closes; "mee-ow" = F2 high ("ee") sweeping down
 *    while F1 opens ("ow"), with a low-passed, nasal "m" onset.
 *  - size: Tone.f0 (pitch) and Tone.fk (formant scale: a shorter vocal tract → higher formants)
 *    come from the pet's real-world size, so a pug yips and a shepherd woofs.
 * Phone speakers hardly reproduce anything under ~250 Hz, so low voices (big barks, growls, the
 * purr) keep their character in the harmonics and in the rhythm, not in a sub-bass fundamental.
 * Every recipe randomises pitch, length and formants a little: no two barks are identical.
 */

export type Flavor = "none" | "husky" | "beagle" | "pug" | "siamese" | "persian" | "maineCoon";

/** One pet's voice, derived once from its species, breed and size (petSounds.ts toneFor()). */
export type Tone = {
  species: "dog" | "cat";
  /** Fundamental of a bark / meow (Hz). */
  f0: number;
  /** Formant scale (1 = medium dog / average cat). */
  fk: number;
  /** 0 = tiny … 1 = big (for durations, panting rate, growl pitch). */
  big: number;
  /** 0..1 roughness. */
  rasp: number;
  flavor: Flavor;
};

const R = (a: number, b: number) => a + Math.random() * (b - a);
const EPS = 0.0001;

let gritCurve: Float32Array<ArrayBuffer> | null = null;
let pulseCurve: Float32Array<ArrayBuffer> | null = null;
/** tanh soft clip: rasp and extra harmonics. */
function grit(): Float32Array<ArrayBuffer> {
  if (!gritCurve) {
    gritCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) gritCurve[i] = Math.tanh(((i / 1023) * 2 - 1) * 2.2);
  }
  return gritCurve;
}
/** Sine → narrow positive pulses (purr / trill amplitude modulation). */
function pulse(): Float32Array<ArrayBuffer> {
  if (!pulseCurve) {
    pulseCurve = new Float32Array(512);
    for (let i = 0; i < 512; i++) pulseCurve[i] = Math.max(0, (i / 511) * 2 - 1) ** 2.5;
  }
  return pulseCurve;
}

/**
 * One sound's nodes: sources start and stop together; when they end, the output disconnects and
 * `onDone` runs (the caller's voice count). Everything else is garbage collected with it.
 */
export class Shot {
  readonly out: GainNode;
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private done = false;

  constructor(
    readonly ac: BaseAudioContext,
    dest: AudioNode,
    vol: number,
    private readonly onDone: () => void,
  ) {
    this.out = ac.createGain();
    this.out.gain.value = vol;
    this.out.connect(dest);
  }

  osc(type: OscillatorType, f: number, t: number): OscillatorNode {
    const o = this.ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.start(t);
    this.srcs.push(o);
    return o;
  }

  noise(t: number): AudioBufferSourceNode {
    const n = this.ac.createBufferSource();
    n.buffer = noiseBuffer(this.ac);
    n.loop = true;
    n.start(t, Math.random() * 1.8);
    this.srcs.push(n);
    return n;
  }

  filter(type: BiquadFilterType, f: number, q: number): BiquadFilterNode {
    const b = this.ac.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  gain(v: number): GainNode {
    const g = this.ac.createGain();
    g.gain.value = v;
    return g;
  }

  shaper(curve: Float32Array<ArrayBuffer>): WaveShaperNode {
    const w = this.ac.createWaveShaper();
    w.curve = curve;
    return w;
  }

  /** Stops every source at `t` (a recipe's return value) and cleans up after the last one. */
  end(t: number): number {
    if (!this.srcs.length) {
      this.finish();
      return t;
    }
    for (const s of this.srcs) s.stop(t);
    this.srcs[0].onended = () => this.finish();
    return t;
  }

  /** Cut short (pet gone / session over). */
  kill(): void {
    for (const s of this.srcs) {
      try {
        s.stop();
      } catch {
        /* not started / already stopped */
      }
    }
    this.finish();
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    this.out.disconnect();
    this.onDone();
  }
}

/** Piecewise-linear automation through [fraction of len, value] points, starting at t. */
function glide(p: AudioParam, t: number, len: number, pts: readonly (readonly [number, number])[]) {
  p.setValueAtTime(pts[0][1], t);
  for (let i = 1; i < pts.length; i++) p.linearRampToValueAtTime(pts[i][1], t + pts[i][0] * len);
}

/** Parallel band-pass formants from `input` into one sum (returned with the filters to automate). */
function formants(s: Shot, input: AudioNode, specs: readonly [f: number, q: number, g: number][]) {
  const sum = s.gain(1);
  const bands = specs.map(([f, q, g]) => {
    const b = s.filter("bandpass", f, q);
    const gn = s.gain(g);
    input.connect(b).connect(gn).connect(sum);
    return b;
  });
  return { sum, bands };
}

function vibrato(s: Shot, target: AudioParam, t: number, rate: number, depth: number) {
  const lfo = s.osc("sine", rate, t);
  const d = s.gain(depth);
  lfo.connect(d).connect(target);
}

// ---- Dog ---------------------------------------------------------------------------------

export type BarkOpts = { pitch?: number; len?: number; vol?: number };

/** One bark: a ~0.1 s yip (small dogs) to a ~0.25 s woof (big ones). */
export function bark(s: Shot, t: number, tone: Tone, o: BarkOpts = {}): number {
  const f0 = tone.f0 * (o.pitch ?? 1) * R(0.93, 1.07);
  const k = tone.fk * R(0.95, 1.05);
  const len = (0.085 + 0.16 * tone.big) * (o.len ?? 1) * R(0.85, 1.15);
  const peak = t + 0.012 + len * 0.18;

  const saw = s.osc("sawtooth", f0 * 0.78, t);
  saw.frequency.linearRampToValueAtTime(f0 * R(1.1, 1.2), peak);
  saw.frequency.exponentialRampToValueAtTime(f0 * R(0.62, 0.72), t + len);
  const voiced = s.gain(0);
  voiced.gain.setValueAtTime(EPS, t);
  voiced.gain.linearRampToValueAtTime(1.6 + tone.rasp, t + 0.008);
  voiced.gain.setTargetAtTime(0, t + len * 0.4, len * 0.22);
  saw.connect(voiced);

  // Breath: a burst of noise that outlasts the voice a little (the "f" of "woof").
  const nz = s.noise(t);
  const breath = s.gain(0);
  breath.gain.setValueAtTime(EPS, t);
  breath.gain.linearRampToValueAtTime(0.35 + 0.35 * tone.rasp, t + 0.01);
  breath.gain.setTargetAtTime(0, t + len * 0.55, len * 0.3);
  nz.connect(s.filter("bandpass", 1400 * k, 0.8)).connect(breath);

  const mix = s.gain(1);
  voiced.connect(mix);
  breath.connect(mix);
  const { sum, bands } = formants(s, mix.connect(s.shaper(grit())), [
    [500 * k, 3.5, 1],
    [1400 * k, 5, 0.55],
    [2700 * k, 6, 0.25],
  ]);
  glide(bands[0].frequency, t, len, [[0, 330 * k], [0.3, 820 * k], [1, 480 * k]]);
  glide(bands[1].frequency, t, len, [[0, 1150 * k], [0.3, 1650 * k], [1, 1200 * k]]);
  sum.connect(s.gain((o.vol ?? 1) * (1 + 0.45 * tone.big))).connect(s.out); // big dogs are louder
  return t + len + 0.3;
}

/** n barks in a row ("woof woof"), each a bit different; returns the end time. */
export function barks(s: Shot, t: number, tone: Tone, n: number, o: BarkOpts = {}): number {
  let end = t;
  let at = t;
  for (let i = 0; i < n; i++) {
    end = bark(s, at, tone, { ...o, pitch: (o.pitch ?? 1) * (1 + (i === n - 1 ? -0.04 : 0.03) * Math.random()) });
    at += (0.17 + 0.2 * tone.big) * (o.len ?? 1) * R(0.9, 1.3);
  }
  return end;
}

export type WhineOpts = { len?: number; vol?: number; pitch?: number; /** 0..1: how much it rises at the end (happy / asking). */ lift?: number };

/** A nasal whine: a high glide with vibrato. Short ones in a row are a happy whimper. */
export function whine(s: Shot, t: number, tone: Tone, o: WhineOpts = {}): number {
  const fw = (1350 - 600 * tone.big) * (o.pitch ?? 1) * R(0.9, 1.1);
  const len = (o.len ?? 0.7) * R(0.85, 1.15);
  const lift = o.lift ?? 0.5;
  const tri = s.osc("triangle", fw, t);
  const pts: [number, number][] = [[0, fw * 0.82], [0.35, fw * 1.18], [0.7, fw * 0.95], [1, fw * (0.9 + 0.35 * lift)]];
  glide(tri.frequency, t, len, pts);
  vibrato(s, tri.frequency, t, R(5, 7), fw * 0.025);
  const over = s.osc("sine", fw * 2, t); // nasal brightness
  glide(over.frequency, t, len, pts.map(([u, f]) => [u, f * 2] as [number, number]));
  const og = s.gain(0.22);
  over.connect(og);

  const env = s.gain(0);
  env.gain.setValueAtTime(EPS, t);
  env.gain.linearRampToValueAtTime(0.36 * (o.vol ?? 1), t + 0.06);
  env.gain.linearRampToValueAtTime(0.46 * (o.vol ?? 1), t + len * 0.5);
  env.gain.setTargetAtTime(0, t + len - 0.1, 0.04);
  const nasal = s.filter("bandpass", 1600 * tone.fk, 1.4);
  tri.connect(nasal);
  og.connect(nasal);
  const body = s.filter("lowpass", 3200, 0.7);
  tri.connect(body);
  const mix = s.gain(1);
  nasal.connect(mix);
  body.connect(s.gain(0.35)).connect(mix);
  mix.connect(env).connect(s.out);
  return t + len + 0.25;
}

/** 2–3 short climbing whines: "hnn-hnn-hnn!" (happy / greeting). */
export function whimpers(s: Shot, t: number, tone: Tone, n = 2 + Math.floor(Math.random() * 2)): number {
  let at = t;
  let end = t;
  for (let i = 0; i < n; i++) {
    const len = R(0.16, 0.28);
    end = whine(s, at, tone, { len, pitch: 1 + i * 0.07, vol: 0.75, lift: 0.8 });
    at += len + R(0.06, 0.12);
  }
  return end;
}

/** Panting for about `seconds`: alternating exhale / inhale noise through a mouth formant. */
export function pant(s: Shot, t: number, tone: Tone, seconds: number): number {
  const rate = R(0.92, 1.08) * (4.2 - 1.8 * tone.big); // cycles per second
  const n = Math.max(1, Math.round(seconds * rate));
  const half = 0.5 / rate;
  const nz = s.noise(t);
  const mouth = s.filter("bandpass", 1100 * tone.fk, 1.3);
  const hiss = s.filter("bandpass", 2500 * tone.fk, 2);
  const env = s.gain(0);
  nz.connect(mouth).connect(env);
  nz.connect(hiss).connect(s.gain(0.35)).connect(env);
  env.connect(s.out);
  env.gain.setValueAtTime(0, t);
  let at = t;
  for (let i = 0; i < n; i++) {
    const a = R(0.7, 1);
    env.gain.setTargetAtTime(0.9 * a, at, 0.012); // exhale ("hah")
    env.gain.setTargetAtTime(0.04, at + half * 0.45, 0.04);
    mouth.frequency.setValueAtTime(1000 * tone.fk * R(0.95, 1.05), at);
    env.gain.setTargetAtTime(0.38 * a, at + half, 0.015); // inhale, softer and brighter
    env.gain.setTargetAtTime(0, at + half * 1.5, 0.035);
    mouth.frequency.setValueAtTime(1450 * tone.fk, at + half);
    at += (1 / rate) * R(0.92, 1.08);
  }
  return at + 0.1;
}

/** Quick inhaled sniffs (snf-snf-snf), sometimes with a little "pff" out. */
export function sniffs(s: Shot, t: number, tone: Tone, n: number, vol = 1): number {
  const cat = tone.species === "cat";
  const nz = s.noise(t);
  const nf = (cat ? 5200 : 3600) * Math.sqrt(tone.fk);
  const nose = s.filter("bandpass", nf, 1.1);
  const env = s.gain(0);
  nz.connect(s.filter("highpass", 1600, 0.7)).connect(nose).connect(env).connect(s.out);
  env.gain.setValueAtTime(0, t);
  let at = t;
  const gap = cat ? 0.065 : 0.085 + 0.03 * tone.big;
  for (let i = 0; i < n; i++) {
    env.gain.setTargetAtTime(0.8 * vol * R(0.6, 1), at, 0.005);
    env.gain.setTargetAtTime(0, at + R(0.025, 0.04), 0.016);
    nose.frequency.setValueAtTime(nf * R(0.92, 1.08), at);
    at += gap * R(0.85, 1.25);
  }
  if (Math.random() < 0.5) {
    // Exhale through the nose: lower, softer, longer.
    const out = s.gain(0);
    nz.connect(s.filter("lowpass", 1100, 0.7)).connect(out).connect(s.out);
    out.gain.setValueAtTime(0, at);
    out.gain.setTargetAtTime(0.55 * vol, at + 0.02, 0.02);
    out.gain.setTargetAtTime(0, at + 0.09, 0.05);
    at += 0.25;
  }
  return at + 0.1;
}

/** Play growl / happy grumble: a low buzz fluttering ~25 times a second, rising and falling. */
export function growl(s: Shot, t: number, tone: Tone, len = 0.7, vol = 1): number {
  const fg = (85 + 120 * (1 - tone.big)) * R(0.92, 1.08);
  len *= R(0.85, 1.2);
  const saw = s.osc("sawtooth", fg, t);
  glide(saw.frequency, t, len, [[0, fg * 0.95], [0.4, fg * 1.15], [1, fg * 0.9]]);
  const nz = s.noise(t);
  const am = s.gain(0.1);
  const flutter = s.osc("sine", R(22, 30), t);
  vibrato(s, flutter.frequency, t, R(2, 4), 5); // irregular flutter
  flutter.connect(s.shaper(pulse())).connect(am.gain);
  saw.connect(am);
  nz.connect(s.filter("bandpass", 650 * tone.fk, 1)).connect(s.gain(0.4)).connect(am);
  const { sum } = formants(s, am.connect(s.shaper(grit())), [
    [450 * tone.fk, 2, 1],
    [1100 * tone.fk, 3, 0.4],
  ]);
  const env = s.gain(0);
  env.gain.setValueAtTime(EPS, t);
  env.gain.linearRampToValueAtTime(0.9 * vol, t + 0.08);
  env.gain.linearRampToValueAtTime(0.55 * vol, t + len * 0.45); // "grr-rrr"
  env.gain.linearRampToValueAtTime(0.85 * vol, t + len * 0.6);
  env.gain.setTargetAtTime(0, t + len - 0.08, 0.05);
  sum.connect(env).connect(s.out);
  return t + len + 0.3;
}

/** Contented sigh ("hmmmf"), optionally voiced like a little groan. */
export function sigh(s: Shot, t: number, tone: Tone, groan = false, vol = 1): number {
  const len = R(0.6, 0.9);
  const nz = s.noise(t);
  const lp = s.filter("lowpass", 2000 * tone.fk, 0.8);
  glide(lp.frequency, t, len, [[0, 1800 * tone.fk], [1, 420 * tone.fk]]);
  const env = s.gain(0);
  env.gain.setValueAtTime(EPS, t);
  env.gain.linearRampToValueAtTime(0.7 * vol, t + 0.14);
  env.gain.setTargetAtTime(0, t + 0.2, len * 0.35);
  nz.connect(lp).connect(env).connect(s.out);
  if (groan) {
    const f = (130 + 160 * (1 - tone.big)) * R(0.9, 1.1);
    const v = s.osc("sawtooth", f, t);
    glide(v.frequency, t, len, [[0, f], [0.5, f * 1.08], [1, f * 0.8]]);
    const g = s.gain(0);
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(0.3 * vol, t + 0.1);
    g.gain.setTargetAtTime(0, t + len * 0.45, 0.12);
    v.connect(s.filter("lowpass", 650 * tone.fk, 1.5)).connect(g).connect(s.out);
  }
  return t + len + 0.6;
}

/** A short nose huff ("pff"): acknowledging, mildly interested. */
export function huff(s: Shot, t: number, tone: Tone, vol = 1): number {
  const nz = s.noise(t);
  const env = s.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.setTargetAtTime(0.75 * vol, t, 0.008);
  env.gain.setTargetAtTime(0, t + 0.05, 0.035);
  nz.connect(s.filter("bandpass", 950 * tone.fk, 0.9)).connect(env).connect(s.out);
  return t + 0.3;
}

/** Talking husky / baying beagle "a-woo": a long sung vowel from "w" through "a" to "oo". */
export function howl(s: Shot, t: number, tone: Tone, len = 1.1, vol = 1): number {
  const f = tone.f0 * 1.5 * R(0.92, 1.08);
  len *= R(0.85, 1.2);
  const saw = s.osc("sawtooth", f, t);
  glide(saw.frequency, t, len, [[0, f * 0.72], [0.25, f * 1.08], [0.7, f], [1, f * 0.82]]);
  vibrato(s, saw.frequency, t, R(4.5, 6), f * 0.02);
  const { sum, bands } = formants(s, saw, [
    [500, 4, 1],
    [1000, 5, 0.5],
    [2600, 6, 0.15],
  ]);
  const k = tone.fk;
  glide(bands[0].frequency, t, len, [[0, 420 * k], [0.25, 780 * k], [1, 380 * k]]);
  glide(bands[1].frequency, t, len, [[0, 850 * k], [0.25, 1300 * k], [1, 800 * k]]);
  const env = s.gain(0);
  env.gain.setValueAtTime(EPS, t);
  vol *= 1 + 0.5 * tone.big;
  env.gain.linearRampToValueAtTime(0.6 * vol, t + 0.12);
  env.gain.linearRampToValueAtTime(0.8 * vol, t + len * 0.3);
  env.gain.setTargetAtTime(0, t + len - 0.15, 0.07);
  sum.connect(env).connect(s.out);
  return t + len + 0.4;
}

/** Dog yawn: a squeaky rising-then-falling whine with the mouth opening wide, then a soft jaw clack. */
export function dogYawn(s: Shot, t: number, tone: Tone): number {
  const len = R(0.9, 1.3);
  const fw = (900 - 350 * tone.big) * R(0.9, 1.1);
  const tri = s.osc("sawtooth", fw, t);
  glide(tri.frequency, t, len, [[0, fw * 0.8], [0.3, fw * 1.35], [0.75, fw * 0.9], [1, fw * 0.5]]);
  const lp = s.filter("lowpass", 800, 1.2);
  glide(lp.frequency, t, len, [[0, 700 * tone.fk], [0.35, 3200 * tone.fk], [1, 500 * tone.fk]]);
  const env = s.gain(0);
  env.gain.setValueAtTime(EPS, t);
  env.gain.linearRampToValueAtTime(0.35, t + 0.15);
  env.gain.linearRampToValueAtTime(0.45, t + len * 0.4);
  env.gain.setTargetAtTime(0, t + len * 0.85, 0.06);
  tri.connect(lp).connect(env).connect(s.out);
  const nz = s.noise(t);
  const breath = s.gain(0);
  breath.gain.setValueAtTime(EPS, t);
  breath.gain.linearRampToValueAtTime(0.25, t + len * 0.4);
  breath.gain.setTargetAtTime(0, t + len * 0.8, 0.08);
  nz.connect(s.filter("bandpass", 1500 * tone.fk, 0.8)).connect(breath).connect(s.out);
  // Jaw clack.
  const clack = s.gain(0);
  clack.gain.setValueAtTime(0, t + len);
  clack.gain.setTargetAtTime(0.6, t + len, 0.002);
  clack.gain.setTargetAtTime(0, t + len + 0.008, 0.006);
  nz.connect(s.filter("bandpass", 2200, 2)).connect(clack).connect(s.out);
  return t + len + 0.25;
}

// ---- Cat ---------------------------------------------------------------------------------

export type MeowKind = "mew" | "meow" | "question" | "wary" | "yawn" | "long";
type Pts = readonly (readonly [number, number])[];

/** Pitch (× f0), F1 / F2 (Hz before fk) contours and length (s) per kind of meow. */
const MEOWS: Record<MeowKind, { len: number; pitch: Pts; f1: Pts; f2: Pts; vol: number }> = {
  mew: { len: 0.3, vol: 0.8, pitch: [[0, 1.08], [0.35, 1.22], [1, 1.0]], f1: [[0, 500], [0.4, 900], [1, 650]], f2: [[0, 2300], [0.4, 2200], [1, 1500]] },
  meow: {
    len: 0.62,
    vol: 1,
    pitch: [[0, 0.88], [0.3, 1.15], [0.55, 1.06], [1, 0.78]],
    f1: [[0, 420], [0.22, 820], [0.6, 1050], [1, 600]],
    f2: [[0, 1900], [0.22, 2600], [0.6, 1700], [1, 1000]],
  },
  question: {
    len: 0.5,
    vol: 0.9,
    pitch: [[0, 0.85], [0.45, 0.95], [1, 1.3]],
    f1: [[0, 450], [0.3, 700], [1, 1000]],
    f2: [[0, 1400], [0.3, 1800], [1, 2100]],
  },
  wary: { len: 0.32, vol: 0.55, pitch: [[0, 0.86], [0.4, 0.94], [1, 0.8]], f1: [[0, 480], [0.4, 800], [1, 560]], f2: [[0, 1700], [0.4, 1900], [1, 1200]] },
  yawn: {
    len: 1.05,
    vol: 0.55,
    pitch: [[0, 0.72], [0.35, 1.3], [0.8, 0.92], [1, 0.55]],
    f1: [[0, 400], [0.35, 1250], [0.8, 900], [1, 450]],
    f2: [[0, 1500], [0.35, 1900], [0.8, 1300], [1, 900]],
  },
  long: {
    len: 0.95,
    vol: 1,
    pitch: [[0, 0.85], [0.25, 1.12], [0.7, 1.04], [1, 0.72]],
    f1: [[0, 420], [0.2, 850], [0.7, 1050], [1, 550]],
    f2: [[0, 2000], [0.2, 2600], [0.7, 1600], [1, 950]],
  },
};

/** "Mee-ow": nasal onset, rising pitch on the "ee", a long glide down as the mouth opens and closes. */
export function meow(s: Shot, t: number, tone: Tone, kind: MeowKind = "meow", vol = 1): number {
  const m = MEOWS[kind];
  const f0 = tone.f0 * R(0.9, 1.1);
  const len = m.len * R(0.82, 1.2) * (tone.flavor === "siamese" ? 1.25 : tone.flavor === "persian" ? 0.85 : 1);
  const k = tone.fk * R(0.95, 1.05);
  const pitch = m.pitch.map(([u, p]) => [u, f0 * p] as const);

  const a = s.osc("sawtooth", f0, t);
  const b = s.osc("sawtooth", f0, t);
  b.detune.value = R(6, 12);
  glide(a.frequency, t, len, pitch);
  glide(b.frequency, t, len, pitch);
  vibrato(s, a.frequency, t, R(5, 6.5), f0 * 0.012);
  const src = s.gain(1.2 + tone.rasp);
  a.connect(src);
  b.connect(s.gain(0.5)).connect(src);
  const nz = s.noise(t);
  nz.connect(s.filter("bandpass", 3000, 0.7)).connect(s.gain(0.06 + 0.25 * tone.rasp + (kind === "yawn" ? 0.25 : 0))).connect(src);

  const { sum, bands } = formants(s, src.connect(s.shaper(grit())), [
    [800 * k, 5, 1],
    [2000 * k, 7, 0.7],
    [3600 * k, 8, 0.28],
  ]);
  glide(bands[0].frequency, t, len, m.f1.map(([u, f]) => [u, f * k] as const));
  glide(bands[1].frequency, t, len, m.f2.map(([u, f]) => [u, f * k] as const));
  // The "m": lips closed at first (low-passed), open, then closing into the "w" at the end.
  const lips = s.filter("lowpass", 900, 0.7);
  glide(lips.frequency, t, len, [[0, 800], [0.15, 5500], [0.85, 4200], [1, kind === "question" ? 4000 : 1300]]);
  const env = s.gain(0);
  const v = m.vol * vol * (tone.flavor === "siamese" ? 1.15 : tone.flavor === "persian" ? 0.8 : 1);
  env.gain.setValueAtTime(EPS, t);
  env.gain.linearRampToValueAtTime(0.3 * v, t + 0.05);
  env.gain.linearRampToValueAtTime(v, t + len * 0.22);
  env.gain.linearRampToValueAtTime(0.75 * v, t + len * 0.8);
  env.gain.linearRampToValueAtTime(0, t + len);
  sum.connect(lips).connect(env).connect(s.out);
  return t + len + 0.15;
}

/** Rolled "brrrp↑" greeting trill. */
export function trill(s: Shot, t: number, tone: Tone, vol = 1, len = R(0.2, 0.34)): number {
  const f = tone.f0 * R(0.9, 1.05);
  const saw = s.osc("sawtooth", f, t);
  glide(saw.frequency, t, len, [[0, f * 0.82], [0.6, f], [1, f * R(1.25, 1.45)]]);
  const am = s.gain(0.25);
  const roll = s.osc("sine", R(26, 34), t);
  roll.connect(s.shaper(pulse())).connect(s.gain(0.75)).connect(am.gain);
  saw.connect(am);
  const { sum, bands } = formants(s, am, [
    [700 * tone.fk, 4, 1],
    [1700 * tone.fk, 5, 0.6],
  ]);
  glide(bands[0].frequency, t, len, [[0, 500 * tone.fk], [1, 900 * tone.fk]]);
  const env = s.gain(0);
  env.gain.setValueAtTime(EPS, t);
  env.gain.linearRampToValueAtTime(1.7 * vol, t + 0.03);
  env.gain.setTargetAtTime(0, t + len - 0.04, 0.025);
  sum.connect(s.filter("lowpass", 3500, 0.7)).connect(env).connect(s.out);
  return t + len + 0.15;
}

/** "Ek-ek-ek" chirps (watching prey, pouncing). */
export function chirps(s: Shot, t: number, tone: Tone, n: number, vol = 1): number {
  const o = s.osc("sawtooth", 1000, t);
  const env = s.gain(0);
  env.gain.setValueAtTime(0, t);
  let at = t;
  const f = tone.f0 * 1.8;
  for (let i = 0; i < n; i++) {
    o.frequency.setValueAtTime(f * R(0.9, 1.05), at);
    o.frequency.linearRampToValueAtTime(f * R(1.35, 1.55), at + 0.055);
    env.gain.setTargetAtTime(1.1 * vol, at, 0.006);
    env.gain.setTargetAtTime(0, at + 0.04, 0.015);
    at += R(0.09, 0.13);
  }
  o.connect(s.filter("bandpass", 1900 * tone.fk, 2.5)).connect(env).connect(s.out);
  return at + 0.1;
}

/** Tongue rasps while grooming, `n` licks spread over `span` seconds. */
export function licks(s: Shot, t: number, n: number, span: number, vol = 1): number {
  const nz = s.noise(t);
  const bp = s.filter("bandpass", 2600, 1.6);
  const env = s.gain(0);
  nz.connect(bp).connect(env).connect(s.out);
  env.gain.setValueAtTime(0, t);
  let at = t;
  for (let i = 0; i < n; i++) {
    bp.frequency.setValueAtTime(1800, at);
    bp.frequency.linearRampToValueAtTime(R(3800, 4800), at + 0.07);
    env.gain.setTargetAtTime(0.55 * vol * R(0.6, 1), at, 0.008);
    env.gain.setTargetAtTime(0, at + 0.05, 0.02);
    at += (span / n) * R(0.7, 1.3);
  }
  return at + 0.15;
}

/**
 * The purr: a loop that runs while a cat is petted. A train of glottal pulses at ~25 Hz (a
 * sawtooth through a low band-pass, plus noise amplitude-modulated by narrow pulses at the same
 * rate), its rate and loudness breathing in and out every ~2 s. `set(level)` fades it; the
 * owner stops it after it has been silent for a while.
 */
export class Purr {
  private readonly level: GainNode;
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private stopped = false;

  constructor(
    private readonly ac: BaseAudioContext,
    dest: AudioNode,
    tone: Tone,
  ) {
    const t = ac.currentTime;
    const rate = (24 + 5 * (1 - tone.big)) * R(0.95, 1.05);
    const osc = (type: OscillatorType, f: number) => {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.start(t);
      this.srcs.push(o);
      return o;
    };
    const gain = (v: number) => {
      const g = ac.createGain();
      g.gain.value = v;
      return g;
    };
    const filter = (type: BiquadFilterType, f: number, q: number) => {
      const b = ac.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };

    this.level = gain(0);
    this.level.connect(dest);
    const breathAmp = gain(0.72); // 0.72 ± 0.28: louder on the exhale
    const body = filter("lowpass", 1300, 0.6);
    body.connect(breathAmp).connect(this.level);

    const buzz = osc("sawtooth", rate);
    buzz.connect(filter("bandpass", 260 * tone.fk, 1.1)).connect(gain(1.1)).connect(body);
    const pulses = osc("sine", rate);
    const am = gain(0.06);
    const shaper = ac.createWaveShaper();
    shaper.curve = pulse();
    pulses.connect(shaper).connect(am.gain);
    const nz = ac.createBufferSource();
    nz.buffer = noiseBuffer(ac);
    nz.loop = true;
    nz.start(t, Math.random() * 1.8);
    this.srcs.push(nz);
    nz.connect(filter("bandpass", 420 * tone.fk, 0.9)).connect(am).connect(gain(1.6)).connect(body);

    const breath = osc("sine", R(0.42, 0.55));
    const fm = gain(rate * 0.07);
    breath.connect(fm);
    fm.connect(buzz.frequency);
    fm.connect(pulses.frequency);
    breath.connect(gain(0.28)).connect(breathAmp.gain);
  }

  /** Fade towards `v` (0..1): quick in, slow out. */
  set(v: number): void {
    if (this.stopped) return;
    const now = this.ac.currentTime;
    this.level.gain.setTargetAtTime(v * 0.75, now, v > this.level.gain.value ? 0.3 : 0.6);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const s of this.srcs) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.level.disconnect();
  }
}
