// The controller for movies and episodes: which title is open, where it is, its tracks, and
// what the viewer does with it. It plays in the same element as live TV (see player.ts): opening a
// title stops the live stream, and starting a live channel closes the title, so the provider sees
// one connection.
//
// How far the title got is saved as the viewer goes: every minute while playing, and at each
// pause, seek, track change, the end, leaving and hiding the window. Never per frame.
//
// A title can play faster or slower, keeping the pitch (the element's `preservesPitch`, on by
// default). The speed lasts for the title, and carries on when another episode of its series opens
// from it, as Next episode does; live channels always play at their own.
//
// An episode knows the next one in its series. At its end that one plays after a countdown,
// unless the viewer turned it off or cancels; Next plays it at once. Watching into the credits of
// the last episode records that the series is finished.
//
// With a receiver on the network connected (see output.ts), a title plays there instead: it is
// opened and loaded through the main process, the controls here command the receiver, and the
// position, the length and whether it plays are what the receiver last confirmed. The main process
// saves how far it got. Connecting a receiver while a title plays here moves it there at its
// position, with its tracks; going back to this computer brings it back the same way. A receiver
// that takes another's place, or is reached again after its connection broke, has nothing of the
// title: it is opened and loaded there afresh, where it was, paused when it was.
import { createStore, useStore } from "zustand";
import type { Episode, SeriesDetails, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { OutputStatus, RemoteMedia } from "@mrstreamer/contracts/output";
import type {
  AudioTrack,
  StreamFailure,
  SubtitleFormat,
  SubtitleTrack,
} from "@mrstreamer/contracts/playback";
import { ORIGINAL_SOUND, type Preferences } from "@mrstreamer/contracts/preferences";
import { nextEpisode } from "@mrstreamer/core/ondemand/details";
import { DEFAULT_TITLE_LANGUAGE } from "@mrstreamer/core/ondemand/languages";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { chooseTracks } from "@mrstreamer/core/ondemand/tracks";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { appError } from "../lib/errors.ts";
import { call } from "../lib/ipc.ts";
import { titleDecoders } from "./decoders.ts";
import type { EngineError } from "./engine.ts";
import { onLiveStart, player, rememberSubtitles, type PlaybackProblem } from "./player.ts";
import { clearSubtitles, setSubtitleDelay } from "./subtitles.ts";
import { outputs, positionOf } from "./output.ts";
import { titleEngine, type SubtitleStatus, type TitleEngine } from "./title-engine.ts";

/** How often progress is saved while a title plays. */
const CHECKPOINT_MS = 60_000;
/** A pause this long ends the run, so the provider's connection isn't held for nothing. */
const RELEASE_AFTER_PAUSE_MS = 5 * 60_000;
/** Waits before each new run after the connection broke. Its length is the attempt limit. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];
/** At the end of an episode, the next one plays after this many seconds. */
const COUNTDOWN_S = 10;

/** The speeds a title plays at, slowest first; 1 is its own. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];

/** The subtitle formats the player shows: all of them. */
const SHOWN_SUBTITLES: ReadonlySet<SubtitleFormat> = new Set([
  "text",
  "picture",
  "teletext",
  "captions",
]);

/** What the view shows about the open title. */
export interface NowPlaying {
  readonly title: TitleRef;
  /** "Escape from New York", or the series' name. */
  readonly name: string;
  /** For episodes: "S2 E3 · Aankomst in Tbilisi". */
  readonly detail: string | null;
  readonly artworkUrl: string | null;
  /** The language it was made in, which "Original language" sound plays; null when unknown. */
  readonly originalLanguage: string | null;
  /** For episodes: the details of the series version they belong to, which list what comes next. */
  readonly series?: SeriesDetails;
}

/** What the player shows for an episode of `series`: the series, and "S2 E3 · Its name". */
export function episodeNow(series: SeriesDetails, episode: Episode): NowPlaying {
  return {
    title: {
      kind: "episode",
      id: episode.id,
      seriesId: episode.seriesId,
      season: episode.season,
      episode: episode.number,
    },
    name: series.title.title,
    detail: `${episodeLabel(episode.season, episode.number)} · ${episode.title}`,
    artworkUrl: episode.stillUrl ?? series.backdropUrl ?? series.title.posterUrl,
    originalLanguage: series.title.originalLanguage,
    series,
  };
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
  readonly subtitle: SubtitleTrack | null;
  /**
   * How the chosen track stands after a skip or a start: still loading what was on screen there,
   * or without it. Null once it shows as the file has it.
   */
  readonly subtitleStatus: SubtitleStatus;
  readonly speed: Speed;
  /**
   * For an episode, the one after it in its series: null after the last episode, undefined for
   * movies and for episodes their series doesn't list.
   */
  readonly next: Episode | null | undefined;
  /** At the end of an episode, the seconds until the next one plays; null without a countdown. */
  readonly countdown: number | null;
  /**
   * Started as the next episode, by the countdown or Next, and not played yet: a failure then
   * means it didn't start.
   */
  readonly continued: boolean;
  /**
   * On a receiver, the kinds of subtitles it shows; null while the title plays here, which shows
   * them all.
   */
  readonly shows: readonly SubtitleFormat[] | null;
  /**
   * On a receiver, while it catches up with a skip: where it last said it was. `position` is
   * where the viewer skipped to meanwhile.
   */
  readonly confirmed: number | null;
}

const idle: TitlePlayerState = {
  now: null,
  phase: { kind: "idle" },
  position: 0,
  duration: null,
  audio: [],
  subtitles: [],
  audioId: null,
  subtitle: null,
  subtitleStatus: null,
  speed: 1,
  next: undefined,
  countdown: null,
  continued: false,
  shows: null,
  confirmed: null,
};

const store = createStore<TitlePlayerState>(() => idle);

/** Reads the title player's state in a component. */
export function useTitlePlayer<T>(selector: (state: TitlePlayerState) => T): T {
  return useStore(store, selector);
}

const video = player.element;
/** The open session: its id and the address runs play from. */
let session: { readonly id: string; readonly url: string } | null = null;
/**
 * When the open title began to play, epoch milliseconds. Its checkpoints bring back a title taken
 * out of Continue watching only when this play began after the removal.
 */
let openedAt = 0;
let engine: TitleEngine | null = null;
/** Voids the runs of an earlier open or run, like the live player's selection. */
let generation = 0;
/** The sound was converted after a copy failed to start; later runs keep converting. */
let convertSound = false;
let checkpoint: ReturnType<typeof setInterval> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
/** Where a run stopped for a long pause resumes from. */
let released: number | null = null;
/** The run starting now holds its first picture: a skip or track change while paused made it. */
let holding = false;
/** The subtitles shown last in this title, which C turns on again. */
let lastSubtitle: SubtitleTrack | null = null;
/** Takes a second off the countdown to the next episode. */
let countdownTimer: ReturnType<typeof setInterval> | null = null;
/** The countdown waits, at the seconds it has left, as while Settings is open over the title. */
let countdownHeld = false;
/** This play of the last episode has recorded that its series is finished. */
let seriesFinished = false;
/**
 * The open title is the receiver's: its session there (null until it is opened for that
 * receiver), the load that plays (null while none does), the subtitle track that load carries, and
 * whether it is held paused, which the phase stops saying while it loads and once it failed.
 */
let receiver: {
  sessionId: string | null;
  load: number | null;
  subtitle: number | null;
  paused: boolean;
} | null = null;
/** What the receiver last confirmed of the load, which the position moves on from while it plays. */
let confirmedMedia: RemoteMedia | null = null;
let ticking: ReturnType<typeof setInterval> | null = null;
/** The viewer asked for this computer, so the title goes on playing here rather than held. */
let returning = false;
/** The title's view is on screen: only then is it brought back when a receiver lets go. */
let shown = false;

video.addEventListener("timeupdate", () => {
  if (engine) store.setState({ position: engine.position() });
});
video.addEventListener("pause", () => {
  if (!engine || store.getState().phase.kind !== "playing") return;
  store.setState({ phase: { kind: "paused" } });
  save();
  releaseLater();
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

/**
 * Saves how far the title got, when there is a title and a length to measure it against. Once
 * the last episode of a series is in its credits, records that the series is finished, after the
 * progress, so every version played leaves Continue watching, this one included.
 */
function save(): void {
  // What a receiver plays, the main process saves, from what the receiver confirmed.
  if (receiver) return;
  const { now, position, duration, next } = store.getState();
  if (!now || !duration || position <= 0) return;
  const saved = call("viewing.recordProgress", {
    commandId: crypto.randomUUID(),
    title: now.title,
    position: Math.min(position, duration),
    duration,
    since: openedAt,
  });
  if (next === null && now.series && !seriesFinished && isFinished(position, duration)) {
    seriesFinished = true;
    const seriesIds = now.series.title.versions.map((version) => version.id);
    void saved
      .then(() => call("viewing.finishSeries", { commandId: crypto.randomUUID(), seriesIds }))
      .catch(() => {});
  }
  void saved.catch(() => {});
}

/** Stops the countdown to the next episode. */
function stopCountdown(): void {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  if (store.getState().countdown !== null) store.setState({ countdown: null });
}

/**
 * At the end of an episode with another after it, counts down to that one once a second, unless
 * the viewer turned that off. The setting is read now, so a change made while it played counts.
 */
async function countDown(mine: number): Promise<void> {
  if (!store.getState().next) return;
  const preferences = await call("preferences.get").catch((): Preferences | null => null);
  if (mine !== generation || store.getState().phase.kind !== "ended") return;
  if (preferences?.autoplayNext === false) return;
  store.setState({ countdown: COUNTDOWN_S });
  if (!countdownHeld) tickCountdown();
}

/** Takes a second off the countdown each second, and plays the next episode at zero. */
function tickCountdown(): void {
  countdownTimer = setInterval(() => {
    const left = (store.getState().countdown ?? 0) - 1;
    if (left > 0) store.setState({ countdown: left });
    else titlePlayer.playNext();
  }, 1000);
}

/** Plays the element at `speed`, and starts each run after this at it too. */
function playAt(speed: number): void {
  video.defaultPlaybackRate = speed;
  video.playbackRate = speed;
}

function stopEngine(): void {
  engine?.destroy();
  engine = null;
  if (checkpoint) clearInterval(checkpoint);
  checkpoint = null;
}

/** Ends the run if the title is still paused in a while, however it came to be paused. */
function releaseLater(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(releaseRun, RELEASE_AFTER_PAUSE_MS);
}

/**
 * Whether the viewer has the title paused: paused now, or starting a run that holds its picture.
 * A second skip or track change before that run starts keeps it paused too.
 */
function pausedByViewer(): boolean {
  const { phase } = store.getState();
  return (
    phase.kind === "paused" ||
    (holding && (phase.kind === "starting" || phase.kind === "reconnecting"))
  );
}

/** Ends the run after a long pause; playing again starts one where it stopped. */
function releaseRun(): void {
  // Not at the end: the element pauses just before it ends, and the end screen stays.
  if (!engine || !video.paused || store.getState().phase.kind !== "paused") return;
  released = engine.position();
  stopEngine();
  store.setState({ phase: { kind: "paused" }, position: released });
}

/**
 * Starts a run at `start` with the chosen tracks, held on its first picture when `paused`.
 * `attempt` counts reconnects.
 */
async function run(start: number, attempt = 0, paused = false): Promise<void> {
  if (!session) return;
  const mine = ++generation;
  stopEngine();
  stopCountdown();
  released = null;
  holding = paused;
  const { audioId, subtitle, duration } = store.getState();
  store.setState({
    phase:
      attempt === 0
        ? { kind: "starting" }
        : { kind: "reconnecting", attempt, of: RECONNECT_DELAYS_MS.length },
    position: start,
    subtitleStatus: subtitle ? "loading" : null,
  });
  const started = titleEngine(video, {
    url: session.url,
    start,
    audio: audioId,
    subtitle: subtitle?.id ?? null,
    page: subtitle?.page ?? null,
    convertSound,
    duration,
    paused,
  });
  engine = started;
  started.onSubtitles((subtitleStatus) => {
    if (mine === generation) store.setState({ subtitleStatus });
  });
  // Starting a run loads the element afresh, which sets its rate to the default one.
  playAt(store.getState().speed);
  try {
    await started.started;
  } catch (error) {
    if (mine !== generation) return;
    await recover(mine, start, asEngineError(error), attempt, false, paused);
    return;
  }
  if (mine !== generation) return;
  store.setState({ phase: { kind: video.paused ? "paused" : "playing" }, continued: false });
  // A run that starts paused holds the provider's connection until the release, as a pause does.
  if (video.paused) releaseLater();
  // Only playing moves the title on; a checkpoint while paused would make it look watched later.
  checkpoint = setInterval(() => {
    if (store.getState().phase.kind === "playing") save();
  }, CHECKPOINT_MS);
  started.onEnded(() => {
    if (mine !== generation) return;
    const { duration: length } = store.getState();
    store.setState({ phase: { kind: "ended" }, position: length ?? started.position() });
    save();
    void countDown(mine);
  });
  started.onFailure((error) => {
    if (mine !== generation) return;
    const paused = store.getState().phase.kind === "paused";
    void recover(mine, started.position(), error, 0, true, paused);
  });
}

/**
 * What to do about a run that failed: convert the sound once when a copied one didn't start,
 * start again where it was after the connection broke, or give up and say why. A title that was
 * paused, or was changing tracks while paused, comes back paused.
 */
async function recover(
  mine: number,
  position: number,
  error: EngineError,
  attempt: number,
  wasPlaying: boolean,
  paused: boolean,
): Promise<void> {
  const upstream = session
    ? await call("playback.failure", { sessionId: session.id }).catch(() => null)
    : null;
  if (mine !== generation) return;
  stopEngine();
  if (!upstream && !wasPlaying && !convertSound && error.kind !== "network") {
    convertSound = true;
    await run(position, attempt, paused);
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
  if (mine === generation) await run(position, attempt + 1, paused);
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

/** Stops moving the position on between two words of the receiver. */
function stopTicking(): void {
  if (ticking) clearInterval(ticking);
  ticking = null;
}

/** What didn't open or load on the receiver, as the view says it. */
function receiverProblem(cause: unknown): PlaybackProblem {
  const error = appError(cause);
  if (error.kind === "output") {
    return error.failure.kind === "stream"
      ? problemOf(error.failure.failure, { kind: "network", detail: "" })
      : { kind: "receiver", failure: error.failure, lost: false };
  }
  return error.kind === "stream"
    ? problemOf(error.failure, { kind: "network", detail: "" })
    : { kind: "app", error };
}

/**
 * Opens the title for the connected receiver and plays it there from `from` seconds, held on its
 * first picture when `paused`. `keep` are the tracks it had here; without them they are chosen
 * as for this computer, among the subtitles a receiver shows.
 */
async function openOnReceiver(
  mine: number,
  now: NowPlaying,
  from: number,
  keep: { readonly audioId: number | null; readonly subtitle: SubtitleTrack | null } | null,
  paused = false,
): Promise<void> {
  receiver = { sessionId: null, load: null, subtitle: null, paused };
  confirmedMedia = null;
  try {
    const [opened, preferences] = await Promise.all([
      call("output.openTitle", { title: now.title }),
      call("preferences.get").catch((): Preferences | null => null),
    ]);
    if (mine !== generation || !receiver) return;
    receiver.sessionId = opened.sessionId;
    const sound =
      preferences?.audioLanguage ?? preferences?.titleLanguage ?? DEFAULT_TITLE_LANGUAGE;
    const chosen = keep
      ? { audio: keep.audioId, subtitle: keep.subtitle }
      : chooseTracks(
          opened.audio,
          opened.subtitles,
          {
            audioLanguage: sound === ORIGINAL_SOUND ? now.originalLanguage : sound,
            subtitleLanguage: preferences?.subtitleLanguage ?? null,
          },
          new Set(opened.shows),
        );
    store.setState({
      duration: opened.duration,
      audio: opened.audio,
      subtitles: opened.subtitles,
      audioId: opened.audio.some((track) => track.id === chosen.audio) ? chosen.audio : null,
      // A kind the receiver doesn't show stays listed, and isn't the one on screen.
      subtitle:
        chosen.subtitle && opened.shows.includes(chosen.subtitle.format) ? chosen.subtitle : null,
      shows: opened.shows,
    });
  } catch (cause) {
    if (mine !== generation) return;
    store.setState({ phase: { kind: "failed", problem: receiverProblem(cause) } });
    return;
  }
  // One that played to its end stays there, open on this receiver for Play again.
  if (store.getState().phase.kind === "ended") return;
  await loadOnReceiver(from, paused);
}

/** Has the receiver play the open title from `start` seconds with the chosen tracks. */
async function loadOnReceiver(start: number, paused = false): Promise<void> {
  const { now, audioId, subtitle } = store.getState();
  if (!receiver?.sessionId || !now) return;
  const mine = ++generation;
  stopCountdown();
  stopTicking();
  released = null;
  receiver.load = null;
  receiver.paused = paused;
  confirmedMedia = null;
  store.setState({ phase: { kind: "starting" }, position: start, confirmed: null });
  try {
    const media = await call("output.playTitle", {
      sessionId: receiver.sessionId,
      position: start,
      audio: audioId,
      subtitle: subtitle?.id ?? null,
      paused,
      name: now.name,
      detail: now.detail,
      artworkUrl: now.artworkUrl,
    });
    if (mine !== generation || !receiver) {
      // Stopped or closed meanwhile: the receiver is told so. One a later load replaced has gone.
      void call("output.command", { generation: media.generation, command: "stop" }).catch(
        () => {},
      );
      return;
    }
    receiver.load = media.generation;
    receiver.subtitle = subtitle?.id ?? null;
    // What the receiver said of it before this answer arrived.
    const said = outputs.media();
    if (said?.generation === media.generation) follow(said);
  } catch (cause) {
    if (mine !== generation) return;
    store.setState({ phase: { kind: "failed", problem: receiverProblem(cause) } });
  }
}

/** Takes the receiver's word on the load that plays: its state, its position and its length. */
function follow(media: RemoteMedia): void {
  const before = store.getState();
  confirmedMedia = media;
  const at = positionOf(media);
  // A skip the receiver hasn't caught up with keeps the position where the viewer put it.
  const skipping =
    before.confirmed !== null && media.state !== "ended" && Math.abs(at - before.position) > 3;
  const next = { duration: media.duration ?? before.duration };
  switch (media.state) {
    case "loading":
    case "buffering":
      store.setState({
        ...next,
        phase: { kind: "starting" },
        ...(skipping ? { confirmed: at } : { position: at, confirmed: null }),
      });
      break;
    case "playing":
    case "paused":
      if (receiver) receiver.paused = media.state === "paused";
      store.setState({
        ...next,
        phase: { kind: media.state },
        continued: false,
        ...(skipping ? { confirmed: at } : { position: at, confirmed: null }),
      });
      break;
    case "ended": {
      if (before.phase.kind === "ended") break;
      const length = media.duration ?? before.duration;
      store.setState({
        ...next,
        phase: { kind: "ended" },
        position: length ?? at,
        confirmed: null,
      });
      // The main process saved how far it got. That its series is finished is said from here.
      const { now, next: after } = store.getState();
      if (after === null && now?.series && !seriesFinished) {
        seriesFinished = true;
        const seriesIds = now.series.title.versions.map((version) => version.id);
        void call("viewing.finishSeries", { commandId: crypto.randomUUID(), seriesIds }).catch(
          () => {},
        );
      }
      void countDown(generation);
      break;
    }
  }
  stopTicking();
  if (media.state === "playing") {
    ticking = setInterval(() => {
      if (!confirmedMedia || store.getState().confirmed !== null) return;
      store.setState({ position: positionOf(confirmedMedia) });
    }, 500);
  }
}

/** Tells the receiver about the load that plays; nothing when none does. */
function command(
  request:
    | { readonly command: "play" | "pause" | "stop" }
    | { readonly command: "seek"; readonly position: number }
    | { readonly command: "subtitles"; readonly on: boolean },
): void {
  if (receiver?.load == null) return;
  void call("output.command", { generation: receiver.load, ...request }).catch(() => {});
}

/**
 * Stops following the receiver that had the title, which is gone or was let go of: its session
 * and its load are no more, and what was still asked of it answers nobody. Whether the title was
 * held paused stays, for whatever plays it next. Returns where it was: where the viewer skipped
 * to, else the receiver's last word, moved on while it played.
 */
function stopFollowing(): number {
  const { position, confirmed } = store.getState();
  const at =
    confirmed === null && confirmedMedia?.state === "playing"
      ? positionOf(confirmedMedia)
      : position;
  generation++;
  stopTicking();
  stopCountdown();
  confirmedMedia = null;
  released = null;
  receiver = { sessionId: null, load: null, subtitle: null, paused: receiver?.paused ?? false };
  return at;
}

/**
 * The receiver that had the title makes way for another, or is reached again after its connection
 * broke. Nothing plays the title until one answers: it waits where it was, as while it opens, and
 * one that played to its end stays at its end.
 */
function awaitReceiver(): number {
  const ended = store.getState().phase.kind === "ended";
  const at = stopFollowing();
  store.setState({
    position: at,
    confirmed: null,
    ...(ended ? {} : { phase: { kind: "opening" } }),
  });
  return at;
}

/**
 * Moves the title to the receiver that just connected, at its position and with its tracks. One
 * that plays here ends its run and session first. One a receiver had already is opened and loaded
 * afresh, as the receiver that answered has nothing of it: paused when it was, and only opened
 * when it had played to its end. `media` is what that receiver plays as it connects.
 */
function moveToReceiver(media: RemoteMedia | null): void {
  const { now, position, audioId, subtitle } = store.getState();
  if (!now) return;
  if (receiver) {
    // It plays the load the title follows, as one taken up before this word of it came: nothing
    // took its place.
    if (media && media.generation === receiver.load) return follow(media);
    const { paused } = receiver;
    const at = awaitReceiver();
    return void openOnReceiver(++generation, now, at, { audioId, subtitle }, paused);
  }
  const paused = pausedByViewer();
  save();
  const mine = ++generation;
  stopCountdown();
  stopEngine();
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  const at = released ?? position;
  released = null;
  if (session) void call("playback.close", { sessionId: session.id }).catch(() => {});
  session = null;
  clearSubtitles(video);
  playAt(1);
  store.setState({ phase: { kind: "opening" }, subtitleStatus: null, speed: 1 });
  void openOnReceiver(mine, now, at, { audioId, subtitle }, paused);
}

/**
 * Brings the title back from the receiver, which let go of it or was let go of, to play here
 * from where it was with its tracks. It goes on playing when the viewer asked for this computer,
 * and is held when the receiver let go by itself, or closes then when its view isn't on screen.
 */
async function moveHere(): Promise<void> {
  const { now, position, phase } = store.getState();
  if (!now || !receiver) return;
  const asked = returning;
  const held = !asked || receiver.paused || phase.kind === "ended";
  returning = false;
  receiver = null;
  confirmedMedia = null;
  stopTicking();
  stopCountdown();
  // Nothing plays here unseen: a title the receiver let go of while the viewer browses closes.
  if (!shown && !asked) return titlePlayer.close();
  const mine = ++generation;
  openedAt = Date.now();
  convertSound = false;
  store.setState({ phase: { kind: "opening" }, shows: null, confirmed: null });
  try {
    const opened = await call("playback.openTitle", {
      title: now.title,
      decoders: [...titleDecoders],
    });
    if (mine !== generation) {
      void call("playback.close", { sessionId: opened.sessionId }).catch(() => {});
      return;
    }
    session = { id: opened.sessionId, url: opened.url };
    store.setState({ duration: opened.duration, audio: opened.audio, subtitles: opened.subtitles });
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
  await run(position, 0, held);
}

/** Follows where playback goes: to a receiver that connected, back from one, and its word meanwhile. */
function outputChanged(status: OutputStatus, before: OutputStatus): void {
  const { output } = status;
  if (!store.getState().now) return;
  if (output.kind === "receiver" && before.output.kind !== "receiver") {
    return moveToReceiver(output.media);
  }
  if (!receiver) return;
  if (output.kind === "local") return void moveHere();
  if (output.kind === "connecting") {
    if (before.output.kind !== "connecting") awaitReceiver();
    return;
  }
  if (output.kind === "lost") {
    store.setState({
      position: stopFollowing(),
      confirmed: null,
      phase: {
        kind: "failed",
        problem: { kind: "receiver", failure: output.failure, lost: true },
      },
    });
    return;
  }
  if (receiver.load === null) return;
  if (output.media?.generation === receiver.load) return follow(output.media);
  if (output.media) return;
  // The receiver holds the load no more: it failed there, or was stopped there.
  const position = confirmedMedia ? positionOf(confirmedMedia) : store.getState().position;
  receiver.load = null;
  stopTicking();
  stopCountdown();
  if (output.failure) {
    const { failure } = output;
    store.setState({
      position,
      confirmed: null,
      phase: {
        kind: "failed",
        problem:
          failure.kind === "stream"
            ? problemOf(failure.failure, { kind: "network", detail: "" })
            : { kind: "receiver", failure, lost: false },
      },
    });
  } else if (store.getState().phase.kind !== "ended") {
    released = position;
    receiver.paused = true;
    store.setState({ position, confirmed: null, phase: { kind: "paused" } });
  }
}

outputs.subscribe(outputChanged);

export const titlePlayer = {
  /**
   * Opens a title and plays it from `from` seconds: the resume position, or 0 to start at the
   * beginning. Closes whatever played before, live or on demand. `continued` is for `playNext`.
   */
  async open(now: NowPlaying, from: number, continued = false): Promise<void> {
    const before = store.getState();
    const sameSeries =
      before.now?.title.kind === "episode" &&
      now.title.kind === "episode" &&
      before.now.title.seriesId === now.title.seriesId;
    titlePlayer.close();
    // Subtitle timing belongs to a file; a new title starts on time.
    setSubtitleDelay(video, 0);
    player.makeWay();
    const mine = ++generation;
    openedAt = Date.now();
    convertSound = false;
    lastSubtitle = null;
    seriesFinished = false;
    store.setState({
      ...idle,
      now,
      phase: { kind: "opening" },
      position: from,
      speed: sameSeries ? before.speed : 1,
      next:
        now.series && now.title.kind === "episode" ? nextEpisode(now.series, now.title) : undefined,
      continued,
    });
    if (outputs.remote()) return openOnReceiver(mine, now, from, null);
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
      // The sound picked last or in Settings, else the movies and series language, English to
      // begin with. "original" is the language the title was made in, or the file's own choice.
      const sound =
        preferences?.audioLanguage ?? preferences?.titleLanguage ?? DEFAULT_TITLE_LANGUAGE;
      const chosen = chooseTracks(
        opened.audio,
        opened.subtitles,
        {
          audioLanguage: sound === ORIGINAL_SOUND ? now.originalLanguage : sound,
          subtitleLanguage: preferences?.subtitleLanguage ?? null,
        },
        SHOWN_SUBTITLES,
      );
      store.setState({
        duration: opened.duration,
        audio: opened.audio,
        subtitles: opened.subtitles,
        audioId: chosen.audio,
        subtitle: chosen.subtitle,
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
    if ((!session && !receiver?.sessionId) || phase.kind === "opening") return;
    const target = Math.max(0, Math.min(position, (duration ?? Infinity) - 1));
    stopCountdown();
    if (receiver) {
      // A receiver that played to the end, or was stopped, holds nothing to skip in.
      if (phase.kind === "ended" || phase.kind === "failed" || receiver.load === null) {
        return void loadOnReceiver(target, phase.kind === "paused");
      }
      store.setState((state) => ({
        position: target,
        confirmed: state.confirmed ?? state.position,
      }));
      return command({ command: "seek", position: target });
    }
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
    // A skip while paused stays paused, on the new picture.
    void run(target, 0, pausedByViewer());
  },

  /** Skips back or forward by `seconds`. */
  skip(seconds: number): void {
    titlePlayer.seek(store.getState().position + seconds);
  },

  togglePause(): void {
    const { phase, position } = store.getState();
    if (receiver) {
      if (phase.kind === "ended") titlePlayer.seek(0);
      else if (phase.kind === "failed") titlePlayer.retry();
      else if (receiver.load === null) void loadOnReceiver(released ?? position);
      else command({ command: phase.kind === "paused" ? "play" : "pause" });
      return;
    }
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
    const { now, phase, position, continued, audioId, subtitle } = store.getState();
    if (!now || phase.kind !== "failed") return;
    if (receiver) {
      // A receiver that is gone has to be connected to again, which loads the title there again.
      if (phase.problem.kind === "receiver" && phase.problem.lost) return outputs.reconnect();
      // Opened afresh: what failed may have closed its session.
      store.setState({ phase: { kind: "opening" } });
      return void openOnReceiver(++generation, now, position, { audioId, subtitle });
    }
    if (session) void run(position);
    else void titlePlayer.open(now, position, continued);
  },

  /**
   * Plays the episode after the open one from its beginning, in the same version of the series,
   * once this one has closed: for the countdown, Next, N and the system's next track. Does nothing
   * for movies, after the last episode, and while the next episode is already starting.
   */
  playNext(): void {
    const { now, next, continued, phase } = store.getState();
    if (!now?.series || !next || (continued && phase.kind !== "failed")) return;
    void titlePlayer.open(episodeNow(now.series, next), 0, true);
  },

  /** Stops the countdown to the next episode, leaving the end on screen. */
  cancelNext(): void {
    stopCountdown();
  },

  /**
   * Holds the countdown to the next episode while `held`, as while Settings is open over the
   * title, so nothing starts behind it. Let go, it carries on from the seconds it had left; one
   * that started meanwhile, at an episode's end, starts counting then.
   */
  holdNext(held: boolean): void {
    if (held === countdownHeld) return;
    countdownHeld = held;
    if (held) {
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = null;
    } else if (store.getState().countdown !== null) {
      tickCountdown();
    }
  },

  /** Plays another sound track from where the title is, and remembers its language. */
  setAudio(id: number): void {
    const { audio, position } = store.getState();
    const track = audio.find((each) => each.id === id);
    if (!track || (!session && !receiver)) return;
    store.setState({ audioId: id });
    if (track.language) {
      void call("preferences.update", { audioLanguage: track.language }).catch(() => {});
    }
    // Another sound track is another load on a receiver, from where it is.
    if (receiver) return void loadOnReceiver(position, receiver.paused);
    save();
    void run(position, 0, pausedByViewer());
  },

  /** Shows another subtitle track, or none, and remembers the choice. */
  setSubtitle(track: SubtitleTrack | null): void {
    const { position, shows } = store.getState();
    if (receiver) {
      // Only the kinds a receiver shows: the others are listed, and play here only.
      if (track && !shows?.includes(track.format)) return;
      store.setState({ subtitle: track });
      if (track) lastSubtitle = track;
      rememberSubtitles(track);
      // The load carries one track: showing or hiding it is a word, another track a new load.
      if (!track) command({ command: "subtitles", on: false });
      else if (receiver.load !== null && receiver.subtitle === track.id) {
        command({ command: "subtitles", on: true });
      } else void loadOnReceiver(position, receiver.paused);
      return;
    }
    if ((track && !SHOWN_SUBTITLES.has(track.format)) || !session) return;
    store.setState({ subtitle: track });
    if (track) lastSubtitle = track;
    rememberSubtitles(track);
    // Turning subtitles off is instant, and stays off; showing others needs a new run.
    if (!track) {
      store.setState({ subtitleStatus: null });
      if (engine) engine.hideSubtitles();
      else clearSubtitles(video);
      return;
    }
    save();
    void run(position, 0, pausedByViewer());
  },

  /** C: subtitles off, or back on: the ones chosen last in this title, else the first. */
  toggleSubtitles(): void {
    const { subtitle, subtitles, shows } = store.getState();
    if (subtitle) {
      lastSubtitle = subtitle;
      return titlePlayer.setSubtitle(null);
    }
    // On a receiver, the first of the kinds it shows.
    const next =
      lastSubtitle ?? subtitles.find((track) => !shows || shows.includes(track.format)) ?? null;
    if (next) titlePlayer.setSubtitle(next);
  },

  /** Plays at `speed` from now on, keeping the pitch. */
  setSpeed(speed: Speed): void {
    // A receiver plays at its own speed.
    if (!store.getState().now || receiver) return;
    store.setState({ speed });
    playAt(speed);
  },

  /** < and >: the next speed down or up; returns the speed now. */
  stepSpeed(direction: -1 | 1): Speed {
    const { speed } = store.getState();
    const next = SPEEDS[SPEEDS.indexOf(speed) + direction] ?? speed;
    titlePlayer.setSpeed(next);
    return next;
  },

  /** The title player's state now, for key handlers that read it once. */
  state(): TitlePlayerState {
    return store.getState();
  },

  /**
   * Brings the title that plays on a receiver back to this computer, where it goes on from where
   * it was: the receiver is let go of first.
   */
  playHere(): void {
    if (!receiver) return;
    returning = true;
    void outputs.local();
  },

  /**
   * Stops the title a receiver plays and closes it here; the receiver stays connected. How far it
   * got, the main process saves.
   */
  stop(): void {
    if (!receiver) return;
    command({ command: "stop" });
    titlePlayer.close();
  },

  /** Whether the title's view is on screen, which says what happens when a receiver lets go. */
  setShown(visible: boolean): void {
    shown = visible;
  },

  /** Whether the open title plays on a receiver. */
  onReceiver: (): boolean => receiver !== null,

  /**
   * Takes up a title a receiver already plays, as when the window opens while it does: what it
   * is, what its file holds and the tracks it plays with. The receiver's word follows.
   */
  adopt(
    now: NowPlaying,
    playing: {
      readonly sessionId: string;
      readonly duration: number;
      readonly audio: readonly AudioTrack[];
      readonly subtitles: readonly SubtitleTrack[];
      readonly shows: readonly SubtitleFormat[];
      readonly audioId: number | null;
      readonly subtitleId: number | null;
    },
    media: RemoteMedia,
  ): void {
    if (store.getState().now) return;
    generation++;
    receiver = {
      sessionId: playing.sessionId,
      load: media.generation,
      subtitle: playing.subtitleId,
      paused: false,
    };
    store.setState({
      ...idle,
      now,
      duration: playing.duration,
      audio: playing.audio,
      subtitles: playing.subtitles,
      audioId: playing.audioId,
      subtitle: playing.subtitles.find((track) => track.id === playing.subtitleId) ?? null,
      shows: playing.shows,
      next:
        now.series && now.title.kind === "episode" ? nextEpisode(now.series, now.title) : undefined,
    });
    follow(media);
  },

  /**
   * Saves how far the title got, then closes it and its provider connection. One that plays on a
   * receiver is only let go of here: the receiver plays on, or what is played next takes its place.
   */
  close(): void {
    const { now, phase } = store.getState();
    if (!now) return;
    if (receiver) {
      generation++;
      stopCountdown();
      stopTicking();
      receiver = null;
      confirmedMedia = null;
      released = null;
      store.setState(idle);
      return;
    }
    save();
    generation++;
    stopCountdown();
    // Still reading the file, before its session is known: stop that too, so no request to the
    // provider outlives the title.
    if (phase.kind === "opening") void call("playback.closeAll").catch(() => {});
    stopEngine();
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = null;
    released = null;
    if (session) void call("playback.close", { sessionId: session.id }).catch(() => {});
    session = null;
    // The element plays live channels next, at their own speed and their subtitles on time.
    playAt(1);
    setSubtitleDelay(video, 0);
    store.setState(idle);
  },
};
