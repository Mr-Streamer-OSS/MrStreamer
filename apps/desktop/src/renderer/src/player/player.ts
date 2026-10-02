// The player controller: owns the one video element, the open stream session and the playback state.
//
// Every `play` call starts a new selection. Anything that resolves for an older selection is
// dropped, so a slow channel can never replace the one the viewer picked after it.
//
// The main process picks which of a channel's streams plays: the quality chosen for it, else
// Automatic, which may pass a stream that doesn't start. Once one plays, the controller asks which.
//
// A channel's sound and subtitle tracks come from its program table once the stream starts.
// Another sound track opens the stream again with it; subtitles are decoded here from the
// stream's private data, timed on the element's clock, and shown over the picture.
//
// The video element outlives every view: Home's backdrop, the guide's preview and Watch each show
// it in turn (see Picture.tsx), so moving between them never reopens the stream. Only Watch plays
// sound unless the viewer unmutes elsewhere; `audible` is that choice, `muted` the viewer's own.
import { createStore, useStore } from "zustand";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import {
  DEFAULT_SUBTITLE_LOOK,
  ORIGINAL_SOUND,
  type Preferences,
} from "@mrstreamer/contracts/preferences";
import type {
  ChannelTracks,
  LivePlaying,
  StreamFailure,
  StreamSession,
  SubtitleTrack,
} from "@mrstreamer/contracts/playback";
import { channelSubtitle } from "@mrstreamer/core/ondemand/tracks";
import { subtitleDecoder, type SubtitleDecoder } from "@mrstreamer/core/subtitles/decoder";
import { appError } from "../lib/errors.ts";
import { call } from "../lib/ipc.ts";
import { decoders } from "./decoders.ts";
import {
  createEngine,
  isEngineError,
  nativeEngine,
  type Engine,
  type EngineError,
  type EngineName,
  type StreamInfo,
} from "./engine.ts";
import {
  clearSubtitles,
  setSubtitleDelay,
  setSubtitleLook,
  subtitlePresenter,
} from "./subtitles.ts";

/** Waits before each reconnect attempt after a stream breaks. Its length is the attempt limit. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];
/**
 * How long zapping waits for the next key press before it opens a stream. Flicking through
 * channels shows each one at once but only tunes the one the viewer stops on, which matters on
 * subscriptions that allow a single connection.
 */
const ZAP_SETTLE_MS = 350;
const VOLUME_SAVE_DELAY_MS = 400;
/** Captions show up in the tracks only once the pictures carry them; asked again after this. */
const TRACKS_AGAIN_MS = 5000;

export type PlaybackProblem =
  /** The provider has no stream for the channel right now. */
  | { readonly kind: "unavailable" }
  /** The provider refused: another device on the connection, or the login stopped working. */
  | { readonly kind: "refused" }
  /** The stream uses a format or codec no engine here can play. */
  | { readonly kind: "unsupported"; readonly detail: string }
  /** Data stopped arriving and reconnecting did not help. */
  | { readonly kind: "network"; readonly detail: string }
  | { readonly kind: "provider-error"; readonly status: number }
  /** The session could not be opened at all. */
  | { readonly kind: "app"; readonly error: AppError };

type PlayerPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "tuning"; readonly since: number }
  | { readonly kind: "playing"; readonly engine: EngineName }
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly of: number }
  | { readonly kind: "failed"; readonly problem: PlaybackProblem };

