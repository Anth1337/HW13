import { renderSVG } from "uqr";
import "./net.css";
import { currentRoom, inviteURL, joinRoom, leaveRoom, newRoomCode, onRoomChange } from "./index";
import { localPetCard, petEmoji, petName } from "./kinds";
import { MAX_PLAYERS } from "./protocol";
import type { RoomClient } from "./room";

/*
 * Room UI, built from code so index.html stays as it is:
 *  - start screen: a 👥 button next to Deploy (creates a room if needed) that opens the invite
 *    sheet: QR code + link + who is in the room (big enough to show on a projector)
 *  - AR / camera overlay: the feed (short chips under the hint) and the 🐾 say-hi button
 * Names come from other players: always set with textContent.
 */

const FEED_S = 3.2;
const FEED_MAX = 3;
/** Someone who sent a snapshot this recently is in AR with their pet. */
const PLAYING_MS = 3000;

export function mountRoomUI(actions: HTMLElement): void {
  const button = el("button", "btn net-friends");
  button.type = "button";
  actions.prepend(button);

  const sheet = el("div", "net-sheet");
  sheet.hidden = true;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Play together");
  const card = el("div", "net-card");
  const head = el("div", "net-card-head");
  const title = el("h2", "net-title", "Play together");
  const close = el("button", "net-x", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  head.append(title, close);
  const lead = el("p", "net-lead", "Scan with your phone camera to bring your pet to the party.");
  const qr = el("div", "net-qr");
  const code = el("p", "net-code");
  const linkRow = el("div", "net-link-row");
  const link = el("a", "net-link");
  link.target = "_blank";
  link.rel = "noopener";
  const copy = el("button", "net-small", "Copy link");
  copy.type = "button";
  linkRow.append(link, copy);
  const status = el("p", "net-status");
  const listTitle = el("h3", "net-h");
  const list = el("ul", "net-list");
  const leave = el("button", "net-small net-leave", "Leave room");
  leave.type = "button";
  card.append(head, lead, qr, code, linkRow, status, listTitle, list, leave);
  sheet.append(card);
  document.body.append(sheet);

  let shownFor: RoomClient | null = null;
  let unsub: (() => void) | null = null;
  let tick: ReturnType<typeof setInterval> | undefined;

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
    button.title = room ? `Room ${room.code}: invite friends` : "Play with friends";
    button.classList.toggle("net-in-room", !!room);
    if (!room || sheet.hidden) return;

    if (shownFor !== room) {
      shownFor = room;
      const url = inviteURL(room.code);
      qr.innerHTML = renderSVG(url, { ecc: "M", border: 2 }); // our own URL, not user input
      link.href = url;
      link.textContent = url.replace(/^https?:\/\//, "");
      code.textContent = `Room ${room.code.toUpperCase()}`;
    }
    status.textContent =
      room.status === "open"
        ? "Connected"
        : room.status === "full"
          ? `This room is full (${MAX_PLAYERS} players). Leave and start a new one.`
          : room.status === "closed"
            ? "Left the room"
            : "Connecting…";
    status.dataset.state = room.status;
    listTitle.textContent = `In this room (${count}/${MAX_PLAYERS})`;
    const now = performance.now();
    const rows: HTMLElement[] = [row(`${petEmoji(localPetCard())} ${petName(localPetCard())}`, "you")];
    for (const peer of room.peers.values()) {
      const playing = now - peer.lastStateMs < PLAYING_MS;
      rows.push(row(`${petEmoji(peer.pet)} ${petName(peer.pet)}`, playing ? "playing" : "getting ready"));
    }
    list.replaceChildren(...rows);
  }

  function watch(room: RoomClient | null) {
    unsub?.();
    unsub = room ? room.onChange(render) : null;
    render();
  }

  function open() {
    if (!currentRoom()) joinRoom(newRoomCode());
    sheet.hidden = false;
    shownFor = null;
    render();
    clearInterval(tick);
    tick = setInterval(render, 1000); // "playing" fades without a roster change
    close.focus();
  }

  function hide() {
    sheet.hidden = true;
    clearInterval(tick);
  }

  button.addEventListener("click", open);
  close.addEventListener("click", hide);
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) hide();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) hide();
  });
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
  leave.addEventListener("click", () => {
    leaveRoom();
    hide();
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
