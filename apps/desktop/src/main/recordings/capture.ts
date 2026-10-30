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
 * `signal`. Answers once the table is in a new file at `path`; throws `CaptureFailure`, with no
 * file left, when no source does. `changed` hears each write.
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
  const file = await open(path, "wx");
  let written = 0;
  const write = async (chunk: Uint8Array) => {
    await file.write(chunk);
    written += chunk.length;
    options.changed();
  };
  let last: StreamFailure = { kind: "unavailable", status: 404 };
  for (const source of sources) {
    const stop = new AbortController();
    const signal = AbortSignal.any([options.signal, stop.signal]);
    try {
      const chunks = await openSource(source, options, signal);
      await startTable(chunks, write, signal);
      return { bytes: () => written, ended: run(chunks, write, file, stop, options) };
    } catch (cause) {
      stop.abort();
      await file.truncate(0).catch(() => {});
      written = 0;
      if (options.signal.aborted) break;
      last = cause instanceof CaptureFailure ? cause.failure : failureOf(cause);
    }
  }
  await file.close().catch(() => {});
  await rm(path, { force: true });
  if (options.signal.aborted) throw new CaptureFailure({ kind: "network", detail: "Stopped." });
  throw new CaptureFailure(last);
}

/** The pieces of a source's stream, in order; ending it ends the provider's request. */
type Chunks = AsyncGenerator<Uint8Array, void, undefined>;

async function openSource(
  source: CaptureSource,
  options: { readonly request: Provider["request"]; readonly userAgent: string },
  signal: AbortSignal,
): Promise<Chunks> {
  const ask = async (address: string, asked: AbortSignal) => {
    const headers = new Headers({ "User-Agent": options.userAgent, ...source.headers });
    for (let attempt = 0; ; attempt++) {
      const answer = await options.request(address, { headers, signal: asked }, source.url);
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
    return (async function* () {
      try {
        for await (const epoch of input.epochs) yield* epoch.chunks;
      } finally {
        await input.close();
      }
    })();
  }
  const answer = await ask(source.url, signal);
  const reader = answer.body?.getReader();
  if (!reader) throw new CaptureFailure({ kind: "network", detail: "The provider sent nothing." });
  return (async function* () {
    try {
      for (;;) {
        const next = await within(reader.read(), SILENCE_MS, signal);
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  })();
}

/** Writes the stream until its program table has passed, or fails as playback would. */
async function startTable(
  chunks: Chunks,
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

/** Writes the rest, then ends the request and closes the file before saying why it ended. */
async function run(
  chunks: Chunks,
  write: (chunk: Uint8Array) => Promise<void>,
  file: Awaited<ReturnType<typeof open>>,
  stop: AbortController,
  options: { readonly until: number; readonly signal: AbortSignal },
): Promise<CaptureEnd> {
  const timer = setTimeout(() => stop.abort(), Math.max(0, options.until - Date.now()));
  let end: CaptureEnd;
  try {
    for (;;) {
      const next = await chunks.next().catch(() => null);
      if (!next || next.done) {
        end = "stream";
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
  } finally {
    clearTimeout(timer);
    stop.abort();
    await chunks.return().catch(() => {});
  }
  if (options.signal.aborted) end = "aborted";
  else if (Date.now() >= options.until) end = "until";
  await file.sync().catch(() => {});
  await file.close().catch(() => {});
  return end;
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
                detail: "The provider stopped sending.",
              }),
            ),
          ms,
        );
        abort = () => reject(new CaptureFailure({ kind: "network", detail: "Stopped." }));
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
  if (cause instanceof HlsInputFailure) return cause.failure;
  return { kind: "network", detail: cause instanceof Error ? cause.message : String(cause) };
}
