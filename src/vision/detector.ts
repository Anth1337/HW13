import type {
  Classifications,
  FaceLandmarker,
  FaceLandmarkerResult,
  HandLandmarker,
  HandLandmarkerResult,
  Matrix,
  PoseLandmarker,
  PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import type { Face2D, Hand2D, Observation, Pose2D, UV, VisionDetector } from "./types";

/*
 * MediaPipe HandLandmarker + FaceLandmarker → Observation (image coords, u right, v down, 0..1).
 *
 * Hands are the primary input (the phone user's own hand near the camera) and run on EVERY
 * call. Faces (eye contact, who is speaking) run on calls 0 and 2 of every 6 and bodies (the optional
 * PoseLandmarker that ties hands/faces to people) on calls 1 and 4; the last result (same ids) is
 * returned in between, flagged facesStale / bodiesStale (up to 4 calls old). The schedule is staggered on call % 6 so that no call runs all three
 * models: the pose model owns calls 1 and 4 and a face that would coincide with it (call 4)
 * is skipped, i.e. hands+pose or hands+face, never hands+face+pose. A missing pose model
 * (load failure, or it keeps throwing) only means no bodies; it is never fatal.
 *
 * Ids: every kind of object is tracked by createTracker (constant-velocity prediction, size-aware
 * gate, optimal global assignment), see there.
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
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// Face mesh landmark indices.
const F_RIGHT_EYE_OUTER = 33; // subject's right eye, outer corner (image left for a facing person)
const F_LEFT_EYE_OUTER = 263; // subject's left eye, outer corner
const F_RIGHT_IRIS = 468;
const F_LEFT_IRIS = 473;

/** Hand key = centroid of wrist + the four finger MCPs (stable under finger motion). */
const HAND_KEY = [0, 5, 9, 13, 17] as const;
const HAND_TRACK_DIST = 0.25; // uv units; a hand can move fast near the camera
const FACE_TRACK_DIST = 0.15;
const BODY_TRACK_DIST = 0.3;
const TRACK_GAP_MS = 500;
const BODY_GAP_MS = 1000;
const POSE_FAILS_MAX = 3;
/** MediaPipe pose landmark indices. */
const P_NOSE = 0;
const P_L_SHOULDER = 11;
const P_R_SHOULDER = 12;
const P_VISIBLE = 0.3; // visibility above which a landmark counts for the tracking key / size
const EYE_YAW_MAX = (25 * Math.PI) / 180;
const EYE_PITCH_MAX = (20 * Math.PI) / 180;

type Vec3 = { x: number; y: number; z: number };

export async function createVisionDetector(
  opts: { maxHands?: number; maxFaces?: number; maxBodies?: number } = {},
): Promise<VisionDetector> {
  const maxHands = Math.max(1, Math.floor(opts.maxHands ?? 4));
  const maxFaces = Math.max(0, Math.floor(opts.maxFaces ?? 4));
  const maxBodies = Math.max(0, Math.floor(opts.maxBodies ?? 3));
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

  // Bodies are optional too (they only improve who-is-who): failure = no bodies.
  let pose: PoseLandmarker | null = null;
  if (maxBodies > 0) {
    try {
      pose = await withDelegateFallback("bodies", (delegate) =>
        vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate },
          runningMode: "VIDEO",
          numPoses: maxBodies,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }),
      );
    } catch (err) {
      console.warn("[vision] pose landmarker unavailable; no body tracking", err);
      pose = null;
    }
  }

  let lastTs = -Infinity;
  let closed = false;
  let calls = 0;
  let poseFails = 0;
  let lastFaces: Face2D[] = [];
  let lastBodies: Pose2D[] = [];
  const handTracker = createTracker(HAND_TRACK_DIST);
  const faceTracker = createTracker(FACE_TRACK_DIST);
  const bodyTracker = createTracker(BODY_TRACK_DIST, BODY_GAP_MS);
  // Runtime check of the image-x vs face-geometry-x convention (see faceGaze()). Positive
  // votes = geometry +x agrees with image +u (expected); negative = mirrored.
  let mirrorVotes = 0;

  function detect(image: ImageData | HTMLVideoElement | HTMLCanvasElement, timestampMs: number): Observation {
    if (closed) return { hands: [], faces: [], bodies: [] };
    try {
      let ts = Number.isFinite(timestampMs) ? timestampMs : lastTs + 1;
      if (ts <= lastTs) ts = lastTs + 1;
      lastTs = ts;

      const handRes: HandLandmarkerResult = hand.detectForVideo(image, ts);
      const hands = buildHands(handRes, ts);

      // Schedule on n % 6: pose on n % 3 === 1 (1, 4), faces on even n except when the pose runs.
      const n = calls++ % 6;
      const poseNow = pose !== null && n % 3 === 1;
      let facesStale = true, bodiesStale = true;
      if (face && n % 2 === 0 && !poseNow) {
        facesStale = false;
        try {
          const faceRes: FaceLandmarkerResult = face.detectForVideo(image, ts);
          lastFaces = buildFaces(faceRes, ts);
        } catch (err) {
          console.warn("[vision] face detect failed", err);
          lastFaces = [];
        }
      }
      if (pose && poseNow) {
        bodiesStale = false;
        try {
          const poseRes: PoseLandmarkerResult = pose.detectForVideo(image, ts);
          lastBodies = buildBodies(poseRes, ts);
          poseFails = 0;
        } catch (err) {
          lastBodies = [];
          if (++poseFails >= POSE_FAILS_MAX) {
            console.warn("[vision] pose detect keeps failing; body tracking disabled", err);
            try { pose.close(); } catch { /* ignore */ }
            pose = null;
          }
        }
      }
      return { hands, faces: lastFaces, bodies: lastBodies, facesStale, bodiesStale };
    } catch (err) {
      console.warn("[vision] detect failed", err);
      return { hands: [], faces: [], bodies: [] };
    }
  }

  function buildHands(res: HandLandmarkerResult, ts: number): Hand2D[] {
    const lms = res.landmarks ?? [];
    const worlds = res.worldLandmarks ?? [];
    const cls = res.handedness ?? res.handednesses ?? [];
    const raw: Omit<Hand2D, "id">[] = [];
    const keys: UV[] = [];
    const sizes: number[] = [];
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
      let u0 = 1, u1 = 0, v0 = 1, v1 = 0;
      for (const p of lm) {
        if (p.x < u0) u0 = p.x;
        if (p.x > u1) u1 = p.x;
        if (p.y < v0) v0 = p.y;
        if (p.y > v1) v1 = p.y;
      }
      sizes.push(Math.max(u1 - u0, v1 - v0));
    }
    const ids = handTracker.assign(keys, ts, sizes);
    return raw.map((h, i) => ({ id: ids[i], ...h }));
  }

  function buildFaces(res: FaceLandmarkerResult, ts: number): Face2D[] {
    const raw: Omit<Face2D, "id">[] = [];
    const keys: UV[] = [];
    const sizes: number[] = [];
    (res.faceLandmarks ?? []).forEach((lm, i) => {
      if (!lm || lm.length <= F_LEFT_EYE_OUTER) return;
      const rOuter = lm[F_RIGHT_EYE_OUTER];
      const lOuter = lm[F_LEFT_EYE_OUTER];
      const eyes = lm.length > F_LEFT_IRIS
        ? { u: (lm[F_RIGHT_IRIS].x + lm[F_LEFT_IRIS].x) / 2, v: (lm[F_RIGHT_IRIS].y + lm[F_LEFT_IRIS].y) / 2 }
        : { u: (rOuter.x + lOuter.x) / 2, v: (rOuter.y + lOuter.y) / 2 };
      const g = faceGaze(res.facialTransformationMatrixes?.[i], res.faceBlendshapes?.[i], lOuter.x - rOuter.x);
      if (!g) return;
      let u0 = 1, u1 = 0, v0 = 1, v1 = 0;
      for (let k = 0; k < lm.length; k++) {
        const p = lm[k];
        if (p.x < u0) u0 = p.x;
        if (p.x > u1) u1 = p.x;
        if (p.y < v0) v0 = p.y;
        if (p.y > v1) v1 = p.y;
      }
      raw.push({
        score: 0.8, // face results carry no per-face score; detection already passed 0.5
        eyes,
        // Subject's left eye outer corner (263) / right eye outer corner (33).
        leftEyeOuter: { u: lOuter.x, v: lOuter.y },
        rightEyeOuter: { u: rOuter.x, v: rOuter.y },
        gazeCamera: g.gaze,
        headForwardCamera: g.head,
        box: { u0, v0, u1, v1 },
        mouthOpen: jawOpen(res.faceBlendshapes?.[i]),
      });
      keys.push(eyes);
      sizes.push(Math.max(u1 - u0, v1 - v0));
    });
    const ids = faceTracker.assign(keys, ts, sizes);
    return raw.map((f, i) => ({ id: ids[i], ...f }));
  }

  function buildBodies(res: PoseLandmarkerResult, ts: number): Pose2D[] {
    const lms = res.landmarks ?? [];
    const worlds = res.worldLandmarks ?? [];
    const raw: Omit<Pose2D, "id">[] = [];
    const keys: UV[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < lms.length; i++) {
      const lm = lms[i];
      const w = worlds[i];
      if (!lm || lm.length < 33 || !w || w.length < 33) continue;
      const vis = lm.map((p) => clamp01(p.visibility ?? 0));
      const key = bodyKey(lm, vis);
      if (!key) continue;
      let u0 = 1, u1 = 0, v0 = 1, v1 = 0;
      for (let k = 0; k < lm.length; k++) {
        if (vis[k] < P_VISIBLE) continue;
        const p = lm[k];
        if (p.x < u0) u0 = p.x;
        if (p.x > u1) u1 = p.x;
        if (p.y < v0) v0 = p.y;
        if (p.y > v1) v1 = p.y;
      }
      raw.push({
        // Pose results carry no per-person score: mean visibility of nose + shoulders.
        score: (vis[P_NOSE] + vis[P_L_SHOULDER] + vis[P_R_SHOULDER]) / 3,
        landmarks: lm.map((p) => ({ u: p.x, v: p.y })),
        visibility: vis,
        world: w.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      });
      keys.push(key);
      sizes.push(Math.max(0.05, Math.hypot(u1 - u0, v1 - v0) / 2));
    }
    const ids = bodyTracker.assign(keys, ts, sizes);
    return raw.map((b, i) => ({ id: ids[i], ...b }));
  }

  /** Tracking key of a body: shoulder midpoint, else nose, else the centre of the visible landmarks. */
  function bodyKey(lm: { x: number; y: number }[], vis: number[]): UV | null {
    const a = lm[P_L_SHOULDER], b = lm[P_R_SHOULDER];
    if (vis[P_L_SHOULDER] >= P_VISIBLE && vis[P_R_SHOULDER] >= P_VISIBLE) return { u: (a.x + b.x) / 2, v: (a.y + b.y) / 2 };
    if (vis[P_NOSE] >= P_VISIBLE) return { u: lm[P_NOSE].x, v: lm[P_NOSE].y };
    let u = 0, v = 0, c = 0;
    for (let k = 0; k < lm.length; k++) if (vis[k] >= P_VISIBLE) { u += lm[k].x; v += lm[k].y; c++; }
    return c >= 3 ? { u: u / c, v: v / c } : null;
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
      try { pose?.close(); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------------------------------------------

function jawOpen(bs: Classifications | undefined): number {
  const cats = bs?.categories;
  if (!cats) return 0;
  for (let i = 0; i < cats.length; i++) if (cats[i].categoryName === "jawOpen") return clamp01(cats[i].score);
  return 0;
}

/**
 * Id assignment between consecutive detections of one kind of object (hands, faces, bodies), one
 * key point per object:
 *  - each track predicts its key with a constant-velocity model (velocity smoothed over matched
 *    frames, extrapolated at most PREDICT_MAX_MS so a stale track does not fly off);
 *  - the gate is size-aware: an object close to the camera (large `size` in uv) moves more in
 *    uv, so gate = clamp(SIZE_GATE_K * size, 0.4 * maxDist, 1.5 * maxDist), widened up to 50 %
 *    over the track's gap; without sizes the gate is simply maxDist;
 *  - detections are matched to tracks by the optimal global assignment (Hungarian algorithm on
 *    the distance/gate cost plus a small size-ratio penalty), not greedily, so two objects that
 *    cross swap ids only if the prediction really prefers it;
 *  - new ids are conservative: detections left over after the strict pass get a second chance
 *    against the tracks left over, at twice the gate, before a new id is minted. Ids are never
 *    reused.
 * A track survives gaps of up to gapMs. assign() must only be called when the model actually ran.
 * Exported for tests.
 */
export function createTracker(maxDist: number, gapMs = TRACK_GAP_MS) {
  interface Track { id: number; key: UV; vel: UV; size: number; lastTs: number }
  let tracks: Track[] = [];
  let nextId = 1;

  const predU = (t: Track, ts: number) => t.key.u + t.vel.u * Math.min(ts - t.lastTs, PREDICT_MAX_MS);
  const predV = (t: Track, ts: number) => t.key.v + t.vel.v * Math.min(ts - t.lastTs, PREDICT_MAX_MS);

  function gateOf(t: Track, size: number | undefined, ts: number): number {
    let g = maxDist;
    if (size !== undefined && size > 0) {
      const s = Math.max(size, t.size);
      g = Math.min(1.5 * maxDist, Math.max(0.4 * maxDist, SIZE_GATE_K * s));
    }
    return g * (1 + 0.5 * Math.min(1, (ts - t.lastTs) / gapMs));
  }

  /** One assignment round over the given subsets; writes matches into `ids` / `used`. */
  function round(
    keys: readonly UV[], sizes: readonly number[] | undefined, ts: number,
    dets: number[], trs: number[], gateScale: number, ids: number[], used: boolean[],
  ): void {
    if (dets.length === 0 || trs.length === 0) return;
    const n = Math.max(dets.length, trs.length);
    const cost: number[][] = [];
    for (let r = 0; r < n; r++) {
      const row = new Array<number>(n).fill(0);
      cost.push(row);
      if (r >= dets.length) continue;
      const ki = dets[r], k = keys[ki], ks = sizes?.[ki];
      for (let c = 0; c < n; c++) {
        if (c >= trs.length) continue; // dummy column: cost 0
        const t = tracks[trs[c]];
        const gate = gateOf(t, ks, ts) * gateScale;
        const d = Math.hypot(k.u - predU(t, ts), k.v - predV(t, ts));
        if (d > gate) { row[c] = FORBIDDEN; continue; }
        let c0 = d / gate;
        if (ks !== undefined && ks > 0 && t.size > 0) c0 += 0.25 * Math.min(1, Math.abs(Math.log(ks / t.size)));
        row[c] = c0;
      }
      // (rows >= dets.length stay all-zero: dummy detections)
    }
    const colOfRow = hungarian(cost, n);
    for (let r = 0; r < dets.length; r++) {
      const c = colOfRow[r];
      if (c < 0 || c >= trs.length || cost[r][c] >= FORBIDDEN) continue;
      ids[dets[r]] = tracks[trs[c]].id;
      used[trs[c]] = true;
    }
  }

  return {
    assign(keys: readonly UV[], ts: number, sizes?: readonly number[]): number[] {
      tracks = tracks.filter((t) => ts - t.lastTs <= gapMs);
      const ids = new Array<number>(keys.length).fill(0);
      const used = new Array<boolean>(tracks.length).fill(false);
      const all = (len: number, skip?: (i: number) => boolean) => {
        const a: number[] = [];
        for (let i = 0; i < len; i++) if (!skip || !skip(i)) a.push(i);
        return a;
      };
      round(keys, sizes, ts, all(keys.length), all(tracks.length), 1, ids, used);
      round(keys, sizes, ts, all(keys.length, (i) => ids[i] !== 0), all(tracks.length, (i) => used[i]), 2, ids, used);

      const byId = new Map<number, Track>();
      for (const t of tracks) byId.set(t.id, t);
      keys.forEach((k, i) => {
        const size = sizes?.[i] ?? 0;
        const t = ids[i] ? byId.get(ids[i]) : undefined;
        if (!t) {
          ids[i] = nextId++;
          tracks.push({ id: ids[i], key: { u: k.u, v: k.v }, vel: { u: 0, v: 0 }, size, lastTs: ts });
          return;
        }
        const dt = ts - t.lastTs;
        if (dt > 0 && dt <= VEL_FIT_MAX_MS) {
          t.vel.u = 0.5 * t.vel.u + 0.5 * ((k.u - t.key.u) / dt);
          t.vel.v = 0.5 * t.vel.v + 0.5 * ((k.v - t.key.v) / dt);
        } else {
          t.vel.u = 0;
          t.vel.v = 0;
        }
        t.key.u = k.u;
        t.key.v = k.v;
        t.size = size > 0 ? (t.size > 0 ? 0.5 * t.size + 0.5 * size : size) : t.size;
        t.lastTs = ts;
      });
      return ids;
    },
  };
}

const FORBIDDEN = 1e4;
const SIZE_GATE_K = 1.5;
const PREDICT_MAX_MS = 300;
const VEL_FIT_MAX_MS = 300;

/**
 * Minimum-cost assignment on a square n x n matrix (Hungarian algorithm, O(n^3), potentials
 * form). Returns, per row, the assigned column. Exported for tests.
 */
export function hungarian(cost: readonly (readonly number[])[], n: number): number[] {
  const INF = Infinity;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0); // p[col] = row matched to col (1-based)
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(INF);
    const usedCol = new Array<boolean>(n + 1).fill(false);
    do {
      usedCol[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (usedCol[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (usedCol[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const colOfRow = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] > 0) colOfRow[p[j] - 1] = j - 1;
  return colOfRow;
}
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function norm(v: Vec3): Vec3 | null {
  const l = Math.hypot(v.x, v.y, v.z);
  if (!(l > 1e-9)) return null;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
