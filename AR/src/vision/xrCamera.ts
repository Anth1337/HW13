/*
 * WebXR camera image + depth → (ImageData, CameraModel) snapshots for the vision pipeline.
 *
 * Session features webxr.ts must request (all optional, so AR still starts without them):
 *   optionalFeatures: ["camera-access", "depth-sensing", "dom-overlay"]
 *   depthSensing: { usagePreference: ["cpu-optimized"], dataFormatPreference: ["luminance-alpha", "float32"] }
 * ("depthSensing" is required in the init dict whenever "depth-sensing" is requested, or
 * Chrome rejects the session request.) "camera-access" is Chrome-on-Android only (Raw Camera
 * Access); without it grab() always returns null and `available` stays false.
 *
 * three.js r187 interplay (WebXRManager.js):
 * - Depth: three only consumes depth when session.depthUsage === "gpu-optimized" (it then
 *   builds an occlusion mesh and stops drawing scene.background). With cpu-optimized usage it
 *   never touches depth, so there is no conflict. Do NOT list "gpu-optimized" in
 *   usagePreference.
 * - Camera access: when "camera-access" is enabled three calls binding.getCameraImage() itself
 *   every frame (exposed via renderer.xr.getCameraTexture). We use the same binding
 *   (renderer.xr.getBinding()); getCameraImage returns the same texture within one frame.
 * - World space: three sets the XR camera matrices straight from view.transform.matrix in
 *   renderer.xr.getReferenceSpace(); webxr.ts never parents the camera, so three's world space
 *   IS that reference space with no offset. We query poses in the same space.
 *
 * Assumption (Raw Camera Access spec): the camera image is aligned with the XRView that owns the
 * XRCamera — same field of view / projection — so image uv maps through view.projectionMatrix.
 * The opaque texture uses GL orientation (texcoord (0,0) = bottom-left of the view), so we read
 * back bottom-up and flip rows to get v DOWN.
 *
 * Call grab() inside the XR animation loop (renderer.setAnimationLoop callback), ideally before
 * renderer.render(). It restores raw GL state, calls renderer.resetState() and re-binds three's
 * current (XR) render target so the following render() still draws into the XR framebuffer.
 */
import * as THREE from "three";
import type { CameraModel, XRVisionSource } from "./types";

// ---- Minimal typings for Raw Camera Access (missing from @types/webxr) ----
interface XRCameraLike {
  readonly width: number;
  readonly height: number;
}
type XRViewWithCamera = XRView & { readonly camera?: XRCameraLike | null };
type BindingWithCamera = XRWebGLBinding & {
  getCameraImage?(camera: XRCameraLike): WebGLTexture | null;
};

// ---------------------------------------------------------------------------------------------
// Pure helpers (no WebXR / WebGL; unit-testable in Node)
// ---------------------------------------------------------------------------------------------

/** A copy of one frame's CPU depth buffer. */
export interface DepthSnapshot {
  /** Raw values (uint16 for "luminance-alpha"/"unsigned-short", float for "float32"). */
  data: Uint16Array | Float32Array;
  width: number;
  height: number;
  rawValueToMeters: number;
  /** Column-major 4x4: normalized view coords (origin top-left, x right, y down) → normalized depth-buffer coords. */
  normDepthBufferFromNormView: Float32Array;
}

/** Copies XRCPUDepthInformation into a DepthSnapshot (null if the format is unknown). */
export function snapshotDepth(
  info: {
    data: ArrayBuffer;
    width: number;
    height: number;
    rawValueToMeters: number;
    normDepthBufferFromNormView: { matrix: Float32Array };
  },
  format: XRDepthDataFormat | undefined,
): DepthSnapshot | null {
  const buf = info.data.slice(0);
  let data: Uint16Array | Float32Array;
  if (format === "float32") data = new Float32Array(buf);
  else if (format === "luminance-alpha" || format === "unsigned-short" || format === undefined) data = new Uint16Array(buf);
  else return null;
  if (data.length < info.width * info.height) return null;
  return {
    data,
    width: info.width,
    height: info.height,
    rawValueToMeters: info.rawValueToMeters,
    normDepthBufferFromNormView: new Float32Array(info.normDepthBufferFromNormView.matrix),
  };
}

/**
 * Metric depth at image point (u, v) (v down; the image is aligned with the view, so these
 * are the depth spec's normalized view coordinates). Nearest sample; if it's 0/invalid, the
 * mean of the valid samples in the 3x3 neighbourhood. null where unknown.
 */
