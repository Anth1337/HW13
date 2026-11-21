import type { Sex } from "../dog/types";
import type { CatBreed, CatBreedPreset, CatCoatPattern, CatConfig, CatEarStyle, CatTailStyle } from "./types";

/*
 * Cat breed presets, the random "dice" config and validation. Plain data, mirrors src/dog/config.ts;
 * the 3D proportions per breed live in src/models/cat.ts. Persistence is src/pets.ts.
 */

type Defaults = CatBreedPreset["defaults"];

function defaults(
  coat: Defaults["coat"],
  face: Partial<Defaults["face"]> & Pick<Defaults["face"], "earStyle">,
  tail: CatTailStyle,
  extra: Partial<Pick<Defaults, "build" | "legLength" | "size">> = {},
): Defaults {
  return {
    size: extra.size ?? 0.5,
    build: extra.build ?? 0.5,
    legLength: extra.legLength ?? 0.5,
    coat,
    face: {
      muzzle: 0.5,
      eyeSize: 0.5,
      eyeColor: "#a7b03a",
      noseColor: "#c97a6e",
      whiskers: true,
      ...face,
    },
    tail,
    collar: { enabled: true, color: "#c0392b", bell: true },
  };
}

export const CAT_BREEDS: CatBreedPreset[] = [
  {
    breed: "shorthair",
    label: "Domestic shorthair",
    heightRange: [0.22, 0.27],
    defaults: defaults({ primary: "#8a6a4a", secondary: "#3a2a1e", pattern: "tabby", fluff: 0.2 }, { earStyle: "upright", muzzle: 0.45, eyeColor: "#9bb046" }, "long"),
    coatSwatches: [
      { primary: "#8a6a4a", secondary: "#3a2a1e", label: "Brown tabby" },
      { primary: "#d98a3d", secondary: "#a8561f", label: "Orange tabby" },
      { primary: "#8d9196", secondary: "#55595e", label: "Grey" },
      { primary: "#1e1c1c", secondary: "#121010", label: "Black" },
      { primary: "#f3f0ea", secondary: "#e3ddd2", label: "White" },
    ],
  },
  {
    breed: "siamese",
    label: "Siamese",
    heightRange: [0.22, 0.28],
    defaults: defaults(
      { primary: "#efe4cf", secondary: "#3b2a22", pattern: "colorpoint", fluff: 0.08 },
      { earStyle: "large", muzzle: 0.85, eyeColor: "#5aa6e0", noseColor: "#3b2a22" },
      "long",
      { build: 0.25, legLength: 0.6 },
    ),
    coatSwatches: [
      { primary: "#efe4cf", secondary: "#3b2a22", label: "Seal point" },
      { primary: "#ecebe6", secondary: "#6f7a88", label: "Blue point" },
      { primary: "#f3efe9", secondary: "#a89ca0", label: "Lilac point" },
      { primary: "#f1e7d4", secondary: "#6b4a35", label: "Chocolate point" },
      { primary: "#f4e8d6", secondary: "#d98a4a", label: "Flame point" },
    ],
  },
  {
    breed: "maineCoon",
    label: "Maine Coon",
    heightRange: [0.26, 0.36],
    defaults: defaults(
      { primary: "#7a5a3c", secondary: "#2e2219", pattern: "tabby", fluff: 0.8 },
      { earStyle: "tufted", muzzle: 0.6, eyeColor: "#c9a03a", noseColor: "#a0604e" },
      "plume",
      { build: 0.6 },
    ),
    coatSwatches: [
      { primary: "#7a5a3c", secondary: "#2e2219", label: "Brown tabby" },
      { primary: "#c8743a", secondary: "#8a4420", label: "Red tabby" },
      { primary: "#b8bcc0", secondary: "#3a3d42", label: "Silver tabby" },
      { primary: "#1e1c1c", secondary: "#141212", label: "Black" },
      { primary: "#e8cfa6", secondary: "#c9a77a", label: "Cream" },
    ],
  },
  {
    breed: "persian",
    label: "Persian",
    heightRange: [0.2, 0.26],
    defaults: defaults(
      { primary: "#f3f0ea", secondary: "#e3ddd2", pattern: "solid", fluff: 1 },
      { earStyle: "upright", muzzle: 0.03, eyeSize: 0.75, eyeColor: "#c8742f", noseColor: "#d48a8a" },
      "plume",
      { build: 0.7, legLength: 0.35 },
    ),
    coatSwatches: [
      { primary: "#f3f0ea", secondary: "#e3ddd2", label: "White" },
      { primary: "#e8d2ad", secondary: "#d6b98a", label: "Cream" },
      { primary: "#9a9da3", secondary: "#7a7d83", label: "Grey" },
      { primary: "#1e1c1c", secondary: "#141212", label: "Black" },
      { primary: "#cf7d3c", secondary: "#a8561f", label: "Red" },
    ],
  },
  {
    breed: "british",
    label: "British Shorthair",
    heightRange: [0.24, 0.3],
    defaults: defaults(
      { primary: "#8a9099", secondary: "#6d737c", pattern: "solid", fluff: 0.35 },
      { earStyle: "upright", muzzle: 0.3, eyeSize: 0.65, eyeColor: "#d39a35", noseColor: "#5a6068" },
      "long",
      { build: 0.8 },
    ),
    coatSwatches: [
      { primary: "#8a9099", secondary: "#6d737c", label: "Blue" },
      { primary: "#b3a6a8", secondary: "#958889", label: "Lilac" },
      { primary: "#e8cfa6", secondary: "#c9a77a", label: "Cream" },
      { primary: "#1e1c1c", secondary: "#141212", label: "Black" },
      { primary: "#c2c5c8", secondary: "#3c3f44", label: "Silver" },
    ],
  },
  {
    breed: "sphynx",
    label: "Sphynx",
    heightRange: [0.22, 0.27],
    defaults: defaults(
      { primary: "#e8c4b0", secondary: "#b08a7a", pattern: "solid", fluff: 0 },
      { earStyle: "large", muzzle: 0.55, eyeColor: "#8fb84a", noseColor: "#d49a8e" },
      "long",
      { build: 0.45 },
    ),
    coatSwatches: [
      { primary: "#e8c4b0", secondary: "#b08a7a", label: "Pink" },
      { primary: "#a9a3a6", secondary: "#7d777a", label: "Grey" },
      { primary: "#6e5a55", secondary: "#4a3c38", label: "Dark" },
      { primary: "#efd9c0", secondary: "#d4b99a", label: "Cream" },
    ],
  },
  {
    breed: "bengal",
    label: "Bengal",
    heightRange: [0.23, 0.29],
    defaults: defaults(
      { primary: "#d4a35a", secondary: "#3a2617", pattern: "spotted", fluff: 0.08 },
      { earStyle: "upright", muzzle: 0.6, eyeColor: "#a7b03a", noseColor: "#b86a52" },
      "long",
      { legLength: 0.6 },
    ),
    coatSwatches: [
      { primary: "#d4a35a", secondary: "#3a2617", label: "Brown" },
      { primary: "#ece6da", secondary: "#8a7a66", label: "Snow" },
      { primary: "#c3c5c7", secondary: "#2e2f33", label: "Silver" },
      { primary: "#6a625a", secondary: "#1e1b19", label: "Charcoal" },
    ],
  },
  {
    breed: "ragdoll",
    label: "Ragdoll",
    heightRange: [0.25, 0.32],
    defaults: defaults(
      { primary: "#f1ebe0", secondary: "#6b4a3a", pattern: "colorpoint", fluff: 0.7 },
      { earStyle: "upright", muzzle: 0.45, eyeSize: 0.65, eyeColor: "#5aa6e0", noseColor: "#c48a80" },
      "plume",
      { build: 0.65 },
    ),
    coatSwatches: [
      { primary: "#f1ebe0", secondary: "#6b4a3a", label: "Seal" },
      { primary: "#eef0f2", secondary: "#7d8796", label: "Blue" },
      { primary: "#f4f1ee", secondary: "#b0a4a6", label: "Lilac" },
      { primary: "#f6ecdd", secondary: "#d9925a", label: "Flame" },
    ],
  },
  {
    breed: "scottishFold",
    label: "Scottish Fold",
    heightRange: [0.2, 0.26],
    defaults: defaults(
      { primary: "#bfc2c5", secondary: "#4a4d52", pattern: "tabby", fluff: 0.3 },
      { earStyle: "folded", muzzle: 0.3, eyeSize: 0.75, eyeColor: "#d39a35", noseColor: "#8a6e6e" },
      "long",
      { build: 0.7 },
    ),
    coatSwatches: [
      { primary: "#bfc2c5", secondary: "#4a4d52", label: "Silver tabby" },
      { primary: "#8a9099", secondary: "#6d737c", label: "Blue" },
      { primary: "#e8cfa6", secondary: "#c9a77a", label: "Cream" },
      { primary: "#f3f0ea", secondary: "#e3ddd2", label: "White" },
    ],
  },
  {
    breed: "moggy",
    label: "Moggy (mixed)",
    heightRange: [0.2, 0.3],
    defaults: defaults(
      { primary: "#d68a42", secondary: "#2a2220", pattern: "calico", fluff: 0.25 },
      { earStyle: "upright", eyeColor: "#c9a03a", noseColor: "#d4928a" },
      "long",
    ),
    coatSwatches: [
      { primary: "#d68a42", secondary: "#2a2220", label: "Calico" },
      { primary: "#e0b98a", secondary: "#7f838a", label: "Dilute calico" },
      { primary: "#1e1c1c", secondary: "#f4f1ea", label: "Black & white" },
      { primary: "#d68a42", secondary: "#f4eee4", label: "Ginger & white" },
      { primary: "#2a201c", secondary: "#c8743a", label: "Tortie" },
    ],
  },
];

