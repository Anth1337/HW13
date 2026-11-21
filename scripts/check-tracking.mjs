// Simulated iPhone (orientation + gyro events, camera frames of a textured floor delivered late)
// through the real WorldTracker. Checks that the measured camera latency is close to the truth and
// that the render pose (getDisplayPose) matches the frame on screen ("the pet sticks").
// Run: npm run check:tracking
import { createWorldTracker, deviceQuaternion } from "../node_modules/.cache/tracking.mjs";

function simulate(CASE) {
const LAG = CASE.lag; // ms: true capture -> presentation latency
const FPS = 30;
const GYRO = true;
const ORI_HZ = 60;
const H = 1.3;
const W = 192, HH = 144;
const FOV_TRUE = CASE.fov;
const F = W / 2 / Math.tan((FOV_TRUE * Math.PI) / 360);

// Phone motion: pointing down at the floor (beta ~ 50 deg), looking around (alpha), slight roll.
// Still for the first 2 s (the tracker zeroes yaw at its first sample; the test aligns frames then), then ramps in.
const ramp = (t) => { const u = Math.max(0, Math.min(1, (t - 3000) / 1500)); return u * u * (3 - 2 * u); };
const alpha = (t) => ramp(t) * (20 * Math.sin(t * 1.3e-3) + 9 * Math.sin(t * 3.7e-3 + 1) + 2.5 * Math.sin(t * 9.1e-3) + 1.2 * Math.sin(t * 14.3e-3 + 2));
const beta = (t) => 50 + ramp(t) * (8 * Math.sin(t * 1.9e-3 + 0.5) + 2 * Math.sin(t * 8.3e-3) + 1 * Math.sin(t * 13.1e-3 + 1));
const gamma = (t) => ramp(t) * 2 * Math.sin(t * 2.9e-3);
const qTrue = (t, o) => deviceQuaternion(alpha(t), beta(t), gamma(t), 0, o);

// Floor texture: smooth pseudo-random blobs, procedural.
const tex = (x, z) => {
  let v = 0;
  for (let k = 0; k < 6; k++) {
    const s = 3 + k * 2.3;
    v += Math.sin(x * s + k * 1.7) * Math.sin(z * s * 1.13 + k * 0.9) * (40 / (k + 1));
  }
  return 128 + v + 25 * Math.sin(x * 23.1) * Math.sin(z * 19.7);
};

const rot = (q, v) => { // rotate vector v by unit quaternion q
  const { x, y, z, w } = q, [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};

let clock = 1000;
const target = new EventTarget();
const grabber = {
  width: W, height: HH, gray: new Uint8Array(W * HH),
  frameT: 0,
  grab() {
    const q = qTrue(this.frameT - LAG, {});
    for (let py = 0; py < HH; py++) for (let px = 0; px < W; px++) {
      const d = rot(q, [(px + 0.5 - W / 2) / F, -(py + 0.5 - HH / 2) / F, -1]);
      let val = 90;
      if (d[1] < -1e-3) { const t = H / -d[1]; val = tex(d[0] * t, d[2] * t); }
      this.gray[py * W + px] = Math.max(0, Math.min(255, val));
    }
    return true;
  },
};
const tracker = createWorldTracker({ cameraHeight: H, fovLongSideDeg: 65 }, { target, now: () => clock, screenAngle: () => 0, grabber });
const video = { currentTime: 0, readyState: 4, videoWidth: 1280, videoHeight: 960 };

const angle = (a, b) => { const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w); return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI; };
const qMul = (a, b) => ({ x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z });
const qInv = (a) => ({ x: -a.x, y: -a.y, z: -a.z, w: a.w });
const pose = () => ({ position: { set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, quaternion: { set(x, y, z, w) { Object.assign(this, { x, y, z, w }); } } });

let nextOri = clock, nextFrame = clock, frameNo = 0, yz = null;
const errOld = [], errNew = [], posDrift = [];
const END = clock + 24000;
for (; clock < END; clock += 1) {
  if (clock >= nextOri) {
    const ev = new Event("deviceorientation");
    Object.assign(ev, { alpha: alpha(clock), beta: beta(clock), gamma: gamma(clock) });
    Object.defineProperty(ev, "timeStamp", { value: clock });
    target.dispatchEvent(ev);
    if (GYRO) { // rotationRate (deg/s) in camera-local axes: beta = x, gamma = y, alpha = z (screen angle 0)
      const a = qTrue(clock - 2, {}), b = qTrue(clock + 2, {});
      const d = qMul(qInv(a), b); const sg = d.w < 0 ? -1 : 1; const k = (2 / 0.004) * sg * (180 / Math.PI);
      const m = new Event("devicemotion");
      Object.assign(m, { rotationRate: { beta: d.x * k, gamma: d.y * k, alpha: d.z * k } });
      Object.defineProperty(m, "timeStamp", { value: clock });
      target.dispatchEvent(m);
    }
    nextOri += 1000 / ORI_HZ;
  }
  if (clock >= nextFrame) { // a new camera frame is presented now; it was captured LAG ago
    grabber.frameT = clock;
    video.currentTime = ++frameNo / FPS;
    nextFrame += 1000 / FPS;
  }
  if (clock % 16 === 0) { // render at ~60 Hz
    tracker.processFrame(video, clock);
    const truth = qTrue(grabber.frameT - LAG, {}); // pose of the frame on screen (device world)
    const pNew = tracker.getDisplayPose(pose());
    const pOld = tracker.getPose(pose());
    if (clock < 2500) { yz = qMul(pNew.quaternion, qInv(truth)); continue; } // tracker world = yz * device world
    const truthTrk = qMul(yz, truth);
    if (clock > 1000 + 12000) { // after the calibration has had time to converge
      errOld.push(angle(pOld.quaternion, truthTrk));
      errNew.push(angle(pNew.quaternion, truthTrk));
      posDrift.push(Math.hypot(pNew.position.x, pNew.position.z));
    }
  }
}
const rms = (a) => Math.sqrt(a.reduce((m, v) => m + v * v, 0) / a.length);
const toPx = (deg) => ((deg * Math.PI) / 180) * (390 / 2 / Math.tan((60 * Math.PI) / 360)); // 390 px wide phone screen
return { lag: LAG, fov: FOV_TRUE, latency: tracker.latencyMs, measuredFov: tracker.fovLongSideDeg, oldPx: toPx(rms(errOld)), newPx: toPx(rms(errNew)), drift: Math.max(...posDrift) };
}

const CASES = [
  { lag: 110, fov: 65 },
  { lag: 70, fov: 58 },
  { lag: 140, fov: 72 },
  { lag: 100, fov: 50 },
];
let failed = 0;
for (const c of CASES) {
  const r = simulate(c);
  const ok = Math.abs(r.latency - c.lag) < 15 && r.newPx < 10 && r.newPx < r.oldPx / 2;
  if (!ok) failed++;
  console.log(
    `${ok ? "ok  " : "FAIL"} camera delay ${c.lag} ms / FOV ${c.fov} deg: measured ${r.latency.toFixed(0)} ms / ${r.measuredFov.toFixed(1)} deg; ` +
      `swim ${r.oldPx.toFixed(1)} px (pose of now) -> ${r.newPx.toFixed(1)} px (pose of the frame on screen); drift turning in place ${r.drift.toFixed(2)} m`,
  );
}
if (failed) {
  console.error(`tracking: ${failed} case(s) failed`);
  process.exit(1);
}
console.log("tracking: ok");
