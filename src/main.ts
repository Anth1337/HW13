import "./style.css";
import * as THREE from "three";
import { requestMotionPermission, type MotionPermission } from "./tracking";
import { primeVoice, releasePrimedVoice } from "./dogPlay";
import { isCameraModeSupported, startCameraMode } from "./cameraMode";
import { mountCreator } from "./creator";
import { mountMenu } from "./menu";
import { petName, petStore } from "./pets";
import { createPreview } from "./preview";
import { mountSheet } from "./sheet";
import { initNet } from "./net";
import { mountRoomUI } from "./net/ui";
import { arUIFromDOM, isWebXRARSupported, startARSession, type ARUI } from "./webxr";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const home = $("home");
const homeText = $("home-text");
const deployButton = $<HTMLButtonElement>("btn-deploy");
const cameraVideo = $<HTMLVideoElement>("camera-video");
const menuEl = $("menu");
const creatorEl = $("creator");
const backButton = $<HTMLButtonElement>("btn-back");
const ui: ARUI = arUIFromDOM();

/** iPhone / iPad (iPadOS reports itself as a Mac with touch). */
const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);

initNet(); // joins ?room=… when opened from an invite (a first-time guest gets a ready-made pet)

/*
 * Two views in the panel: the "My pets" slot menu (always first, also on revisit, with the last
 * active slot pre-selected) and the creator for the active pet, remounted each time it opens.
 */
let creator: { destroy(): void } | null = null;
function showMenu() {
  creator?.destroy();
  creator = null;
  creatorEl.hidden = backButton.hidden = true;
  menuEl.hidden = false;
}
function showCreator() {
  if (!petStore.active()) return;
  creator?.destroy();
  menuEl.hidden = true;
  creatorEl.hidden = backButton.hidden = false;
  creatorEl.scrollTop = 0;
  creator = mountCreator(creatorEl);
  if (sheet.current() === "peek") sheet.snapTo("half"); // show some settings, not just the name
  backButton.focus();
}
backButton.addEventListener("click", () => {
  showMenu();
  menuEl.querySelector<HTMLElement>(`[data-key="pick-${petStore.activeSlot()}"]`)?.focus();
});
mountMenu(menuEl, showCreator);
mountRoomUI($("home-actions"));
const sheet = mountSheet(home, $<HTMLButtonElement>("sheet-grip"), [menuEl, creatorEl]);

/** Set once the AR path is known: whether this device has a Deploy button at all. */
let canDeploy = false;
const syncDeploy = () => {
  const pet = petStore.active();
  deployButton.textContent = `Deploy ${petName(pet)}`;
  deployButton.hidden = !canDeploy || !pet;
  if (!pet && creator) showMenu();
};
syncDeploy();
petStore.subscribe(syncDeploy);

/** Leave the centered "Checking AR support…" screen for the panel layout. */
const doneChecking = () => home.classList.remove("checking");

/**
 * One renderer for both the 3D preview and the AR session. Throws if WebGL is unavailable
 * (disabled, unsupported, or no GPU memory for a context).
 */
function setup3D() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was removed in three r187
  renderer.xr.enabled = true;
  $("app").appendChild(renderer.domElement);

  const preview = createPreview(renderer, petStore.active());
  petStore.subscribe(() => preview.setPet(petStore.active()));

  // Frame the pet beside / above the creator panel, whose size changes with the window,
  // the visible buttons, the status text and the end of the "checking" state.
  const measureHome = () => {
    if (home.hidden || home.classList.contains("checking")) return;
    const r = home.getBoundingClientRect();
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Side panel (wide screens) when the panel doesn't span the width; bottom sheet otherwise.
    const side = r.width < w * 0.75 && r.left > w * 0.25;
    preview.setInsets(side ? { bottom: 0, right: Math.max(0, w - r.left) } : { bottom: Math.max(0, h - r.top), right: 0 });
  };
  new ResizeObserver(measureHome).observe(home);

  const showPreview = () => {
    preview.setInteractive(true);
    renderer.setSize(window.innerWidth, window.innerHeight);
    preview.resize(window.innerWidth, window.innerHeight);
    measureHome();
    renderer.setAnimationLoop(preview.render);
  };
  showPreview();

  window.addEventListener("resize", () => {
    if (renderer.xr.isPresenting) return; // WebXR controls the size during AR
    renderer.setSize(window.innerWidth, window.innerHeight);
    preview.resize(window.innerWidth, window.innerHeight);
    measureHome();
  });

  /** Called when AR / camera mode takes over the canvas. */
  const leavePreview = () => preview.setInteractive(false);

  return { renderer, showPreview, leavePreview };
}

