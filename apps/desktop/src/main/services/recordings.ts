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
// nothing playing or downloading stops for it, and nothing takes it back. Capture itself is in
// ../recordings/capture.ts.
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  Recording,
  RecordingConnections,
  RecordingStart,
} from "@mrstreamer/contracts/recordings";
import { RECORDING_MAX_MS } from "@mrstreamer/contracts/recordings";
import { ownedId, ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import { Guide } from "@mrstreamer/core/guide/service";
import { t } from "@mrstreamer/core/i18n";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { CaptureFailure, startCapture, type CaptureEnd } from "../recordings/capture.ts";
import {
  readRecordings,
  recordingFileName,
  writeRecordings,
  type StoredRecording,
} from "../recordings/store.ts";
import { Library } from "./library.ts";
import { Playback, type LocalCopy } from "./playback.ts";
import { PlaybackCoordination } from "./playback-coordination.ts";
import { Subscriptions } from "./subscription.ts";

/** How often the window hears a recording grow, at most. */
const CHANGES_MS = 1000;

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
     * Records `channel` from now until `stop`, through the first of `variants` (its id alone when
     * absent) whose stream has a program table. Busy, starting nothing, while every connection the
     * account allows is held here; `stopPlaying` closes what plays of its subscription first.
     * Answers once the table is on disk and the record written.
     */
    start(
      channel: OwnedId,
      stop: number,
      options?: { readonly variants?: readonly string[]; readonly stopPlaying?: boolean },
    ): Effect.Effect<RecordingStart, Failed>;
    /** Stops a recording, answering once its request ended and how it ended is written down. */
    stop(id: string): Effect.Effect<void, Failed>;
    /** Deletes an ended recording and its file, closing what plays it first. */
    remove(id: string): Effect.Effect<void, Failed>;
    /** An ended recording's file for playback to open; null when no recording has that id. */
    copy(id: string): Effect.Effect<LocalCopy | null, Failed>;
    /** The list after each change, and as recordings grow, about once a second. */
    readonly changes: Stream.Stream<readonly Recording[]>;
  }
>()("mrstreamer/Recordings") {
  static readonly layer = (deps: RecordingsDeps) => Layer.effect(Recordings, make(deps));
}

/** A recording that captures now. */
interface Active {
  readonly controller: AbortController;
  readonly bytes: () => number;
  /** Why it was asked to end before its stop time. */
  asked: "stopped" | "quit" | null;
  /** Settles once how it ended is written down, or couldn't be. */
  readonly settled: Promise<void>;
}

function make(deps: RecordingsDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const library = yield* Library;
    const guide = yield* Guide;
    const playback = yield* Playback;
    const coordination = yield* PlaybackCoordination;
    const root = join(deps.dataDir, "recordings");
    const path = join(root, "recordings.json");
    const changes = yield* PubSub.sliding<readonly Recording[]>(4);
    /** One write of recordings.json at a time, each with every record as it is then. */
    const writing = (yield* Semaphore.make(1)).withPermits(1);

    const read = yield* Effect.promise(() => readRecordings(path));
    const records = new Map<string, StoredRecording>();
    const active = new Map<string, Active>();
    const fileOf = (record: StoredRecording) => join(root, record.id, record.file);

    const unreadable = () =>
      new Failed({ error: { kind: "unexpected", detail: t("Recordings could not be read.") } });
    const usable = read.kind === "read" ? Effect.void : Effect.fail(unreadable());
    if (read.kind === "read") {
      // Never seen to end: cut short by the quit, with what its file holds.
      for (const record of read.recordings) {
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
          if (active.has(record.id)) return;
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
        if (!record) return;
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
        yield* Effect.ignore(save);
        yield* publish;
      });

    const start = (
      channel: OwnedId,
      stop: number,
      options: { readonly variants?: readonly string[]; readonly stopPlaying?: boolean } = {},
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
        const streams = yield* Effect.forEach(
          options.variants?.length ? options.variants : [listed.id],
          (id) =>
            Effect.tryPromise({
              try: (signal) => source.provider.liveStream(id, signal),
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
        const programme = (yield* guide.listings([ownedId(listed)]))[ownedKey(listed)]?.now;
        if (options.stopPlaying) yield* playback.closeOf(subscriptionId);
        const limit = yield* limitOf(subscriptionId);
        const admitted = yield* coordination.hold(subscriptionId, limit);
        if (admitted.kind === "busy")
          return {
            kind: "busy",
            connections: { limit, uses: admitted.uses },
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
          ended: null,
          bytes: 0,
          status: { kind: "recording" },
        };
        const controller = new AbortController();
        const starting = mkdir(join(root, id), { recursive: true }).then(() =>
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
        starting.catch(() => {});
        const capture = yield* Effect.tryPromise({
          try: () => starting,
          catch: (cause) =>
            cause instanceof CaptureFailure
              ? new Failed({ error: { kind: "stream", failure: cause.failure } })
              : new Failed({
                  error: {
                    kind: "unexpected",
                    detail: t("The recording couldn't be written: {detail}", {
                      detail: cause instanceof Error ? cause.message : String(cause),
                    }),
                  },
                }),
        }).pipe(
          // Also when the app closes meanwhile: whatever started ends before its folder goes.
          Effect.onError(() =>
            Effect.promise(async () => {
              controller.abort();
              await starting.then(
                (started) => started.ended,
                () => {},
              );
              held.release();
              await rm(join(root, id), { recursive: true, force: true });
            }),
          ),
        );
        const { promise: settled, resolve } = Promise.withResolvers<void>();
        const live: Active = { controller, bytes: capture.bytes, asked: null, settled };
        records.set(id, record);
        active.set(id, live);
        void capture.ended.then(async (end) => {
          held.release();
          await Effect.runPromise(ended(id, end, live));
          resolve();
        });
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

    /** Ends what records now, as asked, once each has written down how it ended. */
    const end = (ids: readonly string[], asked: "stopped" | "quit") =>
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
      );
    yield* Effect.addFinalizer(() => end([...active.keys()], "quit"));

    return {
      list: usable.pipe(Effect.andThen(look), Effect.andThen(shown)),
      connections: (subscriptionId: string) =>
        Effect.gen(function* () {
          const limit = yield* limitOf(subscriptionId);
          return { limit, uses: yield* coordination.uses(subscriptionId) };
        }),
      start,
      stop: (id: string) => Effect.asVoid(end([id], "stopped")),
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
          records.delete(id);
          const written = yield* Effect.result(save);
          if (written._tag === "Failure") {
            records.set(id, record);
            return yield* written.failure;
          }
          yield* Effect.promise(() => rm(join(root, id), { recursive: true, force: true }));
          yield* publish;
        }),
      copy: (id: string) =>
        Effect.gen(function* () {
          const record = records.get(id);
          if (!record) return null;
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
    };
  });
}
