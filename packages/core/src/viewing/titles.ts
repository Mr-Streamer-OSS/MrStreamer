// How far movies and episodes got, as rules without storage: which checkpoints count, what one
// changes, when a title counts as finished, and what Continue watching shows. The viewing store
// keeps one row per title and account and runs these on it, when a change commits and when it
// rebuilds the rows from the events.
import { titleKey, type RawTitleRef } from "@mrstreamer/contracts/ondemand";
import { CONTINUE_OFFERED, type TitleProgress } from "@mrstreamer/contracts/viewing";

/** A title counts as started, and shows in Continue watching, after this many seconds. */
export const STARTED_SECONDS = 120;

/** The share at the end that counts as the credits: watching into it finishes the title. */
const CREDITS_SHARE = 0.05;
/** Short titles still leave this much at the end. */
const MIN_CREDITS_SECONDS = 30;

/**
 * How far a movie or an episode got in one account, by the provider's own ids. The service makes
 * a `TitleProgress` of it by saying which subscription's.
 */
export interface RawProgress extends Omit<TitleProgress, "title"> {
  readonly title: RawTitleRef;
}

/** What the store keeps per title and account. */
export interface TitleRow extends RawProgress {
  /** Taken out of Continue watching, until a play begun after `removedAt`. */
  readonly hidden: boolean;
  /**
   * When the movie, or the episode's series, last left Continue watching: epoch milliseconds. Null
   * when it never did, or when a build without it wrote the row.
   */
  readonly removedAt: number | null;
}

/** Whether a position is in the credits, or past the end. */
export function isFinished(position: number, duration: number): boolean {
  const credits = Math.max(duration * CREDITS_SHARE, MIN_CREDITS_SECONDS);
  return duration > 0 && position >= duration - credits;
}

/**
 * Whether a checkpoint saved at `at`, from a play that began at `since`, counts for its title.
 * One of a play older than the play `row` holds doesn't, however late it arrives: what the viewer
 * played last stays. Neither does one of a play begun no later than `markedAt`, when the episode
 * was last marked by hand: the row keeps what it held when the mark was made, so taking the mark
 * back finds exactly that. A checkpoint that doesn't count changes nothing.
 *
 * A row saved later than `at` was saved by a clock that has been set back since. Which play is
 * the older one can't be told then, so the checkpoint counts, and the row goes by this clock
 * from there on rather than refusing every play until the old time comes round again.
 */
export function accepted(
  row: Pick<TitleRow, "since" | "at"> | undefined,
  { since, at }: { readonly since: number; readonly at: number },
  markedAt: number | null,
): boolean {
  const older = row !== undefined && since < row.since && at >= row.at;
  return !older && !(markedAt !== null && since <= markedAt);
}

/**
 * The row after a checkpoint at `position`, from a play that began at `since`. `removedAt` is when
 * the movie, or the episode's series, last left Continue watching. A play begun after that shows
 * it again; the checkpoints of one already going then, as every minute while it plays, leave it out.
 */
export function progressed(
  checkpoint: {
    readonly title: RawTitleRef;
    readonly position: number;
    readonly duration: number;
    readonly since: number;
  },
  at: number,
  removedAt: number | null,
): TitleRow {
  const { title, position, duration, since } = checkpoint;
  return {
    title,
    position: Math.max(0, Math.min(position, duration)),
    duration,
    finished: isFinished(position, duration),
    at,
    since,
    hidden: removedAt !== null && since <= removedAt,
    removedAt,
  };
}

/** What taking `title` out of Continue watching applies to: the movie, or the episode's series. */
export function removalScope(title: RawTitleRef): string {
  return title.kind === "movie" ? titleKey(title) : `series:${title.seriesId}`;
}

/**
 * The keys of the rows that removing `title` from Continue watching hides: the movie, or every
 * episode of the series, so the series goes as a whole.
 */
export function removedKeys(title: RawTitleRef, rows: readonly TitleRow[]): string[] {
  if (title.kind === "movie") return [titleKey(title)];
  return rows
    .filter((row) => row.title.kind === "episode" && row.title.seriesId === title.seriesId)
    .map((row) => titleKey(row.title));
}

/**
 * Continue watching from an account's rows: movies started and not finished, and for each series
 * the episode played last, finished or not, so its next one can be offered. Hidden rows stay out.
 * Most recent first, at most `CONTINUE_OFFERED`.
 */
export function continueWatching(rows: readonly TitleRow[]): RawProgress[] {
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
    .slice(0, CONTINUE_OFFERED)
    .map(({ hidden: _hidden, removedAt: _removedAt, ...progress }) => progress);
}
