// Plain M3U playlists: one link to a list of channels, without a login or an API. Live TV only;
// the guide is the XMLTV document the playlist's first line names, when it names one.
import { AppFailure } from "@mrstreamer/contracts/errors";
import { playlistCatalogue, type PlaylistCatalogue } from "@mrstreamer/core/playlist/catalogue";
import { m3uReader, type PlaylistEntry } from "@mrstreamer/core/playlist/m3u";
import { providerFetch, type Provider, type ProviderOptions } from "@mrstreamer/core/provider";
import { describeNetworkError } from "./xtream.ts";

export interface PlaylistAccount {
  /** The playlist's address as the user gave it. It can hold a token, so it is sealed on disk. */
  readonly link: string;
}

/** Reading the playlist's first line, to check it is one or for the guide it names. */
const CHECK_TIMEOUT_MS = 15_000;
/** The whole playlist: a few megabytes for iptv-org's 11,000 channels. */
const PLAYLIST_TIMEOUT_MS = 90_000;
/** The whole guide download. */
const GUIDE_TIMEOUT_MS = 5 * 60_000;

/**
 * Creates a provider for a playlist link. It reads the playlist as it downloads, so a long one is
 * never parsed in one go, and keeps the last read for stream addresses. Movies and series: none.
 */
export function playlistProvider(account: PlaylistAccount, options: ProviderOptions): Provider {
  const fetchImpl = providerFetch(options.fetch ?? fetch, loginIn(account.link));
  let last: PlaylistCatalogue | null = null;
  /** The read in progress, shared by every call that needs one. */
  let reading: Promise<PlaylistCatalogue> | null = null;

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

  /** A timeout or a connection lost while the playlist arrived, as the error the UI explains. */
  function lost(cause: unknown): AppFailure {
    if (cause instanceof AppFailure) return cause;
    return new AppFailure({
      kind: "unreachable",
      server: new URL(account.link).origin,
      detail: describeNetworkError(cause),
    });
  }

  /** The playlist, read again. Calls while a read runs share it; none of them can stop it. */
  function fresh(): Promise<PlaylistCatalogue> {
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
        last = playlistCatalogue(entries);
        return last;
      } catch (cause) {
        throw lost(cause);
      } finally {
        reading = null;
      }
    })();
    return reading;
  }

  /**
   * The playlist's first line, read alone and afresh: whether the link answers with a playlist,
   * and the guide it names.
   */
  async function firstLine(
    signal?: AbortSignal,
  ): Promise<{ readonly playlist: boolean; readonly guideUrl: string | null }> {
    const text = (await open(account.link, CHECK_TIMEOUT_MS, signal)).pipeThrough(
      new TextDecoderStream(),
    );
    const reader = m3uReader();
    try {
      for await (const piece of text) {
        reader.push(piece);
        if (reader.playlist !== null) break;
      }
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw lost(cause);
    }
    void text.cancel().catch(() => {});
    if (reader.playlist === null) reader.end();
    return { playlist: reader.playlist === true, guideUrl: reader.guideUrl };
  }

  return {
    /** Checks that the link answers with a playlist, reading no more than its first line. */
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
      const { categories, channels } = await abortable(fresh(), signal);
      return { categories, channels };
    },

    async liveStream(channelId, signal) {
      const known = last?.streams.get(channelId);
      if (known) return known;
      // Channels loaded from disk after a restart, or added since the last read.
      const stream = (await abortable(fresh(), signal)).streams.get(channelId);
      if (!stream) throw new AppFailure({ kind: "channel-not-found", channelId });
      return stream;
    },

    request: fetchImpl,

    /**
     * The guide the playlist's first line names now, or that it names none. The line is read
     * again each time: an earlier read says nothing about a guide added, moved or dropped since.
     */
    async liveGuide(signal) {
      const { playlist, guideUrl } = await firstLine(signal);
      if (!playlist) throw notAPlaylist(account.link);
      if (!guideUrl) return { kind: "none" };
      return {
        kind: "document",
        body: await unpacked(await open(guideUrl, GUIDE_TIMEOUT_MS, signal)),
      };
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
