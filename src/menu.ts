import { catBreedPreset } from "./cat/config";
import { el } from "./creator";
import { breedPreset } from "./dog/config";
import { SPECIES, petName, petStore, type Pet, type Species } from "./pets";

/*
 * The "My pets" menu: one card per slot (petStore). Filled card: tap to select it (the preview
 * shows it, Deploy deploys it), then Customise or Delete (inline confirm). Empty card: Create →
 * pick a species (from SPECIES, so new species show up here by themselves) → straight into the
 * creator. Re-rendered from the store on every change; keyboard focus is kept across renders.
 */

const emoji = (s: Species) => SPECIES.find((x) => x.species === s)?.emoji ?? "";

/** Breed + sex, e.g. "Labrador ♂". */
function describe(pet: Pet): string {
  const breed = pet.species === "cat" ? catBreedPreset(pet.config.breed).label : breedPreset(pet.config.breed).label;
  return `${breed} ${pet.config.sex === "male" ? "♂" : "♀"}`;
}

export function mountMenu(container: HTMLElement, onCustomise: () => void): void {
  /** The empty slot showing the species picker, and the filled slot asking "Delete?". */
  let picking: number | null = null;
  let confirming: number | null = null;
  /** Element (by data-key) to focus after the next render, when the focused one goes away. */
  let focusNext: string | null = null;

  const button = (key: string, cls: string, children: (Node | string)[], onClick: () => void, attrs: Record<string, string> = {}) => {
    const b = el("button", { type: "button", class: cls, "data-key": key, ...attrs }, children);
    b.addEventListener("click", onClick);
    return b;
  };
  const rerender = (focus: string | null) => {
    focusNext = focus;
    render();
  };

  function card(pet: Pet | null, i: number): HTMLElement {
    const li = el("li", { class: `slot${pet ? "" : " slot-empty"}` });
    const n = i + 1;

    if (!pet) {
      if (picking !== i) {
        li.append(
          button(`create-${i}`, "slot-create", [el("span", { "aria-hidden": "true", text: "+" }), " Create"], () => {
            picking = i;
            rerender(`species-${i}-0`);
          }, {
            "aria-label": `Create a pet in slot ${n}`,
          }),
        );
        return li;
      }
      const labelId = `slot-pick-${i}`;
      const species = el("div", { class: "slot-species", role: "group", "aria-labelledby": labelId });
      SPECIES.forEach((s, k) =>
        species.append(
          button(`species-${i}-${k}`, "slot-species-btn", [el("span", { class: "slot-emoji", "aria-hidden": "true", text: s.emoji }), s.label], () => {
            picking = null;
            petStore.create(i, s.species);
            onCustomise();
          }),
        ),
      );
      li.append(
        el("p", { id: labelId, class: "slot-q", text: "What kind of pet?" }),
        species,
        button(`cancel-${i}`, "cr-link slot-cancel", ["Cancel"], () => {
          picking = null;
          rerender(`create-${i}`);
        }),
      );
      return li;
    }

    const selected = petStore.activeSlot() === i;
    const name = petName(pet);
    li.append(
      button(
        `pick-${i}`,
        "slot-pick",
        [
          el("span", { class: "slot-emoji", "aria-hidden": "true", text: emoji(pet.species) }),
          el("span", { class: "slot-text" }, [el("span", { class: "slot-name", text: name }), el("span", { class: "slot-desc", text: describe(pet) })]),
        ],
        () => {
          confirming = null;
          petStore.select(i);
          render(); // select() doesn't notify when it's already selected
        },
        { "aria-pressed": String(selected), "aria-label": `Slot ${n}: ${name}, ${describe(pet)}` },
      ),
    );
    if (!selected) return li;

    if (confirming === i) {
      li.append(
        el("div", { class: "slot-actions slot-confirm", role: "alertdialog", "aria-label": `Delete ${name}?` }, [
          el("span", { class: "slot-q", text: `Delete ${name}? This can't be undone.` }),
          button(`really-${i}`, "btn slot-btn btn-danger", ["Delete"], () => {
            confirming = null;
            focusNext = `create-${i}`;
            petStore.delete(i);
          }),
          button(`keep-${i}`, "btn slot-btn", ["Cancel"], () => {
            confirming = null;
            rerender(`delete-${i}`);
          }),
        ]),
      );
    } else {
      li.append(
        el("div", { class: "slot-actions" }, [
          button(`edit-${i}`, "btn btn-primary slot-btn", ["Customise"], onCustomise),
          button(`delete-${i}`, "btn slot-btn", ["Delete"], () => {
            confirming = i;
            rerender(`keep-${i}`);
          }, { "aria-label": `Delete ${name}` }),
        ]),
      );
    }
    return li;
  }

  function render() {
    const active = document.activeElement;
    const key = focusNext ?? (active instanceof HTMLElement && container.contains(active) ? active.dataset.key : undefined);
    focusNext = null;
    const list = el("ul", { class: "slots" });
    petStore.slots().forEach((pet, i) => list.append(card(pet, i)));
    container.replaceChildren(el("h2", { class: "menu-h", text: "My pets" }), list);
    if (key) container.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus();
  }

  render();
  petStore.subscribe(render);
}
