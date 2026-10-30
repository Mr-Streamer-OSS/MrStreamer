import { AppFailure } from "@mrstreamer/contracts/errors";
import type { PlaylistMapping } from "@mrstreamer/contracts/playlist";
import { streamFormat, type PlaylistStream } from "@mrstreamer/core/playlist/catalogue";
import { archiveAddress } from "@mrstreamer/core/playlist/catchup";
import {
  importPlaylist,
  inspectPlaylist,
  type ImportedPlaylist,
} from "@mrstreamer/core/playlist/import";
import { m3uReader, type PlaylistEntry } from "@mrstreamer/core/playlist/m3u";
import {
  providerFetch,
  type GuideRequest,
  type Provider,
  type ProviderLogin,
} from "@mrstreamer/core/provider";
import { bodySize, describeNetworkError } from "@mrstreamer/core/xtream";

// An M3U playlist link as a provider: the desktop app's playlist adapter, read the way the phone
// reads (a body stream through TextDecoder) and always under the mapping limits, so a playlist
// too large for the phone fails saying so instead of exhausting its memory. Its parsing, group
// mapping and exact title versions are core's. The link can hold a token: it stays here and in
// the Keychain, and what it holds is the login (`playlistLogin`).

export interface PlaylistAccount {
  readonly link: string;
  readonly mapping?: PlaylistMapping;
}

/** Reading the first line, to check the link answers with a playlist or for its guide. */
const CHECK_TIMEOUT_MS = 15_000;
const PLAYLIST_TIMEOUT_MS = 90_000;
/** Core's mapping limits, for every read on the phone. */
const PLAYLIST_BYTES = 64 * 1024 * 1024;
const PLAYLIST_ENTRIES = 100_000;
const HEADER_CHARACTERS = 65_536;
/** Each line with its ending, and what is left of the last. */
const LINES = /[^\r\n]*(?:\r\n|\r|\n|$)/g;

/** The last read: its import, and its entries until Settings inspects an unmapped one. */
interface Read {
  readonly snapshot: ImportedPlaylist;
  entries: readonly PlaylistEntry[] | null;
  inspected: ImportedPlaylist | null;
}

