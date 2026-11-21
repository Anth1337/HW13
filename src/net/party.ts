import * as THREE from "three";
import { TRICK_LABEL, type DogCommand, type PetCharacter, type PetZones, type TrickKind } from "../dog/types";
import type { PerceivedHand, Perception } from "../vision/types";
import { currentRoom } from "./index";
import { createPetModel, localPetCard, petBuzz, petName } from "./kinds";
import { RemotePet, type Stage } from "./remotePet";
import type { Peer } from "./room";
import { PET_REPEAT_MS, readEvent, readState, wrapAngle, writeState, type PetEvent } from "./sync";
import { clearFeed, feed, partyButton } from "./ui";

/*
 * Multiplayer inside one AR / camera session (dogPlay.ts creates it when the page is in a room):
 *  - sends this phone's pet ~10 times a second: where it is relative to where it was placed,
 *    and its DogControls (sync.ts)
 *  - shows friends' pets standing around this phone's pet (remotePet.ts)
 *  - a hand on a friend's pet makes it lean in here, on its owner's phone and on everyone
 *    else's; a friend's hand on this phone's pet does the same here
 *  - the feed (who joined, petting, tricks) and the 🎉 button: every pet in the room does the
 *    same trick at once
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

type Touch = { zone: "head" | "body"; held: number; idle: number; active: boolean; sentMs: number };

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
    // "away": they went back to the creator.
    from.lastStateMs = -Infinity;
    pets.get(from.id)?.reset();
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
        if (!stage || p.distanceTo(lastPos) > TELEPORT_M) stage = { x: p.x, y: p.y, z: p.z, yaw: anchor.rotation.y };
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
        if (!live || !stage) continue;
        const [sx, sz] = SLOTS[slots.get(id) ?? 0];
        pet.update(dt, now, stage, sx, sz);
        if (!seenPlaying.has(id)) {
          seenPlaying.add(id);
          feed(`🐾 ${petName(pet.card)} joined the party`);
        }
      }

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
      party?.remove();
      clearFeed();
      dog = null;
      anchor = null;
    },
  };
}
