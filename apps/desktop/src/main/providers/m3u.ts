// M3U playlists with optional explicit group mapping for live and on-demand entries;
// the guide is the XMLTV document the playlist's first line names, when it names one, and a
// channel's recordings play from where its entry's catch-up attributes say.
import { AppFailure } from "@mrstreamer/contracts/errors";
import { streamFormat, type PlaylistStream } from "@mrstreamer/core/playlist/catalogue";
import { archiveAddress } from "@mrstreamer/core/playlist/catchup";
import {
  importPlaylist,
  inspectPlaylist,
  type ImportedPlaylist,
} from "@mrstreamer/core/playlist/import";
import type { PlaylistMapping } from "@mrstreamer/contracts/playlist";
import { m3uReader, type PlaylistEntry } from "@mrstreamer/core/playlist/m3u";
import {
  providerFetch,
  type Provider,
  type ProviderLogin,
  type ProviderOptions,
} from "@mrstreamer/core/provider";
import { t } from "@mrstreamer/core/i18n";
import { bodySize, describeNetworkError } from "./xtream.ts";

export interface PlaylistAccount {
  /** The playlist's address as the user gave it. It can hold a token, so it is sealed on disk. */
  readonly link: string;
  readonly mapping?: PlaylistMapping;
}

/** Reading the playlist's first line, to check it is one or for the guide it names. */
const CHECK_TIMEOUT_MS = 15_000;

/** The whole playlist: a few megabytes for iptv-org's 11,000 channels. */
const PLAYLIST_TIMEOUT_MS = 90_000;

/** The whole guide download, before it is indexed. */
const GUIDE_TIMEOUT_MS = 15 * 60_000;

/** Mapping is bounded; existing unmapped Live playlists keep their original load limits. */
const MAPPING_BYTES = 64 * 1024 * 1024;

/** A playlist download shared by every call waiting on it; `stop` ends it once none are left. */
interface Reading {
  readonly inspecting: boolean;
  readonly stop: AbortController;
  readonly promise: Promise<PlaylistRead>;
  waiting: number;
}

interface PlaylistRead {
  readonly snapshot: ImportedPlaylist;
  /** Mapping reports are built only when Settings asks for them. */
  inspect(): ImportedPlaylist;
}

/** Raw entries are retained only while a bounded mapping inspection can still use them. */
function playlistRead(
  snapshot: ImportedPlaylist,
  entries?: readonly PlaylistEntry[],
  limit?: AppFailure,
): PlaylistRead {
  let pending = entries;
  let inspected = entries ? undefined : snapshot;
  let failure = limit;

  return {
    snapshot,
    inspect() {
      if (failure) throw failure;

      if (inspected) return inspected;

      if (!pending) return snapshot;

      try {
        inspected = inspectPlaylist(pending);

        return inspected;
      } catch (cause) {
        if (cause instanceof AppFailure) failure = cause;
        throw cause;
      } finally {
        pending = undefined;
      }
    },
  };
}

/**
 * Creates a provider for a playlist link. It reads the playlist as it downloads, so a long one is
 * never parsed in one go, and keeps the last successful read for exact stream versions.
 */
