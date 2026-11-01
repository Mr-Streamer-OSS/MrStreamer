import { GUIDE_DAY_MS, type Listing, type Programme } from "@mrstreamer/contracts/guide";
import {
  GuideFault,
  ingest,
  nativeGuide,
  type Activation,
  type Generation,
  type GuideNative,
  type GuideProblem,
  type Match,
  type Query,
  type Result,
} from "./guide-native.ts";
import type { Provider } from "@mrstreamer/core/provider";
import { searchWords } from "@mrstreamer/core/text";
import type { Part } from "./library.ts";
import type { SourceLogin } from "./login-safety.ts";
import { currentSource } from "./sources.ts";
import { store } from "./store.ts";

/**
 * What a guide downloads with: a subscription's Source, or an external guide's link
 * (guide-sources.ts), its `login` the parts of the link no saved programme may hold.
 */
export interface GuideOrigin extends SourceLogin {
  readonly revision: number;
  readonly provider: Pick<Provider, "liveGuideRequest">;
}

export interface GuideStatus {
  readonly availability: "unknown" | "none" | "available";
  readonly activity: "idle" | "loading";
  readonly fetchedAt: number | null;
  readonly stale: boolean;
  readonly error: GuideProblem | null;
}
export interface Day {
  readonly from: number;
  readonly until: number;
}
export interface ScheduleItem extends Omit<Programme, "description"> {
  readonly detail: string;
}
export interface DayPage {
  readonly programmes: readonly ScheduleItem[];
  readonly cursor: string | null;
}
/** A programme `search` found, on channel `key` (`Channel.key`). */
export interface FoundProgramme {
  readonly key: string;
  readonly programme: ScheduleItem;
}
/** What `search` found, and whether a guide could not be searched. */
export interface ProgrammeSearch {
  readonly found: readonly FoundProgramme[];
  readonly unsearched: boolean;
}
interface Entry {
  activation: Activation;
  /** Cached reads may stand while attach is pending, but its old lease cannot refresh. */
  activating?: true;
  readonly source: GuideOrigin | undefined;
  part?: Part;
  generation: Generation | null;
  failedAt: number;
  refresh?: Promise<void>;
  refreshAbort?: AbortController;
  readonly jobs: Set<string>;
}
interface Token {
  /** The subscription or external guide whose guide `entry` is. */
  readonly owner: string;
  readonly entry: Entry;
  readonly part: Part;
  readonly generation: Generation;
  readonly ids: readonly string[];
  readonly key: string;
  readonly start: number;
  readonly day?: Day;
  /** The `configure` it was read under: new guides or mappings withdraw it. */
  readonly layout: number;
}
/** A token schedule() handed out, with the start of the day read that minted it. */
interface Minted extends Token {
  readonly on: number;
}
const listingOf = (rows: readonly Programme[], at: number): Listing => ({
  now: rows.find((row) => row.start <= at && row.stop > at) ?? null,
  next: rows.find((row) => row.start > at) ?? null,
});
/** The start of the local day `at` is in, as a Schedule's day starts. */
const dayOf = (at: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};
const FRESH = 6 * 3600_000;
/**
 * Channel days whose withdrawals `withdrawn` tells apart: a week of the Guide grid's 24 rows
 * several times over. Past it, a screen's rows of the rest read again once.
 */
const WITHDRAWALS = 2048;
const MAX_AGE = 7 * 86400_000;
const EMPTY: GuideStatus = {
  availability: "unknown",
  activity: "idle",
  fetchedAt: null,
  stale: true,
  error: null,
};

/**
 * Sole JS owner. Account supplies lifecycle and Parts, guide-sources.ts the external guides and
 * mappings (`configure`); screens only read this service. A channel's programmes come from the
 * first guide with current ones for the guide id it is mapped to, then for its own guide ids: its
 * subscription's guide first, then each external guide in order.
 */
