// The films and episodes an account marked by hand, as rules without storage: what a series is
// kept under, what a mark, its Undo and leaving Continue watching change, and where a marked series
// goes on. The viewing store keeps one row per marked movie, one per marked episode and one per
// marked series, and runs these on them when a change commits and when it rebuilds them from the
// events, so both add up to the same.
//
// A mark is kept apart from how far a file played. It names no file and no length, so it holds
// when the provider puts another file in the episode's place, and taking it back leaves the
// episode's own progress exactly as it was: while a mark stands, what a play begun before it
// still saves of that episode is left out (`accepted` in ./titles.ts). How a mark and a play
// stand against each other is in ./episodes.ts.
import type { Title } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import type { MarkedNext } from "@mrstreamer/contracts/viewing";
import { continuation } from "./episodes.ts";
import type {
  FilmMarkEvent,
  MarkEvent,
  SeriesListing,
  StoredFilmMark,
  StoredMark,
} from "./record.ts";
import type { RawProgress } from "./titles.ts";
import { defined } from "../defined.ts";

/** What a series is in one subscription, as the lists have it. */
export interface SeriesIdentity {
  /**
   * What a new mark of it is kept under in that subscription's record. Its TMDB id where the
   * lists gather its versions by one, so the marks hold for each of them and for a row the
   * provider lists it under anew. Else the provider's id of its one version. Never its name.
   */
  readonly key: string;
  /**
   * Everything marks that hold for it may be kept under: `key`, and the provider's id of each
   * version, which is what a mark was kept under while the lists had no TMDB id for the row. So
   * a row that gets a TMDB id keeps its marks, and the versions it joins share them. A mark kept
   * under a TMDB id holds for the series with that id and no other, as a saved title's does (see
   * ../ondemand/watchlist.ts): providers give the id of a row they dropped to another series.
   */
  readonly keys: readonly string[];
  /** The provider's ids of the versions of it that subscription lists. */
  readonly versions: readonly string[];
}

/**
 * What `series`, a version, is as `title` from the lists has it. A row for adults never joins
 * others by its TMDB id, and neither does a version the lists don't hold: each goes by its own id.
 */
export function seriesIdentity(series: OwnedId, title: Title | undefined): SeriesIdentity {
  const own = (title?.versions ?? []).flatMap(({ subscriptionId, id }) =>
    subscriptionId === series.subscriptionId ? [id] : [],
  );

  const tmdbId = title && !title.adult && own.includes(series.id) ? title.tmdbId : null;
  const versions = tmdbId ? own : [series.id];
  const key = tmdbId ? `tmdb:${tmdbId}` : `id:${series.id}`;

  return { key, keys: [...new Set([key, ...versions.map((id) => `id:${id}`)])], versions };
}

/**
 * What the latest mark of a series replaced, kept while that mark can still be taken back. The
 * marks it made are those numbered `revision`: one episode's, or a season's or series' at once.
 * One episode's keeps the shape builds before marks of several at once read and check, iOS and
 * Android snapshots among them; several at once add `priors`, which those builds ignore.
 */
export type MarkUndo = {
  /** The mark it takes back. */
  readonly revision: number;
  /** One episode's mark before it, or null when it had none, or when it marked several. */
  readonly prior: StoredMark | null;
  /** When it marked several: their marks before it. An episode that had none has none here. */
  readonly priors?: readonly StoredMark[];
  /** Whether the series was out of Continue watching then. */
  readonly hidden: boolean;
};

/** What an account keeps of the marks made under one key. */
export type SeriesMarks = {
  /** One per episode marked. */
  readonly marks: readonly StoredMark[];
  /** The versions of the series its subscription listed when it was last marked. */
  readonly versions: readonly string[];
  /** The episodes the version it was last marked in listed then. */
  readonly listing: SeriesListing;
  /** It left Continue watching since it was last marked, until it is marked again. */
  readonly hidden: boolean;
  /**
   * When it last left Continue watching: epoch milliseconds, or null when it never did. What a
   * play begun before then saves of its versions stays out of the row, as for a played series.
   */
  readonly leftAt: number | null;
  /** Null once the latest mark was taken back, or the series left Continue watching after it. */
  readonly undo: MarkUndo | null;
  /** The record's number of the last mark or Undo here: a later one has a higher number. */
  readonly changed: number;
};

export const noMarks: SeriesMarks = {
  marks: [],
  versions: [],
  listing: [],
  hidden: false,
  leftAt: null,
  undo: null,
  changed: 0,
};

/**
 * A series' marks after `event`, saved at `at` as the record's event numbered `sequence`. A mark
 * takes the place of each episode's mark before it, remembers those for its Undo, and shows the
 * series in Continue watching again. Its Undo puts back exactly what it replaced; one that names
 * another mark than the latest changes nothing. What the series lists, read anew, changes no
 * mark and no Undo.
 */
export function marked(
  state: SeriesMarks,
  event: MarkEvent,
  at: number,
  sequence: number,
): SeriesMarks {
  if (event.type === "series-listed") {
    return { ...state, versions: event.versions, listing: event.listing };
  }

  if (event.type === "episode-mark-undone") {
    const { undo } = state;

    if (undo?.revision !== event.revision) return state;

    const priors = undo.priors ?? (undo.prior ? [undo.prior] : []);

    return {
      ...state,
      marks: [...state.marks.filter((each) => each.revision !== undo.revision), ...priors],
      hidden: undo.hidden,
      undo: null,
      changed: sequence,
    };
  }

  const titles = event.type === "episode-marked" ? [event.title] : event.titles;
  const of = (mark: StoredMark) => titles.some((title) => sameEpisode(title, mark));
  const { watched, series } = event;

  return {
    ...state,
    marks: [
      ...state.marks.filter((each) => !of(each)),
      ...titles.map((title) => ({
        series,
        title,
        season: title.season,
        episode: title.episode,
        watched,
        at,
        revision: sequence,
      })),
    ],
    versions: event.versions,
    listing: event.listing,
    hidden: false,
    undo:
      event.type === "episode-marked"
        ? { revision: sequence, prior: state.marks.find(of) ?? null, hidden: state.hidden }
        : { revision: sequence, prior: null, priors: state.marks.filter(of), hidden: state.hidden },
    changed: sequence,
  };
}

