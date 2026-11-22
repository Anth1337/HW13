import * as THREE from "three";
import { TRICK_LABEL, type DogCommand, type PetCharacter, type PetSocial, type PetZones, type TrickKind } from "../dog/types";
import type { PerceivedHand, Perception } from "../vision/types";
import { currentRoom } from "./index";
import { createPetModel, localPetCard, petBuzz, petName } from "./kinds";
import { RemotePet, type MeetPose, type Stage } from "./remotePet";
import type { Peer } from "./room";
import { PET_REPEAT_MS, readEvent, readState, wrapAngle, writeState, type PetEvent } from "./sync";
import { clearFeed, feed, partyButton, sayHiButton } from "./ui";

/*
 * Multiplayer inside one AR / camera session (dogPlay.ts creates it when the page is in a room):
 *  - sends this phone's pet ~10 times a second: where it is relative to where it was placed,
 *    and its DogControls (sync.ts)
 *  - shows friends' pets standing around this phone's pet (remotePet.ts)
 *  - a hand on a friend's pet makes it lean in here, on its owner's phone and on everyone
 *    else's; a friend's hand on this phone's pet does the same here
 *  - the feed (who joined, petting, tricks) and the 🎉 button: every pet in the room does the
 *    same trick at once
 *  - pets meeting each other (a "meet" event, started by an idle pet now and then or the 🐾
 *    button): the two walk up nose to nose, sniff, then each does a trick that suits the other's
 *    species. Every phone plays it from its own layout (friends' pets stand in different spots on
 *    each phone): this phone's pet walks there with its brain, friends' pets with RemotePet.meet.
 */

export interface PartyLink {
  /** This phone's pet was placed and given a brain. */
  attach(dog: PetCharacter, anchor: THREE.Object3D): void;
  /** After the brain wrote this frame's controls, before dog.update(): friends petting this pet. */
  beforeDogUpdate(dt: number): void;
  /** Once per frame after the pet was posed: send its state, move friends' pets, pet them. */
  update(dt: number, perception: Perception): void;
  /** This phone's player commanded their pet (button or voice). */
  commanded(cmd: DogCommand): void;
  dispose(): void;
}

export interface PartyHooks {
  /** Hearts at a world point. */
  burst(point: THREE.Vector3, zone: "head" | "body"): void;
  /** Run a command on this phone's pet (someone's party trick, maybe another species' trick). */
  command(cmd: DogCommand): void;
  /** This phone's pet's three tricks (the 🎉 button picks one). */
  tricks: readonly TrickKind[];
  /** This phone's pet meets another pet (null = done). */
  social(s: PetSocial | null): void;
  /** This phone's pet is idle enough to go and say hi by itself. */
  sociable(): boolean;
}

const SEND_EVERY_MS = 100;
/** No snapshot for this long: the friend left AR or lost connection; their pet is hidden. */
const STALE_MS = 2500;
/** The pet moved further than this in one frame: it was re-placed, and the party moves with it. */
const TELEPORT_M = 0.35;
const PARTY_COOLDOWN_MS = 1500;
/** Hand on a friend's pet: same feel as the brain's petting (dwell before it counts, release after). */
const TOUCH_DWELL_S = 0.2;
const TOUCH_RELEASE_S = 0.5;
const HAND_MAX_AGE = 0.4;
const HAND_MIN_CONF = 0.3;
const FINGERTIPS = [4, 8, 12, 16, 20];
/** Being petted by a friend keeps this pet leaning in this long after their last event (they repeat every 250 ms). */
const PETTED_HOLD_MS = 600;
/** One "is petting" line per friend per this long, however often they stop and start. */
const PETTED_FEED_MS = 4000;
/** Where friends' pets stand: behind and beside this phone's pet (x right, z towards the viewer, m). */
const SLOTS: [number, number][] = [
  [0.65, -1.0],
  [-0.65, -1.0],
  [0, -1.9],
  [1.2, -1.8],
  [-1.2, -1.8],
  [0.65, -2.8],
  [-0.65, -2.8],
];
const SHOWN_COMMANDS: Partial<Record<DogCommand, string>> = { ...TRICK_LABEL, sit: "Sit", lie: "Lie down" };

