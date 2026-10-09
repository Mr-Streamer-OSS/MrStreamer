// One download's transfer: the provider's file, streamed into a partial file on disk as it
// arrives, never held in memory. It goes on from bytes already there only when the provider's
// answer proves they are of the same file: a byte range starting where they end, of the same
// size, from the same address with the same strong mark (see ../playback/source-identity.ts).
// Anything else starts again from the first byte, saying so, and never appends one file's bytes
// to another's. A whole-file answer to a range is that fresh start.
//
// What the partial is of is written down (`identify`) in step with its bytes, so a crash or a
// failure at any moment leaves it under a mark it really holds, or under none. The old file's mark
// stays until a fresh start is sure to go ahead, as when there is room for it; then the partial is
// written down as of nothing before it is touched, and as of the new file once a byte of it is on
// disk, which means the partial was emptied for it.
//
// What ends a transfer is what it answers: complete, with what it wrote; stopped, when its signal
// aborted, with the partial kept for later; or failed, with why. A complete transfer has every
// byte the provider said the file holds, flushed to disk. Making it the copy is the caller's.
import { createWriteStream } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import type { Writable } from "node:stream";
import type { DownloadFailure } from "@mrstreamer/contracts/downloads";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import type { Provider } from "@mrstreamer/core/provider";
import { t } from "@mrstreamer/core/i18n";
import type { PartIdentity } from "../platform/downloads-store.ts";
import { resourceKey, strongMark } from "../playback/source-identity.ts";
import { classify } from "../services/playback.ts";

/** How long the provider gets to start answering. */
const CONNECT_TIMEOUT_MS = 15_000;
/**
 * Waits before asking again after a refusal: a provider can take a moment to free the connection
 * of a request that just ended, as another download's or playback's. Its length is the limit.
 */
const REFUSED_RETRY_MS = [500, 1500, 3000];
/** How long the body may send nothing before the transfer counts as broken. */
const STALL_MS = 60_000;

/** Where a transfer writes: the file system, or a stand-in that fails as a full disk does. */
export interface Disk {
  /** Bytes in the file at `path`; 0 when there is none. */
  size(path: string): Promise<number>;
  /** Free bytes on the disk `dir` is on, or null when that can't be read. */
  free(dir: string): Promise<number | null>;
  /** Writes the file at `path` from byte `start` on, dropping what it held from there. */
  write(path: string, start: number): Writable;
}

export const fileDisk: Disk = {
  size: (path) =>
    stat(path).then(
      (found) => found.size,
      () => 0,
    ),
  free: (dir) =>
    statfs(dir).then(
      (found) => found.bavail * found.bsize,
      () => null,
    ),
  // r+ keeps the bytes before `start`; a new file is made with w. `flush` syncs before closing.
  write: (path, start) =>
    createWriteStream(path, { flags: start > 0 ? "r+" : "w", start, flush: true }),
};

export interface TransferRequest {
  /** The provider's address of the file, with its login: never leaves the main process. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly request: Provider["request"];
  readonly userAgent: string;
  /** The partial file. */
  readonly part: string;
  /** What the partial's bytes are of, when an earlier transfer said. */
  readonly known: PartIdentity | null;
  readonly signal: AbortSignal;
  readonly disk?: Disk;
  /** Hears where it is: once the answer says what it sends, then as bytes arrive. */
  readonly progress: (at: TransferProgress) => void;
  /**
   * Writes down what the partial's bytes are of now, before it returns: null when they can't be
   * gone on from. Throws when it can't, which stops the transfer before the partial changes.
   */
  readonly identify: (identity: PartIdentity | null) => void;
}

interface TransferProgress {
  readonly received: number;
  readonly size: number | null;
  /** The bytes before were of another file, or couldn't be gone on from: it started again. */
  readonly restarted: boolean;
}

export type TransferOutcome =
  | { readonly kind: "complete"; readonly size: number; readonly identity: PartIdentity | null }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly failure: DownloadFailure };

