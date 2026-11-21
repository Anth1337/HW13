import * as THREE from "three";
import { dogGaitInfo } from "../models/dog";
import type { PerceivedFace, PerceivedHand } from "../vision/types";
import { TRICK_DURATION } from "./types";
import type { DogBrain, DogCharacter, DogCommand, DogMode, DogZones, TrickKind } from "./types";

/*
 * The dog's brain: perception (hands + faces in world space) + commands → anchor movement and
 * smoothed DogControls. The model is stateless, so all timing, easing and gait-phase integration
 * live here. Every smoothing step is frame-rate independent (exponential with a time constant,
 * or rate-limited linear ramps), and per-frame work is allocation-free.
 *
 * Each frame:
 *   1. perception bookkeeping (petting zones, engaged hand, eye-contact partner)
 *   2. behaviour picks ONE locomotion goal (`want`: target point / speed / facing), by priority:
 *      trick > hand > come / goTo > mode (follow / free / stay)
 *   3. postures (sit / lie / stand-up-before-walking) and locomotion steer the anchor
 *   4. look target (hand > eye contact > glance at the user > idle), sniff, excitement, status
 *
 * Vision runs at ~10–15 Hz while this runs per rendered frame, so every "is X happening" test
 * tolerates short dropouts (dwell + release timers keyed on the brain clock).
 */

// ---- Tuning ------------------------------------------------------------------------------

const DEG = Math.PI / 180;

// Movement.
const FOLLOW_START = 1.6; // m from the user before the dog sets off after them
const FOLLOW_STOP = 0.8; // m from the user where it stops
const COME_DIST = 0.6; // m in front of the user (nose)
const FREE_RADIUS = 2.1; // m: wander targets are within this of the user (limit 2.5)
const FREE_LIMIT = 2.5;
const VIEWER_KEEPOUT = 0.35; // m: the nose never gets closer than this to the camera (floor plane)
const TURN_FACE_START = 35 * DEG; // idle: turn to face the user when further round than this
const TURN_FACE_STOP = 6 * DEG;

// Postures (linear ramps, eased on output).
const POSTURE_DOWN_S = 0.5; // stand → sit / lie
const POSTURE_UP_S = 0.4; // sit / lie → stand
const STOPPED_V = 0.05; // m/s: "stopped" for posture changes / tricks
const SHUFFLE_DIST = 0.3; // m: closer targets are reached by shuffling, without turning towards them

// Hands.
const HAND_MAX_AGE = 0.4;
const HAND_MIN_CONF = 0.3;
const PET_DWELL = 0.2;
const PET_DROPOUT = 0.35;
const PET_RELEASE = 0.5;
const PET_MIN_DETECTIONS = 2; // distinct detections before a session starts (one noisy frame is not enough)
const HAND_NEAR_NOSE = 0.6; // m
const HAND_LOW_ABOVE = 0.5; // m above floor + dog height
const HAND_FRONT_RANGE = 1.5; // m
const HAND_STILL = 0.4; // m/s
const HAND_KEEP_NEAR = 0.9; // relaxed thresholds while engaged (hysteresis)
const HAND_KEEP_RANGE = 2.0;
const HAND_KEEP_SPEED = 0.9;
const HAND_RELEASE = 1.0; // s after the hand stops qualifying
const SNIFF_STANDOFF = 0.12; // m nose → palm
const LURE_STANDOFF = 0.25; // m while the hand moves
const FINGERTIPS = [4, 8, 12, 16, 20];

// Eye contact (faces).
const COS_ENTER = Math.cos(18 * DEG);
const COS_STAY = Math.cos(26 * DEG);
const MAX_LOOK_DIST = 6;
const MIN_FACE_CONF = 0.3;
const MAX_LOOK_AGE = 0.5;
const CANDIDATE_DWELL = 0.35;
const MIN_DISTINCT_DETECTIONS = 2;
const PARTNER_LOOK_AWAY = 0.8;
const SWITCH_LOOK_AWAY = 0.35;
const VANISH_AGE = 1;
const FORGET_AFTER = 2;

const EXCITE_BASE = 0.25;
const FAST_FORWARD_S = 0.4; // a queued trick fast-forwards the running one to its end this quickly

// ---- Helpers -----------------------------------------------------------------------------

