import type { Listing, Programme } from "@mrstreamer/contracts/guide";
import { router, useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { guide, type Day, type DayPage, type GuideStatus, type ScheduleItem } from "./guide.ts";
import { usePlayback } from "./playback.ts";
import type { Library } from "./library.ts";
import { currentSource, onSignedIn } from "./sources.ts";
import { colors } from "./ui.tsx";

export type GuideOrigin = "home" | "live";

/** Routes carry only owned channel keys and the owner's opaque detail token. */
export function openSchedule(origin: GuideOrigin, channel: string) {
  router.push({
    pathname: origin === "home" ? "/schedule" : "/live/schedule",
    params: { channel },
  });
}
export function openProgramme(origin: GuideOrigin, channel: string, detail: string) {
  router.push({
    pathname: origin === "home" ? "/programme" : "/live/programme",
    params: { channel, detail },
  });
}

/** A calendar day's first valid instant, including a DST transition that skips midnight. */
export function localDay(at: number, offset = 0): Day {
  const date = new Date(at);
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
  const until = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  return { from: from.getTime(), until: until.getTime() };
}

/** A day's heading over a Schedule or the Guide grid: Today, else its short date. */
export const dayLabel = (day: Day, now: number) =>
  day.from === localDay(now).from
    ? "Today"
    : new Date(day.from).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

export const programmeTime = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export const programmeRange = (programme: Pick<Programme, "start" | "stop">) =>
  `${programmeTime(programme.start)}–${programmeTime(programme.stop)}`;

const nothing = () => () => {};
const authorityOf = (ids: readonly string[], snapshot: ReturnType<typeof guide.getSnapshot>) =>
  ids
    .map((id) => {
      const status = snapshot.get(id);
      return status?.availability === "none"
        ? "none"
        : status?.fetchedAt == null
          ? "cold"
          : "cache";
    })
    .join(":");
const revisionOf = (ids: readonly string[]) =>
  JSON.stringify(ids.map((id) => guide.getSnapshot().get(id)?.fetchedAt ?? null));

/** Focus owns subscriptions, not settled presentation. Source revisions contain no private inputs. */
export function useGuideOwner(subscriptionIds: readonly string[] = []) {
  const inStack = useIsFocused();
  const { watch } = usePlayback();
  const focused = inStack && !watch;
  const signature = JSON.stringify([...new Set(subscriptionIds)]);
  const ids = useMemo(() => JSON.parse(signature) as string[], [signature]);
  const getSources = useCallback(
    () => JSON.stringify(ids.map((id) => currentSource(id)?.revision ?? null)),
    [ids],
  );
  const subscribe = useCallback(
    (listener: () => void) => (focused ? guide.subscribe(listener) : nothing()),
    [focused],
  );
  const subscribeSources = useCallback(
    (listener: () => void) => (focused ? onSignedIn(listener) : nothing()),
    [focused],
  );
  const snapshot = useSyncExternalStore(subscribe, guide.getSnapshot);
  const sources = useSyncExternalStore(subscribeSources, getSources);
  const authority = authorityOf(ids, snapshot);
  const identity = useMemo(() => ({ sources, authority }), [sources, authority]);
  const valid = useCallback(
    () => getSources() === sources && authorityOf(ids, guide.getSnapshot()) === authority,
    [getSources, sources, ids, authority],
  );
  return { snapshot, focused, now: Date.now(), identity, valid, revision: revisionOf(ids) };
}

/** Keep the same authorized presentation mounted while its next read is pending or fails. */
export function useGuideRead<T>(
  load: (signal: AbortSignal) => Promise<T>,
  subscriptionIds: readonly string[],
) {
  const { snapshot, focused, now, identity, valid } = useGuideOwner(subscriptionIds);
  const request = useMemo(() => ({ load, identity }), [load, identity]);
  const [result, setResult] = useState<{
    request: typeof request;
    snapshot: typeof snapshot;
    value: T | undefined;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (!focused) return;
    const controller = new AbortController();
    void load(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && valid())
          setResult({ request, snapshot, value, failed: false });
      },
      () => {
        if (!controller.signal.aborted && valid())
          setResult((before) => ({
            request,
            snapshot,
            value: before?.request === request ? before.value : undefined,
            failed: true,
          }));
      },
    );
    return () => controller.abort();
  }, [request, load, snapshot, focused, valid]);
  const current = result?.request === request ? result : null;
  return {
    value: current?.value,
    failed: current?.failed ?? false,
    pending: focused && (!current || current.snapshot !== snapshot),
    snapshot,
    now,
  };
}