/** Transfers the file into `part`, going on from what it holds when that is proven to be safe. */
export async function transfer(asked: TransferRequest): Promise<TransferOutcome> {
  const disk = asked.disk ?? fileDisk;
  const { signal } = asked;
  const had = await disk.size(asked.part);
  const known = asked.known;
  // What is there goes on only under the mark it was written under, and within its size.
  let from = known && had > 0 && had < known.size ? had : 0;
  let restarted = had > 0 && from === 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) return { kind: "stopped" };
    const answered = await connect(asked, from > 0 && known ? { from, known } : null);
    if (answered.kind === "past-end") {
      // The partial claims more than the file holds now: it was of a longer one.
      from = 0;
      restarted = true;
      continue;
    }
    if (answered.kind !== "answer") return answered;
    const { response } = answered;
    if (from > 0 && !continues(response, from, known)) {
      from = 0;
      restarted = true;
      // A 200 is the whole file from its start, written over the partial. A range of another
      // file is asked for again, from the start.
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
    }
    if (response.status === 206 && from === 0 && !startsAtZero(response)) {
      await response.body?.cancel().catch(() => {});
      return failed({ kind: "network", detail: t("The provider sent part of the file.") });
    }
    return receive(asked, disk, response, from, restarted);
  }
  return failed({ kind: "network", detail: t("The provider's file kept changing.") });
}

/** The provider's answer, asked from byte `resume.from` of the file `resume.known` says. */
async function connect(
  asked: TransferRequest,
  resume: { readonly from: number; readonly known: PartIdentity } | null,
  attempt = 0,
): Promise<
  | { readonly kind: "answer"; readonly response: Response }
  | { readonly kind: "past-end" }
  | TransferOutcome
> {
  const headers = new Headers({ "User-Agent": asked.userAgent });
  new Headers(asked.headers).forEach((value, name) => headers.set(name, value));
  if (resume) {
    headers.set("Range", `bytes=${resume.from}-`);
    const ifRange = ifRangeOf(resume.known.mark);
    if (ifRange) headers.set("If-Range", ifRange);
  }
  // Only the wait for the answer is timed: its body has the stall deadline of its own.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CONNECT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await asked.request(asked.url, {
      headers,
      signal: AbortSignal.any([asked.signal, timeout.signal]),
    });
  } catch (cause) {
    if (asked.signal.aborted) return { kind: "stopped" };
    return failed({
      kind: "network",
      detail: timeout.signal.aborted
        ? t("The provider did not answer in time.")
        : cause instanceof Error
          ? cause.message
          : String(cause),
    });
  } finally {
    clearTimeout(timer);
  }
  if (response.ok) return { kind: "answer", response };
  await response.body?.cancel().catch(() => {});
  if (resume && response.status === 416) return { kind: "past-end" };
  const failure = classify(response.status);
  const wait = REFUSED_RETRY_MS[attempt];
  if (failure.kind !== "refused" || wait === undefined) return failed(failure);
  const waited = await new Promise<boolean>((resolve) => {
    const done = (went: boolean) => {
      clearTimeout(timer);
      asked.signal.removeEventListener("abort", stopped);
      resolve(went);
    };
    const stopped = () => done(false);
    const timer = setTimeout(() => done(true), wait);
    asked.signal.addEventListener("abort", stopped, { once: true });
  });
  return waited ? connect(asked, resume, attempt + 1) : { kind: "stopped" };
}

