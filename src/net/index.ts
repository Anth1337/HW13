import { randomDogConfig } from "../dog/config";
import { petStore } from "../pets";
import { localPetCard } from "./kinds";
import { ROOM_CODE_RE } from "./protocol";
import { connectRoom, type RoomClient } from "./room";

/*
 * The page's room: at most one, picked from ?room=<code> on load or created with joinRoom()
 * (the 👥 button in ui.ts). Without a room the game is single-player, exactly as before.
 */

let room: RoomClient | null = null;
const listeners = new Set<(room: RoomClient | null) => void>();

export function currentRoom(): RoomClient | null {
  return room;
}

/** Fires when the page joins or leaves a room. Returns an unsubscribe. */
export function onRoomChange(fn: (room: RoomClient | null) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(room);
}

export function roomCodeFromURL(): string | null {
  const code = new URLSearchParams(location.search).get("room")?.trim().toLowerCase();
  return code && ROOM_CODE_RE.test(code) ? code : null;
}

/** The link friends open (and the QR code shows) to join `code`. */
export function inviteURL(code: string): string {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", code);
  return url.toString();
}

/** Short and easy to read out: no 0/o, 1/l/i. */
export function newRoomCode(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function joinRoom(code: string): RoomClient {
  room?.close();
  room = connectRoom(code);
  room.setPet(localPetCard());
  history.replaceState(history.state, "", inviteURL(code));
  emit();
  return room;
}

export function leaveRoom(): void {
  if (!room) return;
  room.close();
  room = null;
  const url = new URL(location.href);
  url.searchParams.delete("room");
  history.replaceState(history.state, "", url.toString());
  emit();
}

/**
 * Joins ?room=… if the page was opened from an invite, and keeps the room's copy of this pet up to
 * date. A first-time guest (no saved pets) gets a random dog in slot 1 so a room isn't full of
 * identical default labradors.
 */
export function initNet(): void {
  const code = roomCodeFromURL();
  if (code) {
    if (!petStore.slots().some((p) => p)) {
      petStore.create(0, "dog");
      petStore.updateActive(randomDogConfig());
    }
    joinRoom(code);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  petStore.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => room?.setPet(localPetCard()), 300); // sliders fire continuously
  });
}
