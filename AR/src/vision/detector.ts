import type {
  Classifications,
  FaceLandmarker,
  FaceLandmarkerResult,
  Matrix,
  NormalizedLandmark,
  PoseLandmarker,
  PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import type { Human2D, HumanDetector, UV } from "./types";

/*
 * MediaPipe pose + face landmarkers → Human2D[] (image coords, u right, v down, 0..1).
 *
 * The MediaPipe bundle (~1 MB JS + ~10 MB wasm + models) is loaded lazily via a dynamic
 * import so it lands in its own chunk and only downloads when the dog actually needs eyes.
 */

/** Pinned to exactly the installed @mediapipe/tasks-vision version (the JS/wasm pair must match). */
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm";
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// BlazePose landmark indices.
const P_NOSE = 0;
const P_LEFT_EYE = 2;
const P_RIGHT_EYE = 5;
const P_LEFT_SHOULDER = 11;
const P_RIGHT_SHOULDER = 12;
const P_LEFT_WRIST = 15;
const P_RIGHT_WRIST = 16;
const P_LEFT_PINKY = 17;
const P_RIGHT_PINKY = 18;
const P_LEFT_INDEX = 19;
const P_RIGHT_INDEX = 20;

// Face mesh landmark indices.
const F_RIGHT_EYE_OUTER = 33; // subject's right eye, outer corner (image left for a facing person)
const F_LEFT_EYE_OUTER = 263; // subject's left eye, outer corner
const F_RIGHT_IRIS = 468;
const F_LEFT_IRIS = 473;

const VIS = 0.5;
const FACE_MATCH_DIST = 0.15;
const TRACK_DIST = 0.2;
const TRACK_GAP_MS = 1000;
const EYE_YAW_MAX = (25 * Math.PI) / 180;
const EYE_PITCH_MAX = (20 * Math.PI) / 180;

type Vec3 = { x: number; y: number; z: number };

export async function createHumanDetector(opts: { maxPeople?: number } = {}): Promise<HumanDetector> {
  const maxPeople = Math.max(1, Math.floor(opts.maxPeople ?? 3));
  const vision = await import("@mediapipe/tasks-vision");
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);

  async function withDelegateFallback<T>(make: (delegate: "GPU" | "CPU") => Promise<T>): Promise<T> {
    try {
      return await make("GPU");
    } catch (err) {
      console.warn("[vision] GPU delegate failed, falling back to CPU", err);
      return make("CPU");
    }
  }

  const pose: PoseLandmarker = await withDelegateFallback((delegate) =>
    vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate },
      runningMode: "VIDEO",
      numPoses: maxPeople,
    }),
  );
  let face: FaceLandmarker;
  try {
    face = await withDelegateFallback((delegate) =>
      vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: "VIDEO",
        numFaces: maxPeople,
        outputFacialTransformationMatrixes: true,
        outputFaceBlendshapes: true,
      }),
    );
  } catch (err) {
    pose.close();
    throw err;
  }

  let lastTs = -Infinity;
  let closed = false;
  const tracker = createTracker();
  // Runtime check of the image-x vs face-geometry-x convention (see faceGaze()). Positive
  // votes = geometry +x agrees with image +u (expected); negative = mirrored.
  let mirrorVotes = 0;

  function detect(image: ImageData | HTMLVideoElement | HTMLCanvasElement, timestampMs: number): Human2D[] {
    if (closed) return [];
    try {
      let ts = Number.isFinite(timestampMs) ? timestampMs : lastTs + 1;
      if (ts <= lastTs) ts = lastTs + 1;
      lastTs = ts;

      // Both landmarkers run every call: at the ~10 Hz the XR source delivers frames, a
      // 384 px image costs a few ms each, and fresh face data is what drives eye contact.
      const poseRes: PoseLandmarkerResult = pose.detectForVideo(image, ts);
      const faceRes: FaceLandmarkerResult = face.detectForVideo(image, ts);

      const people = buildHumans(poseRes, faceRes);
      return tracker.assign(people, ts);
    } catch (err) {
      console.warn("[vision] detect failed", err);
      return [];
    }
  }

  function buildHumans(poseRes: PoseLandmarkerResult, faceRes: FaceLandmarkerResult): Omit<Human2D, "id">[] {
    const people: (Omit<Human2D, "id"> & { ref: UV | null })[] = [];

    for (const lm of poseRes.landmarks ?? []) {
      if (!lm || lm.length < 33) continue;
      const eyes = visible(lm[P_LEFT_EYE]) && visible(lm[P_RIGHT_EYE])
        ? mid(lm[P_LEFT_EYE], lm[P_RIGHT_EYE])
        : null;
      const ls = lm[P_LEFT_SHOULDER];
      const rs = lm[P_RIGHT_SHOULDER];
      const shoulders = visible(ls) && visible(rs)
        ? { left: { u: ls.x, v: ls.y }, right: { u: rs.x, v: rs.y } }
        : null;
      const hands: UV[] = [];
      for (const [idx, pinky, wrist] of [
        [P_LEFT_INDEX, P_LEFT_PINKY, P_LEFT_WRIST],
        [P_RIGHT_INDEX, P_RIGHT_PINKY, P_RIGHT_WRIST],
      ] as const) {
        let h: UV | null = null;
        if (visible(lm[idx]) && visible(lm[pinky])) h = mid(lm[idx], lm[pinky]);
        else if (visible(lm[wrist])) h = { u: lm[wrist].x, v: lm[wrist].y };
        if (h && inImage(h)) hands.push(h);
      }
      // Score: mean visibility of head + shoulder landmarks (pose results carry no score).
      let s = 0;
      for (let i = 0; i <= 12; i++) s += clamp01(lm[i].visibility ?? 0);
      const score = s / 13;
      if (!eyes && !shoulders && hands.length === 0) continue;
      const ref = eyes ?? (visible(lm[P_NOSE]) ? { u: lm[P_NOSE].x, v: lm[P_NOSE].y } : null);
      people.push({ score, eyes, shoulders, hands, face: null, ref });
    }

    // Faces → per-face data, then greedy nearest matching to poses.
    const faces = (faceRes.faceLandmarks ?? []).map((lm, i) => {
      if (!lm || lm.length <= F_LEFT_EYE_OUTER) return null;
      const rOuter = lm[F_RIGHT_EYE_OUTER];
      const lOuter = lm[F_LEFT_EYE_OUTER];
      const eyes = lm.length > F_LEFT_IRIS ? mid(lm[F_RIGHT_IRIS], lm[F_LEFT_IRIS]) : mid(rOuter, lOuter);
      const gaze = faceGaze(
        faceRes.facialTransformationMatrixes?.[i],
        faceRes.faceBlendshapes?.[i],
        lOuter.x - rOuter.x,
      );
      if (!gaze) return null;
      return {
        eyes,
        face: {
          // Subject's left eye outer corner (263) / right eye outer corner (33).
          leftEyeOuter: { u: lOuter.x, v: lOuter.y },
          rightEyeOuter: { u: rOuter.x, v: rOuter.y },
          gazeCamera: gaze,
        },
      };
    });

    const pairs: { f: number; p: number; d: number }[] = [];
    faces.forEach((f, fi) => {
      if (!f) return;
      people.forEach((p, pi) => {
        if (!p.ref) return;
        const d = dist(f.eyes, p.ref);
        if (d <= FACE_MATCH_DIST) pairs.push({ f: fi, p: pi, d });
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const faceUsed = new Set<number>();
    const poseUsed = new Set<number>();
    for (const { f, p } of pairs) {
      if (faceUsed.has(f) || poseUsed.has(p)) continue;
      faceUsed.add(f);
      poseUsed.add(p);
      const fd = faces[f]!;
      people[p].face = fd.face;
      if (!people[p].eyes) people[p].eyes = fd.eyes;
    }
    faces.forEach((f, fi) => {
      if (!f || faceUsed.has(fi)) return;
      people.push({ score: 0.7, eyes: f.eyes, shoulders: null, hands: [], face: f.face, ref: f.eyes });
    });

    return people.map(({ ref: _ref, ...h }) => h);
  }

  /*
   * Gaze in camera space (x right, y up, z toward the viewer).
   *
   * Head pose. MediaPipe's face geometry ("metric") space is right-handed with the virtual
   * camera at the origin looking down -z, y up. When it converts screen landmarks to metric
   * space it flips y (image v is down) but NOT x, so geometry +x == image +u: the space is not
   * mirrored relative to the image, and it equals our contract's camera space. The canonical
   * face model's +z points out of the face (toward a camera it faces) and its +x points from
   * the subject's right eye (landmark 33, image left) to the subject's left eye (263, image
   * right). So with the 4x4 column-major pose matrix M, head forward = R·(0,0,1) where
   * R[row][col] = data[col*4 + row] (normalised, in case M carries scale).
   *
   * Because getting this wrong silently inverts "is this person looking at the dog", we also
   * verify it at runtime: for a roughly frontal face, R·(1,0,0) (the face's +x in camera space)
   * must point the same way in u as the vector from landmark 33 to 263. We keep a running vote
   * and, only if the evidence clearly says the geometry is mirrored (should never happen with
   * an unmirrored rear-camera image), negate x of the final gaze vector: an x-mirrored space
   * maps to ours by diag(-1,1,1), i.e. x → -x.
   *
   * Eyes. Blendshape names refer to the SUBJECT's eyes. In face-local space the subject's left
   * is +x (see above). For the subject's left eye, eyeLookOutLeft = looking toward the subject's
   * left = +x, eyeLookInLeft = toward the nose = -x. For the right eye, eyeLookOutRight = toward
   * the subject's right = -x, eyeLookInRight = +x. Up = +y, down = -y. Averaged over both eyes:
   *   yaw   = 25° · ((outL - inL) + (inR - outR)) / 2   (positive → +x)
   *   pitch = 20° · ((upL - downL) + (upR - downR)) / 2 (positive → +y)
   * Eye direction in face-local space = (sin yaw · cos pitch, sin pitch, cos yaw · cos pitch),
   * then rotated by R like the head forward.
   */
  function faceGaze(m: Matrix | undefined, bs: Classifications | undefined, eyeSpanU: number): Vec3 | null {
    if (!m || !m.data || m.data.length < 16) return null;
    const d = m.data;
    const r = (row: number, col: number) => d[col * 4 + row];

    // Face +x in camera space for the mirror check (only on clearly frontal faces).
    const fx = { x: r(0, 0), y: r(1, 0), z: r(2, 0) };
    const fwdHead = norm({ x: r(0, 2), y: r(1, 2), z: r(2, 2) });
    if (fwdHead && fwdHead.z > 0.8 && Math.abs(eyeSpanU) > 0.01) {
      const agree = Math.sign(fx.x) === Math.sign(eyeSpanU);
      mirrorVotes = Math.max(-20, Math.min(20, mirrorVotes + (agree ? 1 : -1)));
    }

    let yaw = 0;
    let pitch = 0;
    if (bs && bs.categories) {
      const b: Record<string, number> = {};
      for (const c of bs.categories) b[c.categoryName] = c.score;
      const g = (k: string) => b[k] ?? 0;
      yaw = EYE_YAW_MAX * ((g("eyeLookOutLeft") - g("eyeLookInLeft") + (g("eyeLookInRight") - g("eyeLookOutRight"))) / 2);
      pitch = EYE_PITCH_MAX * ((g("eyeLookUpLeft") - g("eyeLookDownLeft") + (g("eyeLookUpRight") - g("eyeLookDownRight"))) / 2);
    }
    const lx = Math.sin(yaw) * Math.cos(pitch);
    const ly = Math.sin(pitch);
    const lz = Math.cos(yaw) * Math.cos(pitch);
    const out = norm({
      x: r(0, 0) * lx + r(0, 1) * ly + r(0, 2) * lz,
      y: r(1, 0) * lx + r(1, 1) * ly + r(1, 2) * lz,
      z: r(2, 0) * lx + r(2, 1) * ly + r(2, 2) * lz,
    });
    if (!out) return null;
    if (mirrorVotes < -5) out.x = -out.x;
    return out;
  }

  return {
    detect,
    close() {
      if (closed) return;
      closed = true;
      try { pose.close(); } catch { /* ignore */ }
      try { face.close(); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * Per-track key points, kept separately so matching compares like with like: the eye midpoint
 * and the shoulder midpoint are ~0.2 apart in v for a nearby person, so switching between them
 * (pose eye visibility flickers when someone looks down at the dog) must not look like motion.
 * Each key keeps its last seen value while the track lives.
 */
interface TrackKeys {
  eye: UV | null;
  sho: UV | null;
  hand: UV | null;
}
interface Track extends TrackKeys {
  id: number;
  lastTs: number;
}

/** Greedy nearest-neighbour id assignment between consecutive frames. */
function createTracker() {
  let tracks: Track[] = [];
  let nextId = 1;
  return {
    assign(people: Omit<Human2D, "id">[], ts: number): Human2D[] {
      tracks = tracks.filter((t) => ts - t.lastTs <= TRACK_GAP_MS);
      const keys = people.map(keyPoints);
      const pairs: { p: number; t: number; d: number }[] = [];
      keys.forEach((k, pi) => {
        if (!k) return;
        tracks.forEach((t, ti) => {
          const d = keyDist(k, t);
          if (d <= TRACK_DIST) pairs.push({ p: pi, t: ti, d });
        });
      });
      pairs.sort((a, b) => a.d - b.d);
      const ids = new Array<number>(people.length).fill(0);
      const usedT = new Set<number>();
      for (const { p, t } of pairs) {
        if (ids[p] || usedT.has(t)) continue;
        ids[p] = tracks[t].id;
        usedT.add(t);
      }
      const out: Human2D[] = people.map((h, i) => {
        if (!ids[i]) ids[i] = nextId++;
        return { id: ids[i], ...h };
      });
      // Update/insert tracks.
      out.forEach((h, i) => {
        const k = keys[i];
        if (!k) return;
        const t = tracks.find((tr) => tr.id === h.id);
        if (t) {
          // Carry an unseen key along with the one that was seen (same rigid shift), so it
          // doesn't go stale while the person moves with only one key visible.
          if (k.eye && !k.sho && t.eye && t.sho) t.sho = shift(t.sho, t.eye, k.eye);
          if (k.sho && !k.eye && t.sho && t.eye) t.eye = shift(t.eye, t.sho, k.sho);
          if (k.eye) t.eye = k.eye;
          if (k.sho) t.sho = k.sho;
          if (k.hand) t.hand = k.hand;
          t.lastTs = ts;
        } else tracks.push({ id: h.id, ...k, lastTs: ts });
      });
      return out;
    },
  };
}

function keyPoints(h: Omit<Human2D, "id">): TrackKeys | null {
  const eye = h.eyes;
  const sho = h.shoulders ? mid2(h.shoulders.left, h.shoulders.right) : null;
  let hand: UV | null = null;
  if (h.hands.length) {
    let u = 0, v = 0;
    for (const p of h.hands) { u += p.u; v += p.v; }
    hand = { u: u / h.hands.length, v: v / h.hands.length };
  }
  return eye || sho || hand ? { eye, sho, hand } : null;
}

function shift(p: UV, from: UV, to: UV): UV {
  return { u: p.u + to.u - from.u, v: p.v + to.v - from.v };
}

/** Compares the most reliable key type both sides have; Infinity when they share none. */
function keyDist(a: TrackKeys, b: TrackKeys): number {
  if (a.eye && b.eye) return dist(a.eye, b.eye);
  if (a.sho && b.sho) return dist(a.sho, b.sho);
  if (a.hand && b.hand) return dist(a.hand, b.hand);
  return Infinity;
}

function visible(l: NormalizedLandmark | undefined): l is NormalizedLandmark {
  return !!l && (l.visibility ?? 0) > VIS && inImage({ u: l.x, v: l.y });
}
function inImage(p: UV): boolean {
  return p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1;
}
function mid(a: NormalizedLandmark, b: NormalizedLandmark): UV {
  return { u: (a.x + b.x) / 2, v: (a.y + b.y) / 2 };
}
function mid2(a: UV, b: UV): UV {
  return { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2 };
}
function dist(a: UV, b: UV): number {
  return Math.hypot(a.u - b.u, a.v - b.v);
}
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function norm(v: Vec3): Vec3 | null {
  const l = Math.hypot(v.x, v.y, v.z);
  if (!(l > 1e-9)) return null;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
