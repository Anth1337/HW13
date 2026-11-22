/*
 * The start-screen panel as a draggable bottom sheet (phones held upright only; wide screens
 * and phones on their side keep the full-height side panel and none of this runs).
 *
 * Three heights ("snaps"): peek (just the header, a sliver of content and Deploy, so the pet
 * preview gets most of the screen), half, and full (most of the screen, for seeing many
 * settings at once). Ways to change it:
 *  - drag the grip bar or the header, with any pointer; a quick flick carries to the next snap
 *  - tap the grip (full ↔ half, or up to full), or ArrowUp / ArrowDown on it
 *  - on a touch screen, drag the content: below full, a vertical drag moves the sheet (the
 *    content's own vertical touch scrolling is off, CSS .sheet-locked); at full the content
 *    scrolls as usual and pulling down from its top shrinks the sheet again (Apple Maps style)
 * Mouse wheels and horizontal drags (the breed row, sliders) always reach the content.
 * The last snap is remembered in localStorage (best effort).
 */

export type Snap = "peek" | "half" | "full";
const ORDER: Snap[] = ["peek", "half", "full"];
const STORE_KEY = "ar-pets-sheet-v1";
/** Matches the side-panel media query in style.css. */
const SIDE_QUERY = "(min-width: 720px), (orientation: landscape) and (min-width: 560px)";
/** Movement (px) before a press becomes a drag. */
const SLOP = 6;
/** How far (ms) a release's velocity is projected when picking the snap. */
const FLING_MS = 180;

export interface Sheet {
  /** Re-measure and re-apply (call when the "checking" state ends or the layout changes). */
  refresh(): void;
  /** Animate to a snap. */
  snapTo(snap: Snap): void;
  /** The current snap (null while the sheet is inactive: side panel or checking). */
  current(): Snap | null;
  /** Fires after the sheet settles on a new height. */
  onChange(fn: () => void): void;
}

const readStored = (): Snap => {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v === "peek" || v === "half" || v === "full") return v;
  } catch {
    /* storage blocked: default */
  }
  return "half";
};
const store = (s: Snap) => {
  try {
    localStorage.setItem(STORE_KEY, s);
  } catch {
    /* storage blocked: not remembered */
  }
};