/** Frame-rate independent smoothing factor for a time constant tau (s). */
function k(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau);
}
function approach(x: number, target: number, dt: number, tau: number): number {
  return x + (target - x) * k(dt, tau);
}
function ramp(x: number, target: number, maxStep: number): number {
  const d = target - x;
  return Math.abs(d) <= maxStep ? target : x + Math.sign(d) * maxStep;
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function ease(x: number): number {
  return x * x * (3 - 2 * x);
}
/** Wrap an angle to (-π, π]. */
function wrap(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}
function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

type Zone = "head" | "body";
type Posture = "stand" | "sit" | "lie";

interface PetState {
  active: boolean;
  dwellStart: number | null;
  dets: number;
  lastHit: number;
  point: THREE.Vector3; // smoothed world hit point
  hitPoint: THREE.Vector3; // this frame's
}

interface FaceTrack {
  id: number;
  seen: boolean;
  lastSeen: number;
  head: THREE.Vector3;
  dist: number;
  looking: boolean;
  lookStart: number;
  lastLook: number;
  prevAge: number;
  lookDets: number;
}

export function createDogBrain(dog: DogCharacter, anchor: THREE.Object3D, floorYIn: number): DogBrain {
  const controls = dog.controls;
  const name = dog.config.name || "Your dog";
  let floorY = floorYIn;
  let now = 0;

  // ---- Size-dependent locomotion numbers ----
  const sf = clamp(dog.height / 0.57, 0.45, 1.15);
  const V_WALK = 0.6 * sf;
  const V_TROT = 1.2 * sf;
  const V_RUN = 2.0 * sf;
  const ACCEL = 1.6 * sf;
  const DECEL = 2.4 * sf;
  const TURN_WALK = 2.5; // rad/s
  const TURN_STAND = 4;

  // Stride table (meters per gait cycle) from the model so paws don't skate. Below gait speed
  // 0.3 the model scales the step linearly with speed, so stride ∝ speed there.
  const STRIDE_STEP = 0.05;
  const STRIDE_MIN = 0.3;
  const strideTable: number[] = [];
  for (let s = STRIDE_MIN; s <= 1.2 + 1e-6; s += STRIDE_STEP) strideTable.push(dogGaitInfo(dog, s).stride);
  function strideAt(gs: number): number {
    if (gs <= STRIDE_MIN) return strideTable[0] * (gs / STRIDE_MIN);
    const f = (Math.min(gs, 1.2) - STRIDE_MIN) / STRIDE_STEP;
    const i = Math.min(Math.floor(f), strideTable.length - 2);
    const w = f - i;
    return strideTable[i] * (1 - w) + strideTable[i + 1] * w;
  }
  /** Ground speed (m/s) → normalised gait speed (0.4 walk, 0.7 trot, 1 run). */
  function gaitSpeedFor(v: number): number {
    if (v <= V_WALK) return (0.4 * v) / V_WALK;
    if (v <= V_TROT) return 0.4 + (0.3 * (v - V_WALK)) / (V_TROT - V_WALK);
    return Math.min(1.1, 0.7 + (0.3 * (v - V_TROT)) / (V_RUN - V_TROT));
  }

  // ---- Scratch (allocation-free per frame) ----
  const invRoot = new THREE.Matrix4();
  const zones: DogZones = { head: new THREE.Sphere(), body: new THREE.Sphere() };
  const eyes = new THREE.Vector3();
  const nose = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const viewerW = new THREE.Vector3();
  const viewerFwd = new THREE.Vector3();
  const desiredW = new THREE.Vector3();
  const lookW = new THREE.Vector3();
  const lookLocal = new THREE.Vector3();
  const petLocal = new THREE.Vector3();
  let lookTargetValid = false;

  // ---- Locomotion state ----
  let yaw = anchor.rotation.y;
  let v = 0; // forward speed m/s
  let yawRate = 0;
  let facingTurn = false; // in-place turn hysteresis
  let shuffling = false; // moving to a close target without turning towards it
  let noseF = Math.max(0.1, dog.length * 0.5); // anchor → nose, forward (m), measured when standing
  let noseH = dog.height * 0.75; // nose height above the floor when standing

  /** The behaviour layer's goal for this frame. */
  const want = {
    move: false,
    x: 0,
    z: 0,
    vMax: 0,
    arrive: 0.05,
    face: false,
    fx: 0,
    fz: 0,
  };
  let arrived = false; // set by locomotion: reached want.x/z this frame

  // ---- Modes / commands ----
  let mode: DogMode = "follow";
  let postureCmd: Posture = "stand"; // commanded (or autonomously chosen) posture
  let autoPosture = false; // postureCmd was chosen by the dog itself (cancel when it needs to move)
  let sitLin = 0;
  let lieLin = 0;
  let comeActive = false;
  let goToActive = false;
  const goToPt = new THREE.Vector3();
  let following = false; // follow mode: currently catching up
  let comeFacing = false; // come: arrived, turning to face the user

  // Free roam.
  let freeHasTarget = false;
  let freeTx = 0;
  let freeTz = 0;
  let freeTrot = false;
  let freeReplanAt = 0;
  let freeActivity: "none" | "sniff" | "lie" = "none";
  let freeActivityUntil = 0;

  // Idle (follow / stay).
  let idleSince = 0;
  let nextIdleSniff = rand(5, 10);
  let idleSniffUntil = -1;
  let nextAutoSit = rand(14, 28);

  // ---- Hands / petting ----
  const pets: Record<Zone, PetState> = {
    head: { active: false, dwellStart: null, dets: 0, lastHit: -Infinity, point: new THREE.Vector3(), hitPoint: new THREE.Vector3() },
    body: { active: false, dwellStart: null, dets: 0, lastHit: -Infinity, point: new THREE.Vector3(), hitPoint: new THREE.Vector3() },
  };
  const petListeners = new Set<(zone: Zone, worldPoint: THREE.Vector3) => void>();
  const handPrevAge = new Map<number, number>(); // distinct-detection bookkeeping
  let freshMask = 0; // bit i = hands[i] is a new detection this frame (first 31 hands)

  let engagedId: number | null = null;
  let engagedLastOk = -Infinity;
  let engagedSeen = false; // the engaged hand is in this frame's fresh perception
  let engagedSpeed = 0;
  let engagedNear = false; // nearCamera hand: look only
  const engagedPalm = new THREE.Vector3();
  let handSniffing = false;

  // ---- Faces ----
  const faceTracks = new Map<number, FaceTrack>();
  const facePool: FaceTrack[] = [];
  let partner: number | null = null;

  // Glances at the user.
  let glanceLeft = 0;
  let nextGlance = rand(2, 5);

  // ---- Tricks (queue of one) ----
  const trickState = { kind: "jump" as TrickKind, progress: 0 };
  let trickRunning = false;
  let trickElapsed = 0;
  let trickRate = 1;
  let queued: TrickKind | null = null; // after the running one
  let pendingTrick: TrickKind | null = null; // waiting for the dog to stop / stand up
  let postureBeforeTrick: Posture = "stand";

  let excitement = EXCITE_BASE;
  let status = "";

  // ---------------------------------------------------------------------------------------

  function trickStatus(kind: TrickKind): string {
    return kind === "rollOver" ? "Rolling over!" : kind === "jump" ? "Jumping!" : "Spinning!";
  }

  function resetPets(): void {
    for (const z of ["head", "body"] as const) {
      pets[z].active = false;
      pets[z].dwellStart = null;
      pets[z].dets = 0;
    }
  }

  function startTrick(kind: TrickKind): void {
    trickRunning = true;
    trickElapsed = 0;
    trickRate = 1;
    trickState.kind = kind;
    trickState.progress = 0;
    controls.trick = trickState;
    resetPets();
  }

  function setPosture(p: Posture, auto: boolean): void {
    postureCmd = p;
    autoPosture = auto && p !== "stand";
  }

  function viewerFloorX(): number {
    return viewerW.x;
  }
  function viewerFloorZ(): number {
    return viewerW.z;
  }

  function setWant(x: number, z: number, vMax: number, arrive: number): void {
    want.move = true;
    want.x = x;
    want.z = z;
    want.vMax = vMax;
    want.arrive = arrive;
  }
  function setFace(x: number, z: number): void {
    want.face = true;
    want.fx = x;
    want.fz = z;
  }

  /** Pushes a nose target (x, z) out of the viewer keep-out circle; result in tmp.x / tmp.z. */
  function keepOutNose(x: number, z: number, radius: number): void {
    const dx = x - viewerFloorX();
    const dz = z - viewerFloorZ();
    const d = Math.hypot(dx, dz);
    if (d >= radius) {
      tmp.set(x, 0, z);
    } else if (d > 1e-4) {
      tmp.set(viewerFloorX() + (dx / d) * radius, 0, viewerFloorZ() + (dz / d) * radius);
    } else {
      tmp.set(viewerFloorX() + Math.sin(yaw) * radius, 0, viewerFloorZ() + Math.cos(yaw) * radius);
    }
  }

  // ---- Petting ---------------------------------------------------------------------------

  function updateHandsBookkeeping(hands: readonly PerceivedHand[]): void {
    freshMask = 0;
    for (let i = 0; i < hands.length; i++) {
      const h = hands[i];
      const prev = handPrevAge.get(h.id);
      const age = Math.max(0, h.age);
      if (prev === undefined || age < prev - 1e-6) {
        if (i < 31) freshMask |= 1 << i;
      }
      handPrevAge.set(h.id, age);
    }
    if (handPrevAge.size > 8) {
      for (const id of handPrevAge.keys()) {
        let found = false;
        for (const h of hands) if (h.id === id) found = true;
        if (!found) handPrevAge.delete(id);
      }
    }
  }

  /** A hand the dog is sniffing (below eye level, around the muzzle / chin) is not a head pat:
   *  pats come from above or behind the eyes. */
  function muzzleRegion(p: THREE.Vector3): boolean {
    const ahead = (p.x - eyes.x) * Math.sin(yaw) + (p.z - eyes.z) * Math.cos(yaw);
    return ahead > -0.05 && p.y < eyes.y - 0.01;
  }

  function testZone(z: THREE.Sphere, h: PerceivedHand, out: THREE.Vector3, excludeMuzzle: boolean): boolean {
    let best = Infinity;
    if (z.containsPoint(h.palm) && !(excludeMuzzle && muzzleRegion(h.palm))) {
      best = h.palm.distanceToSquared(z.center);
      out.copy(h.palm);
    }
    for (const i of FINGERTIPS) {
      const p = h.points[i];
      if (!p || !z.containsPoint(p) || (excludeMuzzle && muzzleRegion(p))) continue;
      const d = p.distanceToSquared(z.center);
      if (d < best) {
        best = d;
        out.copy(p);
      }
    }
    return best < Infinity;
  }

  function updatePetting(hands: readonly PerceivedHand[], dt: number): void {
    dog.getZones(zones);
    let headHit = false;
    let bodyHit = false;
    let headFresh = false;
    let bodyFresh = false;
    for (let i = 0; i < hands.length; i++) {
      const h = hands[i];
      if (h.age >= HAND_MAX_AGE || h.confidence < HAND_MIN_CONF) continue;
      const fresh = i < 31 && (freshMask & (1 << i)) !== 0;
      // Head wins over body when a hand overlaps both.
      // The muzzle exclusion only gates the START of a head session (the head lifts into the hand).
      if (!headHit && testZone(zones.head, h, pets.head.hitPoint, !pets.head.active)) {
        headHit = true;
        headFresh = headFresh || fresh;
      } else if (!bodyHit && testZone(zones.body, h, pets.body.hitPoint, false)) {
        bodyHit = true;
        bodyFresh = bodyFresh || fresh;
      }
    }
    stepZone("head", headHit, headFresh, dt);
    stepZone("body", bodyHit, bodyFresh, dt);
  }

  function stepZone(zone: Zone, hit: boolean, fresh: boolean, dt: number): void {
    const s = pets[zone];
    if (hit) {
      if (s.dwellStart === null || now - s.lastHit > PET_DROPOUT) {
        s.dwellStart = now;
        s.dets = 0;
      }
      if (fresh) s.dets++;
      s.lastHit = now;
      if (s.active) {
        s.point.lerp(s.hitPoint, k(dt, 0.05));
      } else if (!trickRunning && pendingTrick === null && now - s.dwellStart >= PET_DWELL && s.dets >= PET_MIN_DETECTIONS) {
        s.active = true;
        s.point.copy(s.hitPoint);
        tmp.copy(s.hitPoint);
        for (const fn of petListeners) fn(zone, tmp);
      }
    } else if (s.active ? now - s.lastHit > PET_RELEASE : now - s.lastHit > PET_DROPOUT) {
      s.active = false;
      s.dwellStart = null;
      s.dets = 0;
    }
  }

  // ---- Hand engagement ---------------------------------------------------------------------

  /** 0 = no interest, 1 = look only (near camera), 2 = engage. `keep` relaxes thresholds. */
  function handInterest(h: PerceivedHand, keep: boolean): number {
    if (h.age >= HAND_MAX_AGE || h.confidence < HAND_MIN_CONF) return 0;
    if (h.nearCamera) return 1;
    const noseD = h.palm.distanceTo(nose);
    const speed = h.velocity.length();
    if (noseD < (keep ? HAND_KEEP_NEAR : HAND_NEAR_NOSE)) return 2;
    const low = h.palm.y < floorY + dog.height + HAND_LOW_ABOVE;
    if (!low) return 0;
    const dx = h.palm.x - anchor.position.x;
    const dz = h.palm.z - anchor.position.z;
    const d = Math.hypot(dx, dz);
    if (keep) return d < HAND_KEEP_RANGE && speed < HAND_KEEP_SPEED ? 2 : 0;
    if (d > HAND_FRONT_RANGE || speed >= HAND_STILL) return 0;
    const ang = Math.abs(wrap(Math.atan2(dx, dz) - yaw));
    return ang < 80 * DEG || d < 0.5 ? 2 : 0;
  }

  function updateEngagement(hands: readonly PerceivedHand[]): void {
    engagedSeen = false;
    // Keep the current hand while it still qualifies (relaxed).
    if (engagedId !== null) {
      for (const h of hands) {
        if (h.id !== engagedId) continue;
        const lvl = handInterest(h, true);
        if (lvl > 0) {
          engagedSeen = true;
          engagedLastOk = now;
          engagedPalm.copy(h.palm);
          engagedSpeed = h.velocity.length();
          engagedNear = lvl === 1;
        }
      }
      if (!engagedSeen && now - engagedLastOk > HAND_RELEASE) engagedId = null;
    }
    if (engagedSeen) return;
    // Look for a (better) hand: engaging ones beat look-only ones, then the nearest to the nose.
    let best: PerceivedHand | null = null;
    let bestLvl = 0;
    let bestD = Infinity;
    for (const h of hands) {
      const lvl = handInterest(h, false);
      if (lvl === 0) continue;
      const d = h.palm.distanceTo(nose);
      if (lvl > bestLvl || (lvl === bestLvl && d < bestD)) {
        best = h;
        bestLvl = lvl;
        bestD = d;
      }
    }
    if (best) {
      engagedId = best.id;
      engagedSeen = true;
      engagedLastOk = now;
      engagedPalm.copy(best.palm);
      engagedSpeed = best.velocity.length();
      engagedNear = bestLvl === 1;
    }
  }

  // ---- Faces (eye contact) -----------------------------------------------------------------

  function updateFaces(faces: readonly PerceivedFace[]): void {
    for (const t of faceTracks.values()) t.seen = false;
    for (const f of faces) {
      let t = faceTracks.get(f.id);
      if (!t) {
        t = facePool.pop() ?? {
          id: 0, seen: false, lastSeen: 0, head: new THREE.Vector3(), dist: Infinity, looking: false,
          lookStart: 0, lastLook: -Infinity, prevAge: Infinity, lookDets: 0,
        };
        t.id = f.id;
        t.looking = false;
        t.lastLook = -Infinity;
        t.prevAge = Infinity;
        t.lookDets = 0;
        faceTracks.set(f.id, t);
      }
      t.seen = true;
      const age = Math.max(0, f.age);
      const fresh = age < t.prevAge - 1e-6;
      t.prevAge = age;
      t.lastSeen = now - age;
      t.head.copy(f.head);
      t.dist = f.head.distanceTo(eyes);
      let looking = false;
      if (age < MAX_LOOK_AGE && f.confidence >= MIN_FACE_CONF && t.dist <= MAX_LOOK_DIST) {
        tmp.subVectors(eyes, f.head);
        const len = tmp.length();
        const glen = f.gaze.length();
        if (len > 1e-4 && glen > 1e-4) {
          looking = tmp.dot(f.gaze) / (len * glen) >= (t.looking ? COS_STAY : COS_ENTER);
        }
      }
      if (looking && !t.looking) {
        t.lookStart = now;
        t.lookDets = 0;
      }
      if (looking && fresh) t.lookDets++;
      t.looking = looking;
      if (looking) t.lastLook = now;
    }
    for (const [id, t] of faceTracks) {
      if (t.seen) continue;
      t.looking = false;
      if (now - t.lastSeen > FORGET_AFTER) {
        faceTracks.delete(id);
        facePool.push(t);
      }
    }
  }

  function bestFace(except: number | null): FaceTrack | null {
    let best: FaceTrack | null = null;
    for (const t of faceTracks.values()) {
      if (t.id === except || !t.looking || now - t.lookStart < CANDIDATE_DWELL) continue;
      if (t.lookDets < MIN_DISTINCT_DETECTIONS) continue;
      if (!best) {
        best = t;
        continue;
      }
      const dStart = t.lookStart - best.lookStart;
      if (dStart < -0.05 || (Math.abs(dStart) <= 0.05 && t.dist < best.dist)) best = t;
    }
    return best;
  }

  function updatePartner(allowed: boolean): void {
    if (!allowed) {
      partner = null;
      return;
    }
    const p = partner !== null ? faceTracks.get(partner) : undefined;
    if (p && now - p.lastSeen <= VANISH_AGE && now - p.lastLook <= PARTNER_LOOK_AWAY) {
      if (p.looking) return;
      const other = bestFace(p.id);
      if (other && now - p.lastLook >= SWITCH_LOOK_AWAY) partner = other.id;
      return;
    }
    const c = bestFace(null);
    partner = c ? c.id : null;
  }

  // ---- Behaviour ---------------------------------------------------------------------------

  type Activity =
    | "trick"
    | "petHead"
    | "petBody"
    | "handSniff"
    | "handApproach"
    | "handLure"
    | "handWatch"
    | "come"
    | "goTo"
    | "follow"
    | "free"
    | "stay";
  let activity: Activity = "follow";

  function chooseBehaviour(): void {
    want.move = false;
    want.face = false;
    handSniffing = false;
    const ux = viewerFloorX();
    const uz = viewerFloorZ();
    const ax = anchor.position.x;
    const az = anchor.position.z;

    // 1. Trick (running or waiting to start).
    if (trickRunning || pendingTrick !== null) {
      activity = "trick";
      return;
    }

    // 2a. Petting: stop, face / lean into it.
    if (pets.head.active || pets.body.active) {
      activity = pets.head.active ? "petHead" : "petBody";
      if (pets.head.active && postureCmd === "stand") {
        const p = pets.head.point;
        const ang = Math.abs(wrap(Math.atan2(p.x - ax, p.z - az) - yaw));
        if (ang > 50 * DEG) setFace(p.x, p.z);
      }
      return;
    }

    // 2b. A hand of interest.
    if (engagedId !== null) {
      // Don't walk off while a hand is settling into a petting zone.
      const dwelling = pets.head.dwellStart !== null || pets.body.dwellStart !== null;
      const canMove = mode !== "stay" && !engagedNear && !dwelling;
      if (engagedNear) {
        activity = "handWatch";
        return;
      }
      const moving = engagedSpeed >= HAND_STILL;
      const px = engagedPalm.x;
      const pz = engagedPalm.z;
      let dx = px - ax;
      let dz = pz - az;
      let d = Math.hypot(dx, dz);
      if (d < 1e-3) {
        dx = Math.sin(yaw);
        dz = Math.cos(yaw);
        d = 1;
      }
      dx /= d;
      dz /= d;
      const dh = engagedPalm.y - (floorY + noseH); // vs the standing nose: sniffing lowers it
      const want3 = moving ? LURE_STANDOFF : SNIFF_STANDOFF;
      // Keep the nose a little in front of the palm horizontally (sniffing reaches down/forward).
      const horiz = Math.max(0.08, Math.sqrt(Math.max(0, want3 * want3 - dh * dh)));
      // Nose target, kept out of the camera's way, then the anchor behind it.
      keepOutNose(px - dx * horiz, pz - dz * horiz, VIEWER_KEEPOUT);
      const tx = tmp.x - dx * noseF;
      const tz = tmp.z - dz * noseF;
      const noseToPalm = engagedPalm.distanceTo(nose);
      if (noseToPalm < 0.3 && !moving) {
        handSniffing = true;
        activity = "handSniff";
      } else {
        activity = moving ? "handLure" : "handApproach";
      }
      if (canMove && engagedSeen) {
        const dist = Math.hypot(tx - ax, tz - az);
        // Small adjustments are not worth getting up / walking for.
        const minMove = postureCmd === "stand" ? 0.04 : 0.25;
        if (dist > minMove || (v > 0.02 && dist > 0.015)) {
          setWant(tx, tz, moving ? V_WALK : Math.min(V_TROT, 0.6 * V_WALK + 0.5 * dist), 0.02);
        }
      }
      // Face the hand (used while standing or shuffling; ignored when it's right overhead).
      if (postureCmd === "stand" && Math.hypot(px - ax, pz - az) > 0.6 * noseF) setFace(px, pz);
      return;
    }

    // 3. come / goTo.
    if (comeActive) {
      activity = "come";
      let fx = viewerFwd.x;
      let fz = viewerFwd.z;
      let fl = Math.hypot(fx, fz);
      if (fl < 0.2) {
        // Looking straight down: come from the dog's side.
        fx = ax - ux;
        fz = az - uz;
        fl = Math.hypot(fx, fz);
      }
      if (fl < 1e-4) {
        fx = 0;
        fz = 1;
        fl = 1;
      }
      fx /= fl;
      fz /= fl;
      const r = Math.max(COME_DIST, VIEWER_KEEPOUT) + noseF;
      const tx = ux + fx * r;
      const tz = uz + fz * r;
      if (!comeFacing) {
        setWant(tx, tz, speedForDistance(Math.hypot(tx - ax, tz - az)), 0.06);
      } else {
        setFace(ux, uz);
        const ang = Math.abs(wrap(Math.atan2(ux - ax, uz - az) - yaw));
        if (ang < 10 * DEG) {
          comeActive = false;
          comeFacing = false;
          mode = "follow";
          following = false;
          resetIdle();
        }
      }
      return;
    }
    if (goToActive) {
      activity = "goTo";
      setWant(goToPt.x, goToPt.z, speedForDistance(Math.hypot(goToPt.x - ax, goToPt.z - az)), 0.02);
      return;
    }

    // 4. Modes.
    const du = Math.hypot(ax - ux, az - uz);
    if (mode === "follow") {
      activity = "follow";
      if (!following && du > FOLLOW_START) following = true;
      if (following) {
        let ox = ax - ux;
        let oz = az - uz;
        const ol = Math.max(du, 1e-4);
        ox /= ol;
        oz /= ol;
        const stop = Math.max(FOLLOW_STOP, VIEWER_KEEPOUT + noseF + 0.08);
        const tx = ux + ox * stop;
        const tz = uz + oz * stop;
        const dt = Math.hypot(tx - ax, tz - az);
        if (dt < 0.08 && v < 0.1) {
          following = false;
          resetIdle();
        } else {
          setWant(tx, tz, speedForDistance(dt), 0.05);
          return;
        }
      }
      idleBehaviour(ux, uz, true);
      return;
    }
    if (mode === "free") {
      activity = "free";
      freeBehaviour(ux, uz, du);
      return;
    }
    // stay
    activity = "stay";
    if (postureCmd === "stand") {
      // Stand-stay: may turn to face the user, nothing else.
      idleBehaviour(ux, uz, false);
    }
  }

  function speedForDistance(d: number): number {
    // Walk for short hops, trot for medium, run when far behind.
    const t = clamp((d - 1.0) / 2.0, 0, 1);
    return V_WALK + (V_RUN - V_WALK) * ease(t);
  }

  function resetIdle(): void {
    idleSince = now;
    nextIdleSniff = now + rand(4, 9);
    nextAutoSit = now + rand(14, 28);
  }

  /** Close to the user (follow) or standing-stay: face the user, sniff around, maybe sit. */
  function idleBehaviour(ux: number, uz: number, autonomous: boolean): void {
    if (postureCmd === "stand") setFace(ux, uz);
    if (!autonomous) return;
    if (now >= nextIdleSniff && postureCmd === "stand") {
      idleSniffUntil = now + rand(1.5, 3);
      nextIdleSniff = now + rand(8, 16);
    }
    if (now >= nextAutoSit && postureCmd === "stand" && now - idleSince > 10) {
      if (Math.random() < 0.5) setPosture("sit", true);
      nextAutoSit = now + rand(15, 30);
    }
  }

  function pickFreeTarget(ux: number, uz: number): void {
    const ax = anchor.position.x;
    const az = anchor.position.z;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(rand(0.6 * 0.6, FREE_RADIUS * FREE_RADIUS) / (FREE_RADIUS * FREE_RADIUS)) * FREE_RADIUS;
      const x = ux + Math.cos(a) * r;
      const z = uz + Math.sin(a) * r;
      const d = Math.hypot(x - ax, z - az);
      if (d > 0.7 && d < 3) {
        freeTx = x;
        freeTz = z;
        freeHasTarget = true;
        freeTrot = Math.random() < 0.2;
        return;
      }
    }
    // Fallback: a point between the dog and the user.
    freeTx = ux + (ax - ux) * 0.5;
    freeTz = uz + (az - uz) * 0.5;
    freeHasTarget = true;
    freeTrot = false;
  }

  function freeBehaviour(ux: number, uz: number, du: number): void {
    // The user walked off: re-plan towards them right away.
    if (du > FREE_LIMIT - 0.2 && (!freeHasTarget || Math.hypot(freeTx - ux, freeTz - uz) > FREE_RADIUS)) {
      if (autoPosture) setPosture("stand", false);
      freeActivity = "none";
      pickFreeTarget(ux, uz);
    }
    if (freeHasTarget && Math.hypot(freeTx - ux, freeTz - uz) > FREE_LIMIT) pickFreeTarget(ux, uz);
    if (freeHasTarget) {
      const d = Math.hypot(freeTx - anchor.position.x, freeTz - anchor.position.z);
      if (d < 0.08 && v < 0.1) {
        freeHasTarget = false;
        // Arrived: do something for a while.
        const roll = Math.random();
        if (roll < 0.15) {
          freeActivity = "lie";
          freeActivityUntil = now + rand(7, 12);
          setPosture("lie", true);
          freeReplanAt = freeActivityUntil;
        } else if (roll < 0.7) {
          freeActivity = "sniff";
          freeActivityUntil = now + rand(1.5, 3.5);
          freeReplanAt = now + rand(4, 10);
        } else {
          freeActivity = "none";
          freeReplanAt = now + rand(4, 10);
        }
      } else {
        setWant(freeTx, freeTz, freeTrot ? V_TROT : V_WALK, 0.05);
        return;
      }
    }
    if (freeActivity === "lie" && now >= freeActivityUntil) {
      freeActivity = "none";
      if (autoPosture) setPosture("stand", false);
    }
    if (freeActivity === "sniff" && now >= freeActivityUntil) freeActivity = "none";
    if (now >= freeReplanAt) {
      if (autoPosture) setPosture("stand", false);
      freeActivity = "none";
      pickFreeTarget(ux, uz);
    }
  }

  // ---- Postures + locomotion -----------------------------------------------------------------

  function updatePostures(dt: number): void {
    // Walking needs standing: cancel any self-chosen posture, stand up first.
    if (want.move && postureCmd !== "stand") {
      if (autoPosture || mode !== "stay" || comeActive || goToActive) setPosture("stand", false);
    }
    let sitT = 0;
    let lieT = 0;
    if (!trickRunning && pendingTrick === null) {
      if (postureCmd === "sit") sitT = 1;
      else if (postureCmd === "lie") lieT = 1;
    }
    // Stop moving before going down.
    if ((sitT > sitLin || lieT > lieLin) && Math.abs(v) > STOPPED_V) {
      sitT = sitLin;
      lieT = lieLin;
    }
    sitLin = ramp(sitLin, sitT, dt / (sitT > sitLin ? POSTURE_DOWN_S : POSTURE_UP_S));
    lieLin = ramp(lieLin, lieT, dt / (lieT > lieLin ? POSTURE_DOWN_S : POSTURE_UP_S));
    controls.sit = ease(sitLin);
    controls.lie = ease(lieLin);
  }

  function standing(): boolean {
    return sitLin < 0.02 && lieLin < 0.02;
  }

  function updateLocomotion(dt: number): void {
    arrived = false;
    const ax = anchor.position.x;
    const az = anchor.position.z;
    const canMove = standing() && !trickRunning && pendingTrick === null && postureCmd === "stand";
    let vT = 0;
    let errT = 0; // heading error to turn by
    let turning = false;
    let dist = 0;
    let dirX = 0;
    let dirZ = 0;

    if (want.move && canMove) {
      const dx = want.x - ax;
      const dz = want.z - az;
      dist = Math.hypot(dx, dz);
      if (dist > want.arrive) {
        dirX = dx / dist;
        dirZ = dz / dist;
        errT = wrap(Math.atan2(dx, dz) - yaw);
        turning = true;
        const align = clamp((Math.cos(errT) - 0.3) / 0.6, 0, 1);
        const vArr = Math.sqrt(2 * DECEL * 0.7 * Math.max(0, dist - want.arrive * 0.5));
        vT = Math.min(want.vMax, vArr) * align;
        // Close by: don't turn around for a small correction, shuffle there (sideways /
        // backwards) and keep facing whatever the behaviour wants to face.
        if (dist < SHUFFLE_DIST && (Math.abs(errT) > 60 * DEG || shuffling)) {
          shuffling = true;
          turning = false;
          vT = Math.min(0.35 * V_WALK, vArr, want.vMax);
        } else {
          shuffling = false;
        }
      } else {
        arrived = true;
        shuffling = false;
      }
    } else if (want.move) {
      // Must stand up / wait first; facing still allowed after standing.
      dist = Math.hypot(want.x - ax, want.z - az);
    } else {
      shuffling = false;
    }

    if (!turning && want.face && standing() && !trickRunning) {
      const errF = wrap(Math.atan2(want.fx - ax, want.fz - az) - yaw);
      const a = Math.abs(errF);
      if (!facingTurn && a > TURN_FACE_START) facingTurn = true;
      if (facingTurn && a < TURN_FACE_STOP) facingTurn = false;
      if (facingTurn) {
        errT = errF;
        turning = true;
      }
    } else if (!want.face) {
      facingTurn = false;
    }

    // Speed (rate limited).
    if (!canMove) vT = 0;
    v = ramp(v, vT, (vT > v ? ACCEL : DECEL) * dt);
    if (v < 1e-4 && vT === 0) v = 0;

    // Turning (rate limited by speed).
    const maxTurn = TURN_STAND + (TURN_WALK - TURN_STAND) * clamp(v / V_WALK, 0, 1);
    const yrT = turning ? clamp(errT * 5, -maxTurn, maxTurn) : 0;
    yawRate = approach(yawRate, yrT, dt, 0.08);
    let dyaw = yawRate * dt;
    if (turning && Math.abs(dyaw) > Math.abs(errT)) dyaw = errT; // no overshoot
    yaw = wrap(yaw + dyaw);

    // Move.
    if (v > 0) {
      let mx = Math.sin(yaw);
      let mz = Math.cos(yaw);
      let step = v * dt;
      if (shuffling && dist > 0) {
        mx = dirX;
        mz = dirZ;
        step = Math.min(step, dist);
      } else if (want.move && dist > 0 && dist < 0.2) {
        // Final approach: blend the direction onto the target and never overshoot it.
        const w = 1 - dist / 0.2;
        mx = mx * (1 - w) + dirX * w;
        mz = mz * (1 - w) + dirZ * w;
        const ml = Math.hypot(mx, mz) || 1;
        mx /= ml;
        mz /= ml;
        step = Math.min(step, dist);
      }
      anchor.position.x += mx * step;
      anchor.position.z += mz * step;
    }

    // Hard keep-out: the nose never gets within VIEWER_KEEPOUT of the camera (floor plane).
    // Two nose estimates: straight ahead of the anchor, and the posed nose (head turned / bobbing)
    // carried along by this frame's translation; the one nearer the camera counts.
    let ex = anchor.position.x + Math.sin(yaw) * noseF - viewerW.x;
    let ez = anchor.position.z + Math.cos(yaw) * noseF - viewerW.z;
    const ex2 = nose.x + (anchor.position.x - ax) - viewerW.x;
    const ez2 = nose.z + (anchor.position.z - az) - viewerW.z;
    if (ex2 * ex2 + ez2 * ez2 < ex * ex + ez * ez) {
      ex = ex2;
      ez = ez2;
    }
    const ed = Math.hypot(ex, ez);
    if (ed < VIEWER_KEEPOUT) {
      const push = VIEWER_KEEPOUT - ed;
      if (ed > 1e-4) {
        anchor.position.x += (ex / ed) * push;
        anchor.position.z += (ez / ed) * push;
      } else {
        anchor.position.x -= Math.sin(yaw) * push;
        anchor.position.z -= Math.cos(yaw) * push;
      }
    }

    anchor.position.y = floorY;
    anchor.rotation.y = yaw;

    // Gait.
    const gs = gaitSpeedFor(v);
    controls.gait.speed = approach(controls.gait.speed, gs, dt, 0.05);
    if (gs > 1e-4) controls.gait.phase += (v * dt) / Math.max(strideAt(gs), 1e-3);
    controls.gait.turn = clamp(yawRate / TURN_WALK, -1, 1);
  }

  // ---- Look --------------------------------------------------------------------------------

  /** Chooses the look target into desiredW and returns its weight (0 = idle look-around). */
  function chooseLook(dt: number): number {
    if (activity === "trick") return 0;
    if (activity === "petHead") {
      desiredW.copy(viewerW);
      return 0.45;
    }
    if (activity === "petBody") {
      desiredW.copy(pets.body.point);
      return 0.6;
    }
    if (engagedId !== null) {
      // A hand right above / behind the eyes would make the head aim flip around: keep the
      // look target at least a little in front of the eyes.
      desiredW.copy(engagedPalm);
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const ahead = (engagedPalm.x - eyes.x) * fx + (engagedPalm.z - eyes.z) * fz;
      if (ahead < 0.15) {
        desiredW.x += fx * (0.15 - ahead);
        desiredW.z += fz * (0.15 - ahead);
      }
      return 1;
    }
    const p = partner !== null ? faceTracks.get(partner) : undefined;
    if (p) {
      desiredW.copy(p.head);
      nextGlance = now + rand(2, 5);
      return 1;
    }
    // Walking somewhere: look where it's going (idle), except come → look at the user.
    if (activity === "come") {
      desiredW.copy(viewerW);
      return 0.7;
    }
    if (v > V_WALK * 1.2) return 0;
    // Glance at the user every few seconds.
    if (glanceLeft > 0) {
      glanceLeft -= dt;
      if (glanceLeft <= 0) nextGlance = now + rand(3, 7);
      desiredW.copy(viewerW);
      return 0.6;
    }
    if (now >= nextGlance) glanceLeft = rand(1.2, 2.2);
    return 0;
  }

  // ---- Status ------------------------------------------------------------------------------

  function computeStatus(): string {
    switch (activity) {
      case "trick":
        return trickRunning ? trickStatus(trickState.kind) : pendingTrick ? trickStatus(pendingTrick) : "";
      case "petHead":
        return "Loves the head pats";
      case "petBody":
        return "Enjoying a back rub";
      case "handSniff":
        return "Sniffing your hand";
      case "handApproach":
        return mode === "stay" ? `${name} sees your hand` : `${name} is coming to your hand`;
      case "handLure":
        return "Following your hand";
      case "handWatch":
        return "Watching your hand";
      case "come":
        return `${name} is coming`;
      case "goTo":
        return "On the way";
      default:
        break;
    }
    if (postureCmd === "sit" && sitLin > 0.5) return "Sitting";
    if (postureCmd === "lie" && lieLin > 0.5) return "Lying down";
    if (partner !== null) return "Making eye contact";
    if (activity === "free") {
      if (freeActivity === "sniff" || controls.sniff > 0.5) return "Sniffing around";
      return `${name} is exploring`;
    }
    if (activity === "stay") return `${name} is staying`;
    return `${name} is following you`;
  }

  // ---------------------------------------------------------------------------------------

  function measureNose(): void {
    dog.getNoseWorld(nose);
    if (standing() && controls.sniff < 0.1 && !trickRunning) {
      const dx = nose.x - anchor.position.x;
      const dz = nose.z - anchor.position.z;
      const f = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      if (f > 0.03 && f < 2) noseF = f;
      noseH = nose.y - floorY;
    }
  }

  anchor.position.y = floorY;
  measureNose();
  resetIdle();

  const brain: DogBrain = {
    update(dtIn, perception, viewer): void {
      const dt = Math.min(Math.max(dtIn, 0), 0.1);
      now += dt;
      viewerW.copy(viewer.position);
      viewerFwd.copy(viewer.forward);
      const hands = perception.hands;

      // External code may have moved the anchor (placement): keep yaw in sync.
      if (Math.abs(wrap(anchor.rotation.y - yaw)) > 1e-6) yaw = anchor.rotation.y;

      measureNose();
      dog.getEyesWorld(eyes);

      // ---- Tricks
      if (trickRunning) {
        trickElapsed += dt * trickRate;
        const dur = TRICK_DURATION[trickState.kind];
        if (trickElapsed >= dur) {
          trickRunning = false;
          controls.trick = null;
          if (queued) {
            const q = queued;
            queued = null;
            startTrick(q);
          } else if (postureBeforeTrick !== "stand" && mode === "stay") {
            setPosture(postureBeforeTrick, false);
          }
        } else {
          trickState.progress = trickElapsed / dur;
        }
      }
      if (!trickRunning && pendingTrick !== null && Math.abs(v) <= STOPPED_V && standing()) {
        const kq = pendingTrick;
        pendingTrick = null;
        startTrick(kq);
      }

      // ---- Perception
      updateHandsBookkeeping(hands);
      updatePetting(hands, dt);
      updateEngagement(hands);
      updateFaces(perception.faces);
      updatePartner(engagedId === null && !pets.head.active && !pets.body.active && v < V_WALK * 1.2);

      // ---- Behaviour → movement
      chooseBehaviour();
      updatePostures(dt);
      updateLocomotion(dt);
      if (activity === "come" && arrived) comeFacing = true;
      if (activity === "goTo" && arrived && v < 0.02) {
        goToActive = false;
        mode = "stay";
        resetIdle();
      }
      if (want.move || v > 0.05 || postureCmd !== "stand") idleSince = now;

      // Root transform after movement (lookAt / petPoint are in ROOT space).
      dog.root.updateWorldMatrix(true, false);
      invRoot.copy(dog.root.matrixWorld).invert();

      // ---- Petting controls
      const headOn = pets.head.active;
      const bodyOn = pets.body.active;
      controls.petHead = approach(controls.petHead, headOn ? 1 : 0, dt, headOn ? 0.15 : 0.25);
      controls.petBody = approach(controls.petBody, bodyOn ? 1 : 0, dt, bodyOn ? 0.15 : 0.25);
      if (headOn || bodyOn) {
        petLocal.copy(headOn ? pets.head.point : pets.body.point).applyMatrix4(invRoot);
        controls.petPoint = petLocal;
      } else if (controls.petHead < 0.01 && controls.petBody < 0.01) {
        controls.petPoint = null;
      }

      // ---- Look
      const weight = chooseLook(dt);
      if (weight > 0) {
        if (!lookTargetValid || controls.lookWeight < 0.02) lookW.copy(desiredW);
        else lookW.lerp(desiredW, k(dt, 0.1));
        lookTargetValid = true;
      }
      controls.lookWeight = approach(controls.lookWeight, weight, dt, 0.12);
      if (lookTargetValid && controls.lookWeight > 0.005) {
        lookLocal.copy(lookW).applyMatrix4(invRoot);
        controls.lookAt = lookLocal;
      } else {
        controls.lookAt = null;
        controls.lookWeight = 0;
        if (weight === 0) lookTargetValid = false;
      }

      // ---- Sniff
      let sniffT = 0;
      if (handSniffing) sniffT = 1;
      else if (activity === "handApproach" && engagedPalm.distanceTo(nose) < 0.45) sniffT = 0.4;
      else if (activity === "free" && freeActivity === "sniff" && v < 0.1) sniffT = 1;
      else if (activity === "follow" && now < idleSniffUntil && v < 0.1 && postureCmd === "stand") sniffT = 0.8;
      controls.sniff = approach(controls.sniff, sniffT, dt, 0.25);

      // ---- Excitement
      let exT = EXCITE_BASE;
      if (activity === "follow" && v > V_TROT * 0.9) exT = 0.6;
      if (engagedId !== null && !engagedNear) exT = 0.7;
      if (headOn || bodyOn) exT = 0.95;
      if (trickRunning) exT = 1;
      excitement = approach(excitement, exT, dt, exT > excitement ? 0.4 : 3);
      controls.excitement = excitement;

      status = computeStatus();
    },

    command(cmd: DogCommand): void {
      switch (cmd) {
        case "sit":
        case "lie":
          mode = "stay";
          comeActive = false;
          comeFacing = false;
          goToActive = false;
          following = false;
          setPosture(cmd, false);
          if (pendingTrick !== null) pendingTrick = null;
          break;
        case "stand":
          setPosture("stand", false);
          break;
        case "come":
          comeActive = true;
          comeFacing = false;
          goToActive = false;
          setPosture("stand", false);
          break;
        case "follow":
        case "free":
          mode = cmd;
          comeActive = false;
          comeFacing = false;
          goToActive = false;
          following = false;
          freeHasTarget = false;
          freeActivity = "none";
          freeReplanAt = now; // free: plan right away
          setPosture("stand", false);
          resetIdle();
          break;
        default: {
          const kind = cmd;
          if (trickRunning) {
            if (trickState.kind === kind) {
              queued = null;
              trickRate = 1;
            } else {
              queued = kind;
              const remaining = TRICK_DURATION[trickState.kind] - trickElapsed;
              trickRate = Math.max(1, remaining / FAST_FORWARD_S);
            }
          } else {
            if (pendingTrick === null) postureBeforeTrick = postureCmd;
            pendingTrick = kind;
          }
          status = trickStatus(kind);
        }
      }
    },

    goTo(worldPoint: THREE.Vector3): void {
      goToPt.set(worldPoint.x, floorY, worldPoint.z);
      goToActive = true;
      comeActive = false;
      comeFacing = false;
      following = false;
      setPosture("stand", false);
    },

    placeAt(worldPoint: THREE.Vector3, faceToward: THREE.Vector3, fy: number): void {
      floorY = fy;
      anchor.position.set(worldPoint.x, fy, worldPoint.z);
      const dx = faceToward.x - worldPoint.x;
      const dz = faceToward.z - worldPoint.z;
      if (dx * dx + dz * dz > 1e-8) yaw = Math.atan2(dx, dz);
      anchor.rotation.set(0, yaw, 0);
      v = 0;
      yawRate = 0;
      goToActive = false;
      comeActive = false;
      comeFacing = false;
      following = false;
      freeHasTarget = false;
      facingTurn = false;
      resetIdle();
    },

    get mode(): DogMode {
      return mode;
    },
    get posture(): Posture {
      return postureCmd;
    },
    get status(): string {
      return status;
    },
    get eyeContactWith(): number | null {
      return partner;
    },
    onPetStart(fn: (zone: Zone, worldPoint: THREE.Vector3) => void): () => void {
      petListeners.add(fn);
      return () => {
        petListeners.delete(fn);
      };
    },
  };

  return brain;
}
