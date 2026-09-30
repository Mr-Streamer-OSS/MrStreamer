// How far movies and episodes got, as rules without storage: what a checkpoint changes, when a
// title counts as finished, and what Continue watching shows. The viewing store keeps one row per
// title and account and runs these on it.
import { titleKey, type TitleRef } from "@mrstreamer/contracts/ondemand";
import { CONTINUE_LIMIT, type TitleProgress } from "@mrstreamer/contracts/viewing";

/** A title counts as started, and shows in Continue watching, after this many seconds. */
export const STARTED_SECONDS = 120;

/** The share at the end that counts as the credits: watching into it finishes the title. */
const CREDITS_SHARE = 0.05;
/** Short titles still leave this much at the end. */
const MIN_CREDITS_SECONDS = 30;

/** What the store keeps per title and account. */
export interface TitleRow extends TitleProgress {
  /** Taken out of Continue watching; playing it again brings it back. */
  readonly hidden: boolean;
}

/** Whether a position is in the credits, or past the end. */
export function isFinished(position: number, duration: number): boolean {
  const credits = Math.max(duration * CREDITS_SHARE, MIN_CREDITS_SECONDS);
  return duration > 0 && position >= duration - credits;
}

/** The row after a checkpoint at `position`. Playing a title again shows it again. */
export function progressed(
  title: TitleRef,
  position: number,
  duration: number,
  at: number,
): TitleRow {
  return {
    title,
    position: Math.max(0, Math.min(position, duration)),
    duration,
    finished: isFinished(position, duration),
    at,
    hidden: false,
  };
}

/**
 * The keys of the rows that removing `title` from Continue watching hides: the movie, or every
 * episode of the series, so the series goes as a whole.
 */
export function removedKeys(title: TitleRef, rows: readonly TitleRow[]): string[] {
  if (title.kind === "movie") return [titleKey(title)];
  return rows
    .filter((row) => row.title.kind === "episode" && row.title.seriesId === title.seriesId)
    .map((row) => titleKey(row.title));
}

/**
 * Continue watching from an account's rows: movies started and not finished, and for each series
 * the episode played last, finished or not, so its next one can be offered. Hidden rows stay out.
 * Most recent first.
 */
export function continueWatching(rows: readonly TitleRow[]): TitleProgress[] {
  const latestPerSeries = new Map<string, TitleRow>();
  /** Series with an episode watched past its start, so a few seconds of a pilot don't count. */
  const started = new Set<string>();
  const movies: TitleRow[] = [];
  for (const row of rows) {
    if (row.title.kind === "movie") {
      if (!row.hidden && !row.finished && row.position >= STARTED_SECONDS) movies.push(row);
      continue;
    }
    const { seriesId } = row.title;
    if (row.finished || row.position >= STARTED_SECONDS) started.add(seriesId);
    const latest = latestPerSeries.get(seriesId);
    if (!latest || row.at > latest.at) latestPerSeries.set(seriesId, row);
  }
  const series = [...latestPerSeries.values()].filter(
    (row) => !row.hidden && row.title.kind === "episode" && started.has(row.title.seriesId),
  );
  return [...movies, ...series]
    .sort((a, b) => b.at - a.at)
    .slice(0, CONTINUE_LIMIT)
    .map(({ hidden: _hidden, ...progress }) => progress);
}
