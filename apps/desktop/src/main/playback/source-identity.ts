// What tells the file behind a title's address from another, as far as the provider's answers
// say. Playback doesn't depend on it: ffmpeg gets what the provider sends, as it always did. It is
// for what the proxy keeps of a subtitle track's past, which is of one file: once an answer shows
// that the provider put another in its place, everything kept is of a file that is gone.
//
// A provider's servers each give their own ETag for the same file, so an answer is compared with
// what the same address, after redirects, said before, never with another server's. A changed
// size is another file wherever it comes from. A server that answers for the first time has
// nothing to be compared with, so what was kept before it answered isn't used again: see
// `servers`. Marks that prove nothing aren't marks: a weak ETag,
// and a Last-Modified that isn't at least a second older than the answer, as servers send that
// stamp each answer with the time (RFC 9110 8.8.2.2). A file whose answers carry no mark is known
// by its size alone, so nothing kept of it outlasts the reading it was kept for.

import { createHash } from "node:crypto";

/** What an answer holds of the file. */
export interface Held {
  /** From which byte on. */
  readonly start: number;
  /** The whole file's size. */
  readonly size: number;
  /** The answer is of another file than the ones before: what was kept is gone. */
  readonly other: boolean;
  /** The answer is of a file that was replaced, from a server that still has it. */
  readonly stale: boolean;
}

/**
 * What proves which file was read: its size, and the strong mark each address it came from gave
 * it, after redirects, by `resourceKey`: query included, since a mark is only of its own address.
 * The addresses are of one resource, its path and query, perhaps served by several hosts. Another
 * reading of the same bytes says the same for its address. It is kept on disk, so it names no
 * address itself.
 */
export interface FileProof {
  readonly size: number;
  readonly marks: readonly { readonly resource: string; readonly mark: string }[];
}

/** Marks of replaced files kept, for telling a server that lags behind. */
const RETIRED_KEPT = 64;

export type SourceIdentity = ReturnType<typeof sourceIdentity>;

export function sourceIdentity() {
  /** Counts the files seen behind the address. */
  let generation = 0;
  let size: number | null = null;
  /** Whether the provider answers byte ranges; null until one was asked. */
  let ranges: boolean | null = null;
  /** The mark each address gave of the file, null for an answer without one. */
  const marks = new Map<string, string | null>();
  /**
   * The resource read, by its path and query, with the mark each host serving it gave, by
   * `resourceKey`, for `proof`. Another path or query is another resource, maybe other bytes under
   * the same size and ETag, and an answer of a replaced file is other bytes: then nothing in the
   * answers tells which bytes were read, "mixed" until another file is behind the address.
   */
  let proven: { readonly resource: string; readonly marks: Map<string, string> } | "mixed" | null =
    null;
  /** Some answer of the file came without a mark. */
  let unmarked = false;
  /** Marks of the files replaced since, by "address mark". */
  const retired = new Set<string>();

  return {
    get generation(): number {
      return generation;
    },
    /** The file's size, or null before its first answer. */
    get size(): number | null {
      return size;
    },
    get ranges(): boolean | null {
      return ranges;
    },
    /**
     * Whether every answer so far vouched for the file with a mark, so what is kept of it can be
     * used again for as long as no answer says otherwise.
     */
    get steady(): boolean {
      return marks.size > 0 && !unmarked;
    },
    /** The proof of the file read so far, while every answer of it carried a mark. */
    get proof(): FileProof | null {
      if (size === null || proven === null || proven === "mixed" || unmarked) return null;
      return { size, marks: [...proven.marks].map(([resource, mark]) => ({ resource, mark })) };
    },
    /**
     * How many addresses have answered for the file. What was kept when fewer had is of servers
     * that may hold another file than the one that answered since.
     */
    get servers(): number {
      return marks.size;
    },

    /**
     * Notes what `answer` says of the file; `ranged` when a byte range was asked. Null when it
     * doesn't say what it holds.
     */
    observe(answer: Response, ranged: boolean): Held | null {
      const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(answer.headers.get("content-range") ?? "");
      const length = answer.headers.get("content-length");
      const held =
        answer.status === 206 && range
          ? { start: Number(range[1]), size: Number(range[2]) }
          : answer.status === 200 && length !== null
            ? { start: 0, size: Number(length) }
            : null;
      if (!held || !Number.isSafeInteger(held.size)) return null;
      if (ranged) ranges = answer.status === 206;
      const address = URL.parse(answer.url);
      const resource = address ? address.origin + address.pathname : "";
      const mark = strongMark(answer.headers);
      const known = marks.get(resource);
      const other =
        (size !== null && size !== held.size) ||
        (known !== undefined && known !== null && mark !== null && known !== mark);
      const replaced = mark !== null && retired.has(`${resource} ${mark}`);
      if (replaced && !other) {
        // What it sends may be read too, and it is of a file that is gone.
        proven = "mixed";
        return { ...held, other: false, stale: true };
      }
      if (other) {
        // A file that is back can't be told from its copies that never left: forget them all.
        if (replaced) retired.clear();
        for (const [each, old] of marks) if (old !== null) retired.add(`${each} ${old}`);
        for (const oldest of retired) {
          if (retired.size <= RETIRED_KEPT) break;
          retired.delete(oldest);
        }
        marks.clear();
        proven = null;
        unmarked = false;
        generation++;
      }
      size = held.size;
      if (mark === null) unmarked = true;
      if (mark !== null || !marks.has(resource)) marks.set(resource, mark);
      if (mark !== null && proven !== "mixed") {
        const read = address ? address.pathname + address.search : "";
        if (proven === null) proven = { resource: read, marks: new Map() };
        if (proven.resource === read) proven.marks.set(resourceKey(answer.url), mark);
        else proven = "mixed";
      }
      return { ...held, other, stale: false };
    },
  };
}

/**
 * An address as what is kept on disk names it: a fingerprint of its origin, path and query, which
 * are what tells one resource from another. Two addresses differing only in their query may be
 * different files under the same ETag. A provider's file address holds the login in its path or
 * query, which never goes to disk. Downloads and saved subtitles' proofs both name a file's address
 * by this, and only this.
 */
export function resourceKey(address: string): string {
  const url = URL.parse(address);
  return createHash("sha256")
    .update(url ? url.origin + url.pathname + url.search : "")
    .digest("hex");
}

/** The mark of an answer that tells its file from any other: a strong ETag, or an old enough date. */
export function strongMark(headers: Headers): string | null {
  const tag = headers.get("etag");
  if (tag !== null && !tag.startsWith("W/")) return `etag ${tag}`;
  const modified = Date.parse(headers.get("last-modified") ?? "");
  const sent = Date.parse(headers.get("date") ?? "");
  if (Number.isNaN(modified) || Number.isNaN(sent) || sent - modified < 1000) return null;
  return `modified ${modified}`;
}
