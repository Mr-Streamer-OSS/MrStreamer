// Shares a clear HLS stream between Watch and a recording of it (./live-capture.ts). Each
// asks for the playlist and its segments as it would alone, Watch through hls.js and a recording
// through ./hls-ts-input.ts, and the provider is asked for each once:
// - A playlist answered less than half its target duration ago is answered again from then, also
//   when asked at the address the provider redirected it to, or at the one that redirected there:
//   the latest answer is the playlist at each of those addresses. A reader is never given the same
//   answer twice, so a reader alone reads the playlist as it would without this.
// - A segment is known by its playlist, its media and discontinuity sequence numbers in it and its
//   address but for its query, so the same segment under another query token is one segment, and
//   one of another variant, host or path, as another packager's, is not. Addresses the last NAMED_READS
//   reads of each playlist named are known. A playlist whose media sequence went back, as after
//   the provider's packager restarted, lets every segment and address it named before go: numbers
//   are named anew.
//   One under way is read by each who asks for it from its start, as fast as the fastest of them
//   reads, and the last KEPT_SEGMENTS to complete, KEPT_BYTES at most, are kept in memory for one
//   who comes later. One nobody reads any more while it arrives is abandoned.
// The segments are the provider's own bytes, and the playlists its own text, discontinuities and
// all: nothing is converted. Only a playlist that names its segments itself, as clear MPEG-TS the
// HLS reader takes, is shared, and a multivariant playlist naming such playlists. The first
// playlist answered says which: any other passes through to the provider as it would alone, and
// `reading` says nothing reads it. A later playlist that is no longer clear media is passed on as
// it is but not kept; both readers still ask through here, and the HLS reader stops at it.
// A multivariant playlist offers its variants in several qualities, and hls.js picks and changes
// which it reads. The first answered is kept for the share's life, and given to each owner as its
// multivariant playlist, so all name the same variants by the same addresses: a variant is known
// by its address, query and all, a player's delivery directives added to it. While two or more
// owners read, all hold one variant: the one the first of them read, of those a recording takes
// (`Variant.recordable`, and no subtitles of its own it would leave out), as Watch's while a
// recording joins it, or the recording's while Watch does. An owner asking for another variant's
// playlist meanwhile is given the held one's, so the provider sends one quality, and `fixed` says
// which each owner holds, for Watch to show and keep. Once one owner is left, it reads what it
// asks for again: Watch goes back to Auto. A reader that comes while the others read a variant
// none can be held to, and wasn't admitted to share it (`joining`), asks the provider itself for
// as long as it reads, on the connection it was admitted on.
// An owner reads one stream at a time, Watch one of a channel's streams and a recording the one it
// records from, so asking for one leaves any other it read. The last owner leaving aborts what is
// under way, and `leave` waits for every request of each share its owner left to end.
import { clearMedia, PLAYLIST_BYTES, variantsOf, type Variant } from "./hls-ts-input.ts";

/** Complete segments kept for a reader still to come, the newest, and the most they may take. */
const KEPT_SEGMENTS = 4;
const KEPT_BYTES = 64 * 1024 * 1024;
/** The most one answer may take: far more than any segment of a live stream. */
const ANSWER_BYTES = 256 * 1024 * 1024;
/** How long a playlist answered counts as current, at least: half its target duration else. */
const FRESH_MS = 250;
/** Variant aliases kept across the share, newest last, forgetting the oldest beyond this limit. */
const ALIASES = 256;
/** Playlist reads whose segment addresses are known, the latest: as many as readers lag by. */
const NAMED_READS = 3;

/** `address` but for its query: what names a segment or a variant under any token. */
function pathOf(address: string): string {
  const url = URL.parse(address);
  if (!url) return address;
  url.search = "";
  url.hash = "";
  return url.href;
}

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
  /** When it was complete, and how many answers were complete before it. */
  at: number;
  completed: number;
  /** Who reads it now, or waits for its headers. */
  readers: number;
  /** Settles as more arrives, or it ends. */
  arrived: PromiseWithResolvers<void>;
  /** Settles once a reader read all that arrived, so more is read from the provider. */
  wanted: PromiseWithResolvers<void>;
  /** Settles once its request ended. */
  settled: Promise<void>;
  /** Who it was given to: who asked the provider for it, and who read it from here since. */
  readonly given: Set<string>;
  /** The media playlist a segment is of, as `playlist` names it; null for a playlist. */
  readonly of: string | null;
  /** A media playlist's target duration, once complete. */
  targetMs: number;
  /**
   * Which media playlist it is, once complete: the variant's address, else its path, so the
   * same one under another token is the same.
   */
  playlist: string | null;
}

