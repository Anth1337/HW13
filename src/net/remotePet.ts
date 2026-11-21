import * as THREE from "three";
import type { PetCharacter, PetZones, TrickKind } from "../dog/types";
import type { PetCard } from "./protocol";
import { applyControls, lerp, lerpAngle, type PetState } from "./sync";

/*
 * A friend's pet on this phone: their model, posed every frame from their state snapshots,
 * played back INTERP_DELAY_MS in the past so ~10 snapshots a second look smooth. It stands in
 * its own spot (slot) next to this phone's pet; the owner's movement around their placement
 * point is replayed around the slot, squeezed into WANDER_RADIUS so pets don't walk into each
 * other. A hand on it (here, or on another phone) makes it lean in for a moment.
 */

const INTERP_DELAY_MS = 150;
/** After the newest snapshot the pose holds, legs still moving for this long (short dropouts). */
const MAX_EXTRAPOLATE_MS = 250;
const BUFFER = 12;
const WANDER_RADIUS = 0.45;
/** A petting event keeps the pet leaning in this long (events repeat every 250 ms). */
const TOUCH_HOLD_MS = 600;
/** How fast the clock offset may creep up per snapshot (ms): follows clock drift between phones. */
const OFFSET_CREEP_MS = 0.05;

/** Where friends' pets gather on this phone: this phone's pet's placement (floor point + heading). */
export type Stage = { x: number; y: number; z: number; yaw: number };

export class RemotePet {
  readonly anchor = new THREE.Group();
  /** Left AR (an "away" event); cleared by the next snapshot. */
  away = false;
  private readonly snaps: PetState[] = [];
  /** local ms − sender ms for the least delayed snapshot seen (creeps up slowly for drift). */
  private clockOffset: number | null = null;
  private clock = 0;
  private readonly tag: THREE.Sprite;
  private readonly blob: THREE.Mesh;
  private readonly look = new THREE.Vector3();
  private readonly petPoint = new THREE.Vector3();
  private readonly trick: { kind: TrickKind; progress: number } = { kind: "spin", progress: 0 };
  private headUntil = -Infinity;
  private bodyUntil = -Infinity;
  private head = 0;
  private body = 0;

  constructor(
    readonly card: PetCard,
    readonly model: PetCharacter,
    name: string,
  ) {
    model.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = false; // the sun's shadow camera only covers this phone's pet
    });
    this.anchor.add(model.root);

    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.blob.scale.setScalar(Math.max(0.15, model.length * 0.42));
    this.blob.position.y = 0.002;
    this.anchor.add(this.blob);

    this.tag = makeTag(name);
    this.tag.position.y = model.height + 0.1;
    this.anchor.add(this.tag);
  }

  push(s: PetState, nowMs: number): void {
    const last = this.snaps[this.snaps.length - 1];
    if (last && s.t <= last.t) {
      if (s.t > last.t - 2000) return; // late duplicate / out of order
      this.reset(); // the sender reloaded: a new clock
    }
    const offset = nowMs - s.t;
    this.clockOffset = this.clockOffset === null ? offset : Math.min(offset, this.clockOffset + OFFSET_CREEP_MS);
    this.snaps.push(s);
    if (this.snaps.length > BUFFER) this.snaps.shift();
    this.away = false;
  }

  reset(): void {
    this.snaps.length = 0;
    this.clockOffset = null;
  }

  /** Someone's hand is on it. True when this starts a new touch (time for hearts). */
  touch(zone: "head" | "body", nowMs: number): boolean {
    const started = nowMs >= this.headUntil && nowMs >= this.bodyUntil;
    if (zone === "head") this.headUntil = nowMs + TOUCH_HOLD_MS;
    else this.bodyUntil = nowMs + TOUCH_HOLD_MS;
    return started;
  }

  /** Pose for now, standing in `slot` (x right, z towards the viewer, metres) of `stage`. */
  update(dt: number, nowMs: number, stage: Stage, slotX: number, slotZ: number): void {
    const n = this.snaps.length;
    if (n === 0 || this.clockOffset === null) return;
    const renderT = nowMs - this.clockOffset - INTERP_DELAY_MS;

    let a = this.snaps[0];
    let b = a;
    let u = 0;
    let extraPhase = 0;
    const newest = this.snaps[n - 1];
    if (renderT >= newest.t) {
      a = b = newest;
      if (n >= 2) {
        const prev = this.snaps[n - 2];
        const rate = (newest.g[0] - prev.g[0]) / Math.max(1, newest.t - prev.t);
        extraPhase = rate * Math.min(renderT - newest.t, MAX_EXTRAPOLATE_MS);
      }
    } else if (renderT > a.t) {
      for (let i = n - 1; i > 0; i--) {
        if (this.snaps[i - 1].t <= renderT) {
          a = this.snaps[i - 1];
          b = this.snaps[i];
          u = (renderT - a.t) / Math.max(1, b.t - a.t);
          break;
        }
      }
    }

    const c = this.model.controls;
    applyControls(a, b, u, c, this.look, this.petPoint, this.trick);
    c.gait.phase += extraPhase;

    // Petting from this phone's hands or from events: lean in, on top of what the owner sends.
    const k = 1 - Math.exp(-dt / 0.12);
    this.head += ((nowMs < this.headUntil ? 1 : 0) - this.head) * k;
    this.body += ((nowMs < this.bodyUntil ? 1 : 0) - this.body) * k;
    c.petHead = Math.max(c.petHead, this.head);
    c.petBody = Math.max(c.petBody, this.body);
    c.excitement = Math.max(c.excitement, Math.max(this.head, this.body));

    // Owner's offset from their placement point, squeezed into WANDER_RADIUS around the slot.
    const rx = lerp(a.x, b.x, u);
    const rz = lerp(a.z, b.z, u);
    const r = Math.hypot(rx, rz);
    const squeeze = r > 1e-6 ? (WANDER_RADIUS * Math.tanh(r / WANDER_RADIUS)) / r : 1;
    const ox = slotX + rx * squeeze;
    const oz = slotZ + rz * squeeze;
    const cs = Math.cos(stage.yaw);
    const sn = Math.sin(stage.yaw);
    this.anchor.position.set(stage.x + cs * ox + sn * oz, stage.y, stage.z - sn * ox + cs * oz);
    this.anchor.rotation.set(0, stage.yaw + lerpAngle(a.h, b.h, u), 0);

    this.clock += dt;
    this.model.update(this.clock);
  }

  zones(out: PetZones): PetZones {
    return this.model.getZones(out);
  }

  dispose(): void {
    this.anchor.removeFromParent();
    this.model.dispose();
    this.blob.geometry.dispose();
    (this.blob.material as THREE.Material).dispose();
    this.tag.material.map?.dispose();
    this.tag.material.dispose();
  }
}

/** A name tag that always faces the camera and stays visible (drawn on top). */
function makeTag(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "600 44px -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif";
  ctx.font = font;
  const h = 72;
  const w = Math.ceil(ctx.measureText(text).width) + 48;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font; // resizing the canvas resets the context
  ctx.fillStyle = "rgba(20, 20, 20, 0.66)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, w, h, h / 2);
  else ctx.rect(0, 0, w, h);
  ctx.fill();
  ctx.fillStyle = "#f2f2f2";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2 + 2);

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false }));
  const height = 0.07; // m
  sprite.scale.set((height * w) / h, height, 1);
  sprite.renderOrder = 20;
  return sprite;
}