export interface PlayerState {
  readonly channel: LiveChannel | null;
  readonly phase: PlayerPhase;
  /** The channel that played before the current one. Back returns to it, like a TV remote. */
  readonly previous: LiveChannel | null;
  readonly volume: number;
  readonly muted: boolean;
  /** Whether the view on screen plays sound: Watch does, previews only once unmuted. */
  readonly audible: boolean;
  /** The viewer pressed Stop, so previews don't start the stream again on their own. */
  readonly stopped: boolean;
  /** The channel's sound and subtitle tracks, once its stream started. */
  readonly tracks: ChannelTracks | null;
  /** The sound track chosen, by PID; null plays the channel's own choice. */
  readonly audioId: number | null;
  /** The subtitles on screen, or null for none. */
  readonly subtitle: SubtitleTrack | null;
  /** Which of the channel's streams plays, once it started, and those that failed first. */
  readonly stream: LivePlaying | null;
  /**
   * Automatic played another of the channel's streams because the first didn't start. Kept until
   * the channel changes or another quality is chosen.
   */
  readonly fellBack: { readonly from: string; readonly to: string } | null;
}

const store = createStore<PlayerState>(() => ({
  channel: null,
  phase: { kind: "idle" },
  previous: null,
  volume: 1,
  muted: false,
  audible: false,
  stopped: false,
  tracks: null,
  audioId: null,
  subtitle: null,
  stream: null,
  fellBack: null,
}));

/** Reads player state in a component. */
export function usePlayer<T>(selector: (state: PlayerState) => T): T {
  return useStore(store, selector);
}

const video = document.createElement("video");
video.playsInline = true;
video.className = "size-full";
let selection = 0;
/**
 * The current selection is a preview: a failure leaves it stopped instead of reconnecting, so a
 * connection another device holds is not fought over.
 */
let quiet = false;
let current: { readonly sessionId: string; readonly engine: Engine } | null = null;
let volumeSave: ReturnType<typeof setTimeout> | null = null;
let zapTimer: ReturnType<typeof setTimeout> | null = null;
/** The channel the last stream was opened for. It becomes `previous` when another channel tunes. */
let tuned: LiveChannel | null = null;
/** Decodes the chosen subtitles from the stream's private data and shows them. */
let shown: {
  readonly pid: number;
  readonly decoder: SubtitleDecoder;
  readonly presenter: ReturnType<typeof subtitlePresenter>;
} | null = null;
/** The subtitles chosen last on this channel, which C turns on again. */
let lastSubtitle: SubtitleTrack | null = null;

/**
 * Hears when the viewer starts a live channel, so a movie or episode playing in the same element
 * closes first. Previews don't count: they never replace what the viewer chose.
 */
let liveStarts: (() => void) | null = null;

export function onLiveStart(listener: () => void): void {
  liveStarts = listener;
}

function cancelZap(): void {
  if (zapTimer) clearTimeout(zapTimer);
  zapTimer = null;
}

/** Stops the engine and closes the provider connection of the current stream. */
function release(): void {
  if (!current) return;
  current.engine.destroy();
  void call("playback.close", { sessionId: current.sessionId }).catch(() => {});
  current = null;
}

/**
 * Opens and plays a stream. `repair` has the main process re-encode the picture, which conceals
 * a damaged broadcast the way standalone players do; it costs CPU, so it is the second try.
 */
