import type { DogCommand } from "../dog/types";

/*
 * Voice commands. Contract (modules implemented in this folder):
 *
 *   src/voice/commands.ts   export function parseVoiceCommand(transcript: string, dogName: string): VoiceIntent | null
 *                           (pure; unit-testable in plain node)
 *   src/voice/listener.ts   export function createVoiceListener(): VoiceListener
 *                           (Web Speech API; SpeechRecognition / webkitSpeechRecognition)
 */

/** What a phrase means. `command` is what the brain should run; `addressed` = the dog's name was said. */
export interface VoiceIntent {
  command: DogCommand;
  /** The words that matched (lower-case, for the status chip), e.g. "roll over". */
  phrase: string;
  /** The dog's own name was in the utterance ("Biscuit, sit"). */
  addressed: boolean;
  /** Set when the phrase ends the transcript and could still grow into a different command ("play" -> "play dead"): an interim result with this flag should wait for more words. */
  mayExtend?: boolean;
}

export type VoiceState =
  | "off" // not listening (user hasn't enabled it, or stopped)
  | "starting" // waiting for the browser / mic permission
  | "listening"
  | "denied" // mic permission refused
  | "unsupported"; // no SpeechRecognition in this browser

export interface VoiceResult {
  transcript: string;
  /** true when the recogniser finalised this utterance; false for interim (still being said). */
  final: boolean;
  /** 0..1, 0 when the engine gives none. */
  confidence: number;
  /** Other hypotheses from the recogniser (best first, excluding `transcript`); absent when none. Handy for matching mis-hearings. */
  alternatives?: string[];
}

export interface VoiceListener {
  readonly supported: boolean;
  readonly state: VoiceState;
  /** Must be called from a user gesture the first time (mic permission prompt; iOS Safari requirement). Idempotent. */
  start(): void;
  /** Stops and does not restart. */
  stop(): void;
  /** Heard speech (interim and final). Returns an unsubscribe. */
  onResult(fn: (r: VoiceResult) => void): () => void;
  /** Fires on every state change. Returns an unsubscribe. */
  onState(fn: (s: VoiceState) => void): () => void;
  dispose(): void;
}
