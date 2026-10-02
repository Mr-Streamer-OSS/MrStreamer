// Stream sessions and the loopback proxy that serves them to the UI.
//
// The UI never sees provider URLs: they carry the login. It gets a 127.0.0.1 URL with a random
// token instead. Only one session is open at a time, live or on demand, so switching always
// releases the previous provider connection first. Many subscriptions allow a single connection.
//
// Live: the proxy reads the start of each MPEG-TS stream to learn its codecs. A stream the UI's
// player decodes passes through untouched; otherwise ffmpeg converts only the tracks it cannot
// decode. A channel with several streams, one per quality, can be given more than one to try, as
// Auto is: when the provider doesn't deliver one, the proxy asks for the next, after the request
// before is over, and never after a refusal, which is the account's. Streams that failed in the
// last two minutes go last, so reconnecting doesn't wait for one again.
//
// Movies and episodes (see ../playback/title.ts): the proxy serves the provider's file to ffprobe
// and ffmpeg over loopback, answering byte ranges, one upstream request at a time. Each request
// from the player runs ffmpeg from a position with the chosen tracks, and replaces the run before.
//
// Each session is a scope within the service's. Closing it, by stopping, switching or quitting,
// aborts its upstream requests, which ends their ffmpeg processes; the proxy closes with the
// service.
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type {
  ChannelTracks,
  Codec,
  LivePlaying,
  StreamFailure,
  StreamFormat,
  StreamSession,
  TitleSession,
} from "@mrstreamer/contracts/playback";
import { audioTracks, languageCode, subtitleTracks } from "@mrstreamer/core/ondemand/tracks";
import { Diagnostics } from "@mrstreamer/core/diagnostics";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import type { Provider } from "@mrstreamer/core/provider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { createCleanStart } from "../playback/clean-start.ts";
import { ffmpegArguments, planConversion, type Conversion } from "../playback/convert.ts";
import { createInspector, type Inspection, type StreamLayout } from "../playback/inspect.ts";
import { CAPTION_PID, createCaptionCopy } from "../playback/caption-stream.ts";
import { createAudioChoice } from "../playback/program-table.ts";
import { captionsInPicture } from "@mrstreamer/core/subtitles/captions";
import { pgsSegments } from "@mrstreamer/core/subtitles/pgs";
import { pesReader, type PesPacket } from "@mrstreamer/core/subtitles/transport";
import {
  firstPacketTime,
  PROBE_ARGUMENTS,
  readProbe,
  titlePlan,
  type TitleProbe,
  type TitleRun,
} from "../playback/title.ts";
import { Subscriptions } from "./subscription.ts";

/** How long the provider gets to start answering before the stream counts as failed. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Waits before retrying a refused stream. Providers can take a moment to free the slot of a stream we just closed. */
const REFUSED_RETRY_DELAYS_MS = [500, 1500];
/**
 * The same for a movie's file, which ffmpeg reads in several ranges one after the other: a seek
 * closes one request and opens the next at once, so the first retry comes sooner.
 */
const FILE_RETRY_DELAYS_MS = [150, 400, 1000, 2000];
/** Video codecs whose streams start on a keyframe; see ../playback/clean-start.ts. */
const CLEAN_START_CODECS: ReadonlySet<Codec> = new Set(["h264", "hevc", "hevc-10bit"]);
/** How much of a stream the proxy reads, at most, before deciding how to deliver it. */
const INSPECT_LIMIT = { bytes: 2 * 1024 * 1024, ms: 2500 };
/** How long ffprobe may take to read what a movie's file holds. */
const PROBE_TIMEOUT_MS = 30_000;
/** How long a run may take to show where its picture starts, before it counts as failed. */
const RUN_START_TIMEOUT_MS = 30_000;
/** Probes kept for files opened again, such as when resuming. */
const PROBES_KEPT = 32;
/** How long a channel's stream that failed goes after its others when Auto tries them again. */
const FAILED_STREAM_MS = 2 * 60_000;

interface SessionBase {
  readonly id: string;
  readonly token: string;
  /** What the UI's player decodes. */
  readonly decoders: ReadonlySet<Codec>;
  /** Requests the upstream addresses through the provider, which never sends the login unencrypted. */
  readonly request: Provider["request"];
  /** Aborts every upstream request of this session when its scope closes. */
  readonly closed: AbortController;
  readonly scope: Scope.Closeable;
  /** The request currently being served. A new request for the same session replaces it. */
  active: AbortController | null;
  failure: StreamFailure | null;
}