export function useGuideListings(keys: readonly string[], catalogue: Library | null) {
  const signature = JSON.stringify(keys.slice(0, 40));
  const requested = useMemo(() => JSON.parse(signature) as string[], [signature]);
  const load = useCallback(
    (signal: AbortSignal) =>
      guide.listings(
        requested.filter((key) => catalogue?.byKey.has(key)),
        { signal },
      ),
    [requested, catalogue],
  );
  return useGuideRead(
    load,
    requested.map((key) => key.slice(0, key.indexOf(":"))),
  );
}

/** Caps the Guide grid rows read for a day; they are read two channels at a time. */
export const GRID_ROWS = 24;
/**
 * A channel's programmes on a day, in the grid: at most this many of the owner's day pages of
 * 128, so the rows in view mint fewer detail tokens than the owner keeps (guide.ts) and a row
 * read again never evicts another's.
 */
const GRID_PAGES = 2;

/** A channel's day as the grid shows it; `more` when it has programmes past the pages read. */
export interface GridDay {
  readonly programmes: readonly ScheduleItem[];
  readonly more: boolean;
}
interface GridRead extends GridDay {
  /** Whether a page after the first was refused, so it is read again in the next minute. */
  readonly refused: boolean;
  /** The provider's login, guide and generation it was read under (`versionOf`). */
  readonly version: string;
  /** The minute it landed in: an empty day is read again in the next. */
  readonly minute: number;
}
const NO_ROWS: ReadonlyMap<string, GridDay> = new Map();
// With the owner's tokens for the day, which going to the background or eviction withdraws, so a
// row's cells still open.
const versionOf = (key: string, from: number, snapshot: ReturnType<typeof guide.getSnapshot>) => {
  const id = key.slice(0, key.indexOf(":"));
  return JSON.stringify([
    currentSource(id)?.revision ?? null,
    authorityOf([id], snapshot),
    snapshot.get(id)?.fetchedAt ?? null,
    guide.withdrawn(key, from),
  ]);
};

/** Runs reads `width` at a time, in the order asked for; an aborted one gives way at once. */
function lanes(width: number) {
  let free = width;
  const waiting: (() => void)[] = [];
  return async <T,>(signal: AbortSignal, read: () => Promise<T>) => {
    if (free > 0) free--;
    else await new Promise<void>((go) => waiting.push(go));
    try {
      if (signal.aborted) return undefined;
      const aborted = new Promise<undefined>((stop) =>
        signal.addEventListener("abort", () => stop(undefined), { once: true }),
      );
      return await Promise.race([read(), aborted]);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else free++;
    }
  };
}

/** Reads `key`'s day, up to GRID_PAGES pages; undefined when aborted or thrown. */
async function readRow(key: string, day: Day, signal: AbortSignal) {
  const programmes: ScheduleItem[] = [];
  let cursor: string | undefined;
  let refused = false;
  try {
    for (let page = 0; page < GRID_PAGES && !signal.aborted; page++) {
      const got = await guide.schedule(key, day, cursor, { signal });
      programmes.push(...got.programmes);
      // A page after a cursor has programmes, so an empty one was refused.
      refused = cursor !== undefined && got.programmes.length === 0;
      cursor = got.cursor ?? undefined;
      if (!cursor) break;
    }
  } catch {
    // Left out, so it is read again in the next minute, and the other rows still land.
    return undefined;
  }
  return signal.aborted
    ? undefined
    : { programmes, more: cursor !== undefined || refused, refused };
}

/**
 * The Guide grid's days on a local day, by channel key, for the first GRID_ROWS of `keys`: those
 * in view, two at a time, as listings are read. A row shows once it is read and stays while it is
 * in view; only rows new to the view are read. A day is the same all through a guide's
 * generation, so a row is read again when its provider's login or guide changes, which first
 * takes it away, when its tokens are withdrawn, or, when it came back empty or with a page
 * refused, in the next minute. Such a change aborts only that row's read in progress.
 */