async function start(
  channel: LiveChannel,
  attempt: number,
  repair = false,
  preview = false,
): Promise<void> {
  const mine = ++selection;
  // A stream nobody listens to, such as one a channel switch opens just after leaving Watch, is
  // a preview: it doesn't reconnect against another device.
  if (attempt === 0) quiet = preview || !store.getState().audible;
  if (attempt === 0) tune(channel);
  release();
  store.setState({
    channel,
    phase:
      attempt === 0
        ? { kind: "tuning", since: Date.now() }
        : { kind: "reconnecting", attempt, of: RECONNECT_DELAYS_MS.length },
    stream: null,
  });

  let session: StreamSession;
  try {
    const { audioId } = store.getState();
    const preferred = (await call("preferences.get").catch(() => null))?.audioLanguage;
    session = await call("playback.open", {
      channelId: channel.id,
      decoders: [...decoders],
      repair,
      ...(audioId !== null ? { audio: audioId } : {}),
      // The sound in the viewer's language, when the channel has it; the original is its own.
      ...(preferred && preferred !== ORIGINAL_SOUND ? { audioLanguage: preferred } : {}),
    });
  } catch (cause) {
    if (mine === selection)
      store.setState({
        phase: { kind: "failed", problem: { kind: "app", error: appError(cause) } },
      });
    return;
  }
  if (mine !== selection) {
    void call("playback.close", { sessionId: session.sessionId }).catch(() => {});
    if (mine === selection) store.setState({ phase: { kind: "idle" } });
    return;
  }

  let engine = createEngine(session.format, video, session.url);
  current = { sessionId: session.sessionId, engine };
  // A new stream starts its clock again: cues of the one before would show at the wrong time.
  clearSubtitles(video);
  restartSubtitles();
  engine.onPrivateData(showSubtitles);
  let failure = await startFailure(engine);
  // Some "live" channels are raw audio (AAC radio) rather than MPEG-TS. Chromium plays those itself.
  if (failure?.kind === "wrong-container" && mine === selection) {
    engine.destroy();
    engine = nativeEngine(video, session.url);
    current = { sessionId: session.sessionId, engine };
    failure = await startFailure(engine);
  }
  if (mine !== selection) return;
  if (failure) {
    await recover(mine, channel, session, failure, attempt, repair);
    return;
  }

  store.setState({ phase: { kind: "playing", engine: engine.name } });
  void loadStream(mine, session.sessionId);
  void loadTracks(mine, session.sessionId);
  setTimeout(() => void loadTracks(mine, session.sessionId), TRACKS_AGAIN_MS);
  void call("viewing.recordWatch", { commandId: crypto.randomUUID(), channelId: channel.id }).catch(
    () => {},
  );
  // A stream that played fine gets the full set of reconnect attempts when it breaks later.
  engine.onFailure((error) => {
    if (mine === selection) void recover(mine, channel, session, error, 0, repair);
  });
}

/** Waits for an engine to start. Returns why it failed, or null once it plays. */
async function startFailure(engine: Engine): Promise<EngineError | null> {
  try {
    await engine.started;
    return null;
  } catch (error) {
    return isEngineError(error) ? error : { kind: "media", detail: String(error) };
  }
}

/**
 * Decides what to do about a failed or broken stream: reconnect after a delay when the network
 * failed, try once more with the picture repaired when the player could not decode it, or give up.
 */
async function recover(
  mine: number,
  channel: LiveChannel,
  session: StreamSession,
  error: EngineError,
  attempt: number,
  repaired: boolean,
): Promise<void> {
  const upstream = await call("playback.failure", { sessionId: session.sessionId }).catch(
    () => null,
  );
  if (mine !== selection) return;
  const problem = classify(upstream, error);
  if (quiet) {
    release();
    store.setState({ phase: { kind: "failed", problem } });
    return;
  }
  if (problem.kind === "unsupported" && upstream === null && !repaired) {
    release();
    await start(channel, attempt, true);
    return;
  }
  const delay = RECONNECT_DELAYS_MS[attempt];
  const retryable = problem.kind === "network" || problem.kind === "provider-error";

  if (!retryable || delay === undefined) {
    release();
    store.setState({ phase: { kind: "failed", problem } });
    return;
  }
  release();
  store.setState({
    phase: { kind: "reconnecting", attempt: attempt + 1, of: RECONNECT_DELAYS_MS.length },
  });
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (mine === selection) await start(channel, attempt + 1, repaired);
}

