import type { DogCommand } from "../dog/types";
import type { VoiceIntent } from "./types";

/*
 * Pure transcript -> dog command parser (no DOM, runs in plain node).
 *
 * Decisions:
 *  - Several commands in one utterance: the LAST one wins ("come here and sit" -> sit, "sit sit sit" -> sit),
 *    because it is the latest intent. Longer phrases win over their parts ("sit down" is sit, not lie).
 *  - "stay / wait / stop / hold / freeze" have no DogCommand of their own. They map to "sit": the brain's
 *    sit switches to stay mode (cancels come/follow/free/goTo) and holds the spot with a posture, which is what
 *    these words mean to a dog owner. ("stand" would not cancel follow/free.)
 *  - False-positive guard: an utterance that does not address the dog by name must be short (<= 7 words after
 *    filler removal, <= 3 for ambiguous single words like "up"/"here"/"play") and free of narrative words
 *    ("I", "the", "was", "yesterday"...). When the name is said the limits relax (but "I/we/he/she/they/was" still veto).
 *  - Known mishearings are only listed when plausible and rare in chatter ("role over", "rolled over"); bare
 *    "set"/"sat" count only when they are the whole utterance.
 */

interface Entry {
  command: DogCommand;
  words: string[];
  /** Ambiguous in chatter: only accepted in very short utterances (or when addressed). */
  weak?: boolean;
  /** Only accepted when it is the entire (filler-stripped) utterance. */
  solo?: boolean;
}

const SPEC: Array<[DogCommand, string[], ("weak" | "solo" | "")?]> = [
  ["sit", ["sit"]],
  ["sit", ["sit down"]],
  ["sit", ["sit up"]],
  ["sit", ["take a seat"]],
  ["sit", ["have a seat"]],
  ["sit", ["set", "sat", "sit sit"], "solo"],
  ["sit", ["stay", "wait", "hold", "freeze"], "weak"],
  ["sit", ["stop"], "weak"],
  ["sit", ["stay there", "stay put", "stay here", "hold on", "hold still", "wait there", "wait here", "hold it"]],
  ["lie", ["lie down", "lay down", "go down", "get down", "lie", "lay", "settle", "settle down", "play dead", "lie there"]],
  ["lie", ["down", "drop"], "weak"],
  ["stand", ["stand", "up"], "weak"],
  ["stand", ["stand up", "get up", "on your feet"]],
  ["come", ["come", "come here", "come on", "come to me", "come over", "come back", "to me", "heel", "over here", "c mere"]],
  ["come", ["here"], "weak"],
  ["come", ["here kitty", "kitty kitty", "here kitty kitty", "puss puss", "pspsps", "psps", "pss pss"]],
  ["follow", ["follow", "follow me", "with me", "walk with me", "walk with us", "come with me", "stay with me", "keep up"]],
  ["free", ["go play", "go explore", "go on", "go away", "go roam", "roam", "run free", "off you go", "run along", "be free", "go wild", "explore", "go run"]],
  ["free", ["free", "play"], "weak"],
  ["rollOver", ["roll over", "role over", "rolled over", "rollover", "roll them over", "do a roll", "barrel roll", "do a barrel roll", "roll over roll over"]],
  ["rollOver", ["roll"], "weak"],
  ["jump", ["jump", "jump up", "up up", "hop", "leap", "jump jump", "do a jump", "jump for me", "jump up and down"]],
  ["spin", ["spin", "twirl", "turn around", "spin around", "do a spin", "twirl around", "spin spin", "do a twirl", "spin for me", "chase your tail"]],
  ["spin", ["circle", "turn"], "weak"],
  // Cat tricks (the play loop drops tricks the deployed species doesn't know).
  ["pounce", ["pounce", "pounce on it", "get it", "get the hand", "attack", "go get it", "catch it"]],
  ["stretch", ["stretch", "big stretch", "stretch out", "do a stretch", "have a stretch", "stretch it out"]],
  ["groom", ["groom", "groom yourself", "wash", "wash up", "wash yourself", "clean up", "clean yourself", "lick your paw"]],
];

const ENTRIES: Entry[] = (() => {
  const out: Entry[] = [];
  for (const [command, phrases, flag] of SPEC) {
    for (const p of phrases) {
      out.push({ command, words: p.split(" "), weak: flag === "weak", solo: flag === "solo" });
    }
  }
  // Longest phrase first so that "sit down" beats "sit"+"down".
  out.sort((a, b) => b.words.length - a.words.length);
  return out;
})();

const FILLER = new Set([
  "please", "now", "okay", "ok", "hey", "hi", "hello", "good", "boy", "girl", "dog", "doggy", "doggie", "puppy", "pup",
  "buddy", "pal", "kitty", "kitten", "cat", "puss", "pussycat", "can", "could", "would", "will", "just", "and", "then", "right", "alright", "uh", "um", "oh", "yeah",
  "ah", "again", "quickly", "go", "lets", "let", "s", "us", "me", "for",
]);
// "go", "me", "for", "to", "up" etc. also appear in phrases: filler is removed only after phrase matching (see below),
// so the set above is used for COUNTING words, never for deleting words before matching.

