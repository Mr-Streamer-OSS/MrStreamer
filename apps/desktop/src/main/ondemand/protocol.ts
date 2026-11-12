import { type, type Type } from "arktype";
import { isCollectionId } from "@mrstreamer/contracts/ondemand";
// Messages between the main process and the catalogue worker. A call about one subscription's
// lists names that subscription; a call for what the lists show names every subscription whose
// lists count, in their order, so an answer never holds what a subscription that went left
// behind. Every title and version in an answer says which subscription lists it.
import type { AppError } from "@mrstreamer/contracts/errors";
import type {
  CollectionId,
  CollectionPage,
  CollectionRow,
  CollectionSort,
  CollectionTile,
  RowTab,
  RelatedTitles,
  HomeRecommendation,
  HomeSeed,
  Title,
  TitleKind,
  TitleMatches,
} from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import type { FilterOptions, TitleFilters } from "@mrstreamer/contracts/title-filters";
import type { WatchlistPage, WatchlistSort } from "@mrstreamer/contracts/watchlist";
import type { SavedMember, SavedTitle, TitleFacts } from "@mrstreamer/core/ondemand/watchlist";
import type { ActiveLanguage } from "@mrstreamer/core/i18n";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import type { ProviderAccount } from "../providers/account.ts";
import type { MetadataStatus } from "./metadata.ts";

/** What the worker needs once: where TMDB's metadata lives and how to introduce itself. */
export interface WorkerSetup {
  readonly metadataPath: string;
  readonly userAgent: string;
  /** TMDB's key, the region for streaming services and, in tests, another API; null fetches none. */
  readonly tmdb: { readonly key: string; readonly region: string; readonly api?: string } | null;
}

/** Whose lists a call is about. */
export interface CatalogueOwner {
  /** The subscription's id: what its titles and versions carry. */
  readonly subscriptionId: string;
  /** The account its lists are kept on disk for. */
  readonly key: string;
  /** The subscription's folder, where its lists are kept. */
  readonly dir: string;
  readonly importRevision?: string;
  /** Main's captured policy, for this read only. Absent keeps household catalogues unrestricted. */
  readonly approved?: { readonly movies: readonly string[]; readonly series: readonly string[] };
}

/** The subscriptions whose lists make the catalogue a call asks about, in their order. */
interface Owners {
  readonly owners: readonly CatalogueOwner[];
}

/** Main validates current episode details; the worker validates movie rows against its lists. */
export interface KnownFile {
  readonly subscriptionId: string;
  readonly kind: "movie" | "episode";
  readonly id: string;
  readonly seriesId?: string;
  /** Exact episode numbers from the current loaded listing, for admitted manual marks. */
  readonly season?: number;
  readonly episode?: number;
  readonly listingKey: string;
  readonly runtime?: number | null;
  readonly tracks?: {
    readonly audio: readonly (string | null)[];
    readonly subtitles: readonly (string | null)[];
  };
  readonly tags?: readonly string[];
}

/** This profile's progress on one exact movie version or episode file, by its owned key. */
export interface WatchedFile {
  readonly key: string;
  readonly state: "watched" | "in-progress";
}

interface FilterQuery {
  readonly filters?: TitleFilters;
  readonly watched?: readonly WatchedFile[];
  readonly files?: readonly KnownFile[];
}

/** A subscription's loaded lists: their size and age; null counts when nothing is loaded for it. */
export interface WorkerStatus {
  readonly movies: number;
  readonly series: number;
  readonly fetchedAt: number | null;
  /** Private accepted-catalogue identity. Absent on legacy snapshots. */
  readonly catalogueStamp?: string;
  readonly importRevision?: string;
}

/** Which page of the watchlist, in which order. */
export interface SavedQuery {
  readonly home?: boolean;
  /** Everything the subscriptions saved: the lists say which to show, and in what order. */
  readonly members: readonly SavedMember[];
  readonly sort: WatchlistSort;
  readonly offset: number;
  readonly limit: number;
}

