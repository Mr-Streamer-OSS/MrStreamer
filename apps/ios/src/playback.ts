import { appFailure, type AnalyticsFailure } from "@mrstreamer/contracts/analytics";
import type { AppError } from "@mrstreamer/contracts/errors";
import { DEFAULT_NEXT_EPISODE_DELAY } from "@mrstreamer/contracts/preferences";
import { languageCode } from "@mrstreamer/core/ondemand/tracks";
import {
  createVideoPlayer,
  type ObservedItemIdentity,
  type ObservedTrackSelection,
  type ObservedTrackSnapshot,
  type PlaybackObservation,
  type VideoPlayer,
} from "expo-video";
import { appError, describeError, withoutLogin } from "./errors.ts";
import {
  confirms,
  decideAudio,
  decideSubtitles,
  holdOf,
  nextStep,
  observedFileTracks,
  rematch,
  remembered,
  START_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  type MediaPolicy,
  type ObservedFileTracks,
  type PlaybackFailure,
  type TrackContext,
  type TrackHold,
} from "./media-policy.ts";
import {
  effectiveTitleLanguage,
  getMediaPreferences,
  updateMediaPreferences,
  type Speed,
} from "./media-preferences.ts";
import {
  endSubtitleWork,
  hideSubtitle,
  onShownSubtitle,
  playSubtitles,
  shownSubtitle,
  type SubtitleTitle,
} from "./downloaded-subtitles.ts";
import { currentSource, onSignedIn, type Source as SignedInSource } from "./sources.ts";
import { store, useStore, type Store } from "./store.ts";
import { openFormat, type FormatSession, type UnshownSubtitles } from "./title-formats.ts";

// The app's one player and what it plays: a live channel, or a movie or an episode. Every surface
// shows this player and no other: Home's preview, Watch, Picture in Picture and AirPlay, and the
// accessory above the tabs controls it. Nothing opens a second stream for a preview. Playing
// something else, stopping, removing its subscription and a failure each let go of the stream,
// so its local readers drain. Provider disconnect is unobservable. A stream takes its
// subscription's connection from downloads before it opens, with a lease of this process
// (`onAdmission`), and gives it back only once its native and format readers actually closed; a
// downloaded copy plays from the phone and takes none. Downloads deleting a copy waits for every
// reader of it (`playbackReaders`).
//
// A movie or episode in a file AVPlayer can't open, such as Matroska, plays through a format
// session (`title-formats.ts`): the file is read natively, over one request to the provider at a
// time, and this player gets it as HLS from 127.0.0.1. Nothing of a new play reaches the
// provider until every earlier session's request has ended.
//
// A title starts where it is asked to, has a length to seek in, and tells whoever played it how
// far it got: every minute while it plays, when it pauses, and when it stops, fails or gives way
// to something else; and once more when it plays to its end. Its owner saves each, one at a
// time in the order told, whichever play told it, so a slow save never lands after a later one.
// Whatever resumes a title waits for those saves before it reads where it got to
// (`progressSettled`). A refused save is told once, until one is kept again (`onProgressRefused`).
//
// Closing Watch pauses what plays, saving where it got to, unless Picture in Picture or AirPlay
// already shows it, where it plays on with its sound. Stop ends it and saves. Both resolve once
// their save ended, saying whether it was kept.
//
// A movie or an episode plays at the viewer's saved speed (`setSpeed`); a channel, and a programme
// from its catch-up, at their own. What the player says it plays at is `playbackSpeed`.
//
// An episode that plays to its end in Watch counts down to the episode that goes on, once its
// save ended and its owner said which (`upNext`), and plays it at zero. Anything the viewer does
// first ends the countdown for good: Pause, a seek, Close, Stop, any other request or screen.

/** What plays, as the screens name it. */
export interface Playing {
  /** A channel's, movie's or episode's `ownedKey`. */
  readonly id: string;
  /**
   * The subscription whose provider streams it; null for a downloaded copy, which plays from the
   * phone and holds no provider's connection.
   */
  readonly subscriptionId: string | null;
  readonly title: string;
  /** Where the catalogue lists a channel, "Netherlands · News"; a title's line, "S1 E2 · Name". */
  readonly place: string;
  /** A live channel plays on; a title, or a programme from catch-up, has a length. */
  readonly live: boolean;
  /**
   * A channel's programme from its catch-up archive, when it aired: it plays as the channel's own
   * streams do, trying another when one fails, but with a length and never live. Its times count
   * from the programme's start and its length is the programme's, even where the recording
   * starts on the minute before it, is still being made or sends on past it: it stops at the end.
   */
  readonly past?: { readonly start: number; readonly stop: number };
  /** An episode with one after it, which Watch offers. */
  readonly next: boolean;
  /** A title with other versions to try when this one fails. */
  readonly versions: boolean;
  /**
   * A movie's or an episode's version, for online subtitles, made for this play. While one of
   * its downloaded subtitles shows, the file's own are off, and that is never remembered.
   */
  readonly subtitles?: SubtitleTitle;
}

export type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" | "playing" | "paused"; readonly item: Playing }
  | { readonly kind: "failed"; readonly item: Playing; readonly error: string };

export interface Playback {
  readonly phase: Phase;
  /** Watch shows the player full screen. */
  readonly watch: boolean;
  /** Picture in Picture shows it, started from Watch. */
  readonly pip: boolean;
  /** It plays on an AirPlay receiver. */
  readonly external: boolean;
  /**
   * Watch gave way to Downloads or Settings with no Picture in Picture to take the picture over:
   * it waits, paused, for the accessory to bring Watch back (`setAside`).
   */
  readonly aside: boolean;
  /** Home's preview plays without sound until Watch opens or the viewer unmutes it. */
  readonly muted: boolean;
  /**
   * Subscriptions with retired native or format readers still closing, including uncertain closes.
   * The active stream is represented by phase. This does not acknowledge a provider disconnect.
   */
  readonly closing: readonly string[];
}

/** Where a stream is, and its file type as whoever opened it knows it. */
export interface Source {
  /** Rechecks the catalogue/copy authority through format preparation and native admission. */
  readonly admit?: () => void;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** "m3u8" for HLS; a title's listed container, or a copy's. */
  readonly container: string;
  /** Bound by titles.ts to the exact provider row; only original AVPlayer reads report facts. */
  readonly observed?: (tracks: ObservedFileTracks) => void;
  /** Epoch milliseconds a recording from catch-up starts at: its programme's start or before. */
  readonly start?: number;
}

/**
 * The file types a format session plays: Matroska, which AVPlayer can't open. Everything else,
 * live streams always, goes to AVPlayer as it is, as it always did.
 */
const THROUGH_SESSION: ReadonlySet<string> = new Set(["mkv"]);

/** How the latest save of a title's progress ended: kept, or refused with what it was refused for. */
export type Saved = { readonly saved: true } | { readonly saved: false; readonly error: AppError };

/** A title's length in seconds as the player knows it; a programme from catch-up's own. */
const lengthOf = (item: Playing, known: number | null): number =>
  item.past ? (item.past.stop - item.past.start) / 1000 : (known ?? 0);

/** Opens what plays; aborted when the viewer moves on first. */
type Open = (signal: AbortSignal) => Promise<Source>;

export interface LiveCandidate {
  readonly variantId: string;
  readonly open: Open;
}

export type Plan =
  | { readonly kind: "file"; readonly open: Open; readonly originalLanguage: string | null }
  | {
      readonly kind: "live";
      readonly candidates: readonly [LiveCandidate, ...LiveCandidate[]];
      readonly explicit: boolean;
    };

export interface PlayOptions {
  /** In Watch, else in Home's preview. */
  readonly watch: boolean;
  /** What the stream's address carries that no failure the viewer sees may show. */
  readonly login: readonly string[];
  /** Seconds to start a title from. */
  readonly from?: number;
  /**
   * Saves how far a title got, in seconds of its length; rejects when the save was refused, with
   * what was saved before kept. Asked once the save before it, of any play, ended.
   */
  readonly progress?: (position: number, duration: number) => Promise<void>;
  /** A title played to its end. */
  readonly ended?: () => void;
  /** Whether it got as far as playing, said once: true when it first plays, false if it fails. */
  readonly outcome?: (played: boolean) => void;
  /** Plays the episode after this one, once `saved`, this one's save before it, ended. */
  readonly next?: (saved: Promise<Saved>) => void;
  /**
   * The episode that goes on once this one played to its end, as the record stands once `saved`
   * ended; null when none does, the save was refused or the record can't say.
   */
  readonly upNext?: (saved: Promise<Saved>) => Promise<Upcoming | null>;
  /** Shows the title's other versions, after this one failed. */
  readonly versions?: () => void;
}

/** An episode that goes on after the one playing: its line, "S1 E3 · Name", and how it plays. */
export interface Upcoming {
  readonly place: string;
  readonly play: () => void;
}

/** The countdown Watch shows over an episode that played to its end. */
export interface UpNext {
  /** The episode it plays, "S1 E3 · Name". */
  readonly place: string;
  /** Whole seconds left. */
  readonly seconds: number;
}

const state = store<Playback>({
  phase: { kind: "idle" },
  watch: false,
  pip: false,
  external: false,
  aside: false,
  muted: true,
  closing: [],
});
/** Seconds played of the current stream, apart from the rest so only the clock redraws. */
const clock = store(0);
/** A title's length in seconds, once known; 0 for live and before it loaded. */
const length = store(0);

