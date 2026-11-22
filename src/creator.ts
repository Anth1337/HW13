import { CAT_BREEDS, catBreedPreset, configForCatBreed, randomCatConfig } from "./cat/config";
import type { CatConfig, CatEarStyle, CatTailStyle } from "./cat/types";
import { BREEDS, breedPreset, configForBreed, randomDogConfig } from "./dog/config";
import type { DogConfig, EarStyle, Sex, TailStyle } from "./dog/types";
import { petStore, type Species } from "./pets";

/*
 * The character creator: fills #creator with labelled controls for the active pet (petStore),
 * using the controls for its species. A sticky bar holds the name, 🎲 and a row of section tabs
 * (Breed, Body, Coat…) that jump to a section and follow the scroll position, so getting to a
 * setting never takes more than a tap. Discrete choices (breed, sex, chips, toggles) commit at
 * once; slider / colour drags and name typing are debounced (~80 ms) so the preview isn't
 * rebuilt on every input event. Mounted for one pet: main.ts destroys + remounts it when the
 * active pet changes.
 */

const DEBOUNCE_MS = 80;

type Option<T> = { value: T; label: string };

const SEXES: Option<Sex>[] = [
  { value: "female", label: "♀ Female" },
  { value: "male", label: "♂ Male" },
];

let uid = 0;
const nextId = (base: string) => `cr-${base}-${++uid}`;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

/** Sliders side by side (two columns when the panel is wide enough, see .cr-grid). */
const grid = (...children: Node[]) => el("div", { class: "cr-grid" }, children);

/** Three-word description of a 0..1 slider value. */
const words = (lo: string, mid: string, hi: string) => (v: number) => (v < 0.34 ? lo : v > 0.66 ? hi : mid);

/** The fields every species' config shares (DogConfig and CatConfig both fit). */
interface BaseConfig {
  name: string;
  breed: string;
  sex: Sex;
  size: number;
  build: number;
  legLength: number;
  coat: { primary: string; secondary: string; pattern: string; fluff: number };
}

/** The generic controls, bound to one config type. */
interface Kit<C> {
  section(title: string, ...children: Node[]): HTMLElement;
  chips<T extends string>(label: string, options: Option<T>[], get: (c: C) => T, set: (c: C, v: T) => void, opts?: { segmented?: boolean }): HTMLElement;
  slider(label: string, get: (c: C) => number, set: (c: C, v: number) => void, describe: (v: number, c: C) => string): HTMLElement;
  color(label: string, get: (c: C) => string, set: (c: C, v: string) => void): HTMLElement;
  toggle(label: string, get: (c: C) => boolean, set: (c: C, v: boolean) => void): HTMLElement;
}

/** What differs per species. Breed, body and coat are laid out the same; `extra` adds the rest. */
interface SpeciesUI<C extends BaseConfig> {
  species: Species;
  breeds: Option<C["breed"]>[];
  preset(breed: C["breed"]): { heightRange: [number, number]; coatSwatches: { primary: string; secondary: string; label: string }[] };
  forBreed(breed: C["breed"], keep: { name: string; sex: Sex }): C;
  random(): C;
  build: [string, string, string];
  patterns: Option<C["coat"]["pattern"]>[];
  fluff: [string, string, string];
  extra(kit: Kit<C>): void;
}