/** Each call and what it answers. */
export interface WorkerCalls {
  /**
   * Each owner's lists, in the order asked. Also says whether the viewer shows titles for adults,
   * which TMDB is asked about only then.
   */
  status: { args: Owners & { adults: boolean }; result: readonly WorkerStatus[] };
  /**
   * Fetches a subscription's two lists from its provider and, when they look complete, sets them
   * aside for `finishRefresh`: nothing shows or is saved yet. `revision` is the login's:
   * a newer fetch replaces an older one; a fetch older than active or pending work is rejected.
   */
  refresh: {
    args: CatalogueOwner & {
      revision: number;
      account: ProviderAccount;
      catalogue?: OnDemandCatalogue;
    };
    result: null;
  };
  /**
   * Ends the refresh under that login. With `keep`, the lists it set aside become the
   * subscription's and are saved; without, they are dropped and the lists from before stay. Only
   * the main process knows whether the login still stands, so it says.
   */
  finishRefresh: {
    args: CatalogueOwner & { revision: number; keep: boolean };
    /** Marked when the lists kept mark for adults a title the ones before listed without. */
    result: WorkerStatus & { readonly markedForAdults?: true };
  };
  /** Titles by any of their versions, each named with the subscription that lists it. */
  byIds: {
    args: Owners & {
      language: string;
      kind: TitleKind;
      versions: readonly OwnedId[];
      files?: readonly KnownFile[];
    };
    result: readonly Title[];
  };
  search: {
    args: Owners & { language: string; query: string };
    result: { readonly movies: readonly Title[]; readonly series: readonly Title[] };
  };
  /** Movies or series matching `query`, the best `limit` of them, and how many match. */
  searchKind: {
    args: Owners &
      FilterQuery & { language: string; kind: TitleKind; query: string; limit: number };
    result: TitleMatches;
  };
  filterOptions: {
    args: Owners & {
      language: string;
      kind: TitleKind;
      files: readonly KnownFile[];
      adults: boolean;
    };
    result: FilterOptions;
  };
  /** A tab's rows; For you starts with titles like `like`, a version of one watched lately. */
  rows: {
    args: Owners & { language: string; kind: TitleKind; tab: RowTab; like?: OwnedId };
    result: readonly CollectionRow[];
  };
  /** Related uses only loaded lists and metadata already known for the opened version. */
  related: {
    args: Owners & {
      language: string;
      kind: TitleKind;
      version: OwnedId;
      metadata?: { readonly genres: readonly string[]; readonly language: string | null };
    };
    result: RelatedTitles;
  };
  /** A person's or franchise's titles in the lists, by kind and TMDB id, in the order asked. */
  linked: {
    args: Owners & {
      language: string;
      titles: readonly { readonly kind: TitleKind; readonly tmdbId: string }[];
    };
    result: readonly Title[];
  };
  recommendations: {
    args: Owners & { language: string; seeds: readonly HomeSeed[] };
    result: readonly HomeRecommendation[];
  };
  /** Genres or streaming services as tiles. */
  tiles: {
    args: Owners & { language: string; kind: TitleKind; of: "genres" | "services" };
    result: readonly CollectionTile[];
  };
  /** One page of a collection. */
  collection: {
    args: Owners &
      FilterQuery & {
        language: string;
        kind: TitleKind;
        id: CollectionId;
        sort?: CollectionSort;
        offset: number;
        limit: number;
      };
    result: CollectionPage;
  };
  /**
   * A page of the watchlist: what the subscriptions saved as the entries it makes, each with the
   * title it is in the lists now, found by the indexes the catalogue keeps. Titles for adults
   * show only with `adults`, and count only then.
   */
  saved: {
    args: Owners & SavedQuery & { language: string; adults: boolean };
    result: WatchlistPage;
  };
  /**
   * What the lists say now about the titles `entries`, saved by `subscriptionId`, are: each once,
   * as that subscription lists it, for its record to take over. Titles it lists no more are left
   * out. Null when none of its lists are loaded.
   */
  savedFacts: {
    args: Owners & { language: string; subscriptionId: string; entries: readonly SavedTitle[] };
    result: readonly TitleFacts[] | null;
  };
  /** The file type a movie streams as, or null when its subscription's lists don't have it. */
  container: {
    args: CatalogueOwner & { id: string };
    result: { container: string; listingKey: string } | null;
  };
  /** Forgets a subscription's lists and removes their cache, for when the subscription goes. */
  forget: { args: CatalogueOwner; result: null };
  /** Stops metadata requests and writes pending lists and completed answers for shutdown. */
  flush: { args: Record<string, never>; result: null };
}