export function useGuideGrid(keys: readonly string[], day: Day, catalogue: Library) {
  const signature = JSON.stringify(keys.slice(0, GRID_ROWS));
  const requested = useMemo(() => JSON.parse(signature) as string[], [signature]);
  // Every provider's, so each row's provider is followed.
  const ids = useMemo(() => [...catalogue.labels.keys()], [catalogue]);
  const { snapshot, focused: inStack, now, identity } = useGuideOwner(ids);
  // Going to the background withdraws every token, so rows are read again only once back.
  const focused = useSyncExternalStore(guide.awake.subscribe, guide.awake.get) && inStack;
  // Eviction withdraws tokens with no owner notification, so the rows that lost theirs follow this.
  const withdrawals = useSyncExternalStore(
    useCallback(
      (listener: () => void) => (focused ? guide.withdrawals.subscribe(listener) : nothing()),
      [focused],
    ),
    guide.withdrawals.get,
  );
  type Settled = {
    from: number;
    catalogue: Library;
    rows: ReadonlyMap<string, GridRead>;
  };
  const [settled, setSettled] = useState<Settled | null>(null);
  const latest = useRef(settled);
  latest.current = settled;
  const inView = useRef(requested);
  inView.current = requested;
  // Each row's read in progress, under what it was started, so only a change to that aborts it.
  type Reading = { from: number; catalogue: Library; version: string; controller: AbortController };
  const reading = useRef(new Map<string, Reading>());
  const [lane] = useState(() => lanes(2));
  useEffect(() => {
    const running = reading.current;
    return () => {
      for (const read of running.values()) read.controller.abort();
      running.clear();
    };
  }, []);
  // Only what a row is read under starts reads, not every notification, which ingestion sends
  // often and would abort each read in progress.
  const minute = Math.floor(now / 60_000);
  const versioned = JSON.stringify(requested.map((key) => versionOf(key, day.from, snapshot)));
  useEffect(() => {
    const running = reading.current;
    const listed = JSON.parse(versioned) as string[];
    const versions = new Map(requested.map((key, index) => [key, listed[index] ?? ""] as const));
    // A read stops once its row leaves the view, or what it is read under changes.
    for (const [key, read] of running)
      if (
        !focused ||
        !versions.has(key) ||
        read.from !== day.from ||
        read.catalogue !== catalogue ||
        read.version !== versions.get(key)
      ) {
        read.controller.abort();
        running.delete(key);
      }
    if (!focused) return;
    const before =
      latest.current?.from === day.from && latest.current.catalogue === catalogue
        ? latest.current.rows
        : null;
    for (const key of requested) {
      const row = before?.get(key);
      const version = versions.get(key) ?? "";
      if (
        running.has(key) ||
        !catalogue.byKey.has(key) ||
        (row &&
          row.version === version &&
          ((row.programmes.length > 0 && !row.refused) || row.minute === minute))
      )
        continue;
      const read: Reading = {
        from: day.from,
        catalogue,
        version,
        controller: new AbortController(),
      };
      running.set(key, read);
      const { signal } = read.controller;
      void lane(signal, () => readRow(key, { from: day.from, until: day.until }, signal)).then(
        (got) => {
          if (running.get(key) === read) running.delete(key);
          // A read that a login or guide change or a withdrawal overtook is left out: each of
          // those notifies, so the row is read again under what changed.
          if (!got || signal.aborted || versionOf(key, day.from, guide.getSnapshot()) !== version)
            return;
          const landed = { ...got, version, minute: Math.floor(Date.now() / 60_000) };
          setSettled((prior) => {
            const kept =
              prior?.from === day.from && prior.catalogue === catalogue ? prior.rows : undefined;
            const rows = new Map<string, GridRead>();
            for (const shown of inView.current) {
              const row = shown === key ? landed : kept?.get(shown);
              if (row) rows.set(shown, row);
            }
            return { from: day.from, catalogue, rows };
          });
        },
      );
    }
  }, [day.from, day.until, catalogue, requested, versioned, minute, focused, lane]);
  const rows = useMemo(() => {
    if (settled?.from !== day.from || settled.catalogue !== catalogue) return NO_ROWS;
    const shown = new Map<string, GridDay>();
    for (const [key, row] of settled.rows)
      if (row.version === versionOf(key, day.from, snapshot)) shown.set(key, row);
    return shown;
    // `identity` and `withdrawals` follow each provider's login and tokens, as `versionOf` reads.
  }, [settled, day.from, catalogue, snapshot, identity, withdrawals]);
  return { rows, snapshot, now };
}

