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
// An HLS stream's tracks come from its engine instead, which reads them from the stream's
// playlists and says so again whenever they change: its sound switches where it plays, and the
// lines of its subtitles and captions go on the element's subtitle track as they are read. The
// same choices and the same remembered languages apply to both.
//
// The video element outlives every view: Home's backdrop, the guide's preview and Watch each show
// it in turn (see Picture.tsx), so moving between them never reopens the stream. Only Watch plays
// sound unless the viewer unmutes elsewhere; `audible` is that choice, `muted` the viewer's own.
//
// With a receiver on the network connected (see output.ts), a channel the viewer chooses plays
// there: the main process opens it for the receiver, and the state here is what the receiver
// confirmed. Nothing previews meanwhile, as a preview would take the provider's connection from
// the receiver. A channel has no pause and no subtitles there; one the receiver itself holds
// paused or buffering, as after Pause on the TV's remote, says so here.
import { createStore, useStore } from "zustand";
import type { AppError } from "@mrstreamer/contracts/errors";
import type {
  OutputFailure,
  OutputStatus,
  RemoteMedia,
  RemoteState,
} from "@mrstreamer/contracts/output";
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
import type { Cue } from "@mrstreamer/core/subtitles/webvtt";
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
import type { SoundChoice } from "./hls-tracks.ts";
import { outputs } from "./output.ts";
import {
  addTextCue,
  clearSubtitles,
  forgetShownSubtitles,
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
  | { readonly kind: "app"; readonly error: AppError }
  /**
   * A receiver on the network doesn't play it. `lost` when the receiver itself is gone, and has
   * to be connected to again.
   */
  | { readonly kind: "receiver"; readonly failure: OutputFailure; readonly lost: boolean };

/** What a receiver says of a channel it started. A channel has no end. */
type ReceiverState = Exclude<RemoteState, "ended">;

type PlayerPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "tuning"; readonly since: number }
  | { readonly kind: "playing"; readonly engine: EngineName }
  /**
   * A receiver on the network started it. `state` is its last word on it: it plays, is paused
   * there, as from the TV's remote, or waits for more of the stream.
   */
  | { readonly kind: "playing"; readonly engine: "receiver"; readonly state: ReceiverState }
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
  /** The sound track chosen, by id; null plays the channel's own choice. */
  readonly audioId: number | null;
  /** The subtitles on screen, or null for none. */
  readonly subtitle: SubtitleTrack | null;
  /**
   * The chosen subtitles of an HLS stream are still loading: its engine hasn't read them where
   * the stream plays. Whether they say anything there doesn't matter, and subtitles that can't be
   * had stay loading.
   */
  readonly subtitleLoading: boolean;
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
  subtitleLoading: false,
  stream: null,
  fellBack: null,
}));

/** Reads player state in a component. */
export function usePlayer<T>(selector: (state: PlayerState) => T): T {
  return useStore(store, selector);
}

/**
 * What the receiver last said of the channel it started, for the views to say. Null while the
 * channel plays here, and until the receiver starts it.
 */
