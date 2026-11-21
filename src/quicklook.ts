import * as THREE from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import { createCube } from "./cube";

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
 * Exports the cube to USDZ in the browser and points the <a rel="ar"> link at it.
 * The export runs ahead of time so the tap opens Quick Look straight away.
 */
export async function prepareQuickLook(link: HTMLAnchorElement, img: HTMLImageElement) {
  const scene = new THREE.Scene();
  scene.add(createCube());

  // The defaults anchor the model to a horizontal plane, so it sits on the floor or a table.
  const data = await new USDZExporter().parseAsync(scene, { quickLookCompatible: true });
  const blob = new Blob([data], { type: "model/vnd.usdz+zip" });
  link.href = URL.createObjectURL(blob);
  img.src = badge("View in AR");
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
