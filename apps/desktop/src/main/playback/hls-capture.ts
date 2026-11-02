// Shares a clear HLS media playlist between Watch and a recording of it (./live-capture.ts). Each
// asks for the playlist and its segments as it would alone, Watch through hls.js and a recording
// through ./hls-ts-input.ts, and the provider is asked for each once:
// - A playlist answered less than half its target duration ago is answered again from then, also
//   when asked at the address the provider redirected it to, or at the one that redirected there:
//   the latest answer is the playlist at each of those addresses. Who asked for an answer is never
//   given it again once complete, so a reader alone reads the playlist as it would without this.
// - A segment is known by its media and discontinuity sequence numbers in the playlist and its
//   address but for its query, so the same segment under another query token is one segment, and
//   one of another host or path, as another packager's, is not.
//   One under way is read by each who asks for it from its start, as fast as the fastest of them
//   reads, and the last KEPT_SEGMENTS complete ones, KEPT_BYTES at most, are kept in memory for one
//   who comes later. One nobody reads any more while it arrives is abandoned.
// The segments are the provider's own bytes, and the playlists its own text, discontinuities and
// all: nothing is converted. Only a playlist that names its segments itself, as clear MPEG-TS the
// HLS reader takes, is shared. The first playlist answered says so: a multivariant playlist, whose
// leaf hls.js picks and changes, and any other passes through to the provider as it would alone,
// and `reading` says nothing reads it. A later playlist that is no longer clear media is passed
// on as it is but not kept; both readers still ask through here, and the HLS reader stops at it.
// The last owner leaving aborts what is under way and waits for every request to end.
import { clearMedia, PLAYLIST_BYTES } from "./hls-ts-input.ts";

/** Complete segments kept for a reader still to come, the newest, and the most they may take. */
const KEPT_SEGMENTS = 4;
const KEPT_BYTES = 64 * 1024 * 1024;
/** The most one answer may take: far more than any segment of a live stream. */
const ANSWER_BYTES = 256 * 1024 * 1024;
/** How long a playlist answered counts as current, at least: half its target duration else. */
const FRESH_MS = 250;

/** What the provider answered, once its headers came. */
interface Head {
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
}

/** One request to the provider, and what it sent so far, for each who reads it. */
interface Answer {
  readonly controller: AbortController;
  /** Its headers, or why it failed before them. */
  readonly head: Promise<Head>;
  readonly parts: Uint8Array[];
  /** Where it came from, after redirects, once its headers came. */
  url: string;
  size: number;
  done: boolean;
  failure: unknown;
  /** When it was complete. */
  at: number;
  /** Who reads it now, or waits for its headers. */
  readers: number;
  /** Settles as more arrives, or it ends. */
  arrived: PromiseWithResolvers<void>;
  /** Settles once a reader read all that arrived, so more is read from the provider. */
  wanted: PromiseWithResolvers<void>;
  /** Settles once its request ended. */
  settled: Promise<void>;
  /** Who asked the provider for it. */
  readonly by: string;
  /** A segment's media sequence number; null for a playlist. */
  readonly sequence: number | null;
}

interface Share {
  readonly owners: Set<string>;
  /** Whether its playlist names clear media itself; null until its first playlist arrived. */
  media: boolean | null;
  /** Its playlist's target duration. */
  targetMs: number;
  /** Playlists by the address asked for, and by the address they came from. */
  readonly playlists: Map<string, Answer>;
  /** Segments by `segmentOf`. */
  readonly segments: Map<string, Answer>;
  /** Its requests to the provider until each ended, kept or not. */
  readonly requests: Set<Answer>;
  /** Each segment the playlists named while it is listed, by address. */
  names: ReadonlyMap<string, { readonly segment: string; readonly sequence: number }>;
  closing: Promise<void> | null;
}