export const usePlayback = () => useStore(state);
/** Read-only, for telemetry, which follows the player without a screen. */
export const playbackState: Pick<Store<Playback>, "get" | "subscribe"> = state;
export const playbackClock: Pick<Store<number>, "get" | "subscribe"> = clock;
export const usePlaybackClock = () => useStore(clock);
export const playbackLength: Pick<Store<number>, "get" | "subscribe"> = length;
export const usePlaybackLength = () => useStore(length);
/**
 * The rate the player says it plays at, or plays at once played again; null before the current
 * stream's first report. Only the native player's own report sets it, never a request.
 */
const speed = store<number | null>(null);
export const playbackSpeed: Pick<Store<number | null>, "get" | "subscribe"> = speed;
export const usePlaybackSpeed = () => useStore(speed);
const upNext = store<UpNext | null>(null);
/** The countdown to the next episode while Watch shows one; null otherwise. */
export const useUpNext = () => useStore(upNext);

/** A channel that plays or is about to, and how it stands, in the accessory's words. */
export interface ChannelStatus {
  readonly id: string;
  readonly word: "Connecting" | "Paused" | "Playing";
}

/**
 * The channel that plays or is about to, for channel lists and tiles to mark with how it stands;
 * none once it failed or stopped, or while a title plays. A movie's key can read like a channel's
 * of the same subscription, so a title never counts.
 */
export function channelStatus(phase: Phase): ChannelStatus | null {
  if (phase.kind === "idle" || phase.kind === "failed" || !phase.item.live) return null;
  const word =
    phase.kind === "loading" ? "Connecting" : phase.kind === "paused" ? "Paused" : "Playing";
  return { id: phase.item.id, word };
}

/**
 * What streams or is about to, a channel or a title; none once it failed or stopped. A new play
 * is a new item, even of the same key, so a return from Picture in Picture can tell it apart.
 */
export function playingItem(phase: Phase): Playing | null {
  return phase.kind === "idle" || phase.kind === "failed" ? null : phase.item;
}

/**
 * A request of the viewer's that waits before it plays or opens anything, as a series' resume
 * waits for its details, or Next episode for how the episodes stand. It stands until the viewer
 * asks for something newer: any other request, any channel or title played, Stop, removing a
 * subscription or another screen. Close, setting Watch aside and Picture in Picture changes
 * also retire deferred viewer actions. Whatever waited checks `stands()` before acting, so a
 * late answer never replaces what the viewer chose since, nor opens Watch over Connect.
 */
export interface Request {
  stands(): boolean;
}

/** Rises with viewer requests and Watch/navigation context changes: only the latest stands. */
let requests = 0;
/** The screen the viewer is on, as navigation reports it. */
let screen = "";

/**
 * When the viewer last sought a position short of this play's end. An end the player sent
 * before that is still on its way for a moment after, while the player's position may not yet be
 * where the viewer moved it: one that arrives within `SEEK_OVERTAKES` milliseconds is obsolete
 * and starts no countdown. A seek to the end supersedes earlier seeks. Pauses are held separately.
 */
let seekAt = -Infinity;
const SEEK_OVERTAKES = 2000;

/** The viewer moved this play to `to` seconds, which ends any countdown. */
function moved(to: number) {
  cancelUpNext();
  const end = length.get();
  seekAt = !end || to < end - 1 ? Date.now() : -Infinity;
}

/** Retires every waiting request, the countdown to a next episode with them. */
function supersede() {
  requests++;
  cancelUpNext();
}

/** Starts a request that has to wait, replacing any waiting before it. */
export function request(): Request {
  supersede();
  const mine = requests;
  return { stands: () => mine === requests };
}

/**
 * Navigation reports the screen the viewer is on. Leaving it ends any waiting request for good,
 * coming back too; the same screen reported again changes nothing.
 */
export function onScreen(path: string) {
  if (path === screen) return;
  screen = path;
  supersede();
}

/** Whether setting Watch aside paused what played, so bringing Watch back plays it again. */
let resumeOnReturn = false;
/** Viewer Pause waits for application and a paused acknowledgement; away clears on return. */
let pauseOnStart: false | "viewer" | "viewer-applied" | "away" = false;
/**
 * Close silenced what it paused, which had sound: Play from paused brings that sound back. A new
 * play, Stop, Watch shown again and the viewer's own mute or unmute each end it.
 */
let soundOnPlay = false;

/** How often a playing title says how far it got. */
const CHECKPOINT_MS = 60_000;

/** One viewer choice, kept across Try again, including its frozen policy and confirmed holds. */
interface Choice {
  readonly item: Playing;
  readonly plan: Plan;
  readonly options: PlayOptions;
  readonly policy: MediaPolicy;
  readonly context: TrackContext;
  readonly holds: { audio?: TrackHold; subtitles?: TrackHold };
}

/** One source binding and recovery budget. Only play and explicit Try again replace it. */
interface Epoch {
  readonly id: number;
  /** The exact binding and its private login parts, including a login restored before lookup. */
  signedIn: SignedInSource | undefined;
  sourceBound: boolean;
  candidate: number;
  playedOn: number | null;
  reconnects: number;
  played: boolean;
  terminal: boolean;
  last: PlaybackFailure | null;
  backoff: ReturnType<typeof setTimeout> | null;
  watchdog: {
    readonly stage: "startup" | "stall";
    spentMs: number;
    armedAt: number | null;
    timer: ReturnType<typeof setTimeout> | null;
    lastMedia: number | null;
  } | null;
  playingSince: number | null;
  playedMs: number;
}

/** A native paused sample acknowledges intent; it never creates viewer intent. */
let held: { readonly by: "viewer" | "away"; acknowledged: boolean } | null = null;
let epochs = 0;

let current: {
  readonly item: Playing;
  readonly choice: Choice;
  readonly options: PlayOptions;
  readonly epoch: Epoch;
  /** Seconds to seek to once the title is ready; null once done. */
  seek: number | null;
  /**
   * Seconds of the stream before what plays starts, which positions leave out: a recording that
   * starts before its programme. 0 otherwise.
   */
  offset: number;
  /** Whether the stream got as far as playing, so a position means something. */
  loaded: boolean;
  /** Where a title was when it was let go of, for Try again. */
  stoppedAt: number | null;
  resource: Resource;
} | null = null;

type FormatReader = ReturnType<typeof openFormat>;
type Group = "audio" | "subtitles";
interface PendingConfirmation {
  readonly kind: "manual" | "hold";
  readonly selection: ObservedTrackSelection;
  readonly revision: number;
  readonly op: number;
  readonly changed: boolean;
  readonly choice: Choice;
}
interface GroupState {
  authority: "automatic" | "hold" | "manual";
  evaluated: number;
  op: number;
  stale: number;
  queued: boolean;
  pending: PendingConfirmation | null;
}
interface Resource {
  readonly id: number;
  /** The item key it plays, `copy:<id>` for a downloaded copy. */
  readonly key: string;
  readonly controller: AbortController;
  readonly sourceStands: () => boolean;
  readonly subscriptionId: string | null;
  readonly automatic: boolean;
  readonly formats: FormatReader[];
  readonly closed: Promise<void>;
  readonly drained: () => void;
  readonly uncertain: (cause: Error) => void;
  readonly opening: Promise<void>;
  readonly opened: () => void;
  itemId: number | null;
  sequence: number;
  timeControl: Extract<PlaybackObservation, { kind: "state" }>["timeControl"] | null;
  retired: boolean;
  detach: ReturnType<VideoPlayer["detachObservedAsync"]> | null;
  settlement: Promise<void> | null;
  session: FormatSession | null;
  tracks: ObservedTrackSnapshot | null;
  querying: Promise<ObservedTrackSnapshot | null> | null;
  readonly audio: GroupState;
  readonly subtitles: GroupState;
  /** Includes queued work, until each operation's readback or drop finishes. */
  audioWork: number;
  accepted: number;
  audioAck: number;
  confirmedSound: string | null | undefined;
  subtitleSound: string | null | undefined;
  selections: Promise<void>;
  viaSession: boolean;
  observed: Source["observed"] | null;
  admit: Source["admit"] | null;
  facts: ObservedFileTracks | null;
  factsRevision: number;
  /** A viewer Pause applied before admission resolves must still suppress its initial play. */
  holdInitialPlay: boolean;
  /** Its subscription's connection lease from downloads, while held. */
  lease: string | null;
  /** A source went to the native player or a format session: they may hold the connection. */
  submitted: boolean;
}
let attempts = 0;
const closing = new Set<Resource>();

/** Capture before Stop. The handle remains bound to these readers, even after another play. */
export function playbackReader(item: Playing): Readonly<{ closed: Promise<void> }> | null {
  return current?.item === item ? { closed: current.resource.closed } : null;
}

/**
 * The readers of item `key` not yet known closed: the one playing, and every retired one still
 * closing, failed or uncertain included. Capture before Stop. Each settles once its native detach
 * was acknowledged and its format sessions closed, and rejects while that stays unknown; saving
 * progress, Pause, Close or a timeout never settles it.
 */
export function playbackReaders(key: string): readonly Promise<void>[] {
  return [
    ...(current?.resource.key === key ? [current.resource] : []),
    ...[...closing].filter((resource) => resource.key === key && resource !== current?.resource),
  ].map((resource) => resource.closed);
}

