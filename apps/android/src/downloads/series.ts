import { type } from "arktype";
import type { SeriesDetails } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { episodesIn, type Scope } from "@mrstreamer/mobile/series-download";
import { store, type Store } from "../platform/store.ts";
import type { ReplaceOwner } from "./replace.ts";
import { Snapshot, type DownloadRow, type BulkTransferPort, type DownloadState } from "./state.ts";

export interface SeriesFile {
  readonly key: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly kind: "episode";
  readonly mediaId: string;
  readonly container: string;
  readonly title: string;
  readonly seriesKey: string;
  readonly seriesId: string;
  readonly order: readonly string[];
  readonly season: number;
  readonly episode: number;
  readonly episodeName: string;
}

type Status = "none" | "held" | "failed" | "missing" | "changed";

export function copyStatus(row: DownloadRow | undefined): Status {
  if (!row) return "none";

  if (row.state !== "failed") return "held";

  return row.reason === "missing"
    ? "missing"
    : row.reason === "file-changed"
      ? "changed"
      : "failed";
}

/** Uses the iOS exact-file ordering contract rather than sorting season or episode labels. */
export function seriesFiles(
  details: SeriesDetails,
  version: OwnedId,
  containers: ReadonlyMap<string, string>,
  sourceLabel: string,
  scope: Scope,
): SeriesFile[] {
  const all = episodesIn(details, version, { kind: "series" });
  const order = all.map((ref) => ref.id);

  return episodesIn(details, version, scope).map((ref) => {
    const container = containers.get(ref.id)?.trim();

    if (!container) throw new Error("container");
    const episode = details.seasons.flatMap((s) => s.episodes).find((e) => e.id === ref.id);

    return {
      key: JSON.stringify([ref.subscriptionId, "episode", ref.id, container]),
      sourceId: ref.subscriptionId,
      sourceLabel,
      kind: "episode",
      mediaId: ref.id,
      container,
      title: details.title.title,
      seriesKey: details.title.key,
      seriesId: version.id,
      order,
      season: ref.season,
      episode: ref.episode,
      episodeName: episode?.title ?? "",
    };
  });
}

export interface SeriesPlan {
  readonly token: string;
  readonly steps: readonly {
    readonly file: SeriesFile;
    readonly was: Status;
    readonly row: DownloadRow | undefined;
  }[];
  readonly held: number;
  readonly add: number;
  readonly retry: number;
  readonly missing: number;
  readonly changed: number;
}

export interface SeriesResult {
  readonly added: number;
  readonly retried: number;
  readonly replaced: number;
  readonly skipped: number;
  readonly failed: readonly SeriesFile[];
  readonly stopped: "cancelled" | "left" | "version" | "login" | null;
  readonly unqueued: number;
}

export interface SeriesRun {
  readonly running: boolean;
  readonly done: number;
  readonly total: number;
  readonly result: SeriesResult;
}

let runningOwner: { stop(reason: NonNullable<SeriesResult["stopped"]>): void } | undefined;

/** True while any series screen is adding episodes; only one adds at a time. */
export const seriesBusy = store(false);

/** Library calls this even when the same version is selected again. */
export function stopSeriesDownloads(reason: NonNullable<SeriesResult["stopped"]>) {
  runningOwner?.stop(reason);
}

