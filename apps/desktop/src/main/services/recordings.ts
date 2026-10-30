// Recordings: local copies of a live channel, captured by this app while it runs. The viewer
// starts one on the channel they see, until a stop time; it ends there, when the viewer stops it,
// when the stream or the disk fails, or when the app quits, and what it captured stays until the
// viewer deletes it. An ended recording plays from this computer as a downloaded copy does.
//
// This service is the one owner of recordings. Their records are in recordings.json
// (../recordings/store.ts), each file in a folder of its own beside it, named for its programme
// (`recordingFileName`). A record is written once capture has the stream's program table on disk,
// and again with how it ended, only after its provider request ended and its file closed: the
// list never claims more than the file holds. A record still recording as the app starts is one
// the app didn't see end, as after a crash: it counts as cut short by the quit, with what its
// file holds.
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
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ConnectionHolder,
  Recording,
  RecordingConnections,
  RecordingPlan,
  RecordingStart,
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
  recordingFileName,
  writeRecordings,
  writeSchedules,
  type KeptSchedule,
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
/** How soon a schedule waiting for a connection, or whose stream failed, asks again. */
const RETRY_MS = 10_000;
/** A schedule that starts within this of its time started on time. */
const ON_TIME_MS = 60_000;
/** How long the guide settles after a change before the schedules follow it. */
const GUIDE_SETTLE = "2 seconds";

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
    /** Stops a recording, answering once its request ended and how it ended is written down. */
    stop(id: string): Effect.Effect<void, Failed>;
    /** Deletes an ended recording and its file, closing what plays it first. */
    remove(id: string): Effect.Effect<void, Failed>;
    /**
     * A subscription is going: its recordings stop as the viewer stops one, their requests over
     * before this answers. What they captured stays.
     */
    subscriptionGone(subscriptionId: string): Effect.Effect<void>;
    /** An ended recording's file for playback to open; null when no recording has that id. */
    copy(id: string): Effect.Effect<LocalCopy | null, Failed>;
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
  /** Why it was asked to end before its stop time. */
  asked: "stopped" | "quit" | null;
  /** Settles once how it ended is written down, with why that couldn't be, if it couldn't. */
  readonly settled: Promise<Failed | null>;
}