type View = ReturnType<typeof setup3D>;

/**
 * Hide the creator, run an AR / camera session, and bring the creator back when it ends
 * (or show the error if it couldn't start).
 */
function launcher(
  view: View,
  button: HTMLButtonElement,
  start: (onEnd: () => void, motion?: Promise<MotionPermission>) => Promise<void>,
  failure: string,
  withMotion = false,
) {
  button.addEventListener("click", async () => {
    if (!petStore.active()) return; // the sessions deploy petStore.active()
    // The motion prompt must be started synchronously in this tap, before any await: Safari only
    // grants it while the transient user activation is live. Stacking the mic prompt (and then the
    // camera prompt) in the same tick risks iOS auto-denying one of them, so with motion sensors in
    // play the mic is NOT primed here: voice resumes with a tap on the mic button.
    let motion: Promise<MotionPermission> | undefined;
    if (withMotion) {
      try {
        motion = requestMotionPermission();
      } catch {
        motion = Promise.resolve("unavailable");
      }
    }
    if (!withMotion) primeVoice(); // inside the tap: the mic prompt needs the gesture, and AR may refuse it later
    deployButton.disabled = true;
    home.hidden = true;
    const restore = () => {
      home.hidden = false;
      deployButton.disabled = false;
      view.showPreview();
    };
    try {
      view.leavePreview();
      await start(restore, motion);
    } catch (err) {
      console.error(err);
      releasePrimedVoice();
      ui.overlay.hidden = true;
      homeText.textContent = `${failure}: ${err instanceof Error ? err.message : err}`;
      restore();
    }
  });
}

async function init(view: View) {
  const { renderer } = view;

  // 1. Android (Chrome + ARCore): full WebXR AR. Deploy = start AR, tap a surface to place the pet.
  if (await isWebXRARSupported()) {
    homeText.textContent = "Pick or create a pet, then deploy it: scan the floor and tap to place it.";
    canDeploy = true;
    syncDeploy();
    doneChecking();
    launcher(view, deployButton, (onEnd) => startARSession(renderer, ui, onEnd), "Couldn't start AR");
    return;
  }

  // Everywhere else Deploy opens camera mode (the pet over the live camera, world-tracked via src/tracking when motion sensors exist).
  const camera = isCameraModeSupported();
  if (camera) {
    canDeploy = true;
    syncDeploy();
    launcher(
      view,
      deployButton,
      // World tracking is only used on iOS (validated there). Elsewhere (webcams, Android without
      // ARCore) an explicit "unavailable" keeps the fixed camera.
      (onEnd, motion) => startCameraMode(renderer, ui, cameraVideo, onEnd, motion ?? Promise.resolve("unavailable")),
      "Couldn't open the camera",
      isIOS(), // iOS needs the motion permission prompt, started inside the tap
    );
  }

  // 2. iPhone / iPad: no WebXR AR. Deploy = camera mode with our own world tracking (src/tracking).
  if (isIOS()) {
    doneChecking();
    homeText.textContent = camera
      ? "Pick a pet and deploy it. Point at the floor, walk slowly, then tap to place it."
      : window.isSecureContext
        ? "This browser can't open the camera."
        : "Camera and tracking need HTTPS: open this page through an https:// address.";
    return;
  }

  // 3. Anything else: camera mode if there's a camera, otherwise just the creator + preview.
  doneChecking();
  if (!window.isSecureContext) {
    homeText.textContent = "AR needs HTTPS. Open this page through an https:// address.";
  } else if (/Android/i.test(navigator.userAgent)) {
    homeText.textContent = camera
      ? "Full AR isn't available here (use Chrome with “Google Play Services for AR”). Deploy shows your pet through the camera."
      : "AR isn't available here. Use Chrome, and install “Google Play Services for AR” from the Play Store.";
  } else {
    homeText.textContent = camera
      ? "Pick or create a pet, then deploy it into your webcam view. Full AR needs an Android phone."
      : "Make your pets here. Open this page on an Android phone (Chrome) or an iPhone to deploy them.";
  }
}

let view: View | null = null;
try {
  view = setup3D();
} catch (err) {
  console.error(err);
  doneChecking();
  homeText.textContent = "This browser can't show 3D (WebGL is unavailable).";
}
if (view) {
  init(view).catch((err) => {
    console.error(err);
    doneChecking();
    homeText.textContent = "Something went wrong while checking for AR support. Try reloading the page.";
  });
}
