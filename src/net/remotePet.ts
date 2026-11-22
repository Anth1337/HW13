import * as THREE from "three";
import type { PetCharacter, PetZones, TrickKind } from "../dog/types";
import { petGaitInfo } from "../models/pet";
import type { PetCard } from "./protocol";
import { applyControls, lerp, lerpAngle, wrapAngle, type PetState } from "./sync";

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
/*
 * Small, so a friend's pet stays near its slot (within arm's reach of this phone's player, and
 * clear of this phone's own pet) rather than drifting out from under a hand.
 */
const WANDER_RADIUS = 0.3;
/** A petting event keeps the pet leaning in this long (events repeat every 250 ms). */
const TOUCH_HOLD_MS = 600;
/** How fast the clock offset may creep up per snapshot (ms): follows clock drift between phones. */
const OFFSET_CREEP_MS = 0.05;
/** A hand this near keeps the pet still for this long after the last hold() call (called every frame). */
const HOLD_MS = 600;
/** After a hold ends the pet eases back to the replayed spot with this time constant (s), not a jump. */
const HOLD_EASE_S = 0.15;

/** Where friends' pets gather on this phone: this phone's pet's placement (floor point + heading). */
export type Stage = { x: number; y: number; z: number; yaw: number };

/**
 * Meeting another pet (party.ts), world space: this phone walks the pet there itself, because the
 * owner's movement happened in the owner's own layout. Null: walk back to the replayed spot.
 */
export type MeetPose = {
  /** Null: it stays put (sitting / lying) and only looks at the visitor. */
  stand: THREE.Vector3 | null;
  face: THREE.Vector3;
  look: THREE.Vector3;
  sniff: number;
};

