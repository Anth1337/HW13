import * as THREE from "three";
import type { PerceivedHuman } from "../vision/types";
import { TRICK_DURATION } from "./types";
import type { DogBrain, DogCharacter, DogZones, TrickKind } from "./types";

/*
 * The dog's brain: perception (PerceivedHuman[] in world space) → smoothed DogControls.
 *
 * Everything time-based lives here (the model is stateless), so every control value is eased
 * with frame-rate independent exponential smoothing. Vision runs at ~10 Hz while this runs every
 * rendered frame, so all "is X happening" tests are tolerant to short dropouts.
 *
 * Priorities for where the dog looks:
 *   trick (weight 0) > head pats (look at the petter, lower weight) > eye contact (weight 1)
 *   > glance at a visible person (0.5, not eye contact) > glance at the phone user (0.5) > idle.
 */

// ---- Tuning ------------------------------------------------------------------------------

const DEG = Math.PI / 180;
const COS_ENTER = Math.cos(18 * DEG); // start "looking at the dog"
const COS_STAY = Math.cos(26 * DEG); // keep "looking at the dog" (hysteresis)
const MAX_LOOK_DIST = 6; // m
const MIN_CONFIDENCE = 0.3;
const MAX_LOOK_AGE = 0.5; // s: detection must be this fresh to count as looking
const CANDIDATE_DWELL = 0.35; // s a newcomer must keep looking before the dog switches to them
// Vision runs at ~10 Hz and the same (stale) PerceivedHuman is re-evaluated every rendered frame,
// so dwell times alone could be satisfied by ONE noisy detection. Starting eye contact or a
// petting session also needs this many distinct detections (age reset to a lower value).
const MIN_DISTINCT_DETECTIONS = 2;
const PARTNER_LOOK_AWAY = 0.8; // s a partner may look away before being dropped
const SWITCH_LOOK_AWAY = 0.35; // s the partner must have looked away before switching to someone else
const VANISH_AGE = 1; // s since last detection = gone
const FORGET_AFTER = 2; // s: drop bookkeeping for people not seen for this long

const HAND_MAX_AGE = 0.4;
const PET_DWELL = 0.25; // s inside a zone before petting starts
const PET_DROPOUT = 0.3; // s of missing hand tolerated while dwelling
const PET_RELEASE = 0.5; // s outside before a petting session ends

const TURN_START = 65 * DEG; // start turning when the target is further round than this
const TURN_STOP = 8 * DEG; // keep turning until roughly facing it
const TURN_SPEED = 90 * DEG; // rad/s max

const EXCITE_BASE = 0.25;

// ---- Helpers -----------------------------------------------------------------------------

/** Frame-rate independent smoothing factor for a time constant tau (s). */
function k(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau);
}