export function depthAtSnapshot(d: DepthSnapshot, u: number, v: number): number | null {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
  const m = d.normDepthBufferFromNormView;
  // (u, v, 0, 1) through the column-major matrix.
  const w = m[3] * u + m[7] * v + m[15] || 1;
  const x = (m[0] * u + m[4] * v + m[12]) / w;
  const y = (m[1] * u + m[5] * v + m[13]) / w;
  const col = Math.min(d.width - 1, Math.max(0, Math.floor(x * d.width)));
  const row = Math.min(d.height - 1, Math.max(0, Math.floor(y * d.height)));
  const at = (c: number, r: number): number => {
    const raw = d.data[r * d.width + c];
    const meters = raw * d.rawValueToMeters;
    return Number.isFinite(meters) && meters > 0 ? meters : 0;
  };
  const center = at(col, row);
  if (center > 0) return center;
  let sum = 0;
  let n = 0;
  for (let r = row - 1; r <= row + 1; r++) {
    if (r < 0 || r >= d.height) continue;
    for (let c = col - 1; c <= col + 1; c++) {
      if (c < 0 || c >= d.width) continue;
      const m2 = at(c, r);
      if (m2 > 0) {
        sum += m2;
        n++;
      }
    }
  }
  return n > 0 ? sum / n : null;
}

/**
 * Builds a snapshot CameraModel from a view's camera→world matrix (XRView.transform.matrix,
 * column-major) and projection matrix (XRView.projectionMatrix). Both arrays are copied.
 */
export function makeCameraModel(
  viewMatrix: ArrayLike<number>,
  projectionMatrix: ArrayLike<number>,
  depth: DepthSnapshot | null = null,
): CameraModel {
  const camToWorld = new THREE.Matrix4().fromArray(Array.from(viewMatrix));
  const projInv = new THREE.Matrix4().fromArray(Array.from(projectionMatrix)).invert();
  const rotation = new THREE.Matrix4().extractRotation(camToWorld);
  const origin = new THREE.Vector3().setFromMatrixPosition(camToWorld);
  const tmp = new THREE.Vector3();

  const cam: CameraModel = {
    cameraToWorld: rotation,
    ray(u, v, outOrigin, outDir) {
      outOrigin.copy(origin);
      // NDC of the image point on the near plane → view space (applyMatrix4 divides by w).
      tmp.set(2 * u - 1, 1 - 2 * v, -1).applyMatrix4(projInv);
      outDir.copy(tmp).normalize().transformDirection(camToWorld);
    },
  };
  if (depth) cam.depthAt = (u, v) => depthAtSnapshot(depth, u, v);
  return cam;
}

