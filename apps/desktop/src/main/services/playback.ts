// Stream sessions and the loopback proxy that serves them to the UI.
//
// The UI never sees provider URLs: they carry the login. It gets a 127.0.0.1 URL with a random
// token instead. Only one session is open at a time, so switching channels always releases the
// previous provider connection first. Many subscriptions allow a single connection.
//
// The proxy reads the start of each MPEG-TS stream to learn its codecs. A stream the UI's player
// decodes passes through untouched; otherwise ffmpeg converts only the tracks it cannot decode.
//
// Each session is a scope within the service's. Closing it, by stopping, switching or quitting,
// aborts its upstream requests, which ends their ffmpeg processes; the proxy closes with the
// service.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type {
  Codec,
  StreamFailure,
  StreamFormat,
  StreamSession,
} from "@mrstreamer/contracts/playback";
import { Failed } from "@mrstreamer/core/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { createCleanStart } from "../playback/clean-start.ts";
import { ffmpegArguments, planConversion, type Conversion } from "../playback/convert.ts";
import { createInspector, type Inspection, type StreamLayout } from "../playback/inspect.ts";
import { Subscriptions } from "./subscription.ts";

/** How long the provider gets to start answering before the stream counts as failed. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Waits before retrying a refused stream. Providers can take a moment to free the slot of a stream we just closed. */
const REFUSED_RETRY_DELAYS_MS = [500, 1500];
/** Video codecs whose streams start on a keyframe; see ../playback/clean-start.ts. */
const CLEAN_START_CODECS: ReadonlySet<Codec> = new Set(["h264", "hevc", "hevc-10bit"]);
/** How much of a stream the proxy reads, at most, before deciding how to deliver it. */
const INSPECT_LIMIT = { bytes: 2 * 1024 * 1024, ms: 2500 };

interface Session {
  readonly id: string;
  readonly token: string;
  readonly channelId: string;
  readonly upstreamUrl: string;
  readonly format: StreamFormat;
  /** What the UI's player decodes. */
  readonly decoders: ReadonlySet<Codec>;
  /** Re-encode the picture even when the player could decode it; see `open`. */
  readonly repair: boolean;
  /** Aborts every upstream request of this session when its scope closes. */
  readonly closed: AbortController;
  readonly scope: Scope.Closeable;
  /** The request currently being served. A new request for the same session replaces it. */
  active: AbortController | null;
  failure: StreamFailure | null;
}

export interface PlaybackDeps {
  readonly userAgent: string;
  /** The ffmpeg executable that converts streams, or null when this build has none. */
  readonly ffmpeg: string | null;
  readonly fetch?: typeof fetch;
}

export class Playback extends Context.Service<
  Playback,
  {
    /**
     * Opens a stream for a channel. Closes any open stream first. `decoders` lists what the
     * UI's player decodes; the proxy converts the rest. `repair` re-encodes the picture too, for
     * a broadcast the player failed to decode: ffmpeg conceals damage that stops the player.
     */
    open(
      channelId: string,
      decoders: readonly Codec[],
      options?: { readonly repair?: boolean },
    ): Effect.Effect<StreamSession, Failed>;
    /** Closes a stream and its provider connection. Unknown or already closed ids are ignored. */
    close(sessionId: string): Effect.Effect<void>;
    /** Closes every open stream, for example when the window closes. */
    readonly closeAll: Effect.Effect<void>;
    /** Why the session's last upstream request failed, or null. */
    failure(sessionId: string): Effect.Effect<StreamFailure | null>;
  }
>()("mrstreamer/Playback") {
  static readonly layer = (deps: PlaybackDeps) => Layer.effect(Playback, make(deps));
}