/** Meeting timeline (s from the start): walk over, sniff, tricks, done (everyone goes back). */
const MEET_SNIFF_S = 3.5;
const MEET_TRICK_S = 6;
const MEET_END_S = 9.5;
/** An idle pet goes to say hi to a friend's pet after this long (random in the range). */
const MEET_AUTO_MIN_S = 25;
const MEET_AUTO_MAX_S = 45;
/** Gap between the two noses (m). */
const NOSE_GAP = 0.04;
/** Anchor → nose tip as a share of nose-to-rump length (the head sticks out past the torso: dog 0.63, cat 0.60). */
const NOSE_REACH = 0.62;
/** [initiator's trick, other pet's trick] by [initiator species][other species]. */
const MEET_TRICKS: Record<string, Record<string, [TrickKind, TrickKind]>> = {
  dog: { dog: ["spin", "jump"], cat: ["jump", "pounce"] },
  cat: { dog: ["pounce", "jump"], cat: ["stretch", "groom"] },
};

type Touch = { zone: "head" | "body"; held: number; idle: number; active: boolean; sentMs: number };

/** Two pets meeting, as played on this phone. Ids are room ids (this phone's pet: room.selfId). */
type Meet = {
  a: string;
  b: string;
  /** b stays put (sitting / lying): only a walks over. */
  stay: boolean;
  startMs: number;
  tricked: boolean;
  /** Where each pet goes on this phone (stand fixed at the start, the rest updated per frame). */
  poseA: MeetPose;
  poseB: MeetPose;
};

