// Captures a live channel to a file as the provider sends it: the MPEG-TS packets themselves, every
// program, sound and subtitle track kept byte for byte, with nothing decoded or drawn. An HLS
// channel's segments go into the file one after another, read through the same clear muxed MPEG-TS
// subset playback reads (../playback/hls-ts-input.ts); a discontinuity stays in the file as the
// provider sent it. Each read waits for the write before it, so no more than one piece of the
// stream is ever held in memory.
import { open, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { StreamFailure, StreamFormat } from "@mrstreamer/contracts/playback";
import type { RecordingCut } from "@mrstreamer/contracts/recordings";
import type { Provider } from "@mrstreamer/core/provider";
import { t } from "@mrstreamer/core/i18n";
import { createInspector } from "../playback/inspect.ts";
import { HlsInputFailure, openHlsTsInput } from "../playback/hls-ts-input.ts";
import { classify } from "../services/playback.ts";

/** How long the provider may send nothing before a recording counts its stream as broken. */
const SILENCE_MS = 15_000;
/**
 * Waits before asking again after a refusal: a provider can take a moment to free the slot of a
 * stream that just closed, as Watch's does when the viewer stops it to record.
 */
const REFUSED_RETRY_MS: readonly number[] = [500, 1500];
/** How much of a stream may pass before its program table, while capture starts. */
const START_LIMIT = { bytes: 4 * 1024 * 1024, ms: 15_000 };

/** One of a channel's streams, as its provider gave it. */
export interface CaptureSource {
  readonly url: string;
  readonly format: StreamFormat;
  readonly headers: Readonly<Record<string, string>>;
}

/** Why capture couldn't start: what the provider answered, as playback names it. */
export class CaptureFailure extends Error {
  readonly failure: StreamFailure;
  constructor(failure: StreamFailure) {
    super(failure.kind);
    this.failure = failure;
  }
}

/** Why capture couldn't write its file: the system's own words, which say why. */
class DiskFailure extends Error {}

/** Why a capture under way ended: at its stop time, as asked, or cut short. */
export type CaptureEnd = "until" | "aborted" | Exclude<RecordingCut, "quit">;

export interface Capture {
  /** Bytes on disk so far. */
  bytes(): number;
  /** Settles once the provider's request has ended and the file is closed, never rejecting. */
  readonly ended: Promise<CaptureEnd>;
}

/**
 * Starts capturing the first of `sources` that sends a program table, from now until `until` or
 * `signal`. Answers once the table is in a new file at `path`. Throws `CaptureFailure` when no
 * source does, or `DiskFailure` when the file can't be written, with no file left either way and
 * every source's request ended.
 */
export async function startCapture(
  sources: readonly CaptureSource[],
  path: string,
  options: {
    readonly request: Provider["request"];
    readonly userAgent: string;
    readonly until: number;
    readonly signal: AbortSignal;
    readonly changed: () => void;
  },
): Promise<Capture> {
  const file = await open(path, "wx").catch((cause: unknown) => {
    throw new DiskFailure(cause instanceof Error ? cause.message : String(cause));
  });
  // The stop time also ends a start that takes that long.
  const deadline = AbortSignal.timeout(Math.max(0, options.until - Date.now()));
  let written = 0;
  // Every byte, at its offset: a source that failed before leaves the file emptied, but not its
  // position.
  const write = async (chunk: Uint8Array) => {
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await file
        .write(chunk, offset, chunk.length - offset, written)
        .catch((cause: unknown) => {
          throw new DiskFailure(cause instanceof Error ? cause.message : String(cause));
        });
      if (bytesWritten === 0) throw new DiskFailure("Nothing could be written.");
      offset += bytesWritten;
      written += bytesWritten;
    }
    options.changed();
  };
  let last: unknown = new CaptureFailure({ kind: "unavailable", status: 404 });
  for (const source of sources) {
    const stop = new AbortController();
    const signal = AbortSignal.any([options.signal, deadline, stop.signal]);
    let opened: Opened | null = null;
    try {
      opened = await openSource(source, options, signal);
      await startTable(opened.chunks, write, signal);
      return { bytes: () => written, ended: run(opened, write, file, stop, deadline, options) };
    } catch (cause) {
      stop.abort();
      await opened?.close();
      last = cause;
      if (cause instanceof DiskFailure || options.signal.aborted || deadline.aborted) break;
      await file.truncate(0).catch(() => {});
      written = 0;
    }
  }
  await file.close().catch(() => {});
  await rm(path, { force: true });
  if (last instanceof DiskFailure) throw last;
  if (deadline.aborted && !options.signal.aborted)
    throw new CaptureFailure({
      kind: "network",
      detail: t("The stop time passed while it started."),
    });
  if (options.signal.aborted) throw new CaptureFailure({ kind: "network", detail: t("Stopped.") });
  throw new CaptureFailure(last instanceof CaptureFailure ? last.failure : failureOf(last));
}

/** A source's stream, in order, and what ends its request, once the signal it opened with aborts. */
interface Opened {
  readonly chunks: AsyncGenerator<Uint8Array, void, undefined>;
  close(): Promise<void>;
}