const DOG: SpeciesUI<DogConfig> = {
  species: "dog",
  breeds: BREEDS.map((b) => ({ value: b.breed, label: b.label })),
  preset: breedPreset,
  forBreed: configForBreed,
  random: randomDogConfig,
  build: ["Slim", "Average", "Stocky"],
  patterns: [
    { value: "solid", label: "Solid" },
    { value: "twoTone", label: "Two-tone" },
    { value: "saddle", label: "Saddle" },
    { value: "spots", label: "Spots" },
    { value: "mask", label: "Mask" },
    { value: "patches", label: "Patches" },
  ],
  fluff: ["Sleek", "Medium", "Fluffy"],
  extra({ section, chips, slider, color, toggle }) {
    const ears: Option<EarStyle>[] = [
      { value: "floppy", label: "Floppy" },
      { value: "pointy", label: "Pointy" },
      { value: "folded", label: "Folded" },
      { value: "long", label: "Long" },
    ];
    const tails: Option<TailStyle>[] = [
      { value: "otter", label: "Otter" },
      { value: "curled", label: "Curled" },
      { value: "stub", label: "Stub" },
      { value: "plume", label: "Plume" },
      { value: "whip", label: "Whip" },
    ];
    section(
      "Face",
      grid(
        slider("Snout", (c) => c.face.snoutLength, (c, v) => (c.face.snoutLength = v), words("Flat", "Medium", "Long")),
        slider("Eye size", (c) => c.face.eyeSize, (c, v) => (c.face.eyeSize = v), words("Small", "Medium", "Big")),
      ),
      chips("Ears", ears, (c) => c.face.earStyle, (c, v) => (c.face.earStyle = v)),
      el("div", { class: "cr-colors" }, [
        color("Eyes", (c) => c.face.eyeColor, (c, v) => (c.face.eyeColor = v)),
        color("Nose", (c) => c.face.noseColor, (c, v) => (c.face.noseColor = v)),
      ]),
      el("div", { class: "cr-toggles" }, [
        toggle("Brows", (c) => c.face.brows, (c, v) => (c.face.brows = v)),
        toggle("Tongue out", (c) => c.face.tongueOut, (c, v) => (c.face.tongueOut = v)),
      ]),
    );
    section("Tail", chips("Tail style", tails, (c) => c.tail, (c, v) => (c.tail = v)));
    section(
      "Collar",
      el("div", { class: "cr-colors" }, [
        color("Collar", (c) => c.collar.color, (c, v) => (c.collar.color = v)),
        toggle("Name tag", (c) => c.collar.tag, (c, v) => (c.collar.tag = v)),
      ]),
    );
  },
};

const CAT: SpeciesUI<CatConfig> = {
  species: "cat",
  breeds: CAT_BREEDS.map((b) => ({ value: b.breed, label: b.label })),
  preset: catBreedPreset,
  forBreed: configForCatBreed,
  random: randomCatConfig,
  build: ["Slim", "Average", "Chonky"],
  patterns: [
    { value: "solid", label: "Solid" },
    { value: "tabby", label: "Tabby" },
    { value: "bicolor", label: "Bicolour" },
    { value: "tuxedo", label: "Tuxedo" },
    { value: "colorpoint", label: "Colourpoint" },
    { value: "calico", label: "Calico" },
    { value: "spotted", label: "Spotted" },
  ],
  fluff: ["Hairless", "Short", "Long-haired"],
  extra({ section, chips, slider, color, toggle }) {
    const ears: Option<CatEarStyle>[] = [
      { value: "upright", label: "Upright" },
      { value: "folded", label: "Folded" },
      { value: "tufted", label: "Tufted" },
      { value: "large", label: "Large" },
    ];
    const tails: Option<CatTailStyle>[] = [
      { value: "long", label: "Long" },
      { value: "plume", label: "Plume" },
      { value: "bob", label: "Bob" },
      { value: "ringed", label: "Ringed" },
    ];
    section(
      "Face",
      grid(
        slider("Muzzle", (c) => c.face.muzzle, (c, v) => (c.face.muzzle = v), words("Flat", "Medium", "Wedge")),
        slider("Eye size", (c) => c.face.eyeSize, (c, v) => (c.face.eyeSize = v), words("Small", "Medium", "Big")),
      ),
      chips("Ears", ears, (c) => c.face.earStyle, (c, v) => (c.face.earStyle = v)),
      el("div", { class: "cr-colors" }, [
        color("Eyes", (c) => c.face.eyeColor, (c, v) => (c.face.eyeColor = v)),
        color("Nose", (c) => c.face.noseColor, (c, v) => (c.face.noseColor = v)),
      ]),
      el("div", { class: "cr-toggles" }, [toggle("Whiskers", (c) => c.face.whiskers, (c, v) => (c.face.whiskers = v))]),
    );
    section("Tail", chips("Tail style", tails, (c) => c.tail, (c, v) => (c.tail = v)));
    section(
      "Collar",
      el("div", { class: "cr-toggles" }, [toggle("Collar", (c) => c.collar.enabled, (c, v) => (c.collar.enabled = v))]),
      el("div", { class: "cr-colors" }, [
        color("Colour", (c) => c.collar.color, (c, v) => (c.collar.color = v)),
        toggle("Bell", (c) => c.collar.bell, (c, v) => (c.collar.bell = v)),
      ]),
    );
  },
};

/** Mount the creator for the active pet (empty if there is none). */
export function mountCreator(container: HTMLElement): { destroy(): void } {
  const pet = petStore.active();
  if (!pet) {
    container.replaceChildren();
    return { destroy() {} };
  }
  return pet.species === "cat" ? build(container, pet.config, CAT) : build(container, pet.config, DOG);
}