export function createPartyLink(scene: THREE.Scene, hooks: PartyHooks): PartyLink | null {
  const joined = currentRoom();
  if (!joined) return null;
  const room = joined;

  const pets = new Map<string, RemotePet>();
  const slots = new Map<string, number>();
  const touches = new Map<string, Touch>();
  const seenPlaying = new Set<string>();
  const pettedFeedMs = new Map<string, number>();
  const cleanups: (() => void)[] = [];
  let dog: PetCharacter | null = null;
  let anchor: THREE.Object3D | null = null;
  let stage: Stage | null = null;
  const lastPos = new THREE.Vector3();
  let lastSendMs = -Infinity;
  let pettedHeadUntil = -Infinity;
  let pettedBodyUntil = -Infinity;
  let pettedHead = 0;
  let pettedBody = 0;
  let lastPartyMs = -Infinity;
  let connectionLost = false;
  let disposed = false;
  const zones: PetZones = { head: new THREE.Sphere(), body: new THREE.Sphere() };
  const point = new THREE.Vector3();
  const meets: Meet[] = [];
  const social: PetSocial = { stand: null, face: new THREE.Vector3(), look: new THREE.Vector3(), sniff: 0, status: "" };
  let socialOn = false;
  let nextAutoMeetMs = performance.now() + rand(MEET_AUTO_MIN_S, MEET_AUTO_MAX_S) * 1000;
  const lastMetMs = new Map<string, number>();

  const myName = () => petName(localPetCard());
  const ownerOf = (peer: Peer) => `${petName(peer.pet)}'s human`;
  const label = (cmd: DogCommand) => SHOWN_COMMANDS[cmd]?.toLowerCase() ?? cmd;

  /** The friend's pet for this peer, (re)built when their card changes. Null if they have none we can show. */
  function petFor(peer: Peer): RemotePet | null {
    const existing = pets.get(peer.id);
    if (existing && existing.card === peer.pet) return existing;
    existing?.dispose();
    pets.delete(peer.id);
    if (!peer.pet) return null;
    const model = createPetModel(peer.pet);
    if (!model) return null;
    const pet = new RemotePet(peer.pet, model, petName(peer.pet));
    pet.anchor.visible = false;
    scene.add(pet.anchor);
    pets.set(peer.id, pet);
    if (!slots.has(peer.id)) {
      const used = new Set(slots.values());
      let free = 0;
      while (used.has(free)) free++;
      slots.set(peer.id, free % SLOTS.length);
    }
    return pet;
  }

  function forget(id: string) {
    for (const m of [...meets]) if (m.a === id || m.b === id) endMeet(m);
    pets.get(id)?.dispose();
    pets.delete(id);
    slots.delete(id);
    touches.delete(id);
    seenPlaying.delete(id);
    pettedFeedMs.delete(id);
  }

  function onEvent(from: Peer, e: PetEvent) {
    const now = performance.now();
    if (e.k === "cmd") {
      if (e.to === "*") {
        hooks.command(e.c);
        feed(`🎉 ${ownerOf(from)}: everyone ${label(e.c)}!`);
      } else if (e.to !== undefined && e.to === room.selfId) {
        hooks.command(e.c);
        feed(`${ownerOf(from)} told ${myName()} to ${label(e.c)}`);
      } else if (e.to === undefined && SHOWN_COMMANDS[e.c] && pets.get(from.id)?.anchor.visible) {
        feed(`${petName(from.pet)}: ${SHOWN_COMMANDS[e.c]}!`);
      }
      return;
    }
    if (e.k === "pet") {
      if (e.to === room.selfId) {
        const started = now >= pettedHeadUntil && now >= pettedBodyUntil;
        if (e.z === "head") pettedHeadUntil = now + PETTED_HOLD_MS;
        else pettedBodyUntil = now + PETTED_HOLD_MS;
        if (started && dog) {
          dog.getZones(zones);
          hooks.burst(e.z === "head" ? zones.head.center : zones.body.center, e.z);
          navigator.vibrate?.(petBuzz(dog.species, e.z));
          if (now - (pettedFeedMs.get(from.id) ?? -Infinity) >= PETTED_FEED_MS) {
            pettedFeedMs.set(from.id, now);
            feed(`💕 ${ownerOf(from)} is petting ${myName()}`);
          }
        }
      } else {
        const pet = pets.get(e.to);
        if (pet?.touch(e.z, now) && pet.anchor.visible) {
          pet.zones(zones);
          hooks.burst(e.z === "head" ? zones.head.center : zones.body.center, e.z);
        }
      }
      return;
    }
    if (e.k === "meet") {
      startMeet(from.id, e.to, e.stay, now);
      return;
    }
    // "away": they went back to the creator.
    from.lastStateMs = -Infinity;
    pets.get(from.id)?.reset();
    for (const m of [...meets]) if (m.a === from.id || m.b === from.id) endMeet(m);
  }

  // ---- Pets meeting each other ---------------------------------------------------------

  const self = () => room.selfId;
  const nameOf = (id: string) => (id === self() ? myName() : petName(pets.get(id)?.card ?? null));
  const busy = (id: string) => meets.some((m) => m.a === id || m.b === id);
  const speciesOf = (id: string) => (id === self() ? dog?.species : pets.get(id)?.model.species);
  const lengthOf = (id: string) => (id === self() ? dog?.length : pets.get(id)?.model.length) ?? 0.5;

  /** Floor position of a pet as shown on this phone, or null if it isn't shown. */
  function whereIs(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    if (id === self()) return dog && anchor ? out.copy(anchor.position) : null;
    const pet = pets.get(id);
    return pet?.anchor.visible ? out.copy(pet.anchor.position) : null;
  }
  function eyesOf(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    if (id === self()) return dog ? dog.getEyesWorld(out) : null;
    const pet = pets.get(id);
    return pet?.anchor.visible ? pet.model.getEyesWorld(out) : null;
  }

  /** Starts a meeting on this phone (both pets shown and free). True if it started. */
  function startMeet(a: string, b: string, stay: boolean, now: number): boolean {
    if (a === b || busy(a) || busy(b)) return false;
    const pa = whereIs(a, new THREE.Vector3());
    const pb = whereIs(b, new THREE.Vector3());
    if (!pa || !pb) return false;
    const dir = new THREE.Vector3(pb.x - pa.x, 0, pb.z - pa.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    // Noses meet half way (or at the resting pet); each anchor stands its nose reach behind them.
    const ra = lengthOf(a) * NOSE_REACH + NOSE_GAP / 2;
    const rb = lengthOf(b) * NOSE_REACH + NOSE_GAP / 2;
    const noses = stay ? pb.clone().addScaledVector(dir, -rb) : pa.clone().lerp(pb, 0.5).addScaledVector(dir, (ra - rb) / 2);
    const pose = (stand: THREE.Vector3 | null): MeetPose => ({ stand, face: new THREE.Vector3(), look: new THREE.Vector3(), sniff: 0 });
    meets.push({
      a,
      b,
      stay,
      startMs: now,
      tricked: false,
      poseA: pose(noses.clone().addScaledVector(dir, -ra)),
      poseB: pose(stay ? null : noses.clone().addScaledVector(dir, rb)), // null: a resting pet stays put
    });
    if (a === self()) lastMetMs.set(b, now);
    else if (b === self()) lastMetMs.set(a, now);
    feed(`🐾 ${nameOf(a)} is saying hi to ${nameOf(b)}`);
    return true;
  }

  function endMeet(m: Meet) {
    meets.splice(meets.indexOf(m), 1);
    for (const id of [m.a, m.b]) {
      const pet = pets.get(id);
      if (pet) pet.meet = null;
    }
  }

  /** This phone's pet goes to say hi to `to`'s pet (the 🐾 button, or by itself). */
  function sayHi(to: string, now: number): boolean {
    const me = self();
    const pet = pets.get(to);
    if (!me || !pet) return false;
    const stay = pet.resting;
    if (!startMeet(me, to, stay, now)) return false;
    room.sendEvent({ k: "meet", to, stay } satisfies PetEvent);
    return true;
  }

  /** The friend's pet to say hi to: shown, free, met least recently (nearest among never-met). */
  function pickFriend(): string | null {
    let best: string | null = null;
    let bestKey = Infinity;
    for (const [id, pet] of pets) {
      if (!pet.anchor.visible || busy(id) || !anchor) continue;
      const key = (lastMetMs.get(id) ?? -1e12) + pet.anchor.position.distanceTo(anchor.position);
      if (key < bestKey) {
        bestKey = key;
        best = id;
      }
    }
    return best;
  }

  function updateMeets(now: number) {
    const me = self();
    let mine = false;
    for (const m of [...meets]) {
      const t = (now - m.startMs) / 1000;
      if (t >= MEET_END_S || !whereIs(m.a, point) || !whereIs(m.b, point)) {
        endMeet(m);
        continue;
      }
      const sniff = t >= MEET_SNIFF_S ? 0.8 : 0;
      const sides: [string, string, MeetPose][] = [
        [m.a, m.b, m.poseA],
        [m.b, m.a, m.poseB],
      ];
      for (const [id, other, pose] of sides) {
        whereIs(other, pose.face);
        eyesOf(other, pose.look);
        pose.sniff = sniff;
        if (id === me) {
          mine = true;
          social.stand = pose.stand;
          social.face.copy(pose.face);
          social.look.copy(pose.look);
          social.sniff = sniff;
          social.status = `Saying hi to ${nameOf(other)}`;
        } else {
          const pet = pets.get(id); // walks over, or (resting) only looks at the visitor
          if (pet) pet.meet = pose;
        }
      }
      if (!m.tricked && t >= MEET_TRICK_S) {
        m.tricked = true;
        const sa = speciesOf(m.a);
        const sb = speciesOf(m.b);
        const tricks = sa && sb ? MEET_TRICKS[sa]?.[sb] : undefined;
        // Not while someone pets this phone's pet: it stayed for the pats, a trick would break them off.
        const petted = !!dog && dog.controls.petHead + dog.controls.petBody > 0.1;
        if (tricks && !petted && m.a === me) hooks.command(tricks[0]);
        if (tricks && !petted && m.b === me && !m.stay) hooks.command(tricks[1]);
      }
    }
    if (mine) {
      hooks.social(social);
      socialOn = true;
    } else if (socialOn) {
      hooks.social(null);
      socialOn = false;
    }

    // Now and then an idle pet goes to say hi by itself.
    if (now >= nextAutoMeetMs) {
      nextAutoMeetMs = now + rand(MEET_AUTO_MIN_S, MEET_AUTO_MAX_S) * 1000;
      const to = me && dog && !busy(me) && hooks.sociable() ? pickFriend() : null;
      if (to) sayHi(to, now);
    }
  }

  cleanups.push(
    room.onState((from, d) => {
      const s = readState(d);
      if (s) petFor(from)?.push(s, performance.now());
    }),
    room.onEvent((from, d) => {
      const e = readEvent(d);
      if (e) onEvent(from, e);
    }),
    room.onChange(() => {
      if (room.status === "reconnecting" && !connectionLost) {
        connectionLost = true;
        feed("📡 Connection lost, reconnecting…");
      }
      // While this phone reconnects the roster is empty; friends keep their ids, so wait for it.
      if (room.status !== "open") return;
      if (connectionLost) {
        connectionLost = false;
        feed("📡 Reconnected");
      }
      for (const id of [...pets.keys(), ...slots.keys()]) {
        if (!room.peers.has(id)) {
          if (seenPlaying.has(id)) feed(`${petName(pets.get(id)?.card ?? null)} left the party`);
          forget(id);
        }
      }
    }),
  );

  const party = partyButton(() => {
    const now = performance.now();
    if (!dog || now - lastPartyMs < PARTY_COOLDOWN_MS) return;
    lastPartyMs = now;
    const trick = hooks.tricks[Math.floor(Math.random() * hooks.tricks.length)];
    hooks.command(trick);
    room.sendEvent({ k: "cmd", c: trick, to: "*" } satisfies PetEvent);
    feed(room.peers.size ? `🎉 Everyone: ${TRICK_LABEL[trick].toLowerCase()}!` : "🎉 Invite friends so their pets join in");
    navigator.vibrate?.(20);
  });
  if (party) party.el.disabled = true;

  const hi = sayHiButton(() => {
    const me = self();
    if (!dog) return;
    if (!me) return void feed(room.status === "full" ? `${roomName} is full: playing solo` : "📡 Connecting to the room…");
    if (busy(me)) return void feed(`🐾 ${myName()} is already saying hi`);
    const to = pickFriend();
    if (!to) return void feed(room.peers.size ? "🐾 No friend's pet to say hi to right now" : "🐾 Invite friends so their pets can meet yours");
    if (sayHi(to, performance.now())) navigator.vibrate?.(12);
  });
  if (hi) hi.el.disabled = true;

  const friends = room.peers.size;
  const roomName = `👥 Room ${room.code.toUpperCase()}`;
  feed(
    room.status === "full"
      ? `${roomName} is full: playing solo`
      : friends
        ? `${roomName} · ${friends} friend${friends > 1 ? "s" : ""} here`
        : `${roomName} · waiting for friends`,
  );

  /** Is the palm or a fingertip of `h` inside `zone`? Writes the contact point. */
  function handIn(zone: THREE.Sphere, h: PerceivedHand, out: THREE.Vector3): boolean {
    if (zone.containsPoint(h.palm)) {
      out.copy(h.palm);
      return true;
    }
    for (const i of FINGERTIPS) {
      const p = h.points[i];
      if (p && zone.containsPoint(p)) {
        out.copy(p);
        return true;
      }
    }
    return false;
  }

  /** This phone's hands on friends' pets. */
  function petFriends(dt: number, now: number, hands: PerceivedHand[]) {
    for (const [id, pet] of pets) {
      if (!pet.anchor.visible) {
        touches.delete(id);
        continue;
      }
      pet.zones(zones);
      let zone: "head" | "body" | null = null;
      for (const h of hands) {
        if (h.age > HAND_MAX_AGE || h.confidence < HAND_MIN_CONF) continue;
        zone = handIn(zones.head, h, point) ? "head" : handIn(zones.body, h, point) ? "body" : null;
        if (zone) break;
      }
      let t = touches.get(id);
      if (!zone) {
        if (t && (t.idle += dt) >= TOUCH_RELEASE_S) touches.delete(id);
        continue;
      }
      if (!t) touches.set(id, (t = { zone, held: 0, idle: 0, active: false, sentMs: -Infinity }));
      t.zone = zone;
      t.held += dt;
      t.idle = 0;
      if (!t.active && t.held >= TOUCH_DWELL_S) {
        t.active = true;
        hooks.burst(point, zone);
        navigator.vibrate?.(petBuzz(pet.model.species, zone));
      }
      if (!t.active) continue;
      pet.touch(zone, now);
      if (now - t.sentMs >= PET_REPEAT_MS) {
        t.sentMs = now;
        room.sendEvent({ k: "pet", to: id, z: zone } satisfies PetEvent);
      }
    }
  }

  return {
    attach(newDog, newAnchor) {
      dog = newDog;
      anchor = newAnchor;
      stage = null;
      if (party) party.el.disabled = false;
      if (hi) hi.el.disabled = false;
    },

    beforeDogUpdate(dt) {
      if (!dog) return;
      const now = performance.now();
      const k = 1 - Math.exp(-dt / 0.12);
      pettedHead += ((now < pettedHeadUntil ? 1 : 0) - pettedHead) * k;
      pettedBody += ((now < pettedBodyUntil ? 1 : 0) - pettedBody) * k;
      if (pettedHead + pettedBody < 1e-3) return;
      const c = dog.controls;
      c.petHead = Math.max(c.petHead, pettedHead);
      c.petBody = Math.max(c.petBody, pettedBody);
      c.excitement = Math.max(c.excitement, Math.max(pettedHead, pettedBody));
    },

    update(dt, perception) {
      if (disposed) return;
      const now = performance.now();

      if (dog && anchor) {
        const p = anchor.position;
        if (!stage || p.distanceTo(lastPos) > TELEPORT_M) {
          stage = { x: p.x, y: p.y, z: p.z, yaw: anchor.rotation.y };
          // Re-placed: friends' pets jump to their new spots, so meetings planned around the old ones end.
          for (const m of [...meets]) endMeet(m);
          for (const pet of pets.values()) pet.stopMeet();
        }
        lastPos.copy(p);
        if (now - lastSendMs >= SEND_EVERY_MS) {
          lastSendMs = now;
          const dx = p.x - stage.x;
          const dz = p.z - stage.z;
          const cs = Math.cos(stage.yaw);
          const sn = Math.sin(stage.yaw);
          room.sendState(writeState(now, cs * dx - sn * dz, sn * dx + cs * dz, wrapAngle(anchor.rotation.y - stage.yaw), dog.controls));
        }
      }

      for (const [id, pet] of pets) {
        const peer = room.peers.get(id);
        const live = !!peer && !!stage && !pet.away && now - peer.lastStateMs < STALE_MS;
        pet.anchor.visible = live;
        if (!live) pet.stopMeet(); // shows up again where its owner has it, not at an old meeting spot
        if (!live || !stage) continue;
        const [sx, sz] = SLOTS[slots.get(id) ?? 0];
        pet.update(dt, now, stage, sx, sz);
        if (!seenPlaying.has(id)) {
          seenPlaying.add(id);
          feed(`🐾 ${petName(pet.card)} joined the party`);
        }
      }

      updateMeets(now);
      petFriends(dt, now, perception.hands);
    },

    commanded(cmd) {
      room.sendEvent({ k: "cmd", c: cmd } satisfies PetEvent);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      room.sendEvent({ k: "away" } satisfies PetEvent);
      for (const off of cleanups) off();
      for (const id of [...pets.keys()]) forget(id);
      meets.length = 0;
      if (socialOn) hooks.social(null);
      socialOn = false;
      party?.remove();
      hi?.remove();
      clearFeed();
      dog = null;
      anchor = null;
    },
  };
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}