interface LiveSession extends SessionBase {
  readonly kind: "live";
  readonly channelId: string;
  /** The channel's streams to try, in order, with their upstream addresses. */
  readonly variants: readonly { readonly id: string; readonly url: string }[];
  /** Which stream plays, and those that failed before it: see `Playback.playing`. */
  delivered: LivePlaying;
  readonly format: StreamFormat;
  /** Re-encode the picture even when the player could decode it; see `open`. */
  readonly repair: boolean;
  /** The sound track chosen by PID, or null for the channel's first. */
  readonly audio: number | null;
  /** Without a chosen track, the language whose sound plays when the channel has it. */
  readonly audioLanguage: string | null;
  /** The tracks the stream carries, once it has been inspected. */
  layout: StreamLayout | null;
  /** The sound track the stream plays, by PID, once the delivery is planned. */
  playing: number | null;
  /** The caption channels found in the pictures so far, 1 and 3. */
  captions: readonly number[];
}

interface TitleSessionState extends SessionBase {
  readonly kind: "title";
  readonly title: TitleRef;
  readonly upstreamUrl: string;
  probe: TitleProbe | null;
  /** The upstream request serving ffprobe or ffmpeg. A new one replaces it. */
  source: AbortController | null;
  /** What each run of ffmpeg reports back: its subtitle cues and where its picture starts. */
  readonly runs: Map<string, RunReports>;
}

type Session = LiveSession | TitleSessionState;

/** What an ffmpeg run sends the proxy besides the picture. */
interface RunReports {
  readonly cues: TextRelay;
  /**
   * Subtitle packets the player decodes itself, a JSON line each: `{"at":12.3,"data":"<base64>"}`,
   * `at` in seconds on the file's clock.
   */
  readonly packets: TextRelay;
  readonly start: TextRelay;
}

export interface PlaybackDeps {
  readonly userAgent: string;
  /** The ffmpeg executable that converts streams, or null when this build has none. */
  readonly ffmpeg: string | null;
  /** The ffprobe that reads what movie files hold, or null when this build has none. */
  readonly ffprobe?: string | null;
}

export class Playback extends Context.Service<
  Playback,
  {
    /**
     * Opens a stream for a channel. Closes any open stream first. `variants` are the channel's
     * streams to try in turn, the channel's id alone when absent. `decoders` lists what the UI's
     * player decodes; the proxy converts the rest. `repair` re-encodes the picture too, for a
     * broadcast the player failed to decode: ffmpeg conceals damage that stops the player.
     */
    open(
      channelId: string,
      decoders: readonly Codec[],
      options?: {
        readonly variants?: readonly string[];
        readonly repair?: boolean;
        readonly audio?: number | null;
        readonly audioLanguage?: string | null;
      },
    ): Effect.Effect<StreamSession, Failed>;
    /**
     * Opens a movie or episode from its provider file: closes any open stream, reads which
     * tracks the file holds and hands the UI an address to play it from any position. Fails with
     * a `stream` error when the provider refuses the file or it can't play here.
     */
    openTitle(
      title: TitleRef,
      upstreamUrl: string,
      decoders: readonly Codec[],
    ): Effect.Effect<TitleSession, Failed>;
    /** Closes a stream and its provider connection. Unknown or already closed ids are ignored. */
    close(sessionId: string): Effect.Effect<void>;
    /** Closes every open stream, for example when the window closes. */
    readonly closeAll: Effect.Effect<void>;
    /** Why the session's last upstream request failed, or null. */
    failure(sessionId: string): Effect.Effect<StreamFailure | null>;
    /**
     * A channel's sound and subtitle tracks, from its program table; null until its stream has
     * started, and for movies and episodes.
     */
    tracks(sessionId: string): Effect.Effect<ChannelTracks | null>;
    /** Which of a channel's streams the session plays; null for movies and episodes. */
    playing(sessionId: string): Effect.Effect<LivePlaying | null>;
  }
>()("mrstreamer/Playback") {
  static readonly layer = (deps: PlaybackDeps) => Layer.effect(Playback, make(deps));
}

