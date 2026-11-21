import * as THREE from "three";
import { createCube, createShadowCatcher } from "./cube";

export type ARUI = {
  overlay: HTMLElement;
  hint: HTMLElement;
  undo: HTMLButtonElement;
  clear: HTMLButtonElement;
  exit: HTMLButtonElement;
};

/** True where WebXR "immersive-ar" works: Chrome on an ARCore Android phone. */
export async function isWebXRARSupported(): Promise<boolean> {
  if (!window.isSecureContext || !navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-ar");
  } catch {
    return false;
  }
}

/**
 * Starts a WebXR AR session. The camera feed fills the screen, a ring shows the
 * surface in the middle of the view, and tapping the screen places a cube there.
 *
 * Call this from a click handler (browsers require a user gesture). `onEnd`
 * runs when the session ends, whether from the Exit button or the system back gesture.
 */
export async function startARSession(
  renderer: THREE.WebGLRenderer,
  ui: ARUI,
  onEnd: () => void,
): Promise<void> {
  const session = await navigator.xr!.requestSession("immersive-ar", {
    requiredFeatures: ["hit-test"],
    optionalFeatures: ["dom-overlay"],
    domOverlay: { root: ui.overlay },
  });

  // ---- Scene ----
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(); // WebXR drives the real camera pose and projection

  scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2.2));

  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 10;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.01;
  scene.add(sun, sun.target);
  const SUN_OFFSET = new THREE.Vector3(0.6, 3, 0.4);

  // Reticle: a flat ring that sits on the surface the phone points at.
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const placed: THREE.Group[] = [];

  // ---- Session setup ----
  let hitTestSource: XRHitTestSource | null = null;

  let lastHint = "";
  const setHint = (text: string) => {
    if (text !== lastHint) ui.hint.textContent = lastHint = text;
  };

  // Install the AR loop *before* the session starts. three.js stops its normal
  // (non-XR) loop when the session starts, so the loop only runs on XR frames.
  // Setting it before the session also keeps the preview scene from drawing
  // over the camera feed while the session is starting up.
  renderer.setAnimationLoop((_time, frame) => {
    if (!frame || !hitTestSource) return;
    const refSpace = renderer.xr.getReferenceSpace();
    const hit = frame.getHitTestResults(hitTestSource)[0];
    const pose = hit && refSpace ? hit.getPose(refSpace) : undefined;
    if (pose) {
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
    } else {
      reticle.visible = false;
    }

    if (!reticle.visible) setHint("Slowly move your phone to find the floor or a table");
    else if (placed.length === 0) setHint("Tap the screen to place a cube");
    else setHint(`${placed.length} cube${placed.length === 1 ? "" : "s"} · tap to place another`);

    renderer.render(scene, camera);
  });

  try {
    renderer.xr.setReferenceSpaceType("local");
    await renderer.xr.setSession(session);
    const viewerSpace = await session.requestReferenceSpace("viewer");
    const source = await session.requestHitTestSource?.({ space: viewerSpace });
    if (!source) throw new Error("This browser can't find surfaces (no WebXR hit-test).");
    hitTestSource = source;
  } catch (err) {
    await session.end().catch(() => {});
    throw err; // the caller shows the error on the start screen
  }
  ui.overlay.hidden = false;

  // Taps on the overlay buttons must not also count as "place a cube".
  const toolbar = ui.overlay.querySelector(".toolbar");
  const blockSelect = (e: Event) => e.preventDefault();
  toolbar?.addEventListener("beforexrselect", blockSelect);

  // ---- Actions ----
  function place() {
    if (!reticle.visible) return;
    const anchor = new THREE.Group();
    reticle.matrix.decompose(anchor.position, anchor.quaternion, anchor.scale);
    anchor.add(createCube(), createShadowCatcher());
    scene.add(anchor);
    placed.push(anchor);
    fitShadowToCubes();
    updateButtons();
  }

  function undo() {
    const last = placed.pop();
    if (last) scene.remove(last);
    fitShadowToCubes();
    updateButtons();
  }

  function clear() {
    for (const c of placed) scene.remove(c);
    placed.length = 0;
    updateButtons();
  }

  /** Keep the sun's shadow camera around all cubes so each one casts a shadow. */
  function fitShadowToCubes() {
    if (placed.length === 0) return;
    const box = new THREE.Box3();
    for (const c of placed) box.expandByPoint(c.position);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2 + 0.6;

    sun.target.position.copy(center);
    sun.position.copy(center).add(SUN_OFFSET);
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.far = SUN_OFFSET.length() + radius * 2;
    cam.updateProjectionMatrix();
  }

  function updateButtons() {
    ui.undo.disabled = placed.length === 0;
    ui.clear.disabled = placed.length === 0;
  }


  const onUndo = () => undo();
  const onClear = () => clear();
  const onExit = () => void session.end();
  ui.undo.addEventListener("click", onUndo);
  ui.clear.addEventListener("click", onClear);
  ui.exit.addEventListener("click", onExit);
  session.addEventListener("select", place);
  updateButtons();

  // ---- Teardown ----
  session.addEventListener("end", () => {
    hitTestSource?.cancel();
    hitTestSource = null;
    toolbar?.removeEventListener("beforexrselect", blockSelect);
    ui.undo.removeEventListener("click", onUndo);
    ui.clear.removeEventListener("click", onClear);
    ui.exit.removeEventListener("click", onExit);
    ui.overlay.hidden = true;
    reticle.geometry.dispose();
    (reticle.material as THREE.Material).dispose();
    sun.shadow.map?.dispose();
    renderer.setAnimationLoop(null);
    onEnd();
  });
}
