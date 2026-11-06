// Movies and episodes downloaded to this computer: the queue, its one transfer at a time, and the
// copies that play without a subscription. Each download is a record in the database
// (../platform/downloads-store.ts) and a UUID folder in a managed household destination, with
// the file, a partial file while it transfers, and the artwork kept for it. Media paths, addresses and
// logins stay here; the window sees the records as `Download`s.
//
// One download transfers at a time, of whichever subscription: the first in the queue whose
// subscription plays nothing. PlaybackCoordination lends its provider connection and takes
// it back for any stream of that subscription (see PlaybackCoordination.lend): the transfer
// stops, its request ends, and it waits with its partial file until nothing of its subscription
// plays. Another subscription's stream lets it go on. A transfer goes on from its partial file
// only when the provider proves it is the same file; otherwise it starts again and says so (see
// ../downloads/transfer.ts). It becomes a copy once every byte is on disk: the partial is flushed,
// renamed, and only then marked complete. Quitting keeps the queue and its partial files.
//
// The queue goes in the viewer's order: each unfinished download has its place (`order`, or when
// it was added for one an older build added), a new one goes last, and moving one swaps it with
// its neighbour among those waiting, the transfer under way staying put. A paused one keeps its
// place and its partial file and is passed over until resumed. Its pause is the viewer's alone:
// written down before its transfer is stopped, so nothing can take it meanwhile, and never
// written or cleared by playback taking the connection back. Paused is no stored state: an older
// build reads such a download as queued and transfers it, in the order downloads were added,
// keeping both keys for this build to find again.
//
// Only what the database says decides which folders are no download's: when it can't be read,
// nothing is listed, queued or cleaned up, and each call says so. A row this build can't read
// keeps its folder for the build that wrote it.
//
// A copy keeps what it needs to show and play without asking anyone: its details and artwork,
// read as it was queued, how far it was watched here, and the subtitles saved for the exact file
// it was made from (see `subtitlesOfCopy`). Removing a subscription cancels its unfinished
// downloads; its copies stay, and play, until the viewer deletes them.
//
// An episode also keeps what its series version listed then, from the details its queuing read
// anyway: its seasons in order and its TMDB id. The window hears each series version of an account
// by a key made up in this run, so nothing of the account reaches it, with the seasons its latest
// queued download listed; which copies go together and what plays next are worked out from those
// (see @mrstreamer/core/downloads/series). An episode queued before this, or by an earlier build,
// has no series and stands alone.
import { copyProgress } from "../platform/profile-copy-progress.ts";
import { downloadFailure, type OperationObserver } from "../analytics/operations.ts";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  rename,
  rm,
  readFile,
  writeFile,
  open,
  realpath,
  stat,
} from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import {
  artworkUrl,
  type Download,
  type DownloadArtwork,
  type DownloadList,
  type DownloadFailure,
  type DownloadSeries,
  type DownloadFolder,
  type DownloadBulkAction,
  type DownloadBulkResult,
} from "@mrstreamer/contracts/downloads";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { EpisodeDetails, RawTitleRef, TitleRef } from "@mrstreamer/contracts/ondemand";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import { seriesEpisodeSeasons } from "@mrstreamer/core/ondemand/details";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { t } from "@mrstreamer/core/i18n";
import { fileDisk, transfer, type Disk, type TransferOutcome } from "../downloads/transfer.ts";
import {
  DownloadStore,
  type About,
  type PartIdentity,
  type PendingCleanup,
  type SeriesKept,
  type StoredDownload,
} from "../platform/downloads-store.ts";
import { SavedSubtitles, subtitlesOfCopy } from "../platform/saved-subtitles.ts";
import { OnDemand, Overtaken, subscriptionChanged } from "./ondemand.ts";
import { Playback, type LocalCopy } from "./playback.ts";
import { PlaybackCoordination, type Lent } from "./playback-coordination.ts";
import { Subscriptions } from "./subscription.ts";
import { defined } from "@mrstreamer/core/defined";

/** How often the window hears how a transfer goes, at most. */
const CHANGES_MS = 250;

/** How often a transfer's progress is written down, so a restart goes on from about there. */
const SAVE_MS = 5000;

/** The most a picture kept for a download may be. */
const ARTWORK_BYTES = 8 * 1024 * 1024;
const ARTWORK_MS = 20_000;
const ID = /^[0-9a-f-]{36}$/;

export interface DownloadsDeps {
  readonly dataDir: string;
  readonly userAgent: string;
  readonly observeTransfer?: OperationObserver;
  /** The disk transfers write to; the file system except in tests. */
  readonly disk?: Disk;
  /** What artwork is fetched with; `fetch` except in tests. */
  readonly fetch?: typeof fetch;
}

export class Downloads extends Context.Service<
  Downloads,
  {
    readonly list: Effect.Effect<DownloadList, Failed>;
    /** Current household destination and IDs with a move in flight. */
    readonly folder: Effect.Effect<DownloadFolder, Failed>;
    /** Validates and saves a folder for future transfers; existing files stay put. */
    setFolder(path: string): Effect.Effect<void, Failed>;
    /** Waits until the move stops, retaining its original when not yet committed. */
    cancelMove(id: string): Effect.Effect<void, Failed>;
    /**
     * Runs one action on each selected download and answers for each: pause, resume, retry,
     * remove, or move a finished copy to the selected folder. Failures let the rest continue;
     * cancelling a move cancels the remaining moves in that selection.
     */
    bulk(
      ids: readonly string[],
      action: DownloadBulkAction,
    ): Effect.Effect<DownloadBulkResult, Failed>;
    /**
     * Queues a movie or an episode, by the exact version given, with its details and artwork kept
     * for the copy. One of the same account already queued or downloaded, or added while this
     * was looked up, answers as it is; a failed one is queued again. Fails while its subscription
     * can't be asked, or doesn't list it, and once it was removed or logged in anew meanwhile.
     */
    add(title: TitleRef): Effect.Effect<Download, Failed>;
    /**
     * Cancels an unfinished download, or deletes a copy, with everything kept for it. What plays
     * the copy closes first; a transfer stops, and its request ends, before its files go.
     */
    remove(id: string): Effect.Effect<void, Failed>;
    /** Queues a failed download again, in its place. */
    retry(id: string): Effect.Effect<void, Failed>;
    /**
     * Pauses an unfinished download that hasn't failed. The pause is written down first, so the
     * queue can't take the download meanwhile; a transfer then stops, and this answers once its
     * request ended, its partial file closed and where it stopped is written down. Fails, changing
     * nothing, when the pause can't be written down: a transfer goes on. A transfer stopped before
     * where it got to can't be written down fails too, its pause and partial file kept on disk:
     * until the next start, this run lists it as failed, with Retry.
     */
    pause(id: string): Effect.Effect<void, Failed>;
    /** Lets a paused download take its turn again, going on from its partial file where proven. */
    resume(id: string): Effect.Effect<void, Failed>;
    /** Pauses every unfinished download that hasn't failed, as `pause` does, in one write. */
    readonly pauseAll: Effect.Effect<void, Failed>;
    /** Resumes every paused download, in one write. */
    readonly resumeAll: Effect.Effect<void, Failed>;
    /**
     * Moves a download waiting its turn, paused or not, one place earlier (-1) or later (1) among
     * those waiting. The transfer under way neither moves nor stops. Fails, changing nothing, when
     * the new order can't be written down.
     */
    move(id: string, by: -1 | 1): Effect.Effect<void, Failed>;
    recordProgress(id: string, position: number, duration: number): Effect.Effect<void, Failed>;
    /** A complete copy, for playback to open; fails when it isn't, or its file is gone. */
    copy(id: string): Effect.Effect<LocalCopy, Failed>;
    /** A copy's kept picture, for the app's artwork scheme; null without one. */
    artwork(
      id: string,
      artwork: DownloadArtwork,
    ): Effect.Effect<{ readonly path: string; readonly type: string } | null>;
    /**
     * A subscription is going: its unfinished downloads end, their transfer and files with them.
     * Its copies stay. Unreadable startup inventory or refused recovery refuses removal until a
     * healthy restart. Failed cleanup keeps the subscription available for retry in the same run.
     */
    subscriptionGone(subscriptionId: string): Effect.Effect<void, Failed>;
    /** The list after every change, each later than the last, a few times a second at most. */
    readonly changes: Stream.Stream<DownloadList>;
  }