function make(deps: PlaybackDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const diagnostics = yield* Diagnostics;
    const scope = yield* Effect.scope;
    const sessions = new Map<string, Session>();
    /** When channel streams failed, by upstream address, for `FAILED_STREAM_MS`. */
    const failedAt = new Map<string, number>();
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

    const base = `http://127.0.0.1:${port}`;
    /** Probes by file, so reopening a title doesn't read its file again. Oldest first. */
    const probes = new Map<string, TitleProbe>();
    /**
     * How each run's subtitle packets arrive: PGS as stored, or in a transport stream, where a
     * picture's SEI units carry captions.
     */
    const reportedPackets = new WeakMap<
      TextRelay,
      { readonly container: "mpegts" | "sup"; readonly captions: "h264" | "hevc" | null }
    >();

    async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cache-Control", "no-store");
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Access-Control-Allow-Headers": "Range" }).end();
        return;
      }
      const url = new URL(request.url ?? "/", base);
      // /stream/<token>.ts, /source/<token>, /title/<token>.mp4, /report/<token>/<run>/<what>,
      // /cues/<token>/<run>, /packets/<token>/<run>
      const route =
        /^\/(stream|source|title|report|cues|packets)\/([\w-]+)(?:\.\w+)?(?:\/([\w-]+))?(?:\/(cues|packets|start))?$/.exec(
          url.pathname,
        );
      const session = route && [...sessions.values()].find((each) => each.token === route[2]);
      const method = route ? (route[1] === "report" ? "PUT" : "GET") : null;
      if (!route || !session || request.method !== method) {
        response.writeHead(410).end();
        return;
      }
      if (session.kind === "live") {
        if (route[1] === "stream") await serveLive(session, response);
        else response.writeHead(410).end();
        return;
      }
      switch (route[1]) {
        case "source":
          return serveSource(session, request, response);
        case "title":
          // A new run starts clean: what went wrong before was dealt with, or happens again.
          session.failure = null;
          return serveTitle(session, url, response);
        case "report":
          return receiveReport(session, route[3] ?? "", route[4] ?? "", request, response);
        case "cues":
          return sendRelay(session.runs.get(route[3] ?? "")?.cues, "text/vtt", response);
        case "packets":
          return sendRelay(
            session.runs.get(route[3] ?? "")?.packets,
            "application/x-ndjson",
            response,
          );
        default:
          response.writeHead(410).end();
      }
    }

    async function serveLive(session: LiveSession, response: ServerResponse): Promise<void> {
      const started = performance.now();
      /** Notes how the stream reached the player, or why it didn't. */
      const report = (
        delivery: "direct" | "converted" | "repaired" | "none",
        outcome: "ok" | StreamFailure["kind"],
      ) =>
        diagnostics.record({
          op: "stream",
          ms: Math.round(performance.now() - started),
          delivery,
          outcome,
        });

      session.active?.abort();
      const active = new AbortController();
      session.active = active;
      response.on("close", () => active.abort());
      const signal = AbortSignal.any([session.closed.signal, active.signal]);

      const opened = await openVariant(session, signal, (failure) => report("none", failure.kind));
      if (signal.aborted) {
        if (opened.ok) void opened.reader.cancel().catch(() => {});
        response.destroy();
        return;
      }
      if (!opened.ok) {
        session.failure = opened.failure;
        response.writeHead("status" in opened.failure ? opened.failure.status : 502).end();
        return;
      }
      const { contentType, reader, start } = opened;
      const { layout } = start;
      session.layout = layout;
      session.captions = [];
      const video = layout?.video;
      const cleaned =
        video && video.codec !== "unknown" && CLEAN_START_CODECS.has(video.codec)
          ? cleanStart(replay(start, reader), createCleanStart(video.pid, video.codec))
          : replay(start, reader);
      // The track asked for, else the sound in the viewer's language, else the channel's first.
      const chosen =
        layout?.audio.find((track) => track.pid === session.audio) ??
        (session.audioLanguage
          ? layout?.audio.find((track) => languageCode(track.language) === session.audioLanguage)
          : undefined);
      session.playing = (chosen ?? layout?.audio[0])?.pid ?? null;
      const conversion = layout
        ? planConversion(layout, session.decoders, {
            repair: session.repair,
            audio: chosen?.pid ?? null,
          })
        : null;
      // The player plays the first sound track its table lists; ffmpeg keeps only the chosen one.
      const chosenFirst =
        layout && chosen && chosen !== layout.audio[0] && !conversion
          ? filtered(cleaned, createAudioChoice(layout.programPid, chosen.pid))
          : cleaned;
      // Captions inside the pictures get a stream of their own, after any conversion.
      const captionCopy = () =>
        createCaptionCopy((channels) => {
          session.captions = channels;
        });
      const chunks = conversion ? chosenFirst : filtered(chosenFirst, captionCopy());
      const delivery = !conversion ? "direct" : session.repair ? "repaired" : "converted";
      const body = Readable.from(chunks);
      body.on("error", (cause) => {
        if (!signal.aborted) {
          session.failure = { kind: "network", detail: String(cause) };
          report(delivery, "network");
        }
        response.destroy();
      });

      if (!conversion) {
        response.writeHead(200, { "Content-Type": contentType ?? "video/mp2t" });
        body.pipe(response);
        report("direct", "ok");
        return;
      }
      if (!deps.ffmpeg) {
        session.failure = { kind: "unsupported", detail: describeLayout(start.layout) };
        body.destroy();
        response.writeHead(415).end();
        report("none", "unsupported");
        return;
      }
      convert(deps.ffmpeg, conversion, body, response, session, signal, captionCopy(), (outcome) =>
        report(delivery, outcome),
      );
    }

    /**
     * Connects to the session's streams in turn until one sends something, and reads its start.
     * A stream's request is over before the next one's begins, so the provider sees one at a
     * time. A refusal ends the turn: it is the account's, such as another device on the
     * connection, so another stream would be refused too. `failed` hears each failed stream.
     */
    async function openVariant(
      session: LiveSession,
      signal: AbortSignal,
      failed: (failure: StreamFailure) => void,
    ): Promise<
      | {
          readonly ok: true;
          readonly contentType: string | null;
          readonly reader: ReadableStreamDefaultReader<Uint8Array>;
          readonly start: StreamStart;
        }
      | { readonly ok: false; readonly failure: StreamFailure }
    > {
      const noStream: StreamFailure = { kind: "network", detail: "The provider sent no stream." };
      let failure: StreamFailure = noStream;
      session.delivered = { variantId: null, failed: [] };
      for (const variant of session.variants) {
        const upstream = await connect(session, variant.url, {}, signal);
        const body = upstream.ok ? upstream.response.body : null;
        if (signal.aborted) {
          void body?.cancel().catch(() => {});
          return { ok: false, failure };
        }
        if (upstream.ok && body) {
          const reader = body.getReader();
          const start = await inspectStart(reader, session.decoders);
          // A stream that ends before sending anything has nothing to play.
          if (signal.aborted || start.head.length > 0 || start.pending) {
            session.delivered = { ...session.delivered, variantId: variant.id };
            failedAt.delete(variant.url);
            const contentType = upstream.response.headers.get("content-type");
            return { ok: true, contentType, reader, start };
          }
          void reader.cancel().catch(() => {});
        }
        failure = upstream.ok ? noStream : upstream.failure;
        failed(failure);
        session.delivered = {
          ...session.delivered,
          failed: [...session.delivered.failed, { variantId: variant.id, failure }],
        };
        if (failure.kind === "refused") break;
        failedAt.set(variant.url, Date.now());
      }
      return { ok: false, failure };
    }

    /** Pipes the stream through ffmpeg. A conversion that fails counts as an unsupported stream. */
    function convert(
      ffmpeg: string,
      conversion: Conversion,
      body: Readable,
      response: ServerResponse,
      session: LiveSession,
      signal: AbortSignal,
      output: { push(chunk: Uint8Array): Uint8Array },
      report: (outcome: "ok" | "unsupported") => void,
    ): void {
      const child = spawn(ffmpeg, ffmpegArguments(conversion), { stdio: ["pipe", "pipe", "pipe"] });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-2000);
      });
      const stop = () => child.kill("SIGKILL");
      signal.addEventListener("abort", stop, { once: true });
      child.on("error", (cause) => {
        if (!signal.aborted) {
          session.failure = { kind: "unsupported", detail: String(cause) };
          report("unsupported");
        }
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
          report("unsupported");
        }
        response.destroy();
      });
      // ffmpeg stops reading when it fails or is killed; that write error is not the stream's.
      child.stdin.on("error", () => {});
      body.pipe(child.stdin);
      response.writeHead(200, { "Content-Type": "video/mp2t" });
      child.stdout
        .pipe(
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              done(null, output.push(chunk));
            },
          }),
        )
        .pipe(response);
      report("ok");
    }

    /**
     * The provider's file for ffprobe and ffmpeg, the byte range they ask for. One upstream
     * request at a time: a new one, such as a seek, ends the one before.
     */
    async function serveSource(
      session: TitleSessionState,
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> {
      session.source?.abort();
      const mine = new AbortController();
      session.source = mine;
      response.on("close", () => mine.abort());
      const signal = AbortSignal.any([session.closed.signal, mine.signal]);
      const headers: Record<string, string> = request.headers.range
        ? { Range: request.headers.range }
        : {};
      const found = await connect(
        session,
        session.upstreamUrl,
        headers,
        signal,
        FILE_RETRY_DELAYS_MS,
      );
      if (signal.aborted) {
        if (found.ok) void found.response.body?.cancel().catch(() => {});
        response.destroy();
        return;
      }
      if (!found.ok) {
        // A range past the end is ffmpeg looking around, not the provider refusing.
        if (!("status" in found.failure) || found.failure.status !== 416) {
          session.failure = found.failure;
        }
        if ("status" in found.failure) response.writeHead(found.failure.status).end();
        else response.destroy();
        return;
      }
      const upstream = found.response;
      // The provider answers again, so ffmpeg has the range it asked for again: a break before
      // this no longer cuts the run short.
      session.failure = null;
      const forwarded: Record<string, string> = { "Accept-Ranges": "bytes" };
      for (const name of ["content-type", "content-length", "content-range"]) {
        const value = upstream.headers.get(name);
        if (value) forwarded[name] = value;
      }
      response.writeHead(upstream.status, forwarded);
      if (!upstream.body) {
        response.end();
        return;
      }
      const body = Readable.from(upstream.body);
      body.on("error", () => {
        // The provider broke off; ffmpeg may still end its run as if the file had.
        if (!signal.aborted) {
          session.failure ??= { kind: "network", detail: "The provider's file broke off." };
        }
        response.destroy();
      });
      signal.addEventListener("abort", () => body.destroy(), { once: true });
      body.pipe(response);
    }

    /**
     * Plays a movie or episode from `start` with the chosen tracks, as fragmented MP4. Headers
     * tell the player where the picture starts (`x-start`, title seconds), where the file's clock
     * begins (`x-origin`, which subtitle times count from) and where the cues stream (`x-cues`).
     */
    async function serveTitle(
      session: TitleSessionState,
      url: URL,
      response: ServerResponse,
    ): Promise<void> {
      const started = performance.now();
      session.active?.abort();
      const active = new AbortController();
      session.active = active;
      response.on("close", () => active.abort());
      const signal = AbortSignal.any([session.closed.signal, active.signal]);
      const probe = session.probe;
      const run: TitleRun = {
        start: Math.max(0, Number(url.searchParams.get("start")) || 0),
        audio: optionalNumber(url.searchParams.get("audio")),
        subtitle: optionalNumber(url.searchParams.get("subtitle")),
        convertSound: url.searchParams.get("sound") === "convert",
      };
      if (!probe || !deps.ffmpeg) {
        session.failure = {
          kind: "unsupported",
          detail: "This build has no ffmpeg to play movies and episodes.",
        };
        response.writeHead(415).end();
        return;
      }
      const runId = randomBytes(9).toString("base64url");
      const reports: RunReports = {
        cues: textRelay(),
        packets: textRelay(),
        start: textRelay(),
      };
      // The run before is over; its cues may still be read until now, as a short run can end
      // before the player asks for them.
      session.runs.clear();
      session.runs.set(runId, reports);
      const reportUrl = (what: string) => `${base}/report/${session.token}/${runId}/${what}`;
      const plan = titlePlan(probe, run, session.decoders, {
        source: `${base}/source/${session.token}`,
        cues: reportUrl("cues"),
        packets: reportUrl("packets"),
        start: reportUrl("start"),
      });
      reportedPackets.set(reports.packets, {
        container: plan.packets ?? "mpegts",
        captions:
          plan.subtitle && "packets" in plan.subtitle && plan.subtitle.packets === "captions"
            ? probe.video?.name === "hevc"
              ? "hevc"
              : "h264"
            : null,
      });
      const report = (outcome: "ok" | StreamFailure["kind"]) =>
        diagnostics.record({
          op: "title",
          ms: Math.round(performance.now() - started),
          video: plan.video,
          audio: plan.audio,
          outcome,
        });

      const child = spawn(deps.ffmpeg, plan.args, { stdio: ["ignore", "pipe", "pipe"] });
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-2000);
      });
      const stop = () => child.kill("SIGKILL");
      signal.addEventListener("abort", stop, { once: true });
      // Held until the picture's start is known; ffmpeg pauses when too much waits.
      const held: Buffer[] = [];
      let heldBytes = 0;
      const hold = (chunk: Buffer) => {
        held.push(chunk);
        heldBytes += chunk.length;
        if (heldBytes > 32 * 1024 * 1024) child.stdout.pause();
      };
      child.stdout.on("data", hold);
      let outputEnded = false;
      child.stdout.once("end", () => {
        outputEnded = true;
      });
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
      child.on("error", (cause) => {
        errors = String(cause);
      });

      // Converted video starts exactly at `start`; copied video at the keyframe before it,
      // which ffmpeg's report names.
      // ffmpeg sends the report's line as soon as it has the packet, and ends the report only
      // with the run, so the proxy reads it as it arrives.
      const pictureStart =
        plan.video === "copy"
          ? await new Promise<number | null>((resolve) => {
              const timer = setTimeout(() => resolve(null), RUN_START_TIMEOUT_MS);
              const settle = (time: number | null) => {
                clearTimeout(timer);
                unsubscribe();
                resolve(time);
              };
              const unsubscribe = reports.start.subscribe(
                () => {
                  const time = firstPacketTime(reports.start.text());
                  if (time !== null) settle(time);
                },
                () => settle(firstPacketTime(reports.start.text())),
              );
              void exited.then(() => settle(firstPacketTime(reports.start.text())));
            })
          : probe.origin + run.start;
      if (signal.aborted) {
        stop();
        response.destroy();
        return;
      }
      if (pictureStart === null || (held.length === 0 && child.exitCode !== null)) {
        stop();
        const failure: StreamFailure = session.failure ?? {
          kind: "unsupported",
          detail: `The file could not be played. ${lastLine(errors, child.exitCode, child.signalCode, pictureStart)}`,
        };
        session.failure = failure;
        report(failure.kind);
        response.writeHead("status" in failure ? failure.status : 415).end();
        return;
      }

      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Access-Control-Expose-Headers": "x-start, x-origin, x-cues, x-packets, x-packets-codec",
        "x-start": String(Math.max(0, pictureStart - probe.origin)),
        "x-origin": String(probe.origin),
        "x-cues":
          plan.subtitle && "cues" in plan.subtitle ? `${base}/cues/${session.token}/${runId}` : "",
        "x-packets":
          plan.subtitle && "packets" in plan.subtitle
            ? `${base}/packets/${session.token}/${runId}`
            : "",
        "x-packets-codec": plan.subtitle && "packets" in plan.subtitle ? plan.subtitle.packets : "",
      });
      child.stdout.pause();
      child.stdout.off("data", hold);
      for (const chunk of held) response.write(chunk);
      // A short file can be done before the player is connected. Otherwise the response ends
      // with ffmpeg below: a run that broke off must not end like the title.
      if (!outputEnded) child.stdout.pipe(response, { end: false });
      report("ok");
      void exited.then((code) => {
        signal.removeEventListener("abort", stop);
        // ffmpeg exits cleanly after its input broke off too; the source knows better.
        if (code === 0 && !signal.aborted && !session.failure) {
          response.end();
          return;
        }
        if (!signal.aborted && !session.failure) {
          session.failure = {
            kind: "unsupported",
            detail: `The file could not be played. ${lastLine(errors, code, child.signalCode)}`,
          };
        }
        response.destroy();
      });
    }

    /**
     * What ffmpeg sends back about a run: its subtitle cues, its subtitle packets, or where its
     * picture starts.
     */
    function receiveReport(
      session: TitleSessionState,
      runId: string,
      what: string,
      request: IncomingMessage,
      response: ServerResponse,
    ): void {
      const reports = session.runs.get(runId);
      const relay =
        what === "cues"
          ? reports?.cues
          : what === "packets"
            ? reports?.packets
            : what === "start"
              ? reports?.start
              : undefined;
      if (!relay) {
        response.writeHead(410).end();
        return;
      }
      const finish = () => {
        relay.end();
        response.writeHead(204).end();
      };
      request.on("error", () => relay.end());
      if (what !== "packets") {
        request.setEncoding("utf8");
        request.on("data", (text: string) => relay.write(text));
        request.on("end", finish);
        return;
      }
      // Packets arrive as a transport stream, or as PGS as it is stored, and go on as lines.
      const send = (at: number, data: Uint8Array) => {
        if (data.length > 0) {
          relay.write(`${JSON.stringify({ at, data: Buffer.from(data).toString("base64") })}\n`);
        }
      };
      const kind = reportedPackets.get(relay);
      if (kind?.container === "sup") {
        const segments = pgsSegments();
        request.on("data", (chunk: Buffer) => {
          for (const { at, set } of segments.push(chunk)) send(at, set);
        });
        request.on("end", finish);
        return;
      }
      const reader = pesReader();
      const captions = kind?.captions ?? null;
      const forward = (packets: readonly PesPacket[]) => {
        for (const packet of packets) {
          if (packet.pts === null) continue;
          const data = captions ? captionsInPicture(packet.payload, captions) : packet.payload;
          send(packet.pts / 90_000, data);
        }
      };
      request.on("data", (chunk: Buffer) => forward(reader.push(chunk)));
      request.on("end", () => {
        forward(reader.end());
        finish();
      });
    }

    /** A run's subtitle cues or packets, as ffmpeg sends them. */
    function sendRelay(relay: TextRelay | undefined, type: string, response: ServerResponse): void {
      if (!relay) {
        response.writeHead(410).end();
        return;
      }
      response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
      const unsubscribe = relay.subscribe(
        (text) => response.write(text),
        () => response.end(),
      );
      response.on("close", unsubscribe);
    }

    /** Reads what a title's file holds with ffprobe, through the session's source. */
    async function probeTitle(session: TitleSessionState): Promise<TitleProbe> {
      const known = probes.get(session.upstreamUrl);
      if (known) return known;
      const ffprobe = deps.ffprobe;
      if (!ffprobe) {
        throw new Failed({
          error: {
            kind: "stream",
            failure: { kind: "unsupported", detail: "This build has no ffprobe to read movies." },
          },
        });
      }
      const output = await new Promise<string | null>((resolve) => {
        const child = execFile(
          ffprobe,
          [...PROBE_ARGUMENTS, `${base}/source/${session.token}`],
          { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout) => resolve(error ? null : stdout),
        );
        session.closed.signal.addEventListener("abort", () => child.kill("SIGKILL"), {
          once: true,
        });
      });
      let json: unknown = null;
      try {
        json = output === null ? null : JSON.parse(output);
      } catch {
        // Not JSON: the file couldn't be read, handled below.
      }
      const probe = json === null ? null : readProbe(json);
      if (!probe || (!probe.video && probe.audio.length === 0)) {
        throw new Failed({
          error: {
            kind: "stream",
            failure: session.failure ?? {
              kind: "unsupported",
              detail: "The file has no picture or sound Mr. Streamer can read.",
            },
          },
        });
      }
      probes.set(session.upstreamUrl, probe);
      if (probes.size > PROBES_KEPT) probes.delete(probes.keys().next().value ?? "");
      return probe;
    }

    /**
     * Requests `url` through the session's provider, retrying briefly when it refuses: it can take
     * a moment to free the connection of a request we just closed.
     */
    async function connect(
      session: Session,
      url: string,
      headers: Readonly<Record<string, string>>,
      signal: AbortSignal,
      retryDelays: readonly number[] = REFUSED_RETRY_DELAYS_MS,
    ): Promise<{ ok: true; response: Response } | { ok: false; failure: StreamFailure }> {
      for (let attempt = 0; ; attempt++) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), CONNECT_TIMEOUT_MS);
        let response: Response;
        try {
          response = await session.request(url, {
            headers: { "User-Agent": deps.userAgent, ...headers },
            signal: AbortSignal.any([signal, timeout.signal]),
          });
        } catch (cause) {
          return {
            ok: false,
            failure: {
              kind: "network",
              detail: timeout.signal.aborted
                ? "The provider did not answer in time."
                : cause instanceof Error
                  ? cause.message
                  : String(cause),
            },
          };
        } finally {
          clearTimeout(timer);
        }

        if (response.ok) return { ok: true, response };
        await response.body?.cancel();
        const failure = classify(response.status);
        const delay = retryDelays[attempt];
        if (failure.kind !== "refused" || delay === undefined || signal.aborted)
          return { ok: false, failure };
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return {
      open: (
        channelId: string,
        decoders: readonly Codec[],
        options: {
          readonly variants?: readonly string[];
          readonly repair?: boolean;
          readonly audio?: number | null;
          readonly audioLanguage?: string | null;
        } = {},
      ) =>
        openOne(
          Effect.gen(function* () {
            const source = yield* subscriptions.source;
            if (!source) return yield* new Failed({ error: { kind: "no-subscription" } });
            yield* closeAll;

            const now = Date.now();
            for (const [url, at] of failedAt) if (now - at > FAILED_STREAM_MS) failedAt.delete(url);
            // Streams that failed lately go last, in the order they came.
            const variants = (options.variants?.length ? options.variants : [channelId])
              .map((id) => ({ id, url: source.provider.liveStream(id).url }))
              .toSorted((a, b) => Number(failedAt.has(a.url)) - Number(failedAt.has(b.url)));
            // A provider streams every channel in one format.
            const { format } = source.provider.liveStream(channelId);
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
            const session: LiveSession = {
              kind: "live",
              id,
              token: randomBytes(18).toString("base64url"),
              channelId,
              variants,
              delivered: { variantId: null, failed: [] },
              request: source.provider.request,
              format,
              decoders: new Set(decoders),
              repair: options.repair ?? false,
              audio: options.audio ?? null,
              audioLanguage: options.audioLanguage ?? null,
              layout: null,
              playing: null,
              captions: [],
              closed,
              scope: sessionScope,
              active: null,
              failure: null,
            };
            sessions.set(id, session);
            const extension = format === "mpegts" ? "ts" : "m3u8";
            return {
              sessionId: id,
              channelId,
              url: `http://127.0.0.1:${port}/stream/${session.token}.${extension}`,
              format,
            };
          }),
        ),

      openTitle: (title: TitleRef, upstreamUrl: string, decoders: readonly Codec[]) =>
        openOne(
          Effect.gen(function* () {
            const source = yield* subscriptions.source;
            if (!source) return yield* new Failed({ error: { kind: "no-subscription" } });
            yield* closeAll;
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
            const session: TitleSessionState = {
              kind: "title",
              id,
              token: randomBytes(18).toString("base64url"),
              title,
              upstreamUrl,
              request: source.provider.request,
              decoders: new Set(decoders),
              closed,
              scope: sessionScope,
              active: null,
              failure: null,
              probe: null,
              source: null,
              runs: new Map(),
            };
            sessions.set(id, session);
            const probe = yield* Effect.tryPromise({
              try: () => probeTitle(session),
              catch: (cause) => (cause instanceof Failed ? cause : failedWith(cause)),
            }).pipe(Effect.tapError(() => Scope.close(sessionScope, Exit.void)));
            session.probe = probe;
            return {
              sessionId: id,
              title,
              url: `${base}/title/${session.token}.mp4`,
              duration: probe.duration,
              audio: audioTracks(probe.audio),
              subtitles: subtitleTracks(probe.subtitles),
            } satisfies TitleSession;
          }),
        ),

      close: (sessionId: string) =>
        Effect.suspend(() => {
          const session = sessions.get(sessionId);
          return session ? Scope.close(session.scope, Exit.void) : Effect.void;
        }),

      closeAll,

      failure: (sessionId: string) => Effect.sync(() => sessions.get(sessionId)?.failure ?? null),

      tracks: (sessionId: string) =>
        Effect.sync(() => {
          const session = sessions.get(sessionId);
          return session?.kind === "live" && session.layout
            ? channelTracks(session.layout, session.captions, session.playing)
            : null;
        }),

      playing: (sessionId: string) =>
        Effect.sync(() => {
          const session = sessions.get(sessionId);
          return session?.kind === "live" ? session.delivered : null;
        }),
    };
  });
}

