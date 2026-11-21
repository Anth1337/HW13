import { sanitizeCatConfig } from "../cat/config";
import { sanitizeDogConfig } from "../dog/config";
import type { PetCharacter } from "../dog/types";
import { createPetCharacter } from "../models/pet";
import { petStore, sanitizePet } from "../pets";
import type { PetCard } from "./protocol";

/*
 * The kinds of pet that can join a room: a card's `kind` is the pet's species ("dog" | "cat",
 * src/pets.ts). Every species' model is driven by the same PetControls (sit, lie, gait, tricks,
 * petting…), which is what sync.ts sends.
 */

/**
 * The pet this phone brings to the room: the active slot, else the first saved one (so friends
 * still see your pet while you are on the "My pets" menu), else none.
 */
export function localPetCard(): PetCard | null {
  const pet = petStore.active() ?? petStore.slots().find((p) => p) ?? null;
  return pet && { kind: pet.species, config: pet.config };
}

/** Builds a friend's pet from their card, or null for a kind this version doesn't know. */
export function createPetModel(card: PetCard): PetCharacter | null {
  const pet = sanitizePet({ species: card.kind, config: card.config });
  return pet && createPetCharacter(pet);
}

export function petName(card: PetCard | null): string {
  if (card?.kind === "dog") return sanitizeDogConfig(card.config).name.trim() || "A dog";
  if (card?.kind === "cat") return sanitizeCatConfig(card.config).name.trim() || "A cat";
  const name = (card?.config as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 24) : "A pet";
}

export function petEmoji(card: PetCard | null): string {
  return card?.kind === "dog" ? "🐶" : card?.kind === "cat" ? "🐱" : "🐾";
}

/** Petting haptics: purr-like buzzes for a cat (head short, body longer), a single bump for a dog. */
export function petBuzz(species: string, zone: "head" | "body"): number | number[] {
  if (species === "cat") return zone === "head" ? [8, 24, 8, 24, 8, 24, 8] : [8, 24, 8, 24, 8, 24, 8, 24, 8, 24, 8];
  return zone === "head" ? 30 : [20, 40, 20];
}