/** Reads the provider's answer into `parts` as its fastest reader wants it, for every reader. */
function start(
  by: string,
  sequence: number | null,
  open: (signal: AbortSignal) => Promise<Response>,
  finished: (answer: Answer, head: Head | null) => void,
): Answer {
  const controller = new AbortController();
  const head = Promise.withResolvers<Head>();
  // Its failure is each reader's; with none, nobody hears of it.
  head.promise.catch(() => {});
  const answer: Answer = {
    controller,
    head: head.promise,
    parts: [],
    url: "",
    size: 0,
    done: false,
    failure: null,
    at: 0,
    readers: 0,
    arrived: Promise.withResolvers(),
    wanted: Promise.withResolvers(),
    settled: Promise.resolve(),
    by,
    sequence,
  };
  const wake = () => {
    const { resolve } = answer.arrived;
    answer.arrived = Promise.withResolvers();
    resolve();
  };
  // An abort ends the wait for a reader, so the request ends.
  controller.signal.addEventListener("abort", () => answer.wanted.resolve(), { once: true });
  let headed: Head | null = null;
  answer.settled = (async () => {
    try {
      const response = await open(controller.signal);
      headed = {
        status: response.status,
        headers: new Headers(response.headers),
        url: response.url,
      };
      answer.url = response.url;
      head.resolve(headed);
      const reader = response.body?.getReader();
      try {
        // An empty answer, as a 204's, is complete at once.
        while (reader) {
          await answer.wanted.promise;
          answer.wanted = Promise.withResolvers();
          controller.signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          answer.size += next.value.length;
          if (answer.size > ANSWER_BYTES) throw new Error("The provider's answer is too long.");
          answer.parts.push(next.value);
          wake();
        }
        answer.at = Date.now();
      } finally {
        await reader?.cancel().catch(() => {});
      }
    } catch (cause) {
      answer.failure = cause;
      head.reject(cause);
    } finally {
      answer.done = true;
      wake();
      finished(answer, answer.failure === null ? headed : null);
    }
  })();
  return answer;
}

/** A reader's copy of `answer`, from its start; `release` once it stopped reading. */
function serve(answer: Answer, head: Head, signal: AbortSignal, release: () => void): Response {
  let at = 0;
  let left = false;
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const leave = () => {
    if (left) return;
    left = true;
    signal.removeEventListener("abort", aborted);
    release();
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
          const part = answer.parts[at];
          if (part) {
            at++;
            return controller.enqueue(part);
          }
          if (answer.done) {
            leave();
            return answer.failure ? controller.error(answer.failure) : controller.close();
          }
          const arrived = answer.arrived.promise;
          answer.wanted.resolve();
          await arrived;
        }
      },
      cancel: leave,
    },
    { highWaterMark: 0 },
  );
  const empty = [101, 103, 204, 205, 304].includes(head.status);
  if (empty) leave();
  const response = new Response(empty ? null : body, {
    status: head.status,
    headers: head.headers,
  });
  // As fetch's own: where the answer came from, after redirects.
  Object.defineProperty(response, "url", { value: head.url });
  return response;
}

/** `answer`'s headers, or the reason `signal` aborted first. */
function headOf(answer: Answer, signal: AbortSignal): Promise<Head> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    void answer.head
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Shared HLS streams by capture key. `connected` hears of each owner reading a key's shared
 * stream, once that stream is known to be shared.
 */
