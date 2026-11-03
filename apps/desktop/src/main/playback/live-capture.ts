// One provider request per live source, however many read it. Watch and a recording of the same
// channel's stream ask for the same address under the same login: the first request opens the
// provider's stream, and each later one, while it runs, reads the same bytes from its live edge
// instead of asking the provider again. Only the exact source is shared: the subscription, the
// login revision it was looked up under, the channel, which of its streams, that stream's format,
// the address and the headers sent with it. Another channel, stream, login or header set opens
// its own request, also where two channels of a playlist name one address.
//
// The provider's bytes go into the capture's history (./live-history.ts), and each reader reads
// them from there at its own pace, so a slow or stopped reader never holds the others or the
// provider back: it falls behind, and once what it needs is evicted its stream fails with
// `FellBehind`. A reader leaves when its signal aborts or its body is cancelled; the last one
// aborts the provider's request and removes the history, and the next request for that source
// waits for that before it asks the provider again. A stream the provider ends, or leaves silent
// for SILENCE_MS, ends every reader once each has read the rest, and the next request opens a new
// one: bytes from two requests never meet in one reader.
//
// An HLS stream is many requests, not one: its playlist, read again and again, and its segments.
// Those of a clear media playlist are shared through `resource` (./hls-capture.ts), so Watch and a
// recording ask the provider for each once. Of a multivariant playlist, both hold one variant
// while they share it: `fixed` says which, and `fixedChanged` when that changed.
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { DEFAULT_KEEP_FREE } from "@mrstreamer/contracts/recordings";
import type { StreamFormat } from "@mrstreamer/contracts/playback";
import type { LiveStream } from "@mrstreamer/core/provider";
import { PlaybackCoordination } from "../services/playback-coordination.ts";
import { hlsShares } from "./hls-capture.ts";
import { historyStore, PIECE_BYTES, TEMPORARY_BYTES, type History } from "./live-history.ts";

const PACKET = 188;
const SYNC = 0x47;

/** How long the provider may send nothing before its stream counts as broken, as a recording's. */
const SILENCE_MS = 15_000;

