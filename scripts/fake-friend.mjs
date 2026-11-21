// A scripted friend for trying multiplayer without a second phone: Mochi the corgi joins a room,
// walks in circles, sits, does tricks (they show in your feed) and pets your dog now and then.
//
//   npm run fake-friend -- <invite link> [minutes]                e.g. https://hw13-pets.you.workers.dev/?room=abcd
//   npm run fake-friend -- <room code> [server] [minutes]         server defaults to http://127.0.0.1:8787 (npm run dev:rooms)
//
// Stays 10 minutes by default; Ctrl+C to stop. Needs Node 22+ (built-in WebSocket).

const args = process.argv.slice(2);
if (!args[0]) {
  console.log("usage: npm run fake-friend -- <invite link> [minutes]\n       npm run fake-friend -- <room code> [server] [minutes]");
  process.exit(1);
}
let room = args[0];
let server = "http://127.0.0.1:8787";
let minutesArg = args[2];
if (/^https?:\/\//.test(args[0])) {
  const url = new URL(args[0]);
  room = url.searchParams.get("room") ?? "";
  server = url.origin;
  minutesArg = args[1];
} else if (args[1]) {
  server = args[1];
}
room = room.trim().toLowerCase();
if (!/^[a-z0-9_-]{1,24}$/.test(room)) {
  console.log(`No room code in "${args[0]}"`);
  process.exit(1);
}
const minutes = Number(minutesArg ?? 10);
const wsURL = `${server.replace(/\/+$/, "").replace(/^http/, "ws")}/party/${room}`;

const ws = new WebSocket(wsURL);
const peers = new Map(); // id -> pet name
const t0 = performance.now();
let done = false;

const secs = () => (performance.now() - t0) / 1000;
const log = (...a) => console.log(`[${secs().toFixed(0).padStart(4)}s]`, ...a);
const send = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
const nameOf = (pet) => pet?.config?.name ?? "a pet";

ws.addEventListener("open", () => {
  log(`Connected to ${wsURL}`);
  send({ t: "hello", pet: { kind: "dog", config: { version: 1, name: "Mochi", breed: "corgi" } } });
});
ws.addEventListener("message", (e) => {
  if (e.data === "pong") return;
  const m = JSON.parse(e.data);
  if (m.t === "welcome") {
    for (const p of m.peers) peers.set(p.id, nameOf(p.pet));
    log(`Mochi is in room ${room.toUpperCase()}. Already here: ${[...peers.values()].join(", ") || "nobody yet"}`);
  } else if (m.t === "peer") {
    if (!peers.has(m.id)) log(`${nameOf(m.pet)} joined`);
    peers.set(m.id, nameOf(m.pet));
  } else if (m.t === "leave") {
    log(`${peers.get(m.id) ?? m.id} left`);
    peers.delete(m.id);
  } else if (m.t === "e") {
    log(`${peers.get(m.id) ?? m.id}: ${JSON.stringify(m.d)}`);
  } else if (m.t === "full") {
    log("The room is full");
  }
});
ws.addEventListener("error", () => log(`Can't reach ${wsURL}`));
ws.addEventListener("close", (e) => {
  if (!done) log(`Disconnected (${e.code}${e.reason ? ` ${e.reason}` : ""})`);
  process.exit(done ? 0 : 1);
});

// Like a phone (src/net/room.ts): the room drops players that stop pinging.
const pinger = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 20_000);

// Routine, repeating every 24 s: 0-6 walk a circle, 6-10 sit (pets your dog at 7-9), 10-13 spin,
// 13-17 walk, 17-20 roll over, 20-24 stand.
function routine(t) {
  const cycle = Math.floor(t / 24) * 24;
  const c = t - cycle;
  if (c < 6 || (c >= 13 && c < 17)) return { walk: true };
  if (c < 10) return { sit: Math.min(1, (c - 6) / 0.5), pet: c > 7 && c < 9 };
  if (c < 13) return { trick: "spin", start: cycle + 10, dur: 1.6 };
  if (c < 20) return { trick: "rollOver", start: cycle + 17, dur: 2.8 };
  return {};
}

let phase = 0;
let x = 0;
let z = 0;
let h = 0;
let lastTrick = -1;
let lastSit = -1;
let lastPet = 0;
let last = performance.now();

const ticker = setInterval(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  const t = secs();
  const r = routine(t);
  let trick = null;
  if (r.walk) {
    phase += dt * 1.8;
    h += dt * 0.9;
    x += Math.sin(h) * dt * 0.35;
    z += Math.cos(h) * dt * 0.35;
  }
  if (r.trick) {
    const p = (t - r.start) / r.dur;
    if (p <= 1) trick = [r.trick, Math.round(p * 1000) / 1000];
    if (r.start !== lastTrick) {
      lastTrick = r.start;
      send({ t: "e", d: { k: "cmd", c: r.trick } });
    }
  }
  if (r.sit && Math.floor(t / 24) !== lastSit) {
    lastSit = Math.floor(t / 24);
    send({ t: "e", d: { k: "cmd", c: "sit" } });
  }
  const target = [...peers.keys()][0];
  if (r.pet && target && now - lastPet >= 250) {
    lastPet = now;
    send({ t: "e", d: { k: "pet", to: target, z: "head" } });
  }
  send({
    t: "s",
    d: {
      t: Math.round(now),
      x: +x.toFixed(3),
      z: +z.toFixed(3),
      h: +h.toFixed(3),
      g: [+phase.toFixed(3), r.walk ? 0.45 : 0, r.walk ? 0.3 : 0],
      c: [r.sit ?? 0, 0, 0, r.walk ? 0.5 : 0.3, 0, 0, 0],
      l: null,
      p: null,
      k: trick,
    },
  });
  if (t > minutes * 60) stop();
}, 100);

function stop() {
  if (done) return;
  done = true;
  clearInterval(ticker);
  clearInterval(pinger);
  log("Mochi says bye");
  ws.close(1000, "bye");
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", stop);
