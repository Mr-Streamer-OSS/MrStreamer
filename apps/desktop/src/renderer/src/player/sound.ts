// How local playback sounds: delayed behind the picture, and leveled, the same for every engine
// and route (direct, converted, a title or a download), as every one of them plays in a media
// element. The engines attach the element they play in and detach it when they stop. With the
// stream's own sound nothing here runs: Chromium plays the element as it always has. The first
// delay or leveling routes attached elements through Web Audio, and an element stays routed for
// as long as the window lives, since Chromium can route an element only once. With adjustments
// back at their defaults that route passes the sound on unchanged.
//
// A receiver on the network plays what it is sent; nothing here reaches it.
import {
  DEFAULT_PLAYBACK_ADJUSTMENTS,
  SOUND_DELAY_MAX_MS,
  isAdjusted,
  type PlaybackAdjustments,
} from "@mrstreamer/contracts/preferences";

export type SoundAdjustments = Pick<PlaybackAdjustments, "soundDelayMs" | "leveling">;

/**
 * Leveling: a gentle compressor raises quiet passages through its own makeup gain, and a limiter
 * after it keeps peaks below full scale. Each looks ahead a few milliseconds, which is the latency
 * leveling adds to the sound.
 */
const LEVELER = { threshold: -30, knee: 20, ratio: 4, attack: 0.01, release: 0.3 } as const;
const LIMITER = { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.05 } as const;

/** A delay change glides over this many seconds, rather than clicking. */
const DELAY_GLIDE_S = 0.02;

/** One element's (or one measurement's) processing, from its input to its output. */
interface SoundChain {
  readonly output: AudioNode;
  set(adjustments: SoundAdjustments): void;
}

/**
 * Builds the processing between `input` and the returned output in `context`: the one chain both
 * the window's playback and the offline measurements of it use. Channels pass through the delay as
 * they come; leveling, like Chromium's compressor, mixes them to stereo.
 *
 * @public `scripts/picture-sound.ts` of the verification skill bundles this module to measure it.
 */
export function soundChain(context: BaseAudioContext, input: AudioNode): SoundChain {
  const delay = context.createDelay(SOUND_DELAY_MAX_MS / 1000 + 0.1);
  delay.channelCountMode = "max";
  const leveler = new DynamicsCompressorNode(context, LEVELER);
  const limiter = new DynamicsCompressorNode(context, LIMITER);
  const output = context.createGain();
  output.channelCountMode = "max";
  input.connect(delay);
  leveler.connect(limiter);
  limiter.connect(output);
  let leveled: boolean | null = null;

  return {
    output,
    set({ soundDelayMs, leveling }) {
      delay.delayTime.setTargetAtTime(soundDelayMs / 1000, context.currentTime, DELAY_GLIDE_S);

      if (leveled === leveling) return;
      leveled = leveling;
      delay.disconnect();
      delay.connect(leveling ? leveler : output);
    },
  };
}

/** Only the sound part, so `isAdjusted` asks about the sound alone. */
const soundOf = ({ soundDelayMs, leveling }: SoundAdjustments): SoundAdjustments => ({
  soundDelayMs,
  leveling,
});

let current = soundOf(DEFAULT_PLAYBACK_ADJUSTMENTS);
let context: AudioContext | null = null;

/** Each element engines play in, with how many of them hold it: one may start before another stops. */
const attached = new Map<HTMLMediaElement, number>();
const routes = new WeakMap<HTMLMediaElement, SoundChain>();

/** Routes `element` through its chain, made the first time, and connects it to the speakers. */
function route(element: HTMLMediaElement): void {
  context ??= new AudioContext({ latencyHint: "interactive" });
  const speakers = context.destination;
  // Keep every channel the device takes, as Chromium does without Web Audio.
  speakers.channelCount = speakers.maxChannelCount;
  let chain = routes.get(element);

  if (!chain) {
    chain = soundChain(context, context.createMediaElementSource(element));
    routes.set(element, chain);
  }

  chain.set(current);
  chain.output.disconnect();
  chain.output.connect(speakers);
  // A window may have opened its context before any playback; sound needs it running.
  void context.resume().catch(() => {});
}

/**
 * An engine plays in `element` from now on, and it sounds as the adjustments say. Returns the
 * function the engine calls once it stopped; a routed element nobody holds is let go, so it can be
 * freed.
 */
export function attachSound(element: HTMLMediaElement): () => void {
  attached.set(element, (attached.get(element) ?? 0) + 1);

  if (routes.has(element) || isAdjusted(current)) route(element);
  let held = true;

  return () => {
    if (!held) return;
    held = false;
    const holders = (attached.get(element) ?? 1) - 1;

    if (holders > 0) return void attached.set(element, holders);
    attached.delete(element);
    routes.get(element)?.output.disconnect();
  };
}

/** Applies `adjustments` to every attached element at once. */
export function setSound(adjustments: SoundAdjustments): void {
  current = soundOf(adjustments);

  for (const element of attached.keys()) {
    if (routes.has(element) || isAdjusted(current)) route(element);
  }
}