function make(deps: PlaybackDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const scope = yield* Effect.scope;
    const fetchImpl = deps.fetch ?? fetch;
    const sessions = new Map<string, Session>();
    /** Opens one at a time, so switching fast never leaves two sessions open. */
    const openOne = (yield* Semaphore.make(1)).withPermits(1);
    const { port } = yield* Effect.acquireRelease(
      Effect.promise(() => listen((request, response) => void serve(request, response))),
      ({ server }) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    );

    const closeAll = Effect.suspend(() =>
      Effect.forEach([...sessions.values()], (session) => Scope.close(session.scope, Exit.void)),
    ).pipe(Effect.asVoid);

    // Sessions close before the proxy does.
    yield* Effect.addFinalizer(() => closeAll);

    async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cache-Control", "no-store");
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Access-Control-Allow-Headers": "Range" }).end();
        return;
      }
      const token = /^\/stream\/([\w-]+)\.\w+$/.exec(request.url ?? "")?.[1];
      const session = [...sessions.values()].find((candidate) => candidate.token === token);
      if (!session || request.method !== "GET") {
        response.writeHead(410).end();
        return;
      }

      session.active?.abort();
      const active = new AbortController();
      session.active = active;
      response.on("close", () => active.abort());
      const signal = AbortSignal.any([session.closed.signal, active.signal]);

      const upstream = await connect(session, signal);
      if (signal.aborted) {
        response.destroy();
        return;
      }
      if (!upstream.ok) {
        session.failure = upstream.failure;
        response.writeHead("status" in upstream.failure ? upstream.failure.status : 502).end();
        return;
      }

      const reader = upstream.body.getReader();
      const start = await inspectStart(reader, session.decoders);
      if (signal.aborted) {
        void reader.cancel().catch(() => {});
        response.destroy();
        return;
      }
      const video = start.layout?.video;
      const chunks =
        video && video.codec !== "unknown" && CLEAN_START_CODECS.has(video.codec)
          ? cleanStart(replay(start, reader), createCleanStart(video.pid, video.codec))
          : replay(start, reader);
      const body = Readable.from(chunks);
      body.on("error", (cause) => {
        if (!signal.aborted) session.failure = { kind: "network", detail: String(cause) };
        response.destroy();
      });

      const conversion = start.layout
        ? planConversion(start.layout, session.decoders, { repair: session.repair })
        : null;
      if (!conversion) {
        response.writeHead(200, { "Content-Type": upstream.contentType ?? "video/mp2t" });
        body.pipe(response);
        return;
      }
      if (!deps.ffmpeg) {
        session.failure = { kind: "unsupported", detail: describeLayout(start.layout) };
        body.destroy();
        response.writeHead(415).end();
        return;
      }
      convert(deps.ffmpeg, conversion, body, response, session, signal);
    }

    /** Pipes the stream through ffmpeg. A conversion that fails counts as an unsupported stream. */
    function convert(
      ffmpeg: string,
      conversion: Conversion,
      body: Readable,
      response: ServerResponse,
      session: Session,
      signal: AbortSignal,
    ): void {
      const child = spawn(ffmpeg, ffmpegArguments(conversion), { stdio: ["pipe", "pipe", "pipe"] });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-2000);
      });
      const stop = () => child.kill("SIGKILL");
      signal.addEventListener("abort", stop, { once: true });
      child.on("error", (cause) => {
        if (!signal.aborted) session.failure = { kind: "unsupported", detail: String(cause) };
        response.destroy();
      });
      // "close" comes after ffmpeg's output has been read, so a stream that ends normally reaches
      // the player whole; only a failed conversion cuts the response.
      child.on("close", (code) => {
        signal.removeEventListener("abort", stop);
        body.destroy();
        if (code === 0 || signal.aborted) return;
        if (!session.failure) {
          const detail = errors.trim().split("\n").at(-1) ?? `ffmpeg exited with ${code}`;
          session.failure = {
            kind: "unsupported",
            detail: `The stream could not be converted. ${detail}`,
          };
        }
        response.destroy();
      });
      // ffmpeg stops reading when it fails or is killed; that write error is not the stream's.
      child.stdin.on("error", () => {});
      body.pipe(child.stdin);
      response.writeHead(200, { "Content-Type": "video/mp2t" });
      child.stdout.pipe(response);
    }

    /** Opens the upstream request, retrying briefly when the provider refuses. */
    async function connect(
      session: Session,
      signal: AbortSignal,
    ): Promise<
      | { ok: true; body: ReadableStream<Uint8Array>; contentType: string | null }
      | { ok: false; failure: StreamFailure }
    > {
      for (let attempt = 0; ; attempt++) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), CONNECT_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetchImpl(session.upstreamUrl, {
            headers: { "User-Agent": deps.userAgent },
            signal: AbortSignal.any([signal, timeout.signal]),
          });
        } catch (cause) {
          return {
            ok: false,
            failure: {
              kind: "network",
              detail: timeout.signal.aborted
                ? "The provider did not answer in time."
                : String(cause),
            },
          };
        } finally {
          clearTimeout(timer);
        }

        if (response.ok && response.body) {
          return {
            ok: true,
            body: response.body,
            contentType: response.headers.get("content-type"),
          };
        }
        await response.body?.cancel();
        const failure = classify(response.status);
        const delay = REFUSED_RETRY_DELAYS_MS[attempt];
        if (failure.kind !== "refused" || delay === undefined || signal.aborted)
          return { ok: false, failure };
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return {
      open: (
        channelId: string,
        decoders: readonly Codec[],
        options: { readonly repair?: boolean } = {},
      ) =>
        openOne(
          Effect.gen(function* () {
            const source = yield* subscriptions.source;
            if (!source) return yield* new Failed({ error: { kind: "no-subscription" } });
            yield* closeAll;

            const upstream = source.provider.liveStream(channelId);
            const id = randomUUID();
            const closed = new AbortController();
            const sessionScope = yield* Scope.fork(scope);
            yield* Scope.addFinalizer(
              sessionScope,
              Effect.sync(() => {
                closed.abort();
                sessions.delete(id);
              }),
            );
            const session: Session = {
              id,
              token: randomBytes(18).toString("base64url"),
              channelId,
              upstreamUrl: upstream.url,
              format: upstream.format,
              decoders: new Set(decoders),
              repair: options.repair ?? false,
              closed,
              scope: sessionScope,
              active: null,
              failure: null,
            };
            sessions.set(id, session);
            const extension = upstream.format === "mpegts" ? "ts" : "m3u8";
            return {
              sessionId: id,
              channelId,
              url: `http://127.0.0.1:${port}/stream/${session.token}.${extension}`,
              format: upstream.format,
            };
          }),
        ),

      close: (sessionId: string) =>
        Effect.suspend(() => {
          const session = sessions.get(sessionId);
          return session ? Scope.close(session.scope, Exit.void) : Effect.void;
        }),

      closeAll,

      failure: (sessionId: string) => Effect.sync(() => sessions.get(sessionId)?.failure ?? null),
    };
  });
}

