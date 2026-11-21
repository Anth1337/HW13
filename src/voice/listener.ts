import type { VoiceListener, VoiceResult, VoiceState } from "./types";

/*
 * Web Speech API listener (SpeechRecognition / webkitSpeechRecognition), continuous + interim.
 *
 * Browser caveats (cannot be fully verified without a device):
 *  - start() MUST be called synchronously inside a click/tap handler: Chrome Android and iOS Safari refuse the
 *    mic prompt otherwise. Auto-restarts afterwards are fine once permission is granted.
 *  - Chrome ends a continuous session after silence / ~60 s, and Android Chrome ends it after every phrase; we
 *    restart on `end` with backoff. Each restart can play the system "listening" beep on Android and briefly
 *    drop audio, so a word said exactly at a restart can be lost. Nothing in JS can suppress the beep.
 *  - Inside an immersive WebXR session (Chrome Android) the page is still foreground, but the AR session may
 *    hold the camera/audio focus: recognition can fail with "audio-capture"/"not-allowed" or silently stop
 *    producing results. Request the mic (call start()) BEFORE entering AR, from the same tap (dogPlay's
 *    primeVoice() does this from the Deploy tap when voice was left on), and
 *    watch onState: "denied"/"off" means voice is unavailable and the UI should say so.
 *  - Recognition is cloud-based on Chrome (needs network; repeated "network" errors switch us to "off") and
 *    unavailable in Firefox. iOS Safari 14.5+ has webkitSpeechRecognition but needs Siri/dictation enabled.
 *  - Recognition is paused while the tab is hidden and resumed when it is visible again.
 */

interface SRAlternative { transcript: string; confidence: number }
interface SRResult { readonly length: number; readonly isFinal: boolean; [i: number]: SRAlternative }
interface SREvent { resultIndex: number; results: { readonly length: number; [i: number]: SRResult } }
interface SRErrorEvent { error?: string }
interface SR {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SRCtor = new () => SR;

export interface VoiceListenerOptions {
  /** BCP-47 tag; defaults to navigator.language or "en-US". */
  lang?: string;
}

const RESTART_BASE_MS = 250;
const RESTART_MAX_MS = 3000;
const QUICK_END_MS = 1000; // a session that ends sooner than this without a result counts as a failure
const MAX_NETWORK_ERRORS = 5;

function findCtor(): SRCtor | null {
  try {
    const w = (typeof window !== "undefined" ? window : globalThis) as unknown as {
      SpeechRecognition?: SRCtor;
      webkitSpeechRecognition?: SRCtor;
    };
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  } catch {
    return null;
  }
}

export function createVoiceListener(opts: VoiceListenerOptions = {}): VoiceListener {
  const Ctor = findCtor();
  const resultSubs = new Set<(r: VoiceResult) => void>();
  const stateSubs = new Set<(s: VoiceState) => void>();
  let state: VoiceState = Ctor ? "off" : "unsupported";
  let disposed = false;

  const setState = (s: VoiceState): void => {
    if (s === state) return;
    state = s;
    for (const fn of Array.from(stateSubs)) {
      try { fn(s); } catch { /* subscriber bug must not break recognition */ }
    }
  };

  const api: VoiceListener = {
    get supported() { return Ctor !== null; },
    get state() { return state; },
    start() { /* replaced below when supported */ },
    stop() { /* ditto */ },
    onResult(fn) {
      resultSubs.add(fn);
      return () => { resultSubs.delete(fn); };
    },
    onState(fn) {
      stateSubs.add(fn);
      return () => { stateSubs.delete(fn); };
    },
    dispose() {
      disposed = true;
      resultSubs.clear();
      stateSubs.clear();
    },
  };
  if (!Ctor) return api;

  let lang = opts.lang || (typeof navigator !== "undefined" && navigator.language) || "en-US";
  let wantOn = false; // user intent: true between start() and stop()
  let rec: SR | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;
  let gotResult = false; // in the current session
  let failures = 0; // consecutive sessions that died young without a result
  let networkErrors = 0;
  let langRetried = false;
  let fatal = false; // set by onerror to veto the restart that follows `end`
  let everStarted = false; // recognition has run at least once (the mic permission was granted)

  const hidden = (): boolean => typeof document !== "undefined" && document.hidden === true;

  const clearTimer = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };

  const detach = (r: SR): void => {
    r.onstart = r.onaudiostart = r.onresult = r.onerror = r.onend = null;
  };

