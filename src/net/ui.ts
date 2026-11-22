import { renderSVG } from "uqr";
import "./net.css";
import { currentRoom, ensureGuestPet, inviteURL, joinRoom, leaveRoom, newRoomCode, onRoomChange } from "./index";
import { localPetCard, petEmoji, petName } from "./kinds";
import { petStore } from "../pets";
import { MAX_PLAYERS, ROOM_CODE_RE } from "./protocol";
import type { RoomClient } from "./room";

/*
 * Room UI, built from code so index.html stays as it is:
 *  - start screen: a 👥 button next to Deploy that opens the "Play together" sheet:
 *      lobby (not in a room): the pet you'll bring, a room-code box to join a friend (a pasted
 *        invite link works too), or "Start a new room"
 *      room: QR code + code + link (copy / share), who is in the room (big enough to show on a
 *        projector), and Leave
 *  - AR / camera overlay: the feed (short chips under the hint) and the 🐾 say-hi button
 * Names come from other players: always set with textContent.
 */

const FEED_S = 3.2;
const FEED_MAX = 3;
/** Someone who sent a snapshot this recently is in AR with their pet. */
const PLAYING_MS = 3000;

/** A room code from what someone typed or pasted: "ABCD", " ab cd ", or a whole invite link. */
export function parseRoomInput(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  if (/room=|^https?:\/\//i.test(text)) {
    // Only the code token: text pasted along with the link must not become part of it.
    const m = /[?&]room=([a-z0-9_-]+)/i.exec(text);
    if (!m) return null;
    text = m[1];
  } else {
    text = text.replace(/\s+/g, ""); // " ab cd " typed with spaces
  }
  const code = text.toLowerCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

export function mountRoomUI(actions: HTMLElement): void {
  const button = el("button", "btn net-friends");
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  actions.prepend(button);

  const sheet = el("div", "net-sheet");
  sheet.hidden = true;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "net-title");
  const card = el("div", "net-card");
  const head = el("div", "net-card-head");
  const title = el("h2", "net-title", "Play together");
  title.id = "net-title";
  const close = el("button", "net-x", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  head.append(title, close);

  /* ---- Lobby: join a friend's room, or start one ---- */
  const lobby = el("div", "net-lobby");
  const bringing = el("p", "net-bringing");
  const joinForm = el("form", "net-join");
  joinForm.noValidate = true;
  const joinLabel = el("label", "net-h net-join-label", "Join a friend");
  joinLabel.htmlFor = "net-code-input";
  const joinRow = el("div", "net-join-row");
  const codeInput = el("input", "net-code-input");
  codeInput.id = "net-code-input";
  codeInput.type = "text";
  codeInput.placeholder = "Room code";
  codeInput.autocomplete = "off";
  codeInput.spellcheck = false;
  codeInput.maxLength = 200; // room for a pasted invite link
  codeInput.setAttribute("autocapitalize", "characters");
  codeInput.setAttribute("autocorrect", "off");
  codeInput.setAttribute("enterkeyhint", "go");
  codeInput.setAttribute("aria-describedby", "net-join-help");
  const joinBtn = el("button", "btn btn-primary net-join-btn", "Join");
  joinBtn.type = "submit";
  joinRow.append(codeInput, joinBtn);
  const joinHelp = el("p", "net-help", "The 4-letter code on your friend's screen, or paste their invite link.");
  joinHelp.id = "net-join-help";
  joinHelp.setAttribute("aria-live", "polite"); // the error replaces this text
  joinForm.append(joinLabel, joinRow, joinHelp);
  const or = el("div", "net-or");
  or.append(el("span", "", "or"));
  const host = el("div", "net-host");
  const hostBtn = el("button", "btn net-host-btn", "Start a new room");
  hostBtn.type = "button";
  host.append(hostBtn, el("p", "net-help", "Get a code and QR to share. Up to " + MAX_PLAYERS + " pets per room."));
  lobby.append(bringing, joinForm, or, host);

  /* ---- In a room: invite + roster ---- */
  const inRoom = el("div", "net-room");
  const lead = el("p", "net-lead", "Friends scan this with their phone camera, or type the code.");
  const qr = el("div", "net-qr");
  const code = el("p", "net-code");
  const linkRow = el("div", "net-link-row");
  const link = el("a", "net-link");
  link.target = "_blank";
  link.rel = "noopener";
  const copy = el("button", "net-small", "Copy link");
  copy.type = "button";
  const share = el("button", "net-small", "Share…");
  share.type = "button";
  share.hidden = typeof navigator.share !== "function";
  linkRow.append(link, copy, share);
  const status = el("p", "net-status");
  status.setAttribute("role", "status");
  const listTitle = el("h3", "net-h");
  const list = el("ul", "net-list");
  const empty = el("p", "net-help net-empty", "No one else here yet. Share the code to invite friends.");
  const roomActions = el("div", "net-room-actions");
  const retry = el("button", "net-small", "Try another code");
  retry.type = "button";
  const leave = el("button", "net-small net-leave", "Leave room");
  leave.type = "button";
  roomActions.append(retry, leave);
  inRoom.append(lead, qr, code, linkRow, status, listTitle, list, empty, roomActions);

  card.append(head, lobby, inRoom);
  sheet.append(card);
  document.body.append(sheet);

  let shownFor: RoomClient | null = null;
  let unsub: (() => void) | null = null;
  let tick: ReturnType<typeof setInterval> | undefined;

  function setJoinError(msg: string | null) {
    joinHelp.textContent = msg ?? "The 4-letter code on your friend's screen, or paste their invite link.";
    joinHelp.classList.toggle("net-error", !!msg);
    codeInput.setAttribute("aria-invalid", String(!!msg));
  }

  function render() {
    const room = currentRoom();
    const count = room ? room.peers.size + 1 : 0;
    button.textContent = !room
      ? "👥 Friends"
      : room.status === "open"
        ? `👥 ${count} here`
        : room.status === "full"
          ? "👥 Room full"
          : "👥 Connecting…";
    button.title = room ? `Room ${room.code.toUpperCase()}: invite friends` : "Join a friend's room or start one";
    button.classList.toggle("net-in-room", !!room);
    if (sheet.hidden) return;

    const mine = localPetCard();
    lobby.hidden = !!room;
    inRoom.hidden = !room;
    title.textContent = room ? `Room ${room.code.toUpperCase()}` : "Play together";
    if (!room) {
      shownFor = null;
      bringing.replaceChildren();
      if (mine) bringing.append("You'll bring ", el("strong", "", `${petEmoji(mine)} ${petName(mine)}`), ".");
      else bringing.append("Create a pet first so friends can see it.");
      bringing.classList.toggle("net-warn", !mine);
      return;
    }

    if (shownFor !== room) {
      shownFor = room;
      const url = inviteURL(room.code);
      qr.innerHTML = renderSVG(url, { ecc: "M", border: 2 }); // our own URL, not user input
      link.href = url;
      link.textContent = url.replace(/^https?:\/\//, "");
      code.textContent = room.code.toUpperCase();
      code.setAttribute("aria-label", `Room code ${room.code.toUpperCase().split("").join(" ")}`);
    }
    status.textContent =
      room.status === "open"
        ? "Connected"
        : room.status === "full"
          ? `This room is full (${MAX_PLAYERS} players).`
          : room.status === "reconnecting"
            ? "Reconnecting…"
            : room.status === "closed"
              ? "Left the room"
              : "Connecting…";
    status.dataset.state = room.status;
    retry.hidden = room.status !== "full";
    const full = room.status === "full";
    qr.hidden = code.hidden = linkRow.hidden = lead.hidden = full;
    listTitle.textContent = `In this room (${count}/${MAX_PLAYERS})`;
    const now = performance.now();
    const rows: HTMLElement[] = [row(`${petEmoji(mine)} ${petName(mine)}`, "you")];
    for (const peer of room.peers.values()) {
      const playing = now - peer.lastStateMs < PLAYING_MS;
      rows.push(row(`${petEmoji(peer.pet)} ${petName(peer.pet)}`, playing ? "playing" : "getting ready"));
    }
    list.replaceChildren(...rows);
    listTitle.hidden = list.hidden = full;
    empty.hidden = full || room.peers.size > 0 || room.status !== "open";
  }

  function watch(room: RoomClient | null) {
    unsub?.();
    unsub = room ? room.onChange(render) : null;
    render();
  }

  let opener: HTMLElement | null = null;
  function open() {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.hidden = false;
    shownFor = null;
    setJoinError(null);
    render();
    clearInterval(tick);
    tick = setInterval(render, 1000); // "playing" fades without a roster change
    close.focus();
  }

  function hide() {
    sheet.hidden = true;
    clearInterval(tick);
    opener?.focus();
    opener = null;
  }

  function join(roomCode: string) {
    ensureGuestPet(); // friends should see a pet, not nothing
    joinRoom(roomCode); // onRoomChange → watch → render shows the room view
    codeInput.value = "";
    setJoinError(null);
    close.focus();
  }

  button.addEventListener("click", open);
  close.addEventListener("click", hide);
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) hide();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) hide();
  });
  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const roomCode = parseRoomInput(codeInput.value);
    if (!roomCode) {
      setJoinError(codeInput.value.trim() ? "That doesn't look like a room code. Check it and try again." : "Type the room code first.");
      codeInput.focus();
      return;
    }
    codeInput.blur(); // close the phone keyboard
    join(roomCode);
  });
  codeInput.addEventListener("input", () => {
    if (codeInput.getAttribute("aria-invalid") === "true") setJoinError(null);
  });
  hostBtn.addEventListener("click", () => join(newRoomCode()));
  copy.addEventListener("click", async () => {
    const room = currentRoom();
    if (!room) return;
    try {
      await navigator.clipboard.writeText(inviteURL(room.code));
      copy.textContent = "Copied!";
    } catch {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => (copy.textContent = "Copy link"), 1500);
  });
  share.addEventListener("click", async () => {
    const room = currentRoom();
    if (!room) return;
    try {
      await navigator.share({ title: "AR Pets", text: `Bring your pet to my room: ${room.code.toUpperCase()}`, url: inviteURL(room.code) });
    } catch {
      /* cancelled */
    }
  });
  leave.addEventListener("click", () => {
    leaveRoom(); // back to the lobby, sheet stays open
    hostBtn.focus();
  });
  retry.addEventListener("click", () => {
    leaveRoom();
    codeInput.focus();
  });
  petStore.subscribe(() => {
    if (!sheet.hidden) render();
  });

  onRoomChange(watch);
  watch(currentRoom());
}

