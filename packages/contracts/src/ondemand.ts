// Movies and series as the UI sees them, independent of the provider that supplied them.
import { type } from "arktype";
import type { AppError } from "./errors.ts";

export const TITLE_KINDS = ["movie", "series"] as const;
export type TitleKind = (typeof TITLE_KINDS)[number];

/**
 * A movie or a series in a catalogue list. Series and movies share it, so lists show both alike.
 * Providers list each language version on its own; a title gathers them, and shows and plays the
 * one that suits the viewer's language.
 */
export interface Title {
  readonly kind: TitleKind;
  /** The version shown and played first. Stable within one subscription and language. */
  readonly id: string;
  /** The provider's name of that version, for search: "Blow 2001 (NL)". */
  readonly name: string;
  /** The name to show: "Blow". */
  readonly title: string;
  /** Markers from the name: language ("NL", "MULTI") and quality ("4K"). */
  readonly tags: readonly string[];
  readonly year: number | null;
  /** Portrait artwork. */
  readonly posterUrl: string | null;
  /** Landscape artwork, when the list has it. Movies get theirs with the details. */
  readonly backdropUrl: string | null;
  /** Out of 10, or null when the provider has none. */
  readonly rating: number | null;
  /** When the provider added the movie, or last changed the series: epoch milliseconds. */
  readonly addedAt: number | null;
  /** The provider marks it, or its category, as for adults. */
  readonly adult: boolean;
  /** The Movie Database's id, which the language versions of one film share. */
  readonly tmdbId: string | null;
  /** From TMDB, once its metadata arrived: "Comedy", "Drama". */
  readonly genres: readonly string[];
  /** Every version, the one shown first in front. */
  readonly versions: readonly TitleVersion[];
}

/** One version of a title as the provider lists it, often one per language. */
export interface TitleVersion {
  readonly id: string;
  /** Markers from its name: "NL", "MULTI", "4K". */
  readonly tags: readonly string[];
}

interface DetailsBase {
  readonly title: Title;
  readonly originalTitle: string | null;
  readonly plot: string | null;
  readonly genres: readonly string[];
  readonly cast: readonly string[];
  readonly directors: readonly string[];
  /** "1981-05-23", as the provider wrote it. */
  readonly releaseDate: string | null;
  /** Seconds. For a series, the usual length of an episode. */
  readonly duration: number | null;
  readonly backdropUrl: string | null;
}

export interface MovieDetails extends DetailsBase {
  readonly kind: "movie";
}

export interface SeriesDetails extends DetailsBase {
  readonly kind: "series";
  /** In order, each with its episodes in order. Seasons without episodes are left out. */
  readonly seasons: readonly Season[];
}

export type TitleDetails = MovieDetails | SeriesDetails;

export interface Season {
  readonly number: number;
  /** "Season 2", or the provider's own name for it. */
  readonly name: string;
  readonly posterUrl: string | null;
  readonly episodes: readonly Episode[];
}

export interface Episode {
  readonly id: string;
  readonly seriesId: string;
  readonly season: number;
  readonly number: number;
  /** The episode's own name, without the series and numbers the provider puts in front. */
  readonly title: string;
  readonly plot: string | null;
  /** Seconds. */
  readonly duration: number | null;
  readonly stillUrl: string | null;
  readonly airDate: string | null;
}

/** When the movie and series lists were last fetched, and how big they are. */
export interface OnDemandStatus {
  readonly movies: number;
  readonly series: number;
  /** Epoch milliseconds, or null before the first successful fetch. */
  readonly fetchedAt: number | null;
  /** Why the latest refresh failed, when it did. The lists from `fetchedAt` stay in use. */
  readonly failure: AppError | null;
  /** How far TMDB's metadata has come; null without a key. */
  readonly metadata: MetadataProgress | null;
}

/** TMDB's metadata for the catalogue: genres, languages, services. */
export interface MetadataProgress {
  /** Titles with metadata, of those listed with a TMDB id. */
  readonly known: number;
  readonly wanted: number;
  /** TMDB refused the key; nothing more arrives until it changes. */
  readonly refused: boolean;
}

/** One page of a list, and how long the whole list is. */
export interface TitlePage {
  readonly total: number;
  readonly titles: readonly Title[];
}

/**
 * A collection Movies and Series show: everything, what's new, popular or top rated, a genre, a
 * streaming service, or titles like one the viewer watched.
 */
export type CollectionId =
  | "all"
  | "new-week"
  | "new-month"
  | "recent"
  | "popular"
  | "top-rated"
  | "4k"
  | `genre:${string}`
  | `service:${number}`
  | `like:${string}`;

/** Whether text names a collection: what the UI sends is checked before it is used. */
export function isCollectionId(text: string): text is CollectionId {
  return /^(all|new-week|new-month|recent|popular|top-rated|4k|genre:.+|service:\d+|like:.+)$/.test(
    text,
  );
}

/** How a collection's page is ordered. */
export const COLLECTION_SORTS = ["added", "popular", "rating", "title"] as const;
export type CollectionSort = (typeof COLLECTION_SORTS)[number];

/** The tabs of rows: For you, and New. */
export const ROW_TABS = ["for-you", "new"] as const;
export type RowTab = (typeof ROW_TABS)[number];

/** One row of a tab: a collection's first titles, and how many it has. */
export interface CollectionRow {
  readonly id: CollectionId;
  readonly name: string;
  readonly total: number;
  readonly titles: readonly Title[];
}

/** A genre or streaming service as a tile, with a picture from its most popular title. */
export interface CollectionTile {
  readonly id: CollectionId;
  readonly name: string;
  readonly count: number;
  readonly artworkUrl: string | null;
}

/** One page of a collection, with its name. */
export interface CollectionPage extends TitlePage {
  readonly name: string;
}

/** Something that plays on demand: a movie, or one episode of a series. */
export const TitleRef = type({ kind: "'movie'", id: "string > 0" }, "|", {
  kind: "'episode'",
  id: "string > 0",
  seriesId: "string > 0",
  season: "number.integer >= 0",
  episode: "number.integer >= 0",
});
export type TitleRef = typeof TitleRef.infer;

/** "movie:123" or "episode:456": one key per thing that plays, within a subscription. */
export function titleKey(ref: TitleRef): string {
  return `${ref.kind}:${ref.id}`;
}