const BREED_IDS = CAT_BREEDS.map((b) => b.breed);
const EAR_STYLES: CatEarStyle[] = ["upright", "folded", "tufted", "large"];
const TAIL_STYLES: CatTailStyle[] = ["long", "plume", "bob", "ringed"];
const PATTERNS: CatCoatPattern[] = ["solid", "tabby", "bicolor", "tuxedo", "colorpoint", "calico", "spotted"];
const SEXES: Sex[] = ["female", "male"];

export const CAT_NAMES: string[] = [
  "Mochi", "Luna", "Milo", "Oliver", "Cleo", "Simba", "Nala", "Leo", "Bella", "Tiger",
  "Pumpkin", "Shadow", "Smokey", "Ginger", "Whiskers", "Pepper", "Misty", "Oreo", "Salem", "Willow",
  "Mittens", "Felix", "Jasper", "Pixel", "Noodle", "Biscuit", "Sushi", "Tofu", "Marmalade", "Socks",
  "Olive", "Binx", "Kiki", "Momo", "Hazel", "Figaro", "Juniper", "Toast", "Ziggy", "Clementine",
];

export function catBreedPreset(breed: CatBreed): CatBreedPreset {
  return CAT_BREEDS.find((b) => b.breed === breed) ?? CAT_BREEDS[0];
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export function configForCatBreed(breed: CatBreed, keep?: Partial<Pick<CatConfig, "name" | "sex">>): CatConfig {
  const p = catBreedPreset(breed);
  return {
    version: 1,
    name: keep?.name ?? "Mochi",
    breed: p.breed,
    sex: keep?.sex ?? "female",
    ...clone(p.defaults),
  };
}

export function defaultCatConfig(): CatConfig {
  return configForCatBreed("shorthair", { name: "Mochi", sex: "female" });
}

// ---- Random ("dice") ------------------------------------------------------------------

function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length) % xs.length];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function jitter(center: number, amount: number): number {
  // Sum of two uniforms: favours the middle, still reaches the edges.
  return clamp01(center + (Math.random() + Math.random() - 1) * amount);
}

