import type {
  Classifications,
  FaceLandmarker,
  FaceLandmarkerResult,
  HandLandmarker,
  HandLandmarkerResult,
  Matrix,
} from "@mediapipe/tasks-vision";
import type { Face2D, Hand2D, Observation, UV, VisionDetector } from "./types";

/*
 * MediaPipe HandLandmarker + FaceLandmarker → Observation (image coords, u right, v down, 0..1).
 *
 * Hands are the primary input (the phone user's own hand near the camera) and run on EVERY
 * call. Faces only drive eye contact, so the face landmarker runs on every 2nd call and the
 * last face result (same ids) is returned in between. No pose / whole-body model is loaded.
 *
 * The MediaPipe bundle (~1 MB JS + ~10 MB wasm + models) is loaded lazily via a dynamic
 * import so it lands in its own chunk and only downloads when the dog actually needs eyes.
 */

/** Pinned to exactly the installed @mediapipe/tasks-vision version (the JS/wasm pair must match). */
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm";
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// Face mesh landmark indices.
const F_RIGHT_EYE_OUTER = 33; // subject's right eye, outer corner (image left for a facing person)
const F_LEFT_EYE_OUTER = 263; // subject's left eye, outer corner
const F_RIGHT_IRIS = 468;
const F_LEFT_IRIS = 473;

/** Hand key = centroid of wrist + the four finger MCPs (stable under finger motion). */
const HAND_KEY = [0, 5, 9, 13, 17] as const;
const HAND_TRACK_DIST = 0.25; // uv units; a hand can move fast near the camera
const FACE_TRACK_DIST = 0.15;
const TRACK_GAP_MS = 500;
const EYE_YAW_MAX = (25 * Math.PI) / 180;
const EYE_PITCH_MAX = (20 * Math.PI) / 180;

type Vec3 = { x: number; y: number; z: number };