/** Readback size: camera size scaled so the longest side <= maxSize (never upscaled). */
export function readbackSize(width: number, height: number, maxSize: number): { width: number; height: number } {
  const s = Math.min(1, maxSize / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** Flips RGBA rows in place-copy: src rows bottom-up → dst rows top-down. */
export function flipRowsInto(src: Uint8Array, dst: Uint8ClampedArray, width: number, height: number): void {
  const stride = width * 4;
  for (let r = 0; r < height; r++) {
    const from = (height - 1 - r) * stride;
    dst.set(src.subarray(from, from + stride), r * stride);
  }
}

// ---------------------------------------------------------------------------------------------
// WebGL blit (opaque camera texture → small RGBA framebuffer)
// ---------------------------------------------------------------------------------------------

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  // Fullscreen triangle: (-1,-1), (3,-1), (-1,3).
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = vec4(texture(uTex, vUv).rgb, 1.0); }`;

interface BlitResources {
  program: WebGLProgram;
  uTex: WebGLUniformLocation | null;
  vao: WebGLVertexArrayObject;
  fbo: WebGLFramebuffer;
  color: WebGLTexture;
  width: number;
  height: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`xrCamera shader: ${log}`);
  }
  return s;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`xrCamera program: ${log}`);
  }
  return p;
}

/** Saves the GL state the blit touches and returns a function that restores it. */
function saveGLState(gl: WebGL2RenderingContext): () => void {
  const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const readFb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
  const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  const activeTex = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0);
  const tex0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const sampler0 = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler | null;
  const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
  const packBuffer = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
  const packAlign = gl.getParameter(gl.PACK_ALIGNMENT) as number;
  const caps = [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD];
  const enabled = caps.map((c) => gl.isEnabled(c));
  const colorMask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
  return () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFb);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex0);
    gl.bindSampler(0, sampler0);
    gl.activeTexture(activeTex);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, packBuffer);
    gl.pixelStorei(gl.PACK_ALIGNMENT, packAlign);
    caps.forEach((c, i) => (enabled[i] ? gl.enable(c) : gl.disable(c)));
    gl.colorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
  };
}

// ---------------------------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------------------------

export function createXRVisionSource(
  renderer: THREE.WebGLRenderer,
  session: XRSession,
  opts: { intervalMs?: number; maxSize?: number } = {},
): XRVisionSource {
  const intervalMs = opts.intervalMs ?? 100;
  const maxSize = opts.maxSize ?? 384;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const isGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;

  let available = false;
  let hasDepth = false;
  let disposed = false;
  let broken = !isGL2; // permanent failure → grab() always returns null
  let lastGrab = -Infinity;
  let res: BlitResources | null = null;
  let pixels: Uint8Array | null = null;
  let image: ImageData | null = null;
  const warned = new Set<string>();
  const warnOnce = (key: string, err: unknown) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[xrCamera] ${key}`, err);
  };
  if (broken) warnOnce("WebGL2 required for camera readback", "");

  const cameraAccess = () => session.enabledFeatures?.includes("camera-access") ?? true;
  // depthUsage / depthDataFormat THROW (InvalidStateError) when "depth-sensing" wasn't granted,
  // so check enabledFeatures first and guard the getters. Worked out once and cached.
  let cpuDepthCached: boolean | null = null;
  const cpuDepth = (): boolean => {
    if (cpuDepthCached != null) return cpuDepthCached;
    try {
      const feats = session.enabledFeatures;
      cpuDepthCached = !!feats && feats.includes("depth-sensing") && session.depthUsage === "cpu-optimized";
    } catch {
      cpuDepthCached = false;
    }
    return cpuDepthCached;
  };

  function ensureResources(width: number, height: number): BlitResources {
    if (!res) {
      const program = createProgram(gl);
      const vao = gl.createVertexArray()!;
      const fbo = gl.createFramebuffer()!;
      const color = gl.createTexture()!;
      res = { program, uTex: gl.getUniformLocation(program, "uTex"), vao, fbo, color, width: 0, height: 0 };
    }
    if (res.width !== width || res.height !== height) {
      gl.bindTexture(gl.TEXTURE_2D, res.color);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, res.color, 0);
      res.width = width;
      res.height = height;
      pixels = new Uint8Array(width * height * 4);
      image = new ImageData(width, height);
    }
    return res;
  }

  /** Draws the camera texture into our FBO and reads it back into `image` (v down). */
  function readCamera(camTex: WebGLTexture, width: number, height: number): ImageData {
    const restore = saveGLState(gl);
    const prevTarget = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevLevel = renderer.getActiveMipmapLevel();
    try {
      const r = ensureResources(width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, r.fbo);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.colorMask(true, true, true, true);
      gl.useProgram(r.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, camTex);
      gl.bindSampler(0, null);
      gl.uniform1i(r.uTex, 0);
      gl.bindVertexArray(r.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels!);
      flipRowsInto(pixels!, image!.data, width, height);
      return image!;
    } finally {
      restore();
      // Resync three's state cache, then re-bind the XR render target that resetState() forgets
      // (otherwise the next render() would draw into the default canvas framebuffer).
      renderer.resetState();
      renderer.setRenderTarget(prevTarget, prevFace, prevLevel);
    }
  }

  function readDepth(frame: XRFrame, view: XRView): DepthSnapshot | null {
    try {
      if (!cpuDepth() || typeof frame.getDepthInformation !== "function") return null;
      const info = frame.getDepthInformation(view);
      if (!info || !info.data || !(info.width > 0) || !(info.height > 0)) return null;
      const snap = snapshotDepth(info, session.depthDataFormat);
      if (snap) hasDepth = true;
      return snap;
    } catch (err) {
      // Throws while depth isn't available yet (first frames) or if the feature is inactive.
      warnOnce("depth unavailable", err);
      return null;
    }
  }

  return {
    get available() {
      return available;
    },
    get hasDepth() {
      return hasDepth;
    },
    grab(frame, timeMs) {
      if (disposed || broken || !cameraAccess()) return null;
      if (timeMs - lastGrab < intervalMs) return null;
      try {
        const refSpace = renderer.xr.getReferenceSpace();
        if (!refSpace) return null;
        const pose = frame.getViewerPose(refSpace);
        if (!pose) return null;
        const view = (pose.views as readonly XRViewWithCamera[]).find((v) => v.camera);
        const xrCam = view?.camera;
        if (!view || !xrCam || !(xrCam.width > 0) || !(xrCam.height > 0)) return null;

        const binding = renderer.xr.getBinding() as BindingWithCamera | null;
        if (!binding || typeof binding.getCameraImage !== "function") {
          broken = true;
          warnOnce("XRWebGLBinding.getCameraImage not supported", "");
          return null;
        }
        const camTex = binding.getCameraImage(xrCam);
        if (!camTex) return null;
        lastGrab = timeMs;

        const size = readbackSize(xrCam.width, xrCam.height, maxSize);
        const img = readCamera(camTex, size.width, size.height);
        available = true;
        // readDepth never throws: a depth failure only means "no depth", never "no image".
        const cam = makeCameraModel(view.transform.matrix, view.projectionMatrix, readDepth(frame, view));
        return { image: img, cam };
      } catch (err) {
        warnOnce("camera grab failed", err);
        return null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (res && !gl.isContextLost()) {
        gl.deleteProgram(res.program);
        gl.deleteVertexArray(res.vao);
        gl.deleteFramebuffer(res.fbo);
        gl.deleteTexture(res.color);
      }
      res = null;
      pixels = null;
      image = null;
    },
  };
}