export function playlistProvider(
  account: PlaylistAccount,
  options: { readonly userAgent: string; readonly fetch: typeof fetch },
): Provider {
  const get = providerFetch(options.fetch, playlistLogin(account.link));
  const origin = new URL(account.link).origin;
  let last: Read | null = null;
  let titleAddresses = new Set<string>();
  /** The read under way, shared by every call that needs one. */
  let reading: Promise<Read> | null = null;

  /** The link's answer, its network and HTTP failures typed. */
  async function open(url: string, timeoutMs: number, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await get(url, {
        headers: { "User-Agent": options.userAgent },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw unreachable(cause);
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new AppFailure({ kind: "provider-error", status: response.status });
    }
    return { body: response.body, size: bodySize(response) };
  }

  const unreachable = (cause: unknown) =>
    cause instanceof AppFailure
      ? cause
      : new AppFailure({
          kind: "unreachable",
          server: origin,
          detail: describeNetworkError(cause),
        });

  /** The playlist, read again. Calls while a read runs share it; none of them can stop it. */
  function fresh(): Promise<Read> {
    reading ??= (async () => {
      try {
        const { body, size } = await open(account.link, PLAYLIST_TIMEOUT_MS);
        if (size !== null && size > PLAYLIST_BYTES) {
          void body.cancel().catch(() => {});
          throw tooLarge();
        }
        const pieces = body.getReader();
        const decoder = new TextDecoder();
        const reader = m3uReader();
        const entries: PlaylistEntry[] = [];
        const take = (found: readonly PlaylistEntry[]) => {
          entries.push(...found);
          if (entries.length > PLAYLIST_ENTRIES) throw tooMany();
        };
        let bytes = 0;
        try {
          for (;;) {
            const { done, value } = await pieces.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > PLAYLIST_BYTES) throw tooLarge();
            take(reader.push(decoder.decode(value, { stream: true })));
            if (reader.playlist === false) throw notAPlaylist(origin);
          }
        } catch (cause) {
          void pieces.cancel().catch(() => {});
          throw cause;
        }
        take([...reader.push(decoder.decode()), ...reader.end()]);
        if (!reader.playlist) throw notAPlaylist(origin);
        const snapshot = importPlaylist(entries, account.mapping);
        last = {
          snapshot,
          entries: account.mapping ? null : entries,
          inspected: account.mapping ? snapshot : null,
        };
        titleAddresses = new Set([...snapshot.files.values()].map((file) => file.url));
        return last;
      } catch (cause) {
        throw unreachable(cause);
      } finally {
        reading = null;
      }
    })();
    return reading;
  }

  /** The last read, or a fresh one when there is none yet. */
  const lastRead = async (signal?: AbortSignal) => last ?? (await abortable(fresh(), signal));

  /** The first line, read alone and afresh: whether the link is a playlist, and its guide. */
  async function firstLine(signal?: AbortSignal) {
    const pieces = (await open(account.link, CHECK_TIMEOUT_MS, signal)).body.getReader();
    const decoder = new TextDecoder();
    const reader = m3uReader();
    let characters = 0;
    try {
      while (reader.playlist === null) {
        const { done, value } = await pieces.read();
        if (done) {
          reader.push(decoder.decode());
          reader.end();
          break;
        }
        // Line by line, up to the first that says: a piece can hold the whole playlist.
        for (const [line] of decoder.decode(value, { stream: true }).matchAll(LINES)) {
          characters += line.length;
          if (characters > HEADER_CHARACTERS) throw notAPlaylist(origin);
          reader.push(line);
          if (reader.playlist !== null) break;
        }
      }
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw unreachable(cause);
    } finally {
      void pieces.cancel().catch(() => {});
    }
    return { playlist: reader.playlist === true, guideUrl: reader.guideUrl };
  }

  async function streamOf(channelId: string, signal?: AbortSignal): Promise<PlaylistStream> {
    const known = last?.snapshot.live.streams.get(channelId);
    if (known) return known;
    // Channels shown from the copy saved at launch, before this adapter read the playlist.
    const stream = (await abortable(fresh(), signal)).snapshot.live.streams.get(channelId);
    if (!stream) throw new AppFailure({ kind: "channel-not-found", channelId });
    return stream;
  }

  async function guideRequest(signal?: AbortSignal): Promise<GuideRequest> {
    const { playlist, guideUrl } = await firstLine(signal);
    if (!playlist) throw notAPlaylist(origin);
    return guideUrl
      ? { kind: "request", url: guideUrl, headers: { "User-Agent": options.userAgent } }
      : { kind: "none" };
  }

  return {
    async authenticate(signal) {
      if (!(await firstLine(signal)).playlist) {
        throw new AppFailure({
          kind: "incomplete-login",
          detail: "This address isn't a playlist. A server address needs a username and password.",
        });
      }
      return { state: "active", expiresAt: null, maxConnections: null, activeConnections: null };
    },

    async liveCatalogue(signal) {
      const { categories, channels } = (await abortable(fresh(), signal)).snapshot.live;
      return { categories, channels };
    },

    liveStream: streamOf,

    async archiveStream(channelId, window, signal) {
      const stream = await streamOf(channelId, signal);
      const recording = stream.catchup && archiveAddress(stream.catchup, window, Date.now());
      if (!recording) throw new AppFailure({ kind: "catch-up", reason: "none" });
      return {
        url: recording.url,
        start: recording.start,
        format: streamFormat(recording.url) ?? stream.format,
        headers: stream.headers,
      };
    },

    request(url, init, from = url) {
      // A title's file address holds a login of its own, as the desktop app's adapter counts it.
      return titleAddresses.has(from)
        ? providerFetch(options.fetch, playlistLogin(account.link, from))(url, init, from)
        : get(url, init, from);
    },

    liveGuideRequest: guideRequest,

    async liveGuide(signal) {
      const request = await guideRequest(signal);
      if (request.kind === "none") return request;
      return { kind: "document", ...(await open(request.url, CHECK_TIMEOUT_MS, signal)) };
    },

    async onDemandCatalogue(signal) {
      return (await abortable(fresh(), signal)).snapshot.catalogue;
    },

    /** The last read inspected for Settings, or with `refresh` a fresh one. */
    async playlistImport(signal, refresh) {
      const read = refresh ? await abortable(fresh(), signal) : await lastRead(signal);
      signal?.throwIfAborted();
      if (!read.inspected) {
        read.inspected = inspectPlaylist(read.entries ?? []);
        read.entries = null;
      }
      return read.inspected;
    },

    async movieDetails(id, signal) {
      const { snapshot } = await lastRead(signal);
      const details = snapshot.details.get(id);
      if (!details || !snapshot.catalogue.movies.some((each) => each.id === id))
        throw new AppFailure({ kind: "title-not-found", titleId: id });
      return details;
    },

    async seriesDetails(id, signal) {
      const { snapshot } = await lastRead(signal);
      const details = snapshot.details.get(id);
      if (!details || !snapshot.catalogue.series.some((each) => each.id === id))
        throw new AppFailure({ kind: "title-not-found", titleId: id });
      return details;
    },

    async titleFile(kind, id, _container, signal) {
      const file = (await lastRead(signal)).snapshot.files.get(id);
      if (!file || file.kind !== kind)
        throw new AppFailure({ kind: "title-not-found", titleId: id });
      return file;
    },
  };
}

/** Query names whose values are as much a playlist link's login as the user info before its host. */
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

/**
 * What of playlist links is a login (`ProviderLogin`): the user info and `LOGIN_NAMES` values for
 * certain, other query values uncertain, as the desktop app's adapter reads them.
 */
export function playlistLogin(...links: string[]): ProviderLogin {
  const secrets: string[] = [];
  const uncertain: string[] = [];
  for (const link of links) {
    const url = new URL(link);
    secrets.push(decoded(url.username), decoded(url.password));
    for (const [name, value] of url.searchParams)
      (LOGIN_NAMES.has(name.toLowerCase()) ? secrets : uncertain).push(value);
  }
  return { secrets: secrets.filter(Boolean), uncertain };
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const notAPlaylist = (server: string) =>
  new AppFailure({
    kind: "unreachable",
    server,
    detail: "The address answered, but not with a playlist.",
  });

const tooLarge = () =>
  new AppFailure({
    kind: "unexpected",
    detail: "This playlist is larger than 64 MB, more than iPhone reads.",
  });

const tooMany = () =>
  new AppFailure({
    kind: "unexpected",
    detail: "This playlist has more than 100,000 entries, more than iPhone reads.",
  });

/** Waits for `promise` until `signal` aborts. */
function abortable<A>(promise: Promise<A>, signal: AbortSignal | undefined): Promise<A> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
