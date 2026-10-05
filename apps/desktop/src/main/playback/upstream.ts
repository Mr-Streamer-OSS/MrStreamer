// One request to the provider at a time, for everything that reads a movie's file: playback, which
// is ffprobe and ffmpeg reading through the proxy, and recovery, which reads the parts of the file
// a subtitle track's past is in. Many subscriptions allow a single connection, so each takes a
// turn, and gives it back only once its request and body are over.
//
// Playback goes first, always. A new request of ffmpeg's, as it makes to start and to skip, ends
// recovery's request at once. A request for more of what ffmpeg is reading lets recovery's finish
// if that takes no longer than a slice. Recovery gets a turn when playback rests, with ffmpeg
// taking nothing more for now; while ffmpeg takes the file as it comes, only between two of its
// requests and only while the player has enough buffered to spare one. While a run is attached,
// recovery holds the slot for no more than a share of the time.

export interface Lease {
  /** Aborts when the turn is taken away, for something that goes first. */
  readonly revoked: AbortSignal;
  /** Gives the turn back. Its holder calls this once its request and body are over. */
  release(): void;
}

export interface UpstreamLimits {
  /** The longest playback waits for a request of recovery's to finish, in ms. */
  readonly sliceMs: number;
  /** The share of `windowMs` recovery may hold the slot while a run is attached. */
  readonly share: number;
  readonly windowMs: number;
  /** Recovery takes turns between playback's requests from this much buffered, in seconds. */
  readonly startBufferS: number;
  /** And stops below this much. */
  readonly stopBufferS: number;
  /** What the player last said counts for this long, in ms. */
  readonly progressMs: number;
}

export const UPSTREAM_LIMITS: UpstreamLimits = {
  sliceMs: 250,
  share: 0.1,
  windowMs: 10_000,
  startBufferS: 10,
  stopBufferS: 5,
  progressMs: 2000,
};

/** What the player says about the title it plays, while it waits for subtitles. */
export interface Progress {
  /** Seconds buffered beyond the position. */
  readonly buffered: number;
  readonly paused: boolean;
  /** When it said so, as `performance.now()`. */
  readonly at: number;
}

/** What the slot asks its session before it gives recovery a turn. */
export interface UpstreamState {
  /** A run is starting: until its picture has reached the player, only playback reads. */
  starting(): boolean;
  /** A run is attached, so recovery keeps to its share. */
  attached(): boolean;
  /** ffmpeg is taking the file as it comes, between two requests too: playback wants the provider. */
  reading(): boolean;
  progress(): Progress | null;
}

/** What the slot counted, for diagnostics and tests. */
interface UpstreamCounts {
  /** Turns of recovery's that were taken away before their request was over. */
  revoked: number;
  /** Milliseconds recovery held the slot. */
  recoveryMs: number;
  /** The longest playback waited for a turn while recovery held the slot, in ms. */
  longestWaitMs: number;
}

interface Waiter {
  readonly lane: "play" | "recover";
  /** A new request of ffmpeg's rather than more of the one it reads. */
  readonly fresh: boolean;
  readonly since: number;
  /** Since when recovery has had turns ahead of this one; null when it hasn't. */
  yielded: number | null;
  grant(lease: Lease | null): void;
}

