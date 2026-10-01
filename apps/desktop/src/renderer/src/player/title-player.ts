// The controller for movies and episodes: which title is open, where it is, its tracks, and
// what the viewer does with it. It plays in the same element as live TV (see player.ts): opening a
// title stops the live stream, and starting a live channel closes the title, so the provider sees
// one connection.
//
// How far the title got is saved as the viewer goes: every minute while playing, and at each
// pause, seek, track change, the end, leaving and hiding the window. Never per frame.
import { createStore, useStore } from "zustand";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { AudioTrack, StreamFailure, SubtitleTrack } from "@mrstreamer/contracts/playback";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import { DEFAULT_TITLE_LANGUAGE } from "@mrstreamer/core/ondemand/languages";
import { chooseTracks } from "@mrstreamer/core/ondemand/tracks";
import { appError } from "../lib/errors.ts";
import { call } from "../lib/ipc.ts";
import { titleDecoders } from "./decoders.ts";
import type { EngineError } from "./engine.ts";
import { onLiveStart, player, type PlaybackProblem } from "./player.ts";
import { titleEngine, type TitleEngine } from "./title-engine.ts";

/** How often progress is saved while a title plays. */
const CHECKPOINT_MS = 60_000;
/** A pause this long ends the run, so the provider's connection isn't held for nothing. */
const RELEASE_AFTER_PAUSE_MS = 5 * 60_000;
/** Waits before each new run after the connection broke. Its length is the attempt limit. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];

/** What the view shows about the open title. */
export interface NowPlaying {
  readonly title: TitleRef;
  /** "Escape from New York", or the series' name. */
  readonly name: string;
  /** For episodes: "S2 E3 · Aankomst in Tbilisi". */
  readonly detail: string | null;
  readonly artworkUrl: string | null;
}

type TitlePhase =
  | { readonly kind: "idle" }
  /** Reading which tracks the file holds. */
  | { readonly kind: "opening" }
  /** A run is starting, as after a seek or a track change. */
  | { readonly kind: "starting" }
  | { readonly kind: "playing" }
  | { readonly kind: "paused" }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly of: number }
  | { readonly kind: "ended" }
  | { readonly kind: "failed"; readonly problem: PlaybackProblem };

export interface TitlePlayerState {
  readonly now: NowPlaying | null;
  readonly phase: TitlePhase;
  /** Seconds into the title, as of the element's last time update. */
  readonly position: number;
  readonly duration: number | null;
  readonly audio: readonly AudioTrack[];
  readonly subtitles: readonly SubtitleTrack[];
  readonly audioId: number | null;
  /** The subtitle track on screen, or null for none. */
  readonly subtitleId: number | null;
}

const idle: TitlePlayerState = {
  now: null,
  phase: { kind: "idle" },
  position: 0,
  duration: null,
  audio: [],
  subtitles: [],
  audioId: null,
  subtitleId: null,
};

const store = createStore<TitlePlayerState>(() => idle);

/** Reads the title player's state in a component. */
export function useTitlePlayer<T>(selector: (state: TitlePlayerState) => T): T {
  return useStore(store, selector);
}

const video = player.element;
/** The open session: its id and the address runs play from. */
let session: { readonly id: string; readonly url: string } | null = null;
let engine: TitleEngine | null = null;
/** Voids the runs of an earlier open or run, like the live player's selection. */
let generation = 0;
/** The sound was converted after a copy failed to start; later runs keep converting. */
let convertSound = false;
let checkpoint: ReturnType<typeof setInterval> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
/** Where a run stopped for a long pause resumes from. */
let released: number | null = null;