function stands(resource: Resource): boolean {
  return (
    current?.resource === resource &&
    !resource.retired &&
    !resource.controller.signal.aborted &&
    resource.sourceStands()
  );
}

onSignedIn(() => {
  if (!current || sourceStands(current)) return;
  if (!current.resource.retired) void stop();
  else endRecovery();
});

const attended = () => {
  const { watch, pip, external } = state.get();
  return watch || pip || external;
};

const sourceStands = ({ item, epoch }: NonNullable<typeof current>) =>
  item.subscriptionId === null ||
  !epoch.sourceBound ||
  currentSource(item.subscriptionId) === epoch.signedIn;

function noteClosing() {
  const holding = [
    ...new Set([...closing].flatMap((r) => (r.subscriptionId === null ? [] : [r.subscriptionId]))),
  ];
  const now = state.get().closing;
  if (holding.length !== now.length || holding.some((id, at) => id !== now[at])) {
    state.set((s) => ({ ...s, closing: holding }));
  }
}

/**
 * Retain the real native promise and every format reader until positive closure. The
 * connection lease goes back at once when nothing was submitted, else only after that closure;
 * uncertain closure keeps it for the life of the process.
 */
function retire(resource: Resource) {
  if (resource.settlement) return resource.settlement;
  resource.retired = true;
  for (const group of [resource.audio, resource.subtitles]) {
    group.op++;
    group.pending = null;
  }
  closing.add(resource);
  if (!resource.submitted) giveBack(resource);
  resource.detach = Promise.resolve().then(() => player().detachObservedAsync(resource.id));
  resource.settlement = (async () => {
    const receipt = await resource.detach;
    if (
      receipt?.kind !== "detached" ||
      receipt.attemptId !== resource.id ||
      receipt.localItemExcluded !== true ||
      receipt.appWorkDrained !== true ||
      (resource.itemId !== null && receipt.itemId !== resource.itemId)
    ) {
      throw new Error("Player reader closure was not acknowledged.");
    }
    await resource.opening;
    await Promise.all(resource.formats.map((format) => format.closed));
    closing.delete(resource);
    resource.drained();
    noteClosing();
    giveBack(resource);
  })();
  resource.controller.abort();
  for (const format of resource.formats) format.close();
  noteClosing();
  void resource.settlement.catch(() =>
    resource.uncertain(new Error("Player reader closure was not acknowledged.")),
  );
  return resource.settlement;
}

