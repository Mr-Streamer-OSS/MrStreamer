// Messages between the main process and the catalogue worker. Every call names the account it
// is for, so an answer can never mix two subscriptions.
import type { AppError } from "@mrstreamer/contracts/errors";
import type { Title, TitleCategory, TitleKind, TitlePage } from "@mrstreamer/contracts/ondemand";
import type { PageQuery } from "@mrstreamer/core/ondemand/catalogue";
import type { XtreamAccount } from "../providers/xtream.ts";
import type { MetadataStatus } from "./metadata.ts";

/** What the worker needs once: where the caches live and how to introduce itself. */
export interface WorkerSetup {
  readonly cachePath: string;
  readonly metadataPath: string;
  readonly userAgent: string;
  /** TMDB's key, the region for streaming services and, in tests, another API; null fetches none. */
  readonly tmdb: { readonly key: string; readonly region: string; readonly api?: string } | null;
}

/** The loaded catalogue's size and age; null counts when nothing is loaded for the account. */
export interface WorkerStatus {
  readonly movies: number;
  readonly series: number;
  readonly fetchedAt: number | null;
}

/** Each call and what it answers. */
export interface WorkerCalls {
  status: { args: { key: string }; result: WorkerStatus };
  /** Fetches both lists from the provider and keeps them when they look complete. */
  refresh: { args: { key: string; account: XtreamAccount }; result: WorkerStatus };
  categories: {
    args: { key: string; language: string; kind: TitleKind };
    result: readonly TitleCategory[];
  };
  page: { args: { key: string; language: string; query: PageQuery }; result: TitlePage };
  byIds: {
    args: { key: string; language: string; kind: TitleKind; ids: readonly string[] };
    result: readonly Title[];
  };
  search: {
    args: { key: string; language: string; query: string };
    result: { readonly movies: readonly Title[]; readonly series: readonly Title[] };
  };
  /** The file type a movie streams as, or null when the catalogue doesn't have the movie. */
  container: { args: { key: string; id: string }; result: string | null };
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
