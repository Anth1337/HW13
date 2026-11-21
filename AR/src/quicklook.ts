import * as THREE from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import type { ModelId, ModelInfo } from "./models";

/** True on iPhone and iPad (iPadOS reports itself as a Mac with a touch screen). */
export function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}

/**
 * iOS Safari has no WebXR AR. Instead it opens .usdz files in AR Quick Look,
 * Apple's built-in viewer, which places the model on a real surface and lets you
 * move, rotate and scale it.
 *
 * `show(model)` exports that character to USDZ in the browser (in its rest pose:
 * Quick Look can't run our procedural idle animation) and points the <a rel="ar">
 * link at it. The export runs ahead of time so the tap opens Quick Look straight away.
 * The link is hidden while an export runs; if the selection changes mid-export,
 * only the latest request wins. Each model is exported once and cached.
 */
export function createQuickLook(link: HTMLAnchorElement, img: HTMLImageElement) {
  // One export (and so one blob URL) per model: the promise is cached as soon as the
  // export starts, so switching back and forth mid-export never starts a duplicate.
  const pending = new Map<ModelId, Promise<string>>();
  let latest = 0;
  img.src = badge("View in AR");

  function exportModel(model: ModelInfo): Promise<string> {
    let promise = pending.get(model.id);
    if (!promise) {
      promise = runExport(model);
      pending.set(model.id, promise);
      promise.catch(() => pending.delete(model.id)); // allow a retry after a failure
    }
    return promise;
  }

  async function runExport(model: ModelInfo): Promise<string> {
    const character = model.create();
    character.update(0);
    const scene = new THREE.Scene();
    scene.add(character.root);
    scene.updateMatrixWorld(true);
    // The defaults anchor the model to a horizontal plane, so it stands on the floor or a table.
    const data = await new USDZExporter().parseAsync(scene, { quickLookCompatible: true });
    return URL.createObjectURL(new Blob([data], { type: "model/vnd.usdz+zip" }));
  }

  return {
    /** Resolves true when the link now shows `model`, false if a newer call replaced this one. */
    async show(model: ModelInfo): Promise<boolean> {
      const request = ++latest;
      link.hidden = true;
      let url: string;
      try {
        url = await exportModel(model);
      } catch (err) {
        if (request !== latest) return false; // a stale failure doesn't matter
        throw err;
      }
      if (request !== latest) return false;
      link.href = url;
      link.download = `${model.id}.usdz`;
      img.alt = `View the ${model.label.toLowerCase()} in AR`;
      link.hidden = false;
      return true;
    },
  };
}

/** Quick Look links must contain only an <img>, so the button is an SVG image. */
function badge(text: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="56" viewBox="0 0 240 56">
  <rect width="240" height="56" rx="28" fill="#ffa033"/>
  <g transform="translate(52 28)" fill="none" stroke="#1a1a1a" stroke-width="2.2" stroke-linejoin="round">
    <path d="M0 -11 L10 -5.5 L10 5.5 L0 11 L-10 5.5 L-10 -5.5 Z"/>
    <path d="M-10 -5.5 L0 0 L10 -5.5 M0 0 L0 11"/>
  </g>
  <text x="138" y="35" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif"
    font-size="19" font-weight="600" fill="#1a1a1a">${text}</text>
</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
