import { AppFailure } from "@mrstreamer/contracts/errors";
import { importPlaylist } from "@mrstreamer/core/playlist/import";
import { m3uReader, type PlaylistEntry } from "@mrstreamer/core/playlist/m3u";
import { providerFetch, type LiveCatalogue, type ProviderLogin } from "@mrstreamer/core/provider";
import { bodySize, describeNetworkError } from "@mrstreamer/core/xtream";
import type { CatalogueReader } from "./sources.ts";

// An M3U playlist link as a catalogue reader: checked and read under the iOS app's limits
// (apps/ios/src/playlist.ts), so a playlist too large for the phone fails saying so instead of
// exhausting its memory. Parsing and channel import are core's. Temporary: the card "Share mobile
// account and catalogue behavior without changing iOS outcomes" owns one shared playlist adapter
// for both apps, which replaces this reader and its login rules.

const CHECK_TIMEOUT_MS = 15_000;
const PLAYLIST_TIMEOUT_MS = 90_000;
const PLAYLIST_BYTES = 64 * 1024 * 1024;
const PLAYLIST_ENTRIES = 100_000;
/** A first line this long heads no playlist. */
const HEADER_BYTES = 65_536;
/** What a playlist host answers a link it no longer serves with. */
const REFUSED: ReadonlySet<number> = new Set([401, 403, 404, 410]);

/** Query names whose values are as much a playlist link's login as its user info. */
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

/** What of a playlist link is a login: its user info and `LOGIN_NAMES` values for certain. */
export function playlistLogin(link: string): ProviderLogin {
  const url = new URL(link);
  const secrets = [decoded(url.username), decoded(url.password)];
  const uncertain: string[] = [];
  for (const [name, value] of url.searchParams)
    (LOGIN_NAMES.has(name.toLowerCase()) ? secrets : uncertain).push(value);
  return { secrets: secrets.filter(Boolean), uncertain };
}

export function playlistReader(
  link: string,
  options: { readonly userAgent: string; readonly fetch: typeof fetch },
): CatalogueReader {
  const get = providerFetch(options.fetch, playlistLogin(link));
  const origin = new URL(link).origin;
  const unreachable = (detail: string) =>
    new AppFailure({ kind: "unreachable", server: origin, detail });

  /** The link's body, its network and HTTP failures typed, with no address beyond its origin. */
  async function open(timeoutMs: number, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await get(link, {
        headers: { "User-Agent": options.userAgent },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw cause instanceof AppFailure ? cause : unreachable(describeNetworkError(cause));
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      if (REFUSED.has(response.status))
        throw new AppFailure({
          kind: "incomplete-login",
          detail:
            "Your provider refused this playlist link. Check it, or get a new one from your provider.",
        });
      throw new AppFailure({ kind: "provider-error", status: response.status });
    }
    return { body: response.body, size: bodySize(response) };
  }

  const notAPlaylist = () => unreachable("The address answered, but not with a playlist.");
  const tooLarge = () =>
    new AppFailure({
      kind: "unexpected",
      detail: "This playlist is larger than 64 MB, more than the phone reads.",
    });
  const tooMany = () =>
    new AppFailure({
      kind: "unexpected",
      detail: "This playlist has more than 100,000 entries, more than the phone reads.",
    });

  /** Reads `body` through the M3U reader until `enough` says so or it ends. */
  async function read(
    body: ReadableStream<Uint8Array>,
    enough: (reader: ReturnType<typeof m3uReader>, bytes: number) => boolean,
    take: (found: readonly PlaylistEntry[]) => void,
    signal?: AbortSignal,
  ) {
    const pieces = body.getReader();
    const decoder = new TextDecoder();
    const reader = m3uReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await pieces.read();
        if (done) {
          take([...reader.push(decoder.decode()), ...reader.end()]);
          break;
        }
        bytes += value.byteLength;
        take(reader.push(decoder.decode(value, { stream: true })));
        if (reader.playlist === false || enough(reader, bytes)) break;
      }
    } catch (cause) {
      if (signal?.aborted || cause instanceof AppFailure) throw cause;
      throw unreachable(describeNetworkError(cause));
    } finally {
      void pieces.cancel().catch(() => {});
    }
    return reader.playlist === true;
  }

  return {
    async authenticate(signal) {
      const { body } = await open(CHECK_TIMEOUT_MS, signal);
      const playlist = await read(
        body,
        (reader, bytes) => reader.playlist !== null || bytes > HEADER_BYTES,
        () => {},
        signal,
      );
      if (!playlist)
        throw new AppFailure({
          kind: "incomplete-login",
          detail: "This address isn't a playlist. A server address needs a username and password.",
        });
    },

    async liveCatalogue(signal): Promise<LiveCatalogue> {
      const { body, size } = await open(PLAYLIST_TIMEOUT_MS, signal);
      if (size !== null && size > PLAYLIST_BYTES) {
        void body.cancel().catch(() => {});
        throw tooLarge();
      }
      const entries: PlaylistEntry[] = [];
      const playlist = await read(
        body,
        (_reader, bytes) => {
          if (bytes > PLAYLIST_BYTES) throw tooLarge();
          return false;
        },
        (found) => {
          entries.push(...found);
          if (entries.length > PLAYLIST_ENTRIES) throw tooMany();
        },
        signal,
      );
      if (!playlist) throw notAPlaylist();
      const { categories, channels } = importPlaylist(entries).live;
      return { categories, channels };
    },
  };
}
