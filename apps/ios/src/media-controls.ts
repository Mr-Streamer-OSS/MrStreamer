import {
  nextEpisode,
  playbackClock,
  playbackLength,
  playbackSpeed,
  playbackState,
  player,
  seekBy,
  seekTo,
  togglePause,
} from "./playback.ts";

// The system's Now Playing and remote commands (modules/media-controls): the lock screen, Control
// Center, headphones and a car. They show what the app's one player plays while the viewer watches
// it, in Watch, Picture in Picture or on AirPlay, or set Watch aside for Downloads or Settings;
// never Home's silent preview, and nothing once it stopped or failed. A title shows its name, its
// line ("S1 E2 · Name"), its length and where it is, at the rate the player says it plays at; a
// channel shows that it is live. Nothing else of it, no address, provider or artwork, goes there.
//
// Each command does what Watch's own button does, through the same playback calls, so it keeps
// the viewer's Pause, the countdown and every request as Watch would: play and pause; 10 seconds
// back and forward and moving to a position, for a title or a programme from catch-up; and next,
// for an episode with one after it. A channel takes only play and pause.

interface NowPlaying {
  readonly title: string;
  readonly subtitle: string;
  readonly live: boolean;
  /** Seconds; null while not known, and for a channel. */
  readonly duration: number | null;
  /** Seconds from the start, from which iOS counts on at `rate`. */
  readonly elapsed: number;
  /** 0 unless it plays. */
  readonly rate: number;
  /** The rate it plays at once it plays. */
  readonly speed: number;
  readonly seekable: boolean;
  readonly next: boolean;
}

type Command =
  | { readonly command: "play" | "pause" | "toggle" | "next" }
  | { readonly command: "skip"; readonly seconds: number }
  | { readonly command: "seek"; readonly position: number };

interface Native {
  set(info: NowPlaying): void;
  clear(): void;
  addListener(event: "command", listener: (command: Command) => void): { remove(): void };
}

/**
 * The native module, found where Expo installs every module before the app's JavaScript runs;
 * null in a build without it, and in tests that don't provide one.
 */
function native(): Native | null {
  const host: { expo?: { modules?: { MediaControls?: Native } } } = globalThis;
  return host.expo?.modules?.MediaControls ?? null;
}

/** What the system shows now, or null for nothing. */
function nowPlaying(): NowPlaying | null {
  const { phase, watch, pip, external, aside } = playbackState.get();
  if (phase.kind === "idle" || phase.kind === "failed") return null;
  if (!watch && !pip && !external && !aside) return null;
  const { item } = phase;
  const speed = playbackSpeed.get() ?? 1;
  const length = playbackLength.get();
  return {
    title: item.title,
    subtitle: item.place,
    live: item.live,
    duration: item.live || length <= 0 ? null : length,
    elapsed: item.live ? 0 : playbackClock.get(),
    rate: phase.kind === "playing" ? speed : 0,
    speed,
    seekable: !item.live,
    next: item.next,
  };
}

/** How far the shown position may drift from where the player is before it is shown again. */
const DRIFT_S = 1.5;

/** What was shown last and when, to count its position on as iOS does. */
let shown: { readonly info: NowPlaying; readonly at: number } | null = null;

/** Whether `next` says anything `before` doesn't, apart from a position iOS counts on to. */
function changed(before: { readonly info: NowPlaying; readonly at: number }, next: NowPlaying) {
  const rest = (info: NowPlaying) => JSON.stringify({ ...info, elapsed: 0 });
  if (rest(before.info) !== rest(next)) return true;
  const counted = before.info.elapsed + ((Date.now() - before.at) / 1000) * before.info.rate;
  return Math.abs(next.elapsed - counted) > DRIFT_S;
}

function publish(module: Native) {
  const info = nowPlaying();
  if (!info) {
    if (!shown) return;
    shown = null;
    module.clear();
    player().ownsNowPlaying = false;
    return;
  }
  if (shown && !changed(shown, info)) return;
  if (!shown) player().ownsNowPlaying = true;
  shown = { info, at: Date.now() };
  module.set(info);
}

/** Does what Watch's button for `command` does, while something shows. */
function answer(command: Command) {
  const info = nowPlaying();
  if (!info) return;
  const { kind } = playbackState.get().phase;
  switch (command.command) {
    case "play":
      if (kind === "paused") togglePause();
      return;
    case "pause":
      if (kind !== "paused") togglePause();
      return;
    case "toggle":
      return togglePause();
    case "skip":
      if (info.seekable) seekBy(command.seconds);
      return;
    case "seek":
      if (info.seekable) seekTo(command.position);
      return;
    case "next":
      if (info.next) nextEpisode();
  }
}

/**
 * Shows what plays in the system's Now Playing and answers its commands, until the returned
 * function ends both. Watch starts it once, for the app's life.
 */
export function startMediaControls(): () => void {
  const module = native();
  if (!module) return () => {};
  const update = () => publish(module);
  const stops = [playbackState, playbackClock, playbackLength, playbackSpeed].map((store) =>
    store.subscribe(update),
  );
  const listening = module.addListener("command", answer);
  update();
  return () => {
    for (const stop of stops) stop();
    listening.remove();
    if (shown) {
      shown = null;
      module.clear();
      player().ownsNowPlaying = false;
    }
  };
}
