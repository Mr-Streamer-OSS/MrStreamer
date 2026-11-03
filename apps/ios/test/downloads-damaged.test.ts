import {
  memory,
  one,
  otherMovie,
  episode,
  until,
  installedApp,
  withProviders,
  movieRef,
  statusOf,
  isComplete,
  doc,
  folder,
  mediaFile,
  appGoes,
  type App,
} from "./downloads-harness.ts";
import type { Episode as SeriesEpisode, TitleRef } from "@mrstreamer/contracts/ondemand";
import { truncateSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Copies whose file is still there but no longer at its completed size. The app, its fake
// providers and the native models come from downloads-harness.ts. Same-size damage isn't looked for.

/** Cuts copy `id`'s file short, as a damaged one is: still there, at half its size. */
function truncate(id: string) {
  const media = mediaFile(id)!;
  truncateSync(media.path, Math.floor(media.size / 2));
}

/** Has the app look at its copies again, as it does each time it comes to the foreground. */
function foreground() {
  appGoes("background");
  appGoes("active");
}

async function seriesDetails(app: App, subscriptionId: string) {
  const lists = app.titleLists();
  if (lists.kind !== "ready") throw new Error("No titles");
  const version = { subscriptionId, id: String(episode().series.id) };
  const title = app.titleOf(lists.index, "series", version)!;
  const details = await app.detailsOf({ ...title, ...version });
  if (details.kind !== "series") throw new Error("Not a series");
  return { version, details };
}

/** An episode's ref as its row's download button queues it. */
const episodeOf = (each: SeriesEpisode): TitleRef => ({
  kind: "episode",
  subscriptionId: each.subscriptionId,
  id: each.id,
  seriesId: each.seriesId,
  season: each.season,
  episode: each.number,
});

describe("damaged downloads", { timeout: 40_000 }, () => {
  it("shows a copy whose file changed size as missing, won't play it, and replaces it whole", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const damaged = await app.addDownload(movieRef(a));
    const whole = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => isComplete(app, damaged.id) && isComplete(app, whole.id), "both copies");
    const size = mediaFile(damaged.id)!.size;
    truncate(damaged.id);
    foreground();
    expect(statusOf(app, damaged.id)?.kind).toBe("missing");
    expect(statusOf(app, whole.id)?.kind).toBe("complete");

    // Opened anyway, it fails as unavailable: no part of it plays, and nothing streams instead.
    const streams = one.streamRequests();
    app.playDownload(damaged.id);
    await until(() => app.playbackState.get().phase.kind === "failed", "the copy to fail");
    expect(memory.played).toEqual([]);
    expect(one.streamRequests()).toBe(streams);
    await app.stop();

    // The whole copy is kept as it is, and still plays.
    await expect(app.replaceMissingDownload(movieRef(a, otherMovie().id))).resolves.toEqual({
      kind: "kept",
    });
    expect(statusOf(app, whole.id)?.kind).toBe("complete");
    app.playDownload(whole.id);
    await until(() => memory.played.length === 1, "the whole copy to open");
    expect(memory.played[0]!.uri).toBe(mediaFile(whole.id)!.uri);
    await app.stop();

    // The damaged one goes, its file with it, and downloads again at its whole size.
    const replaced = await app.replaceMissingDownload(movieRef(a));
    if (replaced.kind !== "replaced") throw new Error(`Not replaced: ${replaced.kind}`);
    expect(statusOf(app, damaged.id)).toBeUndefined();
    expect(folder(damaged.id).exists).toBe(false);
    await until(() => isComplete(app, replaced.download.id), "the new copy", 20_000);
    expect(mediaFile(replaced.download.id)!.size).toBe(size);
    foreground();
    expect(statusOf(app, replaced.download.id)?.kind).toBe("complete");
  });

  it("replaces a damaged episode in a season run only once the copy playing stops", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { version, details } = await seriesDetails(app, a);
    const season = details.seasons[0]!;
    // Its second episode, an MP4 the player opens itself, alone in its season.
    const only = { ...details, seasons: [{ ...season, episodes: season.episodes.slice(1, 2) }] };
    const kept = await app.addDownload(episodeOf(season.episodes[1]!));
    await until(() => isComplete(app, kept.id), "the copy", 20_000);
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    truncate(kept.id);
    foreground();
    expect(statusOf(app, kept.id)?.kind).toBe("missing");

    const plan = app.planDownload(only, version, { kind: "season", season: season.number });
    expect(plan.missing).toHaveLength(1);
    const playing = app.startDownload(plan, { replace: true, stands: () => true })!;
    await until(() => app.seriesRun()?.phase === "done", "the run");
    expect(app.seriesRun()?.result.failed).toEqual([
      { ref: plan.missing[0], error: "Stop playing this copy first." },
    ]);
    // The reader keeps its file and its record while it plays.
    expect(statusOf(app, kept.id)?.kind).toBe("missing");
    expect(mediaFile(kept.id)?.exists).toBe(true);

    await app.playback.stop();
    app.startDownload(app.planRetry(playing)!, { replace: true, stands: () => true });
    await until(() => app.seriesRun()?.phase === "done", "the retry");
    expect(app.seriesRun()?.result).toMatchObject({ replaced: 1, failed: [] });
    expect(statusOf(app, kept.id)).toBeUndefined();
    expect(doc().items.some((item: { id: string }) => item.id === kept.id)).toBe(false);
    expect(app.downloadOf(plan.missing[0]!)?.status.kind).not.toBe("missing");
  });
});
