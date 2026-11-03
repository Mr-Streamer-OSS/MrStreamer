import { AppFailure } from "@mrstreamer/contracts/errors";
import { archiveHolds } from "@mrstreamer/core/catchup";
import { archiveAddress } from "@mrstreamer/core/playlist/catchup";
import { playlistCatalogue, type PlaylistStream } from "@mrstreamer/core/playlist/catalogue";
import { safeName } from "@mrstreamer/core/playlist/import";
import { m3uReader, type PlaylistEntry } from "@mrstreamer/core/playlist/m3u";
import { providerFetch, type ProviderLogin } from "@mrstreamer/core/provider";
import { describeNetworkError, xtreamProvider } from "@mrstreamer/core/xtream";
import type { Credentials } from "../platform/credentials.ts";
import type { PlayIntent } from "./intent.ts";
import type { Admission } from "./native.ts";

// From an intent to the address the native player opens, read from the source's protected login
// each time. Xtream addresses are core's; a playlist's channel is found by reading the playlist
// again until its entry, as core's playlist provider reads itself again for a stream, under the
// limits the app's playlist reader keeps (src/connect/playlist.ts). The card "Share mobile account
// and catalogue behavior without changing iOS outcomes" owns one shared playlist adapter, which
// can answer this from the catalogue it already read.

/** An admission without its attempt: what an intent plays. */
export type StreamRequest = Omit<Admission, "attempt">;

export type Resolve = (intent: PlayIntent, signal: AbortSignal) => Promise<StreamRequest>;

export interface ResolvePlatform {
  readonly credentials: Credentials;
  readonly fetch: typeof fetch;
  readonly userAgent: string;
  readonly now: () => number;
}

const PLAYLIST_TIMEOUT_MS = 90_000;
const PLAYLIST_BYTES = 64 * 1024 * 1024;

/** Query names whose values are a playlist link's login, as src/connect/playlist.ts reads them. */
const LOGIN_NAMES: ReadonlySet<string> = new Set([
  "username",
  "user",
  "password",
  "pass",
  "pwd",
  "login",
  "token",
  "access_token",
  "auth",
  "key",
  "apikey",
  "api_key",
  "secret",
]);

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function playlistLogin(link: string): ProviderLogin {
  const url = new URL(link);
  const secrets = [decoded(url.username), decoded(url.password)];
  const uncertain: string[] = [];
  for (const [name, value] of url.searchParams)
    (LOGIN_NAMES.has(name.toLowerCase()) ? secrets : uncertain).push(value);
  return { secrets: secrets.filter(Boolean), uncertain };
}

/** Each of a value's ";"-separated groups cleaned on its own. */
const eachGroup = (value: string) => value.split(";").map(safeName).join(";");

/**
 * `entry` named as the app's playlist reader names it (src/connect/playlist.ts), so its channel
 * gets the id the catalogue shows.
 */
const asListed = (entry: PlaylistEntry): PlaylistEntry => ({
  ...entry,
  name: safeName(entry.name),
  group: entry.group === null ? null : eachGroup(entry.group),
  attributes: {
    ...entry.attributes,
    ...Object.fromEntries(
      (["tvg-id", "tvg-name", "group-title"] as const).flatMap((name) => {
        const value = entry.attributes[name];
        return value === undefined ? [] : [[name, eachGroup(value)]];
      }),
    ),
  },
});

/**
 * The playlist's stream for `channelId`, reading the playlist only as far as its entry. Channel
 * ids depend only on the entries before them, so the catalogue of what is read so far names it as
 * the whole playlist's does.
 */