export function createGuide(
  port: () => GuideNative = nativeGuide,
  now: () => number = Date.now,
  sourceOf: (key: string) => GuideOrigin | undefined = currentSource,
) {
  const entries = new Map<string, Entry>();
  const parts = new Map<string, Part>();
  const state = store<ReadonlyMap<string, GuideStatus>>(new Map());
  const tokens = new Map<string, Minted>();
  const versions = new Map<string, number>();
  let sequence = 0;
  let era = 0;
  let foreground = true;
  let foregroundCycle = 0;
  let listeners = 0;
  let clock: ReturnType<typeof setInterval> | undefined;
  let lifecycle: readonly { remove(): void }[] = [];
  /** Undefined for one whose link the Keychain didn't give back: its saved guide still reads. */
  let externals: ReadonlyMap<string, GuideOrigin | undefined> = new Map();
  /** Guide ids by `Channel.key`, which a channel's programmes are read by before its own. */
  let mappings: ReadonlyMap<string, string> = new Map();
  let layout = 0;
  const revision = store(0);
  const originOf = (key: string) => sourceOf(key) ?? externals.get(key);
  const id = () => `g${++sequence}`;
  const cancel = async (job: string) => {
    try {
      await port().cancel(job);
    } catch {
      /* A missing binding cannot have an active local job. */
    }
  };
  const stands = (key: string, entry: Entry) =>
    entries.get(key) === entry && originOf(key) === entry.source;
  const usable = (g: Generation | null) =>
    g !== null &&
    g.until > now() &&
    now() - g.fetchedAt <= MAX_AGE &&
    g.fetchedAt - now() <= 600_000;
  const status = (key: string) => state.get().get(key) ?? EMPTY;
  const update = (key: string, change: Partial<GuideStatus> = {}) => {
    const g = entries.get(key)?.generation ?? null;
    state.set(
      new Map(state.get()).set(key, {
        ...status(key),
        fetchedAt: g?.fetchedAt ?? null,
        stale: !usable(g) || (g !== null && now() - g.fetchedAt >= FRESH),
        ...change,
      }),
    );
  };
  /** Each token by what it names, so reading the same programme or page again reuses it. */
  const minted = new Map<string, string>();
  const named = (value: Minted) =>
    JSON.stringify([
      value.generation.id,
      value.key,
      value.ids,
      value.start,
      value.day?.from ?? null,
      value.on,
    ]);
  const drop = (key: string) => {
    const value = tokens.get(key);
    if (value && minted.get(named(value)) === key) minted.delete(named(value));
    tokens.delete(key);
  };
  /**
   * By channel and day read, the last withdrawal of its tokens, numbered across all of them, so a
   * screen reads again. The least recently withdrawn half goes past WITHDRAWALS; one gone answers
   * `floor`, the last number it held or later, so it never answers what a screen read before.
   */
  const withdrawals = new Map<string, number>();
  let withdrawn = 0;
  let floor = 0;
  /** Changes once after a run of withdrawals, which evictions make without another notification. */
  const withdrawing = store(0);
  /** Whether the app is in the foreground, as foreground() and background() last said. */
  const awake = store(true);
  let announced = false;
  const read = (key: string, on: number) => JSON.stringify([key, on]);
  const withdraw = (value: Minted) => {
    const at = read(value.key, value.on);
    withdrawals.delete(at);
    withdrawals.set(at, ++withdrawn);
    if (withdrawals.size > WITHDRAWALS)
      for (const [each, number] of withdrawals) {
        if (withdrawals.size <= WITHDRAWALS / 2) break;
        withdrawals.delete(each);
        floor = number;
      }
    if (announced) return;
    announced = true;
    queueMicrotask(() => {
      announced = false;
      withdrawing.set((count) => count + 1);
    });
  };
  const invalidate = (entry: Entry) => {
    revision.set((value) => value + 1);
    for (const [key, value] of tokens)
      if (value.entry === entry) {
        withdraw(value);
        drop(key);
      }
  };
  // The least recently minted or read goes first, withdrawn, once 8192 different programmes and
  // pages are held: 32 Guide grid rows of 256 programmes, or about 170 of 48. The grid's 24 rows of
  // two native pages of 128 (GuideIndex.swift) mint fewer, so its rows never evict each other.
  const token = (value: Minted) => {
    const name = named(value);
    const known = minted.get(name);
    const held = known === undefined ? undefined : tokens.get(known);
    if (
      known !== undefined &&
      held?.entry === value.entry &&
      held.part === value.part &&
      held.generation === value.generation
    ) {
      tokens.delete(known);
      tokens.set(known, held);
      return known;
    }
    const oldest = tokens.entries().next().value;
    if (tokens.size >= 8192 && oldest) {
      withdraw(oldest[1]);
      drop(oldest[0]);
    }
    const key = id();
    tokens.set(key, value);
    minted.set(name, key);
    return key;
  };
  const validToken = (value: Token) =>
    value.layout === layout &&
    stands(value.owner, value.entry) &&
    parts.get(value.part.subscriptionId) === value.part &&
    value.entry.generation === value.generation &&
    usable(value.generation);
  /** Withdraws the reads of a subscription's channels, from external guides too. */
  const withdrawChannels = (subscriptionId: string) => {
    revision.set((value) => value + 1);
    for (const [key, value] of tokens)
      if (value.part.subscriptionId === subscriptionId) {
        withdraw(value);
        drop(key);
      }
  };
  /** Withdraws every read handed out, and refuses those under way. */
  const withdrawAll = () => {
    revision.set((value) => value + 1);
    layout++;
    for (const value of tokens.values()) withdraw(value);
    tokens.clear();
    minted.clear();
  };
  const cancelEntry = (entry: Entry) => {
    entry.refreshAbort?.abort();
    invalidate(entry);
    for (const job of entry.jobs) void cancel(job);
  };
  const connect = () => {
    if (lifecycle.length) return;
    const native = port();
    if (native.addListener)
      lifecycle = [
        native.addListener("foreground", () => service.foreground()),
        native.addListener("background", () => service.background()),
      ];
  };
  async function refresh(key: string, explicit = true): Promise<void> {
    if (!foreground) return;
    let entry = entries.get(key);
    // A failed activation has no usable lease. The public Retry action must acquire one.
    if (!entry && explicit && originOf(key)) {
      await service.attach(key);
      entry = entries.get(key);
    }
    if (!entry || entry.activating || !entry.source || !stands(key, entry) || !foreground) return;
    if (entry.refresh) return entry.refresh;
    if (!explicit && now() - entry.failedAt < 15 * 60_000) return;
    const source = entry.source;
    const lease = entry.activation.lease;
    const job = id();
    entry.jobs.add(job);
    const controller = new AbortController();
    const startedCycle = foregroundCycle;
    entry.refreshAbort = controller;
    entry.refresh = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      try {
        const native = port();
        if (!native.begin(entry.activation.lease, job)) throw new GuideFault("busy");
        timer = setTimeout(() => {
          expired = true;
          entry.failedAt = now();
          if (stands(key, entry) && foreground) update(key, { error: "time" });
          controller.abort();
          void cancel(job);
        }, 180_000);
        const wanted = () => !controller.signal.aborted && foreground && stands(key, entry);
        update(key, { activity: "loading", error: null });
        if (!source.provider.liveGuideRequest) throw new GuideFault("unavailable");
        const request = await source.provider.liveGuideRequest(controller.signal);
        if (!wanted()) return;
        if (request.kind === "none") {
          // Only an authoritative provider answer clears availability.
          native.revoke(key);
          if (!(await native.forget(key))) throw new GuideFault("disk");
          if (!stands(key, entry)) return;
          try {
            entry.activation = await native.attach(key, source.revision);
          } catch {
            if (stands(key, entry)) {
              cancelEntry(entry);
              entries.delete(key);
              update(key, { availability: "none", activity: "idle", error: "unavailable" });
            }
            return;
          }
          if (!stands(key, entry)) return;
          entry.generation = null;
          invalidate(entry);
          update(key, { availability: "none" });
          return;
        }
        const result = await ingest(
          native,
          entry.activation.lease,
          job,
          request,
          source,
          now(),
          wanted,
        );
        // An ok publish is already committed. Background/deadline cannot roll it back.
        // Source/entry replacement still rejects the receipt, including remove/re-add.
        if (!stands(key, entry) || entry.activation.lease !== lease) return;
        if (result.kind === "ok") {
          entry.generation = result.value;
          // An external guide can now answer channels another guide answered before.
          if (externals.has(key)) withdrawAll();
          else {
            invalidate(entry);
            withdrawChannels(key);
          }
          entry.failedAt = -Infinity;
          update(key, { availability: "available", error: null });
        } else if (wanted() && result.kind === "failed") throw new GuideFault(result.error);
      } catch (cause) {
        if (stands(key, entry) && foreground && (!controller.signal.aborted || expired)) {
          entry.failedAt = now();
          update(key, {
            error: expired ? "time" : cause instanceof GuideFault ? cause.problem : "network",
          });
        }
      } finally {
        clearTimeout(timer);
        await cancel(job);
        entry.jobs.delete(job);
        delete entry.refresh;
        delete entry.refreshAbort;
        if (stands(key, entry)) {
          update(key, { activity: "idle" });
          // A foreground event while cancellation drained gets one fresh attempt.
          if (
            foreground &&
            foregroundCycle !== startedCycle &&
            controller.signal.aborted &&
            !expired &&
            status(key).stale
          )
            void refresh(key, false);
        }
      }
    })();
    return entry.refresh;
  }
  /** The channel an owned key names, by its canonical key, with its subscription's Part. */
  const channelOf = (key: string) => {
    const colon = key.indexOf(":");
    if (colon < 1) return null;
    const part = parts.get(key.slice(0, colon));
    const channel = part?.byId.get(key.slice(colon + 1));
    return part && channel ? { part, channel } : null;
  };
  /**
   * What to read a channel by, in order, from each guide with a usable generation: its mapped id,
   * then its own ids, or only `trying`.
   */
  const candidates = (key: string, trying?: string): Token[] => {
    const found = channelOf(key);
    if (!found) return [];
    const { part, channel } = found;
    const own = part.guideIds.get(channel.id) ?? [];
    const mapped = mappings.get(channel.key);
    const guides = [part.subscriptionId, ...externals.keys()].flatMap((owner) => {
      const entry = entries.get(owner);
      return entry?.generation && stands(owner, entry) && usable(entry.generation)
        ? [{ owner, entry, generation: entry.generation }]
        : [];
    });
    const passes = trying
      ? [[trying]]
      : mapped
        ? [[mapped], own.filter((id) => id !== mapped)]
        : [own];
    return passes
      .filter((ids) => ids.length > 0)
      .flatMap((ids) =>
        guides.map((read) => ({ ...read, part, ids, key: channel.key, start: -1, layout })),
      );
  };
  /** The first candidate whose guide has the channel, with its answer. */
  async function first(
    key: string,
    mode: "listing" | "day",
    day: Day,
    signal?: AbortSignal,
    trying?: string,
  ) {
    for (const captured of candidates(key, trying)) {
      const answer = await query(captured, mode, day, signal);
      if (signal?.aborted) return null;
      if (answer?.guideId) return { captured, answer };
    }
    return null;
  }
  function query(
    value: Token,
    mode: "listing" | "day" | "detail",
    day: Day,
    signal?: AbortSignal,
  ): Promise<Query | null> {
    return ask(value, signal, (native, lease, job) =>
      native.query(
        lease,
        value.generation.id,
        job,
        value.ids,
        now(),
        mode,
        day.from,
        day.until,
        value.start,
      ),
    );
  }
  /**
   * Runs `read` as a job of `value`'s guide within its 2 second budget: its answer, or null where
   * `value` no longer stands, `signal` aborted, the budget ran out or the native reader refused.
   */
  async function ask<T>(
    value: Token,
    signal: AbortSignal | undefined,
    read: (native: GuideNative, lease: string, job: string) => Promise<Result<T>>,
  ): Promise<T | null> {
    if (signal?.aborted || !validToken(value)) return null;
    const native = port();
    const job = id();
    value.entry.jobs.add(job);
    if (!native.begin(value.entry.activation.lease, job)) {
      value.entry.jobs.delete(job);
      return null;
    }
    const cancel = () => {
      void native.cancel(job);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      cancel();
    }, 2000);
    let result: Result<T>;
    try {
      result = await read(native, value.entry.activation.lease, job);
    } finally {
      try {
        await native.cancel(job);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
        value.entry.jobs.delete(job);
      }
    }
    // Cleanup is an asynchronous boundary too. Validate at the final public return.
    return !expired && !signal?.aborted && validToken(value) && result.kind === "ok"
      ? result.value
      : null;
  }
  const tick = () => {
    for (const key of entries.keys()) {
      update(key);
      if (status(key).stale) void refresh(key, false);
    }
  };
  const service = {
    status,
    /** Immutable owner snapshot for React; notifications also carry the foreground minute tick. */
    getSnapshot: state.get,
    /** Changes when guide contents, channel ids or mappings invalidate listing answers, not status. */
    listingRevision: { get: revision.get, subscribe: revision.subscribe },
    /**
     * Changes as the detail tokens schedule() handed out for a channel's own key (`Channel.key`)
     * on the day from `on` are withdrawn, as by background() or eviction, and may change as other
     * channel days are; it never changes back.
     */
    withdrawn: (key: string, on: number) => withdrawals.get(read(key, on)) ?? floor,
    /** Notifies, once a run of them is over, that `withdrawn` changed. */
    withdrawals: { get: withdrawing.get, subscribe: withdrawing.subscribe },
    /** Whether the app is in the foreground; the Guide grid reads only then. */
    awake: { get: awake.get, subscribe: awake.subscribe },
    subscribe(listener: () => void) {
      const stop = state.subscribe(listener);
      listeners++;
      if (listeners === 1 && foreground) clock = setInterval(tick, 60_000);
      return () => {
        stop();
        if (--listeners === 0) {
          clearInterval(clock);
          clock = undefined;
        }
      };
    },
    /**
     * At launch: restores the saved guides of `ids` and erases the rest, keeping unread those
     * whose id starts with one of `kept` (guide-native.ts `restore`).
     */
    async restore(ids: readonly string[], kept: readonly string[] = []) {
      const cycle = ++era;
      for (const entry of entries.values()) cancelEntry(entry);
      entries.clear();
      withdrawAll();
      try {
        connect();
        const restored = await port().restore(ids, kept);
        if (cycle !== era) return;
        for (const value of restored) {
          if (!ids.includes(value.subscriptionId)) continue;
          const entry: Entry = {
            activation: value.activation,
            source: undefined,
            generation: value.activation.generation,
            failedAt: -Infinity,
            jobs: new Set(),
          };
          entries.set(value.subscriptionId, entry);
          const part = parts.get(value.subscriptionId);
          if (part) entry.part = part;
          update(value.subscriptionId, {
            availability: usable(entry.generation) ? "available" : "unknown",
            activity: "idle",
            error: null,
          });
        }
      } catch {
        for (const key of ids) update(key, { error: "unavailable" });
      }
    },
    async attach(key: string) {
      const source = originOf(key);
      const cycle = era;
      if (!source) return;
      const before = entries.get(key);
      if (before?.source === source) return;
      let pending: Entry | undefined;
      if (before) {
        cancelEntry(before);
        pending = {
          activation: before.activation,
          activating: true,
          source,
          generation: before.generation,
          failedAt: -Infinity,
          jobs: new Set(),
          ...(before.part ? { part: before.part } : {}),
        };
        entries.set(key, pending);
      }
      const version = (versions.get(key) ?? 0) + 1;
      versions.set(key, version);
      try {
        connect();
        const activation = await port().attach(key, source.revision);
        if (originOf(key) !== source || versions.get(key) !== version || cycle !== era) return;
        const entry: Entry = pending ?? {
          activation,
          source,
          generation: activation.generation,
          failedAt: -Infinity,
          jobs: new Set(),
        };
        invalidate(entry);
        entry.activation = activation;
        entry.generation = activation.generation;
        delete entry.activating;
        const part = parts.get(key);
        if (part) entry.part = part;
        entries.set(key, entry);
        update(key, {
          availability: usable(entry.generation) ? "available" : "unknown",
          activity: "idle",
          error: null,
        });
        if (status(key).stale) void refresh(key, false);
      } catch {
        if (pending && entries.get(key) === pending) {
          cancelEntry(pending);
          entries.delete(key);
        }
        if (originOf(key) === source && versions.get(key) === version && cycle === era)
          update(key, { error: "unavailable" });
      }
    },
    setPart(part: Part) {
      parts.set(part.subscriptionId, part);
      withdrawChannels(part.subscriptionId);
      const entry = entries.get(part.subscriptionId);
      if (entry) {
        invalidate(entry);
        entry.part = part;
      }
    },
    /**
     * The external guides, in the order channels read them after their subscription's own, and
     * guide ids by `Channel.key`. Every read handed out before is withdrawn and screens told, so
     * they read again. A guide given a new link needs `attach` again.
     */
    configure(
      guides: ReadonlyMap<string, GuideOrigin | undefined>,
      mapped: ReadonlyMap<string, string>,
    ) {
      externals = guides;
      mappings = mapped;
      withdrawAll();
      state.set(new Map(state.get()));
    },
    /** The guide ids channel `key`'s provider names it by, as its own guide is read. */
    guideIdsOf(key: string): readonly string[] {
      const found = channelOf(key);
      return found?.part.guideIds.get(found.channel.id) ?? [];
    },
    /**
     * What channel `key` shows now and next when mapped to `guideId`, and from which guide: its
     * subscription's or an external guide's id. Null where no guide has current programmes for it.
     */
    async preview(
      key: string,
      guideId: string,
      options?: { readonly signal?: AbortSignal },
    ): Promise<{ readonly guide: string; readonly listing: Listing } | null> {
      const read = await first(key, "listing", { from: 0, until: 0 }, options?.signal, guideId);
      if (!read || options?.signal?.aborted || !validToken(read.captured)) return null;
      return { guide: read.captured.owner, listing: listingOf(read.answer.rows, now()) };
    },
    /**
     * Up to 20 programmes on now or later whose title has every word of `text`, from every guide:
     * on now first, then by start. Each is on the first of `keys` (`Channel.key`, in the order
     * Search lists channels) whose programmes are read from the guide and id it was found by, as
     * `listings` reads them, and its `detail` reads it with `programme`. Nothing is found once guides,
     * sources, catalogues or mappings change during it. `unsearched` where a standing guide could
     * not be read in the foreground: its channels find nothing, and the rest find what they do.
     */
    async search(
      text: string,
      keys: readonly string[],
      options?: { readonly signal?: AbortSignal },
    ): Promise<ProgrammeSearch> {
      const signal = options?.signal;
      const none = { found: [], unsearched: false };
      const words = [...new Set(searchWords(text))];
      // Past what the native reader takes, as no title of its 300 characters folds to more.
      if (
        words.length === 0 ||
        words.length > 160 ||
        words.some((word) => new TextEncoder().encode(word).length > 32768)
      )
        return none;
      // What every answer stands on, which a change during the search leaves it none of.
      const footing = () => [
        layout,
        ...[...entries].flatMap(([key, entry]) => [key, entry, entry.generation, originOf(key)]),
        ...parts.values(),
      ];
      const before = footing();
      const at = now();
      let unsearched = false;
      /** Runs `read` on `value`'s guide; `unsearched` where that guide stands but didn't answer. */
      const asked = async <T>(
        value: Token,
        read: (native: GuideNative, lease: string, job: string) => Promise<Result<T>>,
      ) => {
        const answer = await ask(value, signal, read);
        if (!answer && !signal?.aborted && foreground && validToken(value)) unsearched = true;
        return answer;
      };
      // The guide ids each guide has programmes for now, which tell which guide answers a channel,
      // or null for one that didn't say.
      const current = new Map<string, ReadonlySet<string> | null>();
      const standing = [...entries].filter(
        ([owner, entry]) => stands(owner, entry) && usable(entry.generation),
      ).length;
      for (const key of keys) {
        if (current.size >= standing || signal?.aborted) break;
        for (const value of candidates(key))
          if (!current.has(value.owner)) {
            const answer = await asked(value, (native, lease, job) =>
              native.current(lease, value.generation.id, job, at),
            );
            current.set(value.owner, answer && new Set(answer.ids));
          }
      }
      // By guide, the first of `keys` that reads each of its guide ids.
      const guides = new Map<
        string,
        { readonly asking: Token; readonly by: Map<string, Token & { readonly key: string }> }
      >();
      const places = new Map<string, number>();
      for (const [place, key] of keys.entries())
        for (const value of candidates(key)) {
          const ids = current.get(value.owner);
          // Which guide answers it is unknown past one that didn't say.
          if (ids === null || signal?.aborted) break;
          const guideId = value.ids.find((id) => ids?.has(id));
          if (!guideId) continue;
          if (places.has(value.key)) break;
          places.set(value.key, place);
          const read = guides.get(value.owner) ?? { asking: value, by: new Map() };
          guides.set(value.owner, read);
          if (!read.by.has(guideId)) read.by.set(guideId, value);
          break;
        }
      const found: { captured: Token; match: Match }[] = [];
      for (const { asking, by } of guides.values()) {
        const answer = await asked(asking, (native, lease, job) =>
          native.search(lease, asking.generation.id, job, [...by.keys()], words, at, 20),
        );
        for (const match of answer?.rows ?? []) {
          const captured = by.get(match.guideId);
          if (captured) found.push({ captured, match });
        }
      }
      const after = footing();
      if (
        signal?.aborted ||
        after.length !== before.length ||
        after.some((v, n) => v !== before[n])
      )
        return none;
      const rank = ({ match }: (typeof found)[number]) => (match.start <= at ? 0 : 1);
      const programmes = found
        .filter(({ captured }) => validToken(captured))
        .sort(
          (a, b) =>
            rank(a) - rank(b) ||
            a.match.start - b.match.start ||
            places.get(a.captured.key)! - places.get(b.captured.key)!,
        )
        .slice(0, 20)
        .map(({ captured, match: { guideId, start, stop, title } }) => ({
          key: captured.key,
          programme: {
            start,
            stop,
            title,
            detail: token({ ...captured, ids: [guideId], start, on: dayOf(start) }),
          },
        }));
      return { found: programmes, unsearched };
    },
    async forget(key: string): Promise<boolean> {
      withdrawChannels(key);
      versions.set(key, (versions.get(key) ?? 0) + 1);
      const entry = entries.get(key);
      entries.delete(key);
      parts.delete(key);
      state.set(new Map([...state.get()].filter(([id]) => id !== key)));
      try {
        port().revoke(key);
        if (entry) cancelEntry(entry);
        return await port().forget(key);
      } catch {
        return false;
      }
    },
    refresh,
    foreground() {
      foregroundCycle++;
      foreground = true;
      awake.set(true);
      if (listeners && !clock) clock = setInterval(tick, 60_000);
      tick();
    },
    background() {
      foreground = false;
      awake.set(false);
      clearInterval(clock);
      clock = undefined;
      for (const entry of entries.values()) cancelEntry(entry);
    },
    async listings(
      keys: readonly string[],
      options?: { readonly signal?: AbortSignal },
    ): Promise<ReadonlyMap<string, Listing>> {
      if (keys.length > 40) throw new GuideFault("reply");
      const answers = new Map<string, Awaited<ReturnType<typeof first>>>();
      // Retain each requested alias independently. Later batches must not hide earlier captures.
      for (let offset = 0; offset < keys.length; offset += 2)
        await Promise.all(
          keys.slice(offset, offset + 2).map(async (key) => {
            answers.set(key, await first(key, "listing", { from: 0, until: 0 }, options?.signal));
          }),
        );
      const result = new Map<string, Listing>();
      const at = now();
      for (const [key, value] of answers) {
        const rows =
          !options?.signal?.aborted && value && validToken(value.captured)
            ? value.answer.rows
            : undefined;
        result.set(key, listingOf(rows ?? [], at));
      }
      return result;
    },
    async schedule(
      key: string,
      day: Day,
      cursor?: string,
      options?: { readonly signal?: AbortSignal },
    ): Promise<DayPage> {
      if (
        !Number.isFinite(day.from) ||
        !Number.isFinite(day.until) ||
        day.until <= day.from ||
        day.until - day.from > GUIDE_DAY_MS
      )
        throw new GuideFault("time");
      const date = new Date(day.from);
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const tomorrow = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
      if (start.getTime() !== day.from || tomorrow.getTime() !== day.until)
        throw new GuideFault("time");
      let read: Awaited<ReturnType<typeof first>> = null;
      if (cursor) {
        const captured = tokens.get(cursor);
        if (
          captured &&
          validToken(captured) &&
          captured.day?.from === day.from &&
          captured.day.until === day.until &&
          channelOf(key)?.channel.key === captured.key
        ) {
          const answer = await query(captured, "day", day, options?.signal);
          if (answer) read = { captured, answer };
        }
      } else read = await first(key, "day", day, options?.signal);
      const guideId = read?.answer.guideId;
      if (!read || !guideId || options?.signal?.aborted || !validToken(read.captured))
        return { programmes: [], cursor: null };
      const { captured, answer } = read;
      const ids = [guideId];
      const programmes = answer.rows.map(({ start, stop, title }) => ({
        start,
        stop,
        title,
        detail: token({ ...captured, ids, start, on: day.from }),
      }));
      const last = programmes.at(-1);
      return {
        programmes,
        cursor:
          answer.more && last
            ? token({ ...captured, ids, start: last.start, day, on: day.from })
            : null,
      };
    },
    async programme(
      detail: string,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Programme | null> {
      const captured = tokens.get(detail);
      if (!captured || !validToken(captured)) return null;
      // Newest again, so a programme read as it shows outlasts the day pages minted after it.
      tokens.delete(detail);
      tokens.set(detail, captured);
      const answer = await query(captured, "detail", { from: 0, until: 0 }, options?.signal);
      return !options?.signal?.aborted && validToken(captured) ? (answer?.rows[0] ?? null) : null;
    },
    /**
     * The programme channel `key` (`Channel.key`) has starting exactly at `start`, from the
     * first guide with current programmes for it, as `listings` reads it, with a `detail` token
     * for `programme`. `none` where that guide lists nothing starting then; null where no guide
     * answers for the channel now, or one that stands couldn't be read: nothing is known.
     */
    async programmeAt(
      key: string,
      start: number,
      options?: { readonly signal?: AbortSignal },
    ): Promise<
      | { readonly kind: "found"; readonly programme: Programme; readonly detail: string }
      | { readonly kind: "none" }
      | null
    > {
      if (!Number.isFinite(start)) return null;
      for (const captured of candidates(key)) {
        const asking = { ...captured, start };
        const answer = await query(asking, "detail", { from: 0, until: 0 }, options?.signal);
        if (!answer || options?.signal?.aborted || !validToken(captured)) return null;
        if (!answer.guideId) continue;
        const programme = answer.rows[0];
        if (!programme) return { kind: "none" };
        const ids = [answer.guideId];
        return {
          kind: "found",
          programme,
          detail: token({ ...asking, ids, start: programme.start, on: dayOf(programme.start) }),
        };
      }
      return null;
    },
  };
  return service;
}

export const guide = createGuide();
