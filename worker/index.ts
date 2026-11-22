import { DurableObject } from "cloudflare:workers";
import {
  MAX_MESSAGE_CHARS,
  MAX_PET_CARD_CHARS,
  MAX_PLAYERS,
  ROOM_CODE_RE,
  ROOM_PATH,
  type ClientMessage,
  type PeerInfo,
  type PetCard,
  type ServerMessage,
} from "../src/net/protocol";

/*
 * The deployed app: one Cloudflare Worker that serves the built site (dist/) and, at
 * /party/<code>, hands the WebSocket to that room's Durable Object. Every room code gets its own
 * Room instance, created on first use. Protocol: src/net/protocol.ts.
 *
 * Room uses the WebSocket Hibernation API: between messages the object can be evicted while
 * the phones stay connected, so all per-player state lives in the socket attachment.
 */

interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<Room>;
}

type Attachment = { id: string; pet: PetCard | null; welcomed: boolean; since: number };

/** Phones ping every 20 s (src/net/room.ts); one silent this long lost its network without closing. */
const SILENT_MS = 65_000;
const SWEEP_MS = 30_000;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(ROOM_PATH)) return env.ASSETS.fetch(request);

    const code = decodeURIComponent(url.pathname.slice(ROOM_PATH.length)).toLowerCase();
    if (!ROOM_CODE_RE.test(code)) return new Response("Bad room code", { status: 400 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID().slice(0, 8), pet: null, welcomed: false, since: Date.now() } satisfies Attachment);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Every SWEEP_MS while anyone is connected: drop players who stopped pinging, so they free their slot. */
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const me = ws.deserializeAttachment() as Attachment | null;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      if (now - Math.max(me?.since ?? 0, pinged) < SILENT_MS) continue;
      this.leave(ws);
      try {
        ws.close(4008, "No ping");
      } catch {
        /* already closed */
      }
    }
    if (this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_CHARS) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment() as Attachment | null;
    if (!me || !msg || typeof msg !== "object") return;

    if (msg.t === "hello") {
      const pet = petCard(msg.pet);
      if (!me.welcomed) {
        if (this.welcomed(ws).length >= MAX_PLAYERS) {
          send(ws, { t: "full" });
          ws.close(4003, "Room is full");
          return;
        }
        ws.serializeAttachment({ ...me, pet, welcomed: true } satisfies Attachment);
        send(ws, { t: "welcome", id: me.id, peers: this.welcomed(ws).map(({ id, pet }) => ({ id, pet })) });
      } else {
        ws.serializeAttachment({ ...me, pet } satisfies Attachment);
      }
      this.broadcast(ws, { t: "peer", id: me.id, pet });
      return;
    }
    if ((msg.t === "s" || msg.t === "e") && me.welcomed) {
      this.broadcast(ws, { t: msg.t, id: me.id, d: msg.d });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.leave(ws);
    try {
      // Complete the closing handshake (codes that can't be sent back get a plain close).
      if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) ws.close(code, reason);
      else ws.close();
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  private leave(ws: WebSocket) {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (!me?.welcomed) return;
    ws.serializeAttachment({ ...me, welcomed: false } satisfies Attachment); // close + error both arrive sometimes
    this.broadcast(ws, { t: "leave", id: me.id });
  }

  /** Everyone who said hello, except `skip`. */
  private welcomed(skip: WebSocket): (PeerInfo & { ws: WebSocket })[] {
    const out: (PeerInfo & { ws: WebSocket })[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === skip) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.welcomed) out.push({ id: a.id, pet: a.pet, ws });
    }
    return out;
  }

  private broadcast(from: WebSocket, msg: ServerMessage) {
    const text = JSON.stringify(msg);
    for (const peer of this.welcomed(from)) {
      try {
        peer.ws.send(text);
      } catch {
        /* closing: its webSocketClose sends the leave */
      }
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* closing */
  }
}

/** A plausible pet card or null. The config itself is sanitised by every phone that builds the pet. */
function petCard(raw: unknown): PetCard | null {
  if (!raw || typeof raw !== "object") return null;
  const { kind, config } = raw as Partial<PetCard>;
  if (typeof kind !== "string" || kind.length > 24 || !config || typeof config !== "object") return null;
  const card: PetCard = { kind, config };
  return JSON.stringify(card).length <= MAX_PET_CARD_CHARS ? card : null;
}