/** Whether two name one episode, by its numbers. */
function sameEpisode(
  a: { readonly season: number; readonly episode: number },
  b: { readonly season: number; readonly episode: number },
): boolean {
  return a.season === b.season && a.episode === b.episode;
}

/**
 * A movie's mark after `event`, saved at `at` as the record's event numbered `sequence`, or null
 * once it has none. A mark takes the place of the one before it and remembers it for its Undo;
 * an Undo that names another mark than the movie's, or comes once it can't, changes nothing.
 */
export function filmMarked(
  mark: StoredFilmMark | null,
  event: FilmMarkEvent,
  at: number,
  sequence: number,
): StoredFilmMark | null {
  if (event.type === "movie-marked") {
    const { title, watched } = event;

    // The mark before, without what it replaced: an Undo takes back the latest mark alone.
    const prior = mark && {
      title: mark.title,
      watched: mark.watched,
      at: mark.at,
      revision: mark.revision,
    };

    return { title, watched, at, revision: sequence, undo: { prior } };
  }

  if (mark?.revision !== event.revision || !mark.undo) return mark;
  const { prior } = mark.undo;

  return prior && { ...prior, undo: null };
}

/**
 * Whether a movie's mark still says how it stands: no play of the movie began after it. The
 * row's progress, under it, says nothing while it does.
 */
export function stands(
  mark: Pick<StoredFilmMark, "at">,
  row: Pick<RawProgress, "since"> | undefined,
): boolean {
  return !row || row.since <= mark.at;
}

/** How a movie stands, as an episode does (`EpisodeState` in ./episodes.ts): by its mark or play. */
export function filmState(
  mark: StoredFilmMark | undefined,
  row: RawProgress | undefined,
): "watched" | "partial" | "unwatched" {
  if (mark && stands(mark, row)) return mark.watched ? "watched" : "unwatched";

  if (row?.finished) return "watched";

  return row && row.position > 0 ? "partial" : "unwatched";
}

/** A series' marks once it left Continue watching at `at`: out of it too, and its marks stay. */
export function left(state: SeriesMarks, at: number): SeriesMarks {
  return { ...state, hidden: true, leftAt: at, undo: null };
}

/** The mark made last of those kept under one key. */
export function leading(state: SeriesMarks): StoredMark | undefined {
  return state.marks.toSorted((a, b) => b.revision - a.revision)[0];
}

/**
 * The marks that hold for a series, from what is kept under each of its keys: one per episode,
 * the latest where two keys hold one of the same episode. In the order they were made.
 */
export function standing(kept: readonly SeriesMarks[]): StoredMark[] {
  const latest = new Map<string, StoredMark>();

  for (const mark of kept.flatMap((each) => each.marks)) {
    const key = `${mark.season}:${mark.episode}`;

    if ((latest.get(key)?.revision ?? -Infinity) < mark.revision) latest.set(key, mark);
  }

  return [...latest.values()].toSorted((a, b) => a.revision - b.revision);
}

/**
 * The mark of a series that can still be taken back, from what is kept under each of its keys:
 * the one made last, while nothing was marked or taken back after it, the series didn't leave
 * Continue watching, and no play of any of its versions began after it.
 */
export function undoable(
  kept: readonly SeriesMarks[],
  played: readonly RawProgress[],
): StoredMark | null {
  const last = kept.toSorted((a, b) => b.changed - a.changed)[0];
  const mark = last?.marks.find((each) => each.revision === last.undo?.revision);

  return mark && !played.some((entry) => entry.since > mark.at) ? mark : null;
}

/**
 * Where a marked series goes on as its record stands, among the episodes it listed when it was
 * last marked. Null once every numbered one of them is watched, or when it listed none.
 */
export function goesOn(
  listing: SeriesListing,
  played: readonly RawProgress[],
  marks: readonly StoredMark[],
): MarkedNext | null {
  const seasons = listing.map(({ number, episodes }) => ({
    number,
    episodes: episodes.map((episode) => ({ season: number, number: episode })),
  }));

  const files = listing.some((season) => season.files !== undefined)
    ? new Set(listing.flatMap((season) => season.files ?? []))
    : null;

  // Exact playlist files also identify a source-ordered listing, including specials in place.
  const found = continuation(
    { seasons, ...defined({ episodeOrder: files ? ("source" as const) : undefined }) },
    files ? played.filter((entry) => files.has(entry.title.id)) : played,
    marks,
  );

  if (!found || found.replay) return null;
  const { episode, resume } = found;

  return {
    season: episode.season,
    episode: episode.number,
    resume: resume ? { position: resume.position, duration: resume.duration } : null,
  };
}

/** The latest film mark that stands against every play in its subscription-scoped versions. */
export function standingFilmMark<Mark extends { readonly at: number }>(
  marks: readonly Mark[],
  played: readonly Pick<RawProgress, "since">[],
): Mark | null {
  const mark = marks.toSorted((a, b) => b.at - a.at)[0];

  return mark && played.every((row) => stands(mark, row)) ? mark : null;
}