export function receiverState(phase: PlayerState["phase"]): ReceiverState | null {
  return phase.kind === "playing" && phase.engine === "receiver" ? phase.state : null;
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
 * The selected channel is the receiver's: the load that plays there, null until it was taken, and
 * how often it was tried again.
 */
let onReceiver: { load: number | null; attempt: number } | null = null;
/** The viewer asked for this computer, so the channel goes on here when the receiver is let go of. */
let returning = false;

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

/**
 * Stops the engine and closes the provider connection of the current stream. Its subtitles go
 * with it: their cues are on the clock of a stream that no longer plays.
 */
function release(): void {
  if (!current) return;
  current.engine.destroy();
  clearSubtitles(video);
  void call("playback.close", { sessionId: current.sessionId }).catch(() => {});
  current = null;
  // Nothing loads the chosen subtitles any more.
  if (store.getState().subtitleLoading) store.setState({ subtitleLoading: false });
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
  if (outputs.remote()) {
    // Nothing previews while a receiver has playback: it would take the provider's connection.
    if (!preview) await startOnReceiver(channel, attempt);
    return;
  }
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
  let sound: SoundChoice;
  try {
    const preferred = (await call("preferences.get").catch(() => null))?.audioLanguage;
    sound = {
      audio: store.getState().audioId,
      // The sound in the viewer's language, when the channel has it; the original is its own.
      audioLanguage: preferred && preferred !== ORIGINAL_SOUND ? preferred : null,
    };
    session = await call("playback.open", {
      channelId: channel.id,
      decoders: [...decoders],
      repair,
      ...(sound.audio !== null ? { audio: sound.audio } : {}),
      ...(sound.audioLanguage !== null ? { audioLanguage: sound.audioLanguage } : {}),
      // Said so the main process refuses it when a receiver took playback since this began.
      ...(preview ? { preview } : {}),
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

  let engine = createEngine(session.format, video, session.url, sound);
  current = { sessionId: session.sessionId, engine };
  engine.onPrivateData(showSubtitles);
  engine.tracks?.onChange((tracks) => engineTracks(mine, tracks));
  engine.tracks?.onLine((line) => showLine(mine, line));
  engine.tracks?.onSubtitleLoaded(() => subtitlesLoaded(mine));
  restartSubtitles();
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
  // An engine that reads the stream's tracks tells them itself; the main process reads the rest.
  if (!engine.tracks) {
    void loadTracks(mine, session.sessionId);
    setTimeout(() => void loadTracks(mine, session.sessionId), TRACKS_AGAIN_MS);
  }
  void call("viewing.recordWatch", { commandId: crypto.randomUUID(), channelId: channel.id }).catch(
    () => {},
  );
  // A stream that played fine gets the full set of reconnect attempts when it breaks later.
  engine.onFailure((error) => {
    if (mine === selection) void recover(mine, channel, session, error, 0, repair);
  });
}

/** Plays a channel on the connected receiver, in place of what it had. */
async function startOnReceiver(channel: LiveChannel, attempt: number): Promise<void> {
  const mine = ++selection;
  quiet = false;
  if (attempt === 0) tune(channel);
  release();
  onReceiver = { load: null, attempt };
  store.setState({
    channel,
    stopped: false,
    phase:
      attempt === 0
        ? { kind: "tuning", since: Date.now() }
        : { kind: "reconnecting", attempt, of: RECONNECT_DELAYS_MS.length },
    stream: null,
  });
  try {
    const { audioId } = store.getState();
    const preferred = (await call("preferences.get").catch(() => null))?.audioLanguage;
    const media = await call("output.playChannel", {
      channelId: channel.id,
      name: channel.title,
      ...(audioId !== null ? { audio: audioId } : {}),
      ...(preferred && preferred !== ORIGINAL_SOUND ? { audioLanguage: preferred } : {}),
    });
    if (mine !== selection || !onReceiver) {
      // Stopped meanwhile: the receiver is told so. One another channel replaced has gone already.
      void call("output.command", { generation: media.generation, command: "stop" }).catch(
        () => {},
      );
      return;
    }
    onReceiver.load = media.generation;
    // What the receiver said of it before this answer arrived.
    const said = outputs.media();
    if (said?.generation === media.generation) followReceiver(said);
  } catch (cause) {
    if (mine !== selection) return;
    const error = appError(cause);
    const failure = error.kind === "output" ? error.failure : null;
    if (failure?.kind === "stream") return void recoverOnReceiver(channel, failure.failure);
    store.setState({
      phase: {
        kind: "failed",
        problem: failure ? { kind: "receiver", failure, lost: false } : { kind: "app", error },
      },
    });
  }
}

/**
 * Takes the receiver's word on the channel it plays. Its first word past loading starts the
 * channel, also when that holds it paused; what it says from then on only changes the state.
 */
function followReceiver(media: RemoteMedia): void {
  const { channel, phase } = store.getState();
  // A channel has no end: the main process says its stream stopped instead.
  if (!channel || media.state === "ended") return;
  const started = phase.kind === "playing";
  if (!started && media.state === "loading") return;
  if (receiverState(phase) !== media.state) {
    store.setState({ phase: { kind: "playing", engine: "receiver", state: media.state } });
  }
  if (started) return;
  const mine = selection;
  void loadStream(mine, media.sessionId);
  void loadTracks(mine, media.sessionId);
  void call("viewing.recordWatch", { commandId: crypto.randomUUID(), channelId: channel.id }).catch(
    () => {},
  );
  // A stream that played gets every reconnect attempt when it breaks later.
  if (onReceiver) onReceiver.attempt = 0;
}

/**
 * What to do about a channel whose stream the provider didn't deliver for the receiver: try
 * again after a delay when the network failed, as for this computer, or give up and say why.
 */
async function recoverOnReceiver(channel: LiveChannel, failure: StreamFailure): Promise<void> {
  const mine = selection;
  const attempt = onReceiver?.attempt ?? 0;
  const problem = classify(failure, { kind: "network", detail: "" });
  const delay = RECONNECT_DELAYS_MS[attempt];
  if ((problem.kind !== "network" && problem.kind !== "provider-error") || delay === undefined) {
    store.setState({ phase: { kind: "failed", problem } });
    return;
  }
  store.setState({
    phase: { kind: "reconnecting", attempt: attempt + 1, of: RECONNECT_DELAYS_MS.length },
  });
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (mine === selection && outputs.remote()) await startOnReceiver(channel, attempt + 1);
}

/** Follows where playback goes: to a receiver that connected, back from one, and its word meanwhile. */
function outputChanged(status: OutputStatus, before: OutputStatus): void {
  const { output } = status;
  const { channel, phase } = store.getState();
  if (output.kind === "receiver" && before.output.kind !== "receiver") {
    // The channel being watched moves to the receiver. A preview only makes way.
    if (channel && !quiet && phase.kind !== "idle") void startOnReceiver(channel, 0);
    else if (!onReceiver) player.suspend();
    return;
  }
  if (!onReceiver || !channel) return;
  if (output.kind === "local") {
    // Let go of: the channel goes on here when the viewer asked for that, and stays stopped when
    // the receiver let go by itself.
    const resume = returning;
    returning = false;
    onReceiver = null;
    selection++;
    if (resume) player.play(channel);
    else store.setState({ phase: { kind: "idle" }, stopped: true });
    return;
  }
  if (output.kind === "lost") {
    selection++;
    onReceiver.load = null;
    store.setState({
      phase: {
        kind: "failed",
        problem: { kind: "receiver", failure: output.failure, lost: true },
      },
    });
    return;
  }
  if (output.kind !== "receiver" || onReceiver.load === null) return;
  if (output.media?.generation === onReceiver.load) return followReceiver(output.media);
  if (output.media) return;
  // The receiver holds the channel no more: its stream stopped, or it was stopped there.
  onReceiver.load = null;
  const { failure } = output;
  if (failure?.kind === "stream") void recoverOnReceiver(channel, failure.failure);
  else if (failure) {
    store.setState({
      phase: { kind: "failed", problem: { kind: "receiver", failure, lost: false } },
    });
  } else {
    selection++;
    store.setState({ phase: { kind: "idle" }, stopped: true });
  }
}

outputs.subscribe(outputChanged);

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
  store.setState({
    tracks: null,
    audioId: null,
    subtitle: null,
    subtitleLoading: false,
    fellBack: null,
  });
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

/** Reads the stream's tracks from the main process. */
async function loadTracks(mine: number, sessionId: string): Promise<void> {
  const tracks = await call("playback.tracks", { sessionId }).catch(() => null);
  if (mine === selection && tracks) await applyTracks(mine, tracks);
}

/**
 * Takes the stream's tracks as its engine tells them, now and whenever they change. What the
 * viewer chose holds only while the stream still has it: subtitles it no longer lists go, and a
 * sound track gives way to the one that plays, as after the stream moved to renditions without it.
 */
function engineTracks(mine: number, tracks: ChannelTracks): void {
  if (mine !== selection) return;
  const { audioId, subtitle } = store.getState();
  const listed = (track: SubtitleTrack) =>
    tracks.subtitles.some((each) => each.id === track.id && each.page === track.page);
  if (lastSubtitle && !listed(lastSubtitle)) lastSubtitle = null;
  if (subtitle && !listed(subtitle)) choose(null);
  if (audioId !== null && tracks.playing !== null && tracks.playing !== audioId) {
    store.setState({ audioId: null });
  }
  void applyTracks(mine, tracks);
}

/**
 * Shows the stream's tracks. Until the viewer chose subtitles on this channel, those in the
 * viewer's language may come on by themselves (see channelSubtitle): the language remembered, or
 * none when the viewer turned subtitles off, whatever the stream marks as its default.
 */
async function applyTracks(mine: number, tracks: ChannelTracks): Promise<void> {
  store.setState({ tracks });
  const chosen = () => store.getState().subtitle !== null || lastSubtitle !== null;
  if (chosen()) return;
  const wanted = (await call("preferences.get").catch(() => null))?.subtitleLanguage ?? null;
  // The viewer may have chosen meanwhile, and the stream may list other tracks by now.
  const latest = store.getState().tracks;
  if (mine !== selection || chosen() || !latest) return;
  const match = channelSubtitle(latest, wanted);
  if (match) choose(match);
}

/** Puts a line of an HLS stream's subtitles on the element's track, at the viewer's timing. */
function showLine(mine: number, line: Cue): void {
  if (mine !== selection || !store.getState().subtitle) return;
  forgetShownSubtitles(video);
  addTextCue(video, line.start, line.end, line.text);
}

/** The engine of an HLS stream has read the chosen subtitles where the stream plays. */
function subtitlesLoaded(mine: number): void {
  if (mine !== selection || !store.getState().subtitleLoading) return;
  store.setState({ subtitleLoading: false });
}

/**
 * Starts the chosen subtitles from scratch: read by the engine of a stream that carries them in
 * its playlists, else decoded here from the stream's private data. The engine's are loading until
 * it says otherwise, which it may do at once.
 */
function restartSubtitles(): void {
  const { subtitle } = store.getState();
  const own = current?.engine.tracks ?? null;
  store.setState({ subtitleLoading: own !== null && subtitle !== null });
  if (own) {
    shown = null;
    own.setSubtitle(subtitle);
    return;
  }
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

/**
 * Remembers the subtitles picked, in a channel or a title, for the next ones: their language, or
 * none. Captions have no language, so picking them keeps the one remembered before.
 */
export function rememberSubtitles(track: SubtitleTrack | null): void {
  const language = track ? track.language : "off";
  if (language === null) return;
  void call("preferences.update", { subtitleLanguage: language }).catch(() => {});
}

/** The receiver's volume, when one has playback and it can be set from here. */
function receiverVolume(): { readonly level: number; readonly muted: boolean } | null {
  const { output } = outputs.status();
  return output.kind === "receiver" ? output.volume : null;
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
    // Nothing previews while a receiver has playback, or had it until its connection broke.
    if (outputs.receiver()) return;
    if (stopped || (current?.id === channel.id && phase.kind !== "idle")) return;
    cancelZap();
    void start(channel, 0, false, true);
  },

  /**
   * Stops a preview while nobody can see it. Unlike `stop`, the next preview starts it again. A
   * channel a receiver plays is left alone: no page stops that.
   */
  suspend(): void {
    if (onReceiver) return;
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
    // What a receiver says of the channel before is no word on this one.
    if (onReceiver) onReceiver.load = null;
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

  /** Stops the channel. On a receiver it ends the stream there and keeps the receiver. */
  stop(): void {
    if (onReceiver) {
      const { load } = onReceiver;
      cancelZap();
      selection++;
      onReceiver = null;
      if (load !== null) {
        void call("output.command", { generation: load, command: "stop" }).catch(() => {});
      }
      store.setState({ phase: { kind: "idle" }, stopped: true });
      return;
    }
    player.suspend();
    store.setState({ stopped: true });
  },

  /**
   * Makes way for a movie or episode: what plays here ends, and a channel a receiver plays is
   * forgotten, as the title takes its place there.
   */
  makeWay(): void {
    if (!onReceiver) return player.suspend();
    cancelZap();
    selection++;
    onReceiver = null;
    store.setState({ phase: { kind: "idle" } });
  },

  /**
   * Brings the channel a receiver plays back to this computer: the receiver is let go of first,
   * then it plays here.
   */
  playHere(): void {
    returning = true;
    void outputs.local();
  },

  /**
   * Plays on a channel the receiver holds paused, as after Pause on the TV's remote. The receiver
   * keeps the stream it has, so nothing opens again.
   */
  resume(): void {
    if (onReceiver?.load == null || receiverState(store.getState().phase) !== "paused") return;
    void call("output.command", { generation: onReceiver.load, command: "play" }).catch(() => {});
  },

  /** Whether the selected channel is the receiver's. */
  onReceiver: (): boolean => onReceiver !== null,

  /** Takes up a channel a receiver already plays, as when the window opens while it does. */
  adopt(channel: LiveChannel, media: RemoteMedia): void {
    if (onReceiver) return;
    selection++;
    tune(channel);
    onReceiver = { load: media.generation, attempt: 0 };
    store.setState({ channel, stopped: false, phase: { kind: "tuning", since: media.at } });
    followReceiver(media);
  },

  /** Stops and forgets the selected channel, for when the subscription changes. */
  reset(): void {
    onReceiver = null;
    player.suspend();
    tuned = null;
    store.setState({ channel: null, previous: null, stopped: false });
  },

  /**
   * Sets the volume: this computer's, or the receiver's while one has playback. False when the
   * receiver's can't be set from here.
   */
  setVolume(volume: number): boolean {
    const level = Math.min(1, Math.max(0, volume));
    if (outputs.receiver()) {
      if (!receiverVolume()) return false;
      outputs.volume({ level, muted: false });
      return true;
    }
    store.setState({ volume: level, muted: false, audible: true });
    applyVolume();
    saveVolume();
    return true;
  },

  /** Up and Down: a step louder or quieter, on whatever plays. False as for `setVolume`. */
  nudgeVolume(step: number): boolean {
    const from = outputs.receiver() ? (receiverVolume()?.level ?? 0) : store.getState().volume;
    return player.setVolume(from + step);
  },

  /**
   * The speaker: mutes or unmutes. Unmuting a preview makes it audible without touching the
   * viewer's own mute setting.
   */
  toggleMute(): boolean {
    if (outputs.receiver()) {
      const receiver = receiverVolume();
      if (receiver) outputs.volume({ muted: !receiver.muted });
      return receiver !== null;
    }
    const { muted, audible } = store.getState();
    if (!audible) {
      store.setState({ audible: true, muted: false });
    } else {
      store.setState({ muted: !muted });
    }
    applyVolume();
    saveVolume();
    return true;
  },

  /**
   * Plays another sound track of the channel, and remembers its language. An HLS stream switches
   * where it plays. Any other opens again with the track, so its picture starts over.
   */
  setAudio(id: number): void {
    const { channel, tracks } = store.getState();
    const track = tracks?.audio.find((each) => each.id === id);
    if (!channel || !track) return;
    store.setState({ audioId: id });
    if (track.language) {
      void call("preferences.update", { audioLanguage: track.language }).catch(() => {});
    }
    const own = current?.engine.tracks;
    if (own) own.setAudio(id);
    else void start(channel, 0);
  },

  /** Shows a subtitle track, or none, and remembers the choice. A receiver shows none of a channel's. */
  setSubtitle(track: SubtitleTrack | null): void {
    if (onReceiver) return;
    choose(track);
    rememberSubtitles(track);
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
