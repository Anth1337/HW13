import { DEFAULT_MODEL_ID, type ModelId } from "./models";

type Listener = (id: ModelId) => void;

let current: ModelId = DEFAULT_MODEL_ID;
const listeners = new Set<Listener>();

/** The character the next tap places (and the preview / Quick Look show). Shared by every picker. */
export const selection = {
  get(): ModelId {
    return current;
  },
  set(id: ModelId) {
    if (id === current) return;
    current = id;
    for (const fn of listeners) fn(id);
  },
  /** Calls `fn` on every change. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