async function playlistStream(
  link: string,
  channelId: string,
  platform: ResolvePlatform,
  signal: AbortSignal,
): Promise<PlaylistStream> {
  const origin = new URL(link).origin;
  const unreachable = (detail: string) =>
    new AppFailure({ kind: "unreachable", server: origin, detail });
  const timeout = AbortSignal.timeout(PLAYLIST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await providerFetch(platform.fetch, playlistLogin(link))(link, {
      headers: { "User-Agent": platform.userAgent },
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch (cause) {
    if (signal.aborted || cause instanceof AppFailure) throw cause;
    throw unreachable(describeNetworkError(cause));
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new AppFailure({ kind: "provider-error", status: response.status });
  }
  const pieces = response.body.getReader();
  const decoder = new TextDecoder();
  const reader = m3uReader();
  const entries: PlaylistEntry[] = [];
  let bytes = 0;
  // An entry names the channel only when the id starts with its tvg-id, else its name: the
  // catalogue is worked out again only after such an entry, not after every piece read.
  const couldName = (entry: PlaylistEntry) => {
    const base = entry.attributes["tvg-id"] || entry.name || entry.attributes["tvg-name"];
    return !base || channelId.startsWith(base);
  };
  const found = (read: readonly PlaylistEntry[]) => {
    const more = read.map(asListed);
    entries.push(...more);
    return more.some(couldName) ? playlistCatalogue(entries).streams.get(channelId) : undefined;
  };
  try {
    for (;;) {
      const { done, value } = await pieces.read();
      const stream = done
        ? found([...reader.push(decoder.decode()), ...reader.end()])
        : found(reader.push(decoder.decode(value, { stream: true })));
      if (stream) return stream;
      if (done || reader.playlist === false) break;
      bytes += value.byteLength;
      if (bytes > PLAYLIST_BYTES) break;
    }
  } catch (cause) {
    if (signal.aborted || cause instanceof AppFailure) throw cause;
    throw unreachable(describeNetworkError(cause));
  } finally {
    void pieces.cancel().catch(() => {});
  }
  throw new AppFailure({ kind: "channel-not-found", channelId });
}

/** Resolves intents for the sources whose logins `platform.credentials` holds. */
export function sourceStreams(platform: ResolvePlatform): Resolve {
  const withAgent = (headers: Readonly<Record<string, string>> | undefined) => ({
    "User-Agent": platform.userAgent,
    ...headers,
  });

  return async (intent, signal) => {
    if (intent.kind === "file") {
      return {
        url: `file://${encodeURI(intent.path)}`,
        headers: {},
        format: "progressive",
        mode: "file",
        startMs: intent.resumeAt ?? 0,
        path: intent.path,
      };
    }
    const { sourceId } = intent;
    if (intent.kind === "catch-up" && !archiveHolds(intent.days, intent.window.start, platform.now()))
      throw new AppFailure({ kind: "catch-up", reason: "outside", days: intent.days });
    const authority = await platform.credentials.read(sourceId);
    signal.throwIfAborted();
    if (!authority) throw new AppFailure({ kind: "needs-secret", subscriptionId: sourceId });

    if (authority.kind === "xtream") {
      const provider = xtreamProvider(authority, {
        userAgent: platform.userAgent,
        fetch: platform.fetch,
      });
      switch (intent.kind) {
        case "live": {
          const stream = await provider.liveStream(intent.channelId, signal);
          return {
            url: stream.url,
            headers: withAgent(stream.headers),
            format: stream.format,
            mode: "live",
            startMs: 0,
            sourceId,
          };
        }
        case "catch-up": {
          const stream = await provider.archiveStream(intent.channelId, intent.window, signal);
          return {
            url: stream.url,
            headers: withAgent(stream.headers),
            format: stream.format,
            mode: "archive",
            startMs: Math.max(0, (intent.from ?? intent.window.start) - stream.start),
            sourceId,
          };
        }
        case "title": {
          const file = await provider.titleFile(intent.media, intent.id, intent.container, signal);
          return {
            url: file.url,
            headers: withAgent(file.headers),
            format: "progressive",
            mode: "title",
            startMs: intent.resumeAt ?? 0,
            sourceId,
          };
        }
      }
    }

    // A playlist link lists its channels; its movies and series aren't read on Android yet.
    if (intent.kind === "title") throw new AppFailure({ kind: "title-not-found", titleId: intent.id });
    const stream = await playlistStream(authority.link, intent.channelId, platform, signal);
    if (intent.kind === "live") {
      return {
        url: stream.url,
        headers: withAgent(stream.headers),
        format: stream.format,
        mode: "live",
        startMs: 0,
        sourceId,
      };
    }
    const archive = stream.catchup
      ? archiveAddress(stream.catchup, intent.window, platform.now())
      : null;
    if (!archive) throw new AppFailure({ kind: "catch-up", reason: "none" });
    return {
      url: archive.url,
      headers: withAgent(stream.headers),
      format: stream.format,
      mode: "archive",
      startMs: Math.max(0, (intent.from ?? intent.window.start) - archive.start),
      sourceId,
    };
  };
}
