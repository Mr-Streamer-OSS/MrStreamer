// The segments made for a receiver, in memory: only those around what the receiver last asked
// for. ffmpeg makes segments far faster than they play, so whoever takes them from it waits for
// room before reading the next, which holds ffmpeg, and with it the provider's connection, until
// the receiver has come closer. A receiver that asks for a segment not made yet waits for it; only
// so many requests wait at once, the oldest giving way.

export interface SegmentLimits {
  /** Segments kept after the newest one the receiver asked for, and before it. */
  readonly ahead: number;
  readonly behind: number;
  /** Bytes kept at most, and the most one segment may hold. */
  readonly bytes: number;
  readonly segment: number;
  /** Requests that may wait for a segment at once. */
  readonly waiting: number;
}

export const SEGMENT_LIMITS: SegmentLimits = {
  ahead: 3,
  behind: 1,
  bytes: 160 * 1024 * 1024,
  segment: 96 * 1024 * 1024,
  waiting: 6,
};

export type SegmentStore = ReturnType<typeof segmentStore>;

export function segmentStore(limits: SegmentLimits = SEGMENT_LIMITS) {
  const segments = new Map<number, Buffer>();
  let bytes = 0;
  /** The newest segment the receiver asked for; -1 before it asked for any. */
  let asked = -1;
  const waiting: { readonly index: number; done(segment: Buffer | null): void }[] = [];
  /** Heard when there may be room for another segment. */
  const makers = new Set<() => void>();

  const wanted = (index: number) => index >= asked - limits.behind && index <= asked + limits.ahead;

  function drop(index: number): void {
    const segment = segments.get(index);
    if (!segment) return;
    segments.delete(index);
    bytes -= segment.length;
  }

  return {
    /** Whether segment `index` may be taken from ffmpeg now: the receiver is near it, and it fits. */
    room: (index: number): boolean => index <= asked + limits.ahead && bytes < limits.bytes,
    /** Resolves once `room(index)` holds, or `signal` aborts. */
    whenRoom(index: number, signal: AbortSignal): Promise<void> {
      return new Promise((resolve) => {
        const look = () => {
          if (!signal.aborted && !(index <= asked + limits.ahead && bytes < limits.bytes)) return;
          makers.delete(look);
          signal.removeEventListener("abort", look);
          resolve();
        };
        makers.add(look);
        signal.addEventListener("abort", look, { once: true });
        look();
      });
    },
    /** A segment arrived whole. One the receiver has moved away from meanwhile is not kept. */
    put(index: number, segment: Buffer): void {
      if (!wanted(index)) return;
      drop(index);
      segments.set(index, segment);
      bytes += segment.length;
      for (const waiter of waiting.filter((each) => each.index === index)) waiter.done(segment);
    },
    has: (index: number): boolean => segments.has(index),
    /**
     * The receiver asks for segment `index`: notes that it is there now, lets go of what is far
     * from it, and resolves with the segment once it is made. Null when `signal` aborts, when the
     * segment is given up on (see `fail`), or when too many requests wait and this is the oldest.
     */
    take(index: number, signal: AbortSignal): Promise<Buffer | null> {
      asked = index;
      for (const kept of [...segments.keys()]) if (!wanted(kept)) drop(kept);
      for (const maker of [...makers]) maker();
      const ready = segments.get(index);
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve) => {
        const waiter = {
          index,
          done: (segment: Buffer | null) => {
            const at = waiting.indexOf(waiter);
            if (at === -1) return;
            waiting.splice(at, 1);
            signal.removeEventListener("abort", left);
            resolve(segment);
          },
        };
        const left = () => waiter.done(null);
        signal.addEventListener("abort", left, { once: true });
        waiting.push(waiter);
        while (waiting.length > limits.waiting) waiting[0]!.done(null);
      });
    },
    /** The segments requests wait for, oldest request first. */
    awaited: (): number[] => waiting.map((each) => each.index),
    /** Ends the wait for segment `index`, or for every segment: it won't be made. */
    fail(index?: number): void {
      for (const waiter of [...waiting])
        if (index === undefined || waiter.index === index) waiter.done(null);
    },
    /** How many segments are kept after the newest one the receiver asked for. */
    get ahead(): number {
      return [...segments.keys()].filter((index) => index > asked).length;
    },
    get bytes(): number {
      return bytes;
    },
    limits,
  };
}