/** Words that make an utterance narrative rather than imperative. */
const VETO_ALWAYS = new Set([
  "i", "ive", "id", "we", "he", "she", "they", "was", "were", "had", "been", "yesterday", "didnt", "wasnt",
  // negations: "Biscuit, don't sit" must not sit, even when the dog is addressed
  "dont", "not", "no", "never", "cant", "cannot", "doesnt", "wont", "nope",
]);
const VETO_UNADDRESSED = new Set([
  "the", "my", "your", "his", "her", "their", "that", "this", "is", "are", "has", "have", "if", "because", "but", "what", "why",
  "how", "when", "where", "who", "today", "tomorrow", "scare", "scared", "scary", "rope", "market", "price", "prices", "it", "its",
  "im", "you're", "youre", "did", "does", "should", "gonna", "going",
]);

const MAX_WORDS = 7;
const MAX_WORDS_WEAK = 3;
const MAX_WORDS_ADDRESSED = 10;

function normalize(s: string): string[] {
  const t = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return t === "" ? [] : t.split(" ");
}

function nameTokens(dogName: string): string[] {
  return normalize(dogName).filter((w) => w.length >= 2);
}

/** Every word of every command phrase: these are never taken for a (truncated / plural) dog name. */
const COMMAND_WORDS = new Set(ENTRIES.flatMap((e) => e.words));

function isNameToken(tok: string, names: string[]): boolean {
  for (const n of names) {
    if (tok === n) return true;
    // tolerate "biscuits" / "biscuit's" / "bisc" style truncation and plural, for names >= 4 letters,
    // but not at the cost of a command ("Comet" must not swallow "come", "Stanley" not "stand")
    if (
      n.length >= 4 && tok.length >= 4 && tok.length <= n.length + 2 &&
      (tok.startsWith(n) || n.startsWith(tok)) && !COMMAND_WORDS.has(tok)
    ) return true;
  }
  return false;
}

export function parseVoiceCommand(transcript: string, dogName: string): VoiceIntent | null {
  if (!transcript) return null;
  const all = normalize(transcript);
  if (all.length === 0) return null;
  const names = nameTokens(dogName || "");

  let addressed = false;
  const toks: string[] = [];
  for (const w of all) {
    if (names.length > 0 && isNameToken(w, names)) addressed = true;
    else toks.push(w);
  }
  if (toks.length === 0) return null;

  for (const w of toks) {
    if (VETO_ALWAYS.has(w)) return null;
    if (!addressed && VETO_UNADDRESSED.has(w)) return null;
  }

  // Greedy left-to-right longest-phrase scan; remember the last accepted match.
  let best: Entry | null = null;
  let bestWords = "";
  let bestEnd = -1;
  let i = 0;
  while (i < toks.length) {
    let hit: Entry | null = null;
    for (const e of ENTRIES) {
      const n = e.words.length;
      if (i + n > toks.length) continue;
      let ok = true;
      for (let k = 0; k < n; k++) {
        if (toks[i + k] !== e.words[k]) { ok = false; break; }
      }
      if (ok) { hit = e; break; }
    }
    if (hit) {
      const n = hit.words.length;
      // gates (computed on filler-free word count)
      if (acceptable(hit, toks, addressed)) {
        best = hit;
        bestWords = toks.slice(i, i + n).join(" ");
        bestEnd = i + n;
        }
      i += n;
    } else i++;
  }
  if (!best || bestEnd < 0) return null;
  const intent: VoiceIntent = { command: best.command, phrase: bestWords, addressed };
  if (bestEnd === toks.length && mayExtend(best, toks.slice(bestEnd - best.words.length, bestEnd))) intent.mayExtend = true;
  return intent;
}

/** The matched words end the transcript and begin a longer phrase of ANOTHER command ("stay" -> "stay with me"). */
function mayExtend(e: Entry, words: string[]): boolean {
  return ENTRIES.some(
    (o) => o.command !== e.command && o.words.length > words.length && words.every((w, k) => o.words[k] === w),
  );
}

function acceptable(e: Entry, toks: string[], addressed: boolean): boolean {
  let content = 0;
  for (const w of toks) if (!FILLER.has(w)) content++;
  if (e.solo) return content === e.words.length && toks.every((w) => e.words.indexOf(w) >= 0 || FILLER.has(w));
  if (addressed) return content <= MAX_WORDS_ADDRESSED;
  return content <= (e.weak ? MAX_WORDS_WEAK : MAX_WORDS);
}

export const VOICE_HELP = "Say: sit · lie down · come · roll over · jump · spin · follow me · go play";

/** Example phrases for UI hints, one primary phrase per command. */
export function listCommandWords(): string[] {
  return ["sit", "lie down", "stand", "come", "follow me", "go play", "stay", "roll over", "jump", "spin"];
}
