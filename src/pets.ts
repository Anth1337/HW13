import { defaultCatConfig, sanitizeCatConfig } from "./cat/config";
import type { CatConfig } from "./cat/types";
import { defaultDogConfig, sanitizeDogConfig } from "./dog/config";
import type { DogConfig } from "./dog/types";

/*
 * The three saved animal slots and which one is being edited / played with.
 *
 * Saved in localStorage, not cookies: cookies cap at ~4 KB and are sent to the server with every
 * request, while this is purely client-side data. Same "in this browser only" lifetime.
 * Every read/write is try/catch'd (private mode, blocked storage): the app then works for the
 * session without saving.
 */

export type Species = "dog" | "cat";
export type Pet = { species: "dog"; config: DogConfig } | { species: "cat"; config: CatConfig };

export const SLOT_COUNT = 3;
export const SPECIES: { species: Species; label: string; emoji: string }[] = [
  { species: "dog", label: "Dog", emoji: "🐕" },
  { species: "cat", label: "Cat", emoji: "🐈" },
];

const STORAGE_KEY = "ar-pets-v1";
/** The single-dog save from before slots existed; migrated into slot 1 once. */
const LEGACY_DOG_KEY = "ar-dog-config-v1";

type Saved = { slots: (Pet | null)[]; active: number | null };

export function sanitizePet(raw: unknown): Pet | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { species?: unknown; config?: unknown };
  if (r.species === "dog") return { species: "dog", config: sanitizeDogConfig(r.config) };
  if (r.species === "cat") return { species: "cat", config: sanitizeCatConfig(r.config) };
  return null;
}

export function newPet(species: Species): Pet {
  return species === "cat" ? { species, config: defaultCatConfig() } : { species, config: defaultDogConfig() };
}

function read(key: string): unknown {
  try {
    const s = globalThis.localStorage?.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function load(): Saved {
  const empty = (): (Pet | null)[] => Array.from({ length: SLOT_COUNT }, () => null);
  const raw = read(STORAGE_KEY) as Partial<Saved> | null;
  if (raw && Array.isArray(raw.slots)) {
    const slots = empty().map((_, i) => sanitizePet(raw.slots![i]));
    const a = raw.active;
    const active = typeof a === "number" && Number.isInteger(a) && slots[a] ? a : null;
    return { slots, active };
  }
  const slots = empty();
  const legacy = read(LEGACY_DOG_KEY);
  if (legacy) slots[0] = { species: "dog", config: sanitizeDogConfig(legacy) };
  return { slots, active: null };
}

let state: Saved | null = null;
const listeners = new Set<() => void>();
const get = () => (state ??= load());

function notify() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

// Another tab saved: reload so our next save() doesn't overwrite its slots with stale ones.
// The selection stays per-tab (unless that tab deleted our pet). No save() here, so tabs don't ping-pong.
globalThis.addEventListener?.("storage", (e) => {
  if (e.key !== STORAGE_KEY && e.key !== null) return; // null = storage cleared
  const mine = state?.active ?? null;
  state = load();
  state.active = mine !== null && state.slots[mine] ? mine : null;
  notify();
});

function save() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(get()));
    globalThis.localStorage?.removeItem(LEGACY_DOG_KEY); // migrated: a deleted dog mustn't come back
  } catch {
    /* storage full / blocked */
  }
  notify();
}

const checkSlot = (i: number) => {
  if (!Number.isInteger(i) || i < 0 || i >= SLOT_COUNT) throw new RangeError(`no slot ${i}`);
};

/**
 * The slot list and the active slot. `subscribe` fires after ANY change (slot created, deleted,
 * selected, or the active pet edited).
 */
export const petStore = {
  slots(): readonly (Pet | null)[] {
    return get().slots;
  },
  activeSlot(): number | null {
    return get().active;
  },
  /** The pet being customised / deployed, or null on the menu. */
  active(): Pet | null {
    const s = get();
    return s.active === null ? null : s.slots[s.active];
  },
  /** Fill an empty (or overwrite a) slot with a fresh default animal and make it active. */
  create(slot: number, species: Species): Pet {
    checkSlot(slot);
    const s = get();
    const pet = newPet(species);
    s.slots[slot] = pet;
    s.active = slot;
    save();
    return pet;
  },
  delete(slot: number): void {
    checkSlot(slot);
    const s = get();
    s.slots[slot] = null;
    if (s.active === slot) s.active = null;
    save();
  },
  /** Make a filled slot active (null = back to the menu). */
  select(slot: number | null): void {
    const s = get();
    if (slot !== null) {
      checkSlot(slot);
      if (!s.slots[slot]) return;
    }
    if (s.active === slot) return;
    s.active = slot;
    save();
  },
  /** Replace the active pet's config (the creator's edits). Species can't change here. */
  updateActive(config: DogConfig | CatConfig): void {
    const s = get();
    if (s.active === null) return;
    const cur = s.slots[s.active];
    if (!cur) return;
    s.slots[s.active] = sanitizePet({ species: cur.species, config });
    save();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export const petName = (p: Pet | null) => p?.config.name.trim() || (p?.species === "cat" ? "your cat" : "your dog");