/** Reload the represented page span atomically; never append with a prior generation's cursor. */
export function useGuideSchedule(key: string, day: Day, catalogue: Library) {
  const ids = useMemo(() => [key.slice(0, key.indexOf(":"))], [key]);
  const { snapshot, focused, now, identity, valid, revision } = useGuideOwner(ids);
  const request = useMemo(
    () => ({ key, day: { from: day.from, until: day.until }, catalogue, identity }),
    [key, day.from, day.until, catalogue, identity],
  );
  type Page = {
    request: typeof request;
    page: DayPage;
    pages: number;
    revision: string;
    failed: boolean;
  };
  type Work = { controller: AbortController; busy: boolean };
  const [result, setResult] = useState<Page | null>(null);
  const settled = useRef(result);
  settled.current = result;
  const active = useRef<Work | null>(null);
  const [busy, setBusy] = useState<Work | null>(null);
  const read = useCallback(
    (append = false) => {
      const work = active.current;
      if (!work || work.busy || work.controller.signal.aborted) return;
      const before = settled.current?.request === request ? settled.current : null;
      const version = revisionOf(ids);
      const notification = guide.getSnapshot();
      if (append && (!before?.page.cursor || before.revision !== version)) return;
      work.busy = true;
      setBusy(work);
      const wanted = () =>
        guide.getSnapshot() === notification &&
        active.current === work &&
        !work.controller.signal.aborted &&
        valid() &&
        revisionOf(ids) === version;
      const commit = (page: Page) => {
        settled.current = page;
        setResult(page);
      };
      void (async () => {
        try {
          let cursor = append ? (before?.page.cursor ?? undefined) : undefined;
          let programmes = append && before ? [...before.page.programmes] : [];
          let pages = append && before ? before.pages : 0;
          const count = append ? 1 : (before?.pages ?? 1);
          for (let index = 0; index < count; index++) {
            const page = await guide.schedule(request.key, request.day, cursor, {
              signal: work.controller.signal,
            });
            if (!wanted()) return;
            programmes = [...programmes, ...page.programmes];
            pages++;
            cursor = page.cursor ?? undefined;
            if (!cursor) break;
          }
          // An immutable day cannot become empty during a routine read refusal. Keep known rows.
          if (!append && programmes.length === 0 && before?.page.programmes.length) {
            commit({ ...before, failed: true });
          } else
            commit({
              request,
              page: { programmes, cursor: cursor ?? null },
              pages,
              revision: version,
              failed: false,
            });
        } catch {
          if (wanted())
            commit({
              request,
              page: before?.page ?? { programmes: [], cursor: null },
              pages: before?.pages ?? 1,
              revision: before?.revision ?? version,
              failed: true,
            });
        } finally {
          work.busy = false;
          setBusy((current) => (current === work ? null : current));
        }
      })();
    },
    [request, ids, valid],
  );
  useEffect(() => {
    if (!focused) return;
    const work = { controller: new AbortController(), busy: false };
    active.current = work;
    read();
    return () => {
      work.controller.abort();
      if (active.current === work) active.current = null;
    };
  }, [request, snapshot, focused, read]);
  const current = result?.request === request ? result : null;
  const loading = focused && (!current || (busy !== null && active.current === busy));
  const stale = current !== null && current.revision !== revision;
  return {
    page: current?.page,
    failed: current?.failed ?? false,
    loading,
    stale,
    more: () => read(true),
    canLoadMore: focused && !loading && !stale,
    snapshot,
    now,
  };
}

/** Safe, deliberately small status copy. Recovery uses the existing account/settings path. */
export function guideMessage(status: GuideStatus | undefined): string | null {
  if (!status) return null;
  if (status.availability === "available")
    return status.stale || status.error ? "Guide may be out of date" : null;
  if (status.error) return "Guide unavailable";
  if (status.activity === "loading") return "Loading guide…";
  if (status.availability === "none") return "No programme information";
  return null;
}

/** The owner decides now/next; the UI only formats them and clamps an ongoing programme. */
export function programmePresentation(listing: Listing | undefined, at: number) {
  const current = listing?.now;
  const ongoing = current && current.start <= at && current.stop > at ? current : null;
  return {
    line: ongoing ? `${ongoing.title} · ${programmeRange(ongoing)}` : null,
    next:
      listing?.next && listing.next.start > at
        ? `Next ${programmeTime(listing.next.start)} · ${listing.next.title}`
        : null,
    progress: ongoing
      ? Math.max(0, Math.min(1, (at - ongoing.start) / (ongoing.stop - ongoing.start)))
      : null,
  };
}

export function ProgrammeProgress({ value }: { value: number | null }) {
  return value === null ? null : (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Programme progress"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
      style={styles.track}
    >
      <View style={[styles.progress, { width: `${value * 100}%` }]} />
    </View>
  );
}
export function ProgrammeLines({
  listing,
  fallback,
  at,
  textStyle,
}: {
  listing: Listing | undefined;
  fallback: string;
  at: number;
  textStyle?: StyleProp<TextStyle>;
}) {
  const shown = programmePresentation(listing, at);
  return (
    <>
      {shown.line || fallback ? (
        <Text style={[styles.line, textStyle]} numberOfLines={2}>
          {shown.line ?? fallback}
        </Text>
      ) : null}
      {shown.next ? (
        <Text style={[styles.line, textStyle]} numberOfLines={1}>
          {shown.next}
        </Text>
      ) : null}
      <ProgrammeProgress value={shown.progress} />
    </>
  );
}
const styles = StyleSheet.create({
  line: { color: colors.text, fontSize: 13, marginTop: 2 },
  track: { height: 2, backgroundColor: colors.line, marginTop: 5 },
  progress: { height: 2, backgroundColor: colors.text },
});