video.addEventListener("timeupdate", () => {
  if (engine) store.setState({ position: engine.position() });
});
video.addEventListener("pause", () => {
  if (!engine || store.getState().phase.kind !== "playing") return;
  store.setState({ phase: { kind: "paused" } });
  save();
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(releaseRun, RELEASE_AFTER_PAUSE_MS);
});
video.addEventListener("play", () => {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  if (engine && store.getState().phase.kind === "paused") {
    store.setState({ phase: { kind: "playing" } });
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") save();
});
window.addEventListener("beforeunload", () => save());
// Starting a live channel closes the title.
onLiveStart(() => {
  if (store.getState().now) titlePlayer.close();
});

/** Saves how far the title got, when there is a title and a length to measure it against. */
function save(): void {
  const { now, position, duration } = store.getState();
  if (!now || !duration || position <= 0) return;
  void call("viewing.recordProgress", {
    commandId: crypto.randomUUID(),
    title: now.title,
    position: Math.min(position, duration),
    duration,
  }).catch(() => {});
}

function stopEngine(): void {
  engine?.destroy();
  engine = null;
  if (checkpoint) clearInterval(checkpoint);
  checkpoint = null;
}

/** Ends the run after a long pause; playing again starts one where it stopped. */
function releaseRun(): void {
  // Not at the end: the element pauses just before it ends, and the end screen stays.
  if (!engine || !video.paused || store.getState().phase.kind !== "paused") return;
  released = engine.position();
  stopEngine();
  store.setState({ phase: { kind: "paused" }, position: released });
}

/** Starts a run at `start` with the chosen tracks. `attempt` counts reconnects. */
async function run(start: number, attempt = 0): Promise<void> {
  if (!session) return;
  const mine = ++generation;
  stopEngine();
  released = null;
  const { audioId, subtitleId, duration } = store.getState();
  store.setState({
    phase:
      attempt === 0
        ? { kind: "starting" }
        : { kind: "reconnecting", attempt, of: RECONNECT_DELAYS_MS.length },
    position: start,
  });
  const started = titleEngine(video, {
    url: session.url,
    start,
    audio: audioId,
    subtitle: subtitleId,
    convertSound,
    duration,
  });
  engine = started;
  try {
    await started.started;
  } catch (error) {
    if (mine !== generation) return;
    await recover(mine, start, asEngineError(error), attempt, false);
    return;
  }
  if (mine !== generation) return;
  store.setState({ phase: { kind: video.paused ? "paused" : "playing" } });
  checkpoint = setInterval(save, CHECKPOINT_MS);
  started.onEnded(() => {
    if (mine !== generation) return;
    const { duration: length } = store.getState();
    store.setState({ phase: { kind: "ended" }, position: length ?? started.position() });
    save();
  });
  started.onFailure((error) => {
    if (mine === generation) void recover(mine, started.position(), error, 0, true);
  });
}

/**
 * What to do about a run that failed: convert the sound once when a copied one didn't start,
 * start again where it was after the connection broke, or give up and say why.
 */
async function recover(
  mine: number,
  position: number,
  error: EngineError,
  attempt: number,
  wasPlaying: boolean,
): Promise<void> {
  const upstream = session
    ? await call("playback.failure", { sessionId: session.id }).catch(() => null)
    : null;
  if (mine !== generation) return;
  stopEngine();
  if (!upstream && !wasPlaying && !convertSound && error.kind !== "network") {
    convertSound = true;
    await run(position, attempt);
    return;
  }
  const problem = problemOf(upstream, error);
  const delay = RECONNECT_DELAYS_MS[attempt];
  if (problem.kind !== "network" || delay === undefined) {
    store.setState({ phase: { kind: "failed", problem } });
    return;
  }
  store.setState({
    phase: { kind: "reconnecting", attempt: attempt + 1, of: RECONNECT_DELAYS_MS.length },
  });
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (mine === generation) await run(position, attempt + 1);
}

function problemOf(upstream: StreamFailure | null, error: EngineError): PlaybackProblem {
  switch (upstream?.kind) {
    case "unavailable":
      return { kind: "unavailable" };
    case "refused":
      return { kind: "refused" };
    case "provider-error":
      return { kind: "provider-error", status: upstream.status };
    case "network":
      return { kind: "network", detail: upstream.detail };
    case "unsupported":
      return { kind: "unsupported", detail: upstream.detail };
    case undefined:
      return error.kind === "network"
        ? { kind: "network", detail: error.detail }
        : { kind: "unsupported", detail: error.detail };
  }
}

function asEngineError(error: unknown): EngineError {
  return typeof error === "object" && error !== null && "kind" in error && "detail" in error
    ? (error as EngineError)
    : { kind: "media", detail: String(error) };
}

export const titlePlayer = {
  /**
   * Opens a title and plays it from `from` seconds: the resume position, or 0 to start at the
   * beginning. Closes whatever played before, live or on demand.
   */
  async open(now: NowPlaying, from: number): Promise<void> {
    titlePlayer.close();
    player.suspend();
    const mine = ++generation;
    convertSound = false;
    store.setState({ ...idle, now, phase: { kind: "opening" }, position: from });
    try {
      // The languages chosen last, fresh: a choice in the title before counts.
      const [opened, preferences] = await Promise.all([
        call("playback.openTitle", { title: now.title, decoders: [...titleDecoders] }),
        call("preferences.get").catch((): Preferences | null => null),
      ]);
      if (mine !== generation) {
        void call("playback.close", { sessionId: opened.sessionId }).catch(() => {});
        return;
      }
      session = { id: opened.sessionId, url: opened.url };
      const chosen = chooseTracks(opened.audio, opened.subtitles, {
        // The sound picked last, else the movies and series language, English to begin with.
        audioLanguage:
          preferences?.audioLanguage ?? preferences?.titleLanguage ?? DEFAULT_TITLE_LANGUAGE,
        subtitleLanguage: preferences?.subtitleLanguage ?? null,
      });
      store.setState({
        duration: opened.duration,
        audio: opened.audio,
        subtitles: opened.subtitles,
        audioId: chosen.audio,
        subtitleId: chosen.subtitle,
      });
    } catch (cause) {
      if (mine !== generation) return;
      const error = appError(cause);
      store.setState({
        phase: {
          kind: "failed",
          problem:
            error.kind === "stream"
              ? problemOf(error.failure, { kind: "network", detail: "" })
              : { kind: "app", error },
        },
      });
      return;
    }
    await run(from);
  },

  /** Moves to `position`: at once within what is buffered, otherwise with a new run. */
  seek(position: number): void {
    const { duration, phase } = store.getState();
    if (!session || phase.kind === "opening") return;
    const target = Math.max(0, Math.min(position, (duration ?? Infinity) - 1));
    save();
    if (engine?.seekWithin(target)) {
      store.setState({ position: target });
      // The end left the element paused: playing again starts it.
      if (phase.kind === "ended") {
        store.setState({ phase: { kind: "playing" } });
        void video.play().catch(() => {});
      }
      return;
    }
    void run(target);
  },

  /** Skips back or forward by `seconds`. */
  skip(seconds: number): void {
    titlePlayer.seek(store.getState().position + seconds);
  },

  togglePause(): void {
    const { phase } = store.getState();
    if (phase.kind === "ended") {
      titlePlayer.seek(0);
    } else if (!engine && released !== null) {
      void run(released);
    } else if (!engine && phase.kind === "failed") {
      titlePlayer.retry();
    } else if (video.paused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  },

  /**
   * Tries a failed title again from where it was: a new run, or opening it again when the first
   * open failed and left no session.
   */
  retry(): void {
    const { now, phase, position } = store.getState();
    if (!now || phase.kind !== "failed") return;
    if (session) void run(position);
    else void titlePlayer.open(now, position);
  },

  /** Plays another sound track from where the title is, and remembers its language. */
  setAudio(id: number): void {
    const { audio, position } = store.getState();
    const track = audio.find((each) => each.id === id);
    if (!track || !session) return;
    store.setState({ audioId: id });
    if (track.language) {
      void call("preferences.update", { audioLanguage: track.language }).catch(() => {});
    }
    save();
    void run(position);
  },

  /** Shows another subtitle track, or none, and remembers the choice. */
  setSubtitle(id: number | null): void {
    const { subtitles, position } = store.getState();
    const track = id === null ? null : subtitles.find((each) => each.id === id && each.text);
    if ((id !== null && !track) || !session) return;
    store.setState({ subtitleId: track?.id ?? null });
    void call("preferences.update", {
      subtitleLanguage: track ? (track.language ?? null) : "off",
    }).catch(() => {});
    // Turning subtitles off is instant; showing others needs their cues from a new run.
    if (!track) {
      for (const each of video.textTracks) if (each.label === "Subtitles") each.mode = "disabled";
      return;
    }
    save();
    void run(position);
  },

  /** Saves how far the title got, then closes it and its provider connection. */
  close(): void {
    const { now, phase } = store.getState();
    if (!now) return;
    save();
    generation++;
    // Still reading the file, before its session is known: stop that too, so no request to the
    // provider outlives the title.
    if (phase.kind === "opening") void call("playback.closeAll").catch(() => {});
    stopEngine();
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = null;
    released = null;
    if (session) void call("playback.close", { sessionId: session.id }).catch(() => {});
    session = null;
    store.setState(idle);
  },
};