/** A series screen owns this controller. Closing it invalidates unqueued work only. */
export function seriesDownloads(
  port: Pick<BulkTransferPort, "review" | "admit" | "endReview">,
  beforeReplace: (row: DownloadRow) => Promise<boolean>,
  refresh: () => Promise<void>,
) {
  const state = store<SeriesRun | null>(null);

  const owner = {
    stop(reason: NonNullable<SeriesResult["stopped"]>) {
      stopped = reason;
    },
  };

  let active = false;
  let stopped: SeriesResult["stopped"] = null;
  let review: SeriesPlan | undefined;

  return {
    state,
    async plan(files: readonly SeriesFile[]): Promise<SeriesPlan> {
      if (active) throw new Error("running");

      if (review) await port.endReview(review.token);

      const response = type({ token: "string", snapshot: Snapshot })(
        JSON.parse(await port.review(JSON.stringify(files))),
      );

      if (response instanceof type.errors) throw new Error("read");

      const steps = files.map((file) => {
        const row = response.snapshot.rows.find((r) => r.key === file.key);

        return { file, was: copyStatus(row), row };
      });

      const counts = { none: 0, held: 0, failed: 0, missing: 0, changed: 0 };

      for (const step of steps) counts[step.was]++;
      review = {
        token: response.token,
        steps,
        held: counts.held,
        add: counts.none,
        retry: counts.failed,
        missing: counts.missing,
        changed: counts.changed,
      };
      stopped = null;

      return review;
    },
    stop(reason: NonNullable<SeriesResult["stopped"]> = "cancelled") {
      stopped ??= reason;
    },
    async close() {
      stopped ??= "left";

      if (review) await port.endReview(review.token);
    },
    async start(
      plan: SeriesPlan,
      replace: boolean,
      stands: () => SeriesResult["stopped"],
    ): Promise<SeriesResult | null> {
      if (runningOwner || active || review !== plan || stopped || stands()) return null;
      runningOwner = owner;
      seriesBusy.set(true);
      active = true;

      // A changed file is never replaced in bulk: replacing deletes it, so its own row asks first.
      const steps = plan.steps.filter(
        (s) => s.was !== "held" && s.was !== "changed" && (replace || s.was !== "missing"),
      );

      const failed: SeriesFile[] = [];

      const result = {
        added: 0,
        retried: 0,
        replaced: 0,
        skipped: 0,
        failed,
        stopped: null as SeriesResult["stopped"],
        unqueued: 0,
      };

      let done = 0;

      const publish = () =>
        state.set({
          running: active,
          done,
          total: steps.length,
          result: { ...result, failed: [...failed] },
        });

      publish();

      /** Ends the run before what isn't queued yet when there is a `reason`. */
      const halt = (reason: SeriesResult["stopped"]) => {
        if (!reason) return false;
        result.stopped = reason;
        result.unqueued = steps.length - done;

        return true;
      };

      try {
        for (const step of steps) {
          // Yield to navigation and Cancel remaining between admissions.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));

          if (halt(stopped ?? stands())) break;

          try {
            // A copy that is playing stays as it is, counted as changed meanwhile.
            if (step.was === "missing" && step.row && !(await beforeReplace(step.row))) {
              result.skipped++;
              done++;
              publish();
              continue;
            }

            if (halt(stopped ?? stands())) break;
            const outcome = await port.admit(plan.token, step.file.key, step.was);

            if (outcome === "stopped" || outcome === "login") {
              halt(outcome === "login" ? "login" : (stopped ?? "left"));
              break;
            }

            if (
              outcome !== "added" &&
              outcome !== "retried" &&
              outcome !== "replaced" &&
              outcome !== "skipped"
            )
              throw new Error("admission");
            result[outcome]++;
          } catch {
            failed.push(step.file);
          }

          done++;
          publish();
          await refresh();
        }
      } finally {
        if (runningOwner === owner) {
          runningOwner = undefined;
          seriesBusy.set(false);
        }

        active = false;

        try {
          await port.endReview(plan.token);
        } finally {
          publish();
        }
      }

      return { ...result, failed: [...failed] };
    },
  };
}

export type SeriesController = ReturnType<typeof seriesDownloads>;

/** What Details' bulk rows and dialogs use of Downloads: its rows, a run, and Replace. */
export interface SeriesOwner extends ReplaceOwner {
  readonly state: Store<DownloadState>;
  series(): SeriesController;
}

/** Downloads publishes itself here while it runs, so Library needn't start it. */
export const seriesOwner = store<SeriesOwner | undefined>(undefined);
