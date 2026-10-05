// What a session has read of one subtitle track of a movie's file, and which stretches of the
// file it read whole. A file holds a subtitle only where it begins, so a run from a position
// doesn't bring what is on screen there: the picture, page or caption that began earlier, and the
// objects, colours and hidden rows later ones build on. Everything read of the track is kept here
// instead, with the stretch it covers: what a run reads, and what the proxy reads of the file
// for a position (see matroska.ts). A position's subtitles come from what the history holds: the
// packets from the last point where the subtitles start afresh, or from the start of the file
// for formats that never do. A stretch counts as read only when every packet in it was read
// through. A file's index can say where a track's packets are, and so where to read; it never
// counts as proof that a stretch holds none, however complete it claims to be.

/** One subtitle read from the file: a packet for the player's decoder, or a line of text. */
export type SubtitleEntry = {
  /**
   * The time of the packet it came from, in seconds on the file's clock: where in the file it
   * sits. Entries are kept, and sent on, in this order.
   */
  readonly from: number;
  /** When it takes effect: later than `from` only for the end ffmpeg writes with a DVD picture. */
  readonly at: number;
} & ({ readonly data: Uint8Array } | { readonly until: number; readonly text: string });

/** A stretch of the file's clock, both ends included; infinite at the file's start or end. */
export interface Span {
  readonly from: number;
  readonly to: number;
}

/** One reading of the file from a point on: a run's, or the proxy's for what came before one. */
export interface Reading {
  /**
   * Says from which time on the reading is whole: every entry of the track from there comes
   * with it. -Infinity when it reads from the file's start. Entries added before this wait for it.
   */
  begin(time: number): void;
  /** An entry, in the order read. */
  add(entry: SubtitleEntry): void;
  /** Everything up to `time` has been added. */
  reach(time: number): void;
  /** The reading is over; `toEnd` when it read to the end of the file. */
  end(toEnd: boolean): void;
}

/** Entries closer than this to a time count as at it. */
const EDGE_S = 1e-6;

export type SubtitleHistory = ReturnType<typeof subtitleHistory>;

