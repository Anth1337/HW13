import type { Breed, BreedPreset, CoatPattern, DogConfig, EarStyle, Sex, TailStyle } from "./types";

/*
 * Breed presets, the random "dice" config, validation and the persisted config store.
 * Everything here is plain data; the 3D proportions per breed live in src/models/dog.ts.
 */

type Defaults = BreedPreset["defaults"];

function defaults(
  coat: Defaults["coat"],
  face: Partial<Defaults["face"]> & Pick<Defaults["face"], "earStyle">,
  tail: TailStyle,
  extra: Partial<Pick<Defaults, "build" | "legLength" | "size">> = {},
): Defaults {
  return {
    size: extra.size ?? 0.5,
    build: extra.build ?? 0.5,
    legLength: extra.legLength ?? 0.5,
    coat,
    face: {
      snoutLength: 0.5,
      eyeSize: 0.5,
      eyeColor: "#4a2c17",
      noseColor: "#2b1d16",
      brows: false,
      tongueOut: false,
      ...face,
    },
    tail,
    collar: { color: "#c0392b", tag: true },
  };
}

export const BREEDS: BreedPreset[] = [
  {
    breed: "labrador",
    label: "Labrador",
    heightRange: [0.54, 0.62],
    defaults: defaults({ primary: "#dcae66", secondary: "#efd3a0", pattern: "solid", fluff: 0.15 }, { earStyle: "floppy" }, "otter"),
    coatSwatches: [
      { primary: "#dcae66", secondary: "#efd3a0", label: "Yellow" },
      { primary: "#262220", secondary: "#3a3430", label: "Black" },
      { primary: "#5b3a26", secondary: "#7a5136", label: "Chocolate" },
      { primary: "#b8682f", secondary: "#d69a62", label: "Fox red" },
    ],
  },
  {
    breed: "corgi",
    label: "Corgi",
    heightRange: [0.25, 0.31],
    defaults: defaults(
      { primary: "#c8742f", secondary: "#f4efe6", pattern: "twoTone", fluff: 0.35 },
      { earStyle: "pointy", eyeColor: "#3b2414" },
      "stub",
    ),
    coatSwatches: [
      { primary: "#c8742f", secondary: "#f4efe6", label: "Red & white" },
      { primary: "#9c6a3a", secondary: "#f1e8da", label: "Sable" },
      { primary: "#2e2622", secondary: "#f2ece2", label: "Tricolour" },
      { primary: "#d9a066", secondary: "#f6eddc", label: "Fawn" },
    ],
  },
  {
    breed: "dachshund",
    label: "Dachshund",
    heightRange: [0.18, 0.25],
    defaults: defaults(
      { primary: "#9a4f24", secondary: "#c07a45", pattern: "solid", fluff: 0.05 },
      { earStyle: "long", eyeColor: "#3a2214" },
      "whip",
    ),
    coatSwatches: [
      { primary: "#9a4f24", secondary: "#c07a45", label: "Red" },
      { primary: "#231b18", secondary: "#b0703c", label: "Black & tan" },
      { primary: "#4e2e1f", secondary: "#a87048", label: "Chocolate" },
      { primary: "#e2c08e", secondary: "#f0dcb6", label: "Cream" },
    ],
  },
  {
    breed: "husky",
    label: "Husky",
    heightRange: [0.5, 0.6],
    defaults: defaults(
      { primary: "#5e6066", secondary: "#f3f3f1", pattern: "mask", fluff: 0.6 },
      { earStyle: "pointy", eyeColor: "#6fb7e8", noseColor: "#1e1c1c" },
      "curled",
    ),
    coatSwatches: [
      { primary: "#5e6066", secondary: "#f3f3f1", label: "Grey & white" },
      { primary: "#26272b", secondary: "#f2f2f0", label: "Black & white" },
      { primary: "#a4552e", secondary: "#f5efe6", label: "Red & white" },
      { primary: "#6b5a48", secondary: "#e8e0d4", label: "Agouti" },
    ],
  },
  {
    breed: "poodle",
    label: "Poodle",
    heightRange: [0.38, 0.55],
    defaults: defaults(
      { primary: "#d89a62", secondary: "#e8b88a", pattern: "solid", fluff: 0.95 },
      { earStyle: "long", eyeColor: "#2e1c12", noseColor: "#3a2418" },
      "whip",
    ),
    coatSwatches: [
      { primary: "#d89a62", secondary: "#e8b88a", label: "Apricot" },
      { primary: "#f3f0ea", secondary: "#e8e2d8", label: "White" },
      { primary: "#1f1d1d", secondary: "#2c2a2a", label: "Black" },
      { primary: "#9a9a9e", secondary: "#b4b4b8", label: "Silver" },
      { primary: "#5a3a2a", secondary: "#6e4a36", label: "Chocolate" },
    ],
  },
  {
    breed: "beagle",
    label: "Beagle",
    heightRange: [0.33, 0.41],
    defaults: defaults(
      { primary: "#c27b3f", secondary: "#2a2420", pattern: "saddle", fluff: 0.1 },
      { earStyle: "long", eyeColor: "#3a2214" },
      "whip",
    ),
    coatSwatches: [
      { primary: "#c27b3f", secondary: "#2a2420", label: "Tricolour" },
      { primary: "#e3c27e", secondary: "#d1a65c", label: "Lemon" },
      { primary: "#b0602c", secondary: "#874420", label: "Red" },
      { primary: "#8f8a86", secondary: "#2e2c2c", label: "Blue tick" },
    ],
  },
  {
    breed: "shepherd",
    label: "German Shepherd",
    heightRange: [0.55, 0.65],
    defaults: defaults(
      { primary: "#b67a3c", secondary: "#1f1a17", pattern: "saddle", fluff: 0.45 },
      { earStyle: "pointy", eyeColor: "#3b2414" },
      "plume",
    ),
    coatSwatches: [
      { primary: "#b67a3c", secondary: "#1f1a17", label: "Black & tan" },
      { primary: "#8c6a42", secondary: "#3a2e24", label: "Sable" },
      { primary: "#1e1c1b", secondary: "#2c2826", label: "Black" },
      { primary: "#f1ece2", secondary: "#e6dfd2", label: "White" },
    ],
  },
  {
    breed: "dalmatian",
    label: "Dalmatian",
    heightRange: [0.54, 0.61],
    defaults: defaults(
      { primary: "#f6f4ef", secondary: "#1c1a1a", pattern: "spots", fluff: 0.05 },
      { earStyle: "floppy", eyeColor: "#3b2414", noseColor: "#1c1a1a" },
      "whip",
      { build: 0.4 },
    ),
    coatSwatches: [
      { primary: "#f6f4ef", secondary: "#1c1a1a", label: "Black spots" },
      { primary: "#f6f2ea", secondary: "#6a3a24", label: "Liver spots" },
      { primary: "#f7f3ea", secondary: "#d9a55a", label: "Lemon spots" },
    ],
  },
  {
    breed: "pug",
    label: "Pug",
    heightRange: [0.25, 0.33],
    defaults: defaults(
      { primary: "#d9b98a", secondary: "#26201d", pattern: "mask", fluff: 0.1 },
      { earStyle: "folded", eyeSize: 0.85, eyeColor: "#24160e", noseColor: "#1a1514" },
      "curled",
      { build: 0.75 },
    ),
    coatSwatches: [
      { primary: "#d9b98a", secondary: "#26201d", label: "Fawn" },
      { primary: "#1f1c1b", secondary: "#141212", label: "Black" },
      { primary: "#d39a5e", secondary: "#2a201c", label: "Apricot" },
      { primary: "#cfc3ad", secondary: "#2a2420", label: "Silver fawn" },
    ],
  },
  {
    breed: "mutt",
    label: "Mixed breed",
    heightRange: [0.36, 0.58],
    defaults: defaults(
      { primary: "#8c6239", secondary: "#e9dcc4", pattern: "twoTone", fluff: 0.3 },
      { earStyle: "folded", brows: true },
      "otter",
    ),
    coatSwatches: [
      { primary: "#8c6239", secondary: "#e9dcc4", label: "Brown & cream" },
      { primary: "#6b4b30", secondary: "#3b2a1e", label: "Brindle" },
      { primary: "#24211f", secondary: "#f0ebe3", label: "Black & white" },
      { primary: "#c47a3c", secondary: "#f2e2c8", label: "Ginger" },
      { primary: "#7c7a78", secondary: "#dcd8d2", label: "Grey" },
    ],
  },
];