export function mountSheet(home: HTMLElement, grip: HTMLButtonElement, scrollers: HTMLElement[]): Sheet {
  const head = home.querySelector<HTMLElement>(".home-head");
  const actions = home.querySelector<HTMLElement>(".home-actions");
  const side = window.matchMedia(SIDE_QUERY);
  const listeners: (() => void)[] = [];

  let snap: Snap = readStored();
  let active = false;
  /** The height the sheet shows (px), while active. */
  let height = 0;

  const isActive = () => !side.matches && !home.classList.contains("checking") && !home.hidden;

  /** Snap heights for the current viewport (px), ascending. */
  function heights(): Record<Snap, number> {
    const vh = window.innerHeight;
    const fixed = grip.offsetHeight + (head?.offsetHeight ?? 0) + (actions?.offsetHeight ?? 0);
    const full = Math.round(vh * 0.88);
    const peek = Math.min(Math.round(vh * 0.4), Math.max(150, fixed + 56));
    const half = Math.max(peek + 40, Math.min(full - 40, Math.round(vh * 0.52)));
    return { peek, half, full };
  }

  function apply(h: number, animate: boolean) {
    height = h;
    home.classList.toggle("sheet-animate", animate);
    home.style.height = `${Math.round(h)}px`;
  }

  function syncState() {
    home.classList.toggle("sheet-locked", active && snap !== "full");
    home.dataset.snap = active ? snap : "";
    grip.setAttribute("aria-expanded", String(snap === "full"));
    grip.setAttribute(
      "aria-label",
      snap === "full" ? "Panel: full height. Tap to shrink" : snap === "half" ? "Panel: half height. Tap to expand" : "Panel: minimised. Tap to expand",
    );
  }

  function snapTo(next: Snap, animate = true) {
    const changed = next !== snap;
    snap = next;
    store(next);
    if (!active) return;
    apply(heights()[next], animate);
    syncState();
    if (changed) for (const fn of listeners) fn();
  }

  function refresh() {
    const was = active;
    active = isActive();
    home.classList.toggle("sheet-on", active);
    if (!active) {
      home.style.height = "";
      home.classList.remove("sheet-animate", "sheet-locked", "sheet-dragging");
      delete home.dataset.snap;
      return;
    }
    apply(heights()[snap], false);
    syncState();
    if (!was) for (const fn of listeners) fn();
  }

  /** Nearest snap to where a release at `h` moving at `v` px/ms (positive = growing) would land. */
  function settle(h: number, v: number) {
    const hs = heights();
    const projected = h + v * FLING_MS;
    let best: Snap = snap;
    let bestD = Infinity;
    for (const s of ORDER) {
      const d = Math.abs(hs[s] - projected);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    // A clear flick always moves at least one snap in its direction.
    const i = ORDER.indexOf(snap);
    if (best === snap && Math.abs(v) > 0.5) best = ORDER[Math.max(0, Math.min(ORDER.length - 1, i + Math.sign(v)))];
    home.classList.remove("sheet-dragging");
    snapTo(best);
    // Re-apply even if the snap didn't change: the drag moved the height away from it.
    apply(heights()[best], true);
  }

  /* ---- One drag, fed by pointer or touch events ---- */
  let drag: { startY: number; startH: number; moved: boolean; samples: { t: number; y: number }[] } | null = null;
  /** After a drag, swallow the click the release may produce on whatever is under the finger. */
  let swallowClickUntil = 0;

  function dragStart(y: number) {
    drag = { startY: y, startH: height, moved: false, samples: [{ t: performance.now(), y }] };
  }
  /** Returns true once the press has become a drag. */
  function dragMove(y: number): boolean {
    if (!drag) return false;
    const dy = y - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dy) < SLOP) return false;
      drag.moved = true;
      drag.startY = y; // no jump by the slop distance
      home.classList.add("sheet-dragging");
      home.classList.remove("sheet-animate");
    }
    const t = performance.now();
    drag.samples.push({ t, y });
    while (drag.samples.length > 2 && t - drag.samples[0].t > 100) drag.samples.shift();
    const hs = heights();
    let h = drag.startH - (y - drag.startY);
    // Rubber-band past the ends.
    if (h > hs.full) h = hs.full + (h - hs.full) * 0.25;
    if (h < hs.peek) h = hs.peek - (hs.peek - h) * 0.25;
    apply(h, false);
    return true;
  }
  function dragEnd(): boolean {
    if (!drag) return false;
    const d = drag;
    drag = null;
    if (!d.moved) return false;
    // Velocity over the last 100 ms before the release; zero if the finger rested before lifting.
    const now = performance.now();
    const last = d.samples[d.samples.length - 1];
    const recent = d.samples.filter((x) => now - x.t <= 100);
    const first = recent[0];
    const v = now - last.t > 60 || recent.length < 2 ? 0 : -(last.y - first.y) / Math.max(1, last.t - first.t); // px/ms, positive = growing
    settle(height, v);
    swallowClickUntil = performance.now() + 400;
    return true;
  }
  function dragCancel() {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) settle(height, 0);
  }

  // The click a drag can produce always comes before the next press; a touch drag usually
  // produces none, so a new press disarms the swallow (else it would eat a quick real tap).
  window.addEventListener("pointerdown", () => (swallowClickUntil = 0), true);
  window.addEventListener(
    "click",
    (e) => {
      if (performance.now() < swallowClickUntil && home.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
      }
      swallowClickUntil = 0;
    },
    true,
  );

  /* ---- Grip + header: any pointer ---- */
  let pointerId: number | null = null;
  const handles = [grip, head].filter((x): x is HTMLElement => !!x);
  for (const h of handles) {
    h.addEventListener("pointerdown", (e) => {
      if (!active || pointerId !== null || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      pointerId = e.pointerId;
      h.setPointerCapture(e.pointerId);
      dragStart(e.clientY);
    });
    h.addEventListener("pointermove", (e) => {
      if (e.pointerId === pointerId) dragMove(e.clientY);
    });
    h.addEventListener("pointerup", (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      dragEnd();
    });
    h.addEventListener("pointercancel", (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      dragCancel();
    });
  }

  grip.addEventListener("click", () => {
    if (!active) return;
    snapTo(snap === "full" ? "half" : "full");
  });
  grip.addEventListener("keydown", (e) => {
    if (!active) return;
    const i = ORDER.indexOf(snap);
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      snapTo(ORDER[Math.max(0, Math.min(ORDER.length - 1, i + (e.key === "ArrowUp" ? 1 : -1)))]);
    }
  });

  /* ---- Content: touch only ---- */
  // Below full (.sheet-locked: touch-action pan-x), vertical touch drags don't scroll, so they
  // arrive as pointer events and move the sheet. Horizontal ones pan natively (pointercancel).
  let contentPointer: number | null = null;
  // Sliders keep their own drags. Horizontal rows (breeds, tabs) needn't be skipped: under pan-x a
  // sideways swipe pans them natively (pointercancel), a vertical one arrives here.
  const skip = (t: EventTarget | null) => t instanceof Element && !!t.closest('input[type="range"]');
  for (const sc of scrollers) {
    sc.addEventListener("pointerdown", (e) => {
      if (!active || snap === "full" || e.pointerType === "mouse" || contentPointer !== null || drag || skip(e.target)) return;
      contentPointer = e.pointerId;
      dragStart(e.clientY);
    });
    sc.addEventListener("pointermove", (e) => {
      if (e.pointerId === contentPointer) dragMove(e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== contentPointer) return;
      contentPointer = null;
      if (e.type === "pointercancel") dragCancel();
      else dragEnd();
    };
    sc.addEventListener("pointerup", end);
    sc.addEventListener("pointercancel", end);

    // At full: pulling down from the top of the content shrinks the sheet. Touch events, because
    // only a non-passive touchmove can stop the browser from treating the pull as a scroll.
    let pull: { x: number; y: number; claimed: boolean | null } | null = null;
    sc.addEventListener(
      "touchstart",
      (e) => {
        pull = null;
        if (!active || snap !== "full" || e.touches.length !== 1 || drag || skip(e.target)) return;
        if (sc.scrollTop > 0) return;
        const t = e.touches[0];
        pull = { x: t.clientX, y: t.clientY, claimed: null };
      },
      { passive: true },
    );
    sc.addEventListener(
      "touchmove",
      (e) => {
        if (!pull || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = t.clientX - pull.x;
        const dy = t.clientY - pull.y;
        if (pull.claimed === null) {
          if (dy < 0 || Math.abs(dx) > Math.abs(dy)) {
            // Scrolling up or sideways: the content's own.
            if (Math.abs(dx) + Math.abs(dy) > 2) pull = null;
            return;
          }
          // Not prevented until decided (a prevented first move can cancel the scroll on iOS);
          // overscroll-behavior: contain keeps those few pixels from moving the page.
          if (dy < SLOP) return;
          pull.claimed = true;
          dragStart(pull.y);
        }
        e.preventDefault();
        dragMove(t.clientY);
      },
      { passive: false },
    );
    const pullEnd = () => {
      if (pull?.claimed) dragEnd();
      pull = null;
    };
    sc.addEventListener("touchend", pullEnd);
    sc.addEventListener("touchcancel", () => {
      if (pull?.claimed) dragCancel();
      pull = null;
    });
  }

  side.addEventListener("change", refresh);
  window.addEventListener("resize", () => {
    if (!drag) refresh();
  });
  // Only the "checking" class and `hidden` matter here (the sheet's own classes change all the time).
  const gateKey = () => `${home.classList.contains("checking")}|${home.hidden}`;
  let lastGate = gateKey();
  new MutationObserver(() => {
    const k = gateKey();
    if (k === lastGate) return;
    lastGate = k;
    drag = null;
    refresh();
  }).observe(home, { attributes: true, attributeFilter: ["class", "hidden"] });

  refresh();
  return {
    refresh,
    snapTo: (s) => snapTo(s),
    current: () => (active ? snap : null),
    onChange: (fn) => void listeners.push(fn),
  };
}
