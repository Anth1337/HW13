import * as THREE from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import { createPetCharacter } from "./models/pet";
import type { Pet } from "./pets";

/** True on iPhone and iPad (iPadOS reports itself as a Mac with a touch screen). */
export function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}

/**
 * iOS Safari has no WebXR AR. Instead it opens .usdz files in AR Quick Look, Apple's built-in
 * viewer, which places the model on a real surface and lets you move, rotate and scale it.
 *
 * `show(pet)` builds that custom animal, exports it to USDZ in the browser (a still standing
 * pose: Quick Look can't run our procedural animation) and points the <a rel="ar"> link at it.
 * The export runs ahead of time so the tap opens Quick Look straight away. The link is hidden
 * while an export runs; if the pet changes mid-export only the latest request wins. Only the
 * blob URL the link currently shows is kept: older ones are revoked.
 */
export function createQuickLook(link: HTMLAnchorElement, img: HTMLImageElement) {
  let latest = 0;
  /** The blob URL the link points at (and its pet key), so it can be revoked when replaced. */
  let current: { key: string; url: string } | null = null;
  img.src = badge("View in AR");

  async function runExport(pet: Pet): Promise<string> {
    const dog = createPetCharacter(pet);
    try {
      dog.update(0);
      const scene = new THREE.Scene();
      scene.add(dog.root);
      scene.updateMatrixWorld(true);
      // The defaults anchor the model to a horizontal plane, so it stands on the floor or a table.
      const data = await new USDZExporter().parseAsync(scene, { quickLookCompatible: true });
      return URL.createObjectURL(new Blob([data], { type: "model/vnd.usdz+zip" }));
    } finally {
      dog.dispose();
    }
  }

  return {
    /** Resolves true when the link now shows `pet`, false if a newer call replaced this one. */
    async show(pet: Pet): Promise<boolean> {
      const key = JSON.stringify(pet);
      if (current?.key === key) {
        ++latest; // cancel any export still running for an older pet
        link.hidden = false;
        return true;
      }
      const request = ++latest;
      link.hidden = true;
      let url: string;
      try {
        url = await runExport(pet);
      } catch (err) {
        if (request !== latest) return false; // a stale failure doesn't matter
        throw err;
      }
      if (request !== latest) {
        URL.revokeObjectURL(url);
        return false;
      }
      if (current) URL.revokeObjectURL(current.url);
      current = { key, url };
      const name = pet.config.name.trim() || pet.species;
      link.href = url;
      link.download = `${name.replace(/[^\w-]+/g, "_") || pet.species}.usdz`;
      img.alt = `View ${name} in AR (still)`;
      link.hidden = false;
      return true;
    },
  };
}

/** Quick Look links must contain only an <img>, so the button is an SVG image. */
function badge(text: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="52" viewBox="0 0 200 52">
  <rect x="1" y="1" width="198" height="50" rx="25" fill="#3a3a3a" stroke="#ffa033" stroke-width="2"/>
  <g transform="translate(40 26)" fill="none" stroke="#ffa033" stroke-width="2.2" stroke-linejoin="round">
    <path d="M0 -11 L10 -5.5 L10 5.5 L0 11 L-10 5.5 L-10 -5.5 Z"/>
    <path d="M-10 -5.5 L0 0 L10 -5.5 M0 0 L0 11"/>
  </g>
  <text x="118" y="32" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif"
    font-size="17" font-weight="600" fill="#f2f2f2">${text}</text>
</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
