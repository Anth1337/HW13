import type { Shot } from "./shot";

/*
 * Procedural pet sounds: what's left of the synthesized voices now that the pets speak with real
 * recordings (vocals.ts). Used where there is no recording (cat sniffs, grooming licks) and as the
 * fallback for the core noises (barks, meows) when the recordings couldn't be loaded. Each recipe
 * builds a tiny one-shot graph inside a Shot, schedules it on the audio clock and returns when it
 * ends (the caller passes that to Shot.end(); several recipes may share one Shot, e.g. barks()).
 *
 * Vocal model, roughly source → filter like a real throat: a sawtooth (vocal folds) plus filtered
 * noise (breath) through a soft clip for rasp, then 2–3 band-pass "formants" gliding as the mouth
 * opens and closes. Tone.f0 (pitch) and Tone.fk (formant scale) come from the pet's size.
 */

export type Flavor = "none" | "husky" | "beagle" | "pug" | "siamese" | "persian" | "maineCoon";

/** One pet's synthesized voice, derived once from its species, breed and size (petSounds.ts voiceFor()). */
export type Tone = {
  species: "dog" | "cat";
  /** Fundamental of a bark / meow (Hz). */
  f0: number;
  /** Formant scale (1 = medium dog / average cat). */
  fk: number;
  /** 0 = tiny … 1 = big (bark length and loudness, sniff rate). */
  big: number;
  /** 0..1 roughness. */
  rasp: number;
  flavor: Flavor;
};

const R = (a: number, b: number) => a + Math.random() * (b - a);
const EPS = 0.0001;

let gritCurve: Float32Array<ArrayBuffer> | null = null;
/** tanh soft clip: rasp and extra harmonics. */
function grit(): Float32Array<ArrayBuffer> {
  if (!gritCurve) {
    gritCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) gritCurve[i] = Math.tanh(((i / 1023) * 2 - 1) * 2.2);
  }
  return gritCurve;
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
