// Stream sessions and the loopback proxy that serves them to the UI.
//
// The UI never sees provider URLs: they carry the login. It gets a 127.0.0.1 URL with a random
// token instead. Only one session is open at a time, live or on demand, so switching always
// releases the previous provider connection first. Many subscriptions allow a single connection.
//
// Live: the proxy reads the start of each MPEG-TS stream to learn its codecs. A stream the UI's
// player decodes passes through untouched; otherwise ffmpeg converts only the tracks it cannot
// decode.
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
import { Readable } from "node:stream";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type {
  Codec,
  StreamFailure,
  StreamFormat,
  StreamSession,
  TitleSession,
} from "@mrstreamer/contracts/playback";
import { audioTracks, subtitleTracks } from "@mrstreamer/core/ondemand/tracks";
import { Diagnostics } from "@mrstreamer/core/diagnostics";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { createCleanStart } from "../playback/clean-start.ts";
import { ffmpegArguments, planConversion, type Conversion } from "../playback/convert.ts";
import { createInspector, type Inspection, type StreamLayout } from "../playback/inspect.ts";
import {
  firstPacketTime,
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

interface SessionBase {
  readonly id: string;
  readonly token: string;
  /** What the UI's player decodes. */
  readonly decoders: ReadonlySet<Codec>;
  readonly upstreamUrl: string;
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
  readonly format: StreamFormat;
  /** Re-encode the picture even when the player could decode it; see `open`. */
  readonly repair: boolean;
}

interface TitleSessionState extends SessionBase {
  readonly kind: "title";
  readonly title: TitleRef;
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
  readonly start: TextRelay;
}

export interface PlaybackDeps {
  readonly userAgent: string;
  /** The ffmpeg executable that converts streams, or null when this build has none. */
  readonly ffmpeg: string | null;
  /** The ffprobe that reads what movie files hold, or null when this build has none. */
  readonly ffprobe?: string | null;
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
  }
>()("mrstreamer/Playback") {
  static readonly layer = (deps: PlaybackDeps) => Layer.effect(Playback, make(deps));
}

function make(deps: PlaybackDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const diagnostics = yield* Diagnostics;
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

    const base = `http://127.0.0.1:${port}`;
    /** Probes by file, so reopening a title doesn't read its file again. Oldest first. */
    const probes = new Map<string, TitleProbe>();

    async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cache-Control", "no-store");
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Access-Control-Allow-Headers": "Range" }).end();
        return;
      }
      const url = new URL(request.url ?? "/", base);
      // /stream/<token>.ts, /source/<token>, /title/<token>.mp4, /report/<token>/<run>/<what>,
      // /cues/<token>/<run>
      const route =
        /^\/(stream|source|title|report|cues)\/([\w-]+)(?:\.\w+)?(?:\/([\w-]+))?(?:\/(cues|start))?$/.exec(
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
          return sendCues(session, route[3] ?? "", response);
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

      const upstream = await connect(session.upstreamUrl, {}, signal);
      if (signal.aborted) {
        if (upstream.ok) void upstream.response.body?.cancel().catch(() => {});
        response.destroy();
        return;
      }
      const failure: StreamFailure | null = !upstream.ok
        ? upstream.failure
        : upstream.response.body
          ? null
          : { kind: "network", detail: "The provider sent no stream." };
      if (!upstream.ok || !upstream.response.body || failure) {
        const shown = failure ?? { kind: "network", detail: "The provider sent no stream." };
        session.failure = shown;
        report("none", shown.kind);
        response.writeHead("status" in shown ? shown.status : 502).end();
        return;
      }
      const contentType = upstream.response.headers.get("content-type");
      const reader = upstream.response.body.getReader();
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
      const conversion = start.layout
        ? planConversion(start.layout, session.decoders, { repair: session.repair })
        : null;
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
      convert(deps.ffmpeg, conversion, body, response, session, signal, (outcome) =>
        report(delivery, outcome),
      );
    }

    /** Pipes the stream through ffmpeg. A conversion that fails counts as an unsupported stream. */
    function convert(
      ffmpeg: string,
      conversion: Conversion,
      body: Readable,
      response: ServerResponse,
      session: LiveSession,
      signal: AbortSignal,
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
      child.stdout.pipe(response);
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
      const found = await connect(session.upstreamUrl, headers, signal, FILE_RETRY_DELAYS_MS);
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
      const reports: RunReports = { cues: textRelay(), start: textRelay() };
      // The run before is over; its cues may still be read until now, as a short run can end
      // before the player asks for them.
      session.runs.clear();
      session.runs.set(runId, reports);
      const reportUrl = (what: string) => `${base}/report/${session.token}/${runId}/${what}`;
      const plan = titlePlan(probe, run, session.decoders, {
        source: `${base}/source/${session.token}`,
        cues: reportUrl("cues"),
        start: reportUrl("start"),
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
        "Access-Control-Expose-Headers": "x-start, x-origin, x-cues",
        "x-start": String(Math.max(0, pictureStart - probe.origin)),
        "x-origin": String(probe.origin),
        "x-cues": plan.subtitle ? `${base}/cues/${session.token}/${runId}` : "",
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

    /** What ffmpeg sends back about a run: its subtitle cues, or where its picture starts. */
    function receiveReport(
      session: TitleSessionState,
      runId: string,
      what: string,
      request: IncomingMessage,
      response: ServerResponse,
    ): void {
      const reports = session.runs.get(runId);
      const relay = what === "cues" ? reports?.cues : what === "start" ? reports?.start : undefined;
      if (!relay) {
        response.writeHead(410).end();
        return;
      }
      request.setEncoding("utf8");
      request.on("data", (text: string) => relay.write(text));
      request.on("end", () => {
        relay.end();
        response.writeHead(204).end();
      });
      request.on("error", () => relay.end());
    }

    /** A run's subtitle cues, as WebVTT, as ffmpeg sends them. */
    function sendCues(session: TitleSessionState, runId: string, response: ServerResponse): void {
      const relay = session.runs.get(runId)?.cues;
      if (!relay) {
        response.writeHead(410).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8" });
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
          [
            ...["-v", "error", "-print_format", "json", "-show_streams", "-show_format"],
            `${base}/source/${session.token}`,
          ],
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
     * Opens an upstream request, retrying briefly when the provider refuses: it can take a moment
     * to free the connection of a request we just closed.
     */
    async function connect(
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
          response = await fetchImpl(url, {
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
            const session: LiveSession = {
              kind: "live",
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

      openTitle: (title: TitleRef, upstreamUrl: string, decoders: readonly Codec[]) =>
        openOne(
          Effect.gen(function* () {
            if (!(yield* subscriptions.source)) {
              return yield* new Failed({ error: { kind: "no-subscription" } });
            }
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
