// Plain M3U playlists: one link to a list of channels, without a login or an API. Live TV only;
// the guide is the XMLTV document the playlist's header names, when it names one.
import { AppFailure } from "@mrstreamer/contracts/errors";
import { playlistCatalogue, type PlaylistCatalogue } from "@mrstreamer/core/playlist/catalogue";
import { m3uReader, type PlaylistEntry } from "@mrstreamer/core/playlist/m3u";
import { providerFetch, type Provider, type ProviderOptions } from "@mrstreamer/core/provider";
import { describeNetworkError } from "./xtream.ts";

export interface PlaylistAccount {
  /** The playlist's address as the user gave it. It can hold a token, so it is sealed on disk. */
  readonly link: string;
}

/** Reading the start of the playlist, to check it is one. */
const CHECK_TIMEOUT_MS = 15_000;
/** The whole playlist: a few megabytes for iptv-org's 11,000 channels. */
const PLAYLIST_TIMEOUT_MS = 90_000;
/** The whole guide download. */
const GUIDE_TIMEOUT_MS = 5 * 60_000;

/** One complete read of the playlist. */
interface Read {
  readonly catalogue: PlaylistCatalogue;
  readonly guideUrl: string | null;
}

/**
 * Creates a provider for a playlist link. It reads the playlist as it downloads, so a long one is
 * never parsed in one go, and keeps the last read for stream addresses and the guide. Movies and
 * series: none.
 */
export function playlistProvider(account: PlaylistAccount, options: ProviderOptions): Provider {
  const fetchImpl = providerFetch(options.fetch ?? fetch, loginIn(account.link));
  let last: Read | null = null;
  /** The read in progress, shared by every call that needs one. */
  let reading: Promise<Read> | null = null;

  /** Opens `url` and gives its body, turning network and HTTP failures into typed errors. */
  async function open(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": options.userAgent },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AppFailure({
        kind: "unreachable",
        server: new URL(url).origin,
        detail: describeNetworkError(cause),
      });
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new AppFailure({ kind: "provider-error", status: response.status });
    }
    return response.body;
  }

  /** The playlist, read again. Calls while a read runs share it; none of them can stop it. */
  function fresh(): Promise<Read> {
    reading ??= (async () => {
      try {
        const text = (await open(account.link, PLAYLIST_TIMEOUT_MS)).pipeThrough(
          new TextDecoderStream(),
        );
        const reader = m3uReader();
        const entries: PlaylistEntry[] = [];
        for await (const piece of text) {
          for (const entry of reader.push(piece)) entries.push(entry);
          if (reader.playlist === false) {
            void text.cancel().catch(() => {});
            throw notAPlaylist(account.link);
          }
        }
        for (const entry of reader.end()) entries.push(entry);
        if (!reader.playlist) throw notAPlaylist(account.link);
        last = { catalogue: playlistCatalogue(entries), guideUrl: reader.guideUrl };
        return last;
      } catch (cause) {
        // A timeout or a connection lost halfway through the list.
        if (cause instanceof AppFailure) throw cause;
        throw new AppFailure({
          kind: "unreachable",
          server: new URL(account.link).origin,
          detail: describeNetworkError(cause),
        });
      } finally {
        reading = null;
      }
    })();
    return reading;
  }

  return {
    /** Checks that the link answers with a playlist, reading no more than its first line. */
    async authenticate(signal) {
      const text = (await open(account.link, CHECK_TIMEOUT_MS, signal)).pipeThrough(
        new TextDecoderStream(),
      );
      const reader = m3uReader();
      for await (const piece of text) {
        reader.push(piece);
        if (reader.playlist !== null) break;
      }
      void text.cancel().catch(() => {});
      if (reader.playlist === null) reader.end();
      if (!reader.playlist) {
        throw new AppFailure({
          kind: "incomplete-login",
          detail: "This address isn't a playlist. A server address needs a username and password.",
        });
      }
      return { state: "active", expiresAt: null, maxConnections: null, activeConnections: null };
    },

    async liveCatalogue(signal) {
      const { catalogue } = await abortable(fresh(), signal);
      return { categories: catalogue.categories, channels: catalogue.channels };
    },

    async liveStream(channelId, signal) {
      const known = last?.catalogue.streams.get(channelId);
      if (known) return known;
      // Channels loaded from disk after a restart, or added since the last read.
      const stream = (await abortable(fresh(), signal)).catalogue.streams.get(channelId);
      if (!stream) throw new AppFailure({ kind: "channel-not-found", channelId });
      return stream;
    },

    request: fetchImpl,

    async liveGuide(signal) {
      const { guideUrl } = last ?? (await abortable(fresh(), signal));
      if (!guideUrl) {
        throw new AppFailure({ kind: "unexpected", detail: "This playlist names no guide." });
      }
      return unpacked(await open(guideUrl, GUIDE_TIMEOUT_MS, signal));
    },

    async onDemandCatalogue() {
      return { movieCategories: [], movies: [], seriesCategories: [], series: [] };
    },

    async movieDetails(id) {
      throw new AppFailure({ kind: "title-not-found", titleId: id });
    },

    async seriesDetails(id) {
      throw new AppFailure({ kind: "title-not-found", titleId: id });
    },

    titleFile(_kind, id) {
      throw new AppFailure({ kind: "title-not-found", titleId: id });
    },
  };
}

/**
 * What in a playlist link can be a login: the user and password before the host and every query
 * value, such as a token. Redirects never carry them from https to http.
 */
function loginIn(link: string): string[] {
  const url = new URL(link);
  return [
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    ...url.searchParams.values(),
  ].filter(Boolean);
}

function notAPlaylist(link: string): AppFailure {
  return new AppFailure({
    kind: "unreachable",
    server: new URL(link).origin,
    detail: "The address answered, but not with a playlist.",
  });
}

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

/** The document unpacked when it is gzip, as guides named .xml.gz are, whatever the server says. */
async function unpacked(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const first = await reader.read();
  const whole = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  const gzip = first.value?.[0] === 0x1f && first.value[1] === 0x8b;
  return gzip ? whole.pipeThrough(new DecompressionStream("gzip")) : whole;
}