const MEET_ACCEL = 1.5; // m/s²
const MEET_TURN = 3.5; // rad/s
/** Running speed as a multiple of walking speed (the brain's V_RUN / V_WALK). */
const V_RUN_X = 2 / 0.6;

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
  /** Set by party.ts while this pet meets another one. */
  meet: MeetPose | null = null;
  /** Where this phone walks the pet while meeting / walking back (null = replayed from snapshots). */
  private walk: { x: number; z: number; yaw: number; v: number; phase: number } | null = null;
  private readonly vWalk: number;
  /** A hand is near: the offset around the slot is frozen (see hold()). */
  private holdUntil = -Infinity;
  private holding = false;
  private heldOx = 0;
  private heldOz = 0;
  /** 1 while held, easing to 0 after release: how much of the frozen offset still applies. */
  private holdBlend = 0;

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

    this.vWalk = 0.6 * Math.min(1.15, Math.max(0.45, model.height / 0.57)); // the brain's walking speed

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
    this.stopMeet();
  }

  /** Drop any meeting walk at once: the pet goes back to where its snapshots put it (hidden, re-staged…). */
  stopMeet(): void {
    this.meet = null;
    this.walk = null;
  }

  /** Someone's hand is on it. True when this starts a new touch (time for hearts). */
  touch(zone: "head" | "body", nowMs: number): boolean {
    const started = nowMs >= this.headUntil && nowMs >= this.bodyUntil;
    if (zone === "head") this.headUntil = nowMs + TOUCH_HOLD_MS;
    else this.bodyUntil = nowMs + TOUCH_HOLD_MS;
    return started;
  }

  /**
   * A hand is close to this pet: it stops wandering (the owner's movement is not replayed) so the
   * hand does not lose it. Call every frame while the hand is near; it lets go HOLD_MS after the
   * last call and eases back to where the snapshots put it.
   */
  hold(nowMs: number): void {
    this.holdUntil = nowMs + HOLD_MS;
  }

  /** A hand on this phone is holding the pet still (see hold()): it should not walk off to meet. */
  isHeld(nowMs: number): boolean {
    return nowMs < this.holdUntil;
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
    let ox = slotX + rx * squeeze;
    let oz = slotZ + rz * squeeze;
    // Hold still under a hand: freeze the offset on entry, ease back to the replayed one on release.
    // Not while meeting / walking: those place the pet themselves.
    const held = nowMs < this.holdUntil && !this.meet && !this.walk;
    if (held) {
      if (!this.holding) {
        this.holding = true;
        this.heldOx = ox;
        this.heldOz = oz;
      }
      this.holdBlend = 1;
    } else {
      // Eases out during a meet / walk too: walkMeet starts from wherever the pet is shown, so
      // cutting the blend there would teleport it back to the replayed spot.
      this.holding = false;
      this.holdBlend *= Math.exp(-dt / HOLD_EASE_S);
      if (this.holdBlend < 0.001) this.holdBlend = 0;
    }
    if (this.holdBlend > 0) {
      ox = lerp(ox, this.heldOx, this.holdBlend);
      oz = lerp(oz, this.heldOz, this.holdBlend);
      c.gait.speed *= 1 - this.holdBlend; // standing under the hand, not walking on the spot
    }
    const cs = Math.cos(stage.yaw);
    const sn = Math.sin(stage.yaw);
    this.anchor.position.set(stage.x + cs * ox + sn * oz, stage.y, stage.z - sn * ox + cs * oz);
    this.anchor.rotation.set(0, stage.yaw + lerpAngle(a.h, b.h, u), 0);
    if (this.meet && !this.meet.stand && !this.walk) this.lookAtMeet(this.meet);
    else if (this.meet || this.walk) this.walkMeet(dt);

    this.clock += dt;
    this.model.update(this.clock);
  }

  /** Overrides the replayed position, heading, gait and look while meeting, then walks back. */
  private walkMeet(dt: number): void {
    const home = this.anchor.position;
    const w = (this.walk ??= { x: home.x, z: home.z, yaw: this.anchor.rotation.y, v: 0, phase: this.model.controls.gait.phase });
    const m = this.meet;
    const tx = m?.stand ? m.stand.x : home.x;
    const tz = m?.stand ? m.stand.z : home.z;
    const dx = tx - w.x;
    const dz = tz - w.z;
    const d = Math.hypot(dx, dz);
    const c = this.model.controls; // already filled from the snapshots
    // Head where it walks; once there face the other pet (or, back home, the replayed heading).
    const yawT = d > 0.08 ? Math.atan2(dx, dz) : m ? Math.atan2(m.face.x - w.x, m.face.z - w.z) : this.anchor.rotation.y;
    const err = wrapAngle(yawT - w.yaw);
    w.yaw = wrapAngle(w.yaw + Math.sign(err) * Math.min(Math.abs(err), MEET_TURN * dt));
    // Like the brain: walk short hops, trot / run further; turn mostly on the spot (no moonwalking).
    // On the way back it hurries a little, so it catches up with a replayed spot that keeps moving.
    const far = Math.min(1, Math.max(0, (d - 1) / 2));
    const vMax = this.vWalk * (1 + (V_RUN_X - 1) * far * far * (3 - 2 * far)) * (m ? 1 : 1.5);
    let vT = d > 0.03 ? Math.min(vMax, d * (m ? 2 : 4)) * Math.max(0, Math.cos(err)) : 0;
    // The owner's pet stopped for a trick, a sit or a lie: stand still for it here too (or, on the
    // way back, rejoin its replayed spot instead of gliding there in that pose).
    if (c.trick || c.sit > 0.3 || c.lie > 0.3) {
      if (!m) {
        this.walk = null;
        return;
      }
      vT = 0;
    }
    w.v = vT > w.v ? Math.min(vT, w.v + MEET_ACCEL * dt) : Math.max(vT, w.v - MEET_ACCEL * 1.5 * dt);
    if (Math.cos(err) < 0) w.v = vT; // target behind it: stop and turn, never slide backwards
    const step = Math.min(d, w.v * dt);
    if (d > 1e-6) {
      w.x += (dx / d) * step;
      w.z += (dz / d) * step;
    }

    if (!m && d < 0.03 && Math.abs(err) < 0.05) {
      this.walk = null; // back on the replayed spot: snapshots drive it again
      return;
    }

    // Normalised gait speed for this ground speed (as the brain's gaitSpeedFor: 0.4 walk, 0.7 trot, 1 run).
    const vw = this.vWalk;
    const gs =
      w.v <= vw ? (0.4 * w.v) / vw : w.v <= 2 * vw ? 0.4 + (0.3 * (w.v - vw)) / vw : Math.min(1.1, 0.7 + (0.3 * (w.v - 2 * vw)) / ((V_RUN_X - 2) * vw));
    if (gs > 0.01) {
      const stride = petGaitInfo(this.model, Math.max(gs, 0.3)).stride * Math.min(1, gs / 0.3);
      w.phase += (dt * w.v) / Math.max(stride, 1e-3);
    }
    c.gait.phase = w.phase;
    c.gait.speed = gs;
    c.gait.turn = 0;
    this.anchor.position.set(w.x, home.y, w.z);
    this.anchor.rotation.set(0, w.yaw, 0);
    if (m) this.lookAtMeet(m, w.v < 0.1);
  }

  /** Looks at the other pet from wherever the pet now stands (and sniffs it once stopped). */
  private lookAtMeet(m: MeetPose, stopped = true): void {
    const c = this.model.controls;
    if (stopped) c.sniff = Math.max(c.sniff, m.sniff);
    c.excitement = Math.max(c.excitement, 0.85);
    this.anchor.updateMatrixWorld(true);
    c.lookAt = this.model.root.worldToLocal(this.look.copy(m.look));
    c.lookWeight = 1;
  }

  /** The owner's pet is sitting or lying (it stays put when another pet comes to say hi). */
  get resting(): boolean {
    const s = this.snaps[this.snaps.length - 1];
    return !!s && (s.c[0] > 0.5 || s.c[1] > 0.5);
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