/** A plausible cat coat colour: black, white, grey/blue, ginger, cream, brown. */
function randomCoatColor(): string {
  return pick(["#1e1c1c", "#f3f0ea", "#8a9099", "#9a9da3", "#d68a42", "#c8743a", "#e8cfa6", "#7a5a3c", "#3a2a1e", "#b3a6a8"]);
}

const COLLAR_COLORS = ["#c0392b", "#2e86de", "#27ae60", "#8e44ad", "#f39c12", "#e84393", "#16a085", "#2d3436", "#f1c40f"];
const EYE_COLORS = ["#a7b03a", "#9bb046", "#c9a03a", "#d39a35", "#c8742f", "#5aa6e0", "#7fae3e"];

export function randomCatConfig(): CatConfig {
  const breed = pick(BREED_IDS);
  const p = catBreedPreset(breed);
  const c = configForCatBreed(breed, { name: pick(CAT_NAMES), sex: pick(SEXES) });

  // Colours: mostly the breed's own swatches, sometimes another breed's or a wildcard.
  const r = Math.random();
  if (r < 0.75) {
    const s = pick(p.coatSwatches);
    c.coat.primary = s.primary;
    c.coat.secondary = s.secondary;
  } else if (r < 0.9) {
    const s = pick(pick(CAT_BREEDS).coatSwatches);
    c.coat.primary = s.primary;
    c.coat.secondary = s.secondary;
  } else {
    c.coat.primary = randomCoatColor();
    c.coat.secondary = randomCoatColor();
  }
  if (Math.random() < 0.2) c.coat.pattern = pick(PATTERNS);

  c.size = Math.random();
  c.build = jitter(p.defaults.build, 0.35);
  c.legLength = jitter(p.defaults.legLength, 0.3);
  if (breed !== "sphynx") c.coat.fluff = jitter(p.defaults.coat.fluff, 0.3);
  c.face.muzzle = jitter(p.defaults.face.muzzle, 0.25);
  c.face.eyeSize = jitter(p.defaults.face.eyeSize, 0.35);
  if (Math.random() < 0.15) c.face.earStyle = pick(EAR_STYLES);
  if (Math.random() < 0.2) c.tail = pick(TAIL_STYLES);
  if (Math.random() < 0.3) c.face.eyeColor = pick(EYE_COLORS);
  c.face.whiskers = Math.random() < 0.9;
  c.collar.enabled = Math.random() < 0.7;
  c.collar.color = pick(COLLAR_COLORS);
  c.collar.bell = Math.random() < 0.6;
  return c;
}

