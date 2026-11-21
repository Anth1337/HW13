import * as THREE from "three";
import { hungarian } from "./detector";
import type {
  PerceivedBody,
  PerceivedFace,
  PerceivedHand,
  PerceivedPerson,
  Perception,
  UV,
} from "./types";

/*
 * People tracker: attributes every hand / face / body of a Perception to a stable PerceivedPerson.
 *
 * ASSOCIATION (per update, geometry only; world metres, so it works from any camera pose):
 *  1. A body owns the face whose eye midpoint is nearest the body's nose (uv gate ~ the face box,
 *     world gate 0.35 m + depth slack), one-to-one by optimal assignment.
 *  2. A body owns the hands whose wrist is nearest its wrist joints (world wrist-to-wrist AND uv
 *     gate), one-to-one, at most 2 per body.
 *  3. Remaining hands: (a) STICKY, a hand that belonged to person P last frame stays with P while
 *     within 1.1 m of P's head/torso; (b) VIEWER, hands nearer than 0.45 m to the camera (the
 *     phone holder's own hands, they never see their own body) form one viewer person (isViewer);
 *     (c) PLAUSIBILITY, a head/torso person (face and/or body) claims a hand within arm reach
 *     (0.9 m of the head, 0.8 m of the torso) if that is the nearest head, but a hand in the
 *     phone-holder zone (< 0.8 m from the camera and > 0.4 m closer than the face) is left alone;
 *     (d) anything else is a person of its own (hand-only person: the legacy "one hand" flow is
 *     one person with one hand).
 *  A body-face link or a hand claim that would pull in something belonging to ANOTHER existing
 *  person (a "loose" one, with nothing else in view) must persist 0.2-0.4 s before it is accepted.
 *
 * IDENTITY (stable person ids):
 *  - A cluster (body+face+hands, or hand group) is matched to existing persons by global
 *    assignment. Id continuity is the strongest cue: a person that owned the cluster's face id /
 *    body id (weight 3) or hand ids (1) is kept unless the geometry strongly contradicts
 *    (> 1 m + 1.5 m/s of gap). Otherwise geometry: floor-plane (x, z) distance to the person's
 *    velocity-predicted position, within 0.45 m + 1 m/s of gap (hand-only: 3D, 0.6 m + 1.5 m/s).
 *    Head/torso persons and hand-only persons never geometry-match each other.
 *  - Persons are tracked by their best measured position (head > torso > hands).
 *  - When a detection links two existing persons (a hand-only person's hand is finally matched
 *    to a body, a face-only and a body-only person turn out to be the same one), they MERGE and
 *    the OLDER id survives. Ids are never reused.
 *  - A person survives 3 s without detections (age grows, confidence decays), then expires. At
 *    most 6 persons; beyond that a stale one is evicted, else the newcomer gets personId = null.
 *
 * SPEAKING: per person, the jawOpen samples of the last 1.2 s (fresh, non-duplicate face
 * detections only) give speaking 0..1 from the mean frame-to-frame change, the range and the
 * number of direction reversals (talking oscillates; a steady or slowly moving jaw does not).
 * pickSpeaker() picks a clear winner from one frame; tracker.speakerWithin(s) looks back over
 * the last s seconds (speech recognisers answer 0.3-1.5 s late, final results after the person
 * stopped) and accumulates speaking * time per person.
 *
 * FRESHNESS: an item with age >= 0.01, or whose image position is bit-identical to the one last
 * processed for the same id (the detector repeats faces/bodies between model runs), still gets
 * attributed but does not move the person, add a mouth sample or restart its clocks, so update()
 * may be called every render frame. Never throws.
 */

export interface PeopleTracker {
  /** Attribute the perception's items (sets personId, fills people) and return it (mutated in place). dt = seconds since the previous call. */
  update(perception: Perception, dt: number): Perception;
  /** Id of the person who has been clearly the most active speaker during the last `seconds` seconds (and is still around), else null. */
  speakerWithin(seconds: number): number | null;
  reset(): void;
}