/** Starts the proxy on a free loopback port. */
function listen(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const http = createServer(handle);
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      const address = http.address();
      if (address && typeof address === "object") resolve({ server: http, port: address.port });
      else reject(new Error("Stream proxy has no TCP address."));
    });
  });
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

interface StreamStart {
  /** The tracks, or null when the data is not MPEG-TS. */
  readonly layout: StreamLayout | null;
  /** What was read while inspecting; the player still needs it. */
  readonly head: readonly Uint8Array[];
  /** A read still in flight when time ran out. */
  readonly pending: Promise<ReadResult> | null;
}

/**
 * Reads until the stream's codecs settle how to deliver it, or the inspection limit is reached.
 * A track can stay undetermined when every codec it may turn out to be gets the same treatment.
 */
async function inspectStart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoders: ReadonlySet<Codec>,
): Promise<StreamStart> {
  const inspector = createInspector();
  const head: Uint8Array[] = [];
  let size = 0;
  let latest: Inspection | null = null;
  let pending: Promise<ReadResult> | null = null;
  const deadline = Date.now() + INSPECT_LIMIT.ms;
  while (size < INSPECT_LIMIT.bytes) {
    pending ??= reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
    });
    const result = await Promise.race([pending, expired]).catch(() => null);
    clearTimeout(timer);
    if (result === null) break;
    pending = null;
    if (result.done) break;
    head.push(result.value);
    size += result.value.length;
    latest = inspector.push(result.value) ?? latest;
    const settled = latest?.open.every((candidates) => {
      const decoded = candidates.filter((codec) => decoders.has(codec)).length;
      return decoded === 0 || decoded === candidates.length;
    });
    if (latest && settled) return { layout: latest.layout, head, pending: null };
    if (inspector.notTransportStream) return { layout: null, head, pending: null };
  }
  return { layout: latest?.layout ?? null, head, pending };
}

/** The inspected start of the stream followed by the rest of it. */
async function* replay(
  start: StreamStart,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    yield* start.head;
    if (start.pending) {
      const result = await start.pending;
      if (result.done) return;
      yield result.value;
    }
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** The stream from its first decodable picture on. */
async function* cleanStart(
  chunks: AsyncGenerator<Uint8Array>,
  filter: ReturnType<typeof createCleanStart>,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    const filtered = filter.push(chunk);
    if (filtered.length > 0) yield filtered;
  }
}

/** "HEVC 10-bit video and MP2 sound", for a stream this build cannot convert. */
function describeLayout(layout: StreamLayout | null): string {
  const video = layout?.video?.codec;
  const audio = layout?.audio[0]?.codec;
  const parts = [video && `${video} video`, audio && `${audio} sound`].filter(Boolean);
  return `This stream carries ${parts.join(" and ") || "an unknown format"}.`;
}

function classify(status: number): StreamFailure {
  if (status === 401 || status === 403 || status === 429 || status === 458 || status === 509) {
    return { kind: "refused", status };
  }
  if (status === 404 || status === 410) return { kind: "unavailable", status };
  return { kind: "provider-error", status };
}
