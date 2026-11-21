import "./style.css";
import * as THREE from "three";
import { isCameraModeSupported, startCameraMode } from "./cameraMode";
import { mountCreator } from "./creator";
import { mountMenu } from "./menu";
import { petName, petStore } from "./pets";
import { createPreview } from "./preview";
import { createQuickLook, isIOS } from "./quicklook";
import { arUIFromDOM, isWebXRARSupported, startARSession, type ARUI } from "./webxr";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const home = $("home");
const homeText = $("home-text");
const deployButton = $<HTMLButtonElement>("btn-deploy");
const cameraButton = $<HTMLButtonElement>("btn-camera");
const quickLook = $<HTMLAnchorElement>("quicklook");
const quickLookImg = $<HTMLImageElement>("quicklook-img");
const cameraVideo = $<HTMLVideoElement>("camera-video");
const menuEl = $("menu");
const creatorEl = $("creator");
const backButton = $<HTMLButtonElement>("btn-back");
const ui: ARUI = arUIFromDOM();

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
  backButton.focus();
}
backButton.addEventListener("click", () => {
  showMenu();
  menuEl.querySelector<HTMLElement>(`[data-key="pick-${petStore.activeSlot()}"]`)?.focus();
});
mountMenu(menuEl, showCreator);

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
function launcher(view: View, button: HTMLButtonElement, start: (onEnd: () => void) => Promise<void>, failure: string) {
  button.addEventListener("click", async () => {
    if (!petStore.active()) return; // the sessions deploy petStore.active()
    deployButton.disabled = cameraButton.disabled = true;
    home.hidden = true;
    const restore = () => {
      home.hidden = false;
      deployButton.disabled = cameraButton.disabled = false;
      view.showPreview();
    };
    try {
      view.leavePreview();
      await start(restore);
    } catch (err) {
      console.error(err);
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

  // Everywhere else Deploy opens camera mode (the pet over the live camera, no room tracking).
  // #btn-camera stays hidden: it would only repeat Deploy.
  const camera = isCameraModeSupported();
  if (camera) {
    canDeploy = true;
    syncDeploy();
    launcher(view, deployButton, (onEnd) => startCameraMode(renderer, ui, cameraVideo, onEnd), "Couldn't open the camera");
  }

  // 2. iPhone / iPad: no WebXR AR. Deploy = camera mode; Quick Look shows the custom pet as a
  //    still model on the real floor, re-exported (debounced, latest wins) when it changes.
  if (isIOS()) {
    doneChecking();
    homeText.textContent = camera
      ? "Pick or create a pet, then deploy it into the camera view. View in AR places a still model on your floor."
      : "View in AR places your pet, as a still model, on your floor.";
    const ql = createQuickLook(quickLook, quickLookImg);
    let timer: number | undefined;
    const prepare = async () => {
      const pet = petStore.active();
      if (!pet) return;
      try {
        await ql.show(pet);
        if (!petStore.active()) quickLook.hidden = true; // deselected while exporting
      } catch (err) {
        console.error(err);
        homeText.textContent = "Couldn't prepare the AR model on this device.";
      }
    };
    petStore.subscribe(() => {
      quickLook.hidden = true; // never open an outdated pet
      clearTimeout(timer);
      timer = window.setTimeout(() => void prepare(), 400);
    });
    await prepare();
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
