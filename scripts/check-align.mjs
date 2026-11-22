// Self-check for "line up" (src/net/sync.ts SharedFrame): `npm run check:align`.
// Two phones see the same room in different world frames (rotated, moved, and on the iPhone a
// wrong scale from the assumed camera height). Both tap the same two real spots; a pet at a real
// spot sent by one phone must land on that same real spot on the other.
import assert from "node:assert/strict";
import { fromShared, sharedFrame, toShared } from "../node_modules/.cache/sync.mjs";

/** Real room point → a phone's world (three.js rotation.y convention, plus scale). */
const phone = (yaw, tx, tz, scale) => ({
  pos: ([x, z]) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: tx + scale * (c * x + s * z), y: 0, z: tz + scale * (-s * x + c * z) };
  },
  yaw: (h) => h + yaw,
});

const A = [0.4, -1.2], B = [1.9, -0.7]; // the two agreed spots (rug corners), real metres
const P = [1.1, 0.6], H = 2.0; // a pet's real spot and heading
const android = phone(0.3, 5, -2, 1);
const iphone = phone(-2.4, -1, 3, 0.8); // tracker scale 20 % off

const fA = sharedFrame(android.pos(A), android.pos(B));
const fI = sharedFrame(iphone.pos(A), iphone.pos(B));
assert.ok(fA && fI);
assert.equal(sharedFrame({ x: 1, y: 0, z: 1 }, { x: 1, z: 1 }), null, "same spot twice: no frame");

// Spot A is the origin and B is (1, 0) on every phone.
const b = iphone.pos(B);
assert.deepEqual(toShared(fI, b.x, b.z, 0).slice(0, 2).map(Math.abs), [1, 0]);

for (const [from, fFrom, to, fTo] of [[android, fA, iphone, fI], [iphone, fI, android, fA]]) {
  const p = from.pos(P);
  const w = toShared(fFrom, p.x, p.z, from.yaw(H));
  const got = fromShared(fTo, w[0], w[1], { x: 0, z: 0 });
  const want = to.pos(P);
  assert.ok(Math.hypot(got.x - want.x, got.z - want.z) < 0.005, `position ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
  const dh = Math.atan2(Math.sin(fTo.yaw + w[2] - to.yaw(H)), Math.cos(fTo.yaw + w[2] - to.yaw(H)));
  assert.ok(Math.abs(dh) < 0.005, `heading off by ${dh}`);
}
console.log("align: ok");