async function openSource(
  source: CaptureSource,
  options: { readonly request: Provider["request"]; readonly userAgent: string },
  signal: AbortSignal,
): Promise<Opened> {
  const ask = async (address: string, asked: AbortSignal) => {
    const headers = new Headers({ "User-Agent": options.userAgent, ...source.headers });
    for (let attempt = 0; ; attempt++) {
      const waiting = new AbortController();
      const timeout = setTimeout(() => waiting.abort(), SILENCE_MS);
      let answer: Response;
      try {
        answer = await options.request(
          address,
          { headers, signal: AbortSignal.any([asked, waiting.signal]) },
          source.url,
        );
      } catch (cause) {
        if (waiting.signal.aborted && !asked.aborted)
          throw new CaptureFailure({
            kind: "network",
            detail: t("The provider did not answer in time."),
          });
        throw cause;
      } finally {
        // Once headers arrive, the body's own watchdog owns silence on this response.
        clearTimeout(timeout);
      }
      if (answer.ok) return answer;
      await answer.body?.cancel().catch(() => {});
      const failure = classify(answer.status);
      const delay = REFUSED_RETRY_MS[attempt];
      if (failure.kind !== "refused" || delay === undefined) throw new CaptureFailure(failure);
      await sleep(delay, undefined, { signal: asked });
    }
  };
  if (source.format === "hls") {
    const input = await openHlsTsInput(source.url, ask, signal, false, null);
    const chunks = (async function* () {
      for await (const epoch of input.epochs) yield* epoch.chunks;
    })();
    return {
      chunks,
      close: async () => {
        await chunks.return().catch(() => {});
        await input.close();
      },
    };
  }
  const answer = await ask(source.url, signal);
  const reader = answer.body?.getReader();
  if (!reader)
    throw new CaptureFailure({ kind: "network", detail: t("The provider sent nothing.") });
  const chunks = (async function* () {
    for (;;) {
      const next = await within(reader.read(), SILENCE_MS, signal);
      if (next.done) return;
      yield next.value;
    }
  })();
  return {
    chunks,
    close: async () => {
      await chunks.return().catch(() => {});
      await reader.cancel().catch(() => {});
    },
  };
}

/** Writes the stream until its program table has passed, or fails as playback would. */
async function startTable(
  chunks: Opened["chunks"],
  write: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const inspector = createInspector();
  const deadline = Date.now() + START_LIMIT.ms;
  let size = 0;
  for (;;) {
    const next = await within(chunks.next(), Math.max(1, deadline - Date.now()), signal);
    if (next.done) break;
    await write(next.value);
    size += next.value.length;
    if (inspector.push(next.value)) return;
    if (inspector.notTransportStream || size > START_LIMIT.bytes) break;
  }
  throw new CaptureFailure({
    kind: "unsupported",
    detail: "The provider's stream has no MPEG-TS program to record.",
  });
}

/**
 * Writes the rest, then ends the request and flushes and closes the file before saying why it
 * ended. A file that couldn't be flushed or closed ends as cut by the disk, whatever ended it.
 */
async function run(
  opened: Opened,
  write: (chunk: Uint8Array) => Promise<void>,
  file: Awaited<ReturnType<typeof open>>,
  stop: AbortController,
  deadline: AbortSignal,
  options: { readonly signal: AbortSignal; readonly until: number },
): Promise<CaptureEnd> {
  let end: CaptureEnd = "stream";
  // Its timer waits out a computer's sleep: the clock says when the stop time passed meanwhile.
  let late = false;
  for (;;) {
    const next = await opened.chunks.next().catch(() => null);
    if (!next || next.done) break;
    if (Date.now() >= options.until) {
      late = true;
      break;
    }
    const wrote = await write(next.value).then(
      () => true,
      () => false,
    );
    if (!wrote) {
      end = "disk";
      break;
    }
  }
  stop.abort();
  await opened.close();
  if (end !== "disk" && options.signal.aborted) end = "aborted";
  else if (end !== "disk" && (deadline.aborted || late)) end = "until";
  const flushed = await file.sync().then(
    () => true,
    () => false,
  );
  const closed = await file.close().then(
    () => true,
    () => false,
  );
  return flushed && closed ? end : "disk";
}

/** `promise`, or a `network` failure once `ms` pass or `signal` aborts first. */
async function within<A>(promise: Promise<A>, ms: number, signal: AbortSignal): Promise<A> {
  let timer: NodeJS.Timeout | undefined;
  let abort = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CaptureFailure({
                kind: "network",
                detail: t("The provider stopped sending."),
              }),
            ),
          ms,
        );
        abort = () => reject(new CaptureFailure({ kind: "network", detail: t("Stopped.") }));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function failureOf(cause: unknown): StreamFailure {
  // Recorder-authored details stay on CaptureFailure; transport messages are not localized.
  if (cause instanceof HlsInputFailure)
    return cause.failure.kind === "network" ? { ...cause.failure, detail: "" } : cause.failure;
  return { kind: "network", detail: "" };
}
