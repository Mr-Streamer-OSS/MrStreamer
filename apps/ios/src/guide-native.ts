import type { Programme } from "@mrstreamer/contracts/guide";
import { nextProviderRedirect, type GuideRequest } from "@mrstreamer/core/provider";
import type { SourceLogin } from "./login-safety.ts";

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
  const host: { expo?: { modules?: { Guide?: GuideNative } } } = globalThis;
  const found = host.expo?.modules?.Guide;
  if (!found) throw new GuideFault("unavailable");
  return found;
}

/**
 * Each redirect has closed before JS validates the next hop against the ORIGINAL request, or the
 * address that named it (`from`), with the source's login and uncertain values: an https
 * playlist's token goes to no http hop, however short. The native reader saves no programme
 * holding either, as login-safety.ts `holds` reads saved lists.
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