interface Share {
  readonly owners: Set<string>;
  /**
   * What its first playlist was: one naming clear media itself, a multivariant playlist, or any
   * other; null until it arrived.
   */
  kind: "media" | "variants" | "other" | null;
  /** The multivariant playlist kept, and its variants. */
  master: Answer | null;
  variants: readonly Variant[];
  /** Those variants by the addresses a multivariant playlist asked for again names them. */
  readonly aliases: Map<string, Variant>;
  /** The variant each owner read last. */
  readonly current: Map<string, Variant>;
  /** The variant every owner holds while two or more read. */
  fixed: Variant | null;
  /** Playlists by the address asked for, and by the address they came from. */
  readonly playlists: Map<string, Answer>;
  /** Segments by playlist, media and discontinuity sequence numbers and address but for its query. */
  readonly segments: Map<string, Answer>;
  /** Its requests to the provider until each ended, kept or not. */
  readonly requests: Set<Answer>;
  /** Each segment the last NAMED_READS reads of its playlist named while it is listed, by address. */
  readonly names: Map<
    string,
    {
      readonly segment: string;
      readonly sequence: number;
      readonly read: number;
      /** Its media playlist, as `Answer.playlist` names it. */
      readonly of: string;
    }
  >;
  /**
   * Each media playlist read, as `Answer.playlist` names it: how many times, and the media sequence number it last
   * started at.
   */
  readonly media: Map<string, { reads: number; oldest: number }>;
  closing: Promise<void> | null;
}

/** Answers complete so far, in order. */
let completions = 0;