/** Writes the answer's bytes into the partial from byte `from` on, until it ends or stops. */
async function receive(
  asked: TransferRequest,
  disk: Disk,
  response: Response,
  from: number,
  restarted: boolean,
): Promise<TransferOutcome> {
  const { signal } = asked;
  const size = sizeOf(response);
  const mark = strongMark(response.headers);
  const identity: PartIdentity | null =
    mark !== null && size !== null ? { resource: resourceOf(response), mark, size } : null;
  const body = response.body;
  if (!body) return failed({ kind: "network", detail: t("The provider sent no file.") });
  // Without room, the partial stays as it is, of the file it was of.
  if (size !== null) {
    const free = await disk.free(dirname(asked.part));
    const needed = size - from;
    if (free !== null && needed > free) {
      await body.cancel().catch(() => {});
      return { kind: "failed", failure: { kind: "disk-full", needed: needed - free } };
    }
  }
  let received = from;
  asked.progress({ received, size, restarted });
  // Going on, the partial is of this answer's file already. Starting again, it may hold another's
  // bytes until it is emptied, so it is of none until a byte of this one is on disk.
  let onDisk = from > 0 ? identity : null;
  try {
    asked.identify(onDisk);
  } catch (cause) {
    await body.cancel().catch(() => {});
    const failure = cause instanceof Failed ? cause : failedWith(cause);
    return { kind: "failed", failure: { kind: "app", error: failure.error } };
  }
  const written = (error?: Error | null) => {
    if (error || onDisk === identity) return;
    onDisk = identity;
    try {
      asked.identify(onDisk);
    } catch {
      // Written down as of none until the end: a restart takes it from its first byte.
    }
  };
  let stalled: NodeJS.Timeout | undefined;
  const stall = new AbortController();
  const awake = () => {
    clearTimeout(stalled);
    stalled = setTimeout(() => stall.abort(), STALL_MS);
  };
  awake();
  const stop = AbortSignal.any([signal, stall.signal]);
  const reader = body.getReader();
  const sink = disk.write(asked.part, from);
  // Stopping, or the disk failing, cancels the read under way, which then answers done. Nothing
  // waits on a promise that outlives one chunk, so no chunk is kept by what waited for it.
  let broken: unknown = null;
  const cancel = () => void reader.cancel().catch(() => {});
  stop.addEventListener("abort", cancel, { once: true });
  sink.on("error", (cause) => {
    broken ??= cause;
    cancel();
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (broken) throw broken;
      if (stop.aborted) throw stop.reason;
      if (done) break;
      received += value.length;
      awake();
      asked.progress({ received, size, restarted });
      // At most what the disk hasn't taken yet waits in memory.
      if (!sink.write(value, written)) await once(sink, "drain", { signal: stop });
    }
    // Flushed to disk and closed before it counts.
    sink.end();
    await once(sink, "close", { signal: stop });
    if (broken) throw broken;
  } catch (cause) {
    if (signal.aborted) return { kind: "stopped" };
    if (stall.signal.aborted) {
      return failed({ kind: "network", detail: t("The provider stopped sending the file.") });
    }
    return writeFailure(broken ?? cause) ?? failed({ kind: "network", detail: messageOf(cause) });
  } finally {
    clearTimeout(stalled);
    stop.removeEventListener("abort", cancel);
    // The provider's request is over, and the partial file closed, before this answers.
    await reader.cancel().catch(() => {});
    if (!sink.closed) {
      const closing = once(sink, "close").catch(() => {});
      sink.destroy();
      await closing;
    }
  }
  if (signal.aborted) return { kind: "stopped" };
  if (size !== null && received !== size) {
    return failed({ kind: "network", detail: t("The provider ended the file early.") });
  }
  return { kind: "complete", size: received, identity };
}

/** Whether a 206 answer goes on from byte `from` of the very file `known` says. */
function continues(response: Response, from: number, known: PartIdentity | null): boolean {
  if (!known || response.status !== 206) return false;
  const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  return (
    range !== null &&
    Number(range[1]) === from &&
    Number(range[2]) === known.size &&
    strongMark(response.headers) === known.mark &&
    resourceOf(response) === known.resource
  );
}

function startsAtZero(response: Response): boolean {
  return /^bytes 0-\d+\/\d+$/.test(response.headers.get("content-range") ?? "");
}

/** The whole file's size, as a range's answer or a whole answer says it; null when it doesn't. */
function sizeOf(response: Response): number | null {
  const range = /^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  const total = range ? Number(range[1]) : Number(response.headers.get("content-length") ?? NaN);
  return response.status === 206 && !range
    ? null
    : Number.isSafeInteger(total) && total >= 0
      ? total
      : null;
}

/** The address an answer came from after redirects, as kept on disk: never the address itself. */
function resourceOf(response: Response): string {
  return resourceKey(response.url);
}

/** The If-Range a strong mark asks with: its ETag, or its date. */
function ifRangeOf(mark: string): string | null {
  if (mark.startsWith("etag ")) return mark.slice(5);
  const modified = Number(mark.slice("modified ".length));
  return Number.isFinite(modified) ? new Date(modified).toUTCString() : null;
}

/** What a failed write says of the disk or the folder, or null when it was something else. */
function writeFailure(cause: unknown): TransferOutcome | null {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
  if (code === "ENOSPC" || code === "EDQUOT") {
    return { kind: "failed", failure: { kind: "disk-full", needed: null } };
  }
  if (
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EROFS" ||
    code === "ENOTDIR" ||
    code === "EIO"
  ) {
    return { kind: "failed", failure: { kind: "folder", detail: messageOf(cause) } };
  }
  return null;
}

function failed(failure: StreamFailure): TransferOutcome {
  return { kind: "failed", failure: { kind: "stream", failure } };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