const FRESH_AGE = 0.01;
const PERSON_TTL = 3;
const MAX_PEOPLE = 6;
const SPEAK_WINDOW = 1.2;
const ARM_REACH_HEAD = 0.9;
const ARM_REACH_TORSO = 0.8;
const STICKY_REACH = 1.1;
const VIEWER_ZONE = 0.8;
const VIEWER_HOLD_DIST = 0.7; // a hand of the viewer keeps counting as theirs up to this camera distance (nearCamera is 0.45)
const HAND_GROUP_DIST = 0.6; // free hands this close (palm to palm) are one person's two hands
const HEAD_KEEP = 1.5; // s a measured head stays "known" after the face/nose was last seen
const NEW_COST = 1.6;
const FORBIDDEN = 1e4;
const HISTORY_S = 5;

type Kind = 0 | 1 | 2; // position source: 0 hand(s), 1 torso, 2 head

interface Person {
  id: number;
  firstSeen: number;
  lastSeen: number;
  pos: THREE.Vector3;
  posT: number;
  posKind: Kind;
  posKindT: number;
  vx: number;
  vz: number;
  head: THREE.Vector3 | null;
  headT: number;
  handIds: number[];
  faceId: number | null;
  bodyId: number | null;
  conf: number;
  isViewer: boolean;
  mouth: { t: number; v: number }[];
  speaking: number;
}

interface Cluster {
  body: PerceivedBody | null;
  face: PerceivedFace | null;
  hands: PerceivedHand[];
  viewer: boolean;
  kind: Kind;
  ref: THREE.Vector3;
  person: Person | null;
}

interface Owner { pid: number; t: number }
interface Sample { u: number; v: number; t: number }