export async function createVisionDetector(
  opts: { maxHands?: number; maxFaces?: number } = {},
): Promise<VisionDetector> {
  const maxHands = Math.max(1, Math.floor(opts.maxHands ?? 2));
  const maxFaces = Math.max(0, Math.floor(opts.maxFaces ?? 2));
  const vision = await import("@mediapipe/tasks-vision");
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);

  async function withDelegateFallback<T>(what: string, make: (delegate: "GPU" | "CPU") => Promise<T>): Promise<T> {
    try {
      return await make("GPU");
    } catch (err) {
      console.warn(`[vision] ${what}: GPU delegate failed, falling back to CPU`, err);
      return make("CPU");
    }
  }

  const hand: HandLandmarker = await withDelegateFallback("hands", (delegate) =>
    vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate },
      runningMode: "VIDEO",
      numHands: maxHands,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
  );
  // Faces are optional (eye contact is low priority): a face model failure is not fatal.
  let face: FaceLandmarker | null = null;
  if (maxFaces > 0) {
    try {
      face = await withDelegateFallback("faces", (delegate) =>
        vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate },
          runningMode: "VIDEO",
          numFaces: maxFaces,
          outputFacialTransformationMatrixes: true,
          outputFaceBlendshapes: true,
        }),
      );
    } catch (err) {
      console.warn("[vision] face landmarker unavailable; eye contact disabled", err);
      face = null;
    }
  }

  let lastTs = -Infinity;
  let closed = false;
  let calls = 0;
  let lastFaces: Face2D[] = [];
  const handTracker = createTracker(HAND_TRACK_DIST);
  const faceTracker = createTracker(FACE_TRACK_DIST);
  // Runtime check of the image-x vs face-geometry-x convention (see faceGaze()). Positive
  // votes = geometry +x agrees with image +u (expected); negative = mirrored.
  let mirrorVotes = 0;

  function detect(image: ImageData | HTMLVideoElement | HTMLCanvasElement, timestampMs: number): Observation {
    if (closed) return { hands: [], faces: [] };
    try {
      let ts = Number.isFinite(timestampMs) ? timestampMs : lastTs + 1;
      if (ts <= lastTs) ts = lastTs + 1;
      lastTs = ts;

      const handRes: HandLandmarkerResult = hand.detectForVideo(image, ts);
      const hands = buildHands(handRes, ts);

      // Faces on every 2nd call (they only drive eye contact); in between, repeat the last ones.
      if (face && calls++ % 2 === 0) {
        try {
          const faceRes: FaceLandmarkerResult = face.detectForVideo(image, ts);
          lastFaces = buildFaces(faceRes, ts);
        } catch (err) {
          console.warn("[vision] face detect failed", err);
          lastFaces = [];
        }
      }
      return { hands, faces: lastFaces };
    } catch (err) {
      console.warn("[vision] detect failed", err);
      return { hands: [], faces: [] };
    }
  }

  function buildHands(res: HandLandmarkerResult, ts: number): Hand2D[] {
    const lms = res.landmarks ?? [];
    const worlds = res.worldLandmarks ?? [];
    const cls = res.handedness ?? res.handednesses ?? [];
    const raw: Omit<Hand2D, "id">[] = [];
    const keys: UV[] = [];
    for (let i = 0; i < lms.length; i++) {
      const lm = lms[i];
      const w = worlds[i];
      if (!lm || lm.length < 21 || !w || w.length < 21) continue;
      const c = cls[i]?.[0];
      // NOTE: MediaPipe's handedness label assumes a mirrored (selfie) image; for the
      // unmirrored rear camera it may be swapped. Nothing downstream depends on it.
      const handedness: "Left" | "Right" = c?.categoryName === "Left" ? "Left" : "Right";
      raw.push({
        score: clamp01(c?.score ?? 0.5),
        handedness,
        landmarks: lm.map((p) => ({ u: p.x, v: p.y })),
        world: w.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      });
      let u = 0, v = 0;
      for (const k of HAND_KEY) { u += lm[k].x; v += lm[k].y; }
      keys.push({ u: u / HAND_KEY.length, v: v / HAND_KEY.length });
    }
    const ids = handTracker.assign(keys, ts);
    return raw.map((h, i) => ({ id: ids[i], ...h }));
  }

  function buildFaces(res: FaceLandmarkerResult, ts: number): Face2D[] {
    const raw: Omit<Face2D, "id">[] = [];
    const keys: UV[] = [];
    (res.faceLandmarks ?? []).forEach((lm, i) => {
      if (!lm || lm.length <= F_LEFT_EYE_OUTER) return;
      const rOuter = lm[F_RIGHT_EYE_OUTER];
      const lOuter = lm[F_LEFT_EYE_OUTER];
      const eyes = lm.length > F_LEFT_IRIS
        ? { u: (lm[F_RIGHT_IRIS].x + lm[F_LEFT_IRIS].x) / 2, v: (lm[F_RIGHT_IRIS].y + lm[F_LEFT_IRIS].y) / 2 }
        : { u: (rOuter.x + lOuter.x) / 2, v: (rOuter.y + lOuter.y) / 2 };
      const g = faceGaze(res.facialTransformationMatrixes?.[i], res.faceBlendshapes?.[i], lOuter.x - rOuter.x);
      if (!g) return;
      raw.push({
        score: 0.8, // face results carry no per-face score; detection already passed 0.5
        eyes,
        // Subject's left eye outer corner (263) / right eye outer corner (33).
        leftEyeOuter: { u: lOuter.x, v: lOuter.y },
        rightEyeOuter: { u: rOuter.x, v: rOuter.y },
        gazeCamera: g.gaze,
        headForwardCamera: g.head,
      });
      keys.push(eyes);
    });
    const ids = faceTracker.assign(keys, ts);
    return raw.map((f, i) => ({ id: ids[i], ...f }));
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
   * an unmirrored rear-camera image), negate x of the final vectors: an x-mirrored space
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
  function faceGaze(
    m: Matrix | undefined,
    bs: Classifications | undefined,
    eyeSpanU: number,
  ): { gaze: Vec3; head: Vec3 } | null {
    if (!m || !m.data || m.data.length < 16) return null;
    const d = m.data;
    const r = (row: number, col: number) => d[col * 4 + row];

    // Face +x in camera space for the mirror check (only on clearly frontal faces).
    const fx = { x: r(0, 0), y: r(1, 0), z: r(2, 0) };
    const head = norm({ x: r(0, 2), y: r(1, 2), z: r(2, 2) });
    if (!head) return null;
    if (head.z > 0.8 && Math.abs(eyeSpanU) > 0.01) {
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
    const gaze = norm({
      x: r(0, 0) * lx + r(0, 1) * ly + r(0, 2) * lz,
      y: r(1, 0) * lx + r(1, 1) * ly + r(1, 2) * lz,
      z: r(2, 0) * lx + r(2, 1) * ly + r(2, 2) * lz,
    });
    if (!gaze) return null;
    if (mirrorVotes < -5) {
      gaze.x = -gaze.x;
      head.x = -head.x;
    }
    return { gaze, head };
  }

  return {
    detect,
    close() {
      if (closed) return;
      closed = true;
      try { hand.close(); } catch { /* ignore */ }
      try { face?.close(); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * Greedy nearest-neighbour id assignment between consecutive frames on one key point per
 * object. A track survives gaps of up to TRACK_GAP_MS; matches farther than maxDist get a new id.
 * Exported for tests.
 */
export function createTracker(maxDist: number, gapMs = TRACK_GAP_MS) {
  let tracks: { id: number; key: UV; lastTs: number }[] = [];
  let nextId = 1;
  return {
    assign(keys: readonly UV[], ts: number): number[] {
      tracks = tracks.filter((t) => ts - t.lastTs <= gapMs);
      const pairs: { k: number; t: number; d: number }[] = [];
      keys.forEach((k, ki) => {
        tracks.forEach((t, ti) => {
          const d = Math.hypot(k.u - t.key.u, k.v - t.key.v);
          if (d <= maxDist) pairs.push({ k: ki, t: ti, d });
        });
      });
      pairs.sort((a, b) => a.d - b.d);
      const ids = new Array<number>(keys.length).fill(0);
      const usedT = new Set<number>();
      for (const { k, t } of pairs) {
        if (ids[k] || usedT.has(t)) continue;
        ids[k] = tracks[t].id;
        usedT.add(t);
      }
      keys.forEach((k, i) => {
        if (!ids[i]) {
          ids[i] = nextId++;
          tracks.push({ id: ids[i], key: k, lastTs: ts });
        } else {
          const t = tracks.find((tr) => tr.id === ids[i])!;
          t.key = k;
          t.lastTs = ts;
        }
      });
      return ids;
    },
  };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function norm(v: Vec3): Vec3 | null {
  const l = Math.hypot(v.x, v.y, v.z);
  if (!(l > 1e-9)) return null;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
