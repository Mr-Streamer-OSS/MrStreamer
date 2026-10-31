// Recordings: local copies of a live channel, captured by this app while it runs. The viewer
// starts one on the channel they see, until a stop time; it ends there, or when the viewer stops
// it or quits, and what it captured stays until the viewer deletes it, whatever room it takes. An
// ended recording plays from this computer as a downloaded copy does, kept where it got to.
//
// Its time is what it owes: when capture stops early for the stream, the disk, the room the viewer
// gave recordings, the computer's sleep, a crash or the system shutting down, the recording pauses
// with a gap from then, and goes on with the rest of its time, appended to its file, once the app
// runs, the computer is awake, a connection is free and there is room. Nothing fills a gap: what
// passed while it paused is missed. Stop, and Quit once the viewer confirmed it, end it for good.
//
// This service is the one owner of recordings. Their records are in recordings.json
// (../recordings/store.ts), each file in a folder of its own, named for its programme
// (`recordingFileName`), beside it or in the folder the viewer chose (storage.json). A record is
// written once capture has the stream's program table on disk, and again with how it ended, only
// after its provider request ended and its file closed: the list never claims more than the file
// holds. A record still recording as the app starts is one the app didn't see end, as after a
// crash: it goes on, from a gap since its file was last written, or, its time over, counts as cut
// short by the quit. A recording's folder a crash left before its record was written goes then.
//
// Capture takes one of its subscription's connections through PlaybackCoordination, which
// admits it only while fewer than the account's limit are held here, and keeps it until it ends:
// nothing playing or downloading stops for it, unless the viewer stops playing to record, and
// nothing takes it back. Capture itself is in ../recordings/capture.ts.
//
// Schedules start recordings the same way, at their padded times (../recordings/schedules.ts),
// and are kept in schedules.json beside the records. A loop checks them at the next start, at
// most a minute apart so a clock that was set or slept catches up, when the computer wakes, and
// as the lists, the guide or the recordings change. One whose time came while every connection
// was held waits, asking again every few seconds, and records the rest of its time once one is
// free; nothing stops for it. One whose time came while the app was away records the rest, late,
// and one whose time passed records a missed result. A programme schedule follows the guide's end
// for its start, and holds while the guide lists another programme or none then: it never records
// another show by its title or time. Each start reads its subscription's login as it is then, so
// a replaced login is the one used, and a removed subscription takes its schedules with it.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ConnectionHolder,
  Recording,
  RecordingConnections,
  RecordingCut,
  RecordingGap,
  RecordingGapReason,
  RecordingLimits,
  RecordingPlan,
  RecordingStart,
  RecordingStorage,
  ScheduledRecording,
  ScheduleMiss,
  ScheduleStatus,
} from "@mrstreamer/contracts/recordings";
import { RECORDING_MAX_MS } from "@mrstreamer/contracts/recordings";
import { ownedId, ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { streamsToPlay } from "@mrstreamer/core/catalogue/variants";
import { Failed } from "@mrstreamer/core/failure";
import { Guide } from "@mrstreamer/core/guide/service";
import { t } from "@mrstreamer/core/i18n";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { SavedSubtitles, subtitlesOfCopy } from "../platform/saved-subtitles.ts";
import { CaptureFailure, startCapture, type CaptureEnd } from "../recordings/capture.ts";
import {
  conflictOf,
  nextOccurrence,
  occurrences,
  type Holding,
  type Occurrence,
} from "../recordings/schedules.ts";
import {
  readRecordings,
  readSchedules,
  readStorage,
  recordingFileName,
  writeRecordings,
  writeSchedules,
  writeStorage,
  type KeptSchedule,
  type KeptStorage,
  type StoredRecording,
} from "../recordings/store.ts";
import { Library } from "./library.ts";
import { Playback, type LocalCopy } from "./playback.ts";
import { PlaybackCoordination } from "./playback-coordination.ts";
import { Settings } from "./preferences.ts";
import { Subscriptions } from "./subscription.ts";

/** How often the window hears a recording grow, at most. */
const CHANGES_MS = 1000;
/** The longest the schedules go unchecked, so a clock that was set or slept catches up. */
const CHECK_MS = 60_000;
/** How soon a schedule waiting for a connection asks again; one whose start failed, a minute. */
const RETRY_MS = 10_000;
/** How far back a long absence writes missed results. */
const MISSED_KEPT_MS = 7 * 24 * 60 * 60_000;
/** A schedule that starts within this of its time started on time. */
const ON_TIME_MS = 60_000;
/** How long the guide settles after a change before the schedules follow it. */
const GUIDE_SETTLE = "2 seconds";
/** How long the free space of a recording's disk is taken as measured, while it records. */
const ROOM_MS = 5000;
/** A recording's own folder, by its id: one a crash left before its record goes. */
const RECORDING_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How `Recordings.start` records, beside its stop time. */
export interface StartOptions {
  /**
   * The channel's streams to try, by id, in order; else those playback would try: the one chosen
   * for it before, or Auto's.
   */
  readonly variants?: readonly string[];
  /** Closes what plays of its subscription first. */
  readonly stopPlaying?: boolean;
}

export interface RecordingsDeps {
  readonly dataDir: string;
  readonly userAgent: string;
}

export class Recordings extends Context.Service<
  Recordings,
  {
    /** Every recording, newest first. Fails while recordings.json can't be read. */
    readonly list: Effect.Effect<readonly Recording[], Failed>;
    /** What holds the subscription's connections now, against the account's limit. */
    connections(subscriptionId: string): Effect.Effect<RecordingConnections, Failed>;
    /**
     * Records `channel` from now until `stop`, through the first of its streams to try whose
     * stream has a program table. Busy, starting nothing, while every connection the account
     * allows is held here. Answers once the table is on disk and the record written.
     */
    start(
      channel: OwnedId,
      stop: number,
      options?: StartOptions,
    ): Effect.Effect<RecordingStart, Failed>;
    /**
     * Stops a recording, capturing or paused, for good, answering once its request ended and how
     * it ended is written down.
     */
    stop(id: string): Effect.Effect<void, Failed>;
    /**
     * Deletes an ended recording, its file and the subtitles kept for it, closing what plays it
     * first.
     */
    remove(id: string): Effect.Effect<void, Failed>;
    /**
     * A subscription is going: its recordings stop as the viewer stops one, their requests over
     * before this answers. What they captured stays.
     */
    subscriptionGone(subscriptionId: string): Effect.Effect<void>;
    /**
     * An ended recording's file for playback to open, with where it got to; null when no recording
     * has that id. Fails, listing it as missing, when its file went.
     */
    copy(id: string): Effect.Effect<LocalCopy | null, Failed>;
    /** Keeps how far an ended recording played. */
    recordProgress(id: string, position: number, duration: number): Effect.Effect<void, Failed>;
    /** Where new recordings go, the room they may take, and how much they take. */
    readonly storage: Effect.Effect<RecordingStorage, Failed>;
    setLimits(limits: RecordingLimits): Effect.Effect<RecordingStorage, Failed>;
    /** Sends new recordings to `folder`, once it can be written to. */
    setFolder(folder: string): Effect.Effect<RecordingStorage, Failed>;
    /** The computer is going to sleep: what records pauses, to go on after it wakes. */
    readonly suspend: Effect.Effect<void>;
    /**
     * How the app's close ends what records: `quit`, as the viewer confirmed, for good; `away`,
     * as the system shuts down, to go on when the app runs again. Quit unless told.
     */
    leave(how: "quit" | "away"): Effect.Effect<void>;
    /** Whether a recording's time goes on, capturing or paused, and whether a schedule is kept. */
    readonly live: Effect.Effect<{ readonly recording: boolean; readonly scheduled: boolean }>;
    /** The list after each change, and as recordings grow, about once a second. */
    readonly changes: Stream.Stream<readonly Recording[]>;
    /** Every schedule, by when it records next. Fails while schedules.json can't be read. */
    readonly schedules: Effect.Effect<readonly ScheduledRecording[], Failed>;
    /**
     * How `plan` would stand, saved as a new schedule, or as the one `id` names. Fails when its
     * channel isn't listed, or it has no time to come.
     */
    plan(plan: RecordingPlan, id?: string): Effect.Effect<ScheduledRecording, Failed>;
    /** Saves `plan` as a new schedule, or as the one `id` names, and answers it as saved. */
    schedule(plan: RecordingPlan, id?: string): Effect.Effect<ScheduledRecording, Failed>;
    /** Takes a schedule out; a recording it started goes on. */
    cancel(id: string): Effect.Effect<void, Failed>;
    /**
     * Checks the schedules now, as when the computer wakes or the clock may have moved, answering
     * once the check is done. Starts it asks for go on in the background.
     */
    readonly check: Effect.Effect<void>;
    /** The schedules after each change. */
    readonly scheduleChanges: Stream.Stream<readonly ScheduledRecording[]>;
  }
>()("mrstreamer/Recordings") {
  static readonly layer = (deps: RecordingsDeps) => Layer.effect(Recordings, make(deps));
}

/** What holds a schedule back from recording. */
type Hold = Extract<ScheduleStatus, { readonly kind: "gone" | "changed" }>;
const gone: Hold = { kind: "gone" };

/** A recording that captures now. */
interface Active {
  readonly controller: AbortController;
  readonly bytes: () => number;
  /**
   * Why it was asked to end before its stop time: for good, as stopped or quit, or `away`, as the
   * computer sleeps or shuts down, to go on later.
   */
  asked: "stopped" | "quit" | "away" | null;
  /** Settles once how it ended is written down, with why that couldn't be, if it couldn't. */
  readonly settled: Promise<Failed | null>;
}

/** A recording's gap that goes on now, while it pauses. */
const openGap = (record: StoredRecording): RecordingGap | undefined => {
  const last = record.gaps?.at(-1);
  return last?.to === null ? last : undefined;
};

/** How an interruption names a recording's early end. */
const cutOf = (why: RecordingGapReason) =>
  why === "away" ? "quit" : why === "stream" || why === "busy" ? "stream" : "disk";

/**
 * `record` ended for good at `at`, `as` the viewer stopped it or as cut short, else as its gaps
 * say: a gap it is in ends it where its capture last stopped, and what it missed before stays
 * among its gaps.
 */
function finalOf(
  record: StoredRecording,
  at: number,
  as?: "stopped" | RecordingCut,
): StoredRecording {
  const open = openGap(record);
  const { gaps: all, ...rest } = record;
  const gaps = open ? all?.slice(0, -1) : all;
  const last = open ?? gaps?.at(-1);
  const cut = as ?? (last && cutOf(last.why));
  return {
    ...rest,
    ...(gaps?.length && { gaps }),
    ended: open ? open.from : at,
    status:
      cut === "stopped"
        ? { kind: "stopped" }
        : cut
          ? { kind: "partial", cut }
          : { kind: "complete" },
  };
}

function make(deps: RecordingsDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const library = yield* Library;
    const guide = yield* Guide;
    const playback = yield* Playback;
    const coordination = yield* PlaybackCoordination;
    const settings = yield* Settings;
    const savedSubtitles = yield* SavedSubtitles;
    const root = join(deps.dataDir, "recordings");
    const path = join(root, "recordings.json");
    const storagePath = join(root, "storage.json");
    const changes = yield* PubSub.sliding<readonly Recording[]>(4);
    /** Asks the schedules to be checked: a recording started or ended, or the lists changed. */
    const wakes = yield* Queue.sliding<void>(1);
    const wake = Effect.asVoid(Queue.offer(wakes, undefined));
    /** One write of recordings.json at a time, each with every record as it is then. */
    const writing = (yield* Semaphore.make(1)).withPermits(1);

    const read = yield* Effect.promise(() => readRecordings(path));
    let storage: KeptStorage = yield* Effect.promise(() => readStorage(storagePath));
    const records = new Map<string, StoredRecording>();
    const active = new Map<string, Active>();
    /**
     * Captures still starting, by subscription, which the app's close and a removal stop too, and
     * by recording for one going on after a gap, which its Stop stops. `done` settles once one is
     * active, or has ended and let its connection go.
     */
    const starting = new Map<
      AbortController,
      {
        readonly subscriptionId: string;
        readonly resumes?: string;
        readonly done: Promise<void>;
      }
    >();
    /** Set as the app closes: a start asked for meanwhile would outlive its close. */
    let closing = false;
    /** How the app's close ends what records. */
    let leaving: "quit" | "away" = "quit";
    const folderOf = (record: StoredRecording) => join(record.folder ?? root, record.id);
    const fileOf = (record: StoredRecording) => join(folderOf(record), record.file);
    const isLive = (record: StoredRecording) => record.status.kind === "recording";

    const unreadable = () =>
      new Failed({ error: { kind: "unexpected", detail: t("Recordings could not be read.") } });
    const usable = read.kind === "read" ? Effect.void : Effect.fail(unreadable());
    if (read.kind === "read") {
      const now = Date.now();
      // Never seen to end: its time over, cut short by the quit, with what its file holds; else
      // it goes on, missing the time since its file was last written, or since it paused.
      for (const record of read.items) {
        if (!isLive(record)) {
          records.set(record.id, record);
          continue;
        }
        const file = yield* Effect.promise(() => stat(fileOf(record)).catch(() => null));
        const last = file ? Math.min(file.mtimeMs, record.stop) : record.start;
        const seen = { ...record, bytes: file?.size ?? record.bytes };
        const open = openGap(record);
        if (record.stop <= now)
          records.set(record.id, finalOf(seen, last, open ? undefined : "quit"));
        else
          records.set(record.id, {
            ...seen,
            ...(!open && { gaps: [...(record.gaps ?? []), { from: last, to: null, why: "away" }] }),
          });
      }
      // A recording's folder whose record was never written, as a crash leaves one as it starts.
      for (const folder of new Set([root, storage.folder ?? root])) {
        const entries = yield* Effect.promise(() =>
          readdir(folder, { withFileTypes: true }).catch(() => []),
        );
        for (const entry of entries)
          if (entry.isDirectory() && RECORDING_FOLDER.test(entry.name) && !records.has(entry.name))
            yield* Effect.promise(() =>
              rm(join(folder, entry.name), { recursive: true, force: true }).catch(() => {}),
            );
      }
    }

    /** What a check, or a recording's end, couldn't write, for the next check to write again. */
    const unsaved = { recordings: false, schedules: false };
    /** Recordings whose end the last write of recordings.json couldn't keep. */
    const unsavedEnds = new Set<string>();
    const save = writing(
      Effect.tryPromise({
        try: () => writeRecordings(path, [...records.values()]),
        catch: () =>
          new Failed({
            error: { kind: "unexpected", detail: t("Recordings could not be saved.") },
          }),
      }),
    ).pipe(
      // Every record is written each time: what couldn't be kept before is now.
      Effect.tap(() =>
        Effect.sync(() => {
          unsaved.recordings = false;
          unsavedEnds.clear();
        }),
      ),
    );
    /** Saves, leaving what couldn't be written for the next check to write again. */
    const saveOrLater = save.pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          unsaved.recordings = true;
        }),
      ),
    );

    /** Ended recordings whose file was gone when last looked for: on each read of the list. */
    const missing = new Set<string>();
    const look = Effect.promise(() =>
      Promise.all(
        [...records.values()].map(async (record) => {
          if (isLive(record) || record.status.kind === "missed") return;
          const there = await stat(fileOf(record)).then(
            () => true,
            () => false,
          );
          if (there) missing.delete(record.id);
          else missing.add(record.id);
        }),
      ),
    );
    const shown = Effect.sync(() =>
      [...records.values()]
        .map((record): Recording => {
          const {
            file: _file,
            folder: _folder,
            variants: _variants,
            progress: _progress,
            ...rest
          } = record;
          const marked = unsavedEnds.has(record.id) ? { ...rest, unsaved: true } : rest;
          const capturing = active.get(record.id);
          if (capturing) return { ...marked, bytes: capturing.bytes() };
          if (isLive(record))
            return { ...marked, status: { kind: "paused", why: openGap(record)?.why ?? "away" } };
          return missing.has(record.id) ? { ...marked, status: { kind: "missing" } } : marked;
        })
        .toSorted((a, b) => b.start - a.start),
    );
    const publish = Effect.flatMap(shown, (list) => PubSub.publish(changes, list));
    let pending: NodeJS.Timeout | null = null;
    const grew = () => {
      pending ??= setTimeout(() => {
        pending = null;
        Effect.runFork(publish);
      }, CHANGES_MS);
    };

    // The room recordings may take: what their files take against `storage.space`, and what the
    // disk of each folder they write to keeps free against `storage.keepFree`.
    const capturing = () => [...active.values()].reduce((sum, each) => sum + each.bytes(), 0);
    const used = () =>
      [...records.values()].reduce(
        (sum, record) => sum + (active.get(record.id)?.bytes() ?? record.bytes),
        0,
      );
    const freeIn = (folder: string) =>
      statfs(folder).then(
        ({ bavail, bsize }) => bavail * bsize,
        () => null,
      );
    /** Each folder's free bytes as last measured, and what capture had written by then. */
    const measured = new Map<string, { free: number | null; at: number; written: number }>();
    const measure = async (folder: string) => {
      const written = capturing();
      const known = { free: await freeIn(folder), at: Date.now(), written };
      measured.set(folder, known);
      return known;
    };
    const roomWith = (known: { free: number | null; written: number }) =>
      (storage.space === null || used() < storage.space) &&
      (known.free === null || known.free - (capturing() - known.written) >= storage.keepFree);
    /** Whether capture into `folder` may write on, as last measured, measuring again now and then. */
    const roomOf = (folder: string) => () => {
      const known = measured.get(folder);
      if (!known || Date.now() - known.at > ROOM_MS) {
        // Taken as measured meanwhile, so one measure runs at a time.
        if (known) measured.set(folder, { ...known, at: Date.now() });
        void measure(folder);
      }
      return known ? roomWith(known) : true;
    };
    /** Whether a recording may start or go on in `folder`, as measured now. */
    const roomIn = (folder: string) => Effect.promise(() => measure(folder).then(roomWith));

    const limitOf = (subscriptionId: string) =>
      Effect.map(subscriptions.list, (list) => {
        const allowed = list.find((each) => each.id === subscriptionId)?.account.maxConnections;
        return allowed && allowed > 0 ? allowed : 1;
      });

    /**
     * Writes down how `id`'s capture ended, once its request ended and its file closed: for good,
     * or, with time left and nobody asking it to end, paused from now, to go on.
     */
    const ended = (id: string, end: CaptureEnd, capture: Active) =>
      Effect.gen(function* () {
        const record = records.get(id);
        if (!record) return null;
        const now = Date.now();
        const seen = { ...record, bytes: capture.bytes() };
        active.delete(id);
        const why: RecordingGapReason | null =
          end === "aborted"
            ? capture.asked === "away"
              ? "away"
              : null
            : end === "until" || now >= record.stop
              ? null
              : end;
        records.set(
          id,
          why
            ? { ...seen, gaps: [...(seen.gaps ?? []), { from: now, to: null, why }] }
            : end === "until"
              ? finalOf(seen, now)
              : end === "aborted"
                ? finalOf(seen, now, capture.asked === "stopped" ? "stopped" : "quit")
                : finalOf(seen, now, cutOf(end)),
        );
        // Any later write takes it down too, the next check's at the latest; until then a restart
        // reads it as one the app didn't see end, and its schedule's time stays unsettled.
        const written = yield* Effect.result(save);
        if (written._tag === "Failure") {
          unsaved.recordings = true;
          unsavedEnds.add(id);
        }
        yield* publish;
        // Its connection is free for a schedule that waits, and one paused goes on.
        yield* wake;
        return written._tag === "Failure" ? written.failure : null;
      });

    /**
     * Starts as `start` does, for a schedule as `scheduled` says, named `title`, or goes on with
     * `resumes` after its gap, appending to its file; `controller` stops it at any step, `settle`
     * once it's active.
     */
    const begin = (
      channel: OwnedId,
      stop: number,
      options: StartOptions &
        Pick<StoredRecording, "scheduled"> & {
          readonly title?: string;
          readonly resumes?: StoredRecording;
        },
      controller: AbortController,
      settle: () => void,
    ) =>
      Effect.gen(function* () {
        yield* usable;
        const now = Date.now();
        const { resumes } = options;
        if (stop <= now || (!resumes && stop > now + RECORDING_MAX_MS))
          return yield* new Failed({
            error: { kind: "invalid-input", detail: t("Choose a stop time within 12 hours.") },
          });
        const { subscriptionId } = channel;
        const source = yield* subscriptions.sourceOf(subscriptionId);
        const listed = (yield* library.lookup(subscriptionId))(channel.id);
        if (!listed)
          return yield* new Failed({ error: { kind: "channel-not-found", channelId: channel.id } });
        // A schedule's start tries what playback would: the stream chosen for it before, or Auto's.
        const preferences = {
          ...(yield* settings.get),
          ...(yield* settings.ofSubscription(subscriptionId)),
        };
        const ask = (id: string) =>
          Effect.tryPromise({
            try: (signal) =>
              source.provider.liveStream(id, AbortSignal.any([signal, controller.signal])),
            catch: (cause) =>
              cause instanceof Failed
                ? cause
                : new Failed({
                    error: {
                      kind: "stream",
                      failure: { kind: "network", detail: String(cause) },
                    },
                  }),
          });
        // Streams asked for are each needed. Auto's are tried in its order, so one the provider
        // can't name, as a playlist that dropped it, leaves the others; the first failure says
        // why when none is left.
        const variants = options.variants ?? resumes?.variants;
        const streams = variants?.length
          ? yield* Effect.forEach(variants, ask)
          : yield* Effect.flatMap(
              Effect.forEach(streamsToPlay(listed, preferences, undefined), ({ id }) =>
                Effect.result(ask(id)),
              ),
              (tried) => {
                const found = tried.flatMap((each) =>
                  each._tag === "Success" ? [each.success] : [],
                );
                const failed = tried.find((each) => each._tag === "Failure");
                return found.length === 0 && failed
                  ? Effect.fail(failed.failure)
                  : Effect.succeed(found);
              },
            );
        const programme =
          options.title || resumes
            ? { title: options.title ?? resumes?.title ?? listed.title }
            : (yield* guide.listings([ownedId(listed)]))[ownedKey(listed)]?.now;
        // A disk without room records nothing, and holds no connection for it.
        const folder = resumes?.folder ?? storage.folder ?? root;
        if (!(yield* roomIn(folder)))
          return yield* new Failed({
            error: {
              kind: "unexpected",
              detail: t("There isn't enough free space to record."),
            },
          });
        if (options.stopPlaying) yield* playback.closeOf(subscriptionId);
        const admitted = yield* coordination.hold(
          subscriptionId,
          limitOf(subscriptionId),
          options.stopPlaying ?? false,
        );
        if (admitted.kind === "busy")
          return {
            kind: "busy",
            connections: { limit: yield* limitOf(subscriptionId), uses: admitted.uses },
          } satisfies RecordingStart;
        const { held } = admitted;

        const title = programme?.title ?? listed.title;
        const id = resumes?.id ?? randomUUID();
        // As it is now: a change since it was asked for, as its gap's, counts.
        const record: StoredRecording = (resumes && records.get(resumes.id)) ||
          resumes || {
            id,
            file: recordingFileName(title, listed.title, now),
            ...(folder !== root && { folder }),
            ...(options.variants?.length && { variants: options.variants }),
            channel: ownedId(listed),
            channelName: listed.title,
            title,
            start: now,
            stop,
            ...(options.scheduled && { scheduled: options.scheduled }),
            ended: null,
            bytes: 0,
            status: { kind: "recording" },
          };
        const opening = (
          resumes ? Promise.resolve() : mkdir(folderOf(record), { recursive: true })
        ).then(() =>
          startCapture(
            streams.map(({ url, format, headers }) => ({ url, format, headers: headers ?? {} })),
            fileOf(record),
            {
              request: source.provider.request,
              userAgent: deps.userAgent,
              until: stop,
              signal: controller.signal,
              changed: grew,
              room: roomOf(folder),
              append: Boolean(resumes),
            },
          ),
        );
        opening.catch(() => {});
        const capture = yield* Effect.tryPromise({
          try: () => opening,
          catch: (cause) =>
            cause instanceof CaptureFailure
              ? new Failed({ error: { kind: "stream", failure: cause.failure } })
              : new Failed({
                  error: {
                    kind: "unexpected",
                    // The system's own words name paths and codes, not what to do.
                    detail: t("The recording couldn't be written to this computer."),
                  },
                }),
        }).pipe(
          // Also when the app closes meanwhile: whatever started ends before its folder goes. One
          // going on keeps its folder, its file as it was.
          Effect.onError(() =>
            Effect.promise(async () => {
              controller.abort();
              await opening.then(
                (opened) => opened.ended,
                () => {},
              );
              held.release();
              if (!resumes) await rm(folderOf(record), { recursive: true, force: true });
            }),
          ),
        );
        const { promise: settled, resolve } = Promise.withResolvers<Failed | null>();
        // Stopped by its subscription going, or its Stop, as it started: it ends as one the
        // viewer stopped.
        const asked = controller.signal.reason === "stopped" ? "stopped" : null;
        const live: Active = { controller, bytes: capture.bytes, asked, settled };
        // Going on, its gap ends now.
        const started: StoredRecording = resumes
          ? {
              ...record,
              ...(record.gaps && {
                gaps: record.gaps.map((gap) =>
                  gap.to === null ? { ...gap, to: Date.now() } : gap,
                ),
              }),
            }
          : record;
        records.set(id, started);
        active.set(id, live);
        settle();
        void capture.ended
          .then((end) => {
            held.release();
            return Effect.runPromise(ended(id, end, live));
          })
          .then(resolve, () => resolve(null));
        const written = yield* Effect.result(save);
        if (written._tag === "Failure" && resumes) unsaved.recordings = true;
        else if (written._tag === "Failure") {
          // Without its record nothing would say it exists: it stops, and its file goes.
          live.asked = "stopped";
          controller.abort();
          yield* Effect.promise(() => settled);
          records.delete(id);
          // How it ended may have been written down meanwhile.
          yield* Effect.ignore(save);
          yield* Effect.promise(() => rm(folderOf(record), { recursive: true, force: true }));
          yield* publish;
          return yield* written.failure;
        }
        yield* publish;
        // What the schedules say of the connections changed.
        yield* wake;
        const { file: _file, folder: _folder, variants: _variants, ...recording } = started;
        return {
          kind: "started",
          recording: { ...recording, bytes: capture.bytes() },
        } satisfies RecordingStart;
      });

    const start = (
      channel: OwnedId,
      stop: number,
      options: StartOptions &
        Pick<StoredRecording, "scheduled"> & {
          readonly title?: string;
          readonly resumes?: StoredRecording;
        } = {},
    ) =>
      Effect.suspend(() => {
        if (closing)
          return Effect.fail(
            new Failed({
              error: { kind: "stream", failure: { kind: "network", detail: t("Stopped.") } },
            }),
          );
        // Starting from before its first wait, so a removal, its Stop or the app's close stops it
        // at any step.
        const controller = new AbortController();
        const { promise: done, resolve } = Promise.withResolvers<void>();
        starting.set(controller, {
          subscriptionId: channel.subscriptionId,
          ...(options.resumes && { resumes: options.resumes.id }),
          done,
        });
        const settle = () => {
          starting.delete(controller);
          resolve();
        };
        return Effect.ensuring(
          begin(channel, stop, options, controller, settle),
          Effect.sync(settle),
        );
      });

    /**
     * Ends what records now, as asked, once each has written down how it ended; fails when that
     * couldn't be written down.
     */
    const end = (ids: readonly string[], asked: NonNullable<Active["asked"]>) =>
      Effect.flatMap(
        Effect.promise(() =>
          Promise.all(
            ids.flatMap((id) => {
              const live = active.get(id);
              if (!live) return [];
              live.asked ??= asked;
              live.controller.abort();
              return [live.settled];
            }),
          ),
        ),
        (failures) => {
          const failure = failures.find((each) => each !== null);
          return failure ? Effect.fail(failure) : Effect.void;
        },
      );
    /** Ends for good, `as` asked, each recording that pauses and `which` names. */
    const endPaused = (which: (record: StoredRecording) => boolean, as: "stopped" | "quit") =>
      Effect.suspend(() => {
        const paused = [...records.values()].filter(
          (each) => isLive(each) && !active.has(each.id) && which(each),
        );
        if (paused.length === 0) return Effect.void;
        const now = Date.now();
        for (const record of paused) records.set(record.id, finalOf(record, now, as));
        return Effect.andThen(saveOrLater, publish);
      });
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        Effect.promise(() => {
          closing = true;
          return Promise.all(
            [...starting].map(([controller, start]) => {
              controller.abort();
              return start.done;
            }),
          );
        }),
        // Read once they settled: one may have become active meanwhile.
        Effect.suspend(() =>
          Effect.andThen(
            Effect.ignore(end([...active.keys()], leaving)),
            // Quit ends those paused too: none goes on when the app runs again.
            Effect.suspend(() =>
              leaving === "quit" ? endPaused(() => true, "quit") : Effect.void,
            ),
          ),
        ),
      ),
    );

    /** Ends a start under way that would go on with `id`, once it answered. */
    const stopResuming = (id: string) =>
      Effect.promise(() =>
        Promise.all(
          [...starting].flatMap(([controller, each]) => {
            if (each.resumes !== id) return [];
            controller.abort("stopped");
            return [each.done];
          }),
        ),
      );

    // Schedules.
    const schedulesPath = join(root, "schedules.json");
    const readKept = yield* Effect.promise(() => readSchedules(schedulesPath));
    const schedules = new Map(
      (readKept.kind === "read" ? readKept.items : []).map((each) => [each.id, each]),
    );
    // Both files: with recordings.json unread no check runs, and a schedule saved never records.
    const schedulesUsable = Effect.andThen(
      usable,
      readKept.kind === "read"
        ? Effect.void
        : Effect.fail(
            new Failed({
              error: { kind: "unexpected", detail: t("Schedules could not be read.") },
            }),
          ),
    );
    /** One check, or change of the schedules, at a time. */
    const scheduling = (yield* Semaphore.make(1)).withPermits(1);
    const scheduleChanges = yield* PubSub.sliding<readonly ScheduledRecording[]>(4);
    /** What the window was last told, so a check that changed nothing tells nothing. */
    let shownSchedules: readonly ScheduledRecording[] = [];
    /** What holds each schedule back, as the last check found; null for nothing. */
    let holds = new Map<string, Hold | null>();
    /**
     * Why an occurrence whose time came isn't recording, by `occurrenceKey`: what its last start
     * answered, `held` or `unread` while its schedule was held then, or `starting` while a start is
     * under way.
     */
    const why = new Map<string, ScheduleMiss | "starting">();
    /** When each occurrence whose time came was last asked to start, by `occurrenceKey`. */
    const tried = new Map<string, number>();
    /**
     * Subscriptions a schedule starts on now: one at a time each, so the first in line, by its
     * start and then by when it was saved, takes a connection first.
     */
    const startingOn = new Set<string>();
    /** Each schedule's start under way, settling once it answered, for a change to wait on. */
    const startsOf = new Map<string, Promise<void>>();
    /** When this run of the app began checking schedules. */
    const started = Date.now();
    const occurrenceKey = (id: string, occurrence: Occurrence) => `${id}@${occurrence.start}`;
    /** The recording a schedule made of `occurrence`, if one did. */
    const recordOf = (id: string, occurrence: Occurrence) =>
      [...records.values()].find(
        (each) => each.scheduled?.schedule === id && each.scheduled.from === occurrence.start,
      );
    /** The recording a schedule records now, capturing or paused, if one does. */
    const recordingOf = (id: string) =>
      [...records.values()].find((each) => isLive(each) && each.scheduled?.schedule === id)?.id;

    /**
     * Writes schedules.json, after what a check couldn't write of recordings.json: a time it
     * settled is only kept settled once its missed result is kept too.
     */
    const saveSchedules = Effect.andThen(
      Effect.suspend(() =>
        unsaved.recordings
          ? Effect.tap(save, () => Effect.sync(() => (unsaved.recordings = false)))
          : Effect.void,
      ),
      Effect.tryPromise({
        try: () => writeSchedules(schedulesPath, [...schedules.values()]),
        catch: () =>
          new Failed({ error: { kind: "unexpected", detail: t("Schedules could not be saved.") } }),
      }),
    );
    /** Keeps `schedule` as `id`, or takes `id` out for null, putting it back if the write fails. */
    const keep = (id: string, schedule: KeptSchedule | null) =>
      Effect.gen(function* () {
        const was = schedules.get(id);
        if (schedule) schedules.set(id, schedule);
        else schedules.delete(id);
        const written = yield* Effect.result(saveSchedules);
        if (written._tag === "Failure") {
          if (was) schedules.set(id, was);
          else schedules.delete(id);
          return yield* written.failure;
        }
      });

    /**
     * `plan` as the lists and the guide stand now: its channel, and what holds it back, its
     * channel not listed, or listed under a name other than `channelName`, the one it was saved
     * with, or, for a programme, another programme or none at its start; undefined while that
     * can't be told, as before the lists or the guide are read. A programme listed at its start
     * under its title takes the guide's end.
     */
    const follow = (plan: RecordingPlan, channelName?: string) =>
      Effect.gen(function* () {
        const { subscriptionId } = plan.channel;
        const found = (yield* library.lookup(subscriptionId))(plan.channel.id);
        // Another name under its id, as after a playlist's link was replaced: another channel.
        if (found && channelName !== undefined && found.title !== channelName)
          return { plan, listed: undefined, hold: gone };
        const listed = found;
        if (!listed) {
          const read = (yield* library.status).some(
            (each) => each.subscriptionId === subscriptionId && each.fetchedAt !== null,
          );
          return { plan, listed, hold: read ? gone : undefined };
        }
        if (plan.kind === "slot") return { plan, listed, hold: null };
        const answer = yield* guide.startingAt(plan.channel, plan.start);
        // A guide not read yet can't say what is on then: it waits for one, recording no other show.
        if (answer.kind === "unknown") return { plan, listed, hold: undefined };
        if (answer.kind === "none") return { plan, listed, hold: gone };
        const { title, stop } = answer.programme;
        if (title !== plan.title)
          return { plan, listed, hold: { kind: "changed", title } satisfies Hold };
        // Within the longest a recording runs, as schedules.json keeps it.
        const longest =
          plan.start + RECORDING_MAX_MS - (plan.padding.before + plan.padding.after) * 60_000;
        // A guide whose end isn't after the start keeps the end it was saved with.
        const followed = stop > plan.start ? Math.min(stop, longest) : plan.stop;
        return { plan: { ...plan, stop: followed }, listed, hold: null };
      });

    /** What of this app holds the subscription's connections now. */
    const holdersNow = (subscriptionId: string) =>
      Effect.map(coordination.uses(subscriptionId), (uses): ConnectionHolder[] => [
        ...recordingHoldings(subscriptionId).map((each) => each.holder),
        ...uses.flatMap((use) => (use === "recording" ? [] : [{ kind: use }])),
      ]);
    const recordingHoldings = (subscriptionId: string): Holding[] =>
      [...active.keys()].flatMap((id) => {
        const record = records.get(id);
        if (record?.channel.subscriptionId !== subscriptionId) return [];
        const holder = { kind: "recording", title: record.title, until: record.stop } as const;
        return [{ holder, start: record.start, first: true }];
      });

    /**
     * How `schedule` stands at `now`, held back as `hold` says, against the others of `kept` and
     * what records now.
     */
    const standingOf = (
      schedule: KeptSchedule,
      kept: readonly KeptSchedule[],
      now: number,
      hold = holds.get(schedule.id),
    ) =>
      Effect.gen(function* () {
        const { plan } = schedule;
        const on = nextOccurrence(plan, now);
        const as = (status: ScheduleStatus, next = on): ScheduledRecording => ({
          id: schedule.id,
          plan,
          channelName: schedule.channelName,
          next,
          status,
        });
        // What records goes on whatever the guide says now, or a change made meanwhile, until its
        // own stop.
        const recording = recordingOf(schedule.id);
        const record = recording === undefined ? undefined : records.get(recording);
        if (recording && record)
          return as(
            { kind: "recording", recording },
            { start: record.scheduled?.from ?? record.start, stop: record.stop },
          );
        // A time on now that it recorded, stopped or cut short, or a change settled, records no
        // more: the one after it is next.
        const next =
          on && (recordOf(schedule.id, on) || on.stop <= schedule.through)
            ? nextOccurrence(plan, on.stop)
            : on;
        if (hold) return as(hold, next);
        if (!next) return as({ kind: "planned" }, next);
        const { subscriptionId } = plan.channel;
        const reason = next.start <= now ? why.get(occurrenceKey(schedule.id, next)) : undefined;
        if (reason === "busy")
          return as({ kind: "waiting", holders: yield* holdersNow(subscriptionId) }, next);
        if (reason === "stream" || reason === "disk")
          return as({ kind: "retrying", why: reason }, next);
        const holdings = [
          ...recordingHoldings(subscriptionId),
          ...kept.flatMap((other): Holding[] => {
            if (other.id === schedule.id || other.plan.channel.subscriptionId !== subscriptionId)
              return [];
            if (holds.get(other.id)) return [];
            // Each of its times within this one, but one it records now, which counts above.
            return occurrences(other.plan, next.start, next.stop).flatMap((theirs) => {
              // One recording counts above as what it holds; one that recorded, or was settled,
              // holds nothing more.
              if (recordOf(other.id, theirs) || theirs.stop <= other.through) return [];
              const holder = {
                kind: "schedule",
                title: other.plan.title,
                until: theirs.stop,
              } as const;
              return [{ holder, start: theirs.start, first: other.created < schedule.created }];
            });
          }),
        ];
        const holders = conflictOf(next, holdings, yield* limitOf(subscriptionId));
        return as(holders.length > 0 ? { kind: "conflict", holders } : { kind: "planned" }, next);
      });

    /** Every schedule kept, by when it records next. */
    const standings = (now: number) => {
      const kept = [...schedules.values()];
      return Effect.map(
        Effect.forEach(kept, (schedule) => standingOf(schedule, kept, now)),
        (list) =>
          list.toSorted(
            (a, b) =>
              (a.next?.start ?? Infinity) - (b.next?.start ?? Infinity) ||
              a.channelName.localeCompare(b.channelName),
          ),
      );
    };

    /**
     * When a recording of `schedule`'s `occurrence` is owed from: its start, or when the schedule
     * was first saved, or changed onto that time while it was under way, when that was later. The
     * time before anyone asked for it is nobody's fault.
     */
    const owedOf = (schedule: KeptSchedule, occurrence: Occurrence) =>
      Math.max(
        occurrence.start,
        schedule.created,
        schedule.owed?.from === occurrence.start ? schedule.owed.at : -Infinity,
      );

    /**
     * What a recording or missed result of `schedule`'s `occurrence` says of it: when it was owed
     * from, and the occurrence by its start all the same, so it is found as that time's.
     */
    const scheduledOf = (
      schedule: KeptSchedule,
      occurrence: Occurrence,
      late: ScheduleMiss | null,
    ): NonNullable<StoredRecording["scheduled"]> => {
      const owed = owedOf(schedule, occurrence);
      return {
        schedule: schedule.id,
        from: occurrence.start,
        ...(owed > occurrence.start && { owed }),
        late,
      };
    };

    /**
     * Starts a schedule's occurrence on now, in the background; a check follows its answer. It is
     * late once more than ON_TIME_MS passed since it was owed.
     */
    const startOccurrence = (schedule: KeptSchedule, occurrence: Occurrence, now: number) => {
      const key = occurrenceKey(schedule.id, occurrence);
      const before = why.get(key);
      const late =
        now - owedOf(schedule, occurrence) <= ON_TIME_MS
          ? null
          : before === undefined || before === "starting"
            ? "away"
            : before;
      const { subscriptionId } = schedule.plan.channel;
      why.set(key, "starting");
      startingOn.add(subscriptionId);
      const answered = Promise.withResolvers<void>();
      startsOf.set(schedule.id, answered.promise);
      const { plan } = schedule;
      Effect.runFork(
        Effect.gen(function* () {
          // A programme is named as saved; a repeat by what the guide lists at its unpadded
          // start, else as saved.
          const at = occurrence.start + plan.padding.before * 60_000;
          const listed =
            plan.kind === "slot"
              ? (yield* guide.schedule(plan.channel, at, at + 1)).find(
                  (each) => each.start <= at && at < each.stop,
                )
              : undefined;
          // Taken out meanwhile, as with its subscription, it starts nothing.
          if (!schedules.has(schedule.id)) return null;
          return yield* start(plan.channel, occurrence.stop, {
            scheduled: scheduledOf(schedule, occurrence, late),
            title: listed?.title ?? plan.title,
          });
        }).pipe(
          Effect.match({
            onSuccess: (answer) =>
              answer === null || answer.kind === "started" ? why.delete(key) : why.set(key, "busy"),
            // This computer's when unexpected, as a file it couldn't write; else the stream's,
            // a lost login included.
            onFailure: ({ error }) => why.set(key, error.kind === "unexpected" ? "disk" : "stream"),
          }),
          // A defect, as a capture folder this computer won't remove, is this computer's too.
          Effect.catchDefect(() => Effect.sync(() => why.set(key, "disk"))),
          // However it ended, the subscription's next schedule may start, and a change goes on.
          Effect.ensuring(
            Effect.sync(() => {
              startingOn.delete(subscriptionId);
              if (startsOf.get(schedule.id) === answered.promise) startsOf.delete(schedule.id);
              answered.resolve();
            }),
          ),
          Effect.andThen(wake),
        ),
      );
    };

    /** Goes on with a paused recording in the background; a check follows its answer. */
    const resumeRecording = (record: StoredRecording) => {
      const { subscriptionId } = record.channel;
      startingOn.add(subscriptionId);
      Effect.runFork(
        start(record.channel, record.stop, { resumes: record }).pipe(
          // Refused, busy or failed, it stays paused, and is asked again.
          Effect.ignore,
          Effect.catchDefect(() => Effect.void),
          Effect.ensuring(Effect.sync(() => startingOn.delete(subscriptionId))),
          Effect.andThen(wake),
        ),
      );
    };
    /** When each paused recording last asked to go on, by id. */
    const resumeTried = new Map<string, number>();
    /** Something changed that may let paused recordings go on: they ask again at the next check. */
    const retryPaused = Effect.andThen(
      Effect.sync(() => resumeTried.clear()),
      wake,
    );
    /**
     * Goes on with each paused recording whose time remains, asking at most every RETRY_MS and
     * one start at a time on its subscription, and ends for good one whose time passed meanwhile.
     * Answers whether one still pauses. Only runs in a turn.
     */
    const resumeDue = (now: number) =>
      Effect.gen(function* () {
        let paused = false;
        let over = false;
        for (const record of records.values()) {
          if (!isLive(record) || active.has(record.id)) continue;
          if ([...starting.values()].some((each) => each.resumes === record.id)) {
            paused = true;
            continue;
          }
          if (record.stop <= now) {
            records.set(record.id, finalOf(record, now));
            resumeTried.delete(record.id);
            over = true;
            continue;
          }
          paused = true;
          const { subscriptionId } = record.channel;
          if (startingOn.has(subscriptionId)) continue;
          if ((resumeTried.get(record.id) ?? -Infinity) + RETRY_MS > now) continue;
          resumeTried.set(record.id, now);
          resumeRecording(record);
        }
        if (over) {
          yield* saveOrLater;
          yield* publish;
        }
        return paused;
      });

    /**
     * Goes on with paused recordings, and brings every schedule up to date at the time now: drops
     * those of a subscription that went, follows the lists and the guide, starts what is due,
     * writes what was missed, and tells the window what changed. Answers when the next check is
     * due, or null while nothing pauses and no schedule is kept. Only runs in a turn.
     */
    const checkNow = Effect.gen(function* () {
      if (read.kind !== "read" || closing) return null;
      const paused = yield* resumeDue(Date.now());
      const resumeAt = paused ? Date.now() + RETRY_MS : null;
      if (readKept.kind !== "read") return resumeAt;
      // With none kept, nothing is asked of the lists, the guide or the clock: a schedule saved
      // wakes the next check.
      if (schedules.size === 0 && !unsaved.recordings && !unsaved.schedules) {
        if (shownSchedules.length > 0) {
          shownSchedules = [];
          yield* PubSub.publish(scheduleChanges, shownSchedules);
        }
        return resumeAt;
      }
      const now = Date.now();
      const saved = new Set((yield* subscriptions.saved).map((each) => each.id));
      let dirty = false;
      let missed = false;
      let retry = false;
      const found = new Map<string, Hold | null>();
      const inLine = (each: KeptSchedule) => nextOccurrence(each.plan, now)?.start ?? Infinity;
      const ordered = [...schedules.values()].toSorted(
        (a, b) => inLine(a) - inLine(b) || a.created - b.created,
      );
      for (const schedule of ordered) {
        if (!saved.has(schedule.plan.channel.subscriptionId)) {
          schedules.delete(schedule.id);
          dirty = true;
          continue;
        }
        const seen = yield* Effect.orElseSucceed(
          follow(schedule.plan, schedule.channelName),
          () => null,
        );
        const hold = seen?.hold;
        found.set(schedule.id, hold ?? null);
        // While it records, its plan stays as the recording was started: a guide that moves the
        // end then moves it for no recording.
        let kept: KeptSchedule = {
          ...schedule,
          plan: (!recordingOf(schedule.id) && seen?.plan) || schedule.plan,
        };
        // Each occurrence since it was last settled, up to now. One that ended is settled, as
        // recorded, missed or let go; one on now starts, unless it is held or one records.
        let through = kept.through;
        let settling = true;
        for (const occurrence of occurrences(kept.plan, kept.through, now + 1)) {
          const key = occurrenceKey(kept.id, occurrence);
          const made = recordOf(kept.id, occurrence);
          const reason = why.get(key);
          if (occurrence.stop <= now) {
            if (reason === "starting" || (made && isLive(made))) {
              settling = false;
              continue;
            }
            // A long absence writes its last week, not every day of it.
            if (!made && occurrence.stop > now - MISSED_KEPT_MS) {
              const record: StoredRecording = {
                id: randomUUID(),
                file: recordingFileName(kept.plan.title, kept.channelName, occurrence.start),
                channel: kept.plan.channel,
                channelName: kept.channelName,
                title: kept.plan.title,
                start: occurrence.start,
                stop: occurrence.stop,
                scheduled: scheduledOf(kept, occurrence, reason ?? "away"),
                ended: null,
                bytes: 0,
                status: { kind: "missed", why: reason ?? "away" },
              };
              records.set(record.id, record);
              missed = true;
            }
            why.delete(key);
            tried.delete(key);
            if (settling) through = occurrence.stop;
            continue;
          }
          // Recorded, and stopped or cut short already: the rest of its time is done with too.
          // Not while its start is still answering: one whose record couldn't be kept goes.
          if (made && !isLive(made) && reason !== "starting") {
            why.delete(key);
            tried.delete(key);
            if (settling) through = occurrence.stop;
            continue;
          }
          if (made || reason === "starting" || recordingOf(kept.id)) continue;
          if (hold) why.set(key, "held");
          else if (hold === undefined) {
            // Not for a time that began before the app started: that one was missed while away.
            if (reason === undefined && occurrence.start >= started) why.set(key, "unread");
            retry = true;
          } else if (startingOn.has(kept.plan.channel.subscriptionId)) retry = true;
          // Busy asks again soon; a failed start, which may not change, once a minute.
          else if (
            (tried.get(key) ?? -Infinity) + (reason === "busy" ? RETRY_MS : CHECK_MS) <=
            now
          ) {
            tried.set(key, now);
            startOccurrence(kept, occurrence, now);
          } else retry = true;
        }
        kept = { ...kept, through };
        // A programme records once: settled, it goes.
        const once =
          kept.plan.kind === "programme" && occurrences(kept.plan, through, Infinity).length === 0;
        if (once) schedules.delete(kept.id);
        else schedules.set(kept.id, kept);
        dirty ||= once || !isDeepStrictEqual(kept, schedule);
      }
      holds = found;
      // The missed results first, and what settled them only once they are written: a crash, or
      // a write that fails, leaves their occurrences to settle again, which finds them.
      if (missed || unsaved.recordings) {
        unsaved.recordings = (yield* Effect.result(save))._tag === "Failure";
        yield* publish;
      }
      if (dirty || unsaved.schedules)
        unsaved.schedules = (yield* Effect.result(saveSchedules))._tag === "Failure";
      if (unsaved.recordings || unsaved.schedules) {
        yield* Effect.logWarning("[recordings] schedules could not be saved; trying again");
        retry = true;
      }
      const list = yield* standings(now);
      if (!isDeepStrictEqual(list, shownSchedules)) {
        shownSchedules = list;
        yield* PubSub.publish(scheduleChanges, list);
      }
      const starts = list.flatMap((each) =>
        each.next && each.next.start > now ? [each.next.start] : [],
      );
      return Math.min(now + (retry || paused ? RETRY_MS : CHECK_MS), ...starts);
    });

    const checkOnce = scheduling(checkNow).pipe(
      Effect.catchDefect((defect) =>
        Effect.andThen(
          Effect.logWarning("[recordings] checking schedules failed", defect),
          Effect.sync(() => Date.now() + CHECK_MS),
        ),
      ),
    );
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        for (;;) {
          const next = yield* checkOnce;
          yield* next === null
            ? Queue.take(wakes)
            : Effect.raceFirst(Effect.sleep(Math.max(0, next - Date.now())), Queue.take(wakes));
        }
      }),
    );
    // The lists may list a schedule's channel anew or no longer, and the guide another programme
    // at its start.
    yield* Effect.forkScoped(
      Stream.runForEach(guide.changes.pipe(Stream.debounce(GUIDE_SETTLE)), () => wake),
    );
    yield* Effect.forkScoped(Stream.runForEach(library.changes, () => wake));

    /**
     * Runs `turn` in a turn once `id`'s start under way, if any, answered, waiting for it outside
     * the turn so other schedules go on meanwhile. What it began for then records, or is still to
     * record, as a change finds it: its recording names the time it began for, which a changed
     * start would no longer find.
     */
    const onceAnswered = <A, E>(
      id: string | undefined,
      turn: Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        const answering = id === undefined ? undefined : startsOf.get(id);
        if (answering)
          return Effect.andThen(
            Effect.promise(() => answering),
            onceAnswered(id, turn),
          );
        // Another may have started before the turn came.
        return Effect.flatMap(
          scheduling(
            Effect.suspend(() =>
              id !== undefined && startsOf.has(id)
                ? Effect.succeed(null)
                : Effect.map(turn, (value) => ({ value })),
            ),
          ),
          (done) => (done ? Effect.succeed(done.value) : onceAnswered(id, turn)),
        );
      });

    /**
     * `plan` as `recordings.plan` and `recordings.schedule` take it: the schedule it would be,
     * new or the one `id` names, and how it would stand. Only runs in a turn.
     */
    const draft = (plan: RecordingPlan, id: string | undefined) =>
      Effect.gen(function* () {
        yield* schedulesUsable;
        const now = Date.now();
        const was = id === undefined ? undefined : schedules.get(id);
        if (id !== undefined && !was)
          return yield* new Failed({
            error: { kind: "unexpected", detail: t("This schedule is no longer there.") },
          });
        const found = yield* follow(plan);
        if (!found.listed)
          return yield* new Failed({
            error: { kind: "channel-not-found", channelId: plan.channel.id },
          });
        if (!nextOccurrence(found.plan, now))
          return yield* new Failed({
            error: { kind: "invalid-input", detail: t("Its time has passed.") },
          });
        // Changed, it settles from now: what it recorded or missed stays as it was, and once it
        // recorded its time on now, still recording, stopped or deleted, or a change before this
        // one settled it, the change starts with its next.
        const recording = id === undefined ? undefined : recordingOf(id);
        // Until when that holds its time: the recording's stop, the recorded time's, or where the
        // change before settled it. Each changed time within it is settled too, one that starts
        // later or ends later than the recording included.
        const held =
          was === undefined
            ? []
            : [
                ...(recording === undefined ? [] : [records.get(recording)?.stop ?? now]),
                ...occurrences(was.plan, now, now + 1)
                  .filter((each) => recordOf(was.id, each))
                  .map((each) => each.stop),
                ...(was.through > now ? [was.through] : []),
              ];
        const heldTo = Math.max(now + 1, ...held);
        // A change onto a time already under way asks for it from now: what passed of it before
        // was asked of nobody. One that keeps the time it was on keeps what it owed.
        const onNow = occurrences(found.plan, now, now + 1).find((each) => each.start < now);
        const same =
          was &&
          onNow &&
          occurrences(was.plan, now, now + 1).some((each) => each.start === onNow.start);
        const owed =
          was === undefined || onNow === undefined
            ? undefined
            : same
              ? was.owed?.from === onNow.start
                ? was.owed
                : undefined
              : { from: onNow.start, at: now };
        const schedule: KeptSchedule = {
          id: id ?? randomUUID(),
          plan: found.plan,
          channelName: found.listed.title,
          // Strictly after every other: of two that start together, the one saved first records.
          created:
            was?.created ??
            Math.max(now, ...[...schedules.values()].map((each) => each.created + 1)),
          through: Math.max(
            now,
            ...held,
            ...(held.length > 0
              ? occurrences(found.plan, now, heldTo).map((each) => each.stop)
              : []),
          ),
          ...(owed && { owed }),
        };
        const standing = yield* standingOf(
          schedule,
          [...schedules.values()],
          now,
          found.hold ?? null,
        );
        return { schedule, standing };
      });

    const storageNow = Effect.andThen(
      usable,
      Effect.promise(async (): Promise<RecordingStorage> => {
        const folder = storage.folder ?? root;
        return {
          folder,
          keepFree: storage.keepFree,
          space: storage.space,
          used: used(),
          free: await freeIn(folder),
        };
      }),
    );
    /** Keeps `next` as storage.json, the settings as they were when that fails. */
    const changeStorage = (next: KeptStorage) =>
      Effect.andThen(
        usable,
        Effect.tryPromise({
          try: () => writeStorage(storagePath, next),
          catch: () =>
            new Failed({
              error: { kind: "unexpected", detail: t("Recording settings could not be saved.") },
            }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              storage = next;
              measured.clear();
            }),
          ),
        ),
      );

    return {
      list: usable.pipe(Effect.andThen(look), Effect.andThen(shown)),
      connections: (subscriptionId: string) =>
        Effect.gen(function* () {
          const limit = yield* limitOf(subscriptionId);
          return { limit, uses: yield* coordination.uses(subscriptionId) };
        }),
      start,
      stop: (id: string) =>
        Effect.gen(function* () {
          // A start going on with it ends first: it ends as stopped, or never begins.
          yield* stopResuming(id);
          yield* end([id], "stopped");
          // Paused, it ends where its capture last stopped.
          const record = records.get(id);
          if (record && isLive(record) && !active.has(id)) {
            records.set(id, finalOf(record, Date.now(), "stopped"));
            yield* publish;
          }
          // Capture may have ended before Stop arrived. Retry its terminal record too.
          if (records.has(id)) yield* save;
          yield* publish;
        }),
      subscriptionGone: (subscriptionId: string) =>
        Effect.andThen(
          // Its schedules go first, so none starts meanwhile.
          scheduling(
            Effect.suspend(() => {
              const before = schedules.size;
              for (const [id, each] of schedules)
                if (each.plan.channel.subscriptionId === subscriptionId) schedules.delete(id);
              if (schedules.size === before) return Effect.void;
              // A failed write is tried again by the next check, as its own are.
              return Effect.andThen(
                Effect.map(Effect.result(saveSchedules), (written) => {
                  unsaved.schedules = written._tag === "Failure";
                }),
                wake,
              );
            }),
          ),
          Effect.andThen(
            // Those starting end, or become active and are ended with the others.
            Effect.promise(() =>
              Promise.all(
                [...starting].flatMap(([controller, start]) => {
                  if (start.subscriptionId !== subscriptionId) return [];
                  controller.abort("stopped");
                  return [start.done];
                }),
              ),
            ),
            Effect.suspend(() =>
              Effect.andThen(
                Effect.ignore(
                  end(
                    [...active.keys()].filter(
                      (id) => records.get(id)?.channel.subscriptionId === subscriptionId,
                    ),
                    "stopped",
                  ),
                ),
                // Those paused stop too: nothing of it goes on.
                endPaused((each) => each.channel.subscriptionId === subscriptionId, "stopped"),
              ),
            ),
          ),
        ),
      remove: (id: string) =>
        Effect.gen(function* () {
          yield* usable;
          const record = records.get(id);
          if (!record) return;
          if (isLive(record))
            return yield* new Failed({
              error: { kind: "unexpected", detail: t("Stop the recording before deleting it.") },
            });
          // A schedule's time it recorded stays settled without it, so it never records again.
          const { scheduled } = record;
          if (scheduled)
            yield* scheduling(
              Effect.suspend(() => {
                const schedule = schedules.get(scheduled.schedule);
                if (!schedule) return Effect.void;
                // That time as the plan has it now, as a guide that ran later moved its end.
                const through = Math.max(
                  record.stop,
                  ...occurrences(schedule.plan, scheduled.from, scheduled.from + 1)
                    .filter((each) => each.start === scheduled.from)
                    .map((each) => each.stop),
                );
                return schedule.through < through
                  ? keep(schedule.id, { ...schedule, through })
                  : Effect.void;
              }),
            );
          yield* playback.closeCopy(id);
          // The file goes first: one that stays, as one Windows holds open, keeps its record to
          // delete again, and a record whose file went lists it as missing until it is deleted.
          yield* Effect.tryPromise({
            try: () => rm(folderOf(record), { recursive: true, force: true }),
            catch: () =>
              new Failed({
                error: {
                  kind: "unexpected",
                  detail: t("The recording couldn't be deleted."),
                },
              }),
          });
          records.delete(id);
          const written = yield* Effect.result(save);
          if (written._tag === "Failure") {
            records.set(id, record);
            missing.add(id);
            yield* publish;
            return yield* written.failure;
          }
          missing.delete(id);
          yield* publish;
          // What was saved for its subtitles goes with it, as a copy's does.
          yield* Effect.ignore(savedSubtitles.forget(subtitlesOfCopy(id, { kind: "movie", id })));
          // Room it took may let a paused one go on.
          yield* retryPaused;
        }),
      copy: (id: string) =>
        Effect.gen(function* () {
          const record = records.get(id);
          if (!record || record.status.kind === "missed") return null;
          if (isLive(record))
            return yield* new Failed({
              error: { kind: "unexpected", detail: t("It is still recording.") },
            });
          // Its file may have gone since the list was read: the list says so at once.
          const there = yield* Effect.promise(() =>
            stat(fileOf(record)).then(
              () => true,
              () => false,
            ),
          );
          if (!there) {
            if (!missing.has(id)) {
              missing.add(id);
              yield* publish;
            }
            return yield* new Failed({
              error: { kind: "stream", failure: { kind: "unavailable", status: 404 } },
            });
          }
          if (missing.delete(id)) yield* publish;
          return {
            id,
            path: fileOf(record),
            container: "ts",
            title: { kind: "movie", id },
            progress: record.progress ?? null,
          } satisfies LocalCopy;
        }),
      recordProgress: (id: string, position: number, duration: number) =>
        Effect.gen(function* () {
          yield* usable;
          const record = records.get(id);
          if (!record || record.status.kind === "missed" || isLive(record))
            return yield* new Failed({
              error: { kind: "unexpected", detail: t("This recording is no longer there.") },
            });
          records.set(id, {
            ...record,
            progress: { position: Math.min(position, duration), duration },
          });
          yield* save;
        }),
      storage: storageNow,
      setLimits: (limits: RecordingLimits) =>
        Effect.andThen(
          changeStorage({ ...storage, ...limits }),
          Effect.andThen(retryPaused, storageNow),
        ),
      setFolder: (folder: string) =>
        Effect.gen(function* () {
          // Written to once, as a recording would be, before anything goes there.
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(folder, { recursive: true });
              const probe = join(folder, `.mrstreamer-${randomUUID()}`);
              await writeFile(probe, "");
              await rm(probe, { force: true });
            },
            catch: () =>
              new Failed({
                error: {
                  kind: "invalid-input",
                  detail: t("Recordings can't be written to that folder."),
                },
              }),
          });
          const { folder: _was, ...rest } = storage;
          yield* changeStorage(folder === root ? rest : { ...rest, folder });
          yield* retryPaused;
          return yield* storageNow;
        }),
      suspend: Effect.suspend(() => Effect.ignore(end([...active.keys()], "away"))),
      leave: (how: "quit" | "away") =>
        Effect.sync(() => {
          leaving = how;
        }),
      changes: Stream.fromPubSub(changes),
      schedules: scheduling(
        Effect.andThen(
          schedulesUsable,
          Effect.suspend(() => standings(Date.now())),
        ),
      ),
      plan: (plan: RecordingPlan, id?: string) =>
        onceAnswered(
          id,
          Effect.map(draft(plan, id), ({ standing }) => ({ ...standing, id: id ?? "" })),
        ),
      schedule: (plan: RecordingPlan, id?: string) =>
        Effect.tap(
          onceAnswered(
            id,
            Effect.gen(function* () {
              const { schedule, standing } = yield* draft(plan, id);
              yield* keep(schedule.id, schedule);
              return standing;
            }),
          ),
          () => wake,
        ),
      cancel: (id: string) =>
        Effect.andThen(
          scheduling(
            Effect.gen(function* () {
              yield* schedulesUsable;
              if (schedules.has(id)) yield* keep(id, null);
            }),
          ),
          wake,
        ),
      // Checked now, and the loop then waits for the next time from there.
      // As when the computer wakes: paused recordings ask again at once.
      check: Effect.andThen(
        Effect.sync(() => resumeTried.clear()),
        Effect.andThen(checkOnce, wake),
      ),
      live: Effect.sync(() => ({
        recording: [...records.values()].some(isLive),
        scheduled: schedules.size > 0,
      })),
      scheduleChanges: Stream.fromPubSub(scheduleChanges),
    };
  });
}
