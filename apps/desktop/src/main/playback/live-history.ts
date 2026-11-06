// What a live capture keeps of its stream for the readers it serves: the bytes as the provider
// sent them, in pieces of PIECE_BYTES. The piece being filled and at most MEMORY_PIECES full
// ones waiting for the disk stay in memory. A full piece every reader has read goes at once; one
// a reader behind the live edge still needs is written to a file of its own in the capture's
// folder, and that reader reads it from there. Without a reader to ask, as for rewind later,
// every piece is kept. Every capture's files share one byte budget: the oldest piece of any of
// them goes first when a new one would exceed it, also when a paused reader still needs it, and
// so does a piece the disk doesn't take in time. A reader that asks for evicted bytes hears so;
// none pins anything. A disk that fails a write keeps memory only from then on, so what reads
// the live edge goes on.
//
// Each piece remembers when its first byte arrived: `offsetAt` finds the newest retained piece
// that began at or before a time, a packet boundary to start reading from.
import { mkdir, open, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

const PACKET = 188;

/** About four seconds of an 8 Mbit/s stream, in whole packets. */
export const PIECE_BYTES = PACKET * 22_000;

/**
 * Bytes every capture's files may take together: thirty minutes of a 9 Mbit/s stream, the
 * product's rewind target for one channel. Fewer minutes are kept of a richer stream.
 */
export const TEMPORARY_BYTES = 2 * 1024 ** 3;

/** Full pieces that may wait in memory for the disk. */
const MEMORY_PIECES = 2;

/** What a read answers at most, so a reader far behind never holds a whole piece. */
const READ_BYTES = 256 * 1024;

interface Piece {
  /** Where it begins in the stream. */
  readonly offset: number;
  /** When its first byte arrived. */
  readonly at: number;
  bytes: number;
  /** Its bytes while in memory, in order; null once on disk or evicted. */
  chunks: Uint8Array[] | null;
  /** Its file once written. */
  file: string | null;
}

/** Where the pieces of every capture go, and the bytes their files may take together. */
export interface HistoryBudget {
  readonly folder: string;
  readonly bytes: number;
  readonly pieceBytes: number;
  /** Bytes the disk keeps free: below that, a piece stays in memory only. */
  readonly keepFree: number;
  /** Retention duration, bounded to one hour. Defaults to thirty minutes. */
  readonly retentionMs?: number;
}

/** The answer to a read: bytes from the offset, or that it is ahead of what arrived or evicted. */
type HistoryRead = Uint8Array | "ahead" | "evicted";

export interface History {
  /** The offset after the last byte that arrived. */
  end(): number;
  /** Arrival-time bounds of bytes still retained, or null before data arrives. */
  bounds(): { readonly start: number; readonly end: number } | null;
  append(chunk: Uint8Array): void;
  /** Up to READ_BYTES from `offset`. */
  read(offset: number): Promise<HistoryRead>;
  /** Settles once something arrives past `offset`, the history ends, or `signal` aborts. */
  arrived(offset: number, signal: AbortSignal): Promise<void>;
  /** Where the newest retained piece that began at or before `time` starts. */
  offsetAt(time: number): number;
  /** No more bytes come; readers read what is retained. */
  finish(): void;
  finished(): boolean;
  /** Removes its files; reads answer evicted from then on. */
  close(): Promise<void>;
}

/**
 * The histories one budget serves. One writer takes their full pieces in turn, so the budget is
 * checked and the oldest piece among them evicted before each write, never by two at once.
 */
export function historyStore(budget: HistoryBudget) {
  const histories = new Set<HistoryState>();
  let made = 0;
  /**
   * Bytes of evicted files not removed yet, or that the system wouldn't remove: they still take
   * the disk, also once their history closed.
   */
  let leaving = 0;

  // A crash leaves the last run's pieces behind: they belong to no capture now.
  const ready = rm(budget.folder, { recursive: true, force: true })
    .then(() => mkdir(budget.folder, { recursive: true }))
    .then(
      () => true,
      () => false,
    );

  const used = () => [...histories].reduce((sum, each) => sum + each.disk, leaving);

  /**
   * Evicts the oldest piece on disk among every history, settling once its file is gone; null
   * when there is none.
   */
  const evictOldest = () => {
    let oldest: { history: HistoryState; piece: Piece } | null = null;

    for (const history of histories) {
      const piece = history.pieces.find((each) => each.file !== null);

      if (piece && (!oldest || piece.at < oldest.piece.at)) oldest = { history, piece };
    }

    return oldest ? oldest.history.evictThrough(oldest.piece) : null;
  };

  /**
   * Full pieces waiting for the writer, oldest first. One evicted from memory meanwhile leaves
   * the queue as the next one joins it, so it holds a few per history at most.
   */
  let queue: { readonly state: HistoryState; readonly piece: Piece }[] = [];
  /** The write under way, by whose history it is. */
  let current: { readonly state: HistoryState; readonly done: Promise<void> } | null = null;

  /** Writes one piece; a failure keeps that history in memory only from then on. */
  const write = async (state: HistoryState, piece: Piece) => {
    if (!(await ready)) state.broken = true;

    if (state.broken || state.closed || !piece.chunks || state.passed(piece)) return;

    if (!state.made) {
      state.made = await mkdir(state.folder).then(
        () => true,
        () => false,
      );

      if (!state.made) return state.dropDisk();
    }

    const free = await statfs(state.folder).then(
      (stats) => stats.bavail * stats.bsize,
      () => null,
    );

    // Kept free for recordings and the system: this piece stays in memory until it goes.
    if (free !== null && free - piece.bytes < budget.keepFree) return;

    // The files it evicts are gone before this one is written: the disk never holds more.
    while (used() + piece.bytes > budget.bytes) {
      const evicted = evictOldest();

      if (!evicted) break;
      await evicted;
    }

    // Read by every reader meanwhile, it needs no file.
    if (used() + piece.bytes > budget.bytes || !piece.chunks || state.closed || state.passed(piece))
      return;
    const file = join(state.folder, `${piece.offset}.ts`);

    try {
      const handle = await open(file, "wx");

      try {
        await handle.writev(piece.chunks);
      } finally {
        await handle.close();
      }
    } catch {
      await discard(file, piece.bytes);

      return state.dropDisk();
    }

    // Evicted or closed while it was written.
    if (!piece.chunks || state.closed) return discard(file, piece.bytes);
    piece.chunks = null;
    piece.file = file;
    state.disk += piece.bytes;
  };

  /** Removes a file the writer gave up on; one the system keeps counts as its whole piece. */
  const discard = (file: string, bytes: number) =>
    remove(file).catch(() => void (leaving += bytes));

  const drain = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const done = write(next.state, next.piece);
      current = { state: next.state, done };
      await done;
    }

    current = null;
  };

  /**
   * A new capture's history, in a folder of its own. `needed` answers the lowest offset a reader
   * still needs; without it every piece is kept.
   */
  function create(needed: () => number = () => 0, retaining: () => boolean = () => true): History {
    const state = new HistoryState(
      join(budget.folder, String(++made)),
      budget.pieceBytes,
      (bytes) => (leaving += bytes),
      needed,
      () =>
        retaining()
          ? Math.max(0, Math.min(budget.retentionMs ?? 30 * 60_000, 60 * 60_000))
          : Infinity,
    );

    histories.add(state);
    state.sealed = (piece) => {
      queue = [...queue.filter((each) => each.piece.chunks), { state, piece }];

      if (!current) void drain();
    };

    return {
      end: () => state.end,
      bounds: () =>
        state.pieces.length ? { start: state.pieces[0]!.at, end: state.latest } : null,
      append: (chunk) => state.append(chunk),
      read: (offset) => state.read(offset),
      arrived: (offset, signal) => state.arrived(offset, signal),
      offsetAt: (time) => state.offsetAt(time),
      finish: () => state.finish(),
      finished: () => state.done,
      close: async () => {
        await state.close();
        histories.delete(state);
        queue = queue.filter((each) => each.state !== state);

        if (current?.state === state) await current.done;

        if (state.made) await rm(state.folder, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  return { create };
}

/** Removes a file, trying again a moment later while the system holds it, as Windows can. */
const remove = (file: string) => rm(file, { force: true, maxRetries: 3, retryDelay: 100 });

class HistoryState {
  readonly pieces: Piece[] = [];
  end = 0;
  latest = 0;
  disk = 0;
  broken = false;
  closed = false;
  done = false;
  /** Its folder exists. */
  made = false;
  sealed: (piece: Piece) => void = () => {};
  private waiters = new Set<() => void>();
  readonly folder: string;
  readonly pieceBytes: number;
  /** Hears of bytes evicted files take until they are removed: more, then fewer once gone. */
  private readonly leaving: (bytes: number) => void;
  private readonly needed: () => number;
  private readonly retentionMs: () => number;

  constructor(
    folder: string,
    pieceBytes: number,
    leaving: (bytes: number) => void,
    needed: () => number,
    retentionMs: () => number,
  ) {
    this.folder = folder;
    this.pieceBytes = pieceBytes;
    this.leaving = leaving;
    this.needed = needed;
    this.retentionMs = retentionMs;
  }

  /** Whether every reader has read past `piece`, which then goes. */
  passed(piece: Piece): boolean {
    if (this.needed() < piece.offset + piece.bytes) return false;
    void this.evictThrough(piece);

    return true;
  }

  start() {
    return this.pieces[0]?.offset ?? this.end;
  }

  append(chunk: Uint8Array) {
    if (this.closed || this.done) return;
    this.latest = Date.now();
    const expired = this.pieces.findLast((piece) => piece.at < this.latest - this.retentionMs());

    if (expired) void this.evictThrough(expired);
    let rest = chunk;

    while (rest.length > 0) {
      let current = this.pieces.at(-1);

      if (!current?.chunks || current.file || current.bytes >= this.pieceBytes) {
        current = { offset: this.end, at: Date.now(), bytes: 0, chunks: [], file: null };
        this.pieces.push(current);
      }

      const take = Math.min(rest.length, this.pieceBytes - current.bytes);
      current.chunks!.push(rest.subarray(0, take));
      current.bytes += take;
      this.end += take;
      rest = rest.subarray(take);

      if (current.bytes >= this.pieceBytes) this.seal(current);
    }

    this.wake();
  }

  /**
   * A full piece: gone with those before it once every reader read it, else written to disk,
   * while no more than MEMORY_PIECES wait in memory.
   */
  private seal(piece: Piece) {
    if (this.passed(piece)) return;

    const passed = this.pieces.findLast(
      (each) => each !== piece && each.offset + each.bytes <= this.needed(),
    );

    if (passed) void this.evictThrough(passed);
    const waiting = this.pieces.filter((each) => each.chunks && each.bytes >= this.pieceBytes);

    if (waiting.length > MEMORY_PIECES) void this.evictThrough(waiting[0]!);

    if (!this.broken) this.sealed(piece);
  }

  /**
   * Evicts `piece` and every piece before it, settling once their files are gone. A file the
   * system won't remove still counts against the budget, and its history writes no more.
   */
  evictThrough(piece: Piece): Promise<void> {
    const index = this.pieces.indexOf(piece);
    const removals: Promise<void>[] = [];

    for (const gone of this.pieces.splice(0, index + 1)) {
      gone.chunks = null;

      if (gone.file) {
        const { bytes } = gone;
        this.disk -= bytes;
        // Counted until it is gone, so nothing is written in its place before.
        this.leaving(bytes);
        removals.push(
          remove(gone.file).then(
            () => this.leaving(-bytes),
            () => void (this.broken = true),
          ),
        );
        gone.file = null;
      }
    }

    return Promise.all(removals).then(() => {});
  }

  /** The disk failed: what it holds goes, and so do full pieces beyond memory's few. */
  dropDisk() {
    this.broken = true;
    const kept = this.pieces.filter((each) => each.chunks);
    const last = this.pieces.findLast((each) => !each.chunks);

    if (last) void this.evictThrough(last);
    const waiting = kept.filter((each) => each.bytes >= this.pieceBytes);

    if (waiting.length > MEMORY_PIECES) void this.evictThrough(waiting.at(-MEMORY_PIECES - 1)!);
  }

  async read(offset: number): Promise<HistoryRead> {
    if (this.closed || offset < this.start()) return "evicted";

    if (offset >= this.end) return "ahead";
    const piece = this.pieces.findLast((each) => each.offset <= offset)!;
    const within = offset - piece.offset;

    if (piece.chunks) {
      let at = 0;

      for (const chunk of piece.chunks) {
        if (within < at + chunk.length) {
          return chunk.subarray(within - at, Math.min(chunk.length, within - at + READ_BYTES));
        }

        at += chunk.length;
      }

      return "ahead";
    }

    if (!piece.file) return "evicted";
    const size = Math.min(READ_BYTES, piece.bytes - within);

    try {
      const handle = await open(piece.file, "r");

      try {
        const buffer = new Uint8Array(size);
        const { bytesRead } = await handle.read(buffer, 0, size, within);

        if (bytesRead > 0) return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      // Evicted while it was opened.
    }

    return "evicted";
  }

  arrived(offset: number, signal: AbortSignal) {
    if (offset < this.end || this.done || this.closed || signal.aborted) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };

      this.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  offsetAt(time: number) {
    return this.pieces.findLast((each) => each.at <= time)?.offset ?? this.start();
  }

  finish() {
    this.done = true;
    this.wake();
  }

  close() {
    this.closed = true;
    const last = this.pieces.at(-1);
    this.wake();

    return last ? this.evictThrough(last) : Promise.resolve();
  }

  private wake() {
    for (const waiter of [...this.waiters]) waiter();
  }
}
