import { ROOM_PATH, type ClientMessage, type PetCard, type ServerMessage } from "./protocol";

/*
 * One phone's connection to a room (protocol.ts). Reconnects on its own: phones drop the socket
 * when the screen locks or the browser goes to the background, so a closed connection retries
 * with backoff and immediately when the page becomes visible again. A socket can also die without
 * closing (Wi-Fi to cellular, sleep): a ping that gets no pong counts as a close. After every
 * reconnect the server sends a fresh roster and this phone's pet card is sent again.
 */

export type RoomStatus = "connecting" | "open" | "reconnecting" | "full" | "closed";

export interface Peer {
  readonly id: string;
  pet: PetCard | null;
  /** performance.now() of this player's last state snapshot (-Infinity: none yet, i.e. not in AR). */
  lastStateMs: number;
}

export interface RoomClient {
  readonly code: string;
  readonly status: RoomStatus;
  /** This phone's id in the room (null until welcomed). */
  readonly selfId: string | null;
  /** Everyone else in the room. */
  readonly peers: ReadonlyMap<string, Peer>;
  /** The pet this phone shows the room; re-sent after every reconnect. */
  setPet(pet: PetCard | null): void;
  /** No-ops while disconnected or alone. */
  sendState(d: unknown): void;
  sendEvent(d: unknown): void;
  /** Roster or connection status changed. Returns an unsubscribe. */
  onChange(fn: () => void): () => void;
  onState(fn: (from: Peer, d: unknown) => void): () => void;
  onEvent(fn: (from: Peer, d: unknown) => void): () => void;
  close(): void;
}

/** The server drops a socket that hasn't pinged for ~65 s (worker/index.ts). */
const PING_MS = 20_000;
const PONG_WAIT_MS = 5_000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 8_000;

/**
 * The room server lives on the same origin as the page (the deployed worker, or the Vite dev
 * server's /party proxy to `wrangler dev`). VITE_ROOM_SERVER (e.g. wss://hw13-pets.you.workers.dev)
 * points a local front-end at another server instead.
 */
function roomURL(code: string): string {
  const configured = (import.meta.env.VITE_ROOM_SERVER as string | undefined)?.trim();
  const origin = configured ? configured.replace(/\/+$/, "") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  return `${origin}${ROOM_PATH}${encodeURIComponent(code)}`;
}

export function connectRoom(code: string): RoomClient {
  const peers = new Map<string, Peer>();
  const changeFns = new Set<() => void>();
  const stateFns = new Set<(from: Peer, d: unknown) => void>();
  const eventFns = new Set<(from: Peer, d: unknown) => void>();
  let ws: WebSocket | null = null;
  let status: RoomStatus = "connecting";
  let selfId: string | null = null;
  let pet: PetCard | null = null;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastHeardMs = 0;
  let pingSentMs = 0;
  let closed = false;

  function emit<A extends unknown[]>(fns: Set<(...args: A) => void>, ...args: A) {
    for (const fn of fns) {
      try {
        fn(...args);
      } catch (err) {
        console.error("[room] listener failed", err);
      }
    }
  }

  function setStatus(next: RoomStatus) {
    status = next;
    emit(changeFns);
  }

  function send(msg: ClientMessage) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function open() {
    clearTimeout(retryTimer);
    if (closed || ws) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(roomURL(code));
    } catch (err) {
      console.warn("[room] can't connect", err);
      retry();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      retries = 0;
      lastHeardMs = performance.now();
      pingSentMs = 0;
      send({ t: "hello", pet });
      pingTimer = setInterval(() => {
        if (lastHeardMs < pingSentMs && performance.now() - pingSentMs >= PONG_WAIT_MS) lost(sock);
        else ping(sock);
      }, PING_MS);
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      lastHeardMs = performance.now();
      if (typeof e.data !== "string" || e.data === "pong") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      handle(msg);
    };
    sock.onclose = () => lost(sock);
  }

  function ping(sock: WebSocket): number {
    pingSentMs = performance.now();
    if (sock.readyState === WebSocket.OPEN) sock.send("ping");
    return pingSentMs;
  }

  /** The socket closed or went silent: forget the roster and reconnect. */
  function lost(sock: WebSocket) {
    if (ws !== sock) return;
    ws = null;
    sock.onopen = sock.onmessage = sock.onclose = null;
    sock.close();
    clearInterval(pingTimer);
    clearTimeout(wakeTimer);
    selfId = null;
    peers.clear();
    if (closed || status === "full") {
      emit(changeFns);
      return;
    }
    setStatus("reconnecting");
    retry();
  }

  function retry() {
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** retries++) * (0.75 + Math.random() * 0.5);
    retryTimer = setTimeout(open, delay);
  }

  function handle(msg: ServerMessage) {
    switch (msg.t) {
      case "welcome":
        selfId = msg.id;
        peers.clear();
        for (const p of msg.peers) peers.set(p.id, { id: p.id, pet: p.pet, lastStateMs: -Infinity });
        setStatus("open");
        return;
      case "peer": {
        const known = peers.get(msg.id);
        if (known) known.pet = msg.pet;
        else peers.set(msg.id, { id: msg.id, pet: msg.pet, lastStateMs: -Infinity });
        emit(changeFns);
        return;
      }
      case "leave":
        if (peers.delete(msg.id)) emit(changeFns);
        return;
      case "s": {
        const from = peers.get(msg.id);
        if (!from) return;
        const wasAway = !Number.isFinite(from.lastStateMs);
        from.lastStateMs = performance.now();
        emit(stateFns, from, msg.d);
        if (wasAway) emit(changeFns); // roster shows who is playing
        return;
      }
      case "e": {
        const from = peers.get(msg.id);
        if (from) emit(eventFns, from, msg.d);
        return;
      }
      case "full":
        setStatus("full");
        return;
    }
  }

  /** Back from the background: reconnect now, or check that the socket that survived still works. */
  const onVisible = () => {
    if (document.visibilityState !== "visible" || closed || status === "full") return;
    if (!ws) {
      retries = 0;
      open();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const sock = ws;
    const sent = ping(sock);
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => lastHeardMs < sent && lost(sock), PONG_WAIT_MS);
  };
  document.addEventListener("visibilitychange", onVisible);
  open();

  const subscribe =
    <F>(set: Set<F>) =>
    (fn: F) => {
      set.add(fn);
      return () => void set.delete(fn);
    };

  return {
    code,
    get status() {
      return status;
    },
    get selfId() {
      return selfId;
    },
    peers,
    setPet(next) {
      pet = next;
      send({ t: "hello", pet }); // before the socket is open, onopen sends it
    },
    sendState(d) {
      if (selfId && peers.size > 0) send({ t: "s", d });
    },
    sendEvent(d) {
      if (selfId && peers.size > 0) send({ t: "e", d });
    },
    onChange: subscribe(changeFns),
    onState: subscribe(stateFns),
    onEvent: subscribe(eventFns),
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      clearTimeout(wakeTimer);
      document.removeEventListener("visibilitychange", onVisible);
      const sock = ws;
      ws = null;
      sock?.close(1000, "left");
      peers.clear();
      setStatus("closed");
      changeFns.clear();
      stateFns.clear();
      eventFns.clear();
    },
  };
}