/** The history of one track, keeping at most `limit` bytes of entries. One reading at a time. */
export function subtitleHistory(limit: number) {
  /** By `from`; in the order read where that is equal. */
  const entries: SubtitleEntry[] = [];
  /**
   * The stretches read whole, in order and apart from each other. Every entry of the track
   * inside one is in `entries`, once, and every entry kept lies inside one or in the stretch
   * under way.
   */
  let read: Span[] = [];
  /** The stretch the reading under way has covered so far. */
  let open: { from: number; to: number } | null = null;
  let bytes = 0;

  /** The index of the first entry after `time`. */
  function after(time: number): number {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (entries[middle]!.from <= time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  const isRead = (time: number) => read.some((span) => holds(span, time));

  /**
   * Lets go of the entries furthest from `time` once more than the limit is kept: the first or
   * the last. What was read from there outward no longer counts as read, so a history at its
   * limit keeps one stretch around `time` and never one more for each entry gone.
   */
  function trim(time: number): void {
    while (bytes > limit && entries.length > 0) {
      const first = entries[0]!.from;
      const last = entries.at(-1)!.from;
      const early = time - first >= last - time;
      const still: Span = early
        ? { from: first + EDGE_S, to: Number.POSITIVE_INFINITY }
        : { from: Number.NEGATIVE_INFINITY, to: last - EDGE_S };
      read = read.flatMap((span) => within(span, still));
      if (open) {
        open.from = Math.max(open.from, still.from);
        open.to = Math.min(open.to, still.to);
      }
      const gone = early ? entries.splice(0, after(still.from)) : entries.splice(after(still.to));
      bytes -= gone.reduce((sum, entry) => sum + sizeOf(entry), 0);
    }
  }

  /**
   * Adds what the reading under way covered to what is read. What it brought from beyond that
   * goes again: the next reading of that stretch brings it, with whatever lies between.
   */
  function settle(): void {
    if (!open) return;
    const { from, to } = open;
    open = null;
    if (to >= from) read = joined([...read, { from, to }]);
    const beyond = entries.splice(after(to >= from ? to : from - EDGE_S));
    for (const entry of beyond) {
      if (isRead(entry.from)) entries.push(entry);
      else bytes -= sizeOf(entry);
    }
  }

  return {
    /** The stretch around `time` that is read whole, or null when `time` isn't in one. */
    spanAt(time: number): Span | null {
      return read.find((span) => holds(span, time)) ?? null;
    },

    /** The read stretch nearest below `time`. */
    spanBelow(time: number): Span | null {
      return read.findLast((span) => span.to < time) ?? null;
    },

    /** The entries from `span`'s start up to `time`, in order. */
    entriesIn(span: Span, time: number): readonly SubtitleEntry[] {
      return entries.slice(after(span.from - EDGE_S), after(time));
    },

    /**
     * A reading that counts up to `upTo`: the proxy reads for a stretch, and what it brings
     * from beyond it is left for the reading that comes for that.
     */
    reading(upTo = Number.POSITIVE_INFINITY): Reading {
      let waiting: SubtitleEntry[] | null = [];
      let mine: typeof open = null;

      const add = (entry: SubtitleEntry) => {
        if (!open || open !== mine || entry.from > upTo) return;
        // Before the point it is whole from, the reading may have missed others around it; in a
        // stretch read before, the entry is here already.
        if (entry.from < open.from || isRead(entry.from)) return;
        entries.splice(after(entry.from), 0, entry);
        bytes += sizeOf(entry);
        trim(entry.from);
      };

      return {
        begin(time) {
          if (waiting === null) return;
          settle();
          open = mine = { from: time, to: Number.NEGATIVE_INFINITY };
          const held = waiting;
          waiting = null;
          for (const entry of held) add(entry);
        },
        add(entry) {
          if (waiting) waiting.push(entry);
          else add(entry);
        },
        reach(time) {
          if (open && open === mine) open.to = Math.max(open.to, Math.min(time, upTo));
        },
        end(toEnd) {
          waiting = null;
          if (!open || open !== mine) return;
          if (toEnd) open.to = upTo;
          settle();
          mine = null;
        },
      };
    },
  };
}

function sizeOf(entry: SubtitleEntry): number {
  return "data" in entry ? entry.data.length : entry.text.length;
}

function holds(span: Span, time: number): boolean {
  return span.from <= time && time <= span.to;
}

/** The part of `span` inside `bounds`, if any. */
function within(span: Span, bounds: Span): Span[] {
  const part = { from: Math.max(span.from, bounds.from), to: Math.min(span.to, bounds.to) };
  return part.to >= part.from ? [part] : [];
}

/** Spans in order, those that touch or overlap made one. */
function joined(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans.toSorted((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (span.to < span.from) continue;
    if (last && span.from <= last.to) {
      out[out.length - 1] = { from: last.from, to: Math.max(last.to, span.to) };
    } else out.push({ from: span.from, to: span.to });
  }
  return out;
}

/** What a run from a position needs of a track before it starts. */
export interface Need {
  /** The position, on the file's clock: what shows there has to show at once. */
  readonly at: number;
  /**
   * Up to where the history has to be whole: a little after the position, from where the run
   * brings everything itself.
   */
  readonly upTo: number;
  /** Lines of text: each stands alone and lasts as long as it says. Otherwise packets. */
  readonly text: boolean;
  /**
   * Whether a packet starts the subtitles afresh, so nothing before it matters. Null for text,
   * and for packets that never do: those need the file from its start.
   */
  readonly fresh: ((entry: SubtitleEntry) => boolean) | null;
}

/** What a file's index lists of a track; see matroska.ts. */
export interface TrackIndex {
  /** The time of each packet it lists, in seconds on the file's clock, in order. */
  readonly times: readonly number[];
}

/** How far before a listed time a reading for the packet listed there starts. */
const INDEX_EDGE_S = 0.05;
/** How far back the first reading for a fresh start goes, without an index; each next one doubles. */
const FIRST_LOOK_BACK_S = 6;
/** After this many readings, the next one starts from the start of the file. */
const SCANS_BEFORE_START = 12;

/**
 * The entries a decoder needs before a run from `need.at`, when the history holds them: those
 * from the last fresh start that has taken effect by then, or from the start of the file, up to
 * `need.upTo`; for text, the lines on screen from `need.at` on. Null when more of the file has to
 * be read first.
 */
export function replayFor(history: SubtitleHistory, need: Need): readonly SubtitleEntry[] | null {
  const span = history.spanAt(need.upTo);
  if (!span) return null;
  const fromStart = span.from === Number.NEGATIVE_INFINITY;
  const upTo = history.entriesIn(span, need.upTo);
  // A line of text may have begun at any time before: only the file from its start has them all.
  if (need.text) {
    return fromStart ? upTo.filter((entry) => "until" in entry && entry.until > need.at) : null;
  }
  const { fresh } = need;
  let start = fresh ? upTo.findLastIndex((entry) => entry.at <= need.at && fresh(entry)) : -1;
  // What starts afresh can come as several packets of one time, such as a DVB display's size
  // ahead of its page: the ones before it are part of it.
  while (start > 0 && upTo[start - 1]!.from === upTo[start]!.from) start--;
  if (start >= 0) return upTo.slice(start);
  return fromStart ? upTo : null;
}

/**
 * The next stretch of the file to read so `replayFor` can answer, `tries` readings in; a null
 * `from` reads from the start of the file. Each ends where the read stretch begins and reaches
 * further back, to the packets the index lists when there is one, until a fresh start or the
 * start of the file is in the history.
 */
export function nextScan(
  history: SubtitleHistory,
  need: Need,
  index: TrackIndex | null,
  tries: number,
): { readonly from: number | null; readonly to: number } {
  // What is read reaches down to `low`: the reading ends there.
  const low = history.spanAt(need.upTo)?.from ?? need.upTo;
  const listed = index?.times.filter((time) => time < low) ?? [];
  let from = Number.NEGATIVE_INFINITY;
  if (need.fresh && tries < SCANS_BEFORE_START) {
    const nearest = listed.at(-1);
    if (nearest === undefined) {
      from = low - FIRST_LOOK_BACK_S * 2 ** tries;
    } else {
      // The nearest packet first, then the one before it, then twice as many each time, so a
      // fresh start far back takes few readings.
      from = (listed.at(-(2 ** Math.max(0, tries - 1))) ?? listed[0] ?? nearest) - INDEX_EDGE_S;
    }
  }
  // No further back than what is read before it, which the reading joins.
  const below = history.spanBelow(low);
  if (below && below.to >= from) from = below.to;
  return { from: Number.isFinite(from) ? from : null, to: low };
}