// ---- Validation -------------------------------------------------------------------------

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function num01(x: unknown, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? clamp01(x) : fallback;
}

function color(x: unknown, fallback: string): string {
  if (typeof x !== "string") return fallback;
  const s = x.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return fallback;
}

function oneOf<T extends string>(x: unknown, xs: readonly T[], fallback: T): T {
  return typeof x === "string" && (xs as readonly string[]).includes(x) ? (x as T) : fallback;
}

function bool(x: unknown, fallback: boolean): boolean {
  return typeof x === "boolean" ? x : fallback;
}

export function sanitizeCatConfig(raw: unknown): CatConfig {
  try {
    const r = isObj(raw) ? raw : {};
    const breed = oneOf(r.breed, BREED_IDS, "shorthair");
    const base = configForCatBreed(breed);
    const coat = isObj(r.coat) ? r.coat : {};
    const face = isObj(r.face) ? r.face : {};
    const collar = isObj(r.collar) ? r.collar : {};
    let name = typeof r.name === "string" ? r.name.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
    if (name.length > 24) name = name.slice(0, 24).trim();
    return {
      version: 1,
      name: name || base.name,
      breed,
      sex: oneOf(r.sex, SEXES, base.sex),
      size: num01(r.size, base.size),
      build: num01(r.build, base.build),
      legLength: num01(r.legLength, base.legLength),
      coat: {
        primary: color(coat.primary, base.coat.primary),
        secondary: color(coat.secondary, base.coat.secondary),
        pattern: oneOf(coat.pattern, PATTERNS, base.coat.pattern),
        fluff: num01(coat.fluff, base.coat.fluff),
      },
      face: {
        muzzle: num01(face.muzzle, base.face.muzzle),
        earStyle: oneOf(face.earStyle, EAR_STYLES, base.face.earStyle),
        eyeSize: num01(face.eyeSize, base.face.eyeSize),
        eyeColor: color(face.eyeColor, base.face.eyeColor),
        noseColor: color(face.noseColor, base.face.noseColor),
        whiskers: bool(face.whiskers, base.face.whiskers),
      },
      tail: oneOf(r.tail, TAIL_STYLES, base.tail),
      collar: {
        enabled: bool(collar.enabled, base.collar.enabled),
        color: color(collar.color, base.collar.color),
        bell: bool(collar.bell, base.collar.bell),
      },
    };
  } catch {
    return defaultCatConfig();
  }
}
