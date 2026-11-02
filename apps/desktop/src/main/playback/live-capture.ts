// One provider request per live MPEG-TS source, however many read it. Watch and a recording of
// the same channel ask for the same address under the same login: the first request opens the
// provider's stream, and each later one, while it runs, reads the same bytes from its live edge
// instead of asking the provider again. Only the exact source is shared: the subscription, the
// login revision it was looked up under, the address and the headers sent with it. Another
// channel, stream, login or header set opens its own request.
//
// The provider's bytes go into the capture's history (./live-history.ts), and each reader reads
// them from there at its own pace, so a slow or stopped reader never holds the others or the
// provider back: it falls behind, and once what it needs is evicted its stream fails with
// `FellBehind`. A reader leaves when its signal aborts or its body is cancelled; the last one
// aborts the provider's request and removes the history, and the next request for that source
// waits for that before it asks the provider again. A stream the provider ends ends every
// reader once each has read the rest, and the next request opens a new one: bytes from two
// requests never meet in one reader.
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DEFAULT_KEEP_FREE } from "@mrstreamer/contracts/recordings";
import type { LiveStream } from "@mrstreamer/core/provider";
import { PlaybackCoordination } from "../services/playback-coordination.ts";
import { historyStore, PIECE_BYTES, TEMPORARY_BYTES, type History } from "./live-history.ts";

const PACKET = 188;
const SYNC = 0x47;

/** What a live source is, exactly: what must match for two readers to share its request. */
export interface CaptureSource {
  readonly subscriptionId: string;
  /** The login revision its address was looked up under. */
  readonly revision: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Names a source for `request` and `reading`, and its connection for PlaybackCoordination. */
export function captureKey(source: CaptureSource): string {
  const headers = Object.entries(source.headers)
    .map(([name, value]) => [name.toLowerCase(), value])
    .toSorted(([a = ""], [b = ""]) => a.localeCompare(b));
  return JSON.stringify(["live", source.subscriptionId, source.revision, source.url, headers]);
}

/** The key of a channel's live stream looked up under `revision`; null unless it is MPEG-TS. */
export function streamKey(subscriptionId: string, revision: number, stream: LiveStream | null) {
  if (stream?.format !== "mpegts") return null;
  return captureKey({ subscriptionId, revision, url: stream.url, headers: stream.headers ?? {} });
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
  /** How many read it now. */
  readers: number;
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
    /** Whether a capture reads `key` now, so a request for it asks the provider nothing. */
    reading(key: string): boolean;
    /**
     * Settles once each capture `owner` was the last reader of has ended its request and
     * removed its history. Asked after the owner's reading ended.
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
    /** What each owner's leaving closed, for `idle`. */
    const closings = new Map<string, Set<Promise<void>>>();

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
      try {
        for (;;) {
          const { done, value } = await reader.read();
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
      capture.readers++;
      coordination.connected(owner, capture.key);
      let cursor = offset;
      let left = false;
      let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stop = new AbortController();
      const leave = () => {
        if (left) return;
        left = true;
        signal.removeEventListener("abort", aborted);
        stop.abort();
        if (--capture.readers > 0) return;
        const closing = close(capture);
        const own = closings.get(owner) ?? new Set();
        own.add(closing);
        closings.set(owner, own);
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
              const read = await capture.history.read(cursor);
              if (left) return;
              if (read instanceof Uint8Array) {
                cursor += read.length;
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
              await capture.history.arrived(cursor, stop.signal);
            }
          },
          cancel: leave,
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: capture.status, headers: capture.headers });
    };

    /** Where a reader joining now begins: the packet boundary at or before the live edge. */
    const edge = (capture: Capture) => {
      const end = capture.history.end();
      if (capture.origin === null) return end;
      return capture.origin + Math.floor((end - capture.origin) / PACKET) * PACKET;
    };

    const request = async (
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
          // It failed: this request asks the provider itself.
          if (!capture) {
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
          const capture: Capture = {
            key,
            history: store.create(),
            controller,
            status: response.status,
            headers: new Headers(response.headers),
            origin: null,
            failure: null,
            readers: 0,
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
        await Promise.all(open.map(close));
      }),
    );

    return {
      request,
      reading: (key: string) => {
        const entry = entries.get(key);
        return entry?.kind === "open" || entry?.kind === "opening";
      },
      idle: async (owner: string) => {
        const own = closings.get(owner);
        closings.delete(owner);
        if (own) await Promise.all(own);
      },
    };
  });
}