export type WorkerMethod = keyof WorkerCalls;

export type WorkerRequest = {
  [M in WorkerMethod]: {
    readonly id: number;
    readonly method: M;
    readonly args: WorkerCalls[M]["args"];
    /** The interface language at the call, which names such as "New this week" are written in. */
    readonly interfaceLanguage: ActiveLanguage;
  };
}[WorkerMethod];

export type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: AppError };

/**
 * What the worker says unasked: more metadata arrived, or TMDB refused the key. `content` says
 * that what lists show changed; without it only the status did.
 */
export interface WorkerEvent {
  readonly event: "metadata";
  readonly content: boolean;
  readonly status: MetadataStatus;
}

/** Validates a reply against the result owned by the method that was called. */
const Status = type({
  movies: "number",
  series: "number",
  fetchedAt: "number | null",
  "catalogueStamp?": "string",
  "importRevision?": "string",
});

const Version = type({
  subscriptionId: "string",
  id: "string",
  tags: "string[]",
  "name?": "string",
  "container?": "string | null",
  "addedAt?": "number | null",
  "listedOrder?": "number",
  "year?": "number | null",
  "rating?": "number | null",
  "observed?": { files: "number", audio: "(string | null)[]", subtitles: "(string | null)[]" },
  "episodeFiles?": "string[]",
});

const ListedTitle = type({
  kind: "'movie' | 'series'",
  key: "string",
  subscriptionId: "string",
  id: "string",
  name: "string",
  title: "string",
  originalTitle: "string | null",
  originalLanguage: "string | null",
  tags: "string[]",
  year: "number | null",
  posterUrl: "string | null",
  backdropUrl: "string | null",
  rating: "number | null",
  addedAt: "number | null",
  adult: "boolean",
  tmdbId: "string | null",
  genres: "string[]",
  versions: Version.array(),
  "ambiguous?": "true",
});

const Page = type({ total: "number", titles: ListedTitle.array(), "unfiltered?": "number" });

const Collection = type("string").narrow((value): value is CollectionId => isCollectionId(value));

export const workerResults: { [M in WorkerMethod]: Type<WorkerCalls[M]["result"]> } = {
  status: Status.array(),
  refresh: type("null"),
  finishRefresh: Status.and({ "markedForAdults?": "true" }),
  byIds: ListedTitle.array(),
  search: type({ movies: ListedTitle.array(), series: ListedTitle.array() }),
  searchKind: Page,
  filterOptions: type({
    qualities: "('4k' | 'full-hd' | 'hd' | 'sd' | 'unknown')[]",
    languages: "string[]",
    verified: type({ kind: "'audio' | 'subtitles'", language: "string" }).array(),
    files: "number",
  }),
  rows: type({
    id: Collection,
    name: "string",
    total: "number",
    titles: ListedTitle.array(),
  }).array(),
  related: type({
    basis: "string | null",
    titles: type({ title: ListedTitle, reason: "string" }).array(),
  }),
  linked: ListedTitle.array(),
  recommendations: type({ title: ListedTitle, seed: "string", reason: "string" }).array(),
  tiles: type({
    id: Collection,
    name: "string",
    count: "number",
    artworkUrl: "string | null",
  }).array(),
  collection: Page.and({ name: "string" }),
  saved: type({
    total: "number",
    entries: type({
      subscriptionId: "string",
      id: "string",
      kind: "'movie' | 'series'",
      name: "string",
      year: "number | null",
      savedAt: "number",
      title: ListedTitle.or("null"),
      artworkUrl: "string | null",
      sources: "string[]",
      listed: "boolean",
    }).array(),
  }),
  savedFacts: type({
    kind: "'movie' | 'series'",
    tmdbId: "string | null",
    versionIds: "string[]",
    name: "string",
    year: "number | null",
    adult: "boolean",
  })
    .array()
    .or("null"),
  container: type({ container: "string", listingKey: "string" }).or("null"),
  forget: type("null"),
  flush: type("null"),
};
