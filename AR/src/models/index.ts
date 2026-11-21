import { dogModel } from "./dog";
import { manModel } from "./man";
import type { ModelId, ModelInfo } from "./types";
import { womanModel } from "./woman";

export type { Character, ModelId, ModelInfo } from "./types";

/** Every placeable character, in the order the picker shows them. */
export const MODELS: ModelInfo[] = [dogModel, womanModel, manModel];

export const DEFAULT_MODEL_ID: ModelId = "dog";

export function getModel(id: ModelId): ModelInfo {
  const model = MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}