interface Holder {
  readonly lane: "play" | "recover";
  readonly since: number;
  readonly revoke: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export type UpstreamSlot = ReturnType<typeof upstreamSlot>;

export function upstreamSlot(state: UpstreamState, limits: UpstreamLimits = UPSTREAM_LIMITS) {
  let holder: Holder | null = null;
  const waiting: Waiter[] = [];
  /** When recovery held the slot, within the last window. */
  let held: { readonly from: number; readonly to: number }[] = [];
  /** Recovery is taking turns between playback's requests; see `spare`. */
  let sparing = false;
  /** How long recovery's last whole request held the slot, in ms. */
  let usual = 0;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  const counts: UpstreamCounts = { revoked: 0, recoveryMs: 0, longestWaitMs: 0 };
  const listeners = new Set<() => void>();

  const first = (lane: Waiter["lane"]) => waiting.find((each) => each.lane === lane);

  /** How long recovery held the slot within the window, in ms. */
  function recoveryTime(now: number): number {
    held = held.filter((each) => each.to > now - limits.windowMs);
    const running = holder?.lane === "recover" ? now - holder.since : 0;
    return (
      running +
      held.reduce((sum, each) => sum + each.to - Math.max(each.from, now - limits.windowMs), 0)
    );
  }

  /** Whether recovery may have the slot now; `between` two of playback's requests, or free. */
  function spare(between: boolean, now: number): boolean {
    if (state.starting()) return false;
    const said = state.progress();
    const progress = said && now - said.at <= limits.progressMs ? said : null;
    const withinShare =
      !state.attached() ||
      progress?.paused === true ||
      recoveryTime(now) < limits.share * limits.windowMs;
    if (!between) return withinShare;
    // Playback wants the slot: only a player with enough buffered spares a turn.
    sparing =
      progress !== null &&
      progress.buffered >= (sparing ? limits.stopBufferS : limits.startBufferS);
    return sparing && withinShare;
  }

  function give(waiter: Waiter): void {
    waiting.splice(waiting.indexOf(waiter), 1);
    const now = performance.now();
    const mine: Holder = {
      lane: waiter.lane,
      since: now,
      revoke: new AbortController(),
      timer: undefined,
    };
    holder = mine;
    waiter.grant({
      revoked: mine.revoke.signal,
      release: () => {
        if (holder !== mine) return;
        clearTimeout(mine.timer);
        holder = null;
        if (mine.lane === "recover") {
          const to = performance.now();
          held.push({ from: mine.since, to });
          counts.recoveryMs += to - mine.since;
          if (mine.revoke.signal.aborted) counts.revoked++;
          else usual = to - mine.since;
          // Recovery asks for its next part of the file in a moment: whoever goes next is
          // decided once it has, so a slice can hold more than one request.
          recheck = setTimeout(turn, 0);
          return;
        }
        turn();
      },
    });
    press();
  }

  /** Takes recovery's turn away when playback waits: at once for a new request, else at its slice's end. */
  function press(): void {
    const mine = holder;
    const play = first("play");
    if (!mine || mine.lane !== "recover" || !play || mine.revoke.signal.aborted) return;
    clearTimeout(mine.timer);
    // A slice counts from the first turn recovery took ahead of the request that waits.
    const from = play.yielded ?? mine.since;
    const left = play.fresh ? 0 : from + limits.sliceMs - performance.now();
    if (left <= 0) mine.revoke.abort();
    else mine.timer = setTimeout(() => mine.revoke.abort(), left);
  }

  function turn(): void {
    clearTimeout(recheck);
    recheck = undefined;
    const recover = first("recover");
    if (holder) {
      press();
      // Recovery waits behind a request of playback's that stays open: its holder hears now and
      // then, and ends it when playback can spare the provider.
      if (holder.lane === "play" && recover) {
        for (const listener of listeners) listener();
        recheck = setTimeout(turn, 50);
      }
      return;
    }
    const now = performance.now();
    const play = first("play");
    if (play) {
      // Another request of recovery's only when it is likely over within the slice: one cut
      // short is asked again, and the provider may take a moment to free its connection.
      const within = play.yielded === null || now - play.yielded + usual < limits.sliceMs;
      if (recover && !play.fresh && within && spare(true, now)) {
        play.yielded ??= now;
        return give(recover);
      }
      counts.longestWaitMs = Math.max(counts.longestWaitMs, now - play.since);
      return give(play);
    }
    if (!recover) return;
    if (spare(state.reading(), now)) return give(recover);
    // Its share frees up with time, and the player says more.
    recheck = setTimeout(turn, 50);
  }

  function wait(lane: Waiter["lane"], signal: AbortSignal, fresh: boolean): Promise<Lease | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const left = () => {
        waiting.splice(waiting.indexOf(waiter), 1);
        resolve(null);
      };
      const waiter: Waiter = {
        lane,
        fresh,
        since: performance.now(),
        // A request that finds recovery at its turn gives way from when that began.
        yielded: lane === "play" && holder?.lane === "recover" ? holder.since : null,
        grant: (lease) => {
          signal.removeEventListener("abort", left);
          resolve(lease);
        },
      };
      signal.addEventListener("abort", left, { once: true });
      // Playback's requests replace each other, newest last; recovery's wait in line.
      waiting.push(waiter);
      turn();
    });
  }

  return {
    /**
     * Playback's turn; null when `signal` aborts first. `fresh` for a new request of ffmpeg's,
     * which doesn't wait for recovery.
     */
    play: (signal: AbortSignal, fresh: boolean) => wait("play", signal, fresh),
    /** Recovery's turn, once playback spares one; null when `signal` aborts first. */
    recover: (signal: AbortSignal) => wait("recover", signal, false),
    /**
     * Whether recovery waits for a turn that playback's open request keeps from it, and would get
     * it: `reading` when ffmpeg is taking the file as fast as it comes.
     */
    wanted(reading: boolean): boolean {
      return first("recover") !== undefined && spare(reading, performance.now());
    },
    /**
     * Hears, now and then, while recovery waits for a turn behind a request of playback's; the
     * answer stops listening.
     */
    onWanting(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Looks again whether recovery may have a turn: the player said something new. */
    look: turn,
    /** Ends recovery's request, if it has the slot: playback is about to want the provider. */
    clear(): void {
      if (holder?.lane === "recover") holder.revoke.abort();
    },
    counts,
  };
}

/** How fast the provider's file arrives, from the bodies read without the reader holding back. */
export function rateMeter() {
  let rate: number | null = null;
  return {
    /** A body, or part of one, of `bytes` arrived in `ms`. */
    add(bytes: number, ms: number): void {
      if (bytes < 32 * 1024 || ms <= 0) return;
      const now = (bytes / ms) * 1000;
      rate = rate === null ? now : rate * 0.7 + now * 0.3;
    },
    /** Bytes a second, or null before anything was measured. */
    get rate(): number | null {
      return rate;
    },
  };
}