export function hlsShares(connected: (owner: string, key: string) => void) {
  const shares = new Map<string, Share>();

  const forget = (share: Share, answer: Answer) => {
    for (const [address, each] of share.playlists)
      if (each === answer) share.playlists.delete(address);
    for (const [segment, each] of share.segments)
      if (each === answer) share.segments.delete(segment);
  };

  /** What a complete answer tells: a playlist's segments, or room made for a segment's. */
  const finish = (
    share: Share,
    key: string,
    address: string,
    answer: Answer,
    head: Head | null,
  ) => {
    if (!head || head.status < 200 || head.status >= 300) return forget(share, answer);
    if (answer.sequence !== null) {
      // Newest first: what is kept until it holds too many, or too much.
      const complete = [...share.segments]
        .filter(([, each]) => each.done)
        .toSorted(([, a], [, b]) => (b.sequence ?? 0) - (a.sequence ?? 0));
      let bytes = 0;
      for (const [at, [old, each]] of complete.entries()) {
        bytes += each.size;
        if (at >= KEPT_SEGMENTS || bytes > KEPT_BYTES) share.segments.delete(old);
      }
      return;
    }
    const text = answer.size <= PLAYLIST_BYTES ? Buffer.concat(answer.parts).toString("utf8") : "";
    // An empty answer, or what is no playlist, says nothing of the stream.
    if (!text.trimStart().startsWith("#EXTM3U")) return forget(share, answer);
    const url = head.url || address;
    const media = clearMedia(text, url);
    if (share.media === null) {
      share.media = media !== null;
      if (share.media) for (const owner of share.owners) connected(owner, key);
    }
    if (!media) return forget(share, answer);
    share.targetMs = media.target * 1000;
    // Addresses an earlier read named stay known while their segments are listed: another
    // reader may have that read.
    const oldest = media.segments[0]!.sequence;
    share.names = new Map([
      ...[...share.names].filter(([, name]) => name.sequence >= oldest),
      ...media.segments.map((each) => {
        const path = new URL(each.address);
        path.search = "";
        const segment = `${each.sequence} ${each.epoch} ${path.href}`;
        return [each.address, { segment, sequence: each.sequence }] as const;
      }),
    ]);
    // It is the playlist now at the address it came from, as the HLS reader reads it again, and
    // at each that named the one before it there. One from elsewhere, as an older token's, goes.
    for (const [named, each] of share.playlists) {
      if (each === answer || !each.done) continue;
      if (each.url === answer.url) share.playlists.set(named, answer);
      else share.playlists.delete(named);
    }
    share.playlists.set(url, answer);
  };

  const fresh = (share: Share, answer: Answer) =>
    Date.now() - answer.at < Math.max(FRESH_MS, share.targetMs / 2);

  const resource = async (
    key: string,
    owner: string,
    address: string,
    open: (signal: AbortSignal) => Promise<Response>,
    signal: AbortSignal,
  ): Promise<Response> => {
    for (;;) {
      signal.throwIfAborted();
      const existing = shares.get(key);
      if (existing?.closing) {
        await existing.closing;
        continue;
      }
      const share: Share = existing ?? {
        owners: new Set(),
        media: null,
        targetMs: 0,
        playlists: new Map(),
        segments: new Map(),
        requests: new Set(),
        names: new Map(),
        closing: null,
      };
      shares.set(key, share);
      share.owners.add(owner);
      if (share.media === false) return open(signal);
      if (share.media) connected(owner, key);
      const name = share.names.get(address);
      const found = name ? share.segments.get(name.segment) : share.playlists.get(address);
      // A segment is kept while it is; a complete playlist only while it is fresh, for another.
      const kept = found && (!found.done || name || (fresh(share, found) && found.by !== owner));
      const answer = kept
        ? found
        : start(owner, name?.sequence ?? null, open, (done, head) =>
            finish(share, key, address, done, head),
          );
      if (!kept) {
        if (name) share.segments.set(name.segment, answer);
        else share.playlists.set(address, answer);
        share.requests.add(answer);
        void answer.settled.then(() => share.requests.delete(answer));
      }
      answer.readers++;
      const release = () => {
        // Nobody reads what still arrives: the provider needn't send the rest.
        if (--answer.readers === 0 && !answer.done) {
          answer.controller.abort();
          forget(share, answer);
        }
      };
      let head: Head;
      try {
        head = await headOf(answer, signal);
      } catch (cause) {
        release();
        throw cause;
      }
      return serve(answer, head, signal, release);
    }
  };

  /** Settles once `owner` left every share, the last owner of one ending its requests. */
  const leave = async (owner: string) => {
    const closing: Promise<void>[] = [];
    for (const [key, share] of shares) {
      if (!share.owners.delete(owner) || share.owners.size > 0 || share.closing) continue;
      const requests = [...share.requests];
      for (const answer of requests) answer.controller.abort();
      share.closing = Promise.all(requests.map((answer) => answer.settled)).then(() => {
        if (shares.get(key) === share) shares.delete(key);
      });
      closing.push(share.closing);
    }
    await Promise.all(closing);
  };

  return {
    /**
     * Answers `address` of the HLS stream `key` names: from what the provider answered another
     * reader, or through `open`. `owner` names who reads it, and `signal` ends this answer.
     */
    resource,
    /** Whether a shared HLS stream of `key` is read now. */
    reading: (key: string) => {
      const share = shares.get(key);
      return share?.media === true && !share.closing && share.owners.size > 0;
    },
    leave,
    /** Ends every share, as the app quits. */
    close: () => Promise.all([...shares.values()].flatMap((share) => [...share.owners]).map(leave)),
  };
}
