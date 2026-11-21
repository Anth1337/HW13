/*
 * Messages between phones and the room server (worker/index.ts): JSON text over one WebSocket
 * per phone at /party/<room code>. Shared by the worker and the web app, so no imports here.
 *
 * The server is a relay. It gives every connection an id, keeps each player's pet card (for
 * players who join later) and forwards states / events to everyone else in the room with the
 * sender's id added. What is inside a state or an event is up to the phones (src/net/sync.ts).
 *
 *   phone → server   { t: "hello", pet }    first message after connecting, again when the pet changes
 *                    { t: "s", d }          pet state snapshot (~10 per second while in AR)
 *                    { t: "e", d }          event (command, petting, …)
 *   server → phone   { t: "welcome", id, peers }   reply to the first hello: your id + who is here
 *                    { t: "peer", id, pet }        someone joined or changed their pet
 *                    { t: "leave", id }
 *                    { t: "s", id, d } / { t: "e", id, d }
 *                    { t: "full" }                 the room already has MAX_PLAYERS (then closed)
 * The text "ping" is answered with "pong" by the runtime (keeps idle connections alive).
 */

export const ROOM_PATH = "/party/";
export const MAX_PLAYERS = 8;
/** Room codes, lower-cased: letters, digits, "-" and "_". */
export const ROOM_CODE_RE = /^[a-z0-9_-]{1,24}$/;
/** Bigger messages are dropped by the server. */
export const MAX_MESSAGE_CHARS = 8192;
/** Bigger pet cards are refused (the server keeps one per connection). */
export const MAX_PET_CARD_CHARS = 4096;

/** What a player shows the room: which model to build and its creator settings (receivers sanitise them). */
export interface PetCard {
  kind: string;
  config: unknown;
}

export interface PeerInfo {
  id: string;
  pet: PetCard | null;
}

export type ClientMessage = { t: "hello"; pet: PetCard | null } | { t: "s"; d: unknown } | { t: "e"; d: unknown };

export type ServerMessage =
  | { t: "welcome"; id: string; peers: PeerInfo[] }
  | { t: "peer"; id: string; pet: PetCard | null }
  | { t: "leave"; id: string }
  | { t: "s"; id: string; d: unknown }
  | { t: "e"; id: string; d: unknown }
  | { t: "full" };