/** The selection deadline never changes the real closing ledger or resumes a failed selection. */
async function waitForReaders(resource: Resource) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const abort = () => reject(new Error("Selection ended."));
    resource.controller.signal.addEventListener("abort", abort, { once: true });
    resource.opening.then(() => resource.controller.signal.removeEventListener("abort", abort));
  });
  try {
    await Promise.race([
      Promise.all([...closing].map((r) => r.closed)),
      aborted,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("detach-timeout")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let checkpoint: ReturnType<typeof setInterval> | null = null;
const KEPT: Saved = { saved: true };
/** Every save of progress asked so far, one after another, ending with how the latest went. */
let saving: Promise<Saved> = Promise.resolve(KEPT);
/** Whether the latest save was refused, so a run of refusals is told once. */
let refusing = false;
/**
 * Told when a save is refused after one that was kept, unless its subscription went; Watch
 * registers it.
 */
let refused: (() => void) | null = null;
/** Told each failure's category, never its message; telemetry registers it. */
let failed: ((failure: AnalyticsFailure) => void) | null = null;
/** Ends Picture in Picture; Watch registers it while its view can. */
let endPictureInPicture: (() => void) | null = null;
/**
 * How a stream takes its subscription's connection from downloads and gives it back; downloads.ts
 * registers it. `acquire` resolves once the download requests of that subscription ended and the
 * provider had its moment to free the connection, and rejects, so the stream fails, when one
 * didn't end. The same lease asked again joins; `release` of it, early or twice, is harmless.
 */
export interface Admission {
  acquire(subscriptionId: string, lease: string): Promise<void>;
  release(lease: string): void;
}
let admission: Admission | null = null;
/** Names this process's leases, apart from an earlier process's. */
const LEASES = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Gives `resource`'s lease back, once. */
function giveBack(resource: Resource) {
  const { lease } = resource;
  if (lease === null) return;
  resource.lease = null;
  admission?.release(lease);
}

/** Abort this pre-reader wait only. Downloads still settles the real acquisition. */
async function acquireBeforeLookup(resource: Resource, subscriptionId: string) {
  if (!admission) return;
  const lease = `${LEASES}-${resource.id}`;
  resource.lease = lease;
  const { signal } = resource.controller;
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([admission.acquire(subscriptionId, lease), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Tells a title's owner how far it got, if it got anywhere, after the saves asked before.
 * Resolves with how that save went once it ended; kept when there was nothing to save.
 */
function report(): Promise<Saved> {
  const save = current?.options.progress;
  const made = player();
  const duration = made.duration;
  if (
    !current?.loaded ||
    current.item.live ||
    !save ||
    !(duration > 0 && Number.isFinite(duration))
  ) {
    return saving.then(() => KEPT);
  }
  const position = Math.min(made.currentTime, duration);
  saving = saving.then(async (): Promise<Saved> => {
    try {
      await save(position, duration);
      refusing = false;
      return KEPT;
    } catch (cause) {
      const error = appError(cause);
      // A save whose subscription went, as removing its provider stops what plays, wasn't kept,
      // but the viewer chose that: it isn't told, and leaves a run of refusals as it was.
      if (error.kind !== "no-subscription") {
        if (!refusing) refused?.();
        refusing = true;
      }
      return { saved: false, error };
    }
  });
  return saving;
}

/** Resolves once every save of progress asked so far ended, kept or not. */
export function progressSettled(): Promise<void> {
  return saving.then(() => undefined);
}

let created: VideoPlayer | null = null;
/** The player, made on first use. */
export function player(): VideoPlayer {
  if (created) return created;
  const made = createVideoPlayer(null);
  made.timeUpdateEventInterval = 1;
  made.muted = state.get().muted;
  // Installed once, before any attempt. Legacy source/status/time events have no authority.
  made.addListener("playbackObservation", observe);
  made.addListener("isExternalPlaybackActiveChange", ({ isExternalPlaybackActive }) => {
    // An AirPlay receiver keeps playing while the app is in the background.
    made.staysActiveInBackground = isExternalPlaybackActive;
    // Back on the phone with Watch and Picture in Picture closed, Home's preview is silent again.
    const { watch, pip } = state.get();
    const silent = !isExternalPlaybackActive && !watch && !pip;
    if (silent) made.muted = true;
    state.set((s) => ({ ...s, external: isExternalPlaybackActive, muted: silent || s.muted }));
    attentionChanged();
  });
  created = made;
  return made;
}

/** Releases readers independently of the ordered progress-save result. */
function release(): Promise<Saved> {
  const saved = report();
  cancelUpNext();
  endAtLength(false);
  if (current) {
    clearWatchdog(current.epoch);
    playingTime(current.epoch, false);
  }
  if (current?.loaded && !current.item.live) {
    const at = Math.max(0, player().currentTime - current.offset);
    current.stoppedAt = current.item.past ? Math.min(at, lengthOf(current.item, null)) : at;
  }
  if (checkpoint) clearInterval(checkpoint);
  checkpoint = null;
  if (current) void retire(current.resource);
  player().pause();
  clock.set(0);
  length.set(0);
  speed.set(null);
  return saved;
}

function clearWatchdog(epoch: Epoch) {
  if (epoch.watchdog) clearTimeout(epoch.watchdog.timer ?? undefined);
  epoch.watchdog = null;
}

function cancelEpoch(epoch: Epoch) {
  clearTimeout(epoch.backoff ?? undefined);
  epoch.backoff = null;
  clearWatchdog(epoch);
}

function playingTime(epoch: Epoch, playing: boolean) {
  const now = Date.now();
  if (epoch.playingSince !== null) epoch.playedMs += now - epoch.playingSince;
  epoch.playingSince = playing ? now : null;
}

/** One policy decision per failure; an automatic step changes only the Resource. */
function fail(failure: PlaybackFailure): void {
  if (!current || current.resource.retired) return;
  const owned = current;
  const { choice, epoch } = owned;
  epoch.last = failure;
  playingTime(epoch, false);
  clearWatchdog(epoch);
  const step = nextStep(
    failure,
    {
      candidates: choice.plan.kind === "live" ? choice.plan.candidates.length : 1,
      candidate: epoch.candidate,
      playedOn: epoch.playedOn,
      reconnects: epoch.reconnects,
      playedMs: epoch.playedMs,
    },
    {
      live: choice.plan.kind === "live",
      attended: attended(),
      held: held !== null,
      sourceStands: sourceStands(owned),
    },
  );
  if (step.kind === "fail") return terminal(owned);
  release();
  owned.loaded = false;
  epoch.candidate = step.candidate;
  state.set((s) => ({ ...s, phase: { kind: "loading", item: choice.item } }));
  if (current !== owned || epoch.terminal) return;
  if (!attended() || held !== null || !sourceStands(owned)) return terminal(owned);
  if (step.kind === "candidate") return void admit(owned);
  epoch.reconnects = step.reconnects;
  const id = epoch.id;
  epoch.backoff = setTimeout(() => {
    epoch.backoff = null;
    if (current !== owned || current.epoch.id !== id || epoch.terminal) return;
    if (!attended() || held !== null || !sourceStands(owned)) return terminal(owned);
    void admit(owned);
  }, step.delayMs);
}

/** Publishes once even when backoff left every reader retired. */
function terminal(owned: NonNullable<typeof current>): void {
  const { item, options, epoch } = owned;
  const failure = epoch.last;
  if (current !== owned || epoch.terminal || !failure) return;
  epoch.terminal = true;
  cancelEpoch(epoch);
  playingTime(epoch, false);
  const formatFailure = failure.kind === "format" ? failure.failure : null;
  const native = failure.kind === "native" ? failure.failure : null;
  const analytics = formatFailure
    ? appFailure({ kind: "stream", failure: formatFailure })
    : failure.kind === "lookup"
      ? appFailure(failure.error)
      : failure.kind === "deadline"
        ? "network"
        : native?.kind === "auth"
          ? "credentials"
          : native?.kind === "network"
            ? "network"
            : native?.kind === "unsupported" || native?.kind === "decode"
              ? "unsupported"
              : native?.kind === "missing" ||
                  native?.kind === "rate-limit" ||
                  native?.kind === "http"
                ? "unavailable"
                : "app";
  release();
  failed?.(analytics);
  if (!epoch.played) options.outcome?.(false);
  owned.loaded = false;
  const message = formatFailure
    ? describeError({ kind: "stream", failure: formatFailure })
    : failure.kind === "lookup"
      ? describeError(failure.error)
      : failure.kind === "deadline"
        ? failure.stage === "startup"
          ? `No picture or sound within ${START_TIMEOUT_MS / 1000} s.`
          : "The stream stopped delivering data."
        : native?.kind === "network"
          ? "The connection to the provider failed."
          : native?.kind === "unsupported" || native?.kind === "decode"
            ? "Mr. Streamer can't play this file."
            : failure.kind === "detach-timeout"
              ? "The previous stream is still closing. Try again."
              : "The player stopped. Try again.";
  if (current !== owned) return;
  state.set((s) => ({
    ...s,
    phase: {
      kind: "failed",
      item,
      error: withoutLogin(
        message,
        [...options.login, ...(epoch.signedIn?.login ?? [])],
        epoch.signedIn?.uncertain,
      ),
    },
  }));
}

/** Cancel a pending automatic open or backoff, keeping the last real failure. */
function endRecovery() {
  const owned = current;
  if (owned && (owned.epoch.backoff !== null || (owned.resource.automatic && !owned.loaded)))
    terminal(owned);
}

function attentionChanged() {
  if (!attended() || held !== null) endRecovery();
  reconsiderWatchdog();
}

/** Armed time is retained while disarmed. Only actual media progress resets a stall. */
function reconsiderWatchdog(mediaTime?: number): void {
  const owned = current;
  if (!owned || owned.resource.retired || owned.epoch.terminal || !sourceStands(owned)) return;
  const { epoch, resource } = owned;
  const watchdog = epoch.watchdog;
  if (!watchdog) return;
  const now = Date.now();
  clearTimeout(watchdog.timer ?? undefined);
  watchdog.timer = null;
  if (watchdog.armedAt !== null) watchdog.spentMs += now - watchdog.armedAt;
  watchdog.armedAt = null;
  if (watchdog.stage === "stall" && mediaTime !== undefined && Number.isFinite(mediaTime)) {
    if (watchdog.lastMedia !== null && mediaTime > watchdog.lastMedia) watchdog.spentMs = 0;
    watchdog.lastMedia = mediaTime;
  }
  // The initial native paused sample still counts while the app shows Connecting.
  if (
    !attended() ||
    held !== null ||
    (resource.timeControl === "paused" &&
      (watchdog.stage === "stall" || state.get().phase.kind === "paused"))
  )
    return;
  const limit = watchdog.stage === "startup" ? START_TIMEOUT_MS : STALL_TIMEOUT_MS;
  if (watchdog.spentMs >= limit) return fail({ kind: "deadline", stage: watchdog.stage });
  watchdog.armedAt = now;
  watchdog.timer = setTimeout(() => {
    if (current === owned && current.resource === resource && stands(resource))
      reconsiderWatchdog();
  }, limit - watchdog.spentMs);
}

/** Apply the pending viewer Pause only once an actual item exists. */
function applyViewerPause(resource: Resource) {
  resource.holdInitialPlay = true;
  pauseOnStart = "viewer-applied";
  player().pause();
  // Known paused makes app Play available; it does not acknowledge this newer Pause request.
  state.set((s) => {
    if (
      !stands(resource) ||
      resource.timeControl !== "paused" ||
      s.phase.kind !== "loading" ||
      s.phase.item !== current?.item
    )
      return s;
    return { ...s, phase: { kind: "paused", item: s.phase.item } };
  });
}

/** Read current intent after asynchronous admission and complete its initial action. */
function startAttached(resource: Resource) {
  // The rate it plays at; a paused player keeps it for its next play.
  player().playbackRate = speedOf(current);
  if (pauseOnStart === "viewer") applyViewerPause(resource);
  else if (!pauseOnStart && !resource.holdInitialPlay) player().play();
}

function acceptItem(resource: Resource, identity: ObservedItemIdentity) {
  if (
    !stands(resource) ||
    identity.attemptId !== resource.id ||
    !Number.isSafeInteger(identity.itemId) ||
    identity.itemId <= 0 ||
    (resource.itemId !== null && resource.itemId !== identity.itemId)
  )
    return false;
  resource.itemId = identity.itemId;
  return true;
}

function acceptTracks(resource: Resource, tracks: ObservedTrackSnapshot) {
  if (
    !stands(resource) ||
    tracks.attemptId !== resource.id ||
    tracks.itemId !== resource.itemId ||
    (resource.tracks && tracks.revision < resource.tracks.revision)
  )
    return;
  resource.tracks = tracks;
  resource.accepted++;
  onSnapshot(resource);
}

const soundOf = (resource: Resource) =>
  resource.audioWork > 0 ? undefined : resource.confirmedSound;
const selectedId = (tracks: ObservedTrackSnapshot, group: Group) =>
  group === "audio" ? tracks.selectedAudioId : tracks.selectedSubtitleId;
const sameLanguages = (a: readonly (string | null)[], b: readonly (string | null)[]) =>
  a.length === b.length && a.every((language, at) => language === b[at]);

/** Every accepted event or query, including same-revision selection readback, reaches this owner. */
function onSnapshot(resource: Resource) {
  const tracks = resource.tracks;
  if (!tracks || !stands(resource)) return;
  if (tracks.revision > resource.factsRevision) {
    resource.factsRevision = tracks.revision;
    const facts = resource.observed && !resource.viaSession ? observedFileTracks(tracks) : null;
    if (
      facts &&
      (!resource.facts ||
        !sameLanguages(facts.audio, resource.facts.audio) ||
        !sameLanguages(facts.subtitles, resource.facts.subtitles))
    ) {
      resource.facts = facts;
      try {
        resource.observed?.(facts);
      } catch {
        // A facts sink cannot fail playback.
      }
    }
  }
  for (const group of ["audio", "subtitles"] as const) {
    if (!stands(resource)) return;
    tryConfirm(resource, group);
  }
  settleSound(resource);
  for (const group of ["audio", "subtitles"] as const) {
    const state = resource[group];
    if (state.authority !== "manual" && tracks.revision > state.evaluated)
      schedule(resource, group);
  }
}

/** Only the latest post-ack snapshot with all audio work finished confirms the actual sound. */
function settleSound(resource: Resource) {
  const tracks = resource.tracks;
  if (resource.audioWork > 0 || !tracks || !stands(resource)) return;
  if (resource.accepted > resource.audioAck) {
    resource.confirmedSound =
      tracks.audio.state === "ready"
        ? languageCode(
            tracks.audio.options.find((track) => track.id === tracks.selectedAudioId)?.language,
          )
        : tracks.audio.state === "absent"
          ? null
          : undefined;
  }
  const sound = resource.confirmedSound;
  if (
    resource.subtitles.authority !== "manual" &&
    sound !== undefined &&
    sound !== resource.subtitleSound
  ) {
    schedule(resource, "subtitles");
  }
}

/** A requested selection holds and remembers only once an accepted snapshot confirms it. */
function tryConfirm(resource: Resource, group: Group) {
  const state = resource[group];
  const pending = state.pending;
  const tracks = resource.tracks;
  if (!pending || !tracks) return;
  if (!stands(resource) || current?.choice !== pending.choice || state.op !== pending.op) {
    state.pending = null;
    return;
  }
  if (!confirms(pending.selection, pending.revision, tracks)) return;
  state.pending = null;
  if (pending.kind === "hold") {
    state.authority = "manual";
    return;
  }
  pending.choice.holds[group] = holdOf(pending.selection);
  if (!pending.changed) return;
  const memory = remembered(
    pending.selection,
    soundOf(resource),
    getMediaPreferences(),
    pending.choice.context,
  );
  if (memory?.field === "audio") updateMediaPreferences("audio", memory.value);
  else if (memory) updateMediaPreferences("subtitles", memory.value);
}

/** An earlier query cannot stand in for readback of a newer native request. */
async function readbackAfterRequest(resource: Resource) {
  await resource.querying?.catch(() => null);
  if (!stands(resource)) return;
  await refreshTracks(resource);
}

/** `choice`'s version while one of its downloaded subtitles shows: the file's own stay off. */
function downloadedOver(choice: Choice): SubtitleTitle | undefined {
  const title = choice.item.subtitles;
  return title && shownSubtitle()?.title === title ? title : undefined;
}

/** The version a downloaded subtitle showed over when the current file's subtitles were decided. */
let decidedOver: SubtitleTitle | undefined;
// A downloaded subtitle shown or taken away decides the current file's own subtitles anew: off
// while one shows, else as the policy and any confirmed hold say.
onShownSubtitle(() => {
  const over = current ? downloadedOver(current.choice) : undefined;
  if (over === decidedOver) return;
  decidedOver = over;
  const resource = current?.resource;
  if (!current || !resource || !stands(resource)) return;
  const hold = current.choice.holds.subtitles;
  Object.assign(resource.subtitles, groupState(hold), { op: resource.subtitles.op + 1 });
  schedule(resource, "subtitles");
});

/** One pending evaluate-now token per group, deciding from current facts only at dequeue. */
function schedule(resource: Resource, group: Group) {
  const state = resource[group];
  if (!stands(resource) || state.queued || state.authority === "manual") return;
  const choice = current!.choice;
  state.queued = true;
  const token = state.op;
  if (group === "audio") resource.audioWork++;
  resource.selections = resource.selections.then(async () => {
    state.queued = false;
    try {
      if (!stands(resource) || state.op !== token || state.authority === "manual") return;
      const tracks = resource.tracks;
      if (!tracks || (state.pending && state.pending.revision >= tracks.revision)) return;
      state.evaluated = tracks.revision;
      const sound = soundOf(resource);
      if (group === "subtitles") resource.subtitleSound = sound;
      const downloaded = group === "subtitles" && downloadedOver(choice) !== undefined;
      const hold = downloaded ? undefined : choice.holds[group];
      const held = state.authority === "hold" && hold ? rematch(hold, tracks) : null;
      if (held && confirms(held, tracks.revision, tracks)) {
        state.authority = "manual";
        state.pending = null;
        return;
      }
      const decision = held
        ? { kind: "select" as const, selection: held }
        : group === "audio"
          ? decideAudio(tracks, choice.policy, choice.context)
          : decideSubtitles(
              tracks,
              downloaded ? { ...choice.policy, subtitles: { kind: "off" } } : choice.policy,
              choice.context,
              sound,
            );
      if (decision.kind !== "select" || state.stale >= 3) return;
      const op = ++state.op;
      state.pending = null;
      const result = await player().selectObservedTrackAsync(
        tracks,
        tracks.revision,
        decision.selection,
      );
      if (!stands(resource) || state.op !== op) return;
      if (result.kind === "stale") {
        state.stale++;
        return;
      }
      if (result.kind !== "requested") return;
      state.stale = 0;
      if (group === "audio") {
        resource.audioAck = resource.accepted;
        resource.confirmedSound = undefined;
      }
      if (held) {
        state.pending = {
          kind: "hold",
          selection: held,
          revision: tracks.revision,
          op,
          changed: false,
          choice,
        };
        tryConfirm(resource, group);
      }
      await readbackAfterRequest(resource);
      if (!stands(resource) || state.op !== op) return;
    } catch {
      // A refused bridge call changes no authority, hold or accepted preference.
    } finally {
      if (group === "audio" && --resource.audioWork === 0) settleSound(resource);
    }
  });
}

/** Manual intent supersedes older work now; acknowledgement and confirmation are separate. */
function chooseManually(resource: Resource, revision: number, selection: ObservedTrackSelection) {
  if (!stands(resource)) return Promise.resolve();
  const choice = current!.choice;
  const group = selection.kind;
  // A pick over a downloaded subtitle isn't remembered. A download under way ends now, so it can't
  // show over this pick while the native one is requested.
  const downloaded = group === "subtitles" ? downloadedOver(choice) : undefined;
  if (group === "subtitles" && choice.item.subtitles) endSubtitleWork(choice.item.subtitles);
  const state = resource[group];
  const op = ++state.op;
  state.pending = null;
  if (group === "audio") resource.audioWork++;
  resource.selections = resource.selections.then(async () => {
    let dropped = true;
    try {
      const tracks = resource.tracks;
      if (!tracks || !stands(resource) || state.op !== op || tracks.revision !== revision) return;
      if (selection.track ? !selection.track.isPlayable : !tracks.subtitleOffAllowed) return;
      const before = selectedId(tracks, group);
      const result = await player().selectObservedTrackAsync(tracks, revision, selection);
      if (!stands(resource) || state.op !== op || result.kind !== "requested") return;
      dropped = false;
      // The file's own subtitles, once requested, take the downloaded one's place for this
      // version and end a download under way. Decided here, so the change isn't decided again.
      if (group === "subtitles" && choice.item.subtitles) {
        decidedOver = undefined;
        hideSubtitle(choice.item.subtitles);
      }
      state.authority = "manual";
      state.stale = 0;
      if (group === "audio") {
        resource.audioAck = resource.accepted;
        resource.confirmedSound = undefined;
      }
      state.pending = {
        kind: "manual",
        selection,
        revision,
        op,
        changed: !downloaded && before !== (selection.track?.id ?? null),
        choice,
      };
      tryConfirm(resource, group);
      await readbackAfterRequest(resource);
      if (!stands(resource) || state.op !== op) return;
    } catch {
      // Rejection never confirms a pick.
    } finally {
      if (group === "audio" && --resource.audioWork === 0) settleSound(resource);
      if (dropped && stands(resource) && state.op === op) {
        state.evaluated = -1;
        schedule(resource, group);
      }
    }
  });
  return resource.selections;
}

function refreshTracks(resource: Resource): Promise<ObservedTrackSnapshot | null> {
  if (!stands(resource) || resource.itemId === null) return Promise.resolve(null);
  if (resource.querying) return resource.querying;
  const expected = { attemptId: resource.id, itemId: resource.itemId };
  const before = resource.tracks;
  resource.querying = Promise.resolve()
    .then(() => (stands(resource) ? player().getObservedTracksAsync(expected) : null))
    .then(
      (tracks) => {
        if (!tracks || "kind" in tracks || !stands(resource)) return null;
        if (resource.tracks === before) acceptTracks(resource, tracks);
        return resource.tracks;
      },
      () => null,
    )
    .finally(() => {
      resource.querying = null;
    });
  return resource.querying;
}

function observe(event: PlaybackObservation) {
  const resource = current?.resource;
  if (
    !resource ||
    !stands(resource) ||
    event.version !== 1 ||
    event.attemptId !== resource.id ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence <= resource.sequence
  )
    return;
  if (event.kind === "detached") return; // Only the retained promise proves drain.
  if (event.kind === "attached") {
    if (!acceptItem(resource, event)) return;
  } else if (event.kind === "failure" && resource.itemId === null && event.itemId !== null) {
    // A failed preparation may have constructed an item without ever attaching it.
    if (!acceptItem(resource, { attemptId: event.attemptId, itemId: event.itemId })) return;
  } else if (event.itemId !== resource.itemId) return;
  resource.sequence = event.sequence;
  if (!current) return;
  switch (event.kind) {
    case "attached":
      if (pauseOnStart === "viewer") applyViewerPause(resource);
      return;
    case "failure": {
      if (!event.terminal) return;
      const stopped = resource.session?.failure();
      return fail(
        stopped ? { kind: "format", failure: stopped } : { kind: "native", failure: event.failure },
      );
    }
    case "media-services-reset":
      return fail({ kind: "reset" });
    case "ready": {
      if (!current.item.live) length.set(lengthOf(current.item, event.durationSeconds));
      if (current.seek !== null) {
        const from = current.seek + current.offset;
        current.seek = null;
        // A recording still being made would start where it is now, so a programme always seeks.
        if (from > 0 || current.item.past) player().currentTime = from;
      }
      void refreshTracks(resource);
      return;
    }
    case "tracks":
      acceptTracks(resource, event.tracks);
      void refreshTracks(resource);
      return;
    case "ended":
      if (!pauseOnStart && !current.item.live) {
        const saved = report();
        current.options.ended?.();
        if (
          current.item.next &&
          state.get().watch &&
          held?.by !== "viewer" &&
          Date.now() - seekAt > SEEK_OVERTAKES
        )
          countDown(current, saved);
      }
      return;
    case "state": {
      const previous = resource.timeControl;
      resource.timeControl = event.timeControl;
      const playing = event.timeControl === "playing";
      const paused = event.timeControl === "paused";
      if (held && paused) held.acknowledged = true;
      else if (held?.acknowledged && previous === "paused" && playing) held = null;
      const viewerPaused = paused && pauseOnStart === "viewer-applied";
      if (viewerPaused) pauseOnStart = false;
      clock.set(Math.max(0, event.mediaTimeSeconds - current.offset));
      if (event.speed) speed.set(event.speed);
      if (!stands(resource) || resource.sequence !== event.sequence) return;
      endAtLength(playing);
      const { phase } = state.get();
      if (phase.kind === "idle" || phase.kind === "failed") return;
      if (playing && pauseOnStart) {
        if (pauseOnStart === "viewer") applyViewerPause(resource);
        else player().pause();
        return;
      }
      if (playing && !current.loaded) {
        current.loaded = true;
        current.epoch.playedOn ??= current.epoch.candidate;
        if (!current.epoch.played) {
          current.epoch.played = true;
          current.options.outcome?.(true);
          if (!stands(resource)) return;
        }
        if (current.epoch.watchdog?.stage === "startup") {
          clearWatchdog(current.epoch);
          current.epoch.watchdog = {
            stage: "stall",
            spentMs: 0,
            armedAt: null,
            timer: null,
            lastMedia: event.mediaTimeSeconds,
          };
        }
      }
      playingTime(current.epoch, playing);
      if (playing) checkpoint ??= setInterval(report, CHECKPOINT_MS);
      else if (checkpoint !== null) {
        clearInterval(checkpoint);
        checkpoint = null;
      }
      if (!playing && phase.kind === "playing") report();
      const kind = playing
        ? "playing"
        : phase.kind === "loading" && !viewerPaused && !(paused && pauseOnStart)
          ? "loading"
          : "paused";
      if (kind !== phase.kind && stands(resource) && resource.sequence === event.sequence) {
        state.set((s) => ({ ...s, phase: { kind, item: phase.item } }));
      }
      if (stands(resource)) reconsiderWatchdog(event.mediaTimeSeconds);
    }
  }
}

/** Read fixed bridge codes only. Native descriptions and wrapped causes never become UI text. */
function bridgeCode(cause: unknown): string | null {
  for (let depth = 0; depth < 4 && typeof cause === "object" && cause !== null; depth++) {
    if ("code" in cause && cause.code === "ERR_OBSERVED_NOT_DRAINED") return cause.code;
    cause = "cause" in cause ? cause.cause : null;
  }
  return null;
}
let admitted = false;

/** One same-player bootstrap retry yields through the async bridge, without a media reload. */
async function attach(
  resource: Resource,
  source: Parameters<VideoPlayer["replaceObservedAsync"]>[0],
) {
  try {
    const result = await player().replaceObservedAsync(source, resource.id);
    admitted = true;
    return result;
  } catch (cause) {
    if (admitted || !stands(resource) || bridgeCode(cause) !== "ERR_OBSERVED_NOT_DRAINED")
      throw cause;
    const result = await player().replaceObservedAsync(source, resource.id);
    admitted = true;
    return result;
  }
}

/**
 * A new viewer choice freezes the accepted policies and the caller's actual language context.
 * Playing the live channel already chosen again, as a Quality pick does, keeps its confirmed
 * track picks while its login stands: each holds by what describes it until the new stream offers
 * one alike.
 */
export function play(item: Playing, plan: Plan, options: PlayOptions) {
  const { audio, subtitles } = getMediaPreferences();
  const before = current && sourceStands(current) ? current.choice : undefined;
  const choice: Choice = {
    item,
    plan,
    options,
    policy: Object.freeze({ audio, subtitles }),
    context: Object.freeze({
      media: plan.kind,
      titleLanguage: languageCode(effectiveTitleLanguage()),
      originalLanguage: plan.kind === "file" ? languageCode(plan.originalLanguage) : null,
    }),
    holds: item.live && before?.item.live && before.item.id === item.id ? { ...before.holds } : {},
  };
  const started = start(choice, choice.options);
  // Once it is the current play, so the listener below reconsiders its tracks, not the last's.
  playSubtitles(item.subtitles ?? null);
  return started;
}

/** A new budget on the same frozen Choice, including explicit Try again. */
async function start(choice: Choice, options: PlayOptions) {
  supersede();
  seekAt = -Infinity;
  if (current) cancelEpoch(current.epoch);
  release();
  const signedIn =
    choice.item.subscriptionId === null ? undefined : currentSource(choice.item.subscriptionId);
  const epoch: Epoch = {
    id: ++epochs,
    signedIn,
    sourceBound: signedIn !== undefined,
    candidate: 0,
    playedOn: null,
    reconnects: 0,
    played: false,
    terminal: false,
    last: null,
    backoff: null,
    watchdog: null,
    playingSince: null,
    playedMs: 0,
  };
  const resource = makeResource(choice, epoch, false);
  const owned = {
    item: choice.item,
    choice,
    options,
    epoch,
    // A programme from catch-up starts at its start, which its recording can start before.
    seek: options.from ?? (choice.item.past ? 0 : null),
    offset: 0,
    loaded: false,
    stoppedAt: null,
    resource,
  };
  current = owned;
  resumeOnReturn = false;
  pauseOnStart = false;
  soundOnPlay = false;
  held = null;
  state.set((s) => {
    const muted = options.watch || s.watch ? false : s.muted;
    player().muted = muted;
    return {
      ...s,
      phase: { kind: "loading", item: owned.item },
      watch: options.watch || s.watch,
      aside: false,
      muted,
    };
  });
  await runAttempt(owned, resource);
}

function makeResource(choice: Choice, epoch: Epoch, automatic: boolean): Resource {
  const { item } = choice;
  const controller = new AbortController();
  let drained!: () => void;
  let uncertain!: (cause: Error) => void;
  let opened!: () => void;
  const closed = new Promise<void>((resolve, reject) => {
    drained = resolve;
    uncertain = reject;
  });
  void closed.catch(() => undefined); // Admission and reader handles still observe rejection.
  const resource: Resource = {
    id: ++attempts,
    key: item.id,
    controller,
    subscriptionId: item.subscriptionId,
    automatic,
    sourceStands: () =>
      item.subscriptionId === null ||
      !epoch.sourceBound ||
      currentSource(item.subscriptionId) === epoch.signedIn,
    formats: [],
    closed,
    drained,
    uncertain,
    opening: new Promise<void>((resolve) => {
      opened = resolve;
    }),
    opened,
    itemId: null,
    sequence: 0,
    timeControl: null,
    retired: false,
    detach: null,
    settlement: null,
    session: null,
    tracks: null,
    querying: null,
    audio: groupState(choice.holds.audio),
    subtitles: groupState(choice.holds.subtitles),
    audioWork: 0,
    accepted: 0,
    audioAck: 0,
    confirmedSound: undefined,
    subtitleSound: undefined,
    selections: Promise.resolve(),
    viaSession: false,
    observed: null,
    admit: null,
    facts: null,
    factsRevision: -1,
    holdInitialPlay: false,
    lease: null,
    submitted: false,
  };
  return resource;
}

/** Automatic attempts preserve viewer requests, presentation, options, Choice and source binding. */
async function admit(owned: NonNullable<typeof current>) {
  if (current !== owned || owned.epoch.terminal) return;
  if (!sourceStands(owned) || !attended() || held !== null) return terminal(owned);
  const resource = makeResource(owned.choice, owned.epoch, true);
  owned.resource = resource;
  // A recording plays on where it got to, or where it was to start, even from another stream
  // whose recording starts elsewhere; a channel plays live again.
  if (owned.item.past) owned.seek = owned.stoppedAt ?? owned.options.from ?? 0;
  owned.loaded = false;
  owned.epoch.playingSince = null;
  owned.epoch.playedMs = 0;
  await runAttempt(owned, resource);
}

function attemptStands(owned: NonNullable<typeof current>, resource: Resource) {
  if (!stands(resource)) return false;
  if (!recheckPlayback()) return false;
  if (resource.automatic && (!attended() || held !== null)) {
    terminal(owned);
    return false;
  }
  return true;
}

/** Raw catalogue changes revoke a pending or attached source before any later native action. */
export function recheckPlayback(): boolean {
  try {
    current?.resource.admit?.();
    return true;
  } catch (cause) {
    fail({ kind: "lookup", error: appError(cause) });
    return false;
  }
}

/** Every attempt waits for all earlier native/format readers before reclaim or lookup. */
async function runAttempt(owned: NonNullable<typeof current>, resource: Resource) {
  const { item, options, choice, epoch } = owned;
  const { plan } = choice;
  const { controller } = resource;
  const open = plan.kind === "file" ? plan.open : plan.candidates[epoch.candidate]?.open;
  let stage: "readers" | "lookup" | "native" = "native";
  try {
    if (!attemptStands(owned, resource)) return;
    if (!open) return fail({ kind: "bridge" });
    if (player().mrStreamerPlaybackContract !== 1) throw new Error("Player contract unavailable.");
    stage = "readers";
    await waitForReaders(resource);
    if (!attemptStands(owned, resource)) return;
    stage = "lookup";
    if (item.subscriptionId !== null) await acquireBeforeLookup(resource, item.subscriptionId);
    if (!attemptStands(owned, resource)) return;
    if (!epoch.sourceBound) {
      epoch.signedIn =
        item.subscriptionId === null ? undefined : currentSource(item.subscriptionId);
      epoch.sourceBound = true;
    }
    const source = await open(controller.signal);
    resource.admit = source.admit ?? null;
    owned.offset =
      item.past && source.start !== undefined
        ? Math.max(0, (item.past.start - source.start) / 1000)
        : 0;
    if (!attemptStands(owned, resource)) return;
    resource.observed =
      plan.kind === "file" && !item.live && item.subscriptionId !== null
        ? (source.observed ?? null)
        : null;
    let playable = {
      uri: source.url,
      ...(source.headers ? { headers: { ...source.headers } } : {}),
      contentType: source.container === "m3u8" ? ("hls" as const) : ("auto" as const),
    };
    if (!item.live && THROUGH_SESSION.has(source.container.toLowerCase())) {
      resource.submitted = true;
      const opening = openFormat(source.url, source.headers, options.from ?? 0, controller.signal);
      resource.formats.push(opening);
      // Observe failure now, even if opening itself is still pending.
      void opening.closed.catch(() => undefined);
      const opened = await opening.opened;
      if (!attemptStands(owned, resource)) return opening.close();
      if (opened.kind === "session") {
        const { session } = opened;
        resource.session = session;
        resource.viaSession = true;
        void session.failed.then((failure) => {
          if (stands(resource)) fail({ kind: "format", failure });
        });
        playable = { uri: session.playlist, contentType: "hls" };
        owned.seek = null;
      } else {
        await opening.closed;
        if (!attemptStands(owned, resource)) return;
      }
    }
    stage = "native";
    resource.submitted = true;
    if (plan.kind === "live") {
      epoch.watchdog = {
        stage: "startup",
        spentMs: 0,
        armedAt: null,
        timer: null,
        lastMedia: null,
      };
      reconsiderWatchdog();
    }
    if (!attemptStands(owned, resource)) return;
    const result = await attach(resource, playable);
    if (!attemptStands(owned, resource)) return;
    if (result.attemptId !== resource.id) return fail({ kind: "bridge" });
    if (result.kind === "attached") {
      if (!acceptItem(resource, result)) return fail({ kind: "bridge" });
      startAttached(resource);
    } else if (result.kind === "failed") {
      if (
        result.itemId !== null &&
        !acceptItem(resource, { attemptId: result.attemptId, itemId: result.itemId })
      ) {
        return fail({ kind: "bridge" });
      }
      fail({ kind: "native", failure: result.failure });
    } else fail({ kind: "cancelled" });
  } catch (cause) {
    if (!attemptStands(owned, resource)) return;
    if (stage === "lookup") {
      const error = appError(cause);
      fail(
        error.kind === "stream"
          ? { kind: "format", failure: error.failure }
          : { kind: "lookup", error },
      );
    } else fail({ kind: stage === "readers" ? "detach-timeout" : "bridge" });
  } finally {
    resource.opened();
    if (!stands(resource) && !resource.retired) void retire(resource);
  }
}

function groupState(hold: TrackHold | undefined): GroupState {
  return {
    authority: hold ? "hold" : "automatic",
    evaluated: -1,
    op: 0,
    stale: 0,
    queued: false,
    pending: null,
  };
}

/** The candidate actually playing, never a backoff or a failed override. */
export function liveStream() {
  if (!current?.item.live || current.choice.plan.kind !== "live") return null;
  const { kind } = state.get().phase;
  return {
    channel: current.item.id,
    explicit: current.choice.plan.explicit,
    playing:
      kind === "playing" || kind === "paused"
        ? (current.choice.plan.candidates[current.epoch.candidate]?.variantId ?? null)
        : null,
  };
}

/** Plays what failed or stopped again, a title from where it got to. */
export function retry() {
  if (!current) return;
  const { choice, options, stoppedAt } = current;
  const from = stoppedAt ?? options.from;
  void start(choice, {
    ...options,
    watch: state.get().watch,
    ...(from === undefined ? {} : { from }),
  });
}

/**
 * Stops playing and closes Watch, Picture in Picture and the accessory, saving how far a title
 * got. What plays next on Home starts without sound again. Waits for its real reader settlement
 * and reports only the save outcome. Uncertain closure stays blocked in the resource ledger.
 */
export async function stop(): Promise<Saved> {
  supersede();
  if (current) cancelEpoch(current.epoch);
  const saved = release();
  const readers = current?.resource.settlement;
  current = null;
  playSubtitles(null);
  endPictureInPicture?.();
  player().muted = true;
  resumeOnReturn = false;
  pauseOnStart = false;
  soundOnPlay = false;
  held = null;
  state.set((s) => ({
    ...s,
    phase: { kind: "idle" },
    watch: false,
    pip: false,
    aside: false,
    muted: true,
  }));
  // Saved says only whether progress was kept. Reader failure remains in closing and on the
  // captured reader handle, even when Stop returns its save result.
  await readers?.catch(() => undefined);
  return saved;
}

/**
 * Play or Pause, the viewer's own: in Watch, or from the accessory while Watch is set aside, where
 * it replaces setting aside's own pause, so bringing Watch back keeps whatever they chose last.
 * It goes by what the player last reported, as the accessory shows it. Play after Close plays with
 * the sound Close silenced (`soundOnPlay`).
 */
export function togglePause() {
  resumeOnReturn = false;
  cancelUpNext();
  const { phase } = state.get();
  if (phase.kind === "playing" || phase.kind === "loading") {
    held = { by: "viewer", acknowledged: false };
    pauseOnStart = phase.kind === "loading" ? "viewer" : false;
    if (pauseOnStart === "viewer" && current && current.resource.itemId !== null) {
      applyViewerPause(current.resource);
    } else player().pause();
  } else if (phase.kind === "paused") {
    held = null;
    pauseOnStart = false;
    if (soundOnPlay) setMuted(false);
    player().play();
  }
  attentionChanged();
}

/** The speed `owned` plays at: a movie's or an episode's saved one, else its own. */
const speedOf = (owned: typeof current): Speed =>
  owned?.choice.plan.kind === "file" ? getMediaPreferences().titleSpeed : 1;

/**
 * Plays movies and episodes at `next` from now on, saved before it applies: what plays now too,
 * if it is one. False when the save was refused, which leaves the speed as it was.
 */
export function setSpeed(next: Speed): boolean {
  if (!updateMediaPreferences("titleSpeed", next)) return false;
  // One still opening takes it as it attaches.
  if (current?.resource.itemId != null) player().playbackRate = speedOf(current);
  return true;
}

/** Moves by `seconds`; a programme from catch-up, within the programme. */
export function seekBy(seconds: number) {
  const at = player().currentTime - (current?.offset ?? 0) + seconds;
  if (current?.item.past) return seekTo(Math.min(length.get(), at));
  moved(at);
  player().seekBy(seconds);
}

/** Moves a title to `seconds` from its start. */
export function seekTo(seconds: number) {
  const at = Math.max(0, seconds);
  moved(at);
  player().currentTime = at + (current?.offset ?? 0);
  clock.set(at);
  endAtLength(state.get().phase.kind === "playing", at);
}

/** Pauses a programme from catch-up at its end, which no event of the player's marks. */
let ending: ReturnType<typeof setTimeout> | null = null;

/**
 * Times the pause at a programme's end from where it is, or `at` where a seek still lands, while
 * it plays: told each time it starts or stops playing and after each seek. A timer that fires
 * early, as after a seek back, times again from where it is then.
 */
function endAtLength(playing: boolean, at?: number) {
  if (ending) clearTimeout(ending);
  ending = null;
  const owned = current;
  if (!playing || !owned?.item.past) return;
  const left = (from = player().currentTime - owned.offset) => length.get() - from;
  ending = setTimeout(
    () => {
      ending = null;
      if (current !== owned) return;
      if (left() > 0.5) endAtLength(true);
      else player().pause();
    },
    Math.max(0, left(at)) * 1000,
  );
}

export function setMuted(muted: boolean) {
  soundOnPlay = false;
  player().muted = muted;
  state.set((s) => ({ ...s, muted }));
}

/** Existing Watch rows. Selection acknowledges a request; subsequent readback checks the row. */
export interface TrackChoice {
  readonly kind: "track" | "off";
  readonly label: string;
  readonly selected: boolean;
  readonly choose: () => Promise<void>;
}

type Track =
  | ObservedTrackSnapshot["audio"]["options"][number]
  | ObservedTrackSnapshot["subtitles"]["options"][number];

function labelled<T extends Track>(tracks: readonly T[], fallback: string) {
  const labels = tracks.map((track) => track.label || track.language || fallback);
  return tracks.map((track, i) => {
    const label = labels[i] ?? fallback;
    if (labels.indexOf(label) === labels.lastIndexOf(label)) return { track, label };
    const number = labels.slice(0, i + 1).filter((other) => other === label).length;
    return { track, label: `${label} · ${track.name || number}` };
  });
}

/**
 * Query actual groups when the menu opens. A retained row cannot select on a newer item/revision.
 * Null while the group isn't known: nothing plays yet, it is loading or its read failed. An empty
 * list is a known group with nothing playable, or none at all.
 */
export async function trackChoices(
  of: "audio" | "subtitles",
): Promise<readonly TrackChoice[] | null> {
  const resource = current?.resource;
  if (!resource) return null;
  const tracks = await refreshTracks(resource);
  if (!tracks || !stands(resource)) return null;
  const group = of === "audio" ? tracks.audio : tracks.subtitles;
  if (group.state === "absent") return [];
  if (group.state !== "ready") return null;
  const choose = (selection: ObservedTrackSelection) =>
    chooseManually(resource, tracks.revision, selection);
  if (of === "audio") {
    return labelled(
      tracks.audio.options.filter((track) => track.isPlayable),
      "Sound",
    ).map(({ track, label }) => ({
      kind: "track" as const,
      label,
      selected: tracks.selectedAudioId === track.id,
      choose: () => choose({ kind: "audio", track }),
    }));
  }
  return [
    ...(tracks.subtitleOffAllowed
      ? [
          {
            kind: "off" as const,
            label: "Off",
            selected: tracks.selectedSubtitleId === null,
            choose: () => choose({ kind: "subtitles", track: null }),
          },
        ]
      : []),
    ...labelled(
      tracks.subtitles.options.filter((track) => track.isPlayable),
      "Subtitles",
    ).map(({ track, label }) => ({
      kind: "track" as const,
      label,
      selected: tracks.selectedSubtitleId === track.id,
      choose: () => choose({ kind: "subtitles", track }),
    })),
  ];
}

/**
 * The subtitle tracks of the file the current attempt plays that can't show: those a format
 * session doesn't carry, such as pictures. None where every track can, or AVPlayer opened the
 * file itself. Read it beside `trackChoices`, before awaiting that, for the same attempt.
 */
export function unshownSubtitles(): UnshownSubtitles {
  return current?.resource.session?.unshown ?? { named: [], more: 0 };
}

/**
 * Plays the episode after the one playing, saving how far this one got first: its owner is given
 * that save, to read the record once it ended.
 */
export function playNext() {
  const saved = report();
  current?.options.next?.(saved);
}

/** The countdown under way, from asking which episode goes on until it plays or ends. */
let counting: {
  readonly stands: () => boolean;
  play?: () => void;
  timer?: ReturnType<typeof setInterval>;
} | null = null;

/**
 * Ends the countdown, or the ask for which episode it counts to. An episode that ended stays where
 * it ended, its Next episode still offered.
 */
export function cancelUpNext() {
  clearInterval(counting?.timer);
  counting = null;
  upNext.set(null);
}

/**
 * `owned` played to its end in Watch: once its owner says which episode goes on, as the record
 * stands after `saved`, Watch counts down to it, for as long as the desktop app does by default,
 * and plays it at zero. It stands while nothing newer was asked (`supersede` ends it), the same
 * play shows in Watch, and its provider's login stands.
 */
function countDown(owned: NonNullable<typeof current>, saved: Promise<Saved>) {
  const find = owned.options.upNext;
  if (!find) return;
  // A request still waiting, such as Next episode pressed just before the end, goes on.
  cancelUpNext();
  const mine: NonNullable<typeof counting> = {
    stands: () =>
      counting === mine &&
      current === owned &&
      sourceStands(owned) &&
      state.get().watch &&
      playingItem(state.get().phase) === owned.item,
  };
  counting = mine;
  void find(saved).then(
    (next) => {
      if (!next || !mine.stands()) return void (counting === mine && cancelUpNext());
      mine.play = next.play;
      let left = DEFAULT_NEXT_EPISODE_DELAY;
      upNext.set({ place: next.place, seconds: left });
      mine.timer = setInterval(() => {
        if (!mine.stands()) cancelUpNext();
        else if (--left > 0) upNext.set({ place: next.place, seconds: left });
        else playUpNext();
      }, 1000);
    },
    () => counting === mine && cancelUpNext(),
  );
}

/**
 * The system's Play, Pause or Play/Pause, the viewer's own as Watch's buttons are. Like Space in
 * Watch, while an ended episode counts down any of them only ends the countdown. Pause also holds
 * what is paused already, so bringing back a Watch set aside plays nothing.
 */
export function playOrPause(command: "play" | "pause" | "toggle") {
  if (upNext.get()) return cancelUpNext();
  const paused = state.get().phase.kind === "paused";
  if (command === "toggle" || (command === "play" && paused)) return togglePause();
  if (command !== "pause") return;
  if (!paused) return togglePause();
  resumeOnReturn = false;
  cancelUpNext();
}

/** The system's next track: the episode counted down to, at once, else Next episode's. */
export function nextEpisode() {
  if (counting?.play) playUpNext();
  else playNext();
}

/** Plays the episode Watch counts down to at once. */
export function playUpNext() {
  const play = counting?.stands() ? counting.play : null;
  cancelUpNext();
  play?.();
}

/** Shows the other versions of the title that failed. */
export function showVersions() {
  current?.options.versions?.();
}

/**
 * Shows the player full screen, bringing it back from Picture in Picture or from being set aside.
 * What setting it aside paused plays again: a movie or an episode from where it paused, a channel
 * live again rather than from where it paused. What failed meanwhile shows its failure.
 */
export function openWatch() {
  soundOnPlay = false;
  player().muted = false;
  const { pip, aside, phase } = state.get();
  if (pip) endPictureInPicture?.();
  state.set((s) => ({ ...s, watch: true, aside: false, muted: false }));
  const resume = aside && resumeOnReturn;
  if (pauseOnStart === "away") pauseOnStart = false;
  if (held?.by === "away" || resume) held = null;
  resumeOnReturn = false;
  attentionChanged();
  if (!resume || (phase.kind !== "playing" && phase.kind !== "paused")) return;
  if (phase.item.live) retry();
  else if (phase.kind === "paused") {
    pauseOnStart = false;
    player().play();
  }
}

/**
 * Back to the tabs at once, saving where a title got to. Picture in Picture or AirPlay already
 * showing it plays on there, muted or not as it was. Otherwise nothing plays unseen: what plays
 * pauses; what still loads pauses as it starts; what was paused or failed stays so. It goes
 * silent, as Home's preview is, so what plays next on Home starts without sound; Play from the
 * accessory brings back the sound it had (`soundOnPlay`). Resolves with how the save went once
 * it ended; a format session paused keeps its request open for Play.
 */
export function closeWatch(): Promise<Saved> {
  supersede();
  const { pip, external, phase, muted } = state.get();
  const away = !pip && !external;
  if (away) {
    if (phase.kind === "playing" || phase.kind === "loading") {
      held ??= { by: "away", acknowledged: false };
    }
    resumeOnReturn = false;
    if ((phase.kind === "playing" || phase.kind === "loading") && !pauseOnStart) {
      pauseOnStart = "away";
    }
    soundOnPlay = !muted;
    if (phase.kind === "playing") player().pause();
  }
  const silent = away || muted;
  player().muted = silent;
  state.set((s) => ({ ...s, watch: false, aside: false, muted: silent }));
  attentionChanged();
  return report();
}

/**
 * Watch gives way to Downloads or Settings where Picture in Picture can't take the picture over.
 * On AirPlay it plays on, as when Watch closes. Otherwise nothing plays unseen: what plays pauses,
 * what still loads pauses as it starts, and what was paused or failed stays so. The accessory over
 * the tabs shows it as it is and brings Watch back (`openWatch`).
 */
export function setAside() {
  supersede();
  const { phase, external } = state.get();
  if (phase.kind === "idle" || external) return void closeWatch();
  if (phase.kind === "playing" || phase.kind === "loading") {
    held ??= { by: "away", acknowledged: false };
  }
  resumeOnReturn =
    (phase.kind === "playing" || phase.kind === "loading") &&
    pauseOnStart !== "viewer" &&
    pauseOnStart !== "viewer-applied";
  if ((phase.kind === "playing" || phase.kind === "loading") && !pauseOnStart) {
    pauseOnStart = "away";
  }
  if (phase.kind === "playing") player().pause();
  // Paused, it makes no sound; played again from the accessory, it plays as Watch would.
  player().muted = false;
  state.set((s) => ({ ...s, watch: false, aside: true, muted: false }));
  attentionChanged();
}

/**
 * Watch shows again what was set aside, as it stands, when nothing else can bring it back: the
 * tabs and their accessory went, as when the last provider is removed while a downloaded copy
 * waits. A paused copy stays paused where it was; nothing opens again.
 */
export function unsetAside() {
  if (!state.get().aside) return;
  resumeOnReturn = false;
  if (pauseOnStart === "away") pauseOnStart = false;
  if (held?.by === "away") held = null;
  player().muted = false;
  state.set((s) => ({ ...s, watch: true, aside: false, muted: false }));
  attentionChanged();
}

/**
 * Watch reports Picture in Picture starting and ending. It leaves Watch for the tabs, where the
 * accessory controls it; once it ends, Home's preview shows the player again.
 */
export function pictureInPicture(active: boolean) {
  supersede();
  if (active) {
    state.set((s) => ({ ...s, pip: true, watch: false, aside: false }));
    attentionChanged();
    return;
  }
  const { watch } = state.get();
  if (!watch) player().muted = true;
  state.set((s) => ({ ...s, pip: false, muted: s.watch ? s.muted : true }));
  attentionChanged();
}

/**
 * The viewer brought Picture in Picture back to the app rather than closing it: Watch shows the
 * player again, with its sound, before Picture in Picture reports that it ended. Returns what
 * Watch shows, or null when nothing streams in Picture in Picture any more (it stopped or failed
 * first), so there is nothing to return to.
 */
export function restoreFromPictureInPicture(): Playing | null {
  const { phase, pip } = state.get();
  const item = playingItem(phase);
  if (!pip || item === null) return null;
  player().muted = false;
  state.set((s) => ({ ...s, watch: true, muted: false }));
  attentionChanged();
  return item;
}

export function onPlaybackFailure(listener: ((failure: AnalyticsFailure) => void) | null) {
  failed = listener;
}

export function onEndPictureInPicture(end: (() => void) | null) {
  endPictureInPicture = end;
}

export function onAdmission(given: Admission | null) {
  admission = given;
}

export function onProgressRefused(tell: (() => void) | null) {
  refused = tell;
}
