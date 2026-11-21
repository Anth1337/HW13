import type { CatCharacter } from "../cat/types";
import type { DogCharacter, PetCharacter } from "../dog/types";
import type { Pet } from "../pets";
import { catGaitInfo, createCatCharacter } from "./cat";
import { createDogCharacter, dogGaitInfo } from "./dog";

/** Builds the 3D animal for a saved pet (the caller owns it: dispose() when replaced). */
export function createPetCharacter(pet: Pet): PetCharacter {
  return pet.species === "cat" ? createCatCharacter(pet.config) : createDogCharacter(pet.config);
}

/** Stride / speed numbers of the character's own gait (see dogGaitInfo), whatever its species. */
export function petGaitInfo(
  c: PetCharacter,
  speed: number,
): { stride: number; metersPerSecond: number; cyclesPerSecond: number } {
  return c.species === "cat" ? catGaitInfo(c as CatCharacter, speed) : dogGaitInfo(c as DogCharacter, speed);
}