export function createPeopleTracker(): PeopleTracker {
  let t = 0;
  let nextId = 1;
  let persons: Person[] = [];
  const handOwner = new Map<number, Owner>();
  const faceOwner = new Map<number, Owner>();
  const bodyOwner = new Map<number, Owner>();
  const lastHand = new Map<number, Sample>();
  const lastFace = new Map<number, Sample>();
  const lastBody = new Map<number, Sample>();
  const links = new Map<string, { since: number; last: number }>();
  let history: { t: number; id: number; s: number; w: number }[] = [];
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  const personById = (id: number) => persons.find((p) => p.id === id);
  const ownerOf = (m: Map<number, Owner>, id: number): Person | undefined => {
    const o = m.get(id);
    return o ? personById(o.pid) : undefined;
  };

  /**
   * True once the same link key has been seen continuously for `need` seconds. The clock only
   * advances on evaluations where `fresh` (one of the involved items was detected just now): the
   * same stale detections re-evaluated every frame are no new evidence.
   */
  function confirmed(key: string, need: number, fresh: boolean): boolean {
    let e = links.get(key);
    if (!fresh) return !!e && t - e.last <= 0.4 && t - e.since >= need;
    if (!e || t - e.last > 0.4) e = { since: t, last: t };
    e.last = t;
    links.set(key, e);
    return t - e.since >= need;
  }

  function isFresh(m: Map<number, Sample>, id: number, age: number, uv: UV | null): boolean {
    if (!(age < FRESH_AGE)) return false;
    const prev = m.get(id);
    return !(prev && uv && prev.u === uv.u && prev.v === uv.v);
  }

  function predict(p: Person, out: THREE.Vector3): THREE.Vector3 {
    const dt = Math.min(Math.max(t - p.posT, 0), 0.6);
    return out.set(p.pos.x + p.vx * dt, p.pos.y, p.pos.z + p.vz * dt);
  }

  /** Optimal one-to-one assignment of rows to columns with an "unmatched" cost; returns column per row or -1. */
  function assignRect(cost: number[][], rows: number, cols: number, unmatched: number): number[] {
    if (rows === 0 || cols === 0) return new Array<number>(rows).fill(-1);
    const n = rows + cols;
    const sq: number[][] = [];
    for (let r = 0; r < n; r++) {
      const row = new Array<number>(n).fill(0);
      if (r < rows) {
        for (let c = 0; c < cols; c++) row[c] = cost[r][c];
        for (let c = cols; c < n; c++) row[c] = unmatched;
      }
      sq.push(row);
    }
    const res = hungarian(sq, n);
    const out: number[] = [];
    for (let r = 0; r < rows; r++) out.push(res[r] < cols && cost[r][res[r]] < FORBIDDEN ? res[r] : -1);
    return out;
  }

  function continuity(c: Cluster, p: Person): number {
    let s = 0;
    if (c.body && bodyOwner.get(c.body.id)?.pid === p.id) s += 3;
    if (c.face && faceOwner.get(c.face.id)?.pid === p.id) s += 3;
    for (const h of c.hands) if (handOwner.get(h.id)?.pid === p.id) s += 1;
    if (c.viewer && p.isViewer) s += 2;
    return s;
  }

  /** Distance between a cluster and a person's predicted position, and the continuity/geometry gates. */
  function pairCost(c: Cluster, p: Person): number {
    const cont = continuity(c, p);
    if (c.viewer && p.isViewer) return -cont + 0.2;
    predict(p, tmp);
    const sameClass = (c.kind === 0) === (p.posKind === 0);
    const handish = c.kind === 0 || p.posKind === 0;
    const d = handish
      ? tmp.distanceTo(c.ref)
      : Math.hypot(tmp.x - c.ref.x, tmp.z - c.ref.z);
    const gap = Math.min(Math.max(t - p.posT, 0), 3);
    if (cont > 0) {
      const gateCont = (c.kind === 0 ? 1.5 : 1.0) + 1.5 * gap + (sameClass ? 0 : 0.9);
      if (d <= gateCont) return -cont + 0.5 * (d / gateCont) + 1e-4 * p.id;
      return FORBIDDEN;
    }
    if (!sameClass) return FORBIDDEN;
    const gate = Math.min(2.5, c.kind === 0 ? 0.6 + 1.5 * gap : 0.45 + 1.0 * gap);
    if (d > gate) return FORBIDDEN;
    return 0.5 + d / gate + 1e-4 * p.id;
  }

  function matchClusters(cs: Cluster[], pool: Person[], taken: Set<Person>): void {
    const cost: number[][] = cs.map((c) => pool.map((p) => pairCost(c, p)));
    const res = assignRect(cost, cs.length, pool.length, NEW_COST);
    res.forEach((j, i) => {
      if (j >= 0) { cs[i].person = pool[j]; taken.add(pool[j]); }
    });
  }

  function setRef(c: Cluster): void {
    if (c.face) { c.ref.copy(c.face.head); c.kind = 2; }
    else if (c.body?.nose) { c.ref.copy(c.body.nose); c.kind = 2; }
    else if (c.body?.torso) { c.ref.copy(c.body.torso); c.kind = 1; }
    else if (c.hands.length) {
      c.ref.set(0, 0, 0);
      for (const h of c.hands) c.ref.add(h.palm);
      c.ref.divideScalar(c.hands.length);
      c.kind = 0;
    }
  }

  function mergePerson(keep: Person, drop: Person): void {
    keep.firstSeen = Math.min(keep.firstSeen, drop.firstSeen);
    keep.isViewer = keep.isViewer || drop.isViewer;
    // The dropped person's mouth samples are not appended: a merge can join two different faces
    // (a wrong link), and interleaved jawOpen values would read as speaking.
    for (const m of [handOwner, faceOwner, bodyOwner]) for (const o of m.values()) if (o.pid === drop.id) o.pid = keep.id;
    for (const h of history) if (h.id === drop.id) h.id = keep.id;
    persons = persons.filter((p) => p !== drop);
  }

  function run(perception: Perception, dtIn: number): Perception {
    t += Number.isFinite(dtIn) ? Math.min(Math.max(dtIn, 0), 1) : 0;
    const cam = perception.cameraPosition ?? null;
    const hands = perception.hands, faces = perception.faces, bodies = perception.bodies ?? [];

    // Freshness flags.
    const hFresh = hands.map((h) => isFresh(lastHand, h.id, h.age, h.uv));
    const fFresh = faces.map((f) => isFresh(lastFace, f.id, f.age, f.uv));
    const bFresh = bodies.map((b) => isFresh(lastBody, b.id, b.age, b.torsoUV));

    // Persons that have lived past their TTL.
    persons = persons.filter((p) => t - p.lastSeen <= PERSON_TTL);

    // Nothing was detected just now (render frames between detections): the attribution on the
    // items still stands, only time passes. Skip the association.
    if (!hFresh.includes(true) && !fFresh.includes(true) && !bFresh.includes(true)) {
      const hid = new Set(hands.map((h) => h.id)), fid = new Set(faces.map((f) => f.id)), bid = new Set(bodies.map((b) => b.id));
      for (const p of persons) {
        p.handIds = p.handIds.filter((id) => hid.has(id));
        if (p.faceId !== null && !fid.has(p.faceId)) p.faceId = null;
        if (p.bodyId !== null && !bid.has(p.bodyId)) p.bodyId = null;
      }
      housekeeping();
      return publish(perception, dtIn);
    }

    const camDist = (v: THREE.Vector3) => (cam ? v.distanceTo(cam) : 0);

    // Link for a body whose nose is not visible: the face must sit just above its shoulders (world). Weaker than a nose link.
    const noseless = (b: PerceivedBody, f: PerceivedFace): number => {
      const sh = b.leftShoulder && b.rightShoulder
        ? tmp2.copy(b.leftShoulder).add(b.rightShoulder).multiplyScalar(0.5)
        : b.torso;
      if (!sh) return FORBIDDEN;
      const up = f.head.y - sh.y;
      const dh = Math.hypot(f.head.x - sh.x, f.head.z - sh.z);
      const gh = 0.3 + 0.06 * camDist(f.head);
      if (up < 0.05 || up > 0.8 || dh > gh) return FORBIDDEN;
      return 0.9 + 0.4 * (dh / gh);
    };

    // 1. Body <-> face links.
    const faceOfBody = new Array<number>(bodies.length).fill(-1);
    {
      const cost: number[][] = bodies.map((b) =>
        faces.map((f) => {
          if (!b.noseUV) return noseless(b, f);
          const fs = Math.max(f.box.u1 - f.box.u0, f.box.v1 - f.box.v0);
          const gu = 0.7 * fs + 0.02;
          const du = Math.hypot(f.uv.u - b.noseUV.u, f.uv.v - b.noseUV.v);
          if (du > gu) return FORBIDDEN;
          let c = du / gu;
          if (b.nose) {
            const gw = 0.35 + 0.08 * camDist(f.head);
            const dw = b.nose.distanceTo(f.head);
            // Body and face depths are estimated differently: a mismatch only costs, unless it is gross.
            if (dw > 3 * gw) return FORBIDDEN;
            c += 0.4 * Math.min(dw / gw, 2.5);
          }
          return c;
        }),
      );
      const res = assignRect(cost, bodies.length, faces.length, NEW_COST);
      res.forEach((j, bi) => {
        if (j < 0) return;
        const b = bodies[bi], f = faces[j];
        const pb = ownerOf(bodyOwner, b.id), pf = ownerOf(faceOwner, f.id);
        // Two different existing persons would be fused by this link: wait until it persists.
        if (pb && pf && pb !== pf && !confirmed(`BF${b.id}:${f.id}`, 0.25, fFresh[j] || bFresh[bi])) return;
        faceOfBody[bi] = j;
      });
    }
    const faceUsed = new Set<number>(faceOfBody.filter((j) => j >= 0));
    const roots: Cluster[] = [];
    const mk = (body: PerceivedBody | null, face: PerceivedFace | null): Cluster => {
      const c: Cluster = { body, face, hands: [], viewer: false, kind: 0, ref: new THREE.Vector3(), person: null };
      setRef(c);
      return c;
    };
    bodies.forEach((b, i) => roots.push(mk(b, faceOfBody[i] >= 0 ? faces[faceOfBody[i]] : null)));
    faces.forEach((f, i) => { if (!faceUsed.has(i)) roots.push(mk(null, f)); });

    // 2. Root clusters <-> existing persons.
    const taken = new Set<Person>();
    matchClusters(roots, persons, taken);
    // 2b. A face root and a body root of one person that no longer link (nose hidden, big depth
    // gap) both continue that person: Hungarian gave it to one of them, so fuse the other in.
    for (let ci = roots.length - 1; ci >= 0; ci--) {
      const c = roots[ci];
      if (c.person) continue;
      const r = roots.find((q) =>
        q !== c && q.person && ((c.face && !c.body && q.body && !q.face) || (c.body && !c.face && q.face && !q.body)) &&
        continuity(c, q.person) > 0 && pairCost(c, q.person) < FORBIDDEN);
      if (!r) continue;
      if (c.face) r.face = c.face; else r.body = c.body;
      setRef(r);
      roots.splice(ci, 1);
    }

    // 3. Hands.
    const handFree = new Array<boolean>(hands.length).fill(true);
    const looseOwner = (h: PerceivedHand): Person | undefined => {
      const a = ownerOf(handOwner, h.id);
      return a && !taken.has(a) ? a : undefined;
    };
    // 3a. wrist association
    {
      const slots: { c: Cluster; w: THREE.Vector3; uv: UV }[] = [];
      for (const c of roots) {
        if (!c.body) continue;
        if (c.body.leftWrist && c.body.leftWristUV) slots.push({ c, w: c.body.leftWrist, uv: c.body.leftWristUV });
        if (c.body.rightWrist && c.body.rightWristUV) slots.push({ c, w: c.body.rightWrist, uv: c.body.rightWristUV });
      }
      const cost: number[][] = slots.map((s) =>
        hands.map((h) => {
          const gw = 0.35 + 0.06 * (cam ? camDist(s.w) : 2);
          const dw = h.points[0].distanceTo(s.w);
          const du = Math.hypot(h.uv.u - s.uv.u, h.uv.v - s.uv.v);
          if (dw > gw || du > 0.18) return FORBIDDEN;
          return dw / gw + 0.6 * (du / 0.18);
        }),
      );
      const res = assignRect(cost, slots.length, hands.length, NEW_COST);
      res.forEach((hi, si) => {
        if (hi < 0) return;
        const h = hands[hi], c = slots[si].c;
        const a = looseOwner(h);
        if (a && a !== c.person && !confirmed(`W${h.id}:${c.body!.id}`, 0.2, hFresh[hands.indexOf(h)] || bFresh[bodies.indexOf(c.body!)])) return;
        c.hands.push(h);
        handFree[hi] = false;
      });
    }
    // 3b. sticky
    hands.forEach((h, hi) => {
      if (!handFree[hi]) return;
      const a = ownerOf(handOwner, h.id);
      if (!a) return;
      const c = roots.find((r) => r.person === a);
      if (c && c.hands.length < 2 && h.palm.distanceTo(c.ref) <= STICKY_REACH) {
        c.hands.push(h);
        handFree[hi] = false;
      }
    });
    // 3c. viewer hands
    let viewer: Cluster | null = null;
    {
      const near = hands.map((_h, i) => i).filter((i) =>
        handFree[i] && (hands[i].nearCamera || (hands[i].distance < VIEWER_HOLD_DIST && !!ownerOf(handOwner, hands[i].id)?.isViewer)));
      near.sort((a, b) => hands[a].distance - hands[b].distance);
      for (const i of near.slice(0, 2)) {
        if (!viewer) viewer = { body: null, face: null, hands: [], viewer: true, kind: 0, ref: new THREE.Vector3(), person: null };
        viewer.hands.push(hands[i]);
        handFree[i] = false;
      }
    }
    // 3d. plausibility claims (each hand only by its nearest head/torso, 2 hands per person)
    {
      const claims = roots.map(() => [] as { hi: number; d: number }[]);
      hands.forEach((h, hi) => {
        if (!handFree[hi]) return;
        let best = -1, bestD = Infinity;
        roots.forEach((c, ci) => {
          const d = h.palm.distanceTo(c.ref);
          if (d < bestD) { bestD = d; best = ci; }
        });
        if (best < 0) return;
        const c = roots[best];
        if (bestD > (c.kind === 2 ? ARM_REACH_HEAD : ARM_REACH_TORSO)) return;
        if (cam && h.distance < VIEWER_ZONE && camDist(c.ref) - h.distance > 0.4) return; // the phone holder's hand
        claims[best].push({ hi, d: bestD });
      });
      claims.forEach((list, ci) => {
        const c = roots[ci];
        list.sort((a, b) => a.d - b.d);
        for (const { hi } of list) {
          if (c.hands.length >= 2) break;
          const h = hands[hi];
          const a = looseOwner(h);
          if (a && a !== c.person && !confirmed(`C${h.id}:${c.body ? "b" + c.body.id : "f" + c.face!.id}`, 0.4, hFresh[hi] || (c.body ? bFresh[bodies.indexOf(c.body)] : fFresh[faces.indexOf(c.face!)]))) continue;
          c.hands.push(h);
          handFree[hi] = false;
        }
      });
    }
    // 3e. everything else: a person of its own
    const handClusters: Cluster[] = [];
    if (viewer) { setRef(viewer); handClusters.push(viewer); }
    // (two free hands close together are one person's pair, not two people)
    const grouped = new Set<number>();
    hands.forEach((h, hi) => {
      if (!handFree[hi] || grouped.has(hi)) return;
      const c: Cluster = { body: null, face: null, hands: [h], viewer: false, kind: 0, ref: new THREE.Vector3(), person: null };
      let mate = -1, md = HAND_GROUP_DIST;
      hands.forEach((o, oi) => {
        if (oi === hi || !handFree[oi] || grouped.has(oi)) return;
        const d = h.palm.distanceTo(o.palm);
        if (d < md) { md = d; mate = oi; }
      });
      if (mate >= 0) { c.hands.push(hands[mate]); grouped.add(mate); }
      grouped.add(hi);
      setRef(c);
      handClusters.push(c);
    });

    // 4. Hand-only clusters <-> persons still free.
    matchClusters(handClusters, persons.filter((p) => !taken.has(p)), taken);

    // 5. Merge persons that this frame's links show to be one, then create the rest.
    const all = roots.concat(handClusters);
    const absorbPool = persons.filter((p) => !taken.has(p));
    for (const c of all) {
      const group: Person[] = c.person ? [c.person] : [];
      for (const p of absorbPool) {
        if (taken.has(p) || group.includes(p)) continue;
        const owns =
          (c.body && bodyOwner.get(c.body.id)?.pid === p.id) ||
          (c.face && faceOwner.get(c.face.id)?.pid === p.id) ||
          c.hands.some((h) => handOwner.get(h.id)?.pid === p.id);
        if (!owns) continue;
        predict(p, tmp);
        const handish = p.posKind === 0;
        const d = handish ? tmp.distanceTo(c.ref) : Math.hypot(tmp.x - c.ref.x, tmp.z - c.ref.z);
        const gap = Math.min(Math.max(t - p.posT, 0), 3);
        if (d > 1.0 + 1.5 * gap + (handish ? 0.9 : 0)) continue; // geometry contradicts
        group.push(p);
        taken.add(p);
      }
      if (group.length > 1) {
        group.sort((a, b) => a.firstSeen - b.firstSeen || a.id - b.id);
        const keep = group[0];
        for (let i = 1; i < group.length; i++) mergePerson(keep, group[i]);
        c.person = keep;
        taken.add(keep);
      }
    }
    for (const c of all) {
      if (c.person) continue;
      if (persons.length >= MAX_PEOPLE) {
        let worst: Person | null = null;
        for (const p of persons) if (!taken.has(p) && (!worst || p.lastSeen < worst.lastSeen)) worst = p;
        if (worst && t - worst.lastSeen > 0.5) persons = persons.filter((p) => p !== worst);
        else continue; // too many people: this one stays unattributed
      }
      const p: Person = {
        id: nextId++, firstSeen: t, lastSeen: t,
        pos: c.ref.clone(), posT: t, posKind: c.kind, posKindT: t, vx: 0, vz: 0,
        head: null, headT: -Infinity, handIds: [], faceId: null, bodyId: null,
        conf: 0, isViewer: false, mouth: [], speaking: 0,
      };
      persons.push(p);
      taken.add(p);
      c.person = p;
    }

    // 6. Write the attribution back and update every matched person.
    for (const c of all) {
      const p = c.person;
      if (!p) continue;
      p.handIds = c.hands.map((h) => h.id);
      p.faceId = c.face ? c.face.id : null;
      p.bodyId = c.body ? c.body.id : null;
      let conf = 0, minAge = Infinity;
      const own = (m: Map<number, Owner>, id: number) => m.set(id, { pid: p.id, t });
      for (const h of c.hands) { h.personId = p.id; own(handOwner, h.id); conf = Math.max(conf, h.confidence); minAge = Math.min(minAge, h.age); }
      if (c.face) { c.face.personId = p.id; own(faceOwner, c.face.id); conf = Math.max(conf, c.face.confidence); minAge = Math.min(minAge, c.face.age); }
      if (c.body) { c.body.personId = p.id; own(bodyOwner, c.body.id); conf = Math.max(conf, c.body.confidence); minAge = Math.min(minAge, c.body.age); }
      p.conf = conf;
      p.lastSeen = Math.max(p.lastSeen, t - Math.max(0, minAge));
      p.isViewer = c.viewer;

      // Measured positions from fresh detections only.
      const face = c.face && fFresh[faces.indexOf(c.face)] ? c.face : null;
      const body = c.body && bFresh[bodies.indexOf(c.body)] ? c.body : null;
      const freshHands = c.hands.filter((h) => hFresh[hands.indexOf(h)]);
      let kind = 0;
      const m = tmp;
      if (face) { m.copy(face.head); kind = 2; }
      else if (body?.nose) { m.copy(body.nose); kind = 2; }
      else if (body?.torso) { m.copy(body.torso); kind = 1; }
      else if (freshHands.length) {
        m.set(0, 0, 0);
        for (const h of freshHands) m.add(h.palm);
        m.divideScalar(freshHands.length);
      } else kind = -1;
      if (kind >= 0) {
        if (kind >= 1) {
          if (!p.head) p.head = new THREE.Vector3();
          if (kind === 2) { p.head.copy(m); p.headT = t; }
        }
        if (kind >= p.posKind || t - p.posKindT > HEAD_KEEP) {
          const dt = t - p.posT;
          if (kind === p.posKind && dt > 0 && dt <= 0.5) {
            p.vx = 0.6 * p.vx + 0.4 * ((m.x - p.pos.x) / dt);
            p.vz = 0.6 * p.vz + 0.4 * ((m.z - p.pos.z) / dt);
            const sp = Math.hypot(p.vx, p.vz);
            if (sp > 2.5) { p.vx *= 2.5 / sp; p.vz *= 2.5 / sp; }
          } else if (kind !== p.posKind) { p.vx = 0; p.vz = 0; }
          p.pos.copy(m);
          p.posT = t;
          p.posKind = kind as Kind;
          p.posKindT = t;
        } else if (kind === p.posKind) p.posKindT = t;
      }
      if (face) {
        p.mouth.push({ t, v: face.mouthOpen });
      }
    }
    // Remember the processed image positions (freshness) and prune old bookkeeping.
    hands.forEach((h, i) => { if (hFresh[i]) lastHand.set(h.id, { u: h.uv.u, v: h.uv.v, t }); });
    faces.forEach((f, i) => { if (fFresh[i]) lastFace.set(f.id, { u: f.uv.u, v: f.uv.v, t }); });
    bodies.forEach((b, i) => { if (bFresh[i] && b.torsoUV) lastBody.set(b.id, { u: b.torsoUV.u, v: b.torsoUV.v, t }); });
    housekeeping();

    // Unmatched persons keep their last items out of the lists.
    const inCluster = new Set<Person>();
    for (const c of all) if (c.person) inCluster.add(c.person);
    for (const p of persons) {
      if (!inCluster.has(p)) { p.handIds = []; p.faceId = null; p.bodyId = null; }
    }
    return publish(perception, dtIn);
  }

  /** Drop old freshness / ownership / link bookkeeping. */
  function housekeeping(): void {
    for (const m of [lastHand, lastFace, lastBody]) for (const [k, s] of m) if (t - s.t > PERSON_TTL) m.delete(k);
    for (const m of [handOwner, faceOwner, bodyOwner]) for (const [k, o] of m) if (t - o.t > PERSON_TTL + 1 || !personById(o.pid)) m.delete(k);
    for (const [k, e] of links) if (t - e.last > 1) links.delete(k);
  }

  /** Speaking, history and the PerceivedPerson list. */
  function publish(perception: Perception, dtIn: number): Perception {
    const dtEff = Math.min(Math.max(dtIn, 0), 0.25);
    for (const p of persons) {
      p.speaking = speaking(p);
      if (p.speaking > 0.05 && dtEff > 0) history.push({ t, id: p.id, s: p.speaking, w: dtEff });
    }
    history = history.filter((h) => t - h.t <= HISTORY_S);

    const out: PerceivedPerson[] = persons.map((p) => {
      const age = Math.max(0, t - p.lastSeen);
      const head = p.head && t - p.headT <= HEAD_KEEP ? p.head.clone() : null;
      return {
        id: p.id,
        confidence: p.conf * Math.max(0, 1 - age / PERSON_TTL),
        position: head ? head.clone() : p.pos.clone(),
        head,
        handIds: p.handIds.slice(),
        faceId: p.faceId,
        bodyId: p.bodyId,
        speaking: p.speaking,
        age,
        isViewer: p.isViewer,
      };
    });
    out.sort((a, b) => a.age - b.age || a.id - b.id);
    perception.people = out;
    return perception;
  }

  function speaking(p: Person): number {
    const lo = t - SPEAK_WINDOW;
    while (p.mouth.length && p.mouth[0].t < lo) p.mouth.shift();
    const m = p.mouth;
    const n = m.length;
    if (n < 4) return 0;
    let sum = 0, min = Infinity, max = -Infinity, rev = 0, prevSign = 0;
    for (let i = 0; i < n; i++) {
      if (m[i].v < min) min = m[i].v;
      if (m[i].v > max) max = m[i].v;
      if (i === 0) continue;
      const d = m[i].v - m[i - 1].v;
      sum += Math.abs(d);
      if (Math.abs(d) >= 0.01) {
        const s = d > 0 ? 1 : -1;
        if (prevSign !== 0 && s !== prevSign) rev++;
        prevSign = s;
      }
    }
    let s = 0.6 * Math.min(sum / (n - 1) / 0.045, 1) + 0.4 * Math.min((max - min) / 0.12, 1);
    if (rev < 2) s *= 0.35;
    if (n < 6) s *= n / 6;
    return Math.min(1, s);
  }

  return {
    update(perception, dt) {
      try {
        return run(perception, dt);
      } catch (err) {
        console.warn("[people] update failed", err);
        if (!perception.people) perception.people = [];
        return perception;
      }
    },
    speakerWithin(seconds) {
      const lo = t - Math.max(0, seconds);
      const mass = new Map<number, { m: number; peak: number }>();
      for (const h of history) {
        if (h.t < lo) continue;
        const e = mass.get(h.id) ?? { m: 0, peak: 0 };
        e.m += h.s * h.w;
        e.peak = Math.max(e.peak, h.s);
        mass.set(h.id, e);
      }
      let best = -1, bm = 0, second = 0, peak = 0;
      for (const [id, e] of mass) {
        if (e.m > bm) { second = bm; bm = e.m; best = id; peak = e.peak; }
        else if (e.m > second) second = e.m;
      }
      if (best < 0 || peak < 0.3 || bm < 1.5 * second) return null;
      return personById(best) ? best : null;
    },
    reset() {
      t = 0;
      persons = [];
      history = [];
      for (const m of [handOwner, faceOwner, bodyOwner, lastHand, lastFace, lastBody]) m.clear();
      links.clear();
    },
  };
}

/** The id of the person who is clearly the most active speaker right now (speaking >= 0.3 and ahead of the runner-up by 0.15), else null. */
export function pickSpeaker(people: readonly PerceivedPerson[]): number | null {
  let best: PerceivedPerson | null = null;
  let second = 0;
  for (const p of people) {
    if (!best || p.speaking > best.speaking) {
      if (best) second = Math.max(second, best.speaking);
      best = p;
    } else second = Math.max(second, p.speaking);
  }
  if (!best || best.speaking < 0.3 || best.speaking - second < 0.15) return null;
  return best.id;
}
