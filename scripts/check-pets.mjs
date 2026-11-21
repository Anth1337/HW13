// Self-check for the pet slot storage (src/pets.ts): `npm run check:pets`.
// The npm script bundles src/pets.ts to node_modules/.cache/pets.mjs; each fresh() import gets a
// new module instance (a "page reload") over the same in-memory localStorage stub.
import assert from "node:assert/strict";

const data = new Map();
globalThis.localStorage = {
  getItem: (k) => (data.has(k) ? data.get(k) : null),
  setItem: (k, v) => data.set(k, String(v)),
  removeItem: (k) => data.delete(k),
};
let n = 0;
const fresh = () => import(`../node_modules/.cache/pets.mjs?${++n}`);

// Legacy single-dog save → slot 1, nothing active.
data.set("ar-dog-config-v1", JSON.stringify({ name: "Rex", breed: "beagle" }));
let { petStore } = await fresh();
assert.equal(petStore.slots()[0]?.species, "dog");
assert.equal(petStore.slots()[0]?.config.name, "Rex");
assert.equal(petStore.activeSlot(), null);

// Create a cat in slot 3 → active; edits persist; a reload restores slots + active.
petStore.create(2, "cat");
petStore.updateActive({ ...petStore.active().config, name: "Tom" });
({ petStore } = await fresh());
assert.equal(petStore.activeSlot(), 2);
assert.equal(petStore.active()?.species, "cat");
assert.equal(petStore.active()?.config.name, "Tom");
assert.equal(petStore.slots()[0]?.config.name, "Rex", "legacy dog kept after the first save");

// Delete the active slot → nothing active, survives reload; legacy key isn't re-migrated.
petStore.delete(2);
assert.equal(petStore.active(), null);
petStore.delete(0);
({ petStore } = await fresh());
assert.deepEqual([...petStore.slots()], [null, null, null]);

// select() ignores empty slots; corrupt storage → empty slots, no throw.
petStore.select(1);
assert.equal(petStore.activeSlot(), null);
data.set("ar-pets-v1", "{not json");
({ petStore } = await fresh());
assert.deepEqual([...petStore.slots()], [null, null, null]);
data.set("ar-pets-v1", JSON.stringify({ slots: [{ species: "fish" }, null, { species: "cat", config: 7 }], active: 0 }));
({ petStore } = await fresh());
assert.equal(petStore.slots()[0], null);
assert.equal(petStore.slots()[2]?.species, "cat");
assert.equal(petStore.activeSlot(), null, "active pointing at an empty slot is dropped");

console.log("pets: ok");
