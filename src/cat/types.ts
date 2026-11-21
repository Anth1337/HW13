import type { PetCharacter, Sex } from "../dog/types";

/* ======================================================================================
 * Cat customisation (character creator). Mirrors DogConfig; plain JSON, colours "#rrggbb",
 * every 0..1 slider relative to the breed's own proportions (0.5 = breed standard).
 * ====================================================================================== */

export type CatBreed =
  | "shorthair" // domestic shorthair (tabby by default)
  | "siamese"
  | "maineCoon"
  | "persian"
  | "british"
  | "sphynx"
  | "bengal"
  | "ragdoll"
  | "scottishFold"
  | "moggy"; // mixed / random-bred

/** upright = classic, folded = Scottish fold, tufted = lynx tips (Maine Coon), large = Sphynx/Siamese bat ears. */
export type CatEarStyle = "upright" | "folded" | "tufted" | "large";
/** long = classic, plume = big fluffy, bob = short bobtail, ringed = banded raccoon-ish rings in the secondary colour. */
export type CatTailStyle = "long" | "plume" | "bob" | "ringed";
/** How `primary` / `secondary` are laid out. colorpoint = dark face/ears/paws/tail (Siamese). */
export type CatCoatPattern = "solid" | "tabby" | "bicolor" | "tuxedo" | "colorpoint" | "calico" | "spotted";

export interface CatConfig {
  version: 1;
  name: string;
  breed: CatBreed;
  /** Males (toms) are slightly larger with broader cheeks; females slightly finer. */
  sex: Sex;
  /** Overall scale within the breed's real size range. */
  size: number;
  /** Slim (0) → chonky (1). */
  build: number;
  legLength: number;
  coat: {
    primary: string;
    secondary: string;
    pattern: CatCoatPattern;
    /** 0 = hairless/sleek, 1 = very long-haired (ruff, britches, fluffy tail). */
    fluff: number;
  };
  face: {
    /** Flat (0, Persian) → long wedge (1, Siamese). */
    muzzle: number;
    earStyle: CatEarStyle;
    eyeSize: number;
    eyeColor: string;
    noseColor: string;
    whiskers: boolean;
  };
  tail: CatTailStyle;
  collar: { enabled: boolean; color: string; bell: boolean };
}

export interface CatBreedPreset {
  breed: CatBreed;
  label: string;
  /** Real-world shoulder height in meters for size = 0 and size = 1 (cats ≈ 0.20–0.30). */
  heightRange: [number, number];
  defaults: Omit<CatConfig, "version" | "name" | "sex" | "breed">;
  coatSwatches: { primary: string; secondary: string; label: string }[];
}

/*
 * src/cat/config.ts must export (same shape as src/dog/config.ts):
 *   export const CAT_BREEDS: CatBreedPreset[]
 *   export function catBreedPreset(breed: CatBreed): CatBreedPreset
 *   export function defaultCatConfig(): CatConfig                // a shorthair tabby, e.g. "Mochi"
 *   export function configForCatBreed(breed: CatBreed, keep?: Partial<Pick<CatConfig, "name" | "sex">>): CatConfig
 *   export function randomCatConfig(): CatConfig
 *   export function sanitizeCatConfig(raw: unknown): CatConfig    // validate / clamp / fill defaults, never throws
 *   export const CAT_NAMES: string[]
 *
 * src/models/cat.ts must export:
 *   export function createCatCharacter(config: CatConfig): CatCharacter
 *   export function catGaitInfo(cat: CatCharacter, speed: number): { stride: number; metersPerSecond: number; cyclesPerSecond: number }
 * It reads the same PetControls the dog does (sit, lie = loaf, sniff, excitement = tail up + ears
 * forward + slow tail-tip flick, petHead = eyes closed / slow blink + head rub, petBody = back arch +
 * tail up quiver, trick kinds "pounce" | "stretch" | "groom").
 */

export interface CatCharacter extends PetCharacter {
  readonly species: "cat";
  readonly config: CatConfig;
}
