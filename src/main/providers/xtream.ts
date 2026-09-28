// Xtream Codes compatible providers (player_api.php). Most IPTV resellers run a panel that speaks this API.
import { type } from "arktype";
import { AppFailure } from "../../shared/errors.ts";
import type { LoginInput } from "../../shared/ipc.ts";
import type { AccountState, AccountStatus } from "../../shared/subscription.ts";
import type {
  LiveCatalogue,
  LiveProvider,
  ProviderCategory,
  ProviderChannel,
  ProviderOptions,
} from "./provider.ts";

export interface XtreamAccount {
  /** Normalised origin plus an optional path prefix, without a trailing slash. */
  readonly server: string;
  readonly username: string;
  readonly password: string;
}

const AUTH_TIMEOUT_MS = 15_000;
const CATALOGUE_TIMEOUT_MS = 90_000;

/**
 * Turns what the user typed into an account. The server field also accepts a pasted M3U link
 * (`.../get.php?username=...&password=...`), which carries the login itself.
 */
export function parseLogin(input: LoginInput): XtreamAccount {
  const raw = input.server.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new AppFailure({
      kind: "incomplete-login",
      detail: "The server address is not a valid URL.",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppFailure({
      kind: "incomplete-login",
      detail: "The server address must start with http or https.",
    });
  }

  const username = input.username.trim() || url.searchParams.get("username")?.trim() || "";
  const password = input.password || url.searchParams.get("password") || "";
  if (!username || !password) {
    throw new AppFailure({
      kind: "incomplete-login",
      detail: "Enter a username and password, or paste an M3U link that contains them.",
    });
  }

  const path = url.pathname
    .replace(/\/(player_api|get|xmltv|panel_api)\.php$/i, "")
    .replace(/\/+$/, "");
  return { server: `${url.origin}${path}`, username, password };
}

/** Creates a provider for an Xtream account. */
export function xtreamProvider(account: XtreamAccount, options: ProviderOptions): LiveProvider {
  const fetchImpl = options.fetch ?? fetch;
  const credentials = new URLSearchParams({
    username: account.username,
    password: account.password,
  });

  async function getJson(
    params: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${account.server}/player_api.php?${credentials}${params}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    let text: string;
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": options.userAgent, Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.status === 401 || response.status === 403) {
        throw new AppFailure({ kind: "invalid-login" });
      }
      if (!response.ok) throw new AppFailure({ kind: "provider-error", status: response.status });
      text = await response.text();
    } catch (cause) {
      if (cause instanceof AppFailure || signal?.aborted) throw cause;
      throw new AppFailure({
        kind: "unreachable",
        server: account.server,
        detail: describeNetworkError(cause),
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AppFailure({
        kind: "unreachable",
        server: account.server,
        detail: "The server answered, but not like an Xtream API.",
      });
    }
  }

  return {
    async authenticate(signal) {
      const body = AuthResponse(await getJson("", AUTH_TIMEOUT_MS, signal));
      if (body instanceof type.errors || !body.user_info || !isTruthy(body.user_info.auth)) {
        throw new AppFailure({ kind: "invalid-login" });
      }
      const account = accountStatus(body.user_info);
      if (
        account.state === "expired" ||
        account.state === "banned" ||
        account.state === "disabled"
      ) {
        throw new AppFailure({
          kind: "account-inactive",
          state: account.state,
          expiresAt: account.expiresAt,
        });
      }
      return account;
    },

    async liveCatalogue(signal): Promise<LiveCatalogue> {
      const [categories, streams] = await Promise.all([
        getJson("&action=get_live_categories", CATALOGUE_TIMEOUT_MS, signal),
        getJson("&action=get_live_streams", CATALOGUE_TIMEOUT_MS, signal),
      ]);
      if (isRejectedLogin(categories) || isRejectedLogin(streams)) {
        throw new AppFailure({ kind: "invalid-login" });
      }
      return {
        categories: rows(categories).flatMap(toCategory),
        channels: rows(streams).flatMap(toChannel),
      };
    },

    liveStream(channelId) {
      const user = encodeURIComponent(account.username);
      const pass = encodeURIComponent(account.password);
      return {
        url: `${account.server}/live/${user}/${pass}/${encodeURIComponent(channelId)}.ts`,
        format: "mpegts",
      };
    },
  };
}

// Panels disagree on types: numbers arrive as strings, empty strings stand in for null, and
// fields go missing. The schemas accept all of that and the mappers below normalise it.
const idLike = type("string | number");
const loose = type("string | number | null");

const UserInfo = type({
  "auth?": "number | string | boolean | null",
  "status?": "string | null",
  "exp_date?": loose,
  "max_connections?": loose,
  "active_cons?": loose,
});

const AuthResponse = type({ "user_info?": UserInfo.or("unknown[]") }).pipe((body) => ({
  user_info: Array.isArray(body.user_info) ? undefined : body.user_info,
}));

const CategoryRow = type({ category_id: idLike, "category_name?": "string | null" });

const StreamRow = type({
  stream_id: idLike,
  "name?": "string | null",
  "num?": loose,
  "stream_icon?": "string | null",
  "category_id?": loose,
  "category_ids?": "(string | number)[] | null",
});

function toCategory(raw: unknown): ProviderCategory[] {
  const row = CategoryRow(raw);
  if (row instanceof type.errors) return [];
  const id = String(row.category_id);
  return [{ id, name: row.category_name?.trim() || `Category ${id}` }];
}

function toChannel(raw: unknown): ProviderChannel[] {
  const row = StreamRow(raw);
  if (row instanceof type.errors) return [];
  const id = String(row.stream_id);
  const categoryIds = row.category_ids?.length
    ? row.category_ids.map(String)
    : row.category_id != null && row.category_id !== ""
      ? [String(row.category_id)]
      : [];
  return [
    {
      id,
      name: row.name?.trim() || `Channel ${id}`,
      number: toInteger(row.num),
      logoUrl: row.stream_icon && /^https?:\/\//i.test(row.stream_icon) ? row.stream_icon : null,
      categoryIds,
    },
  ];
}

function accountStatus(info: typeof UserInfo.infer): AccountStatus {
  const expiry = toInteger(info.exp_date);
  return {
    state: accountState(info.status),
    expiresAt: expiry ? new Date(expiry * 1000).toISOString() : null,
    maxConnections: toInteger(info.max_connections),
    activeConnections: toInteger(info.active_cons),
  };
}

function accountState(status: string | null | undefined): AccountState {
  switch (status?.trim().toLowerCase()) {
    case "active":
      return "active";
    case "expired":
      return "expired";
    case "banned":
      return "banned";
    case "disabled":
      return "disabled";
    default:
      return "unknown";
  }
}

/** Some panels answer catalogue actions with a login failure instead of an HTTP error. */
function isRejectedLogin(body: unknown): boolean {
  const parsed = AuthResponse(body);
  return (
    !(parsed instanceof type.errors) &&
    parsed.user_info !== undefined &&
    !isTruthy(parsed.user_info.auth)
  );
}

function rows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  // A few panels return an object keyed by index instead of an array.
  if (body && typeof body === "object" && !("user_info" in body)) return Object.values(body);
  return [];
}

function isTruthy(value: string | number | boolean | null | undefined): boolean {
  return value === true || value === 1 || value === "1";
}

function toInteger(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) ? number : null;
}

function describeNetworkError(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "TimeoutError")
    return "The server did not answer in time.";
  // fetch wraps the socket error: TypeError("fetch failed", { cause: Error { code } }).
  const inner = cause instanceof Error && cause.cause instanceof Error ? cause.cause : null;
  const code = inner && "code" in inner ? inner.code : null;
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "The server name could not be found.";
    case "ECONNREFUSED":
      return "The server refused the connection.";
    case "ECONNRESET":
      return "The connection was reset.";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return "The server did not answer in time.";
    default:
      return inner?.message ?? (cause instanceof Error ? cause.message : String(cause));
  }
}
