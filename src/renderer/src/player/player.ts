// The player controller: owns the video element, the open stream session and the playback state.
//
// Every `play` call starts a new selection. Anything that resolves for an older selection is
// dropped, so a slow channel can never replace the one the viewer picked after it.
import { createStore, useStore } from "zustand";
import type { AppError } from "../../../shared/errors.ts";
import type { LiveChannel } from "../../../shared/library.ts";
import type { StreamFailure, StreamSession } from "../../../shared/playback.ts";
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

/** Waits before each reconnect attempt after a stream breaks. Its length is the attempt limit. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];
/**
 * How long zapping waits for the next key press before it opens a stream. Flicking through
 * channels shows each one at once but only tunes the one the viewer stops on, which matters on
 * subscriptions that allow a single connection.
 */
const ZAP_SETTLE_MS = 350;
const VOLUME_SAVE_DELAY_MS = 400;

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

export type PlayerPhase =
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
}

const store = createStore<PlayerState>(() => ({
  channel: null,
  phase: { kind: "idle" },
  previous: null,
  volume: 1,
  muted: false,
}));

/** Reads player state in a component. */
export function usePlayer<T>(selector: (state: PlayerState) => T): T {
  return useStore(store, selector);
}

let video: HTMLVideoElement | null = null;
let selection = 0;
let current: { readonly sessionId: string; readonly engine: Engine } | null = null;
let volumeSave: ReturnType<typeof setTimeout> | null = null;
let zapTimer: ReturnType<typeof setTimeout> | null = null;
/** The channel the last stream was opened for. It becomes `previous` when another channel tunes. */
let tuned: LiveChannel | null = null;

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

async function start(channel: LiveChannel, attempt: number): Promise<void> {
  const mine = ++selection;
  if (attempt === 0 && tuned?.id !== channel.id) {
    if (tuned) store.setState({ previous: tuned });
    tuned = channel;
  }
  release();
  store.setState({
    channel,
    phase:
      attempt === 0
        ? { kind: "tuning", since: Date.now() }
        : { kind: "reconnecting", attempt, of: RECONNECT_DELAYS_MS.length },
  });

  let session: StreamSession;
  try {
    session = await call("playback.open", { channelId: channel.id, decoders: [...decoders] });
  } catch (cause) {
    if (mine === selection)
      store.setState({
        phase: { kind: "failed", problem: { kind: "app", error: appError(cause) } },
      });
    return;
  }
  if (mine !== selection || !video) {
    void call("playback.close", { sessionId: session.sessionId }).catch(() => {});
    if (mine === selection) store.setState({ phase: { kind: "idle" } });
    return;
  }

  let engine = createEngine(session.format, video, session.url);
  current = { sessionId: session.sessionId, engine };
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
    await recover(mine, channel, session, failure, attempt);
    return;
  }

  store.setState({ phase: { kind: "playing", engine: engine.name } });
  void call("preferences.recordWatch", { channelId: channel.id }).catch(() => {});
  // A stream that played fine gets the full set of reconnect attempts when it breaks later.
  engine.onFailure((error) => {
    if (mine === selection) void recover(mine, channel, session, error, 0);
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

/** Decides whether a failed or broken stream is worth reconnecting, and does so after a delay. */
async function recover(
  mine: number,
  channel: LiveChannel,
  session: StreamSession,
  error: EngineError,
  attempt: number,
): Promise<void> {
  const upstream = await call("playback.failure", { sessionId: session.sessionId }).catch(
    () => null,
  );
  if (mine !== selection) return;
  const problem = classify(upstream, error);
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
  if (mine === selection) await start(channel, attempt + 1);
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

function applyVolume(): void {
  if (!video) return;
  const { volume, muted } = store.getState();
  video.volume = volume;
  video.muted = muted;
}

function saveVolume(): void {
  if (volumeSave) clearTimeout(volumeSave);
  volumeSave = setTimeout(() => {
    const { volume, muted } = store.getState();
    void call("preferences.update", { volume, muted }).catch(() => {});
  }, VOLUME_SAVE_DELAY_MS);
}

export const player = {
  /** Hands the controller the video element. Passing null stops playback. */
  attach(element: HTMLVideoElement | null): void {
    if (element === video) return;
    if (!element) player.stop();
    video = element;
    applyVolume();
  },

  /** Restores the saved volume. Call once before the first `play`. */
  hydrate(preferences: { volume: number; muted: boolean }): void {
    store.setState({ volume: preferences.volume, muted: preferences.muted });
    applyVolume();
  },

  play(channel: LiveChannel): void {
    cancelZap();
    void start(channel, 0);
  },

  /**
   * Switches channel the way a remote does: the new channel shows immediately and its stream
   * opens once the viewer stops switching for a moment.
   */
  zap(channel: LiveChannel): void {
    cancelZap();
    selection++;
    release();
    store.setState({ channel, phase: { kind: "tuning", since: Date.now() } });
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

  stop(): void {
    cancelZap();
    selection++;
    release();
    store.setState({ phase: { kind: "idle" } });
  },

  /** Stops and forgets the selected channel, for when the subscription changes. */
  reset(): void {
    player.stop();
    tuned = null;
    store.setState({ channel: null, previous: null });
  },

  setVolume(volume: number): void {
    store.setState({ volume: Math.min(1, Math.max(0, volume)), muted: false });
    applyVolume();
    saveVolume();
  },

  toggleMute(): void {
    store.setState((state) => ({ muted: !state.muted }));
    applyVolume();
    saveVolume();
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