>()("mrstreamer/Downloads") {
  static readonly layer = (deps: DownloadsDeps) => Layer.effect(Downloads, make(deps));
}

/** The transfer under way. */
interface Active {
  readonly id: string;
  /** Stops it for the viewer or the app; playback's lease stops it for a stream. */
  readonly controller: AbortController;
  received: number;
  size: number | null;
  identity: PartIdentity | null;
  restarted: boolean;
  rate: number | null;
  /** Settles once its request is over, the partial closed and its lease given back. */
  over: Promise<void>;
  /**
   * Settles once what it ended with is written down: a copy, a failure, or where it stopped. Says
   * why, when that couldn't be written down.
   */
  settled: Promise<Failed | null>;
}

function make(deps: DownloadsDeps) {
  return Effect.gen(function* () {
    const store = yield* DownloadStore;
    const personal = yield* copyProgress;
    const playback = yield* Playback;
    const coordination = yield* PlaybackCoordination;
    const onDemand = yield* OnDemand;
    const subscriptions = yield* Subscriptions;
    const savedSubtitles = yield* SavedSubtitles;
    const scope = yield* Effect.scope;
    const disk = deps.disk ?? fileDisk;
    const fetchArtwork = deps.fetch ?? fetch;
    const root = join(deps.dataDir, "downloads");
    const changes = yield* PubSub.sliding<DownloadList>(4);

    const folderOf = (id: string) =>
      join(records.get(id)?.directory ?? root, records.get(id)?.folderId ?? id);

    const mediaOf = (record: StoredDownload) =>
      join(folderOf(record.id), `media.${extensionOf(record.container)}`);

    const partOf = (record: StoredDownload) => `${mediaOf(record)}.part`;

    const records = new Map<string, StoredDownload>();
    const loaded = yield* Effect.result(store.list);
    const configured = yield* Effect.result(store.folder);
    const loadedCleanup = yield* Effect.result(store.cleanups);
    let selectedFolder = configured._tag === "Success" ? (configured.success ?? root) : root;

    // Without a complete startup inventory nothing can be queued or listed. A later successful
    // read cannot validate files skipped at startup; a new start must check them. A refused
    // recovery save below also latches its original failure until the next start retries it.
    let unloaded =
      configured._tag === "Failure"
        ? store.folder.pipe(Effect.andThen(Effect.fail(configured.failure)))
        : loaded._tag === "Failure"
          ? store.list.pipe(Effect.andThen(Effect.fail(loaded.failure)))
          : loadedCleanup._tag === "Failure"
            ? store.cleanups.pipe(Effect.andThen(Effect.fail(loadedCleanup.failure)))
            : null;

    if (loaded._tag === "Failure") {
      yield* Effect.logWarning("[downloads] can't be read", loaded.failure.error);
    }

    const inventory = loaded._tag === "Success" ? loaded.success : null;

    for (const record of inventory?.records ?? []) records.set(record.id, record);
    /** Copies whose file is gone, as last looked: looked at again as the window asks for the list. */
    const missing = new Set<string>();
    let active: Active | null = null;
    let ended = 0;
    const artworkWork = new Map<string, Promise<void>>();
    let closing = false;
    const removing = new Set<string>();

    const moving = new Map<
      string,
      { cancelled: boolean; controller: AbortController; settled: Promise<void> }
    >();

    /**
     * Writes a record and keeps it. Every write is synchronous, as the database is: none can come
     * between a removal's and its record going, so nothing writes a removed download back.
     */
    const write = (record: StoredDownload, durable = false) => {
      Effect.runSync(store.put(record, durable));
      records.set(record.id, record);
    };

    /** Changes a download's record as it is now; one removed meanwhile stays removed. */
    const update = (
      id: string,
      change: (latest: StoredDownload) => StoredDownload,
      durable = false,
    ) => {
      const latest = records.get(id);

      if (latest) write(change(latest), durable);
    };

    /** Writes several records in one transaction and keeps them: all of them, or none. */
    const writeAll = (changed: readonly StoredDownload[]) => {
      if (changed.length === 0) return;
      Effect.runSync(store.putMany(changed));

      for (const record of changed) records.set(record.id, record);
    };

    /** A download's place in the queue: its own, or when it was added, as an older build kept it. */
    const placeOf = (record: StoredDownload) => record.order ?? record.addedAt;

    /** The unfinished downloads in queue order; one placed alike keeps the order it was read in. */
    const unfinished = () =>
      [...records.values()]
        .filter((record) => record.state !== "complete")
        .toSorted((a, b) => placeOf(a) - placeOf(b));

    /** The place after every unfinished download's: where a new one goes. */
    const lastPlace = () => {
      let last = 0;

      for (const record of records.values()) {
        if (record.state !== "complete") last = Math.max(last, placeOf(record));
      }

      return last + 1;
    };

    // Cleanup is durable independently of the playable copy. An unavailable old volume must
    // not prohibit another move or deletion. New folders carry a token across remounts; legacy
    // markers retain their conservative parent check and may need manual cleanup.
    const deferCleanup = (record: StoredDownload) => {
      const pending: PendingCleanup[] = [];

      if (record.moveTo)
        pending.push({
          path: join(record.moveTo, record.moveId ?? record.id),
          ...defined({ token: record.moveToken, device: record.moveDevice }),
        });

      if (record.moveFrom)
        pending.push({ path: record.moveFrom, ...defined({ token: record.sourceToken }) });

      if (!pending.length) return;
      const { moveFrom: _from, sourceToken: _source, ...clean } = unmarked(record);
      Effect.runSync(store.deferCleanup(clean, pending));
      records.set(record.id, clean);
    };

    const retryCleanup = async () => {
      if (unloaded) return;

      for (const item of Effect.runSync(store.cleanups)) {
        try {
          const parent = await stat(join(item.path, ".."));

          if (item.token) {
            try {
              if ((await readFile(join(item.path, ".mrstreamer-owner"), "utf8")) !== item.token)
                continue;
            } catch (cause) {
              if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
                try {
                  await stat(item.path);
                } catch (missing) {
                  if (missing instanceof Error && "code" in missing && missing.code === "ENOENT")
                    Effect.runSync(store.forgetCleanup(item.path));
                }
              }

              continue;
            }
          } else if (!item.device || item.device !== `${parent.dev}:${parent.ino}`) continue;
          await rm(item.path, { recursive: true, force: true });
          const after = await stat(join(item.path, ".."));

          if (parent.dev === after.dev && parent.ino === after.ino) {
            await syncDirectory(join(item.path, ".."));
            Effect.runSync(store.forgetCleanup(item.path));
          }
        } catch {
          // Offline, replaced or locked folders stay tracked, even after the copy is deleted.
        }
      }
    };

    for (const record of records.values()) {
      if (record.moveTo || record.moveFrom) {
        try {
          deferCleanup(record);
        } catch {
          /* Keep the original durable marker on save failure. */
        }
      }
    }

    yield* Effect.promise(retryCleanup);

    // A copy renamed into place as the app stopped, before it was written down as complete.
    for (const record of records.values()) {
      if (
        record.state === "queued" &&
        record.size !== null &&
        (yield* Effect.promise(() => disk.size(mediaOf(record)))) === record.size
      ) {
        const { pausedAt: _pausedAt, order: _order, ...rest } = record;

        const complete: StoredDownload = {
          ...rest,
          state: "complete",
          received: record.size,
          completedAt: Date.now(),
        };

        const saved = yield* Effect.result(store.put(complete));

        if (saved._tag === "Failure") {
          unloaded = Effect.fail(saved.failure);
          break;
        }

        records.set(record.id, complete);
      }
    }

    const sweepingCleanup = yield* Effect.result(store.cleanups);

    // Folders no row names: left by a deletion that couldn't finish, or a download that went.
    // An unreadable record may name a moved folder too, so only a fully readable inventory can clean up.
    if (inventory && sweepingCleanup._tag === "Success" && inventory.unreadable.size === 0) {
      const ownedFolders = new Set(
        [...records.values()].flatMap((record) =>
          record.folderId ? [record.id, record.folderId] : [record.id],
        ),
      );

      // Pending folders remain reserved even after their authoritative copy was deleted.
      for (const item of sweepingCleanup.success) {
        ownedFolders.add(item.path.split(/[\\/]/).at(-1)!);
      }

      yield* Effect.promise(async () => {
        const names = await readdir(root).catch(() => []);
        await Promise.all(
          names
            .filter((name) => ID.test(name) && !ownedFolders.has(name))
            .map((name) => rm(join(root, name), { recursive: true, force: true }).catch(() => {})),
        );
      });
    }

    const lookForMissing = () => {
      missing.clear();

      for (const record of records.values()) {
        if (record.state === "complete" && !existsSync(mediaOf(record))) missing.add(record.id);
      }
    };

    lookForMissing();

    /**
     * Each series version of an account as the window knows it: a key made up for it in this run.
     * An Xtream account's key holds its username, so the window never sees what it is made of. Its
     * TMDB id splits it: a provider that gives a series' id to another series gives another key.
     */
    const seriesKeys = new Map<string, string>();

    const seriesKeyOf = (record: StoredDownload): string | null => {
      if (!record.series || record.title.kind !== "episode") return null;
      const version = JSON.stringify([record.account, record.title.seriesId, record.series.tmdb]);
      const known = seriesKeys.get(version);

      if (known) return known;
      const made = randomUUID();
      seriesKeys.set(version, made);

      return made;
    };

    /** The saved subscription of each account now, by its key, with the name it shows. */
    const accounts = Effect.gen(function* () {
      const [saved, listed] = yield* Effect.all([subscriptions.saved, subscriptions.list]);
      const names = new Map(listed.map((each) => [each.id, each.name ?? hostOf(each.server)]));

      return new Map(
        saved.map((each) => [each.key, { id: each.id, name: names.get(each.id) ?? "" }]),
      );
    });

    const downloadOf = (
      record: StoredDownload,
      owners: ReadonlyMap<string, { readonly id: string; readonly name: string }>,
      busy: ReadonlySet<string>,
    ) =>
      Effect.map(
        record.state === "complete"
          ? personal.read("download", record.id, record.progress)
          : Effect.succeed(null),
        (progress): Download => ({
          id: record.id,
          title: record.title,
          subscription: owners.get(record.account) ?? null,
          name: record.about.name,
          episodeName: record.about.episodeName,
          year: record.about.year,
          duration: record.about.duration,
          originalLanguage: record.about.originalLanguage,
          posterUrl: record.about.poster ? artworkUrl(record.id, "poster") : null,
          wideUrl: record.about.wide ? artworkUrl(record.id, "wide") : null,
          size:
            record.state === "complete"
              ? record.received
              : active?.id === record.id
                ? active.size
                : record.size,
          status:
            record.state === "complete"
              ? { kind: missing.has(record.id) ? "missing" : "complete" }
              : record.state === "failed"
                ? {
                    kind: "failed",
                    failure: record.failure ?? {
                      kind: "app",
                      error: { kind: "unexpected", detail: t("This download stopped.") },
                    },
                  }
                : active?.id === record.id
                  ? {
                      kind: "transferring",
                      received: active.received,
                      size: active.size,
                      rate: active.rate,
                      restarted: active.restarted,
                    }
                  : record.pausedAt !== undefined
                    ? { kind: "paused", received: record.received, size: record.size }
                    : busy.has(record.subscriptionId)
                      ? { kind: "waiting" }
                      : { kind: "queued" },
          progress,
          series: seriesKeyOf(record),
        }),
      );

    /** What each series of the downloads listed, by its key: as its latest queued one read it. */
    const seriesOf = (all: readonly StoredDownload[]) => {
      const latest = new Map<string, { readonly addedAt: number; readonly series: SeriesKept }>();

      for (const record of all) {
        const key = seriesKeyOf(record);
        const before = key ? latest.get(key) : undefined;

        if (key && record.series && (!before || record.addedAt >= before.addedAt)) {
          latest.set(key, { addedAt: record.addedAt, series: record.series });
        }
      }

      return Object.fromEntries(
        [...latest].map(([key, { series }]): [string, DownloadSeries] => [
          key,
          { seasons: series.seasons, sourceOrder: series.sourceOrder },
        ]),
      );
    };

    const view = Effect.gen(function* () {
      const owners = yield* accounts;
      const busy = yield* coordination.busy;
      const all = [...records.values()];
      // The transfer leads, then those waiting their turn in their order, then the failed ones.
      const queue = unfinished();

      const leads = (record: StoredDownload) =>
        record.state === "queued" && record.id === active?.id;

      const copies = all
        .filter((record) => record.state === "complete")
        .toSorted((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

      const free = yield* Effect.promise(async () => {
        if (selectedFolder === root) await mkdir(root, { recursive: true }).catch(() => {});

        return disk.free(selectedFolder);
      });

      return {
        items: yield* Effect.all(
          [
            ...queue.filter(leads),
            ...queue.filter((record) => record.state === "queued" && !leads(record)),
            ...queue.filter((record) => record.state === "failed"),
            ...copies,
          ].map((record) => downloadOf(record, owners, busy)),
        ),
        storage: { path: selectedFolder, moving: [...moving.keys()] },
        series: seriesOf(all),
        bytes: all.reduce(
          (sum, record) => sum + (active?.id === record.id ? active.received : record.received),
          0,
        ),
        free,
        ended,
      } satisfies DownloadList;
    });

    let telling: NodeJS.Timeout | undefined;
    /** Whether a list is being made to tell, and whether anything changed since it began. */
    let viewing = false;
    let stale = false;

    /**
     * Tells the window, once the changes of the next moment are in. One list is made at a time,
     * so one that waits on the disk can't arrive after a later one; what changes while it is made
     * is told once it is out.
     */
    const tell = () => {
      if (unloaded || closing) return;

      if (viewing) stale = true;

      if (telling || viewing) return;
      telling = setTimeout(() => {
        telling = undefined;
        viewing = true;
        void Effect.runPromise(view)
          .then(
            (list) => PubSub.publishUnsafe(changes, list),
            () => {},
          )
          .finally(() => {
            viewing = false;

            if (stale) {
              stale = false;
              tell();
            }
          });
      }, CHANGES_MS);
    };

    /**
     * The first download the queue may start now, in its order: queued, not paused, and of a
     * subscription that plays nothing and didn't refuse its connection in this choice.
     */
    const firstAllowed = (busy: ReadonlySet<string>, refused: ReadonlySet<string>) =>
      unfinished().find(
        (record) =>
          record.state === "queued" &&
          !removing.has(record.id) &&
          record.pausedAt === undefined &&
          !busy.has(record.subscriptionId) &&
          !refused.has(record.subscriptionId),
      );

    /**
     * Starts the first download allowed to go, if none goes on. Its subscription's connection is
     * lent under playback's admission, which can wait on an open or a removal: the queue may have
     * been reordered, paused or emptied meanwhile. Whatever is first then starts, when the lease is
     * its subscription's; otherwise the lease goes back and the choice is made again from the queue
     * as it is.
     */
    let picking = false;
    let again = false;

    const next = async (): Promise<void> => {
      if (picking) {
        again = true;

        return;
      }

      picking = true;

      try {
        // Subscriptions that lent nothing in this choice: something of theirs plays. Woken
        // meanwhile, as when playback stopped, the queue forgets them: they may lend now.
        const refused = new Set<string>();

        for (;;) {
          if (unloaded || active || closing) return;

          if (again) refused.clear();
          again = false;
          const chosen = firstAllowed(await Effect.runPromise(coordination.busy), refused);

          if (!chosen) {
            if (!again) return;
            continue;
          }

          const lent = await Effect.runPromise(coordination.lend(chosen.subscriptionId));

          if (!lent) {
            refused.add(chosen.subscriptionId);
            continue;
          }

          const busy = await Effect.runPromise(coordination.busy);

          if (again) refused.clear();
          // Read only now: the app may have begun to close while the lease was asked for.
          const first = closing ? undefined : firstAllowed(busy, refused);

          if (first?.subscriptionId === chosen.subscriptionId) {
            start(first, lent);

            return;
          }

          lent.release();
        }
      } finally {
        picking = false;
      }
    };

    const wake = () => void next();

    /** Transfers `record` on the connection playback lent it. */
    const start = (record: StoredDownload, lent: Lent) => {
      const finished = deps.observeTransfer?.();
      const controller = new AbortController();
      let outcome: TransferOutcome = { kind: "stopped" };

      const transferring: Active = {
        id: record.id,
        controller,
        received: record.received,
        size: record.size,
        identity: record.identity,
        restarted: record.restarted,
        rate: null,
        over: Promise.resolve(),
        settled: Promise.resolve(null),
      };

      active = transferring;
      tell();
      transferring.over = transferOf(
        record,
        transferring,
        AbortSignal.any([controller.signal, lent.signal]),
      )
        .then(
          (ended) => void (outcome = ended),
          (cause) =>
            void (outcome = {
              kind: "failed",
              failure: { kind: "app", error: failedWith(cause).error },
            }),
        )
        // Only once its request is over does the subscription's stream go on.
        .finally(() => lent.release());
      transferring.settled = transferring.over
        .then(async () => {
          const failure = await settle(record.id, transferring, outcome);

          if (failure === "stopped") finished?.("interrupted");
          else if (failure) finished?.("failed", downloadFailure(failure));
          else finished?.(outcome.kind === "stopped" ? "interrupted" : "success");

          return null;
        })
        .catch((cause) => {
          finished?.("failed", "app");
          console.warn("[downloads] couldn't keep how a transfer ended", cause);
          const failure = cause instanceof Failed ? cause : failedWith(cause);
          // Failed as far as this run knows, so the queue doesn't take it again and again.
          const latest = records.get(record.id);

          if (latest?.state === "queued") {
            records.set(record.id, {
              ...latest,
              state: "failed",
              failure: { kind: "app", error: failure.error },
            });
          }

          return failure;
        })
        .finally(() => {
          active = null;
          tell();
          wake();
        });
    };

    /** Asks the provider for `record`'s file and writes it into its partial file. */
    const transferOf = async (
      record: StoredDownload,
      transferring: Active,
      signal: AbortSignal,
    ): Promise<TransferOutcome> => {
      const title: TitleRef = { ...record.title, subscriptionId: record.subscriptionId };

      // Stopped while the file is looked up, nothing is asked of the provider's file. A lookup a
      // catalogue refresh overtook is asked once more, of the catalogue that refresh accepted.
      const resolved = await Effect.runPromise(
        Effect.all([
          subscriptions.sourceOf(record.subscriptionId),
          onDemand
            .file(title)
            .pipe(Effect.retry({ times: 1, while: (failure) => failure instanceof Overtaken })),
        ]).pipe(Effect.result),
        { signal },
      ).catch(() => null);

      if (!resolved || signal.aborted) return { kind: "stopped" };

      if (resolved._tag === "Failure") {
        return { kind: "failed", failure: { kind: "app", error: resolved.failure.error } };
      }

      const [source, file] = resolved.success;

      // A file looked up, first or renewed, under a login that replaced the one read here fails as
      // a replaced login does.
      if (file.revision !== source.revision) {
        return { kind: "failed", failure: { kind: "app", error: subscriptionChanged() } };
      }

      // The file the bytes are of: its listing and login, which its saved subtitles are kept by.
      update(record.id, (latest) => ({
        ...latest,
        listingKey: file.listingKey,
        sourceStamp: source.fileRevision,
      }));

      try {
        if (
          record.directory &&
          record.directory !== root &&
          !(await stat(record.directory)).isDirectory()
        )
          throw new Error("Download folder unavailable");
        await mkdir(folderOf(record.id), { recursive: true });
      } catch (cause) {
        return { kind: "failed", failure: { kind: "folder", detail: messageOf(cause) } };
      }

      if (signal.aborted) return { kind: "stopped" };
      let savedAt = performance.now();
      let measured = { at: performance.now(), received: record.received };

      return transfer({
        url: file.url,
        headers: file.headers ?? {},
        request: source.provider.request,
        userAgent: deps.userAgent,
        part: partOf(record),
        known: record.identity,
        signal,
        disk,
        progress: ({ received, size, restarted }) => {
          if (active !== transferring) return;
          const now = performance.now();

          if (now - measured.at >= 1000) {
            const rate = ((received - measured.received) * 1000) / (now - measured.at);
            transferring.rate = rate >= 0 ? rate : null;
            measured = { at: now, received };
          }

          const again = restarted !== transferring.restarted;
          transferring.received = received;
          transferring.size = size;
          transferring.restarted = restarted;
          tell();

          // How far it got goes down now and then; what the partial is of, as `identify` says.
          if (again || now - savedAt >= SAVE_MS) {
            savedAt = now;

            try {
              update(record.id, (latest) => ({ ...latest, received, size, restarted }));
            } catch {
              // Written down at the end, or the transfer goes on from less.
            }
          }
        },
        // Throws when it can't be written down, before the transfer touches the partial.
        identify: (identity) => {
          transferring.identity = identity;

          if (sameIdentity(records.get(record.id)?.identity ?? null, identity)) return;
          const { received, size, restarted } = transferring;
          update(record.id, (latest) => ({ ...latest, received, size, identity, restarted }));
        },
      });
    };

    /** Writes down how a transfer ended: a copy, a failure, or where it stopped. */
    const settle = async (
      id: string,
      transferring: Active,
      outcome: TransferOutcome,
    ): Promise<DownloadFailure | "stopped" | undefined> => {
      const record = records.get(id);

      // Removed meanwhile: its files are the removal's.
      if (!record) return "stopped";
      const { received, size, identity, restarted } = transferring;
      const where = { ...record, received, size, identity, restarted };

      if (outcome.kind === "stopped") {
        update(id, () => where);

        return;
      }

      if (outcome.kind === "failed") {
        update(id, () => ({ ...where, state: "failed", failure: outcome.failure }));

        return outcome.failure;
      }

      try {
        await rename(partOf(record), mediaOf(record));
      } catch (cause) {
        const failure: DownloadFailure = { kind: "folder", detail: messageOf(cause) };
        update(id, () => ({ ...where, state: "failed", failure }));

        return failure;
      }

      // What was saved for the exact bytes it was made from comes with the copy. Saved for other
      // bytes, or without proof of which, it stays the provider file's.
      const source = await Effect.runPromise(
        subscriptions.sourceOf(record.subscriptionId).pipe(Effect.option),
      );

      if (source._tag === "Some" && outcome.identity && records.has(id)) {
        await Effect.runPromise(
          savedSubtitles
            .duplicate(
              {
                account: source.value.key,
                sourceStamp: record.sourceStamp,
                listingKey: record.listingKey,
                kind: record.title.kind,
                id: record.title.id,
              },
              subtitlesOfCopy(record.id, record.title),
              outcome.identity,
            )
            .pipe(Effect.ignore),
        );
      }

      if (!records.has(id)) return "stopped";
      missing.delete(id);
      // A copy has no place in the queue, and a pause asked for as it finished pauses nothing.
      update(id, (latest) => {
        const { failure: _failure, pausedAt: _pausedAt, order: _order, ...rest } = latest;

        return {
          ...rest,
          state: "complete",
          received: outcome.size,
          size: outcome.size,
          identity: outcome.identity,
          restarted,
          completedAt: Date.now(),
        };
      });
    };

    /**
     * Stops the transfer under way, its pause already written down: done once its request ended,
     * its partial file closed and where it stopped is kept. Fails, the transfer stopped all the
     * same, when where it stopped can't be kept.
     */
    const stopPaused = async (transferring: Active) => {
      transferring.controller.abort();
      const failure = await transferring.settled;

      if (failure) throw failure;
    };

    /**
     * Excludes this ID from admission before any await. Its transfer and artwork settle before
     * playback closes and files go; only a successful file deletion permits removing the record.
     */
    const removeOne = async (id: string) => {
      const record = records.get(id);

      if (!record) return;

      if (moving.has(id) || removing.has(id)) throw moveError("Copy is busy");

      removing.add(id);

      try {
        deferCleanup(record);
        await retryCleanup();
        const transferring = active?.id === id ? active : null;

        if (transferring) {
          // Removal has already excluded this ID from admission; no pause save is needed.
          transferring.controller.abort();
          await transferring.settled;
        }

        await artworkWork.get(id);
        await Effect.runPromise(playback.closeCopy(id));
        await rm(folderOf(id), { recursive: true, force: true });
        Effect.runSync(store.remove(id));
        records.delete(id);
        missing.delete(id);
        await Effect.runPromise(
          savedSubtitles.forget(subtitlesOfCopy(id, record.title)).pipe(Effect.ignore),
        );
      } catch (cause) {
        const latest = records.get(id);

        if (latest?.state === "queued") {
          const failed: StoredDownload = {
            ...latest,
            state: "failed",
            failure: { kind: "app", error: safeMoveFailure(cause).error },
          };

          try {
            write(failed);
          } catch {
            records.set(id, failed);
          }
        }

        tell();
        wake();
        throw cause;
      } finally {
        removing.delete(id);
      }
    };

    // Whatever plays decides which subscriptions' downloads wait.
    yield* Effect.forkIn(
      Stream.runForEach(coordination.busyChanged, () =>
        Effect.sync(() => {
          tell();
          wake();
        }),
      ),
      scope,
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closing = true;
        clearTimeout(telling);
        const stopping = active;

        for (const work of moving.values()) {
          work.cancelled = true;
          work.controller.abort();
        }

        await Promise.all([...moving.values()].map((work) => work.settled.catch(() => {})));

        if (!stopping) return;
        stopping.controller.abort();
        await stopping.settled;
      }),
    );
    wake();

    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: safeMoveFailure,
      });

    // Made when it fails, so it says so in the interface language of the moment.
    const notFound = () =>
      new Failed({
        error: { kind: "unexpected", detail: t("That download is no longer here.") },
      });

    /**
     * Moves one finished copy to a freshly reserved UUID folder, keeping its copy ID. The record keeps its old
     * folder, with a `moveTo` marker naming the incomplete target, until every file is flushed;
     * only then does it commit. A copy already there counts as moved.
     */
    const relocate = async (id: string): Promise<boolean> => {
      const record = records.get(id);

      if (!record || record.state !== "complete") throw notFound();

      if (closing || moving.has(id) || removing.has(id)) throw moveError("Copy is busy");
      const destination = selectedFolder;

      const work = {
        cancelled: false,
        controller: new AbortController(),
        settled: Promise.resolve(),
      };

      moving.set(id, work);
      work.settled = (async () => {
        deferCleanup(record);
        await retryCleanup();

        const sourceParent = await realpath(record.directory ?? root).catch(() => {
          throw moveError("Source copy is missing or changed");
        });

        const destinationParent = await realpath(destination).catch(() => {
          throw moveError("Destination unavailable");
        });

        if (sourceParent === destinationParent) return;
        await artworkWork.get(id);

        const source = folderOf(id);
        const moveId = randomUUID();
        const target = join(destination, moveId);

        if (
          (
            await stat(mediaOf(record)).catch(() => {
              throw moveError("Source copy is missing or changed");
            })
          ).size !== record.size
        )
          throw moveError("Source copy is missing or changed");

        if (within(source, destination)) throw moveError("Destination is inside this copy");

        const check = () => {
          if (work.cancelled || closing) throw moveError("Move cancelled; original copy kept");
        };

        check();

        const parent = await stat(destination).catch(() => {
          throw moveError("Destination unavailable");
        });

        if (!parent.isDirectory()) throw moveError("Destination unavailable");
        const moveDevice = `${parent.dev}:${parent.ino}`;
        const free = await disk.free(destination);

        if (free !== null && record.size !== null && free < record.size)
          throw moveError("Disk full. Free some space, then retry.");
        // Reserve a fresh UUID durably before creating anything at the destination.
        const token = randomUUID();
        const ownership = await open(join(source, ".mrstreamer-owner"), "w");

        try {
          await ownership.writeFile(token);
          await ownership.sync();
        } finally {
          await ownership.close();
        }

        await syncDirectory(source);
        update(
          id,
          (latest) => ({ ...latest, moveTo: destination, moveId, moveDevice, moveToken: token }),
          true,
        );
        let committed = false;

        try {
          await mkdir(target);
          const targetOwner = await open(join(target, ".mrstreamer-owner"), "wx");

          try {
            await targetOwner.writeFile(token);
            await targetOwner.sync();
          } finally {
            await targetOwner.close();
          }

          const copyTree = async (from: string, to: string): Promise<void> => {
            for (const entry of await readdir(from, { withFileTypes: true })) {
              check();

              if (entry.name === ".mrstreamer-owner") continue;
              const input = join(from, entry.name);
              const output = join(to, entry.name);

              if (entry.isDirectory()) {
                await mkdir(output);
                await copyTree(input, output);
              } else if (entry.isFile()) {
                try {
                  await pipeline(
                    createReadStream(input),
                    createWriteStream(output, { flags: "wx" }),
                    { signal: work.controller.signal },
                  );
                } catch (cause) {
                  check();
                  throw cause;
                }

                const file = await open(output, "r+");

                try {
                  await file.sync();
                } finally {
                  await file.close();
                }

                if ((await stat(input)).size !== (await stat(output)).size)
                  throw moveError("Incomplete copy");
              } else throw moveError("Copy contains an unsupported file");
            }

            await syncDirectory(to);
          };

          await copyTree(source, target);
          await syncDirectory(destination);
          check();
          // Closing playback prevents a stale reader surviving deletion of its old files.
          await Effect.runPromise(playback.closeCopy(id));
          check();
          update(
            id,
            (latest) => ({
              ...unmarked(latest),
              directory: destination,
              folderId: moveId,
              moveFrom: source,
              sourceToken: token,
            }),
            true,
          );
          committed = true;
          missing.delete(id);

          deferCleanup(records.get(id)!);
          await retryCleanup();
        } finally {
          if (!committed) {
            try {
              deferCleanup(records.get(id)!);
              await retryCleanup();
            } catch {
              // Preserve the original failure and the durable intent if bookkeeping fails.
            }
          }
        }
      })();
      tell();

      try {
        await work.settled;

        return work.cancelled;
      } finally {
        moving.delete(id);
        tell();
      }
    };

    const commands: Downloads["Service"] = {
      cancelMove: (id: string) =>
        attempt(async () => {
          const work = moving.get(id);

          if (!work) return;
          work.cancelled = true;
          work.controller.abort();
          await work.settled.catch(() => {});
        }),
      bulk: (ids: readonly string[], action: DownloadBulkAction) =>
        attempt(async () => {
          if (unloaded) await Effect.runPromise(unloaded);
          const succeeded: string[] = [];
          const failed: { id: string; error: AppError }[] = [];

          let cancelled = false;

          const perform = async (id: string) => {
            try {
              if (cancelled) throw moveError("Move cancelled; original copy kept");

              if (!records.has(id)) throw notFound();

              if (moving.has(id) || removing.has(id)) throw moveError("Copy is busy");

              if (action === "move") cancelled = await relocate(id);
              else if (action === "remove") {
                await removeOne(id);
                tell();
                wake();
              } else await Effect.runPromise(commands[action](id));
              succeeded.push(id);
            } catch (cause) {
              const error = safeMoveFailure(cause).error;

              if (action === "move" && cause instanceof MoveFailure && cause.cancelled)
                cancelled = true;
              failed.push({ id, error });
            }
          };

          // Each remove reserves its ID synchronously, before stopping a transfer can wake the queue.
          if (action === "remove") await Promise.all([...new Set(ids)].map(perform));
          else for (const id of new Set(ids)) await perform(id);

          return { succeeded, failed };
        }),
      folder: Effect.suspend(
        () => unloaded ?? Effect.succeed({ path: selectedFolder, moving: [...moving.keys()] }),
      ),
      setFolder: (path: string) =>
        attempt(async () => {
          if (unloaded) await Effect.runPromise(unloaded);
          const directory = await realpath(path);

          if (!(await stat(directory)).isDirectory()) throw moveError("Not a folder");

          const copyFolders = await Promise.all(
            [...records.values()].map(async (record) =>
              join(
                await realpath(record.directory ?? root).catch(() => record.directory ?? root),
                record.folderId ?? record.id,
              ),
            ),
          );

          if (copyFolders.some((folder) => within(folder, directory)))
            throw moveError("Choose a folder outside managed copies");

          const probe = join(directory, `.mrstreamer-${randomUUID()}`);
          const file = await open(probe, "wx");

          try {
            await file.sync();
          } finally {
            await file.close();
            await rm(probe);
          }

          const isDefault = directory === (await realpath(root).catch(() => root));
          Effect.runSync(store.setFolder(isDefault ? root : directory));
          selectedFolder = isDefault ? root : directory;
          tell();
        }),
      list: Effect.suspend(() => {
        if (unloaded) return unloaded;
        lookForMissing();

        return view;
      }),

      add: (title: TitleRef) =>
        Effect.gen(function* () {
          if (unloaded) return yield* unloaded;
          const source = yield* subscriptions.sourceOf(title.subscriptionId);
          const { subscriptionId, ...raw } = title;

          const knownOf = () =>
            [...records.values()].find(
              (record) =>
                record.account === source.key &&
                record.title.kind === raw.kind &&
                record.title.id === raw.id,
            );

          const answer = (known: StoredDownload) =>
            Effect.gen(function* () {
              const owners = yield* accounts;
              const busy = yield* coordination.busy;

              if (known.state === "failed") {
                yield* attempt(async () =>
                  update(known.id, ({ failure: _failure, pausedAt: _pausedAt, ...rest }) => ({
                    ...rest,
                    state: "queued",
                  })),
                );
                tell();
                wake();
              }

              return yield* downloadOf(records.get(known.id) ?? known, owners, busy);
            });

          const known = knownOf();

          if (known) return yield* answer(known);
          // Asked first: a title its provider doesn't list now isn't queued.
          const file = yield* onDemand.file(title);
          const kept = yield* aboutOf(raw, subscriptionId);
          const owners = yield* accounts;
          const busy = yield* coordination.busy;

          // Both took a while. A removal drains unfinished downloads while the subscription is
          // excluded, before deleting its login. Check its source again and use an existing copy
          // if the same title was added meanwhile.
          if (!(yield* subscriptions.stands(source))) {
            return yield* new Failed({ error: { kind: "no-subscription" } });
          }

          const added = knownOf();

          if (added) return yield* answer(added);

          const record: StoredDownload = {
            id: randomUUID(),
            ...defined({ directory: selectedFolder === root ? undefined : selectedFolder }),
            account: source.key,
            subscriptionId,
            title: raw,
            listingKey: file.listingKey,
            sourceStamp: source.fileRevision,
            container: file.container,
            about: { ...kept.about, poster: null, wide: null },
            ...defined({ series: "series" in kept ? kept.series : undefined }),
            state: "queued",
            size: null,
            received: 0,
            identity: null,
            restarted: false,
            addedAt: Date.now(),
            // Last in the queue, so a season added episode by episode keeps their order.
            order: lastPlace(),
            completedAt: null,
            progress: null,
          };

          const result = yield* downloadOf(record, owners, busy);
          yield* attempt(async () => {
            // Keep this source check and publication synchronous: no await may separate them.
            if (!subscriptions.standsNow(source))
              throw new Failed({ error: { kind: "no-subscription" } });
            write(record);
          });
          yield* Effect.forkIn(
            Effect.promise(() => {
              const work = keepArtwork(record.id, kept.artwork);
              artworkWork.set(record.id, work);

              return work.finally(() => artworkWork.delete(record.id));
            }),
            scope,
          );
          tell();
          wake();

          return result;
        }),

      remove: (id: string) =>
        attempt(async () => {
          await removeOne(id);
          tell();
          wake();
        }),

      retry: (id: string) =>
        attempt(async () => {
          const record = records.get(id);

          if (!record) throw notFound();

          if (record.state !== "failed") return;
          // Retry asks for the transfer, so a pause an older build kept through the failure goes.
          const { failure: _failure, pausedAt: _pausedAt, ...rest } = record;
          write({ ...rest, state: "queued" });
          tell();
          wake();
        }),

      pause: (id: string) =>
        attempt(async () => {
          const record = records.get(id);

          if (!record) throw notFound();

          if (record.state !== "queued") return;

          if (record.pausedAt === undefined) {
            write({ ...record, pausedAt: Date.now() });
            tell();
          }

          if (active?.id === id) await stopPaused(active);
        }),

      resume: (id: string) =>
        attempt(async () => {
          const record = records.get(id);

          if (!record) throw notFound();

          if (record.state !== "queued" || record.pausedAt === undefined) return;
          const { pausedAt: _pausedAt, ...rest } = record;
          write(rest);
          tell();
          wake();
        }),

      pauseAll: attempt(async () => {
        const at = Date.now();
        writeAll(
          [...records.values()].flatMap((record) =>
            record.state === "queued" && record.pausedAt === undefined
              ? [{ ...record, pausedAt: at }]
              : [],
          ),
        );
        tell();

        if (active && records.get(active.id)?.pausedAt !== undefined) await stopPaused(active);
      }),

      resumeAll: attempt(async () => {
        writeAll(
          [...records.values()].flatMap(({ pausedAt, ...rest }) =>
            rest.state === "queued" && pausedAt !== undefined ? [rest] : [],
          ),
        );
        tell();
        wake();
      }),

      move: (id: string, by: -1 | 1) =>
        attempt(async () => {
          const record = records.get(id);

          if (!record) throw notFound();
          const queue = unfinished();
          const waiting = queue.filter((each) => each.state === "queued" && each.id !== active?.id);
          const from = waiting.indexOf(record);
          const other = waiting[from + by];

          if (from < 0 || !other) return;
          // Swapped in the whole queue, then every unfinished download given its place from 1, so
          // two an older build added at the same moment swap too, and the rest keep their order.
          const order = queue.with(queue.indexOf(record), other).with(queue.indexOf(other), record);
          writeAll(
            order.flatMap((each, index) =>
              each.order === index + 1 ? [] : [{ ...each, order: index + 1 }],
            ),
          );
          tell();
        }),

      recordProgress: (id: string, position: number, duration: number) =>
        Effect.suspend(() =>
          records.get(id)?.state === "complete"
            ? personal.write("download", id, position, duration)
            : Effect.fail(notFound()),
        ).pipe(Effect.tap(() => Effect.sync(tell))),

      copy: (id: string) =>
        Effect.suspend(() => {
          const record = records.get(id);

          if (record?.state !== "complete" || !existsSync(mediaOf(record))) {
            if (record?.state === "complete" && !missing.has(id)) {
              missing.add(id);
              tell();
            }

            return Effect.fail(
              new Failed({
                error: { kind: "stream", failure: { kind: "unavailable", status: 404 } },
              }),
            );
          }

          return personal.read("download", id, record.progress).pipe(
            Effect.map(
              (progress) =>
                ({
                  id: record.id,
                  path: mediaOf(record),
                  container: record.container,
                  title: record.title,
                  progress,
                }) satisfies LocalCopy,
            ),
          );
        }),

      artwork: (id: string, artwork: DownloadArtwork) =>
        Effect.sync(() => {
          const record = records.get(id);
          const type = record?.about[artwork];

          return record && type ? { path: join(folderOf(record.id), artwork), type } : null;
        }),

      subscriptionGone: (subscriptionId: string) =>
        attempt(async () => {
          if (unloaded) await Effect.runPromise(unloaded);

          const gone = [...records.values()].filter(
            (record) => record.subscriptionId === subscriptionId && record.state !== "complete",
          );

          if (gone.length === 0) return;

          for (const record of gone) {
            try {
              await removeOne(record.id);
              ended++;
            } catch (cause) {
              const latest = records.get(record.id);

              if (latest) {
                const failed: StoredDownload = {
                  ...latest,
                  state: "failed",
                  failure: { kind: "app", error: safeMoveFailure(cause).error },
                };

                try {
                  write(failed);
                } catch {
                  records.set(record.id, failed);
                }
              }

              throw cause;
            }
          }

          tell();
          wake();
        }),

      changes: Stream.fromPubSub(changes),
    };

    return commands;

    /**
     * What a download keeps of its title's details, and where its pictures are online, from the
     * details the viewer just opened: a movie's, or an episode's with its series', and what that
     * series lists, so its copies are placed and go on offline. Nothing more is asked for that.
     */
    function aboutOf(title: RawTitleRef, subscriptionId: string) {
      return Effect.gen(function* () {
        if (title.kind === "movie") {
          const details = yield* onDemand.details("movie", { subscriptionId, id: title.id });

          return {
            about: {
              name: details.title.title,
              episodeName: null,
              year: details.title.year,
              duration: details.duration,
              originalLanguage: details.title.originalLanguage,
            },
            artwork: {
              poster: details.title.posterUrl,
              wide: details.backdropUrl ?? details.title.backdropUrl,
            },
          };
        }

        const series = yield* onDemand.details("series", { subscriptionId, id: title.seriesId });

        const season = yield* onDemand
          .season({ subscriptionId, id: title.seriesId }, title.season)
          .pipe(Effect.orElseSucceed((): readonly EpisodeDetails[] => []));

        const episode =
          season.find((each) => each.id === title.id) ??
          (series.kind === "series"
            ? series.seasons.flatMap((each) => each.episodes).find((each) => each.id === title.id)
            : undefined);

        return {
          about: {
            name: series.title.title,
            episodeName: episode?.title ?? null,
            year: series.title.year,
            duration: episode?.duration ?? series.duration,
            originalLanguage: series.title.originalLanguage,
          },
          artwork: {
            poster: series.title.posterUrl,
            wide: episode?.stillUrl ?? series.backdropUrl ?? series.title.backdropUrl,
          },
          ...defined({
            series:
              series.kind === "series"
                ? {
                    tmdb: series.title.tmdbId,
                    seasons: seriesEpisodeSeasons(series).map(({ number, episodes }) => ({
                      number,
                      episodes: episodes.map((each) => each.number),
                    })),
                    sourceOrder: series.episodeOrder !== undefined,
                  }
                : undefined,
          }),
        };
      });
    }

    /**
     * Fetches a download's pictures into its folder, so the copy shows them with no network. One
     * that doesn't come leaves the copy without it.
     */
    async function keepArtwork(
      id: string,
      urls: { readonly poster: string | null; readonly wide: string | null },
    ): Promise<void> {
      const kept: Partial<Record<DownloadArtwork, string>> = {};

      for (const artwork of ["poster", "wide"] as const) {
        const url = urls[artwork];

        if (!url || !/^https?:\/\//.test(url)) continue;
        const picture = await fetchPicture(url).catch(() => null);

        if (!picture || !records.has(id) || removing.has(id)) continue;

        try {
          await mkdir(folderOf(id), { recursive: true });
          await writeFile(join(folderOf(id), artwork), picture.bytes);
          kept[artwork] = picture.type;
        } catch {
          // Without it, the copy shows its name.
        }
      }

      if (Object.keys(kept).length === 0) return;

      try {
        update(id, (latest) => ({
          ...latest,
          about: { ...latest.about, ...kept } satisfies About,
        }));
      } catch {
        // Fetched again by nothing: the copy shows its name.
      }

      tell();
    }

    async function fetchPicture(
      url: string,
    ): Promise<{ readonly bytes: Uint8Array; readonly type: string } | null> {
      const response = await fetchArtwork(url, {
        headers: { "User-Agent": deps.userAgent },
        signal: AbortSignal.timeout(ARTWORK_MS),
      });

      const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";

      if (!response.ok || !type.startsWith("image/") || !response.body) {
        void response.body?.cancel().catch(() => {});

        return null;
      }

      const parts: Uint8Array[] = [];
      let length = 0;

      for await (const part of response.body) {
        length += part.length;

        if (length > ARTWORK_BYTES) return null;
        parts.push(part);
      }

      return { bytes: Buffer.concat(parts), type };
    }
  });
}

