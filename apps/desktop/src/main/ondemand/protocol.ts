// Messages between the main process and the catalogue worker. Every call names the subscription
// it is for, so an answer can never mix two, and every title in an answer names it too.
import type { AppError } from "@mrstreamer/contracts/errors";
import type {
  CollectionId,
  CollectionPage,
  CollectionRow,
  CollectionSort,
  CollectionTile,
  RowTab,
  Title,
  TitleKind,
  TitleMatches,
} from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import type { ProviderAccount } from "../providers/account.ts";
import type { MetadataStatus } from "./metadata.ts";

/** What the worker needs once: where the caches live and how to introduce itself. */
export interface WorkerSetup {
  readonly cachePath: string;
  readonly metadataPath: string;
  readonly userAgent: string;
  /** TMDB's key, the region for streaming services and, in tests, another API; null fetches none. */
  readonly tmdb: { readonly key: string; readonly region: string; readonly api?: string } | null;
}

/** Whose catalogue a call is about. */
export interface CatalogueOwner {
  /** The subscription's id: what its titles and versions carry. */
  readonly subscriptionId: string;
  /** The account its lists are kept on disk for. */
  readonly key: string;
}

/** The loaded catalogue's size and age; null counts when nothing is loaded for the account. */
export interface WorkerStatus {
  readonly movies: number;
  readonly series: number;
  readonly fetchedAt: number | null;
}

/** Each call and what it answers. */
export interface WorkerCalls {
  /** Also says whether the viewer shows titles for adults, which TMDB is asked about only then. */
  status: { args: CatalogueOwner & { adults: boolean }; result: WorkerStatus };
  /**
   * Fetches both lists from the provider and, when they look complete, sets them aside for
   * `finishRefresh`: nothing shows or is saved yet. `revision` is the login's: a fetch under
   * another one is given up for this one.
   */
  refresh: {
    args: CatalogueOwner & { revision: number; account: ProviderAccount };
    result: null;
  };
  /**
   * Ends the refresh under that login. With `keep`, the lists it set aside become the
   * subscription's and are saved; without, they are dropped and the lists from before stay. Only
   * the main process knows whether the login still stands, so it says.
   */
  finishRefresh: {
    args: CatalogueOwner & { revision: number; keep: boolean };
    result: WorkerStatus;
  };
  /** Titles by the ids of their versions, as the subscription's provider gives them. */
  byIds: {
    args: CatalogueOwner & { language: string; kind: TitleKind; ids: readonly string[] };
    result: readonly Title[];
  };
  search: {
    args: CatalogueOwner & { language: string; query: string };
    result: { readonly movies: readonly Title[]; readonly series: readonly Title[] };
  };
  /** Movies or series matching `query`, the best `limit` of them, and how many match. */
  searchKind: {
    args: CatalogueOwner & { language: string; kind: TitleKind; query: string; limit: number };
    result: TitleMatches;
  };
  /** A tab's rows; For you starts with titles like `like`, a version of one watched lately. */
  rows: {
    args: CatalogueOwner & { language: string; kind: TitleKind; tab: RowTab; like?: OwnedId };
    result: readonly CollectionRow[];
  };
  /** Genres or streaming services as tiles. */
  tiles: {
    args: CatalogueOwner & { language: string; kind: TitleKind; of: "genres" | "services" };
    result: readonly CollectionTile[];
  };
  /** One page of a collection. */
  collection: {
    args: CatalogueOwner & {
      language: string;
      kind: TitleKind;
      id: CollectionId;
      sort?: CollectionSort;
      offset: number;
      limit: number;
    };
    result: CollectionPage;
  };
  /** The file type a movie streams as, or null when the catalogue doesn't have the movie. */
  container: { args: CatalogueOwner & { id: string }; result: string | null };
  /** Forgets the catalogue and removes the cache, for when the subscription changes or goes. */
  clear: { args: Record<string, never>; result: null };
  /** Answers once the cache write in progress is done, so stopping the worker keeps it. */
  flush: { args: Record<string, never>; result: null };
}

export type WorkerMethod = keyof WorkerCalls;

export type WorkerRequest = {
  [M in WorkerMethod]: {
    readonly id: number;
    readonly method: M;
    readonly args: WorkerCalls[M]["args"];
  };
}[WorkerMethod];

export type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: AppError };

/** What the worker says unasked: more metadata arrived, or TMDB refused the key. */
export interface WorkerEvent {
  readonly event: "metadata";
  readonly status: MetadataStatus;
}