function make(deps: RecordingsDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const library = yield* Library;
    const guide = yield* Guide;
    const playback = yield* Playback;
    const coordination = yield* PlaybackCoordination;
    const settings = yield* Settings;
    const root = join(deps.dataDir, "recordings");
    const path = join(root, "recordings.json");
    const changes = yield* PubSub.sliding<readonly Recording[]>(4);
    /** One write of recordings.json at a time, each with every record as it is then. */
    const writing = (yield* Semaphore.make(1)).withPermits(1);

    const read = yield* Effect.promise(() => readRecordings(path));
    const records = new Map<string, StoredRecording>();
    const active = new Map<string, Active>();
    /**
     * Captures still starting, by subscription, which the app's close and a removal stop too.
     * `done` settles once one is active, or has ended and let its connection go.
     */
    const starting = new Map<
      AbortController,
      { readonly subscriptionId: string; readonly done: Promise<void> }
    >();
    /** Set as the app closes: a start asked for meanwhile would outlive its close. */
    let closing = false;
    const fileOf = (record: StoredRecording) => join(root, record.id, record.file);

    const unreadable = () =>
      new Failed({ error: { kind: "unexpected", detail: t("Recordings could not be read.") } });
    const usable = read.kind === "read" ? Effect.void : Effect.fail(unreadable());
    if (read.kind === "read") {
      // Never seen to end: cut short by the quit, with what its file holds.
      for (const record of read.items) {
        if (record.status.kind !== "recording") {
          records.set(record.id, record);
          continue;
        }
        const file = yield* Effect.promise(() => stat(fileOf(record)).catch(() => null));
        records.set(record.id, {
          ...record,
          bytes: file?.size ?? record.bytes,
          ended: file ? Math.min(file.mtimeMs, record.stop) : record.start,
          status: { kind: "partial", cut: "quit" },
        });
      }
    }

    const save = writing(
      Effect.tryPromise({
        try: () => writeRecordings(path, [...records.values()]),
        catch: () =>
          new Failed({
            error: { kind: "unexpected", detail: t("Recordings could not be saved.") },
          }),
      }),
    );

    /** Ended recordings whose file was gone when last looked for: on each read of the list. */
    const missing = new Set<string>();
    const look = Effect.promise(() =>
      Promise.all(
        [...records.values()].map(async (record) => {
          if (active.has(record.id) || record.status.kind === "missed") return;
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
          const { file: _file, ...rest } = record;
          const live = active.get(record.id);
          if (live) return { ...rest, bytes: live.bytes() };
          return missing.has(record.id) ? { ...rest, status: { kind: "missing" } } : rest;
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

    const limitOf = (subscriptionId: string) =>
      Effect.map(subscriptions.list, (list) => {
        const allowed = list.find((each) => each.id === subscriptionId)?.account.maxConnections;
        return allowed && allowed > 0 ? allowed : 1;
      });

    /** Writes down how `id` ended, once its request ended and its file closed. */
    const ended = (id: string, end: CaptureEnd, live: Active) =>
      Effect.gen(function* () {
        const record = records.get(id);
        if (!record) return null;
        const status: StoredRecording["status"] =
          end === "until"
            ? { kind: "complete" }
            : end === "aborted"
              ? live.asked === "stopped"
                ? { kind: "stopped" }
                : { kind: "partial", cut: "quit" }
              : { kind: "partial", cut: end };
        records.set(id, { ...record, status, bytes: live.bytes(), ended: Date.now() });
        active.delete(id);
        // Any later write takes it down too; until then a restart reads it as cut by the quit.
        const written = yield* Effect.result(save);
        yield* publish;
        return written._tag === "Failure" ? written.failure : null;
      });

    /**
     * Starts as `start` does, for a schedule as `scheduled` says, named `title`; `controller` stops
     * it at any step, `settle` once it's active.
     */
    const begin = (
      channel: OwnedId,
      stop: number,
      options: StartOptions & Pick<StoredRecording, "scheduled"> & { readonly title?: string },
      controller: AbortController,
      settle: () => void,
    ) =>
      Effect.gen(function* () {
        yield* usable;
        const now = Date.now();
        if (stop <= now || stop > now + RECORDING_MAX_MS)
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
        const streams = yield* Effect.forEach(
          options.variants?.length
            ? options.variants
            : streamsToPlay(listed, preferences, undefined).map(({ id }) => id),
          (id) =>
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
            }),
        );
        const programme = options.title
          ? { title: options.title }
          : (yield* guide.listings([ownedId(listed)]))[ownedKey(listed)]?.now;
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
        const id = randomUUID();
        const record: StoredRecording = {
          id,
          file: recordingFileName(title, listed.title, now),
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
        const opening = mkdir(join(root, id), { recursive: true }).then(() =>
          startCapture(
            streams.map(({ url, format, headers }) => ({ url, format, headers: headers ?? {} })),
            fileOf(record),
            {
              request: source.provider.request,
              userAgent: deps.userAgent,
              until: stop,
              signal: controller.signal,
              changed: grew,
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
          // Also when the app closes meanwhile: whatever started ends before its folder goes.
          Effect.onError(() =>
            Effect.promise(async () => {
              controller.abort();
              await opening.then(
                (opened) => opened.ended,
                () => {},
              );
              held.release();
              await rm(join(root, id), { recursive: true, force: true });
            }),
          ),
        );
        const { promise: settled, resolve } = Promise.withResolvers<Failed | null>();
        // Stopped by its subscription going as it started: it ends as one the viewer stopped.
        const asked = controller.signal.reason === "stopped" ? "stopped" : null;
        const live: Active = { controller, bytes: capture.bytes, asked, settled };
        records.set(id, record);
        active.set(id, live);
        settle();
        void capture.ended
          .then((end) => {
            held.release();
            return Effect.runPromise(ended(id, end, live));
          })
          .then(resolve, () => resolve(null));
        const written = yield* Effect.result(save);
        if (written._tag === "Failure") {
          // Without its record nothing would say it exists: it stops, and its file goes.
          live.asked = "stopped";
          controller.abort();
          yield* Effect.promise(() => settled);
          records.delete(id);
          // How it ended may have been written down meanwhile.
          yield* Effect.ignore(save);
          yield* Effect.promise(() => rm(join(root, id), { recursive: true, force: true }));
          yield* publish;
          return yield* written.failure;
        }
        yield* publish;
        const { file: _file, ...recording } = record;
        return {
          kind: "started",
          recording: { ...recording, bytes: capture.bytes() },
        } satisfies RecordingStart;
      });

    const start = (
      channel: OwnedId,
      stop: number,
      options: StartOptions & Pick<StoredRecording, "scheduled"> & { readonly title?: string } = {},
    ) =>
      Effect.suspend(() => {
        if (closing)
          return Effect.fail(
            new Failed({
              error: { kind: "stream", failure: { kind: "network", detail: t("Stopped.") } },
            }),
          );
        // Starting from before its first wait, so a removal or the app's close stops it at any step.
        const controller = new AbortController();
        const { promise: done, resolve } = Promise.withResolvers<void>();
        starting.set(controller, { subscriptionId: channel.subscriptionId, done });
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
    const end = (ids: readonly string[], asked: "stopped" | "quit") =>
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
        Effect.suspend(() => Effect.ignore(end([...active.keys()], "quit"))),
      ),
    );

    // Schedules.
    const schedulesPath = join(root, "schedules.json");
    const readKept = yield* Effect.promise(() => readSchedules(schedulesPath));
    const schedules = new Map(
      (readKept.kind === "read" ? readKept.items : []).map((each) => [each.id, each]),
    );
    const schedulesUsable =
      readKept.kind === "read"
        ? Effect.void
        : Effect.fail(
            new Failed({
              error: { kind: "unexpected", detail: t("Schedules could not be read.") },
            }),
          );
    /** One check, or change of the schedules, at a time. */
    const scheduling = (yield* Semaphore.make(1)).withPermits(1);
    const wakes = yield* Queue.sliding<void>(1);
    const wake = Effect.asVoid(Queue.offer(wakes, undefined));
    const scheduleChanges = yield* PubSub.sliding<readonly ScheduledRecording[]>(4);
    /** What the window was last told, so a check that changed nothing tells nothing. */
    let shownSchedules: readonly ScheduledRecording[] = [];
    /** What holds each schedule back, as the last check found; null for nothing. */
    let holds = new Map<string, Hold | null>();
    /**
     * Why an occurrence whose time came isn't recording, by `occurrenceKey`: what its last start
     * answered, `hold` while its schedule was held then, or `starting` while a start is under way.
     */
    const why = new Map<string, ScheduleMiss | "hold" | "starting">();
    /** When each occurrence whose time came was last asked to start, by `occurrenceKey`. */
    const tried = new Map<string, number>();
    const occurrenceKey = (id: string, occurrence: Occurrence) => `${id}@${occurrence.start}`;
    /** The recording a schedule made of `occurrence`, if one did. */
    const recordOf = (id: string, occurrence: Occurrence) =>
      [...records.values()].find(
        (each) => each.scheduled?.schedule === id && each.scheduled.from === occurrence.start,
      );
    /** The recording a schedule records now, if one does. */
    const recordingOf = (id: string) =>
      [...active.keys()].find((each) => records.get(each)?.scheduled?.schedule === id);

    const saveSchedules = Effect.tryPromise({
      try: () => writeSchedules(schedulesPath, [...schedules.values()]),
      catch: () =>
        new Failed({ error: { kind: "unexpected", detail: t("Schedules could not be saved.") } }),
    });

    /**
     * `plan` as the lists and the guide stand now: its channel, and what holds it back, its
     * channel not listed, or, for a programme, another programme or none at its start; undefined
     * while that can't be told, as before the lists or the guide are read. A programme listed at
     * its start under its title takes the guide's end.
     */
    const follow = (plan: RecordingPlan) =>
      Effect.gen(function* () {
        const { subscriptionId } = plan.channel;
        const listed = (yield* library.lookup(subscriptionId))(plan.channel.id);
        if (!listed) {
          const read = (yield* library.status).some(
            (each) => each.subscriptionId === subscriptionId && each.fetchedAt !== null,
          );
          return { plan, listed, hold: read ? gone : undefined };
        }
        if (plan.kind === "slot") return { plan, listed, hold: null };
        const answer = yield* guide.startingAt(plan.channel, plan.start);
        // A guide not read yet holds nothing: it records at the times it was given.
        if (answer.kind === "unknown") return { plan, listed, hold: null };
        if (answer.kind === "none") return { plan, listed, hold: gone };
        const { title, stop } = answer.programme;
        if (title !== plan.title)
          return { plan, listed, hold: { kind: "changed", title } satisfies Hold };
        return { plan: { ...plan, stop }, listed, hold: null };
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

    /** How `schedule` stands at `now`, against the others of `kept` and what records now. */
    const standingOf = (schedule: KeptSchedule, kept: readonly KeptSchedule[], now: number) =>
      Effect.gen(function* () {
        const { plan } = schedule;
        const next = nextOccurrence(plan, now);
        const as = (status: ScheduleStatus): ScheduledRecording => ({
          id: schedule.id,
          plan,
          channelName: schedule.channelName,
          next,
          status,
        });
        const hold = holds.get(schedule.id);
        if (hold) return as(hold);
        const recording = recordingOf(schedule.id);
        if (recording) return as({ kind: "recording", recording });
        if (!next) return as({ kind: "planned" });
        const { subscriptionId } = plan.channel;
        if (next.start <= now && why.get(occurrenceKey(schedule.id, next)) === "busy")
          return as({ kind: "waiting", holders: yield* holdersNow(subscriptionId) });
        const holdings = [
          ...recordingHoldings(subscriptionId),
          ...kept.flatMap((other): Holding[] => {
            if (other.id === schedule.id || other.plan.channel.subscriptionId !== subscriptionId)
              return [];
            const theirs = nextOccurrence(other.plan, now);
            if (!theirs || holds.get(other.id) || recordingOf(other.id)) return [];
            const holder = {
              kind: "schedule",
              title: other.plan.title,
              until: theirs.stop,
            } as const;
            return [{ holder, start: theirs.start, first: other.created < schedule.created }];
          }),
        ];
        const holders = conflictOf(next, holdings, yield* limitOf(subscriptionId));
        return as(holders.length > 0 ? { kind: "conflict", holders } : { kind: "planned" });
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

    /** Starts a schedule's occurrence on now, in the background; a check follows its answer. */
    const startOccurrence = (schedule: KeptSchedule, occurrence: Occurrence, now: number) => {
      const key = occurrenceKey(schedule.id, occurrence);
      const before = why.get(key);
      const late =
        now - occurrence.start <= ON_TIME_MS
          ? null
          : before === "busy" || before === "stream"
            ? before
            : "away";
      why.set(key, "starting");
      Effect.runFork(
        start(schedule.plan.channel, occurrence.stop, {
          scheduled: { schedule: schedule.id, from: occurrence.start, late },
          title: schedule.plan.title,
        }).pipe(
          Effect.match({
            onSuccess: (answer) =>
              answer.kind === "started" ? why.delete(key) : why.set(key, "busy"),
            onFailure: () => why.set(key, "stream"),
          }),
          Effect.andThen(wake),
        ),
      );
    };

    /**
     * Brings every schedule up to date at the time now: drops those of a subscription that
     * went, follows the lists and the guide, starts what is due, writes what was missed, and
     * tells the window what changed. Answers when the next check is due. Only runs in a turn.
     */
    const checkNow = Effect.gen(function* () {
      if (readKept.kind !== "read" || read.kind !== "read" || closing) return null;
      const now = Date.now();
      const saved = new Set((yield* subscriptions.saved).map((each) => each.id));
      let dirty = false;
      let missed = false;
      let retry = false;
      const found = new Map<string, Hold | null>();
      for (const schedule of [...schedules.values()]) {
        if (!saved.has(schedule.plan.channel.subscriptionId)) {
          schedules.delete(schedule.id);
          dirty = true;
          continue;
        }
        const seen = yield* Effect.orElseSucceed(follow(schedule.plan), () => null);
        const hold = seen?.hold;
        found.set(schedule.id, hold ?? null);
        let kept: KeptSchedule = {
          ...schedule,
          plan: seen?.plan ?? schedule.plan,
          channelName: seen?.listed?.title ?? schedule.channelName,
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
            if (reason === "starting" || (made && active.has(made.id))) {
              settling = false;
              continue;
            }
            if (!made && reason !== "hold") {
              const record: StoredRecording = {
                id: randomUUID(),
                file: recordingFileName(kept.plan.title, kept.channelName, occurrence.start),
                channel: kept.plan.channel,
                channelName: kept.channelName,
                title: kept.plan.title,
                start: occurrence.start,
                stop: occurrence.stop,
                scheduled: { schedule: kept.id, from: occurrence.start, late: reason ?? "away" },
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
          if (made || reason === "starting" || recordingOf(kept.id)) continue;
          if (hold) why.set(key, "hold");
          else if (hold === undefined) retry = true;
          else if ((tried.get(key) ?? -Infinity) + RETRY_MS <= now) {
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
      if (missed) {
        yield* Effect.ignore(save);
        yield* publish;
      }
      // After the missed results: a crash between leaves their occurrences to settle again, which
      // finds them.
      if (dirty) yield* Effect.ignore(saveSchedules);
      const list = yield* standings(now);
      if (!isDeepStrictEqual(list, shownSchedules)) {
        shownSchedules = list;
        yield* PubSub.publish(scheduleChanges, list);
      }
      const starts = list.flatMap((each) =>
        each.next && each.next.start > now ? [each.next.start] : [],
      );
      return Math.min(now + (retry ? RETRY_MS : CHECK_MS), ...starts);
    });

    const checkOnce = scheduling(checkNow).pipe(
      Effect.catchDefect((defect) =>
        Effect.as(Effect.logWarning("[recordings] checking schedules failed", defect), null),
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
    // The lists may list a schedule's channel anew or no longer, the guide another programme at
    // its start, and a recording that ended frees a connection one waits for.
    yield* Effect.forkScoped(
      Stream.runForEach(guide.changes.pipe(Stream.debounce(GUIDE_SETTLE)), () => wake),
    );
    yield* Effect.forkScoped(Stream.runForEach(library.changes, () => wake));
    yield* Effect.forkScoped(Stream.runForEach(Stream.fromPubSub(changes), () => wake));

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
        // Changed, it settles from now: what it recorded or missed stays as it was, and while it
        // records, the change starts with its next time.
        const recording = id === undefined ? undefined : recordingOf(id);
        const schedule: KeptSchedule = {
          id: id ?? randomUUID(),
          plan: found.plan,
          channelName: found.listed.title,
          // Strictly after every other: of two that start together, the one saved first records.
          created:
            was?.created ??
            Math.max(now, ...[...schedules.values()].map((each) => each.created + 1)),
          through: (recording && nextOccurrence(found.plan, now)?.stop) || now,
        };
        const kept = [...schedules.values()].filter((each) => each.id !== schedule.id);
        const before = holds;
        holds = new Map(before).set(schedule.id, found.hold ?? null);
        const standing = yield* Effect.ensuring(
          standingOf(schedule, [...kept, schedule], now),
          Effect.sync(() => (holds = before)),
        );
        return { schedule, standing };
      });

    return {
      list: usable.pipe(Effect.andThen(look), Effect.andThen(shown)),
      connections: (subscriptionId: string) =>
        Effect.gen(function* () {
          const limit = yield* limitOf(subscriptionId);
          return { limit, uses: yield* coordination.uses(subscriptionId) };
        }),
      start,
      stop: (id: string) =>
        Effect.andThen(
          end([id], "stopped"),
          // Capture may have ended before Stop arrived. Retry its terminal record too.
          Effect.suspend(() => (records.has(id) ? save : Effect.void)),
        ),
      subscriptionGone: (subscriptionId: string) =>
        Effect.andThen(
          // Its schedules go first, so none starts meanwhile.
          scheduling(
            Effect.suspend(() => {
              const before = schedules.size;
              for (const [id, each] of schedules)
                if (each.plan.channel.subscriptionId === subscriptionId) schedules.delete(id);
              return schedules.size === before
                ? Effect.void
                : Effect.andThen(Effect.ignore(saveSchedules), wake);
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
              Effect.ignore(
                end(
                  [...active.keys()].filter(
                    (id) => records.get(id)?.channel.subscriptionId === subscriptionId,
                  ),
                  "stopped",
                ),
              ),
            ),
          ),
        ),
      remove: (id: string) =>
        Effect.gen(function* () {
          yield* usable;
          const record = records.get(id);
          if (!record) return;
          if (active.has(id))
            return yield* new Failed({
              error: { kind: "unexpected", detail: t("Stop the recording before deleting it.") },
            });
          yield* playback.closeCopy(id);
          // The file goes first: one that stays, as one Windows holds open, keeps its record to
          // delete again, and a record whose file went lists it as missing until it is deleted.
          yield* Effect.tryPromise({
            try: () => rm(join(root, id), { recursive: true, force: true }),
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
        }),
      copy: (id: string) =>
        Effect.gen(function* () {
          const record = records.get(id);
          if (!record || record.status.kind === "missed") return null;
          if (active.has(id))
            return yield* new Failed({
              error: { kind: "unexpected", detail: t("It is still recording.") },
            });
          return {
            id,
            path: fileOf(record),
            container: "ts",
            title: { kind: "movie", id },
            progress: null,
          } satisfies LocalCopy;
        }),
      changes: Stream.fromPubSub(changes),
      schedules: scheduling(
        Effect.andThen(
          schedulesUsable,
          Effect.suspend(() => standings(Date.now())),
        ),
      ),
      plan: (plan: RecordingPlan, id?: string) =>
        scheduling(Effect.map(draft(plan, id), ({ standing }) => standing)),
      schedule: (plan: RecordingPlan, id?: string) =>
        Effect.tap(
          scheduling(
            Effect.gen(function* () {
              const { schedule, standing } = yield* draft(plan, id);
              const was = schedules.get(schedule.id);
              schedules.set(schedule.id, schedule);
              const written = yield* Effect.result(saveSchedules);
              if (written._tag === "Failure") {
                if (was) schedules.set(schedule.id, was);
                else schedules.delete(schedule.id);
                return yield* written.failure;
              }
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
              const was = schedules.get(id);
              if (!was) return;
              schedules.delete(id);
              const written = yield* Effect.result(saveSchedules);
              if (written._tag === "Failure") {
                schedules.set(id, was);
                return yield* written.failure;
              }
            }),
          ),
          wake,
        ),
      // Checked now, and the loop then waits for the next time from there.
      check: Effect.andThen(checkOnce, wake),
      scheduleChanges: Stream.fromPubSub(scheduleChanges),
    };
  });
}