/** What a live source is, exactly: what must match for two readers to share its request. */
export interface CaptureSource {
  readonly subscriptionId: string;
  /** The login revision its address was looked up under. */
  readonly revision: number;
  /** The channel as the library names it, never another of its streams' ids. */
  readonly channelId: string;
  /** Which of the channel's streams. */
  readonly variantId: string;
  readonly format: StreamFormat;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Names a source for `request`, `resource` and `reading`, and its connection for coordination. */
export function captureKey(source: CaptureSource): string {
  const headers = Object.entries(source.headers)
    .map(([name, value]) => [name.toLowerCase(), value])
    .toSorted(([a = ""], [b = ""]) => a.localeCompare(b));

  const { subscriptionId, revision, channelId, variantId, format, url } = source;

  return JSON.stringify([
    "live",
    subscriptionId,
    revision,
    channelId,
    variantId,
    format,
    url,
    headers,
  ]);
}

/**
 * The key of the channel's stream `variantId`, looked up under `revision`; null without one.
 * `channelId` is the channel's own id, as the library lists it.
 */
export function streamKey(
  subscriptionId: string,
  revision: number,
  channelId: string,
  variantId: string,
  stream: LiveStream | null,
) {
  if (!stream) return null;
  const { format, url } = stream;
  const headers = stream.headers ?? {};

  return captureKey({ subscriptionId, revision, channelId, variantId, format, url, headers });
}

/** The provider sent nothing for SILENCE_MS: what reads it ends, and the next request asks anew. */
class Silent extends Error {
  constructor() {
    super("The provider stopped sending.");
  }
}

/** A reader whose bytes were evicted before it read them: it read too slowly. */
export class FellBehind extends Error {
  constructor() {
    super("The stream moved on before it was read.");
  }
}

interface Capture {
  readonly key: string;
  readonly history: History;
  readonly controller: AbortController;
  readonly status: number;
  readonly headers: Headers;
  /** Where the stream's packets begin: the first sync byte. */
  origin: number | null;
  failure: unknown;
  /** Where each reader is in the stream. */
  readonly readers: Set<{ cursor: number }>;
  /** Settles once the provider's request ended. */
  readonly pumped: Promise<void>;
  /** Settles once the request ended and the history is gone; set by the last reader leaving. */
  closing: Promise<void> | null;
}

type Entry =
  | { readonly kind: "opening"; readonly opened: Promise<Capture | null> }
  | { readonly kind: "open"; readonly capture: Capture }
  | { readonly kind: "closing"; readonly closed: Promise<void> };

export interface LiveCapturesOptions {
  /** Where histories keep their pieces; emptied as the app starts. */
  readonly folder: string;
  /** Bytes every history's files may take together; TEMPORARY_BYTES unless given. */
  readonly bytes?: number;
  readonly pieceBytes?: number;
  readonly keepFree?: number;
  /** SILENCE_MS unless given. */
  readonly silenceMs?: number;
}

export class LiveCaptures extends Context.Service<
  LiveCaptures,
  {
    /**
     * Answers a request for the live stream `key` names: from the capture reading it now, from
     * its live edge, or else through `open`, whose answer this reader gets from its start. An
     * answer that isn't a stream, as a refusal, comes back as it is and is shared with nobody.
     * `owner` names the play or recording that reads it, and `signal` ends its reading.
     */
    request(
      key: string,
      owner: string,
      open: (signal: AbortSignal) => Promise<Response>,
      signal: AbortSignal,
    ): Promise<Response>;
    /**
     * Answers `address` of the HLS stream `key` names, the playlist or one of its segments: from
     * what the provider answered another reader of that stream, else through `open`, as
     * ./hls-capture.ts says. `owner` names the play or recording that reads it, `signal` ends
     * this answer, and `joining` says it was admitted to share what reads `key` now.
     */
    resource(
      key: string,
      owner: string,
      address: string,
      open: (address: string, signal: AbortSignal) => Promise<Response>,
      signal: AbortSignal,
      joining?: boolean,
    ): Promise<Response>;
    /** Whether something reads `key` now, so reading it too asks the provider nothing more. */
    reading(key: string): boolean;
    /**
     * The variant of the multivariant HLS stream `key` a reader joining it now holds, as its
     * playlist names it; null for any other stream, or one nothing reads.
     */
    joins(key: string): string | null;
    /**
     * The variant `owner` holds while it shares a multivariant HLS stream with another reader,
     * as its playlist names it; null while it reads what it asks for.
     */
    fixed(owner: string): string | null;
    /** Owners whose `fixed` changed. */
    readonly fixedChanged: Stream.Stream<string>;
    /**
     * Settles once each request `owner` still had opening has settled, and each capture it was
     * the last reader of has ended its request and removed its history, and each HLS stream its
     * requests. Asked after the owner's reading ended.
     */
    idle(owner: string): Promise<void>;
  }
>()("mrstreamer/LiveCaptures") {
  static readonly layer = (options: LiveCapturesOptions) =>
    Layer.effect(LiveCaptures, make(options));
}

/** The default folder in the app's data folder. */
export const historyFolder = (dataDir: string) => join(dataDir, "live-history");

function make(options: LiveCapturesOptions) {
  return Effect.gen(function* () {
    const coordination = yield* PlaybackCoordination;

    const store = historyStore({
      folder: options.folder,
      bytes: options.bytes ?? TEMPORARY_BYTES,
      pieceBytes: options.pieceBytes ?? PIECE_BYTES,
      keepFree: options.keepFree ?? DEFAULT_KEEP_FREE,
    });

    const entries = new Map<string, Entry>();
    const changes = yield* PubSub.unbounded<string>();

    const hls = hlsShares({
      connected: coordination.connected,
      changed: (owner) => PubSub.publishUnsafe(changes, owner),
    });

    /** What each owner's leaving closed, and its requests still under way, for `idle`. */
    const closings = new Map<string, Set<Promise<void>>>();
    const asking = new Map<string, Set<Promise<void>>>();

    const own = (owners: Map<string, Set<Promise<void>>>, owner: string, work: Promise<void>) => {
      const set = owners.get(owner) ?? new Set();
      set.add(work);
      owners.set(owner, set);
    };

    const close = (capture: Capture) => {
      if (capture.closing) return capture.closing;
      capture.controller.abort();
      const closing = capture.pumped.then(() => capture.history.close());
      capture.closing = closing;
      const entry = entries.get(capture.key);

      if (entry?.kind === "open" && entry.capture === capture) {
        entries.set(capture.key, { kind: "closing", closed: closing });
        void closing.then(() => {
          if (entries.get(capture.key)?.kind === "closing") entries.delete(capture.key);
        });
      }

      return closing;
    };

    /** Reads the provider's stream into the history until it ends or the last reader left. */
    const pump = async (capture: Capture, body: ReadableStream<Uint8Array>) => {
      const reader = body.getReader();
      const silenceMs = options.silenceMs ?? SILENCE_MS;

      try {
        for (;;) {
          let timer: NodeJS.Timeout | undefined;

          const silent = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Silent()), silenceMs);
          });

          const { done, value } = await Promise.race([reader.read(), silent]).finally(() =>
            clearTimeout(timer),
          );

          if (done) break;

          if (capture.origin === null) {
            const at = value.indexOf(SYNC);

            if (at >= 0) capture.origin = capture.history.end() + at;
          }

          capture.history.append(value);
        }
      } catch (cause) {
        if (!capture.controller.signal.aborted) capture.failure = cause;
      } finally {
        await reader.cancel().catch(() => {});
        capture.history.finish();
        // Its request is over: the next one for this source opens anew.
        const entry = entries.get(capture.key);

        if (entry?.kind === "open" && entry.capture === capture) entries.delete(capture.key);
      }
    };

    /** A reader's answer, from `offset`. */
    const attach = (capture: Capture, owner: string, offset: number, signal: AbortSignal) => {
      const reading = { cursor: offset };
      capture.readers.add(reading);
      coordination.connected(owner, capture.key);
      let left = false;
      let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stop = new AbortController();

      const leave = () => {
        if (left) return;
        left = true;
        signal.removeEventListener("abort", aborted);
        stop.abort();
        capture.readers.delete(reading);

        if (capture.readers.size > 0) return;
        own(closings, owner, close(capture));
      };

      const aborted = () => {
        leave();

        try {
          stream?.error(signal.reason);
        } catch {
          // Already closed.
        }
      };

      signal.addEventListener("abort", aborted, { once: true });

      const body = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            stream = controller;

            if (signal.aborted) aborted();
          },
          pull: async (controller) => {
            for (;;) {
              if (left) return;
              const read = await capture.history.read(reading.cursor);

              if (left) return;

              if (read instanceof Uint8Array) {
                reading.cursor += read.length;

                return controller.enqueue(read);
              }

              if (read === "evicted") {
                leave();

                return controller.error(new FellBehind());
              }

              if (capture.history.finished()) {
                leave();

                return capture.failure ? controller.error(capture.failure) : controller.close();
              }

              await capture.history.arrived(reading.cursor, stop.signal);
            }
          },
          cancel: leave,
        },
        { highWaterMark: 0 },
      );

      return new Response(body, { status: capture.status, headers: capture.headers });
    };

    /**
     * Where a reader joining now begins: the first packet boundary at or after the live edge, so
     * nothing before it, which may already be gone, is ever asked for.
     */
    const edge = (capture: Capture) => {
      const end = capture.history.end();

      if (capture.origin === null) return end;

      return capture.origin + Math.ceil((end - capture.origin) / PACKET) * PACKET;
    };

    const request = (
      key: string,
      owner: string,
      open: (signal: AbortSignal) => Promise<Response>,
      signal: AbortSignal,
    ): Promise<Response> => {
      const answer = ask(key, owner, open, signal);

      // Until it settles, `idle` waits for it: a request abandoned while it opens still ends.
      const settled = answer.then(
        () => {},
        () => {},
      );

      own(asking, owner, settled);
      void settled.then(() => asking.get(owner)?.delete(settled));

      return answer;
    };

    const ask = async (
      key: string,
      owner: string,
      open: (signal: AbortSignal) => Promise<Response>,
      signal: AbortSignal,
    ): Promise<Response> => {
      for (;;) {
        signal.throwIfAborted();
        const entry = entries.get(key);

        if (entry?.kind === "closing") {
          await entry.closed;
          continue;
        }

        if (entry?.kind === "opening") {
          const capture = await entry.opened;

          // It failed, its reader left as it opened, or the provider ended it at once: this request
          // asks the provider itself.
          if (!capture || capture.closing || capture.history.finished()) {
            if (entries.get(key) === entry) entries.delete(key);
            continue;
          }

          signal.throwIfAborted();

          return attach(capture, owner, edge(capture), signal);
        }

        if (entry?.kind === "open")
          return attach(entry.capture, owner, edge(entry.capture), signal);

        const controller = new AbortController();
        // Until it answers, the request is this reader's alone: its abort ends it.
        const abandon = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abandon, { once: true });

        const answered = open(controller.signal).finally(() =>
          signal.removeEventListener("abort", abandon),
        );

        const started = answered.then((response): Capture | null => {
          if (!response.ok || !response.body) return null;
          const { promise: pumped, resolve } = Promise.withResolvers<void>();
          const readers = new Set<{ cursor: number }>();

          const capture: Capture = {
            key,
            // Only what a reader hasn't read yet is kept.
            history: store.create(() =>
              Math.min(Infinity, ...[...readers].map((each) => each.cursor)),
            ),
            controller,
            status: response.status,
            headers: new Headers(response.headers),
            origin: null,
            failure: null,
            readers,
            pumped,
            closing: null,
          };

          void pump(capture, response.body).then(resolve);

          return capture;
        });

        const opening: Entry = { kind: "opening", opened: started.catch(() => null) };
        entries.set(key, opening);
        let capture: Capture | null;

        try {
          capture = await started;
        } finally {
          if (entries.get(key) === opening) entries.delete(key);
        }

        if (!capture) return answered;
        entries.set(key, { kind: "open", capture });

        return attach(capture, owner, 0, signal);
      }
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const open = [...entries.values()].flatMap((entry) =>
          entry.kind === "open" ? [entry.capture] : [],
        );

        await Promise.all([...open.map(close), hls.close()]);
      }),
    );

    return {
      request,
      resource: hls.resource,
      reading: (key: string) => {
        const entry = entries.get(key);

        // One still opening counts once its provider answered and its reader attached, as
        // admission counts its connection as the capture's from then.
        return entry?.kind === "open" || hls.reading(key);
      },
      joins: hls.joins,
      fixed: hls.fixed,
      fixedChanged: Stream.fromPubSub(changes),
      idle: async (owner: string) => {
        await hls.leave(owner);
        // A request still opening may yet attach and leave, closing what it read last.
        await Promise.all(asking.get(owner) ?? []);
        asking.delete(owner);
        const closed = closings.get(owner);
        closings.delete(owner);

        if (closed) await Promise.all(closed);
      },
    };
  });
}
