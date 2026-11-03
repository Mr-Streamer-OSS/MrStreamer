import { requireNativeModule } from "expo";
import type { Programme } from "@mrstreamer/contracts/guide";
import { nextProviderRedirect, type GuideRequest } from "@mrstreamer/core/provider";

/** What no saved programme may hold: a source's login, and values that may be one. */
export interface SourceLogin {
  readonly login: readonly string[];
  readonly uncertain?: readonly string[];
}

/** Fixed codes only. Native errors, URLs, headers and Location never enter public state. */
export type GuideProblem =
  | "login"
  | "http"
  | "network"
  | "redirect"
  | "xml"
  | "gzip"
  | "empty"
  | "ended"
  | "body"
  | "element"
  | "depth"
  | "rows"
  | "time"
  | "disk"
  | "reply"
  | "unavailable"
  | "busy";

export interface Generation {
  readonly id: string;
  readonly fetchedAt: number;
  readonly until: number;
}

export interface Activation {
  readonly lease: string;
  readonly generation: Generation | null;
}

export type Result<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failed"; readonly error: GuideProblem }
  | { readonly kind: "changed" | "cancelled" };

export interface Query {
  readonly guideId: string | null;
  readonly rows: readonly Programme[];
  readonly more: boolean;
}

/** A programme `search` found, by the guide id of the channel it is on. */
export interface Match {
  readonly guideId: string;
  readonly start: number;
  readonly stop: number;
  readonly title: string;
}

type Prepared =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "candidate"; readonly id: string };

/** Private Expo port. Ingest bytes and rows never cross this boundary. */
export interface GuideNative {
  /**
   * Activates `ids` and erases every other saved guide, but those whose id starts with one of
   * `kept`: they stay on disk, unread, for a later restore to name or erase.
   */
  restore(
    ids: readonly string[],
    kept: readonly string[],
  ): Promise<readonly { readonly subscriptionId: string; readonly activation: Activation }[]>;
  attach(id: string, revision: number): Promise<Activation>;
  revoke(id: string): void;
  forget(id: string): Promise<boolean>;
  begin(lease: string, job: string): boolean;
  cancel(job: string): Promise<void>;
  prepare(
    lease: string,
    job: string,
    url: string,
    headers: Readonly<Record<string, string>>,
    login: readonly string[],
    uncertain: readonly string[],
    now: number,
    from: number,
    until: number,
  ): Promise<Result<Prepared>>;
  publish(lease: string, job: string, candidate: string): Promise<Result<Generation>>;
  query(
    lease: string,
    generation: string,
    job: string,
    ids: readonly string[],
    at: number,
    mode: "listing" | "day" | "detail",
    from: number,
    until: number,
    after: number,
  ): Promise<Result<Query>>;
  /** The guide ids with a programme not ended at `at`. */
  current(
    lease: string,
    generation: string,
    job: string,
    at: number,
  ): Promise<Result<{ readonly ids: readonly string[] }>>;
  /**
   * The first `limit` programmes on `ids`, not ended at `at`, whose title folded as core text.ts
   * `normalize` folds holds each of `words`: on now first, then by start.
   */
  search(
    lease: string,
    generation: string,
    job: string,
    ids: readonly string[],
    words: readonly string[],
    at: number,
    limit: number,
  ): Promise<Result<{ readonly rows: readonly Match[] }>>;
  addListener?(event: "foreground" | "background", listener: () => void): { remove(): void };
}

export class GuideFault extends Error {
  readonly problem: GuideProblem;
  constructor(problem: GuideProblem) {
    super(problem);
    this.problem = problem;
  }
}

/** Expo installs modules before JS starts. Lazy lookup also keeps Node service tests independent. */
export function nativeGuide(): GuideNative {
  const raw = requireNativeModule<
    Omit<GuideNative, "prepare" | "query"> & {
      prepareRequest(args: Readonly<Record<string, unknown>>): ReturnType<GuideNative["prepare"]>;
      queryRequest(args: Readonly<Record<string, unknown>>): ReturnType<GuideNative["query"]>;
    }
  >("Guide");

  return {
    restore: (ids, kept) => raw.restore(ids, kept),
    attach: (id, revision) => raw.attach(id, revision),
    revoke: (id) => raw.revoke(id),
    forget: (id) => raw.forget(id),
    begin: (lease, job) => raw.begin(lease, job),
    cancel: (job) => raw.cancel(job),
    publish: (lease, job, candidate) => raw.publish(lease, job, candidate),
    current: (lease, generation, job, at) => raw.current(lease, generation, job, at),
    search: (lease, generation, job, ids, words, at, limit) =>
      raw.search(lease, generation, job, ids, words, at, limit),
    addListener: (event, listener) => raw.addListener?.(event, listener) ?? { remove() {} },
    prepare: (lease, job, url, headers, login, uncertain, now, from, until) =>
      raw.prepareRequest({ lease, job, url, headers, login, uncertain, now, from, until }),
    query: (lease, generation, job, ids, at, mode, from, until, after) =>
      raw.queryRequest({ lease, generation, job, ids, at, mode, from, until, after }),
  };
}

/**
 * Each redirect has closed before JS validates the next hop against the ORIGINAL request, or the
 * address that named it (`from`), with the source's login and uncertain values: an https
 * playlist's token goes to no http hop, however short. The native reader saves no programme
 * holding either, under XmltvReader.kt's secret checks.
 */
export async function ingest(
  native: GuideNative,
  lease: string,
  job: string,
  request: Extract<GuideRequest, { kind: "request" }>,
  { login, uncertain = [] }: SourceLogin,
  now: number,
  wanted: () => boolean,
): Promise<Result<Generation>> {
  // An empty value would be in everything.
  const known = { secrets: login.filter(Boolean), uncertain: uncertain.filter(Boolean) };
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  let url = request.url;

  for (let followed = 0; ; followed++) {
    if (!wanted()) return { kind: "cancelled" };

    const result = await native.prepare(
      lease,
      job,
      url,
      request.headers,
      login,
      known.uncertain,
      now,
      yesterday.getTime(),
      now + 7 * 86400_000,
    );

    if (!wanted()) return { kind: "cancelled" };

    if (result.kind !== "ok") return result;

    if (result.value.kind === "candidate") return native.publish(lease, job, result.value.id);

    try {
      url = nextProviderRedirect({
        original: request.from ?? request.url,
        current: url,
        location: result.value.location,
        followed,
        login: known,
      });
    } catch {
      return { kind: "failed", error: "redirect" };
    }
  }
}
