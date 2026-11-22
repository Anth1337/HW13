import { noiseBuffer } from "./engine";

/**
 * One sound's nodes: a recorded clip (vocals.ts), a synthesized recipe (synth.ts), or several of
 * either scheduled together (e.g. a whine then a bark). When the last source has ended, the output
 * disconnects and `onDone` runs (the caller's voice count). Everything else is garbage collected.
 */
export class Shot {
  readonly out: GainNode;
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private ended = 0;
  private done = false;

  constructor(
    readonly ac: BaseAudioContext,
    dest: AudioNode,
    vol: number,
    private readonly onDone: () => void,
  ) {
    this.out = ac.createGain();
    this.out.gain.value = vol;
    this.out.connect(dest);
  }

  /** Plays `buffer` once at `t` (sped up / slowed down by `rate`); returns when it ends. */
  clip(buffer: AudioBuffer, t: number, rate: number, gain: number): number {
    const src = this.ac.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = this.gain(gain);
    src.connect(g).connect(this.out);
    src.start(t);
    this.srcs.push(src);
    return t + buffer.duration / rate;
  }

  osc(type: OscillatorType, f: number, t: number): OscillatorNode {
    const o = this.ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.start(t);
    this.srcs.push(o);
    return o;
  }

  noise(t: number): AudioBufferSourceNode {
    const n = this.ac.createBufferSource();
    n.buffer = noiseBuffer(this.ac);
    n.loop = true;
    n.start(t, Math.random() * 1.8);
    this.srcs.push(n);
    return n;
  }

  filter(type: BiquadFilterType, f: number, q: number): BiquadFilterNode {
    const b = this.ac.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  gain(v: number): GainNode {
    const g = this.ac.createGain();
    g.gain.value = v;
    return g;
  }

  shaper(curve: Float32Array<ArrayBuffer>): WaveShaperNode {
    const w = this.ac.createWaveShaper();
    w.curve = curve;
    return w;
  }

  /**
   * Stops every source by `t` (the latest end of what was scheduled) and cleans up once all of
   * them have ended (a clip may end on its own before `t`).
   */
  end(t: number): number {
    if (!this.srcs.length) {
      this.finish();
      return t;
    }
    for (const s of this.srcs) {
      s.onended = () => {
        if (++this.ended >= this.srcs.length) this.finish();
      };
      s.stop(t);
    }
    return t;
  }

  /** Cut short (pet gone / session over / nothing to play). */
  kill(): void {
    for (const s of this.srcs) {
      try {
        s.stop();
      } catch {
        /* not started / already stopped */
      }
    }
    this.finish();
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    this.out.disconnect();
    this.onDone();
  }
}