function row(name: string, state: string): HTMLElement {
  const li = el("li", "net-row");
  li.append(el("span", "net-row-name", name), el("span", `net-row-state net-${state.replace(" ", "-")}`, state));
  return li;
}

// ---- In AR / camera mode ----

let feedBox: HTMLElement | null = null;

/** A short line under the AR hint for a few seconds ("Mochi joined the party"). */
export function feed(text: string): void {
  if (!feedBox?.isConnected) {
    const wrap = document.querySelector("#overlay .hint-wrap");
    if (!wrap) return;
    feedBox = el("div", "net-feed");
    feedBox.setAttribute("aria-live", "polite");
    wrap.append(feedBox);
  }
  const chip = el("span", "status-chip net-feed-chip", text);
  feedBox.append(chip);
  while (feedBox.childElementCount > FEED_MAX) feedBox.firstElementChild?.remove();
  setTimeout(() => chip.remove(), FEED_S * 1000);
}

export function clearFeed(): void {
  feedBox?.replaceChildren();
}

let pinBox: HTMLElement | null = null;

/** A line under the AR hint that stays until replaced or cleared (null): a step the user has to do. */
export function pinnedNote(text: string | null): void {
  if (text === null) {
    pinBox?.remove();
    pinBox = null;
    return;
  }
  if (!pinBox?.isConnected) {
    const wrap = document.querySelector("#overlay .hint-wrap");
    if (!wrap) return;
    pinBox = el("div", "status-chip net-pin");
    pinBox.setAttribute("aria-live", "polite");
    wrap.append(pinBox);
  }
  pinBox.textContent = text;
}

/** The 📍 button in the AR tools: line up with friends (tap the same two floor spots). */
export function alignButton(onClick: () => void): { el: HTMLButtonElement; remove(): void } | null {
  return toolButton("📍", "Line up with friends", "Line up: tap the same two floor spots as your friends, so pets stand where they really are", onClick);
}

/** The 🐾 button in the AR tools (taps on it never reach the AR scene): this phone's pet goes to say hi to a friend's pet. Null if the tools are missing. */
export function sayHiButton(onClick: () => void): { el: HTMLButtonElement; remove(): void } | null {
  return toolButton("🐾", "Say hi to a friend's pet", "Say hi: your pet goes to meet a friend's pet", onClick);
}

function toolButton(icon: string, label: string, title: string, onClick: () => void): { el: HTMLButtonElement; remove(): void } | null {
  const tools = document.querySelector("#ar-controls .ar-tools");
  if (!tools) return null;
  const b = el("button", "btn btn-small net-hi", icon);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  tools.prepend(b);
  return {
    el: b,
    remove() {
      b.removeEventListener("click", onClick);
      b.remove();
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
