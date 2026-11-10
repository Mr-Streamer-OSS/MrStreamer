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
// (`recordingFileName`), beside it or in the folder the viewer chose (storage.json), which holds a
// mark from when it was first chosen: nothing records into one without it, as a mount point's own
// empty folder while its drive is away, and a recording there waits until its own is back. A record is
// written once its connection is held, before its folder is made, and listed once capture has the
// stream's program table on disk; it is written again with how it ended, only after its provider
// request ended and its file closed: the list never claims more than the file holds. A record still
// recording as the app starts is one the app didn't see end, as after a crash: it goes on, from a
// gap since its file was last written, or, its time over, counts as cut short by the quit. A
// recording's folder left without its record, as a crash leaves one as its start fails, or a
// failed start whose folder couldn't be removed, or an older version's crash as it started, goes
// then. A failed start whose record recordings.json couldn't take out marks its folder instead, so
// a relaunch, also after a Quit, drops that record rather than going on with it.
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
import type { ActiveProfile } from "@mrstreamer/contracts/profiles";
import { copyProgress } from "../platform/profile-copy-progress.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ConnectionHolder,
  Recording,
  RecordingResumeList,
  RecordingConnections,
  RecordingCapacity,
  RecordingCut,
  RecordingGap,
  RecordingGapReason,
  RecordingLimits,
  RecordingPlan,
  RecordingRule,
  RecordingRulePlan,
  RecordingRulePreview,
  RecordingStart,
  RecordingStorage,
  ScheduledRecording,
  ScheduleMiss,
  ScheduleStatus,
} from "@mrstreamer/contracts/recordings";
import {
  DEFAULT_KEEP_FREE,
  RECORDING_MAX_MS,
  RECORDING_RULE_LIMITS,
  RECORDING_PRIORITY_DEFAULT,
} from "@mrstreamer/contracts/recordings";
import type { GuideStatus } from "@mrstreamer/contracts/guide";
import { ownedId, ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { streamsToPlay } from "@mrstreamer/core/catalogue/variants";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import { Guide } from "@mrstreamer/core/guide/service";
import { t, type PlainKey } from "@mrstreamer/core/i18n";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  indexRecording,
  recordingFile,
  type RecordingFile,
  type RecordingExtent,
} from "../playback/file-source.ts";
import { SavedSubtitles, subtitlesOfCopy } from "../platform/saved-subtitles.ts";
import { CaptureFailure, startCapture, type CaptureEnd } from "../recordings/capture.ts";
import {
  comparePending,
  forecastCapacity,
  type Holding,
  type PendingCapture,
  nextOccurrence,
  occurrences,
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
import { readRules, writeRules, type KeptRule } from "../recordings/rule-store.ts";
import { planRule } from "../recordings/rules.ts";
import { Library } from "./library.ts";
import { Playback, type LocalCopy } from "./playback.ts";
import { PlaybackCoordination } from "./playback-coordination.ts";
import { LiveCaptures, streamKey } from "../playback/live-capture.ts";
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

/**
 * A capture whose provider ended its answer cleanly this soon after it began ended quickly: after
 * QUICK_ENDS of them in a row, as from one that answers with a short clip, the recording ends
 * there. A stream that breaks or falls silent goes on however often it does.
 */
const QUICK_MS = 30_000;
const QUICK_ENDS = 3;

/** A recording's own folder, by its id: one left without its record goes. */
const RECORDING_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Marks a recording's folder in a folder the viewer chose as this profile's, holding the path of
 * its recordings.json's folder, so only those it made go with a crash; the profile's own folder
 * holds nothing else.
 */
const OURS = ".mrstreamer-recording";

/**
 * Left empty in a recording's folder as Stop or a confirmed Quit ends it, so a relaunch ends it the
 * same way, as of when it was left, when recordings.json couldn't be written to say so.
 */
const ENDED = { stopped: ".mrstreamer-stopped", quit: ".mrstreamer-quit" } as const;

/**
 * Left empty in a failed start's folder, which then stays, when recordings.json couldn't take its
 * record out: a relaunch drops that record, never capturing for it, and its folder goes once
 * recordings.json no longer lists it.
 */
const FAILED = ".mrstreamer-failed";

/**
 * Left in a folder as the viewer first chooses it, holding a random id, and kept there: where it
 * isn't, as in the empty folder a drive's mount point keeps while the drive is away, nothing
 * records, and nothing there reads as unmarked (see FAILED). A recording keeps the id of its
 * folder's (`mark`), and goes on only where that is, as when its drive is back: another folder
 * chosen at that path meanwhile, as that empty one, has its own.
 */
const CHOSEN = ".mrstreamer-storage";

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
    /**
     * What holds the subscription's connections now, against the account's limit, and with
     * `of`, a channel by its own id and its streams to try, whether recording them would share
     * what plays.
     */
    connections(
      subscriptionId: string,
      of?: { readonly channel: string; readonly variants: readonly string[] },
    ): Effect.Effect<RecordingConnections, Failed>;
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
    copy(id: string, owner?: ActiveProfile): Effect.Effect<LocalCopy | null, Failed>;
    /** Main-only owner-bound projection; callers must authorize every exact recording row. */
    resume(owner?: ActiveProfile): Effect.Effect<RecordingResumeList, Failed>;
    /** Keeps how far a retained recording played, including one still capturing. */
    recordProgress(
      id: string,
      position: number,
      duration: number,
      owner?: ActiveProfile,
    ): Effect.Effect<void, Failed>;
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
    /**
     * Holds new recordings back once nothing records or starts, answering whether it could, so an
     * update's restart ends none; `false` lets them start again.
     */
    holdStarts(on: boolean): Effect.Effect<boolean>;
    /**
     * Writes again how each recording the viewer stopped, its time remaining, ended, while
     * neither recordings.json nor its mark (see ENDED) keeps that yet, answering whether every one
     * is kept now: a relaunch would go on with one that isn't. An update's restart asks first.
     */
    readonly keepStops: Effect.Effect<boolean>;
    /**
     * Whether a recording's time goes on, capturing or paused, whether a schedule is kept, and
     * whether a write of either waits to be tried again.
     */
    readonly live: Effect.Effect<{
      readonly recording: boolean;
      readonly scheduled: boolean;
      readonly unsaved: boolean;
    }>;
    /** Main-only invalidation after a personal save, retaining its original owner and recording. */
    readonly progressChanges: Stream.Stream<{ readonly owner: ActiveProfile; readonly id: string }>;
    /** Inventory after each change and as recordings grow, about once a second; no personal progress. */
    readonly changes: Stream.Stream<readonly Recording[]>;
    /** Lists saved rules; a refused startup inventory stays refused until the next start. */
    readonly rules: Effect.Effect<readonly RecordingRule[], Failed>;
    previewRule(plan: RecordingRulePlan, id?: string): Effect.Effect<RecordingRulePreview, Failed>;
    saveRule(plan: RecordingRulePlan, id?: string): Effect.Effect<RecordingRule, Failed>;
    cancelRule(id: string): Effect.Effect<void, Failed>;
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
  readonly key: string | null;
  readonly controller: AbortController;
  readonly bytes: () => number;
  /** When it last wrote: a gap after it begins there. */
  readonly lastWrite: () => number;
  /** When this capture began. */
  readonly since: number;
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
 * `record` ended for good at `at`, stopped by the viewer, cut short as `as` says, or else as its
 * last gap says: a gap it is in ends with it, at `at` or its stop time once that passed.
 */
function finalOf(
  record: StoredRecording,
  at: number,
  as?: "stopped" | RecordingCut,
): StoredRecording {
  const open = openGap(record);
  const end = Math.min(at, record.stop);
  const { gaps: all, ...rest } = record;

  const gaps = all
    ?.map((gap) => (gap.to === null ? { ...gap, to: end } : gap))
    .filter((gap) => (gap.to ?? end) > gap.from);

  const last = gaps?.at(-1);
  const cut = as ?? (last && cutOf(last.why));

  return {
    ...rest,
    ...(gaps?.length && { gaps }),
    ended: open ? end : at,
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
    const personal = yield* copyProgress;

    const pendingProgress = new Map<
      string,
      {
        id: string;
        owner: ReturnType<typeof personal.of>;
        position: number;
        duration: number;
        retryAt: number;
        watchedAt: number;
      }
    >();

    const subscriptions = yield* Subscriptions;
    const library = yield* Library;
    const guide = yield* Guide;
    const playback = yield* Playback;
    const coordination = yield* PlaybackCoordination;
    const captures = yield* LiveCaptures;
    const settings = yield* Settings;
    const savedSubtitles = yield* SavedSubtitles;
    const root = join(deps.dataDir, "recordings");
    const path = join(root, "recordings.json");
    const storagePath = join(root, "storage.json");

    const progressChanges = yield* PubSub.unbounded<{
      readonly owner: ActiveProfile;
      readonly id: string;
    }>();

    const changes = yield* PubSub.sliding<readonly Recording[]>(4);
    /** Asks the schedules to be checked: a recording started or ended, or the lists changed. */
    const wakes = yield* Queue.sliding<void>(1);
    const wake = Effect.asVoid(Queue.offer(wakes, undefined));
    /** One write of recordings.json at a time, each with every record as it is then. */
    const writing = (yield* Semaphore.make(1)).withPermits(1);

    const read = yield* Effect.promise(() => readRecordings(path));
    const readKeptStorage = yield* Effect.promise(() => readStorage(storagePath));
    /** As storage.json keeps it; the defaults while it can't be read, for recordings going on. */
    let storage: KeptStorage = readKeptStorage ?? { keepFree: DEFAULT_KEEP_FREE, space: null };

    // An unread storage.json is never written over, and nothing new records into a folder it
    // might not name.
    const storageUsable = readKeptStorage
      ? Effect.void
      : Effect.fail(
          new Failed({
            error: { kind: "unexpected", detail: t("Recording settings could not be read.") },
          }),
        );

    const records = new Map<string, StoredRecording>();
    const recordingFiles = new Map<string, RecordingFile>();
    /**
     * New recordings still starting, written to recordings.json from before they capture, so a
     * crash meanwhile leaves one that goes on when the app runs again. Nothing else here sees them
     * until they capture; a start that doesn't takes its own out again.
     */
    const beginning = new Map<string, StoredRecording>();
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
    /** Set while an update's restart goes ahead: nothing new starts meanwhile. */
    let held = false;
    const placeOf = (record: StoredRecording) => record.folder ?? root;
    const folderOf = (record: StoredRecording) => join(placeOf(record), record.id);
    const fileOf = (record: StoredRecording) => join(folderOf(record), record.file);
    const isLive = (record: StoredRecording) => record.status.kind === "recording";

    /**
     * Marks `record` ended for good, as `as` says, in its own folder (see ENDED), while its time
     * remains: one whose time is over never goes on, and reads as it ended.
     */
    const markEnded = (record: StoredRecording, as: keyof typeof ENDED) =>
      Effect.promise(async () => {
        if (record.stop > Date.now())
          await writeFile(join(folderOf(record), ENDED[as]), "").catch(() => {});
      });

    /** How `record` was marked ended for good, and when, if it was. */
    const endedAs = async (record: StoredRecording) => {
      for (const as of ["stopped", "quit"] as const) {
        const marked = await stat(join(folderOf(record), ENDED[as])).catch(() => null);

        if (marked) return { as, at: marked.mtimeMs };
      }

      return null;
    };

    /**
     * Folders of failed starts recordings.json still lists, by id (see FAILED): they go once it is
     * written without them, as the next check does.
     */
    const failedFolders = new Map<string, string>();

    /** The id `folder` is marked with (see CHOSEN), null when none; "" for the profile's own. */
    const markOf = async (folder: string) =>
      folder === root ? "" : readFile(join(folder, CHOSEN), "utf8").catch(() => null);

    /**
     * Whether `folder` is the profile's own, or one the viewer chose, marked, with `mark` when it is
     * given: as a recording that began there has it, unless it began before marks held an id.
     */
    const isThere = async (folder: string, mark?: string) => {
      const now = await markOf(folder);

      return now !== null && (mark === undefined || now === mark);
    };

    /** Whether its own chosen folder marks `record` as a failed start; null while unknown. */
    const failedStart = (record: StoredRecording) =>
      Effect.promise(async () => {
        const failed = await stat(join(folderOf(record), FAILED)).then(
          (): boolean | null => true,
          (cause: NodeJS.ErrnoException) =>
            cause.code === "ENOENT" || cause.code === "ENOTDIR" ? false : null,
        );

        // A failed-start mark on a different storage folder says nothing about this recording.
        return (await isThere(placeOf(record), record.mark)) ? failed : null;
      });

    const unreadable = () =>
      new Failed({ error: { kind: "unexpected", detail: t("Recordings could not be read.") } });

    const usable = read.kind === "read" ? Effect.void : Effect.fail(unreadable());
    /**
     * Records the app didn't see end, as recordings.json kept them, whose chosen folder wasn't
     * there as the app started, by id: read again as then once it is (see reckon).
     */
    const unseen = new Map<string, StoredRecording>();

    /**
     * Reads `record`, which the app didn't see end, as of `now`: a failed start goes (see FAILED);
     * its time over, it was cut short by the quit, with what its file holds; else it goes on,
     * missing the time since its file was last written, or since it paused. While its chosen folder
     * isn't there, nor are its marks and file: it is read again once that folder is (see unseen).
     * One changed while it is read, as by a Stop, stays as that left it.
     */
    const reckon = (
      record: StoredRecording,
      now: number,
      current: StoredRecording | undefined = records.get(record.id),
    ) =>
      Effect.gen(function* () {
        const failed = yield* failedStart(record);

        const file = failed
          ? null
          : yield* Effect.promise(() => stat(fileOf(record)).catch(() => null));

        const left = failed ? null : yield* Effect.promise(() => endedAs(record));

        if (records.get(record.id) !== current) return;

        if (failed === null) unseen.set(record.id, record);
        else unseen.delete(record.id);

        if (failed) {
          records.delete(record.id);
          recordingFiles.delete(record.id);
          failedFolders.set(record.id, folderOf(record));

          return;
        }

        const last = file ? Math.min(file.mtimeMs, record.stop) : record.start;
        const seen = { ...record, bytes: file?.size ?? record.bytes };
        const open = openGap(record);

        // Paused, its gap lasts until it was ended; else it ended where its file was last written.
        if (left)
          records.set(record.id, finalOf(seen, open ? left.at : Math.min(last, left.at), left.as));
        else if (record.stop <= now && failed !== null)
          records.set(
            record.id,
            finalOf(seen, open ? record.stop : last, open ? undefined : "quit"),
          );
        else
          records.set(record.id, {
            ...seen,
            ...(!open && { gaps: [...(record.gaps ?? []), { from: last, to: null, why: "away" }] }),
          });
      });

    if (read.kind === "read") {
      const now = Date.now();

      for (const record of read.items) {
        if (isLive(record)) yield* reckon(record, now);
        else records.set(record.id, record);
      }

      // A recording's folder without its record, as a failed start leaves one (see the header):
      // only once recordings.json is there to say so, and in a chosen folder only one it marked.
      const listed = yield* Effect.promise(() =>
        stat(path).then(
          () => true,
          () => false,
        ),
      );

      for (const folder of listed ? new Set([root, storage.folder ?? root]) : []) {
        const entries = yield* Effect.promise(() =>
          readdir(folder, { withFileTypes: true }).catch(() => []),
        );

        for (const entry of entries) {
          if (!entry.isDirectory() || !RECORDING_FOLDER.test(entry.name)) continue;

          if (records.has(entry.name) || failedFolders.has(entry.name)) continue;
          const stray = join(folder, entry.name);
          yield* Effect.promise(async () => {
            const owner = await readFile(join(stray, OURS), "utf8").catch(() => null);

            if (folder !== root && owner !== root) return;
            await rm(stray, { recursive: true, force: true }).catch(() => {});
          });
        }
      }
    }

    /** What a check, or a recording's end, couldn't write, for the next check to write again. */
    const unsaved = { recordings: failedFolders.size > 0, schedules: false };

    /**
     * Drops a failed start's record (see FAILED) whose mark couldn't be read as the app started,
     * for the next write to take out, with its folder.
     */
    const forgetStart = (record: StoredRecording) => {
      records.delete(record.id);
      recordingFiles.delete(record.id);
      failedFolders.set(record.id, folderOf(record));
      unsaved.recordings = true;
    };

    /** Recordings whose end the last write of recordings.json couldn't keep. */
    const unsavedEnds = new Set<string>();
    /** Recordings the viewer is stopping: none of them goes on meanwhile. */
    const stopping = new Set<string>();
    /**
     * Of `unsavedEnds`, those the viewer stopped, also one that had ended by itself and so reads as
     * it ended: an update's install is refused while one isn't kept (see keepStops).
     */
    const unsavedStops = new Set<string>();
    /** How many times in a row each recording's capture ended quickly, by id. */
    const quickEnds = new Map<string, number>();

    const save = writing(
      Effect.tryPromise({
        try: async () => {
          // One not read yet (see unseen) is kept as it was, its gap not guessed.
          const kept = [
            ...[...records.values()].map((record) =>
              isLive(record) ? (unseen.get(record.id) ?? record) : record,
            ),
            ...beginning.values(),
          ];

          await writeRecordings(path, kept);
          // Failed starts it no longer lists lose their marked folders.
          const listed = new Set(kept.map(({ id }) => id));

          for (const [id, folder] of failedFolders) {
            if (listed.has(id)) continue;
            failedFolders.delete(id);
            void rm(folder, { recursive: true, force: true }).catch(() => {});
          }
        },
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
          unsavedStops.clear();
        }),
      ),
    );

    /**
     * Saves how the recordings `ended` ended, leaving what couldn't be written for the next check
     * to write again, and listed as not saved yet meanwhile.
     */
    const saveEnds = (ended: readonly string[]) =>
      save.pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            unsaved.recordings = true;

            for (const id of ended) unsavedEnds.add(id);
          }),
        ),
      );

    /**
     * Takes a failed start's record out of recordings.json and removes its folder. While it can't
     * be taken out, its folder is marked instead (see FAILED), for the next check, which it wakes,
     * to remove; one that can't be marked is removed all the same.
     */
    const dropStart = (record: StoredRecording) =>
      Effect.suspend(() => {
        const folder = folderOf(record);
        beginning.delete(record.id);
        // Before the check it wakes can write, so that write removes the folder too.
        failedFolders.set(record.id, folder);

        return save.pipe(
          Effect.as(true),
          Effect.catch(() =>
            Effect.andThen(
              Effect.sync(() => (unsaved.recordings = true)),
              Effect.as(wake, false),
            ),
          ),
          Effect.flatMap((out) =>
            Effect.promise(async () => {
              // Never made anew where its parent went, or in another folder in its place, as on a
              // drive away.
              const marked =
                !out &&
                (await isThere(placeOf(record), record.mark)) &&
                (await mkdir(folder)
                  .catch((cause: NodeJS.ErrnoException) => {
                    if (cause.code !== "EEXIST") throw cause;
                  })
                  .then(() => (record.folder ? writeFile(join(folder, OURS), root) : undefined))
                  .then(() => writeFile(join(folder, FAILED), ""))
                  .then(
                    () => true,
                    () => false,
                  ));

              // Still listed as far as this knows: else a save took it out as it was marked.
              if (marked && failedFolders.has(record.id)) return;
              failedFolders.delete(record.id);
              await rm(folder, { recursive: true, force: true }).catch(() => {});
            }),
          ),
        );
      });

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
            mark: _mark,
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

    const fileListeners = new Set<() => void>();
    let filesClosed = false;

    const notifyFiles = () => {
      for (const listener of fileListeners) listener();
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        filesClosed = true;
        recordingFiles.clear();
        notifyFiles();
      }),
    );

    const publish = Effect.andThen(
      Effect.sync(notifyFiles),
      Effect.flatMap(shown, (list) => PubSub.publish(changes, list)),
    );

    /** Looks for gone files again, telling the window when that changed what it lists. */
    const lookAgain = Effect.gen(function* () {
      const gone = () => [...missing].toSorted().join();
      const before = gone();
      yield* look;

      if (gone() !== before) yield* publish;
    });

    let pending: NodeJS.Timeout | null = null;

    const grew = () => {
      notifyFiles();
      pending ??= setTimeout(() => {
        pending = null;
        Effect.runFork(publish);
      }, CHANGES_MS);
    };

    // The room recordings may take: what their files on this computer take against
    // `storage.space`, and what the disk of each folder they write to keeps free against
    // `storage.keepFree`.
    /** What capture into `folder` has written so far, of those active now. */
    const capturingIn = (folder: string) =>
      [...active].reduce((sum, [id, each]) => {
        const record = records.get(id);

        return record && placeOf(record) === folder ? sum + each.bytes() : sum;
      }, 0);

    const used = () =>
      [...records.values()].reduce(
        (sum, record) =>
          missing.has(record.id) ? sum : sum + (active.get(record.id)?.bytes() ?? record.bytes),
        0,
      );

    /**
     * Free bytes of the disk `folder` is on; null when unknown. The profile's own folder may not be
     * made yet: its disk is the nearest folder there. A chosen one must be there.
     */
    const freeIn = async (folder: string) => {
      for (let at = folder; ; at = dirname(at)) {
        const free = await statfs(at).then(
          ({ bavail, bsize }) => bavail * bsize,
          () => null,
        );

        if (free !== null || folder !== root || dirname(at) === at) return free;
      }
    };

    /** Each folder's free bytes as last measured, and what capture into it had written by then. */
    const measured = new Map<string, { free: number | null; at: number; written: number }>();

    const measure = async (folder: string) => {
      const written = capturingIn(folder);
      const known = { free: await freeIn(folder), at: Date.now(), written };
      measured.set(folder, known);

      return known;
    };

    const roomWith = (folder: string, known: { free: number | null; written: number }) =>
      (storage.space === null || used() < storage.space) &&
      (known.free === null ||
        known.free - (capturingIn(folder) - known.written) >= storage.keepFree);

    /**
     * Whether capture into `folder` may write on, as last measured, measuring again now and then,
     * and as soon as a capture there starts or ends (`remeasure`).
     */
    const roomOf = (folder: string) => () => {
      const known = measured.get(folder);

      if (!known || Date.now() - known.at > ROOM_MS) {
        // Taken as measured meanwhile, so one measure runs at a time.
        if (known) measured.set(folder, { ...known, at: Date.now() });
        void measure(folder);
      }

      return known ? roomWith(folder, known) : true;
    };

    const remeasure = (record: StoredRecording) => measured.delete(placeOf(record));

    /** Whether a recording may start or go on in `folder`, as measured now. */
    const roomIn = (folder: string) =>
      Effect.andThen(
        // Files gone since the list was read take no space; the list says so too.
        storage.space === null ? Effect.void : lookAgain,
        Effect.promise(() => measure(folder).then((known) => roomWith(folder, known))),
      );

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
        remeasure(record);

        // Stop and Quit end it for good, whatever ended its capture meanwhile.
        const intent =
          capture.asked === "stopped" || capture.asked === "quit" ? capture.asked : null;

        // Its stream ending quickly again and again ends it, rather than recording that again.
        const quick =
          end === "closed" && now - capture.since < QUICK_MS ? (quickEnds.get(id) ?? 0) + 1 : 0;

        if (quick > 0) quickEnds.set(id, quick);
        else quickEnds.delete(id);

        const why: RecordingGapReason | null =
          end === "until" || intent || now >= record.stop || quick >= QUICK_ENDS
            ? null
            : end === "aborted"
              ? "away"
              : end === "ended"
                ? null
                : end === "closed"
                  ? "stream"
                  : end;

        if (!why) quickEnds.delete(id);
        // Asleep, the gap begins as the computer sleeps; else from what it last wrote.
        const from = end === "aborted" ? now : Math.min(now, capture.lastWrite());
        records.set(
          id,
          why
            ? { ...seen, gaps: [...(seen.gaps ?? []), { from, to: null, why }] }
            : end === "until"
              ? finalOf(seen, now)
              : intent
                ? finalOf(seen, now, intent)
                : end === "aborted"
                  ? finalOf(seen, now, "quit")
                  : finalOf(seen, now, end === "ended" || end === "closed" ? "stream" : cutOf(end)),
        );

        if (intent) yield* markEnded(record, intent);
        // Any later write takes it down too, the next check's at the latest; until then a restart
        // reads it as one the app didn't see end, but for Stop's or Quit's mark, and its
        // schedule's time stays unsettled.
        const written = yield* Effect.result(save);

        if (written._tag === "Failure") {
          unsaved.recordings = true;

          // A pause written later says nothing of an end.
          if (!why) unsavedEnds.add(id);
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

        if (!resumes) yield* storageUsable;

        if (stop <= now || (!resumes && stop > now + RECORDING_MAX_MS))
          return yield* new Failed({
            error: { kind: "invalid-input", detail: t("Choose a stop time within 12 hours.") },
          });

        const stopped = () =>
          resumes && (stopping.has(resumes.id) || !isLive(records.get(resumes.id) ?? resumes));

        const stoppedFailure = new Failed({
          error: { kind: "stream", failure: { kind: "network", detail: t("Stopped.") } },
        });

        const notThere = new Failed({
          error: {
            kind: "unexpected",
            detail: t(
              "The folder for recordings isn't there. Connect its drive, or choose it again in Settings.",
            ),
          },
        });

        // Stopped since it was asked to go on: it asks the provider nothing.
        if (stopped()) return yield* stoppedFailure;

        // A failed start whose mark couldn't be read as the app started, as on a drive away then.
        if (resumes) {
          const failed = yield* failedStart(resumes);

          if (failed === null) return yield* notThere;

          if (failed) {
            forgetStart(resumes);
            yield* publish;
            yield* wake;

            return yield* stoppedFailure;
          }
        }

        // One going on stays where it began. A chosen folder that isn't there, as on a drive not
        // plugged in, is never made anew, or written into on another disk in its place (see
        // CHOSEN).
        const folder = resumes ? placeOf(resumes) : (storage.folder ?? root);
        // A new one keeps its folder's mark, to go on only there.
        const mark = resumes ? resumes.mark : yield* Effect.promise(() => markOf(folder));

        if (mark === null || (resumes && !(yield* Effect.promise(() => isThere(folder, mark)))))
          return yield* notThere;

        // A disk without room records nothing, asks the provider nothing and holds no connection
        // for it.
        if (!(yield* roomIn(folder)))
          return yield* new Failed({
            error: { kind: "unexpected", detail: t("There isn't enough free space to record.") },
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
            try: async (signal) => ({
              id,
              stream: await source.provider.liveStream(
                id,
                AbortSignal.any([signal, controller.signal]),
              ),
            }),
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

        if (options.stopPlaying) yield* playback.closeOf(subscriptionId);

        // A stream of the channel that plays now, under this login, is recorded from what it
        // reads: that stream alone, on the connection it holds.
        const keyed = streams.map((each) => ({
          ...each,
          key: streamKey(subscriptionId, source.revision, listed.id, each.id, each.stream),
        }));

        const shared = keyed.find((each) => each.key !== null && captures.reading(each.key));
        const tried = shared ? [shared] : keyed;

        const admitted = yield* coordination.hold(
          subscriptionId,
          limitOf(subscriptionId),
          options.stopPlaying ?? false,
          shared?.key ?? undefined,
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
            ...(folder !== root && { folder, ...(mark && { mark }) }),
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

        // Stopped while it waited for a connection: it lets it go, keeping no record.
        if (stopped() || controller.signal.aborted) {
          held.release();

          return yield* stoppedFailure;
        }

        if (!resumes) {
          beginning.set(id, {
            ...record,
            ...(options.variants?.length && { variants: options.variants }),
          });
          const kept = yield* Effect.result(save);

          if (kept._tag === "Failure") {
            held.release();
            yield* dropStart(record);

            return yield* kept.failure;
          }
        }

        // Its own folder is made, or made again when it went while the recording paused, in the
        // chosen folder as it is now, its drive maybe gone while the provider answered.
        const opening = isThere(folder, record.mark)
          .then((there) => {
            if (!there) throw notThere;
          })
          .then(() => mkdir(folderOf(record), { recursive: true }))
          .then(() =>
            resumes || folder === root ? undefined : writeFile(join(folderOf(record), OURS), root),
          )
          .then(() =>
            startCapture(
              tried.map(({ key, stream: { url, format, headers } }) => ({
                url,
                format,
                headers: headers ?? {},
                shared: key,
                joining: shared !== undefined,
                variant: key === null ? null : captures.joins(key),
              })),
              fileOf(record),
              {
                request: source.provider.request,
                captures: {
                  request: captures.request,
                  resource: captures.resource,
                  owner: held.id,
                },
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
            cause instanceof Failed
              ? cause
              : cause instanceof CaptureFailure
                ? new Failed({ error: { kind: "stream", failure: cause.failure } })
                : new Failed({
                    error: {
                      kind: "unexpected",
                      // The system's own words name paths and codes, not what to do.
                      detail: t("The recording couldn't be written to this computer."),
                    },
                  }),
        }).pipe(
          // Also when the app closes meanwhile: whatever started ends before its folder goes, and
          // its record before that, so a crash between leaves a folder the next start cleans up,
          // not a record that goes on; while recordings.json still lists it, its folder stays
          // marked FAILED. One going on keeps its folder, its file as it was.
          Effect.onError(() =>
            Effect.promise(async () => {
              controller.abort();
              await opening.then(
                (opened) => opened.ended,
                () => {},
              );
              // What it read last ends its provider request before the connection counts free.
              await captures.idle(held.id);
              held.release();
            }).pipe(Effect.andThen(resumes ? Effect.void : dropStart(record))),
          ),
        );

        const { promise: settled, resolve } = Promise.withResolvers<Failed | null>();
        // Stopped by its subscription going, or its Stop, as it started: it ends as one the
        // viewer stopped.
        const asked = controller.signal.reason === "stopped" ? "stopped" : null;

        const live: Active = {
          key: tried[capture.source]!.key,
          controller,
          bytes: capture.bytes,
          lastWrite: capture.lastWrite,
          since: Date.now(),
          asked,
          settled,
        };

        // Going on, its gap ends now; new, it goes on later with the stream it captures.
        const started: StoredRecording = resumes
          ? {
              ...record,
              ...(record.gaps && {
                gaps: record.gaps.map((gap) =>
                  gap.to === null ? { ...gap, to: Date.now() } : gap,
                ),
              }),
            }
          : { ...record, variants: [tried[capture.source]!.id] };

        records.set(id, started);
        beginning.delete(id);
        active.set(id, live);
        remeasure(started);
        settle();
        void capture.ended
          .then(async (end) => {
            await captures.idle(held.id);
            held.release();

            return Effect.runPromise(ended(id, end, live));
          })
          .then(resolve, () => resolve(null));
        const written = yield* Effect.result(save);

        // Its record as it was kept before it captured says it records meanwhile.
        if (written._tag === "Failure") unsaved.recordings = true;
        yield* publish;
        // What the schedules say of the connections changed.
        yield* wake;

        const {
          file: _file,
          folder: _folder,
          mark: _mark,
          variants: _variants,
          ...recording
        } = started;

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
        // Nothing starts as the app closes or an update restarts it, nor by itself as the
        // computer sleeps.
        if (closing || held || (asleep !== null && (options.resumes || options.scheduled)))
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

        return Effect.andThen(
          Effect.forEach(paused, (record) => markEnded(record, as), { discard: true }),
          Effect.andThen(saveEnds(paused.map((each) => each.id)), publish),
        );
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
        Effect.gen(function* () {
          yield* Effect.ignore(end([...active.keys()], leaving));

          // Quit ends those paused too, and those whose end wasn't written: none goes on when
          // the app runs again.
          if (leaving === "quit") {
            yield* Effect.forEach(
              [...unsavedEnds].flatMap((id) => records.get(id) ?? []),
              (record) => markEnded(record, "quit"),
              { discard: true },
            );
            yield* endPaused(() => true, "quit");
          }

          // Shutdown also retries recording metadata writes, including playback position.
          if (unsaved.recordings) yield* Effect.ignore(save);
        }),
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
    const rulesPath = join(root, "rules.json");
    let rules = yield* Effect.promise(() => readRules(rulesPath));

    const ruleFailure = (detail: PlainKey) =>
      new Failed({ error: { kind: "unexpected", detail: t(detail) } });

    const rulesUsable = Effect.suspend(() =>
      rules === null
        ? Effect.fail(ruleFailure("Recording rules could not be read."))
        : schedulesUsable,
    );

    const persistRules = (next: KeptRule[]) =>
      Effect.tap(
        Effect.tryPromise({
          try: () => writeRules(rulesPath, next),
          catch: () => ruleFailure("Recording rules could not be saved."),
        }),
        () =>
          Effect.sync(() => {
            rules = next;
          }),
      );

    // Main names each airing a rule found `rule:<uuid>`; the window reads `ScheduledRecording.rule`.
    const isRuleSchedule = (id: string) => id.startsWith("rule:");

    /** The rule that made schedule `id`, for its standing. */
    const ruleOf = (id: string) =>
      isRuleSchedule(id)
        ? rules?.find((rule) => rule.occurrences.some((each) => each.id === id))?.id
        : undefined;

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
    /** Last snapshot; publish again when schedules or connection owners change. */
    let shownSchedules: readonly ScheduledRecording[] = [];
    let ownersChanged = false;
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
        try: () =>
          writeSchedules(
            schedulesPath,
            [...schedules.values()].filter((each) => !isRuleSchedule(each.id)),
          ),
        catch: () =>
          new Failed({ error: { kind: "unexpected", detail: t("Schedules could not be saved.") } }),
      }),
    );

    const ruleErrors = new Map<string, string>();
    const blockedRules = new Set<string>();

    const findRuleMatches = (plan: RecordingRulePlan, status: readonly GuideStatus[]) =>
      Effect.gen(function* () {
        yield* rulesUsable;
        const matches = [];
        let limited = false;

        for (const subscriptionId of new Set(plan.channels.map((each) => each.subscriptionId))) {
          const available = status.find((each) => each.subscriptionId === subscriptionId);

          if (!available) return yield* ruleFailure("This rule's subscription is no longer there.");

          // Availability describes only the subscription's own guide. Global XMLTV
          // sources can supply its channels even when that own guide is absent.
          if (available.availability !== "available" && available.supplied.length === 0)
            return yield* ruleFailure("This rule's guide could not be read.");

          const page = yield* guide.searchPage({
            from: Date.now(),
            subscriptionId,
            query: plan.title,
            channels: plan.channels
              .filter((each) => each.subscriptionId === subscriptionId)
              .map((each) => each.id),
            limit: RECORDING_RULE_LIMITS.matches,
          });

          matches.push(...page.matches);
          limited ||= page.next !== null;
        }

        return planRule(plan, matches, Date.now(), limited);
      });

    /** Preview and reconciliation must retain the same airing identity after guide shifts. */
    const existingAiring = (
      occurrences: KeptRule["occurrences"],
      preview: RecordingRulePreview,
      match: RecordingRulePreview["matches"][number],
    ) => {
      const shifted = occurrences.filter((each) => {
        const interval = each.observed ?? each.plan;

        return (
          ownedKey(each.plan.channel) === ownedKey(match.plan.channel) &&
          (each.settled ||
            recordingOf(each.id) ||
            startsOf.has(each.id) ||
            !preview.matches.some((candidate) => candidate.identity === each.identity)) &&
          interval.start < match.plan.stop &&
          match.plan.start < interval.stop &&
          (!each.episodeIdentity ||
            !match.episodeIdentity ||
            each.episodeIdentity === match.episodeIdentity ||
            each.settled ||
            recordingOf(each.id) ||
            startsOf.has(each.id))
        );
      });

      return (
        occurrences.find((each) => each.identity === match.identity) ??
        (shifted.length === 1 ? shifted[0] : shifted.length > 0 ? null : undefined)
      );
    };

    const previewRule = (plan: RecordingRulePlan, status: readonly GuideStatus[], id?: string) =>
      Effect.gen(function* () {
        const preview = yield* findRuleMatches(plan, status);
        const now = Date.now();

        const candidates = preview.matches.map((match, i) => {
          const occurrence = existingAiring(
            rules?.find((rule) => rule.id === id)?.occurrences ?? [],
            preview,
            match,
          );

          if (occurrence === null || occurrence?.settled) return undefined;

          const saved = occurrence && schedules.get(occurrence.id);

          return {
            id: saved?.id ?? `preview:${i}`,
            plan: match.plan,
            channelName: match.channelName,
            created: saved?.created ?? now,
            through: saved?.through ?? now,
            priority: plan.priority ?? RECORDING_PRIORITY_DEFAULT,
          };
        });

        const kept = [...schedules.values()].filter(
          (each) =>
            id === undefined ||
            ruleOf(each.id) !== id ||
            recordingOf(each.id) ||
            startsOf.has(each.id),
        );

        const capacity = yield* capacityOf(
          [...kept, ...candidates.filter((each) => each !== undefined)],
          now,
        );

        return {
          ...preview,
          matches: preview.matches.map((match, i) => {
            const candidate = candidates[i];
            const forecast = candidate && capacity.get(candidate.id);

            return { ...match, ...(forecast && { capacity: forecast }) };
          }),
        };
      });

    /** Durable identities precede schedules and capture. Settled identities never expire into
     * eligibility; a full history stops admitting work until the viewer creates another rule. */
    const reconcileRules = Effect.gen(function* () {
      yield* rulesUsable;
      const next: KeptRule[] = [];
      ruleErrors.clear();
      blockedRules.clear();

      const saved = new Set((yield* subscriptions.saved).map((each) => each.id));

      // Retire dead work durably, retaining identities and observed intervals for suppression.
      // Recent expired work still reaches the scheduler's ordinary Missed path.
      const retained = (rules ?? []).map((rule) => ({
        ...rule,
        occurrences: rule.occurrences.map((each) => ({
          ...each,
          settled:
            each.settled ||
            (!startsOf.has(each.id) &&
              ([...records.values()].some((record) => record.scheduled?.schedule === each.id) ||
                (!recordingOf(each.id) &&
                  (!saved.has(each.plan.channel.subscriptionId) ||
                    each.plan.stop + each.plan.padding.after * 60_000 <=
                      Date.now() - MISSED_KEPT_MS)))),
        })),
      }));

      let queued = retained.reduce(
        (count, rule) => count + rule.occurrences.filter((each) => !each.settled).length,
        0,
      );

      const observed = new Set<string>();
      const status = yield* guide.status;

      for (const rule of retained) {
        const checked = yield* Effect.result(findRuleMatches(rule.plan, status));
        const occurrences = rule.occurrences;

        if (checked._tag === "Failure") {
          blockedRules.add(rule.id);
          ruleErrors.set(
            rule.id,
            checked.failure.error.kind === "unexpected"
              ? checked.failure.error.detail
              : t("This rule's guide could not be read."),
          );

          for (const each of occurrences) observed.add(each.id);
          next.push(rule);
          continue;
        }

        const preview = checked.success;

        // Expired retained airings must reach the ordinary Missed path, even after restart.
        for (const each of occurrences)
          if (
            !each.settled &&
            (preview.matches.length === 0 ||
              each.plan.stop + each.plan.padding.after * 60_000 <= Date.now())
          )
            observed.add(each.id);

        for (const match of preview.matches) {
          // Retain overlapping observations separately from the immutable capture plan.
          // The guide can carry clipped old slots alongside a replacement; settled/active
          // intervals keep their union so those old slots cannot erase suppression history.
          const was = existingAiring(occurrences, preview, match);

          if (was) {
            was.identity = match.identity;
            const interval = was.observed ?? was.plan;
            was.observed =
              was.settled || recordingOf(was.id) || startsOf.has(was.id)
                ? {
                    start: Math.min(interval.start, match.plan.start),
                    stop: Math.max(interval.stop, match.plan.stop),
                  }
                : { start: match.plan.start, stop: match.plan.stop };

            if (!was.settled && !startsOf.has(was.id) && !recordingOf(was.id)) {
              was.plan = match.plan;
              was.channelName = match.channelName;
            }
          } else if (was === null) {
            // Ambiguous overlap cannot safely revive a settled or active airing.
            continue;
          } else if (
            occurrences.length < RECORDING_RULE_LIMITS.history &&
            queued < RECORDING_RULE_LIMITS.queued
          ) {
            occurrences.push({
              ...match,
              id: `rule:${randomUUID()}`,
              settled: false,
              observed: { start: match.plan.start, stop: match.plan.stop },
            });
            queued++;
          }
        }

        for (const each of occurrences)
          if (preview.matches.some((match) => match.identity === each.identity))
            observed.add(each.id);

        if (occurrences.length >= RECORDING_RULE_LIMITS.history)
          ruleErrors.set(rule.id, t("This recording rule’s airing history is full."));
        next.push({ ...rule, occurrences });
      }

      if (!isDeepStrictEqual(next, rules)) yield* persistRules(next);

      const wanted = new Set(
        next.flatMap((rule) =>
          rule.occurrences
            .filter((each) => !each.settled && observed.has(each.id))
            .map((each) => each.id),
        ),
      );

      for (const id of schedules.keys()) {
        if (isRuleSchedule(id) && !wanted.has(id) && !startsOf.has(id) && !recordingOf(id))
          schedules.delete(id);
      }

      for (const rule of next)
        for (const each of rule.occurrences) {
          if (each.settled || !observed.has(each.id) || startsOf.has(each.id)) continue;
          const was = schedules.get(each.id);
          schedules.set(each.id, {
            id: each.id,
            plan: each.plan,
            channelName: each.channelName,
            created: was?.created ?? Date.now(),
            through: was?.through ?? each.plan.start - each.plan.padding.before * 60_000 - 1,
          });
        }
    });

    const settleRuleSchedule = (id: string) =>
      Effect.gen(function* () {
        if (!isRuleSchedule(id)) return;
        yield* rulesUsable;

        const next = (rules ?? []).map((rule) => ({
          ...rule,
          occurrences: rule.occurrences.map((each) =>
            each.id === id ? { ...each, settled: true } : each,
          ),
        }));

        if (!isDeepStrictEqual(next, rules)) yield* persistRules(next);
      });

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

    const priorityOf = (id: string) =>
      rules?.find((rule) => rule.id === ruleOf(id))?.plan.priority ?? RECORDING_PRIORITY_DEFAULT;

    /** A schedule's occurrence in the priority queue; a previewed one brings its own priority. */
    const pendingOf = (
      schedule: KeptSchedule & { readonly priority?: number },
      occurrence: Occurrence,
    ): PendingCapture => ({
      ...occurrence,
      id: schedule.id,
      channel: ownedKey(schedule.plan.channel),
      title: schedule.plan.title,
      priority: schedule.priority ?? priorityOf(schedule.id),
      created: schedule.created,
    });

    /** Shares the displayed next unsettled occurrence with the forecast horizon. */
    const nextPending = (schedule: KeptSchedule, now: number) => {
      const on = nextOccurrence(schedule.plan, now);

      return on && (recordOf(schedule.id, on) || on.stop <= schedule.through)
        ? nextOccurrence(schedule.plan, on.stop)
        : on;
    };

    /** Keep current owners protected; only unstarted occurrences enter the priority queue. */
    const capacityOf = (
      kept: readonly (KeptSchedule & { readonly priority?: number })[],
      now: number,
    ) =>
      Effect.gen(function* () {
        const result = new Map<string, RecordingCapacity>();

        for (const subscriptionId of new Set(
          kept.map((each) => each.plan.channel.subscriptionId),
        )) {
          const own = kept.filter((each) => each.plan.channel.subscriptionId === subscriptionId);

          const horizon = Math.max(
            now + 1,
            ...own.map((each) => nextPending(each, now)?.stop ?? now),
          );

          const pending = own.flatMap((each) => {
            if (holds.get(each.id)) return [];

            return occurrences(each.plan, now, horizon)
              .filter(
                (occurrence) => !recordOf(each.id, occurrence) && occurrence.stop > each.through,
              )
              .map((occurrence, i) => ({
                ...pendingOf(each, occurrence),
                id: i === 0 ? each.id : occurrenceKey(each.id, occurrence),
              }));
          });

          const watching = yield* coordination.watching(subscriptionId);

          const protectedUses: Holding[] = recordingHoldings(subscriptionId).map((holding) =>
            watching.has(holding.channel)
              ? { ...holding, until: Infinity, holder: { kind: "watch" } }
              : holding,
          );

          const uses = yield* coordination.uses(subscriptionId);
          // Match current source keys, not just channel IDs: a replaced login or a different
          // variant must not promise sharing with a capture of the old source.
          const selected = new Map<string, string>();

          if (uses.includes("watch") || protectedUses.length > 0) {
            yield* Effect.gen(function* () {
              const source = yield* subscriptions.sourceOf(subscriptionId);

              const lookup = yield* library.lookup(subscriptionId);

              const preferences = {
                ...(yield* settings.get),
                ...(yield* settings.ofSubscription(subscriptionId)),
              };

              // A playlist's playback snapshot has no mapping inspection or refresh-on-miss.
              // Undefined from that read means no known sharing, never a network fallback.
              for (const schedule of own) {
                const listed = lookup(schedule.plan.channel.id);

                if (!listed) continue;

                for (const variant of streamsToPlay(listed, preferences, undefined)) {
                  const stream = yield* Effect.tryPromise({
                    try: () =>
                      source.provider.currentLiveStream
                        ? Promise.resolve(source.provider.currentLiveStream(variant.id) ?? null)
                        : source.provider.liveStream(variant.id),
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

                  const key = streamKey(
                    subscriptionId,
                    source.revision,
                    listed.id,
                    variant.id,
                    stream,
                  );

                  const channel = ownedKey(schedule.plan.channel);

                  if (key !== null) {
                    if (!selected.has(channel) || captures.reading(key)) selected.set(channel, key);
                  }
                }
              }
            }).pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  // Failed source reads retain current owners and promise no sharing.
                  selected.clear();
                }),
              ),
            );
          }

          for (const connection of watching) {
            if (protectedUses.some((use) => use.channel === connection)) continue;

            protectedUses.push({ channel: connection, until: Infinity, holder: { kind: "watch" } });
          }

          if (uses.includes("download")) {
            protectedUses.push({
              channel: "occupied:download",
              until: Infinity,
              holder: { kind: "download" },
            });
          }

          for (const [id, capacity] of forecastCapacity(
            pending.map((each) => ({
              ...each,
              channel: selected.get(each.channel) ?? each.channel,
            })),
            protectedUses,
            yield* limitOf(subscriptionId),
            now,
          ))
            result.set(id, capacity);
        }

        return result;
      });

    /** What each of the subscription's captures holds now: the source it reads, until it ends. */
    const recordingHoldings = (subscriptionId: string) =>
      [...active.entries()].flatMap(([id, capture]) => {
        const record = records.get(id);

        return record?.channel.subscriptionId === subscriptionId
          ? [
              {
                channel: capture.key ?? `recording:${id}`,
                until: record.stop,
                holder: { kind: "recording", title: record.title, until: record.stop } as const,
              },
            ]
          : [];
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
      forecast?: ReadonlyMap<string, RecordingCapacity>,
    ) =>
      Effect.gen(function* () {
        const { plan } = schedule;
        const on = nextOccurrence(plan, now);

        const rule = ruleOf(schedule.id);

        const as = (status: ScheduleStatus, next = on): ScheduledRecording => ({
          id: schedule.id,
          plan,
          channelName: schedule.channelName,
          next,
          status,
          ...(rule && { rule }),
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
        const next = nextPending(schedule, now);

        if (hold) return as(hold, next);

        if (!next) return as({ kind: "planned" }, next);
        const { subscriptionId } = plan.channel;
        const reason = next.start <= now ? why.get(occurrenceKey(schedule.id, next)) : undefined;

        if (reason === "busy")
          return as({ kind: "waiting", holders: yield* holdersNow(subscriptionId) }, next);

        if (reason === "stream" || reason === "disk")
          return as({ kind: "retrying", why: reason }, next);

        const capacity = (
          forecast ??
          (yield* capacityOf([...kept.filter((each) => each.id !== schedule.id), schedule], now))
        ).get(schedule.id);

        return as(
          capacity && capacity.kind !== "available"
            ? { kind: "conflict", holders: capacity.holders }
            : { kind: "planned" },
          next,
        );
      });

    /** Every schedule kept, by when it records next. */
    const standings = (now: number) => {
      const kept = [...schedules.values()];

      return Effect.gen(function* () {
        const forecast = yield* capacityOf(kept, now);

        const list = yield* Effect.forEach(kept, (schedule) =>
          standingOf(schedule, kept, now, holds.get(schedule.id), forecast),
        );

        return list.toSorted(
          (a, b) =>
            (a.next?.start ?? Infinity) - (b.next?.start ?? Infinity) ||
            a.channelName.localeCompare(b.channelName),
        );
      });
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
      const rule = ruleOf(schedule.id);

      return {
        schedule: schedule.id,
        ...(rule && { rule }),
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

          // Taken out meanwhile, as with its subscription, it starts nothing; asleep meanwhile, it
          // starts once the computer wakes.
          if (!schedules.has(schedule.id)) return null;

          if (asleep !== null) return "asleep" as const;

          return yield* start(plan.channel, occurrence.stop, {
            scheduled: scheduledOf(schedule, occurrence, late),
            title: listed?.title ?? plan.title,
          });
        }).pipe(
          Effect.match({
            onSuccess: (answer) => {
              if (answer === "asleep") tried.delete(key);

              if (answer === null || answer === "asleep" || answer.kind === "started")
                why.delete(key);
              else why.set(key, "busy");
            },
            // This computer's when unexpected, as a file it couldn't write; else the stream's,
            // a lost login included.
            onFailure: ({ error }) => {
              // Cut short as the computer slept: it starts after the wake, as if never asked.
              if (asleep !== null) {
                why.delete(key);
                tried.delete(key);
              } else why.set(key, error.kind === "unexpected" ? "disk" : "stream");
            },
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

    /**
     * Goes on with a paused recording in the background; a check follows its answer. Refused, it
     * stays paused and is asked again, saying so when every connection is held or there is no
     * room, and otherwise keeping the reason it paused for.
     */
    const resumeRecording = (record: StoredRecording) => {
      const { subscriptionId } = record.channel;
      startingOn.add(subscriptionId);
      Effect.runFork(
        Effect.gen(function* () {
          // A drive away isn't measured: its mount point's disk says nothing of its room.
          if (!(yield* Effect.promise(() => isThere(placeOf(record), record.mark)))) return null;

          if (!(yield* roomIn(placeOf(record)))) return "space" as const;
          const answer = yield* start(record.channel, record.stop, { resumes: record });

          return answer.kind === "busy" ? ("busy" as const) : null;
        }).pipe(
          Effect.orElseSucceed((): RecordingGapReason | null => null),
          Effect.catchDefect(() => Effect.succeed(null)),
          Effect.flatMap((why) => {
            const now = why && records.get(record.id);
            const open = now && isLive(now) && !active.has(now.id) && openGap(now);

            if (!now || !open || open.why === why) return Effect.void;
            records.set(now.id, {
              ...now,
              gaps: [...(now.gaps ?? []).slice(0, -1), { ...open, why }],
            });

            return publish;
          }),
          Effect.ensuring(Effect.sync(() => startingOn.delete(subscriptionId))),
          Effect.andThen(wake),
        ),
      );
    };

    /**
     * When the computer went to sleep: nothing starts or goes on until it wakes and checks, or, as
     * where the system never says it woke, a check comes a minute later.
     */
    let asleep: number | null = null;
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
        const over: string[] = [];

        for (let record of records.values()) {
          if (!isLive(record) || active.has(record.id)) continue;

          if (
            stopping.has(record.id) ||
            [...starting.values()].some((each) => each.resumes === record.id)
          ) {
            paused = true;
            continue;
          }

          // Read as the app started once its folder is back, where a Stop or Quit may have marked
          // it ended: nothing goes on until then.
          const kept = unseen.get(record.id);

          if (kept) {
            if (!(yield* Effect.promise(() => isThere(placeOf(kept), kept.mark)))) {
              paused = true;
              continue;
            }

            yield* reckon(kept, now);
            const again = records.get(record.id);

            if (stopping.has(record.id)) {
              paused = true;
              continue;
            }

            if (!again || !isLive(again)) {
              resumeTried.delete(record.id);
              over.push(record.id);
              continue;
            }

            record = again;
          }

          if (record.stop <= now) {
            const failed = yield* failedStart(record);

            if (failed === null) {
              paused = true;
              continue;
            }

            if (failed) forgetStart(record);
            else records.set(record.id, finalOf(record, now));
            resumeTried.delete(record.id);
            over.push(record.id);
            continue;
          }

          paused = true;
          const { subscriptionId } = record.channel;

          if (startingOn.has(subscriptionId)) continue;

          if ((resumeTried.get(record.id) ?? -Infinity) + RETRY_MS > now) continue;
          resumeTried.set(record.id, now);
          resumeRecording(record);
        }

        if (over.length > 0) {
          yield* saveEnds(over);
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

      if (asleep !== null && Date.now() - asleep < CHECK_MS) return asleep + CHECK_MS;
      asleep = null;

      for (const [id, progress] of pendingProgress) {
        if (!records.has(progress.id)) {
          pendingProgress.delete(id);
          continue;
        }

        if (Date.now() < progress.retryAt) continue;
        progress.retryAt = Date.now() + RETRY_MS;

        const available = yield* Effect.result(progress.owner.available);

        if (available._tag === "Failure") continue;

        if (!available.success) {
          pendingProgress.delete(id);
          continue;
        }

        const saved = yield* Effect.result(
          progress.owner.write(
            "recording",
            progress.id,
            progress.position,
            progress.duration,
            progress.watchedAt,
          ),
        );

        if (saved._tag === "Success" && pendingProgress.get(id) === progress) {
          pendingProgress.delete(id);
          yield* PubSub.publish(progressChanges, { owner: progress.owner.owner, id: progress.id });
        }
      }

      const paused = yield* resumeDue(Date.now());
      const resumeAt = paused || pendingProgress.size > 0 ? Date.now() + RETRY_MS : null;

      if (readKept.kind !== "read") {
        // What recordings.json couldn't keep is written again whatever schedules.json holds.
        if (!unsaved.recordings) return resumeAt;
        unsaved.recordings = (yield* Effect.result(save))._tag === "Failure";
        yield* publish;

        return unsaved.recordings ? Date.now() + RETRY_MS : resumeAt;
      }

      // With none kept, nothing is asked of the lists, the guide or the clock: a schedule saved
      // wakes the next check.
      if (schedules.size === 0 && !rules?.length && !unsaved.recordings && !unsaved.schedules) {
        if (shownSchedules.length > 0 || ownersChanged) {
          ownersChanged = false;
          shownSchedules = [];
          yield* PubSub.publish(scheduleChanges, shownSchedules);
        }

        return resumeAt;
      }

      const previousErrors = new Map(ruleErrors);
      const ruleCheck = yield* Effect.result(reconcileRules);

      if (ruleCheck._tag === "Failure" && (rules?.length ?? 0) > 0)
        yield* Effect.logWarning("[recordings] rules could not be checked or saved; trying again");

      if (ruleCheck._tag === "Failure")
        for (const rule of rules ?? [])
          ruleErrors.set(rule.id, t("Recording rules could not be saved."));

      const now = Date.now();
      const saved = new Set((yield* subscriptions.saved).map((each) => each.id));
      let dirty = false;
      let missed = false;
      let retry = false;
      const found = new Map<string, Hold | null>();
      const inLine = (each: KeptSchedule) => nextOccurrence(each.plan, now)?.start ?? Infinity;

      const ordered = [...schedules.values()].toSorted(
        (a, b) =>
          Math.max(now, inLine(a)) - Math.max(now, inLine(b)) ||
          comparePending(
            pendingOf(a, { start: inLine(a), stop: Infinity }),
            pendingOf(b, { start: inLine(b), stop: Infinity }),
          ),
      );

      for (const schedule of ordered) {
        if (
          isRuleSchedule(schedule.id) &&
          (ruleCheck._tag === "Failure" || blockedRules.has(ruleOf(schedule.id) ?? ""))
        )
          continue;

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

      const forecast = yield* Effect.result(standings(now));

      if (forecast._tag === "Failure") {
        yield* Effect.logWarning("[recordings] capacity could not be checked; trying again");

        return now + RETRY_MS;
      }

      const list = forecast.success;

      if (
        ownersChanged ||
        !isDeepStrictEqual(list, shownSchedules) ||
        !isDeepStrictEqual(previousErrors, ruleErrors)
      ) {
        ownersChanged = false;
        shownSchedules = list;
        yield* PubSub.publish(scheduleChanges, list);
      }

      const starts = list.flatMap((each) =>
        each.next && each.next.start > now ? [each.next.start] : [],
      );

      return Math.min(
        now + (retry || paused || pendingProgress.size > 0 ? RETRY_MS : CHECK_MS),
        ...starts,
      );
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
    // Ownership changes can alter an open rule preview even with no saved schedules.
    // The normal check publishes once; reading that snapshot never changes ownership.
    yield* Effect.forkScoped(
      Stream.runForEach(coordination.busyChanged, () =>
        Effect.andThen(
          Effect.sync(() => {
            ownersChanged = true;
          }),
          wake,
        ),
      ),
    );

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

        // Reconciling would put the rule's plan back: an airing a rule found changes with its rule.
        if (id !== undefined && isRuleSchedule(id))
          return yield* new Failed({
            error: {
              kind: "invalid-input",
              detail: t("A rule sets this schedule. Change the rule instead."),
            },
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
      Effect.andThen(usable, storageUsable),
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

    /** One change of storage.json at a time, each made from the one before. */
    const changingStorage = (yield* Semaphore.make(1)).withPermits(1);

    /** Keeps storage.json as `change` makes it, the settings as they were when that fails. */
    const changeStorage = (change: (now: KeptStorage) => KeptStorage) =>
      changingStorage(
        Effect.gen(function* () {
          yield* usable;
          yield* storageUsable;
          const next = change(storage);
          yield* Effect.tryPromise({
            try: () => writeStorage(storagePath, next),
            catch: () =>
              new Failed({
                error: { kind: "unexpected", detail: t("Recording settings could not be saved.") },
              }),
          });
          storage = next;
          measured.clear();
        }),
      );

    /**
     * A recording's own file as it is written: committed extent, status and gaps, indexed for its
     * program and media time. Fails when it is unknown or missed.
     */
    const recordingSource = (id: string) =>
      Effect.gen(function* () {
        yield* usable;
        const record = records.get(id);

        if (!record || record.status.kind === "missed")
          return yield* new Failed({
            error: { kind: "stream", failure: { kind: "unavailable", status: 404 } },
          });
        const cached = recordingFiles.get(id);

        if (cached) {
          yield* Effect.tryPromise({ try: (signal) => cached.read(signal), catch: failedWith });

          return cached;
        }

        const path = fileOf(record);
        let previous: RecordingExtent | undefined;

        const readCurrent = async (signal?: AbortSignal): Promise<RecordingExtent> => {
          signal?.throwIfAborted();

          if (filesClosed) throw new Error("Recording owner closed.");
          const beforeRecord = records.get(id);
          const beforeCapture = active.get(id);
          const committed = beforeCapture?.bytes() ?? beforeRecord?.bytes;
          const found = await stat(path, { bigint: true });
          signal?.throwIfAborted();
          const current = records.get(id);

          // A settled writer must not publish its final status with an earlier byte snapshot.
          if (current !== beforeRecord || active.get(id) !== beforeCapture)
            return readCurrent(signal);

          if (!current || current.status.kind === "missed" || missing.has(id))
            throw new Error("Recording is unavailable.");
          const capture = active.get(id);
          const bytes = committed ?? current.bytes;

          if (!found.isFile() || found.size < bytes)
            throw new Error("Recording file is missing, replaced or truncated.");

          const status =
            isLive(current) && !capture
              ? { kind: "paused" as const, why: openGap(current)?.why ?? ("away" as const) }
              : current.status;

          const facts = {
            bytes,
            mediaRevision: current.gaps?.length ?? 0,
            device: found.dev.toString(),
            inode: found.ino.toString(),
            status,
            final: !isLive(current) && !capture,
            duration: null,
            seekable: [],
            gaps: current.gaps ?? [],
          };

          const revision =
            previous && isDeepStrictEqual({ ...previous, revision: 0 }, { ...facts, revision: 0 })
              ? previous.revision
              : (previous?.revision ?? -1) + 1;

          previous = { ...facts, revision };

          return previous;
        };

        // Assign revisions in observation order, including reads made by EOF waiters.
        let tail = Promise.resolve();

        const read = (signal?: AbortSignal) => {
          const next = tail.then(() => readCurrent(signal));
          tail = next.then(
            () => undefined,
            () => undefined,
          );

          return next;
        };

        const source: RecordingFile = {
          read,
          wait: async (revision, signal) => {
            for (;;) {
              signal.throwIfAborted();
              // Subscribe before reading: an append during stat cannot fall between check and wait.
              const change = Promise.withResolvers<void>();
              const wake = () => change.resolve();
              fileListeners.add(wake);
              signal.addEventListener("abort", wake, { once: true });

              try {
                const next = await read(signal);

                if (next.revision > revision) return next;
                await change.promise;
              } finally {
                fileListeners.delete(wake);
                signal.removeEventListener("abort", wake);
              }
            }
          },
        };

        const file = indexRecording(path, recordingFile(path, source));
        recordingFiles.set(id, file);
        yield* Effect.tryPromise({ try: (signal) => file.read(signal), catch: failedWith });

        return file;
      });

    return {
      list: usable.pipe(Effect.andThen(look), Effect.andThen(shown)),
      connections: (
        subscriptionId: string,
        of?: { readonly channel: string; readonly variants: readonly string[] },
      ) =>
        Effect.gen(function* () {
          const limit = yield* limitOf(subscriptionId);
          const uses = yield* coordination.uses(subscriptionId);

          // A source that can't be read, as without its login, still gets the count, unshared.
          const source = of?.variants.length
            ? yield* Effect.orElseSucceed(subscriptions.sourceOf(subscriptionId), () => null)
            : null;

          if (!of || !source) return { limit, uses };

          const streams = yield* Effect.forEach(of.variants, (id) =>
            Effect.promise(async () => ({
              id,
              stream: await source.provider.liveStream(id).catch(() => null),
            })),
          );

          const shares = streams.some(({ id, stream }) => {
            const key = streamKey(subscriptionId, source.revision, of.channel, id, stream);

            return key !== null && captures.reading(key);
          });

          return { limit, uses, shares };
        }),
      start,
      stop: (id: string) =>
        Effect.gen(function* () {
          stopping.add(id);
          // A start going on with it ends first: it ends as stopped, or never begins. A failed
          // write of how it ended is written below, with the rest.
          yield* stopResuming(id);
          yield* Effect.ignore(end([id], "stopped"));
          // Paused, it ends where its capture last stopped.
          const record = records.get(id);

          if (!record) return;

          if (isLive(record) && !active.has(id))
            records.set(id, finalOf(record, Date.now(), "stopped"));
          // Also one that ended by itself, its end maybe not written yet: stopped, it never goes on
          // after a relaunch either.
          yield* markEnded(record, "stopped");
          // Capture may have ended before Stop arrived. Retry its terminal record too; until it is
          // written, the list says so and the check tries again.
          const written = yield* Effect.result(save);

          if (written._tag === "Failure") {
            unsaved.recordings = true;
            unsavedEnds.add(id);
            unsavedStops.add(id);
          }

          yield* publish;

          if (written._tag === "Failure") return yield* written.failure;
        }).pipe(Effect.ensuring(Effect.sync(() => stopping.delete(id)))),
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

          if (scheduled) yield* scheduling(settleRuleSchedule(scheduled.schedule));

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
          recordingFiles.delete(id);
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
      copy: (id: string, captured?: ActiveProfile) =>
        Effect.gen(function* () {
          const owner = captured ? personal.of(captured) : yield* personal.admit;
          const record = records.get(id);

          if (!record || record.status.kind === "missed") return null;

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
          // One still recording plays as it grows, once its own index has read its program.
          const growing = isLive(record) ? yield* recordingSource(id) : undefined;

          if (
            growing &&
            !(yield* Effect.tryPromise({
              try: (signal) => growing.read(signal),
              catch: failedWith,
            })).layout
          )
            return yield* new Failed({
              error: { kind: "unexpected", detail: t("It is still recording.") },
            });

          return {
            id,
            kind: "recording",
            owner: owner.owner,
            path: fileOf(record),
            container: "ts",
            title: { kind: "movie", id },
            progress: yield* owner.read("recording", id, record.progress ?? null),
            ...(growing && { recording: growing }),
          } satisfies LocalCopy;
        }),
      resume: (captured?: ActiveProfile) =>
        Effect.gen(function* () {
          const owner = captured ? personal.of(captured) : yield* personal.admit;
          yield* usable;
          const positions = yield* owner.recordings;
          yield* lookAgain;

          // Use inventory identities, never the provider catalogue or a title-name match.
          // File failures omit the copy rather than promise playback; no growing-edge completion heuristic.
          const present = new Set(
            yield* Effect.promise(() =>
              Promise.all(
                positions.map(async ({ id }) => {
                  const record = records.get(id);

                  if (!record || record.status.kind === "missed") return null;

                  return stat(fileOf(record)).then(
                    (file) => (file.isFile() && file.size > 0 ? id : null),
                    () => null,
                  );
                }),
              ),
            ),
          );

          const inventory = new Map((yield* shown).map((recording) => [recording.id, recording]));
          const items: RecordingResumeList["items"][number][] = [];

          for (const { id, position, duration, at } of positions) {
            const recording = inventory.get(id);

            if (recording && present.has(id))
              items.push({ recording, progress: { position, duration, at } });
          }

          return { owner: owner.owner, items };
        }),
      recordProgress: (id: string, position: number, duration: number, captured?: ActiveProfile) =>
        Effect.gen(function* () {
          const owner = captured ? personal.of(captured) : yield* personal.admit;
          yield* usable;
          const record = records.get(id);

          if (!record || record.status.kind === "missed")
            return yield* new Failed({
              error: { kind: "unexpected", detail: t("This recording is no longer there.") },
            });
          const key = JSON.stringify([owner.owner.id, id]);
          const watchedAt = Date.now();

          const progress = {
            id,
            owner,
            position,
            duration,
            watchedAt,
            retryAt: watchedAt + RETRY_MS,
          };

          pendingProgress.set(key, progress);
          yield* owner.write("recording", id, position, duration, watchedAt).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (pendingProgress.get(key) === progress) pendingProgress.delete(key);
              }),
            ),
            Effect.tap(() => PubSub.publish(progressChanges, { owner: owner.owner, id })),
            Effect.onError(() => wake),
          );
        }),
      storage: storageNow,
      setLimits: (limits: RecordingLimits) =>
        Effect.andThen(
          changeStorage((now) => ({ ...now, ...limits })),
          Effect.andThen(retryPaused, storageNow),
        ),
      setFolder: (folder: string) =>
        Effect.gen(function* () {
          // Written to, as a recording would be, before anything goes there. Its mark is made once
          // and never written over (see CHOSEN).
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(folder, { recursive: true });
              const probe = join(folder, `.mrstreamer-${randomUUID()}`);
              await writeFile(probe, "");
              await rm(probe, { force: true });

              if (folder === root) return;
              await writeFile(join(folder, CHOSEN), randomUUID(), { flag: "wx" }).catch(
                (cause: NodeJS.ErrnoException) => {
                  if (cause.code !== "EEXIST") throw cause;
                },
              );
            },
            catch: () =>
              new Failed({
                error: {
                  kind: "invalid-input",
                  detail: t("Recordings can't be written to that folder."),
                },
              }),
          });
          yield* changeStorage(({ folder: _was, ...rest }) =>
            folder === root ? rest : { ...rest, folder },
          );
          yield* retryPaused;

          return yield* storageNow;
        }),
      suspend: Effect.gen(function* () {
        asleep = Date.now();
        // Starts under way end too: none becomes active as the computer sleeps.
        yield* Effect.promise(() =>
          Promise.all(
            [...starting].map(([controller, each]) => {
              controller.abort();

              return each.done;
            }),
          ),
        );
        yield* Effect.ignore(end([...active.keys()], "away"));
      }),
      leave: (how: "quit" | "away") =>
        Effect.sync(() => {
          leaving = how;
        }),
      holdStarts: (on: boolean) =>
        Effect.sync(() => {
          held = on && starting.size === 0 && ![...records.values()].some(isLive);

          return held === on;
        }),
      keepStops: Effect.gen(function* () {
        const unkept = Effect.promise(async () => {
          const now = Date.now();

          const stopped = [...unsavedEnds]
            .flatMap((id) => records.get(id) ?? [])
            .filter(
              (record) =>
                (record.status.kind === "stopped" || unsavedStops.has(record.id)) &&
                record.stop > now,
            );

          const marked = await Promise.all(stopped.map(endedAs));

          return stopped.filter((_, index) => !marked[index]);
        });

        const left = yield* unkept;

        if (left.length === 0) return true;

        if ((yield* Effect.result(save))._tag === "Success") {
          yield* publish;

          return true;
        }

        yield* Effect.forEach(left, (record) => markEnded(record, "stopped"), { discard: true });

        return (yield* unkept).length === 0;
      }),
      progressChanges: Stream.fromPubSub(progressChanges),
      changes: Stream.fromPubSub(changes),
      rules: scheduling(
        Effect.andThen(
          rulesUsable,
          Effect.sync(() =>
            (rules ?? []).map(({ id, plan }) => ({
              id,
              plan,
              ...(ruleErrors.has(id) && { error: ruleErrors.get(id)! }),
            })),
          ),
        ),
      ),
      previewRule: (plan: RecordingRulePlan, id?: string) =>
        scheduling(Effect.flatMap(guide.status, (status) => previewRule(plan, status, id))),
      saveRule: (plan: RecordingRulePlan, id?: string) =>
        Effect.tap(
          scheduling(
            Effect.gen(function* () {
              // Fails as the preview does: rules unread, or a channel's subscription not saved.
              yield* findRuleMatches(plan, yield* guide.status);
              const was = rules?.find((each) => each.id === id);

              if (id && !was) return yield* ruleFailure("This recording rule is no longer there.");

              if (!was && (rules?.length ?? 0) >= RECORDING_RULE_LIMITS.rules)
                return yield* ruleFailure("The recording rule limit was reached.");

              const rule: KeptRule = {
                id: id ?? randomUUID(),
                plan: {
                  ...plan,
                  mode: plan.mode ?? "every",
                  priority: plan.priority ?? RECORDING_PRIORITY_DEFAULT,
                },
                occurrences: was?.occurrences ?? [],
              };

              yield* persistRules(
                was
                  ? (rules ?? []).map((each) => (each.id === rule.id ? rule : each))
                  : [...(rules ?? []), rule],
              );

              return { id: rule.id, plan: rule.plan };
            }),
          ),
          () => wake,
        ),
      cancelRule: (id: string) =>
        Effect.tap(
          scheduling(
            Effect.gen(function* () {
              yield* rulesUsable;
              const rule = rules?.find((each) => each.id === id);
              yield* persistRules((rules ?? []).filter((each) => each.id !== id));

              for (const each of rule?.occurrences ?? []) schedules.delete(each.id);
            }),
          ),
          () => wake,
        ),
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

              yield* settleRuleSchedule(id);

              if (schedules.has(id)) yield* keep(id, null);
            }),
          ),
          wake,
        ),
      // Checked now, and the loop then waits for the next time from there.
      // As when the computer wakes: paused recordings ask again at once.
      check: Effect.andThen(
        Effect.sync(() => {
          asleep = null;
          resumeTried.clear();
        }),
        Effect.andThen(checkOnce, wake),
      ),
      live: Effect.sync(() => ({
        recording: [...records.values()].some(isLive),
        scheduled: schedules.size > 0 || (rules?.length ?? 0) > 0,
        unsaved: unsaved.recordings || unsaved.schedules,
      })),
      scheduleChanges: Stream.fromPubSub(scheduleChanges),
    };
  });
}
