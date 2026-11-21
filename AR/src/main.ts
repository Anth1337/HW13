import "./style.css";
import * as THREE from "three";
import { createPreview } from "./preview";
import { isIOS, prepareQuickLook } from "./quicklook";
import { isWebXRARSupported, startARSession, type ARUI } from "./webxr";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const home = $("home");
const homeText = $("home-text");
const startButton = $<HTMLButtonElement>("start-ar");
const quickLook = $<HTMLAnchorElement>("quicklook");
const quickLookImg = $<HTMLImageElement>("quicklook-img");
const ui: ARUI = {
  overlay: $("overlay"),
  hint: $("hint"),
  undo: $<HTMLButtonElement>("btn-undo"),
  clear: $<HTMLButtonElement>("btn-clear"),
  exit: $<HTMLButtonElement>("btn-exit"),
};

// One renderer for both the 3D preview and the AR session.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was removed in three r187
renderer.xr.enabled = true;
$("app").appendChild(renderer.domElement);

const preview = createPreview(renderer);
const showPreview = () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  preview.resize(window.innerWidth, window.innerHeight);
  renderer.setAnimationLoop(preview.render);
};
showPreview();

window.addEventListener("resize", () => {
  if (renderer.xr.isPresenting) return; // WebXR controls the size during AR
  renderer.setSize(window.innerWidth, window.innerHeight);
  preview.resize(window.innerWidth, window.innerHeight);
});

async function init() {
  // 1. Android (Chrome + ARCore): full WebXR AR, many cubes, tap to place.
  if (await isWebXRARSupported()) {
    homeText.textContent = "Scan your room and tap to place cubes on the floor or a table.";
    startButton.hidden = false;
    startButton.addEventListener("click", async () => {
      startButton.disabled = true;
      home.hidden = true;
      try {
        await startARSession(renderer, ui, () => {
          home.hidden = false;
          startButton.disabled = false;
          showPreview();
        });
      } catch (err) {
        console.error(err);
        home.hidden = false;
        startButton.disabled = false;
        ui.overlay.hidden = true;
        homeText.textContent = `Couldn't start AR: ${err instanceof Error ? err.message : err}`;
        showPreview();
      }
    });
    return;
  }

  // 2. iPhone / iPad: Apple AR Quick Look (iOS has no WebXR AR).
  if (isIOS()) {
    homeText.textContent = "Opening in Apple's AR viewer. Move the phone until the cube lands on a surface.";
    try {
      await prepareQuickLook(quickLook, quickLookImg);
      homeText.textContent =
        "Tap the button, then point at the floor. Drag to move, pinch to scale, twist to rotate.";
      quickLook.hidden = false;
    } catch (err) {
      console.error(err);
      homeText.textContent = "Couldn't prepare the AR model on this device.";
    }
    return;
  }

  // 3. Anything else.
  if (!window.isSecureContext) {
    homeText.textContent = "AR needs HTTPS. Open this page through an https:// address.";
  } else if (/Android/i.test(navigator.userAgent)) {
    homeText.textContent =
      "AR isn't available here. Use Chrome, and install “Google Play Services for AR” from the Play Store.";
  } else {
    homeText.textContent =
      "Open this page on an Android phone (Chrome) or an iPhone (Safari) to place the cube in your room. Drag to orbit the preview.";
  }
}

void init();