const BREED_IDS = BREEDS.map((b) => b.breed);
const EAR_STYLES: EarStyle[] = ["floppy", "pointy", "folded", "long"];
const TAIL_STYLES: TailStyle[] = ["otter", "curled", "stub", "plume", "whip"];
const PATTERNS: CoatPattern[] = ["solid", "twoTone", "saddle", "spots", "mask", "patches"];
const SEXES: Sex[] = ["female", "male"];

export const DOG_NAMES: string[] = [
  "Biscuit", "Luna", "Max", "Bella", "Charlie", "Daisy", "Milo", "Pepper", "Rosie", "Cooper",
  "Maple", "Teddy", "Willow", "Buddy", "Hazel", "Ollie", "Ruby", "Bear", "Penny", "Scout",
  "Nala", "Finn", "Lola", "Waffles", "Juniper", "Toby", "Poppy", "Ziggy", "Mochi", "Rex",
  "Clover", "Bruno", "Honey", "Pickles", "Sadie", "Winston", "Olive", "Nugget", "Gus", "Peanut",
];

export function breedPreset(breed: Breed): BreedPreset {
  return BREEDS.find((b) => b.breed === breed) ?? BREEDS[0];
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export function configForBreed(breed: Breed, keep?: Partial<Pick<DogConfig, "name" | "sex">>): DogConfig {
  const p = breedPreset(breed);
  return {
    version: 1,
    name: keep?.name ?? "Biscuit",
    breed: p.breed,
    sex: keep?.sex ?? "female",
    ...clone(p.defaults),
  };
}

export function defaultDogConfig(): DogConfig {
  return configForBreed("labrador", { name: "Biscuit", sex: "female" });
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

function hsl(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** A plausible dog coat colour: browns, creams, greys, blacks, whites. */
function randomCoatColor(): string {
  const r = Math.random();
  if (r < 0.15) return hsl(0, 0, 0.1 + Math.random() * 0.1); // black
  if (r < 0.3) return hsl(0.1, 0.1, 0.88 + Math.random() * 0.08); // white / cream
  if (r < 0.45) return hsl(0.6, 0.04, 0.35 + Math.random() * 0.3); // grey / blue
  return hsl(0.05 + Math.random() * 0.06, 0.35 + Math.random() * 0.35, 0.25 + Math.random() * 0.45); // browns
}

const COLLAR_COLORS = ["#c0392b", "#2e86de", "#27ae60", "#8e44ad", "#f39c12", "#e84393", "#16a085", "#2d3436", "#f1c40f"];
const EYE_COLORS = ["#4a2c17", "#3b2414", "#6a4422", "#8a5a2b", "#6fb7e8"];

export function randomDogConfig(): DogConfig {
  const breed = pick(BREED_IDS);
  const p = breedPreset(breed);
  const c = configForBreed(breed, { name: pick(DOG_NAMES), sex: pick(SEXES) });

  // Colours: mostly the breed's own swatches, sometimes another breed's or a wildcard.
  const r = Math.random();
  if (r < 0.75) {
    const s = pick(p.coatSwatches);
    c.coat.primary = s.primary;
    c.coat.secondary = s.secondary;
  } else if (r < 0.9) {
    const s = pick(pick(BREEDS).coatSwatches);
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
  c.coat.fluff = jitter(p.defaults.coat.fluff, 0.3);
  c.face.snoutLength = jitter(0.5, 0.35);
  c.face.eyeSize = jitter(p.defaults.face.eyeSize, 0.35);
  if (Math.random() < 0.2) c.face.earStyle = pick(EAR_STYLES);
  if (Math.random() < 0.2) c.tail = pick(TAIL_STYLES);
  if (Math.random() < 0.15) c.face.eyeColor = pick(EYE_COLORS);
  if (Math.random() < 0.2) c.face.brows = !c.face.brows;
  c.face.tongueOut = Math.random() < 0.3;
  c.collar.color = pick(COLLAR_COLORS);
  c.collar.tag = Math.random() < 0.65;
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

export function sanitizeDogConfig(raw: unknown): DogConfig {
  try {
    const r = isObj(raw) ? raw : {};
    const breed = oneOf(r.breed, BREED_IDS, "labrador");
    const base = configForBreed(breed);
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
        snoutLength: num01(face.snoutLength, base.face.snoutLength),
        earStyle: oneOf(face.earStyle, EAR_STYLES, base.face.earStyle),
        eyeSize: num01(face.eyeSize, base.face.eyeSize),
        eyeColor: color(face.eyeColor, base.face.eyeColor),
        noseColor: color(face.noseColor, base.face.noseColor),
        brows: bool(face.brows, base.face.brows),
        tongueOut: bool(face.tongueOut, base.face.tongueOut),
      },
      tail: oneOf(r.tail, TAIL_STYLES, base.tail),
      collar: {
        color: color(collar.color, base.collar.color),
        tag: bool(collar.tag, base.collar.tag),
      },
    };
  } catch {
    return defaultDogConfig();
  }
}

// ---- Store ----------------------------------------------------------------------------

const STORAGE_KEY = "ar-dog-config-v1";

function load(): DogConfig {
  try {
    const s = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (s) return sanitizeDogConfig(JSON.parse(s));
  } catch {
    /* private mode / corrupt JSON: fall through */
  }
  return defaultDogConfig();
}

let current: DogConfig | null = null;
const listeners = new Set<(c: DogConfig) => void>();

export const dogConfigStore = {
  get(): DogConfig {
    if (!current) current = load();
    return current;
  },
  set(c: DogConfig): void {
    current = sanitizeDogConfig(c);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      /* storage full / blocked */
    }
    for (const fn of [...listeners]) {
      try {
        fn(current);
      } catch (e) {
        console.error(e);
      }
    }
  },
  subscribe(fn: (c: DogConfig) => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