function classify(upstream: StreamFailure | null, error: EngineError): PlaybackProblem {
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

/**
 * Makes `channel` the one tuned, when it is another: the one before becomes where Back goes, even
 * while switching, and the tracks and subtitle timing start afresh, with the viewer's languages,
 * for the new channel.
 */
function tune(channel: LiveChannel): void {
  if (tuned?.id === channel.id) return;
  if (tuned) store.setState({ previous: tuned });
  tuned = channel;
  store.setState({ tracks: null, audioId: null, subtitle: null, fellBack: null });
  lastSubtitle = null;
  shown = null;
  clearSubtitles(video);
  setSubtitleDelay(video, 0);
}

/** Reads which of the channel's streams plays, and notes when Automatic passed one by. */
async function loadStream(mine: number, sessionId: string): Promise<void> {
  const stream = await call("playback.playing", { sessionId }).catch(() => null);
  if (mine !== selection || !stream) return;
  const [failed] = stream.failed;
  const fellBack =
    failed && stream.variantId ? { from: failed.variantId, to: stream.variantId } : null;
  store.setState(fellBack ? { stream, fellBack } : { stream });
}

/**
 * Reads the stream's tracks from the main process. The first time on a channel, subtitles in the
 * viewer's language may come on by themselves (see channelSubtitle).
 */
async function loadTracks(mine: number, sessionId: string): Promise<void> {
  const tracks = await call("playback.tracks", { sessionId }).catch(() => null);
  if (mine !== selection || !tracks) return;
  store.setState({ tracks });
  if (store.getState().subtitle || lastSubtitle) return;
  const wanted = (await call("preferences.get").catch(() => null))?.subtitleLanguage ?? null;
  const match = channelSubtitle(tracks, wanted);
  if (match && mine === selection) choose(match);
}

/** A decoder and presenter for the chosen subtitles, from scratch. */
function restartSubtitles(): void {
  const { subtitle } = store.getState();
  shown = subtitle
    ? {
        pid: subtitle.id,
        decoder: subtitleDecoder(
          subtitle.format === "teletext"
            ? "teletext"
            : subtitle.format === "captions"
              ? "captions"
              : "dvb",
          subtitle.page,
        ),
        presenter: subtitlePresenter(video),
      }
    : null;
}

function showSubtitles(pid: number, data: Uint8Array, at: number): void {
  if (!shown || pid !== shown.pid) return;
  const change = shown.decoder.push(data, at);
  if (change) shown.presenter.show(change);
}

/** Shows `track`, or nothing. */
function choose(track: SubtitleTrack | null): void {
  store.setState({ subtitle: track });
  if (track) lastSubtitle = track;
  clearSubtitles(video);
  restartSubtitles();
}

function applyVolume(): void {
  const { volume, muted, audible } = store.getState();
  video.volume = volume;
  video.muted = muted || !audible;
}

function saveVolume(): void {
  if (volumeSave) clearTimeout(volumeSave);
  volumeSave = setTimeout(() => {
    const { volume, muted } = store.getState();
    void call("preferences.update", { volume, muted }).catch(() => {});
  }, VOLUME_SAVE_DELAY_MS);
}

export const player = {
  /** The video element every view shows the picture in. */
  element: video,

  /** Restores the saved volume and subtitle look. Call once before the first `play`. */
  hydrate(preferences: Preferences): void {
    store.setState({ volume: preferences.volume, muted: preferences.muted });
    applyVolume();
    setSubtitleLook(preferences.subtitleLook ?? DEFAULT_SUBTITLE_LOOK);
  },

  play(channel: LiveChannel): void {
    liveStarts?.();
    cancelZap();
    store.setState({ stopped: false });
    void start(channel, 0);
  },

  /**
   * Plays a channel to watch it, keeping the stream when a preview already shows it. From then on
   * a failure reconnects as usual.
   */
  watch(channel: LiveChannel): void {
    const { channel: current, phase } = store.getState();
    const open =
      phase.kind === "playing" || phase.kind === "tuning" || phase.kind === "reconnecting";
    if (current?.id === channel.id && open && !zapTimer) {
      liveStarts?.();
      quiet = false;
      store.setState({ stopped: false });
      return;
    }
    player.play(channel);
  },

  /** Starts a muted preview of a channel, unless it already plays or the viewer stopped playback. */
  preview(channel: LiveChannel): void {
    const { channel: current, phase, stopped } = store.getState();
    if (stopped || (current?.id === channel.id && phase.kind !== "idle")) return;
    cancelZap();
    void start(channel, 0, false, true);
  },

  /** Stops a preview while nobody can see it. Unlike `stop`, the next preview starts it again. */
  suspend(): void {
    cancelZap();
    selection++;
    release();
    shown = null;
    store.setState({ phase: { kind: "idle" } });
  },

  /**
   * Whether the view on screen plays sound. A stream nobody listens to is a preview again, so
   * leaving Watch stops it from reconnecting against another device.
   */
  setAudible(audible: boolean): void {
    quiet = !audible;
    if (store.getState().audible === audible) return;
    store.setState({ audible });
    applyVolume();
  },

  /**
   * Switches channel the way a remote does: the new channel shows immediately and its stream
   * opens once the viewer stops switching for a moment.
   */
  zap(channel: LiveChannel): void {
    liveStarts?.();
    cancelZap();
    selection++;
    release();
    tune(channel);
    store.setState({ channel, phase: { kind: "tuning", since: Date.now() }, stopped: false });
    zapTimer = setTimeout(() => {
      zapTimer = null;
      void start(channel, 0);
    }, ZAP_SETTLE_MS);
  },

  /** Returns to the channel that played before this one. */
  back(): void {
    const { previous } = store.getState();
    if (previous) player.play(previous);
  },

  /** Tries the current channel again from scratch. */
  retry(): void {
    const { channel } = store.getState();
    if (channel) void start(channel, 0);
  },

  /** Opens the current channel again after its quality was chosen, forgetting a fallback. */
  reopen(): void {
    store.setState({ fellBack: null });
    player.retry();
  },

  stop(): void {
    player.suspend();
    store.setState({ stopped: true });
  },

  /** Stops and forgets the selected channel, for when the subscription changes. */
  reset(): void {
    player.suspend();
    tuned = null;
    store.setState({ channel: null, previous: null, stopped: false });
  },

  setVolume(volume: number): void {
    store.setState({ volume: Math.min(1, Math.max(0, volume)), muted: false, audible: true });
    applyVolume();
    saveVolume();
  },

  /**
   * The speaker: mutes or unmutes. Unmuting a preview makes it audible without touching the
   * viewer's own mute setting.
   */
  toggleMute(): void {
    const { muted, audible } = store.getState();
    if (!audible) {
      store.setState({ audible: true, muted: false });
    } else {
      store.setState({ muted: !muted });
    }
    applyVolume();
    saveVolume();
  },

  /**
   * Plays another sound track of the channel. The stream opens again with it, so the picture
   * starts over; the language is remembered.
   */
  setAudio(id: number): void {
    const { channel, tracks } = store.getState();
    const track = tracks?.audio.find((each) => each.id === id);
    if (!channel || !track) return;
    store.setState({ audioId: id });
    if (track.language) {
      void call("preferences.update", { audioLanguage: track.language }).catch(() => {});
    }
    void start(channel, 0);
  },

  /** Shows a subtitle track, or none, and remembers the choice. */
  setSubtitle(track: SubtitleTrack | null): void {
    choose(track);
    void call("preferences.update", {
      subtitleLanguage: track ? (track.language ?? null) : "off",
    }).catch(() => {});
  },

  /** C: subtitles off, or back on: the ones chosen last on this channel, else the first. */
  toggleSubtitles(): void {
    const { subtitle, tracks } = store.getState();
    if (subtitle) return player.setSubtitle(null);
    const next = lastSubtitle ?? tracks?.subtitles[0] ?? null;
    if (next) player.setSubtitle(next);
  },

  /** The player's state now, for key handlers that read it once. */
  state(): PlayerState {
    return store.getState();
  },

  /** The selected channel, playing or not. */
  current(): LiveChannel | null {
    return store.getState().channel;
  },

  /** Details of the playing stream, or null when nothing plays. */
  info(): StreamInfo | null {
    return current && store.getState().phase.kind === "playing" ? current.engine.info() : null;
  },
};