  const killRec = (): void => {
    const r = rec;
    rec = null;
    if (!r) return;
    detach(r);
    try { r.abort(); } catch { /* already stopped */ }
  };

  const emit = (r: VoiceResult): void => {
    for (const fn of Array.from(resultSubs)) {
      try { fn(r); } catch { /* subscriber bug */ }
    }
  };

  const onResult = (e: SREvent): void => {
    if (rec === null) return;
    gotResult = true;
    everStarted = true;
    failures = 0;
    networkErrors = 0;
    if (state !== "listening") setState("listening");
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (!res || res.length === 0) continue;
      const best = res[0];
      const text = (best.transcript || "").trim();
      if (text === "") continue;
      let alts: string[] | undefined;
      for (let k = 1; k < res.length; k++) {
        const t = (res[k].transcript || "").trim();
        if (t !== "" && t !== text) (alts ??= []).push(t);
      }
      const out: VoiceResult = { transcript: text, final: res.isFinal, confidence: res.isFinal ? best.confidence || 0 : 0 };
      if (alts) out.alternatives = alts;
      emit(out);
    }
  };

  const scheduleRestart = (): void => {
    clearTimer();
    if (!wantOn || disposed || hidden()) return;
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * Math.pow(2, failures));
    timer = setTimeout(() => { timer = null; begin(); }, delay);
  };

  const onEnd = (): void => {
    if (rec === null) return;
    const young = Date.now() - startedAt < QUICK_END_MS;
    rec = null;
    if (!gotResult && young) failures = Math.min(failures + 1, 4);
    if (fatal || !wantOn || disposed) return;
    if (state === "listening") setState("starting");
    scheduleRestart();
  };

  const onError = (e: SRErrorEvent): void => {
    const err = e && e.error ? e.error : "";
    switch (err) {
      case "not-allowed":
      case "service-not-allowed":
        fatal = true;
        wantOn = false;
        // A refusal after recognition already worked comes from a restart outside a user gesture
        // (iOS Safari, Chrome in AR): not a denial, a tap resumes. Only a first-time refusal is "denied".
        setState(everStarted ? "off" : "denied");
        break;
      case "audio-capture": // no mic, or the XR/camera session owns it
        fatal = true;
        wantOn = false;
        setState("off");
        break;
      case "language-not-supported":
        if (!langRetried) { langRetried = true; lang = "en-US"; } else { fatal = true; wantOn = false; setState("off"); }
        break;
      case "network":
        failures = Math.min(failures + 1, 4);
        if (++networkErrors >= MAX_NETWORK_ERRORS) { fatal = true; wantOn = false; setState("off"); }
        break;
      default: // "no-speech", "aborted", unknown: `end` follows and restarts
        break;
    }
  };

  function begin(): void {
    if (!wantOn || disposed || hidden() || !Ctor) return;
    killRec();
    let r: SR;
    try {
      r = new Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 3;
      r.lang = lang;
    } catch {
      wantOn = false;
      setState("unsupported");
      return;
    }
    fatal = false;
    gotResult = false;
    startedAt = Date.now();
    r.onstart = r.onaudiostart = () => {
      if (rec !== r) return;
      everStarted = true;
      if (state !== "listening") setState("listening");
    };
    r.onresult = onResult;
    r.onerror = onError;
    r.onend = onEnd;
    rec = r;
    try {
      r.start();
    } catch {
      // InvalidStateError (already started) or a gesture/permission refusal thrown synchronously
      rec = null;
      failures = Math.min(failures + 1, 4);
      scheduleRestart();
    }
  }

  const onVisibility = (): void => {
    if (disposed || !wantOn) return;
    if (hidden()) {
      clearTimer();
      killRec();
      setState("off");
    } else {
      failures = 0;
      setState("starting");
      begin();
    }
  };
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", onVisibility);
  }

  api.start = () => {
    if (disposed) return;
    if (wantOn && (state === "starting" || state === "listening")) return; // idempotent
    wantOn = true;
    failures = 0;
    networkErrors = 0;
    langRetried = false;
    clearTimer();
    setState("starting");
    begin(); // synchronous: keeps the user gesture
  };

  api.stop = () => {
    wantOn = false;
    clearTimer();
    killRec();
    if (!disposed && state !== "denied") setState("off");
  };

  const baseDispose = api.dispose;
  api.dispose = () => {
    wantOn = false;
    clearTimer();
    killRec();
    if (typeof document !== "undefined" && document.removeEventListener) {
      document.removeEventListener("visibilitychange", onVisibility);
    }
    baseDispose();
  };

  return api;
}
