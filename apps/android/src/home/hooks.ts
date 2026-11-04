import { useRootNavigationState } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { sources } from "../bootstrap/sources.ts";
import type { ChannelRow } from "../connect/sources.ts";
import { guide } from "../guide/guide.ts";
import { useGuideStart, useListingRevision } from "../guide/hooks.ts";
import { useLibraryModel } from "../library/runtime.ts";
import { lists } from "../live/runtime.ts";
import { useLocale } from "../library/catalogue.ts";
import { useStore } from "../platform/store.ts";
import { homeModel } from "./model.ts";
import { viewing } from "./index.ts";

interface NavigationTree {
  readonly routes: readonly {
    readonly name: string;
    readonly params?: object | undefined;
    readonly state?: NavigationTree | undefined;
  }[];
}

/** Live keeps its country on its index route while another tab is showing. */
function liveCountry(state: NavigationTree | undefined, inLive = false): string | undefined {
  for (const route of state?.routes ?? []) {
    const live = inLive || route.name === "(live)";

    if (
      live &&
      route.params &&
      "country" in route.params &&
      typeof route.params.country === "string"
    )
      return route.params.country;
    const found = liveCountry(route.state, live);

    if (found !== undefined) return found;
  }

  return undefined;
}

/** React screens follow the same pure Home model, including source removal and metadata updates. */
export function useHome(country?: string) {
  const locale = useLocale();
  const navigation = useRootNavigationState();
  const library = useLibraryModel();
  const catalogue = useStore(library.state);
  const state = useStore(viewing.state);
  const accounts = useStore(sources.state);
  const saved = useStore(lists.state);

  const chosenCountry = country ?? liveCountry(navigation);

  const model = useMemo(
    () =>
      homeModel(
        state,
        accounts,
        library,
        saved.lists.find((list) => list.id === "favourites"),
        chosenCountry,
      ),
    [state, accounts, library, catalogue, saved, chosenCountry, locale],
  );

  return model;
}

/** Missing guide facts leave the channel's own name; they never invent a programme or rating. */
export function useOnNow(rows: readonly ChannelRow[]) {
  useGuideStart();
  const revision = useListingRevision();

  // Home's model hands over fresh rows on every render; the channels they name decide the read.
  const names = rows
    .slice(0, 20)
    .map((row) => row.key)
    .join("\n");

  const wanted = useMemo(() => rows.slice(0, 20), [names]);
  const [read, setRead] = useState<Awaited<ReturnType<typeof guide.listings>>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    void guide
      .listings(
        wanted.map((row) => row.key),
        { signal: controller.signal },
      )
      .then((found) => {
        if (!controller.signal.aborted) setRead(found);
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [wanted, revision]);

  return wanted.map((row) => ({ row, programme: read.get(row.key)?.now ?? null }));
}
