import { dogConfigStore, sanitizeDogConfig } from "../dog/config";
import type { DogCharacter } from "../dog/types";
import { createDogCharacter } from "../models/dog";
import type { PetCard } from "./protocol";

/*
 * The kinds of pet that can join a room. A kind needs a model whose pose is driven by
 * DogControls (sit, lie, gait, tricks, petting…), because that is what sync.ts sends.
 * Adding cats: give them a "cat" card in localPetCard() and build them in createPetModel().
 */

/** The pet this phone brings to the room. */
export function localPetCard(): PetCard {
  return { kind: "dog", config: dogConfigStore.get() };
}

/** Builds a friend's pet from their card, or null for a kind this version doesn't know. */
export function createPetModel(card: PetCard): DogCharacter | null {
  if (card.kind === "dog") return createDogCharacter(sanitizeDogConfig(card.config));
  return null;
}

export function petName(card: PetCard | null): string {
  if (card?.kind === "dog") return sanitizeDogConfig(card.config).name.trim() || "A dog";
  const name = (card?.config as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 24) : "A pet";
}

export function petEmoji(card: PetCard | null): string {
  return card?.kind === "dog" ? "🐶" : card?.kind === "cat" ? "🐱" : "🐾";
}