function optionalNumber(value: string | null): number | null {
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

/** ffmpeg's last error line, or how it ended when it said nothing. */
function lastLine(
  errors: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  start: number | null = null,
): string {
  const line = errors.trim().split("\n").at(-1);
  if (line) return line;
  return `ffmpeg ended with ${signal ?? code ?? "no exit"}${start === null ? ", before the picture started" : ""}.`;
}

/**
 * Text that arrives in pieces from one side and is read, from its start, by another that may
 * come later: ffmpeg's reports and cues, read by the proxy and the player.
 */
interface TextRelay {
  write(text: string): void;
  end(): void;
  /** Everything written so far. */
  text(): string;
  /** Resolves once the writer is done. */
  readonly ended: Promise<void>;
  /** Hears what was written so far, then each later piece, then the end. Returns an unsubscribe. */
  subscribe(onText: (text: string) => void, onEnd: () => void): () => void;
}

function textRelay(): TextRelay {
  let buffer = "";
  let done = false;
  const listeners = new Set<{ onText: (text: string) => void; onEnd: () => void }>();
  const { promise: ended, resolve } = Promise.withResolvers<void>();
  return {
    write(text) {
      if (done) return;
      buffer += text;
      for (const listener of listeners) listener.onText(text);
    },
    end() {
      if (done) return;
      done = true;
      resolve();
      for (const listener of listeners) listener.onEnd();
      listeners.clear();
    },
    text: () => buffer,
    ended,
    subscribe(onText, onEnd) {
      if (buffer) onText(buffer);
      if (done) {
        onEnd();
        return () => {};
      }
      const listener = { onText, onEnd };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
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
function cleanStart(
  chunks: AsyncGenerator<Uint8Array>,
  filter: ReturnType<typeof createCleanStart>,
): AsyncGenerator<Uint8Array> {
  return filtered(chunks, filter);
}

/** The stream through a filter that takes chunks and returns whole packets. */
async function* filtered(
  chunks: AsyncGenerator<Uint8Array>,
  filter: { push(chunk: Uint8Array): Uint8Array },
): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    const out = filter.push(chunk);
    if (out.length > 0) yield out;
  }
}

/** The tracks a channel's program table names, and its captions, as the UI lists them. */
function channelTracks(
  layout: StreamLayout,
  captions: readonly number[],
  playing: number | null,
): ChannelTracks {
  return {
    playing,
    audio: audioTracks(
      layout.audio.map((track, index) => ({
        id: track.pid,
        language: track.language,
        name: null,
        default: index === 0,
        channels: null,
        description: track.description,
      })),
    ),
    subtitles: subtitleTracks([
      ...layout.subtitles.map((track) => ({
        id: track.pid,
        page: track.page,
        format: track.format,
        language: track.language,
        name: null,
        default: false,
        forced: false,
        hearingImpaired: track.hearingImpaired,
      })),
      ...captions.map((channel) => ({
        id: CAPTION_PID,
        page: channel,
        format: "captions" as const,
        language: null,
        name: null,
        default: false,
        forced: false,
        hearingImpaired: false,
      })),
    ]),
  };
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
