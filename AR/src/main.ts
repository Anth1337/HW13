import "./style.css";
import * as THREE from "three";
import { isCameraModeSupported, startCameraMode } from "./cameraMode";
import { MODELS, getModel } from "./models";
import { createPreview } from "./preview";
import { createQuickLook, isIOS } from "./quicklook";
import { selection } from "./selection";
import { isWebXRARSupported, startARSession, type ARUI } from "./webxr";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const home = $("home");
const homeText = $("home-text");
const startButton = $<HTMLButtonElement>("start-ar");
const quickLook = $<HTMLAnchorElement>("quicklook");
const quickLookImg = $<HTMLImageElement>("quicklook-img");
const cameraButton = $<HTMLButtonElement>("start-camera");
const cameraVideo = $<HTMLVideoElement>("camera-video");
const ui: ARUI = {
  overlay: $("overlay"),
  hint: $("hint"),
  controls: $("ar-controls"),
  undo: $<HTMLButtonElement>("btn-undo"),
  clear: $<HTMLButtonElement>("btn-clear"),
  exit: $<HTMLButtonElement>("btn-exit"),
  status: $("status"),
  tricks: {
    rollOver: $<HTMLButtonElement>("btn-trick-rollOver"),
    jump: $<HTMLButtonElement>("btn-trick-jump"),
    spin: $<HTMLButtonElement>("btn-trick-spin"),
  },
  visionToggle: $<HTMLButtonElement>("btn-vision"),
  visionCanvas: $<HTMLCanvasElement>("vision-canvas"),
};

/** Fills a segmented control with one toggle button per character, kept in sync with `selection`. */
function buildPicker(container: HTMLElement) {
  const buttons = MODELS.map((model) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "picker-btn";
    button.textContent = model.label;
    button.addEventListener("click", () => selection.set(model.id));
    container.appendChild(button);
    return { id: model.id, button };
  });
  const sync = () => {
    for (const { id, button } of buttons) button.setAttribute("aria-pressed", String(id === selection.get()));
  };
  sync();
  selection.subscribe(sync);
}
buildPicker($("home-picker"));
buildPicker($("ar-picker"));

/** Leave the centered "Checking AR support…" screen for the normal bottom layout with the picker. */
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

  const preview = createPreview(renderer, getModel(selection.get()));
  selection.subscribe((id) => preview.setModel(getModel(id)));

  // Frame the model above the start-screen UI, whose height changes with its text, the
  // visible buttons, the window size and the end of the "checking" state.
  const measureHome = () => {
    if (home.hidden || home.classList.contains("checking")) return;
    preview.setCovered(home.getBoundingClientRect().height);
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
  });

  /** Called when AR / camera mode takes over the canvas. */
  const leavePreview = () => preview.setInteractive(false);

  return { renderer, showPreview, leavePreview };
}

async function init(renderer: THREE.WebGLRenderer, showPreview: () => void, leavePreview: () => void) {
  // 1. Android (Chrome + ARCore): full WebXR AR, many characters, tap to place.
  if (await isWebXRARSupported()) {
    homeText.textContent =
      "Scan your room and tap to place the dog. Pet it on the head or back, look it in the eye, and use the buttons to make it roll over, jump and spin.";
    startButton.hidden = false;
    doneChecking();
    startButton.addEventListener("click", async () => {
      startButton.disabled = true;
      home.hidden = true;
      try {
        leavePreview();
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

  // Camera mode: the dog over the live camera, for browsers without WebXR AR.
  const offerCameraMode = () => {
    if (!isCameraModeSupported()) return false;
    cameraButton.hidden = false;
    return true;
  };
  cameraButton.addEventListener("click", async () => {
    cameraButton.disabled = true;
    home.hidden = true;
    try {
      leavePreview();
      await startCameraMode(renderer, ui, cameraVideo, () => {
        home.hidden = false;
        cameraButton.disabled = false;
        showPreview();
      });
    } catch (err) {
      console.error(err);
      home.hidden = false;
      cameraButton.disabled = false;
      ui.overlay.hidden = true;
      homeText.textContent = `Couldn't open the camera: ${err instanceof Error ? err.message : err}`;
      showPreview();
    }
  });

  // 2. iPhone / iPad: Apple AR Quick Look (iOS has no WebXR AR), plus camera mode for the live dog.
  if (isIOS()) {
    doneChecking();
    offerCameraMode();
    const ql = createQuickLook(quickLook, quickLookImg);
    const prepare = async () => {
      const model = getModel(selection.get());
      homeText.textContent = `Preparing the ${model.label.toLowerCase()}…`;
      try {
        if (!(await ql.show(model))) return; // a newer selection took over
        homeText.textContent =
          "View in AR places a still model on your floor. To pet the dog and teach it tricks, play with it through the camera.";
      } catch (err) {
        console.error(err);
        homeText.textContent = "Couldn't prepare the AR model on this device.";
      }
    };
    selection.subscribe(() => void prepare());
    await prepare();
    return;
  }

  // 3. Anything else: camera mode if there's a camera, otherwise just the preview.
  doneChecking();
  const camera = offerCameraMode();
  if (!window.isSecureContext) {
    homeText.textContent = "AR needs HTTPS. Open this page through an https:// address.";
  } else if (/Android/i.test(navigator.userAgent)) {
    homeText.textContent = camera
      ? "Full AR isn't available here (use Chrome with “Google Play Services for AR”). You can still play with the dog through the camera."
      : "AR isn't available here. Use Chrome, and install “Google Play Services for AR” from the Play Store.";
  } else {
    homeText.textContent = camera
      ? "Play with the dog through your camera: pet it, look it in the eye, teach it tricks. For full AR, open this page on an Android phone (Chrome)."
      : "Open this page on an Android phone (Chrome) or an iPhone (Safari) to place the dog in your room. Drag to orbit the preview.";
  }
}

let view: ReturnType<typeof setup3D> | null = null;
try {
  view = setup3D();
} catch (err) {
  console.error(err);
  doneChecking();
  homeText.textContent = "This browser can't show 3D (WebGL is unavailable).";
}
if (view) {
  init(view.renderer, view.showPreview, view.leavePreview).catch((err) => {
    console.error(err);
    doneChecking();
    homeText.textContent = "Something went wrong while checking for AR support. Try reloading the page.";
  });
}