function approach(x: number, target: number, dt: number, tau: number): number {
  return x + (target - x) * k(dt, tau);
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

/** Per-person bookkeeping (pooled; one per tracked id). */
interface Track {
  id: number;
  seenThisFrame: boolean;
  lastSeen: number; // brain time of the detection (now - age)
  headKnown: boolean;
  head: THREE.Vector3; // last known head, world
  dist: number; // head → dog eyes, m (Infinity if unknown)
  looking: boolean;
  lookStart: number; // when the current looking streak began
  lastLook: number; // last time they were looking (-Infinity if never)
  prevAge: number; // h.age last frame (a lower age now = a new detection)
  fresh: boolean; // this frame's sample is a new detection
  lookDets: number; // distinct detections in the current looking streak
}

type Zone = "head" | "body";

interface PetState {
  active: boolean;
  dwellStart: number | null;
  dets: number; // distinct detections with a hand in the zone since dwellStart
  lastHit: number;
  petterId: number | null;
  point: THREE.Vector3; // smoothed world-space hand point
  hitPoint: THREE.Vector3; // this frame's hand point
}

type GlanceMode = "none" | "human" | "viewer";

export function createDogBrain(dog: DogCharacter): DogBrain {
  const controls = dog.controls;

  let now = 0;

  // Scratch (allocation-free per frame).
  const invRoot = new THREE.Matrix4();
  const eyes = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const zones: DogZones = { head: new THREE.Sphere(), body: new THREE.Sphere() };
  const desiredW = new THREE.Vector3(); // desired look target, world
  const lookW = new THREE.Vector3(); // smoothed look target, world
  const lookLocal = new THREE.Vector3(); // handed to controls.lookAt
  const petLocal = new THREE.Vector3(); // handed to controls.petPoint
  let lookTargetValid = false; // lookW holds something meaningful

  // People.
  const tracks = new Map<number, Track>();
  const pool: Track[] = [];
  let partner: number | null = null;

  // Glancing when nobody makes eye contact.
  let glanceMode: GlanceMode = "none";
  let glanceLeft = 0;
  let nextGlance = rand(1, 3);
  let glanceId: number | null = null;

  // Petting.
  const pets: Record<Zone, PetState> = {
    head: { active: false, dwellStart: null, dets: 0, lastHit: -Infinity, petterId: null, point: new THREE.Vector3(), hitPoint: new THREE.Vector3() },
    body: { active: false, dwellStart: null, dets: 0, lastHit: -Infinity, petterId: null, point: new THREE.Vector3(), hitPoint: new THREE.Vector3() },
  };
  const petListeners = new Set<(zone: Zone, worldPoint: THREE.Vector3) => void>();

  // Tricks.
  // A trick of another kind interrupts the running one (contract). The model is stateless
  // (pose = f(t, controls)), so cutting a trick at e.g. 50% progress would pop the dog from
  // upside-down straight back to standing. Instead the running trick is fast-forwarded to its
  // neutral end (progress 1, where every trick envelope is 0) within FAST_FORWARD_S, then the
  // requested one starts. Queue of one; the latest press wins.
  const FAST_FORWARD_S = 0.4;
  const trickState = { kind: "jump" as TrickKind, progress: 0 };
  let trickRunning = false;
  let trickElapsed = 0;
  let trickRate = 1; // > 1 while fast-forwarding to a queued trick
  let queued: TrickKind | null = null;

  let turning = false;
  let status = "";

  function startTrick(kind: TrickKind): void {
    trickRunning = true;
    trickElapsed = 0;
    trickRate = 1;
    trickState.kind = kind;
    trickState.progress = 0;
    controls.trick = trickState;
    // Tricks interrupt petting sessions.
    for (const z of ["head", "body"] as const) {
      pets[z].active = false;
      pets[z].dwellStart = null;
      pets[z].dets = 0;
    }
    turning = false;
  }

  function getTrack(id: number): Track {
    let t = tracks.get(id);
    if (!t) {
      t = pool.pop() ?? {
        id, seenThisFrame: false, lastSeen: 0, headKnown: false, head: new THREE.Vector3(),
        dist: Infinity, looking: false, lookStart: 0, lastLook: -Infinity,
        prevAge: Infinity, fresh: false, lookDets: 0,
      };
      t.id = id;
      t.seenThisFrame = false;
      t.headKnown = false;
      t.dist = Infinity;
      t.looking = false;
      t.lookStart = 0;
      t.lastLook = -Infinity;
      t.prevAge = Infinity;
      t.fresh = false;
      t.lookDets = 0;
      tracks.set(id, t);
    }
    return t;
  }

  function visible(t: Track): boolean {
    return t.headKnown && now - t.lastSeen <= VANISH_AGE;
  }

  function nearestVisible(): Track | null {
    let best: Track | null = null;
    for (const t of tracks.values()) {
      if (visible(t) && (!best || t.dist < best.dist)) best = t;
    }
    return best;
  }

  function updatePeople(humans: readonly PerceivedHuman[]): void {
    for (const t of tracks.values()) {
      t.seenThisFrame = false;
      t.fresh = false;
    }

    for (const h of humans) {
      const t = getTrack(h.id);
      t.seenThisFrame = true;
      const age = Math.max(0, h.age);
      t.fresh = age < t.prevAge - 1e-6;
      t.prevAge = age;
      t.lastSeen = now - Math.max(0, h.age);
      if (h.head) {
        t.headKnown = true;
        t.head.copy(h.head);
        t.dist = h.head.distanceTo(eyes);
      }
      let looking = false;
      if (h.head && h.gaze && h.age < MAX_LOOK_AGE && h.confidence >= MIN_CONFIDENCE && t.dist <= MAX_LOOK_DIST) {
        tmp.subVectors(eyes, h.head);
        const len = tmp.length();
        const glen = h.gaze.length();
        if (len > 1e-4 && glen > 1e-4) {
          const cos = tmp.dot(h.gaze) / (len * glen);
          looking = cos >= (t.looking ? COS_STAY : COS_ENTER);
        }
      }
      if (looking && !t.looking) {
        t.lookStart = now;
        t.lookDets = 0;
      }
      if (looking && t.fresh) t.lookDets++;
      t.looking = looking;
      if (looking) t.lastLook = now;
    }

    for (const [id, t] of tracks) {
      if (!t.seenThisFrame) {
        t.looking = false;
        if (now - t.lastSeen > FORGET_AFTER) {
          tracks.delete(id);
          pool.push(t);
        }
      }
    }
  }

  /** Longest-looking qualified candidate (nearest breaks near-ties), excluding `except`. */
  function bestCandidate(except: number | null): Track | null {
    let best: Track | null = null;
    for (const t of tracks.values()) {
      if (t.id === except || !t.looking || now - t.lookStart < CANDIDATE_DWELL) continue;
      if (t.lookDets < MIN_DISTINCT_DETECTIONS) continue;
      if (!best) { best = t; continue; }
      const dStart = t.lookStart - best.lookStart;
      if (dStart < -0.05 || (Math.abs(dStart) <= 0.05 && t.dist < best.dist)) best = t;
    }
    return best;
  }

  function updatePartner(): void {
    const p = partner !== null ? tracks.get(partner) : undefined;
    const valid = !!p && now - p.lastSeen <= VANISH_AGE && now - p.lastLook <= PARTNER_LOOK_AWAY;
    if (p && valid) {
      if (p.looking) return; // keep the current partner while they keep looking
      const other = bestCandidate(p.id);
      if (other && now - p.lastLook >= SWITCH_LOOK_AWAY) partner = other.id;
      return; // otherwise grace period: keep them a little longer
    }
    const c = bestCandidate(null);
    partner = c ? c.id : null;
  }

  function updatePetting(humans: readonly PerceivedHuman[], dt: number): void {
    dog.getZones(zones);
    let headHit = false;
    let bodyHit = false;
    let headFresh = false;
    let bodyFresh = false;
    let headD = Infinity;
    let bodyD = Infinity;
    for (const h of humans) {
      if (h.age >= HAND_MAX_AGE) continue;
      const fresh = tracks.get(h.id)?.fresh ?? false;
      for (const hand of h.hands) {
        if (zones.head.containsPoint(hand)) {
          if (fresh) headFresh = true;
          const d = hand.distanceToSquared(zones.head.center);
          if (d < headD) {
            headD = d;
            headHit = true;
            pets.head.hitPoint.copy(hand);
            if (!pets.head.active || pets.head.petterId === null) pets.head.petterId = h.id;
          }
        } else if (zones.body.containsPoint(hand)) {
          if (fresh) bodyFresh = true;
          const d = hand.distanceToSquared(zones.body.center);
          if (d < bodyD) {
            bodyD = d;
            bodyHit = true;
            pets.body.hitPoint.copy(hand);
            if (!pets.body.active || pets.body.petterId === null) pets.body.petterId = h.id;
          }
        }
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
        s.point.lerp(s.hitPoint, k(dt, 0.04));
      } else if (!trickRunning && now - s.dwellStart >= PET_DWELL && s.dets >= MIN_DISTINCT_DETECTIONS) {
        s.active = true;
        s.point.copy(s.hitPoint);
        const p = s.hitPoint.clone();
        for (const fn of petListeners) fn(zone, p);
      }
    } else {
      if (s.active && now - s.lastHit > PET_RELEASE) {
        s.active = false;
        s.dwellStart = null;
        s.dets = 0;
        s.petterId = null;
      } else if (!s.active && now - s.lastHit > PET_DROPOUT) {
        s.dwellStart = null;
        s.dets = 0;
        s.petterId = null;
      }
    }
  }

  /** true while glancing at a visible person (status "Watching someone"). Set by chooseLook. */
  let watching = false;

  /** Picks the desired look target (into desiredW) and returns its weight (0 = idle). */
  function chooseLook(dt: number): number {
    watching = false;
    const headPet = pets.head;
    const pTrack = partner !== null ? tracks.get(partner) : undefined;

    // Head pats: look up at the petter (softly) unless someone else holds eye contact.
    if (headPet.active && headPet.petterId !== null) {
      const petter = tracks.get(headPet.petterId);
      if (petter && petter.headKnown && (!pTrack || pTrack.id === petter.id)) {
        desiredW.copy(petter.head);
        glanceMode = "none";
        return 0.6;
      }
    }

    if (pTrack && pTrack.headKnown) {
      desiredW.copy(pTrack.head);
      glanceMode = "none";
      nextGlance = rand(1.5, 4);
      return 1;
    }

    // Nobody looking at the dog: occasional glances.
    const near = nearestVisible();
    if (glanceMode !== "none") {
      glanceLeft -= dt;
      if (glanceLeft <= 0) {
        glanceMode = "none";
        nextGlance = near ? rand(1.5, 4) : rand(3, 7);
      }
    } else {
      nextGlance -= dt;
      if (nextGlance <= 0) {
        if (near) {
          glanceMode = "human";
          glanceLeft = rand(2, 3.5);
          glanceId = near.id;
        } else {
          glanceMode = "viewer";
          glanceLeft = rand(1, 1.8);
        }
      }
    }

    if (glanceMode === "human") {
      let t = glanceId !== null ? tracks.get(glanceId) : undefined;
      if (!t || !visible(t)) {
        t = near ?? undefined;
        glanceId = t ? t.id : null;
      }
      if (t) {
        desiredW.copy(t.head);
        watching = true;
        return 0.5;
      }
      glanceMode = "none";
      nextGlance = rand(3, 7);
    }
    if (glanceMode === "viewer") {
      desiredW.copy(viewerW);
      return 0.5;
    }
    return 0;
  }

  const viewerW = new THREE.Vector3();
  let excitement = EXCITE_BASE;

  const brain: DogBrain = {
    update(dtIn: number, humans: readonly PerceivedHuman[], viewerWorld: THREE.Vector3): void {
      const dt = Math.min(Math.max(dtIn, 0), 0.1);
      now += dt;
      viewerW.copy(viewerWorld);

      dog.root.updateWorldMatrix(true, false);
      invRoot.copy(dog.root.matrixWorld).invert();
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
          }
        } else {
          trickState.progress = trickElapsed / dur;
        }
      }

      // ---- Perception
      updatePeople(humans);
      updatePartner();
      updatePetting(humans, dt);

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
      } // else keep the last petPoint while fading out

      // ---- Look
      const weight = chooseLook(dt);
      const targetWeight = trickRunning ? 0 : weight;
      if (weight > 0) {
        if (!lookTargetValid || controls.lookWeight < 0.02) lookW.copy(desiredW);
        else lookW.lerp(desiredW, k(dt, 0.12));
        lookTargetValid = true;
      }
      controls.lookWeight = approach(controls.lookWeight, targetWeight, dt, 0.1);
      if (lookTargetValid && controls.lookWeight > 0.005) {
        lookLocal.copy(lookW).applyMatrix4(invRoot);
        controls.lookAt = lookLocal;
      } else {
        // Faded out completely: back to the idle look-around.
        controls.lookAt = null;
        controls.lookWeight = 0;
        if (weight === 0) lookTargetValid = false;
      }

      // ---- Turning in place to face the look target
      let stepTarget = 0;
      const petted = controls.petHead > 0.2 || controls.petBody > 0.2;
      if (!trickRunning && !petted && weight >= 0.5 && lookTargetValid) {
        lookLocal.copy(lookW).applyMatrix4(invRoot);
        const horiz = lookLocal.x * lookLocal.x + lookLocal.z * lookLocal.z;
        if (horiz > 1e-4) {
          const targetYaw = Math.atan2(lookLocal.x, lookLocal.z);
          const d = wrap(targetYaw - controls.turnYaw);
          const ad = Math.abs(d);
          if (!turning && ad > TURN_START) turning = true;
          if (turning && ad < TURN_STOP) turning = false;
          if (turning) {
            const rate = Math.min(TURN_SPEED, 2.5 * ad + 0.3);
            const step = Math.min(ad, rate * dt);
            controls.turnYaw = wrap(controls.turnYaw + Math.sign(d) * step);
            stepTarget = rate / TURN_SPEED;
          }
        }
      } else {
        turning = false;
      }
      controls.turnStep = approach(controls.turnStep, trickRunning ? 0 : stepTarget, dt, 0.12);

      // ---- Excitement
      let exTarget = EXCITE_BASE;
      if (partner !== null) exTarget = 0.5;
      if (headOn || bodyOn) exTarget = 0.9;
      if (trickRunning) exTarget = 1;
      excitement = approach(excitement, exTarget, dt, exTarget > excitement ? 0.4 : 3);
      controls.excitement = excitement;

      // ---- Status
      if (trickRunning) {
        status = trickState.kind === "rollOver" ? "Rolling over!" : trickState.kind === "jump" ? "Jumping!" : "Spinning!";
      } else if (headOn) status = "Loves the head pats";
      else if (bodyOn) status = "Enjoying a back rub";
      else if (partner !== null) status = "Making eye contact";
      else if (watching) status = "Watching someone";
      else status = "";
    },

    doTrick(kind: TrickKind): void {
      if (trickRunning) {
        if (trickState.kind === kind) {
          // Same trick pressed again: cancel any pending switch and let it play normally.
          queued = null;
          trickRate = 1;
        } else {
          queued = kind;
          const remaining = TRICK_DURATION[trickState.kind] - trickElapsed;
          trickRate = Math.max(1, remaining / FAST_FORWARD_S);
        }
        return;
      }
      startTrick(kind);
      status = kind === "rollOver" ? "Rolling over!" : kind === "jump" ? "Jumping!" : "Spinning!";
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