function sameIdentity(a: PartIdentity | null, b: PartIdentity | null): boolean {
  return a?.resource === b?.resource && a?.mark === b?.mark && a?.size === b?.size;
}

/** A file type safe to name a file with; anything else is kept as "bin". */
function extensionOf(container: string): string {
  return /^[a-z0-9]{1,8}$/i.test(container) ? container.toLowerCase() : "bin";
}

function hostOf(server: string): string {
  return URL.parse(server)?.host || server;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Directory fsync is supported on Unix; Windows flushes copied files but cannot open directories. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Whether `path` is `parent` or inside it. */
function within(parent: string, path: string): boolean {
  const inside = relative(parent, path);

  return !inside || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** A record without its move marker: the move committed, or its target was cleaned up. */
function unmarked({
  moveTo: _moveTo,
  moveId: _moveId,
  moveDevice: _moveDevice,
  moveToken: _moveToken,
  ...rest
}: StoredDownload): StoredDownload {
  return rest;
}

function safeMoveFailure(cause: unknown): Failed {
  if (cause instanceof Failed) return cause;

  if (cause instanceof AppFailure) return failedWith(cause);

  if (cause instanceof Error && "code" in cause && cause.code === "ENOSPC")
    return moveError("Disk full. Free some space, then retry.");

  if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
    return moveError("Destination folder already exists");

  return moveError("The downloads folder can't be written. Retry, or check the disk.");
}

class MoveFailure extends Failed {
  readonly cancelled: boolean;
  constructor(message: MoveMessage) {
    super({ error: { kind: "unexpected", detail: t(message) } });
    this.cancelled = message === "Move cancelled; original copy kept";
  }
}

function moveError(message: MoveMessage): Failed {
  return new MoveFailure(message);
}

type MoveMessage =
  | "Destination folder already exists"
  | "Copy is busy"
  | "Destination needs recovery; reconnect it and restart"
  | "Source copy is missing or changed"
  | "Destination is inside this copy"
  | "Move cancelled; original copy kept"
  | "Destination unavailable"
  | "Disk full. Free some space, then retry."
  | "Incomplete copy"
  | "Copy contains an unsupported file"
  | "Not a folder"
  | "Choose a folder outside managed copies"
  | "The downloads folder can't be written. Retry, or check the disk.";