export function playlistProvider(account: PlaylistAccount, options: ProviderOptions): Provider {
  const fetchImpl = providerFetch(options.fetch ?? fetch, loginIn(account.link));
  let last: PlaylistRead | null = null;
  let titleAddresses = new Set<string>();

  /** The read in progress, shared by every call that needs one. */
  let reading: Reading | null = null;

  /** Opens `url` as fetch’s non-shared byte chunks, turning network and HTTP failures into typed errors. */
  async function open(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array<ArrayBuffer>>; size: number | null }> {
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

    return { body: response.body, size: bodySize(response) };
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

  /** Waits for `read` until `signal` aborts, stopping it when no other call is left waiting. */
  function wait(read: Reading, signal: AbortSignal | undefined): Promise<PlaylistRead> {
    read.waiting++;

    if (!signal) return read.promise;

    return new Promise((resolve, reject) => {
      const leave = () => {
        reject(signal.reason);

        if (--read.waiting > 0) return;

        if (reading === read) reading = null;
        read.stop.abort();
      };

      signal.addEventListener("abort", leave, { once: true });
      read.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", leave));
    });
  }

  /**
   * The playlist, read again, until `signal` gives up waiting. Calls while a read runs share it,
   * and it stops once every one of them has given up, so the next call reads afresh.
   */
  function fresh(signal?: AbortSignal, inspecting = false): Promise<PlaylistRead> {
    signal?.throwIfAborted();

    if (reading) {
      // An inspection can stop at its mapping cap. Live then retries under its original policy.
      if (!account.mapping && !inspecting && reading.inspecting)
        return wait(reading, signal).catch((cause: unknown) => {
          if (cause instanceof AppFailure && cause.error.kind === "unexpected")
            return fresh(signal);
          throw cause;
        });

      return wait(reading, signal);
    }

    const stop = new AbortController();

    const promise = (async () => {
      try {
        const body: ReadableStream<NodeJS.BufferSource> = (
          await open(account.link, PLAYLIST_TIMEOUT_MS, stop.signal)
        ).body;

        const text = body.pipeThrough(new TextDecoderStream());

        const reader = m3uReader();
        const entries: PlaylistEntry[] = [];
        let bytes = 0;

        for await (const piece of text) {
          bytes += Buffer.byteLength(piece);

          if ((account.mapping || inspecting) && bytes > MAPPING_BYTES) {
            throw new AppFailure({
              kind: "unexpected",
              detail: t("Playlist exceeds the {size} MiB mapping limit.", { size: 64 }),
            });
          }

          for (const entry of reader.push(piece)) {
            entries.push(entry);

            if ((account.mapping || inspecting) && entries.length > 100_000)
              throw new AppFailure({
                kind: "unexpected",
                detail: t("Playlist exceeds the {count} entry mapping limit.", { count: 100_000 }),
              });
          }

          if (reader.playlist === false) {
            void text.cancel().catch(() => {});
            throw notAPlaylist(account.link);
          }
        }

        // EOF may already be buffered when the final waiter cancels the request.
        stop.signal.throwIfAborted();

        for (const entry of reader.end()) entries.push(entry);

        if (!reader.playlist) throw notAPlaylist(account.link);

        const snapshot =
          inspecting && !account.mapping
            ? inspectPlaylist(entries)
            : importPlaylist(entries, account.mapping);

        const limit =
          bytes > MAPPING_BYTES
            ? new AppFailure({
                kind: "unexpected",
                detail: t("Playlist exceeds the {size} MiB mapping limit.", { size: 64 }),
              })
            : entries.length > 100_000
              ? new AppFailure({
                  kind: "unexpected",
                  detail: t("Playlist exceeds the {count} entry mapping limit.", {
                    count: 100_000,
                  }),
                })
              : undefined;

        last = playlistRead(
          snapshot,
          account.mapping || inspecting || limit ? undefined : entries,
          limit,
        );
        titleAddresses = new Set([...snapshot.files.values()].map((file) => file.url));

        return last;
      } catch (cause) {
        throw lost(cause);
      } finally {
        // A read every caller gave up on has already made way for the next one.
        if (!stop.signal.aborted) reading = null;
      }
    })();

    reading = { inspecting, stop, promise, waiting: 0 };

    return wait(reading, signal);
  }

  /**
   * The playlist's first line, read alone and afresh: whether the link answers with a playlist,
   * and the guide it names.
   */
  async function firstLine(
    signal?: AbortSignal,
  ): Promise<{ readonly playlist: boolean; readonly guideUrl: string | null }> {
    const body: ReadableStream<NodeJS.BufferSource> = (
      await open(account.link, CHECK_TIMEOUT_MS, signal)
    ).body;

    const text = body.pipeThrough(new TextDecoderStream());

    const reader = m3uReader();
    let characters = 0;

    try {
      for await (const piece of text) {
        // Only complete lines up to the first meaningful header are parsed, even when a fetch
        // supplies the whole playlist in one chunk. Leading blank lines count against the cap.
        for (const line of piece.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
          const part = line[0];
          characters += part.length;

          if (characters > 65_536)
            throw new AppFailure({
              kind: "unexpected",
              detail: t("Playlist header exceeds {count} characters.", { count: 65_536 }),
            });
          reader.push(part);

          if (reader.playlist !== null) break;
        }

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

  /** A channel's stream, from the last read or, for one it doesn't have, a fresh one. */
  async function streamOf(channelId: string, signal?: AbortSignal): Promise<PlaylistStream> {
    const known = last?.snapshot.live.streams.get(channelId);

    if (known) return known;
    // Channels loaded from disk after a restart, or added since the last read.
    const stream = (await fresh(signal)).snapshot.live.streams.get(channelId);

    if (!stream) throw new AppFailure({ kind: "channel-not-found", channelId });

    return stream;
  }

  return {
    /** Checks that the link answers with a playlist, reading no more than its first line. */
    async authenticate(signal) {
      if (!(await firstLine(signal)).playlist) {
        throw new AppFailure({
          kind: "incomplete-login",
          detail: t(
            "This address isn't a playlist. A server address needs a username and password.",
          ),
        });
      }

      return { state: "active", expiresAt: null, maxConnections: null, activeConnections: null };
    },

    async liveCatalogue(signal) {
      const {
        snapshot: {
          live: { categories, channels },
        },
      } = await fresh(signal);

      return { categories, channels };
    },

    liveStream: streamOf,

    currentLiveStream(channelId) {
      return last?.snapshot.live.streams.get(channelId);
    },

    async archiveStream(channelId, window, signal) {
      const stream = await streamOf(channelId, signal);
      const recording = stream.catchup && archiveAddress(stream.catchup, window, Date.now());

      if (!recording) throw new AppFailure({ kind: "catch-up", reason: "none" });
      const { url, start } = recording;

      return {
        url,
        start,
        format: streamFormat(url) ?? stream.format,
        headers: stream.headers,
      };
    },

    request(url, init, from = url) {
      // Title credentials belong to exact imported files. Live keeps its existing redirect policy.
      return titleAddresses.has(from)
        ? providerFetch(options.fetch ?? fetch, loginIn(account.link, from))(url, init, from)
        : fetchImpl(url, init, from);
    },

    /**
     * The guide the playlist's first line names now, or that it names none. The line is read
     * again each time: an earlier read says nothing about a guide added, moved or dropped since.
     */
    async liveGuide(signal) {
      const { playlist, guideUrl } = await firstLine(signal);

      if (!playlist) throw notAPlaylist(account.link);

      if (!guideUrl) return { kind: "none" };

      // As it comes: the guide service unpacks one that is gzip, as guides named .xml.gz are.
      return { kind: "document", ...(await open(guideUrl, GUIDE_TIMEOUT_MS, signal)) };
    },

    async onDemandCatalogue(signal) {
      return (await fresh(signal)).snapshot.catalogue;
    },

    async playlistImport(signal, refresh) {
      const read = refresh ? await fresh(signal) : (last ?? (await fresh(signal, true)));

      signal?.throwIfAborted();

      return refresh ? read.snapshot : read.inspect();
    },

    async movieDetails(id, signal) {
      const imported = (last ?? (await fresh(signal))).snapshot;
      const details = imported.details.get(id);

      if (!details || !imported.catalogue.movies.some((each) => each.id === id)) {
        throw new AppFailure({ kind: "title-not-found", titleId: id });
      }

      return details;
    },

    async seriesDetails(id, signal) {
      const imported = (last ?? (await fresh(signal))).snapshot;
      const details = imported.details.get(id);

      if (!details || !imported.catalogue.series.some((each) => each.id === id))
        throw new AppFailure({ kind: "title-not-found", titleId: id });

      return details;
    },

    async titleFile(kind, id, _container, signal) {
      const imported = (last ?? (await fresh(signal))).snapshot;
      const file = imported.files.get(id);

      if (!file || kind !== file.kind)
        throw new AppFailure({ kind: "title-not-found", titleId: id });

      return file;
    },
  };
}

/**
 * Query names a playlist link's login goes by. Their values are as much the login as the user and
 * password before the host.
 */
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
 * What in playlist links is a login (see `ProviderLogin`): the user and password before the host,
 * and the values of `LOGIN_NAMES`. Any other query value, such as `output=ts`, can be a setting
 * as well as a token under a name of the publisher's own, so it is uncertain.
 */
function loginIn(...links: string[]): ProviderLogin {
  const secrets: string[] = [];
  const uncertain: string[] = [];

  for (const link of links) {
    const url = new URL(link);
    secrets.push(decoded(url.username), decoded(url.password));

    for (const [name, value] of url.searchParams)
      (LOGIN_NAMES.has(name.toLowerCase()) ? secrets : uncertain).push(value);
  }

  return { secrets, uncertain };
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function notAPlaylist(link: string): AppFailure {
  return new AppFailure({
    kind: "unreachable",
    server: new URL(link).origin,
    detail: t("The address answered, but not with a playlist."),
  });
}
