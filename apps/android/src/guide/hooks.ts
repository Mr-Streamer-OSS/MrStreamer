import type { Programme } from "@mrstreamer/contracts/guide";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { sources } from "../bootstrap/sources.ts";
import { useStore } from "../platform/store.ts";
import { guide, type Day, type ScheduleItem } from "./guide.ts";
import { guides } from "./guide-sources.ts";
import type { MapInput } from "./present.ts";
import { startGuide } from "./runtime.ts";

// How the guide screens read the guide service: they start it, follow its listing revision and
// withdrawals, and keep what they showed while a read again is under way or fails.

/** Starts the guide's runtime once, from whichever guide screen opens first. */
export function useGuideStart() {
  useEffect(() => {
    void startGuide().catch(() => {
      // Statuses stay unknown, which the screens show as loading; the next launch tries again.
    });
  }, []);
}

/** Changes as guide contents, catalogues or mappings change what a read answers. */
export const useListingRevision = () =>
  useSyncExternalStore(guide.listingRevision.subscribe, guide.listingRevision.get);

/** What Map channels and a channel's mapping read, rendering again as any of it changes. */
export function useMapInput(): MapInput {
  const revision = useListingRevision();
  const state = useStore(sources.state);
  const mappings = guides.useMappings();

  return useMemo(() => {
    const ready = state.kind === "ready" ? state.sources : [];

    // Read again as `revision` says a catalogue was read or forgotten.
    return {
      channels: guide.channels(),
      mappings,
      providers: new Map(ready.map((source) => [source.id, source.label])),
      categories: new Map(
        ready.flatMap((source) =>
          source.channels.kind === "ready"
            ? source.channels.rows.map((row) => [row.key, row.category] as const)
            : [],
        ),
      ),
    };
  }, [revision, state, mappings]);
}

interface Read {
  /** The channel and day read. */
  readonly id: string;
  readonly programmes: readonly ScheduleItem[];
  readonly cursor: string | null;
  /** Pages shown, so a read again after a change reads as many. */
  readonly pages: number;
  readonly failed: boolean;
}

/**
 * Channel `key`'s programmes on `day`, a page at a time with `more`. Each change to the guide
 * reads the pages shown again; a read that fails, or comes back empty for a day that had rows,
 * keeps the rows shown and says so with `failed`.
 */
export function useSchedule(key: string, day: Day) {
  const revision = useListingRevision();

  const withdrawn = useSyncExternalStore(guide.withdrawals.subscribe, () =>
    guide.withdrawn(key, day.from),
  );

  const id = `${key} ${day.from}`;
  const [read, setRead] = useState<Read | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef(read);
  shown.current = read;
  const work = useRef<AbortController | null>(null);

  const load = useCallback(
    async (more: boolean) => {
      const before = shown.current?.id === id ? shown.current : null;

      if (more && !before?.cursor) return;
      work.current?.abort();
      const controller = new AbortController();
      work.current = controller;
      setBusy(true);

      try {
        let cursor = more ? (before?.cursor ?? undefined) : undefined;
        const programmes = more && before ? [...before.programmes] : [];
        let pages = more && before ? before.pages : 0;
        const count = more ? 1 : (before?.pages ?? 1);

        for (let index = 0; index < count; index++) {
          const page = await guide.schedule(key, { from: day.from, until: day.until }, cursor, {
            signal: controller.signal,
          });

          if (controller.signal.aborted) return;
          programmes.push(...page.programmes);
          pages++;
          cursor = page.cursor ?? undefined;

          if (!cursor) break;
        }

        // A day's programmes don't vanish: an empty answer where rows showed is a refused read.
        if (!more && programmes.length === 0 && before?.programmes.length)
          setRead({ ...before, failed: true });
        else setRead({ id, programmes, cursor: cursor ?? null, pages, failed: false });
      } catch {
        if (!controller.signal.aborted)
          setRead({
            id,
            programmes: before?.programmes ?? [],
            cursor: before?.cursor ?? null,
            pages: before?.pages ?? 1,
            failed: true,
          });
      } finally {
        if (work.current === controller) {
          work.current = null;
          setBusy(false);
        }
      }
    },
    [key, day.from, day.until, id],
  );

  useEffect(() => {
    void load(false);

    return () => work.current?.abort();
  }, [load, revision, withdrawn]);
  const current = read?.id === id ? read : null;

  return {
    programmes: current?.programmes ?? [],
    more: current?.cursor ? () => void load(true) : null,
    /** Nothing read yet for this channel and day. */
    loading: current === null,
    busy,
    failed: current?.failed ?? false,
  };
}

/**
 * The programme channel `key` has at `start`, by its `detail` token while the token stands, else
 * by its identity. `value` stays while it is read again; null once no guide has it.
 */
export function useProgramme(key: string, start: number, detail?: string) {
  const revision = useListingRevision();
  const id = `${key} ${start} ${detail ?? ""}`;
  const [read, setRead] = useState<{ id: string; value: Programme | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      const byToken = detail ? await guide.programme(detail, { signal }) : null;
      const value = byToken ?? (await guide.programmeAt(key, start, { signal })) ?? null;

      if (!signal.aborted) setRead({ id, value });
    })().catch(() => {
      if (!signal.aborted) setRead((before) => (before?.id === id ? before : { id, value: null }));
    });

    return () => controller.abort();
  }, [id, key, start, detail, revision]);
  const current = read?.id === id ? read : null;

  return { pending: current === null, value: current?.value ?? null };
}
