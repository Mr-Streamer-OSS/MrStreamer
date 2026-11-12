// How local playback sounds: delayed behind the picture, and leveled, the same for every engine
// and route (direct, converted, a title or a download), as every one of them plays in a media
// element. The engines attach the element they play in and detach it when they stop. With the
// stream's own sound nothing here runs: Chromium plays the element as it always has. The first
// delay or leveling routes attached elements through Web Audio, and an element stays routed for
// as long as the window lives, since Chromium can route an element only once. With adjustments
// back at their defaults that route retains the AudioContext output latency.
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
 * after it reduces peaks. Each looks ahead a few milliseconds, which is the latency
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
  flush(): void;
}

/**
 * Builds the processing between `input` and the returned output in `context`: the one chain both
 * the window's playback and the offline measurements of it use. Channels pass through the delay as
 * they come; leveling processes each output channel independently.
 *
 * @public `scripts/picture-sound.ts` of the verification skill bundles this module to measure it.
 */
export function soundChain(context: BaseAudioContext, input: AudioNode): SoundChain {
  const output = context.createGain();
  output.channelCountMode = "max";
  let current: SoundAdjustments = soundOf(DEFAULT_PLAYBACK_ADJUSTMENTS);
  let disconnect = () => {};
  let delay: DelayNode;

  const rebuild = () => {
    disconnect();
    delay = context.createDelay(SOUND_DELAY_MAX_MS / 1000 + 0.1);
    delay.channelCountMode = "max";
    delay.delayTime.value = current.soundDelayMs / 1000;
    input.connect(delay);
    const nodes: AudioNode[] = [delay];

    if (current.leveling) {
      // One mono processor per device channel avoids the compressor's stereo downmix.
      const count = context.destination.channelCount;
      const split = context.createChannelSplitter(count);
      const merge = context.createChannelMerger(count);
      // Apply the device's ordinary speaker mix before splitting. A stereo device must still
      // hear a surround source's centre/dialogue channel, rather than dropping extra channels.
      const deviceMix = context.createGain();
      deviceMix.channelCount = count;
      deviceMix.channelCountMode = "explicit";
      deviceMix.channelInterpretation = "speakers";
      delay.connect(deviceMix);
      deviceMix.connect(split);
      nodes.push(deviceMix, split, merge);

      for (let channel = 0; channel < count; channel++) {
        const leveler = new DynamicsCompressorNode(context, { ...LEVELER, channelCount: 1 });
        const limiter = new DynamicsCompressorNode(context, { ...LIMITER, channelCount: 1 });
        split.connect(leveler, channel);
        leveler.connect(limiter);
        limiter.connect(merge, 0, channel);
        nodes.push(leveler, limiter);
      }

      merge.connect(output);
    } else delay.connect(output);
    disconnect = () => {
      input.disconnect(delay);

      for (const node of nodes) node.disconnect();
    };
  };

  rebuild();

  return {
    output,
    set(adjustments) {
      const changed = current.leveling !== adjustments.leveling;
      current = adjustments;

      if (changed) rebuild();
      else
        delay.delayTime.setTargetAtTime(
          current.soundDelayMs / 1000,
          context.currentTime,
          DELAY_GLIDE_S,
        );
    },
    flush: rebuild,
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
async function route(element: HTMLMediaElement): Promise<void> {
  context ??= new AudioContext({ latencyHint: "interactive" });
  const speakers = context.destination;
  // Keep every channel the device takes, as Chromium does without Web Audio.
  speakers.channelCount = speakers.maxChannelCount;
  let chain = routes.get(element);

  if (!chain) {
    chain = soundChain(context, context.createMediaElementSource(element));
    routes.set(element, chain);
    const owned = chain;

    const reset = () => {
      owned.flush();
      owned.output.disconnect();
    };

    for (const event of ["pause", "seeking", "emptied", "loadstart"])
      element.addEventListener(event, reset);

    const reconnect = () => {
      if (!attached.has(element)) return;
      owned.output.disconnect();
      owned.output.connect(speakers);
      void context!
        .resume()
        .catch((cause: unknown) =>
          window.dispatchEvent(new CustomEvent("sounderror", { detail: cause })),
        );
    };

    element.addEventListener("playing", reconnect);
    element.addEventListener("seeked", () => {
      if (!element.paused) reconnect();
    });
  }

  chain.set(current);
  chain.output.disconnect();
  chain.output.connect(speakers);
  // A window may have opened its context before any playback; sound needs it running.
  await context.resume();
}

/**
 * An engine plays in `element` from now on, and it sounds as the adjustments say. Returns the
 * function the engine calls once it stopped; a routed element nobody holds is let go, so it can be
 * freed.
 */
export function attachSound(element: HTMLMediaElement): () => void {
  attached.set(element, (attached.get(element) ?? 0) + 1);

  if (routes.has(element) || isAdjusted(current))
    void route(element).catch((cause: unknown) =>
      window.dispatchEvent(new CustomEvent("sounderror", { detail: cause })),
    );
  let held = true;

  return () => {
    if (!held) return;
    held = false;
    const holders = (attached.get(element) ?? 1) - 1;

    if (holders > 0) return void attached.set(element, holders);
    attached.delete(element);
    routes.get(element)?.flush();
    routes.get(element)?.output.disconnect();
  };
}

/** Applies `adjustments` to every attached element at once. */
export async function setSound(adjustments: SoundAdjustments): Promise<void> {
  if (
    current.soundDelayMs === adjustments.soundDelayMs &&
    current.leveling === adjustments.leveling &&
    context?.state !== "suspended"
  )
    return;
  current = soundOf(adjustments);

  for (const element of attached.keys()) {
    if (routes.has(element) || isAdjusted(current)) await route(element);
  }
}

/** Discards buffered sound before an engine switches its audio track. */
export function flushSound(element: HTMLMediaElement): void {
  routes.get(element)?.flush();
}