/** Reads the provider's answer into `parts` as its fastest reader wants it, for every reader. */
function start(
  by: string,
  of: string | null,
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
    completed: 0,
    readers: 0,
    arrived: Promise.withResolvers(),
    wanted: Promise.withResolvers(),
    settled: Promise.resolve(),
    given: new Set([by]),
    of,
    targetMs: 0,
    playlist: null,
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
        answer.completed = ++completions;
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
 * stream, once that stream is known to be shared, and `changed` of each whose `fixed` variant
 * changed.
 */
export function hlsShares({
  connected,
  changed,
}: {
  readonly connected: (owner: string, key: string) => void;
  readonly changed: (owner: string) => void;
}) {
  const shares = new Map<string, Share>();
  /** An independently admitted reader outlives the share it couldn't join, until it leaves. */
  const strangers = new Map<string, string>();

  /** Remember a variant's most recently used addresses, bounded across the share. */
  const rememberAlias = (share: Share, address: string, variant: Variant) => {
    share.aliases.delete(address);
    share.aliases.set(address, variant);
    if (share.aliases.size > ALIASES) share.aliases.delete(share.aliases.keys().next().value!);
  };

  /**
   * The variant held, or else the one the first owner to read one the HLS reader takes read: a
   * reader joining never holds the others to one a recording can't read.
   */
  const heldOrFirst = (share: Share) =>
    share.fixed ??
    [...share.owners]
      .map((owner) => share.current.get(owner))
      .find((variant) => variant?.recordable && !variant.subtitles) ??
    null;

  /**
   * The variant whose playlist `asked` is, as the kept multivariant playlist or one asked for
   * again names it: by its address, else the most specific whose query `asked` has with what a
   * player adds to it, else the only one at that path.
   */
  const variantOf = (share: Share, asked: string) => {
    const url = URL.parse(asked);
    if (!url) return undefined;
    const named = [
      ...share.variants.map((each) => [each.address, each] as const),
      ...share.aliases,
    ];
    const at = named.filter(([address]) => pathOf(address) === pathOf(asked));
    const exact = at.find(([address]) => address === asked);
    if (exact) return exact[1];
    const query = (address: string) => [...new URL(address).searchParams];
    const within = at
      .filter(([address]) =>
        query(address).every(([name, value]) => url.searchParams.get(name) === value),
      )
      .toSorted(([a], [b]) => query(b).length - query(a).length);
    if (within[0]) return within[0][1];
    const distinct = new Set(at.map(([, variant]) => variant));
    return distinct.size === 1 ? at[0]![1] : undefined;
  };

  /** Holds every owner to one variant while two or more read, telling each when that changed. */
  const settle = (share: Share) => {
    const before = share.fixed;
    share.fixed = share.owners.size < 2 ? null : heldOrFirst(share);
    if (share.fixed !== before) for (const owner of share.owners) changed(owner);
  };

  /** The variant an owner joining `share` now holds, one the HLS reader takes. */
  const joins = (share: Share) => heldOrFirst(share)?.address ?? null;

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
    if (answer.of !== null) {
      // The last to complete first: what is kept until it holds too many, or too much.
      const complete = [...share.segments]
        .filter(([, each]) => each.done)
        .toSorted(([, a], [, b]) => b.completed - a.completed);
      let bytes = 0;
      for (const [at, [old, each]] of complete.entries()) {
        bytes += each.size;
        if (at >= KEPT_SEGMENTS || bytes > KEPT_BYTES) share.segments.delete(old);
      }
      return;
    }
    // An empty answer, or what is no playlist, says nothing of the stream.
    const start = Buffer.concat(answer.parts.slice(0, 4)).subarray(0, 64).toString("utf8");
    if (answer.size > PLAYLIST_BYTES || !start.trimStart().startsWith("#EXTM3U"))
      return forget(share, answer);
    const text = Buffer.concat(answer.parts).toString("utf8");
    const url = head.url || address;
    answer.url = url;
    const decide = (kind: NonNullable<Share["kind"]>) => {
      if (share.kind !== null) return;
      share.kind = kind;
      if (kind !== "other") for (const owner of share.owners) connected(owner, key);
    };
    if (/^#EXT-X-STREAM-INF:/m.test(text)) {
      let variants: readonly Variant[] = [];
      try {
        variants = variantsOf(text, url);
      } catch {
        // Malformed: as any other playlist.
      }
      decide(variants.length ? "variants" : "other");
      if (share.kind !== "variants" || !variants.length) return forget(share, answer);
      // One asked again is its asker's alone, and the variants held stay the first's: its own,
      // as under new tokens, are those in the same place at the same path.
      if (share.master) {
        for (const [at, each] of variants.entries()) {
          const kept = share.variants[at];
          if (kept && pathOf(kept.address) === pathOf(each.address))
            rememberAlias(share, each.address, kept);
        }
        return;
      }
      share.master = answer;
      share.variants = variants;
    } else {
      const media = clearMedia(text, url);
      decide(media ? "media" : "other");
      if (!media || share.kind === "other") return forget(share, answer);
      answer.targetMs = media.target * 1000;
      // Addresses a recent read of this playlist named stay known while their segments are
      // listed: another reader may have that read. Numbers that went back are named anew.
      // A variant's playlist at the address it sent on to is that variant's too.
      const variant = variantOf(share, address);
      if (variant && url !== variant.address) rememberAlias(share, url, variant);
      const of = variant?.address ?? pathOf(url);
      answer.playlist = of;
      const oldest = media.segments[0]!.sequence;
      const last = share.media.get(of);
      const restarted = last !== undefined && oldest < last.oldest;
      const read = (last?.reads ?? 0) + 1;
      share.media.set(of, { reads: read, oldest });
      for (const [named, name] of share.names) {
        if (name.of !== of) continue;
        if (restarted || name.sequence < oldest || name.read <= read - NAMED_READS)
          share.names.delete(named);
      }
      if (restarted)
        for (const [segment, each] of share.segments)
          if (each.of === of) share.segments.delete(segment);
      for (const each of media.segments) {
        const segment = `${of} ${each.sequence} ${each.epoch} ${pathOf(each.address)}`;
        share.names.set(each.address, { segment, sequence: each.sequence, read, of });
      }
    }
    // It is the playlist now at the address it came from, as the HLS reader reads it again, and
    // at each that named the one before it there. Its older answer from elsewhere, as under an
    // older token, goes.
    for (const [named, each] of share.playlists) {
      if (each === answer || !each.done) continue;
      if (each.url === answer.url) share.playlists.set(named, answer);
      else if (each.playlist !== null && each.playlist === answer.playlist)
        share.playlists.delete(named);
    }
    share.playlists.set(url, answer);
  };

  const fresh = (answer: Answer) =>
    Date.now() - answer.at < Math.max(FRESH_MS, answer.targetMs / 2);

  const resource = async (
    key: string,
    owner: string,
    asked: string,
    open: (address: string, signal: AbortSignal) => Promise<Response>,
    signal: AbortSignal,
    joining = false,
  ): Promise<Response> => {
    for (;;) {
      signal.throwIfAborted();
      if (strangers.get(owner) === key) return open(asked, signal);
      const existing = shares.get(key);
      if (existing?.closing) {
        await existing.closing;
        continue;
      }
      const share: Share = existing ?? {
        owners: new Set(),
        kind: null,
        master: null,
        variants: [],
        aliases: new Map(),
        current: new Map(),
        fixed: null,
        playlists: new Map(),
        segments: new Map(),
        requests: new Set(),
        names: new Map(),
        media: new Map(),
        closing: null,
      };
      shares.set(key, share);
      if (!share.owners.has(owner)) {
        drop(owner, key);
        if (!joining && share.kind === "variants" && share.current.size > 0 && !joins(share)) {
          strangers.set(owner, key);
          return open(asked, signal);
        }
        share.owners.add(owner);
        settle(share);
      }
      if (share.kind === "other") return open(asked, signal);
      if (share.kind) connected(owner, key);
      // A variant's playlist is the held variant's while one is held.
      let address = asked;
      const variant = variantOf(share, asked);
      if (variant) {
        const held = share.fixed ?? variant;
        if (held !== variant) address = held.address;
        share.current.set(owner, held);
        settle(share);
      }
      const name = share.names.get(address);
      const found = name ? share.segments.get(name.segment) : share.playlists.get(address);
      // A segment is kept while it is; a complete playlist only while it is fresh, and the
      // multivariant playlist while it is kept, for one it wasn't given to yet.
      const kept =
        found &&
        (!found.done ||
          name ||
          (!found.given.has(owner) && (found === share.master || fresh(found))));
      const answer = kept
        ? found
        : start(
            owner,
            name?.of ?? null,
            (opened) => open(address, opened),
            (done, head) => finish(share, key, address, done, head),
          );
      if (!kept) {
        if (name) share.segments.set(name.segment, answer);
        else if (found !== share.master) share.playlists.set(address, answer);
        share.requests.add(answer);
        void answer.settled.then(() => share.requests.delete(answer));
      }
      answer.readers++;
      answer.given.add(owner);
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

  /** What each owner's leaving closed, for `leave`. */
  const closings = new Map<string, Set<Promise<void>>>();
  /** Takes `owner` out of every share but `kept`'s, closing those it was the last of. */
  const drop = (owner: string, kept?: string) => {
    strangers.delete(owner);
    for (const [key, share] of shares) {
      if (key === kept) continue;
      if (!share.owners.delete(owner)) continue;
      share.current.delete(owner);
      if (share.owners.size > 0) {
        settle(share);
        continue;
      }
      if (share.closing) continue;
      const requests = [...share.requests];
      for (const answer of requests) answer.controller.abort();
      share.closing = Promise.all(requests.map((answer) => answer.settled)).then(() => {
        if (shares.get(key) === share) shares.delete(key);
      });
      const closed = closings.get(owner) ?? new Set();
      closed.add(share.closing);
      closings.set(owner, closed);
    }
  };

  /** Settles once `owner` left every share, each it was the last owner of with its requests. */
  const leave = async (owner: string) => {
    drop(owner);
    const closed = closings.get(owner);
    closings.delete(owner);
    if (closed) await Promise.all(closed);
  };

  return {
    /**
     * Answers `address` of the HLS stream `key` names: from what the provider answered another
     * reader, or through `open` of the address it asks, which is the held variant's playlist in
     * place of another variant's. `owner` names who reads it, and `signal` ends this answer.
     * `joining` says it was admitted to share what reads `key` now.
     */
    resource,
    /**
     * Whether a shared HLS stream of `key` is read now, so reading it too asks the provider for
     * nothing more: of a multivariant playlist, when the variant a reader joining would hold is
     * one the HLS reader takes.
     */
    reading: (key: string) => {
      const share = shares.get(key);
      if (!share || share.closing || share.owners.size === 0) return false;
      return share.kind === "media" || (share.kind === "variants" && joins(share) !== null);
    },
    /** The variant a reader joining `key` now holds, as its multivariant playlist names it. */
    joins: (key: string) => {
      const share = shares.get(key);
      return share && !share.closing ? joins(share) : null;
    },
    /** The variant `owner` holds while it shares one with another reader, as `joins` names it. */
    fixed: (owner: string) => {
      for (const share of shares.values()) {
        if (!share.owners.has(owner) || share.fixed === null) continue;
        return share.fixed.address;
      }
      return null;
    },
    leave,
    /** Ends every share, as the app quits. */
    close: () =>
      Promise.all(
        [...shares.values()]
          .flatMap((share) => [...share.owners])
          .concat([...strangers.keys()])
          .map(leave),
      ),
  };
}