function build<C extends BaseConfig>(container: HTMLElement, initial: C, ui: SpeciesUI<C>): { destroy(): void } {
  /** The latest config, including edits not yet committed to the store. */
  let draft: C = initial;
  let timer: number | undefined;
  const syncers: ((c: C) => void)[] = [];
  const cleanups: (() => void)[] = [];

  const commitNow = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    petStore.updateActive(draft as unknown as DogConfig | CatConfig);
  };
  const commitSoon = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(commitNow, DEBOUNCE_MS);
  };
  /** Apply an edit to a copy of the draft (configs from the store are never mutated). */
  const edit = (fn: (c: C) => void, debounce: boolean) => {
    const next = structuredClone(draft);
    fn(next);
    draft = next;
    if (debounce) commitSoon();
    else commitNow();
  };

  const root = el("div", { class: "creator-inner" });

  /* ---- Top bar: name + dice ---- */
  const nameId = nextId("name");
  const nameInput = el("input", {
    id: nameId,
    class: "cr-name",
    type: "text",
    maxlength: "20",
    autocomplete: "off",
    spellcheck: "false",
    enterkeyhint: "done",
  });
  nameInput.addEventListener("input", () => edit((c) => (c.name = nameInput.value), true));
  nameInput.addEventListener("change", commitNow);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameInput.blur();
  });
  syncers.push((c) => {
    if (document.activeElement !== nameInput && nameInput.value !== c.name) nameInput.value = c.name;
  });

  const diceIcon = el("span", { class: "dice-icon", "aria-hidden": "true", text: "🎲" });
  const dice = el("button", { type: "button", class: "cr-dice", title: `Random ${ui.species}` }, [diceIcon, el("span", { text: "Randomize" })]);
  dice.addEventListener("click", () => {
    diceIcon.classList.remove("rolling");
    void diceIcon.offsetWidth; // restart the animation on quick repeated taps
    diceIcon.classList.add("rolling");
    draft = ui.random();
    commitNow();
  });
  diceIcon.addEventListener("animationend", () => diceIcon.classList.remove("rolling"));

  /** Section tabs, filled in once every section exists (see the end of build). */
  const nav = el("nav", { class: "cr-nav", "aria-label": "Jump to a section" });
  const bar = el("div", { class: "cr-sticky" }, [
    el("div", { class: "cr-top" }, [
      el("div", { class: "cr-name-wrap" }, [el("label", { for: nameId, class: "cr-label", text: "Name" }), nameInput]),
      dice,
    ]),
    nav,
  ]);
  root.append(bar);

  /* ---- Building blocks ---- */
  const sections: { title: string; el: HTMLElement }[] = [];
  const section = (title: string, ...children: Node[]) => {
    const id = nextId("sec");
    const s = el("section", { class: "cr-section", "aria-labelledby": id }, [el("h2", { id, class: "cr-h", text: title })]);
    s.append(...children);
    root.append(s);
    sections.push({ title, el: s });
    return s;
  };

  /** A row of toggle buttons (one pressed). */
  function chips<T extends string>(
    label: string,
    options: Option<T>[],
    get: (c: C) => T,
    set: (c: C, v: T) => void,
    opts: { scroll?: boolean; segmented?: boolean; onPick?: (v: T) => void } = {},
  ) {
    const id = nextId("chips");
    const group = el("div", {
      class: `cr-chips${opts.scroll ? " cr-scroll" : ""}${opts.segmented ? " cr-seg" : ""}`,
      role: "group",
      "aria-labelledby": id,
    });
    const buttons = options.map((o) => {
      const b = el("button", { type: "button", class: "cr-chip", "aria-pressed": "false", text: o.label });
      b.addEventListener("click", () => {
        if (opts.onPick) opts.onPick(o.value);
        else edit((c) => set(c, o.value), false);
      });
      group.append(b);
      return { value: o.value, b };
    });
    /** Keep the chosen chip in view in a scrolling row (no smooth scroll: it fights quick taps). */
    const revealPressed = () => {
      const on = buttons.find(({ b }) => b.getAttribute("aria-pressed") === "true")?.b;
      if (!on || !on.offsetParent) return; // not laid out yet (e.g. hidden while checking AR)
      const gl = group.scrollLeft;
      const left = on.offsetLeft - group.offsetLeft;
      if (left < gl || left + on.offsetWidth > gl + group.clientWidth) group.scrollLeft = left - 12;
    };
    if (opts.scroll) {
      // The row may first be laid out after mount (the creator is hidden during the checking state).
      let wasVisible = false;
      const ro = new ResizeObserver(() => {
        const visible = group.clientWidth > 0;
        if (visible && !wasVisible) revealPressed();
        wasVisible = visible;
      });
      ro.observe(group);
      cleanups.push(() => ro.disconnect());
    }
    syncers.push((c) => {
      const v = get(c);
      for (const { value, b } of buttons) b.setAttribute("aria-pressed", String(value === v));
      if (opts.scroll) revealPressed();
    });
    return el("div", { class: "cr-field" }, [el("span", { id, class: "cr-label", text: label }), group]);
  }

  /** A 0..1 slider with a word/number readout. */
  function slider(label: string, get: (c: C) => number, set: (c: C, v: number) => void, describe: (v: number, c: C) => string) {
    const id = nextId("rng");
    const input = el("input", { id, type: "range", min: "0", max: "1", step: "0.01", class: "cr-range" });
    const out = el("output", { for: id, class: "cr-out" });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      edit((c) => set(c, v), true);
      out.textContent = describe(v, draft);
    });
    input.addEventListener("change", commitNow);
    syncers.push((c) => {
      const v = get(c);
      if (document.activeElement !== input || Math.abs(Number(input.value) - v) > 0.011) input.value = String(v);
      out.textContent = describe(v, c);
    });
    return el("div", { class: "cr-field cr-slider" }, [
      el("div", { class: "cr-row" }, [el("label", { for: id, class: "cr-label", text: label }), out]),
      input,
    ]);
  }

  function color(label: string, get: (c: C) => string, set: (c: C, v: string) => void) {
    const id = nextId("col");
    const input = el("input", { id, type: "color", class: "cr-color" });
    input.addEventListener("input", () => edit((c) => set(c, input.value), true));
    input.addEventListener("change", commitNow);
    syncers.push((c) => {
      const v = get(c).toLowerCase();
      if (input.value.toLowerCase() !== v) input.value = v;
    });
    return el("label", { for: id, class: "cr-colorfield" }, [input, el("span", { text: label })]);
  }

  function toggle(label: string, get: (c: C) => boolean, set: (c: C, v: boolean) => void) {
    const b = el("button", { type: "button", role: "switch", class: "cr-switch", "aria-checked": "false" }, [
      el("span", { class: "cr-switch-track", "aria-hidden": "true" }, [el("span", { class: "cr-switch-knob" })]),
      el("span", { text: label }),
    ]);
    b.addEventListener("click", () => edit((c) => set(c, !get(c)), false));
    syncers.push((c) => b.setAttribute("aria-checked", String(get(c))));
    return b;
  }

  /* ---- Breed ---- */
  const resetBreed = el("button", { type: "button", class: "cr-link", text: "Reset breed" });
  resetBreed.addEventListener("click", () => {
    draft = ui.forBreed(draft.breed, { name: draft.name, sex: draft.sex });
    commitNow();
  });
  const breedField = chips(
    "Breed",
    ui.breeds,
    (c) => c.breed,
    () => {},
    {
      scroll: true,
      onPick: (breed) => {
        if (breed === draft.breed) return;
        draft = ui.forBreed(breed, { name: draft.name, sex: draft.sex });
        commitNow();
      },
    },
  );
  const breedHead = el("div", { class: "cr-row" }, [el("h2", { class: "cr-h", text: "Breed" }), resetBreed]);
  const breedSection = el("section", { class: "cr-section", "aria-label": "Breed" }, [breedHead, breedField]);
  breedField.querySelector(".cr-label")?.classList.add("visually-hidden");
  root.append(breedSection);
  sections.push({ title: "Breed", el: breedSection });

  /* ---- Body ---- */
  const heightCm = (v: number, c: C) => {
    const [lo, hi] = ui.preset(c.breed).heightRange;
    return `${Math.round((lo + (hi - lo) * v) * 100)} cm`;
  };
  section(
    "Body",
    chips("Sex", SEXES, (c) => c.sex, (c, v) => (c.sex = v), { segmented: true }),
    grid(
      slider("Size", (c) => c.size, (c, v) => (c.size = v), heightCm),
      slider("Build", (c) => c.build, (c, v) => (c.build = v), words(...ui.build)),
      slider("Leg length", (c) => c.legLength, (c, v) => (c.legLength = v), words("Short", "Average", "Long")),
    ),
  );

  /* ---- Coat ---- */
  const swatchId = nextId("sw");
  const swatchRow = el("div", { class: "cr-swatches", role: "group", "aria-labelledby": swatchId });
  let swatchBreed: string | null = null;
  const swatchButtons: { b: HTMLButtonElement; primary: string; secondary: string }[] = [];
  syncers.push((c) => {
    if (swatchBreed !== c.breed) {
      swatchBreed = c.breed;
      swatchRow.replaceChildren();
      swatchButtons.length = 0;
      for (const s of ui.preset(c.breed).coatSwatches) {
        const b = el("button", { type: "button", class: "cr-swatch", title: s.label, "aria-label": s.label, "aria-pressed": "false" }, [
          el("span", { class: "cr-swatch-a", style: `background:${s.primary}` }),
          el("span", { class: "cr-swatch-b", style: `background:${s.secondary}` }),
        ]);
        b.addEventListener("click", () =>
          edit((cc) => {
            cc.coat.primary = s.primary;
            cc.coat.secondary = s.secondary;
          }, false),
        );
        swatchRow.append(b);
        swatchButtons.push({ b, primary: s.primary.toLowerCase(), secondary: s.secondary.toLowerCase() });
      }
    }
    for (const s of swatchButtons) {
      const on = s.primary === c.coat.primary.toLowerCase() && s.secondary === c.coat.secondary.toLowerCase();
      s.b.setAttribute("aria-pressed", String(on));
    }
  });
  section(
    "Coat",
    el("div", { class: "cr-field" }, [el("span", { id: swatchId, class: "cr-label", text: "Colours for this breed" }), swatchRow]),
    el("div", { class: "cr-colors" }, [
      color("Main", (c) => c.coat.primary, (c, v) => (c.coat.primary = v)),
      color("Markings", (c) => c.coat.secondary, (c, v) => (c.coat.secondary = v)),
    ]),
    chips("Pattern", ui.patterns, (c) => c.coat.pattern, (c, v) => (c.coat.pattern = v)),
    slider("Fluff", (c) => c.coat.fluff, (c, v) => (c.coat.fluff = v), words(...ui.fluff)),
  );

  /* ---- Face, tail, collar: per species ---- */
  ui.extra({ section, chips, slider, color, toggle });

  /* ---- Section tabs ---- */
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  /** Top of a section in the scroller's coordinates, minus the sticky bar. */
  const sectionTop = (s: HTMLElement) =>
    container.scrollTop + s.getBoundingClientRect().top - container.getBoundingClientRect().top - bar.offsetHeight;
  const tabs = sections.map(({ title, el: s }) => {
    const b = el("button", { type: "button", class: "cr-tab", text: title });
    b.addEventListener("click", () => {
      container.scrollTo({ top: Math.max(0, sectionTop(s) + 1), behavior: reduceMotion.matches ? "auto" : "smooth" });
      setCurrent(s);
    });
    nav.append(b);
    return { b, s };
  });
  let current: HTMLElement | null = null;
  function setCurrent(s: HTMLElement) {
    if (s === current) return;
    current = s;
    for (const t of tabs) {
      if (t.s === s) {
        t.b.setAttribute("aria-current", "true");
        // Keep the tab visible in the (horizontally scrolling) row.
        const left = t.b.offsetLeft - nav.offsetLeft;
        if (left < nav.scrollLeft || left + t.b.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = left - 12;
      } else t.b.removeAttribute("aria-current");
    }
  }
  /** The last section whose top has reached the bar (the last one once scrolled to the end). */
  const trackScroll = () => {
    if (!tabs.length || container.clientHeight === 0) return;
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) return setCurrent(tabs[tabs.length - 1].s);
    let on = tabs[0].s;
    for (const t of tabs) if (sectionTop(t.s) <= container.scrollTop + 8) on = t.s;
    setCurrent(on);
  };
  let scrollFrame = 0;
  const onScroll = () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(() => ((scrollFrame = 0), trackScroll()));
  };
  container.addEventListener("scroll", onScroll, { passive: true });
  cleanups.push(() => {
    container.removeEventListener("scroll", onScroll);
    cancelAnimationFrame(scrollFrame);
  });

  container.replaceChildren(root);
  if (tabs.length) setCurrent(tabs[0].s);

  const syncAll = (c: C) => {
    for (const s of syncers) s(c);
  };
  syncAll(draft);
  const unsubscribe = petStore.subscribe(() => {
    // Changes from elsewhere (or our own commit echoing back). A pending debounced edit is newer.
    const p = petStore.active();
    if (timer !== undefined || !p || p.species !== ui.species) return;
    draft = p.config as unknown as C;
    syncAll(draft);
  });

  return {
    destroy() {
      if (timer !== undefined) commitNow();
      unsubscribe();
      for (const fn of cleanups) fn();
      container.replaceChildren();
    },
  };
}
