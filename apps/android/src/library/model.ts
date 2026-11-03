import type { Title, TitleKind, TitleDetails } from "@mrstreamer/contracts/ondemand";
import type { OnDemandCatalogue, ProviderDetails } from "@mrstreamer/core/provider";
import { indexCatalogue, kindOf, searchPage } from "@mrstreamer/core/ondemand/catalogue";
import {
  collections,
  collectionRows,
  type ServiceTitles,
} from "@mrstreamer/core/ondemand/collections";
import { movieDetails, seriesDetails } from "@mrstreamer/core/ondemand/details";
import type { TitleAbout, TitleMetadata } from "@mrstreamer/core/metadata/tmdb";
import type { metadataStore } from "@mrstreamer/core/metadata/store";
import { TMDB_EXPIRE_MS } from "@mrstreamer/core/metadata/policy";
import { store } from "../platform/store.ts";

export interface LibrarySource {
  readonly id: string;
  readonly label: string;
  catalogue(): Promise<OnDemandCatalogue>;
  details(kind: TitleKind, id: string): Promise<ProviderDetails>;
}

/** Settings supplies this only with consent and access. No port means no network and no retry. */
export interface MetadataPort {
  readonly facts?: Pick<ReturnType<typeof metadataStore>, "get" | "name" | "services">;
  about(kind: TitleKind, id: string, language: string): Promise<TitleAbout | null>;
}

export interface ListState {
  readonly loading: boolean;
  readonly failures: readonly string[];
  readonly revision: number;
}

export interface DetailState {
  readonly value: TitleDetails | null;
  readonly providerFailed: boolean;
  readonly metadataFailed: boolean;
}

export function libraryModel(options: {
  sources(): readonly LibrarySource[];
  language(): string;
  metadata?: MetadataPort | undefined;
  now?: () => number;
}) {
  const state = store<ListState>({ loading: true, failures: [], revision: 0 });
  const kept = new Map<string, OnDemandCatalogue>();
  const abouts = new Map<string, { at: number; value: TitleAbout | null }>();
  const provided = new Map<string, ProviderDetails>();
  const detailReads = new Map<string, number>();
  const now = options.now ?? Date.now;
  let generation = 0;

  let indexed: ReturnType<typeof indexCatalogue> | undefined;
  let indexedLists: readonly { subscriptionId: string; catalogue: OnDemandCatalogue }[] = [];

  function catalogue() {
    const language = options.language();

    const lists = options.sources().flatMap((s) => {
      const catalogue = kept.get(s.id);

      return catalogue ? [{ subscriptionId: s.id, catalogue }] : [];
    });

    if (
      !indexed ||
      indexed.language !== language ||
      lists.length !== indexedLists.length ||
      lists.some(
        (s, i) =>
          s.subscriptionId !== indexedLists[i]?.subscriptionId ||
          s.catalogue !== indexedLists[i]?.catalogue,
      )
    ) {
      indexed = indexCatalogue(lists, language);
      indexedLists = lists;
    }

    return indexed;
  }

  function made(kind: TitleKind) {
    const language = options.language();
    const facts = options.metadata?.facts;
    const tmdbKind = kind === "movie" ? "movie" : "tv";

    return collections({
      kind,
      titles: kindOf(catalogue(), kind).titles,
      language,
      metadata: (id): TitleMetadata | null => facts?.get(tmdbKind, id) ?? null,
      names: (id) => facts?.name(tmdbKind, id, language) ?? null,
      services: facts?.services(tmdbKind) ?? ([] satisfies readonly ServiceTitles[]),
      now: now(),
    });
  }

  return {
    state,
    made,
    async refresh() {
      const run = ++generation;
      state.set((s) => ({ ...s, loading: true }));
      const active = options.sources();

      for (const id of kept.keys()) if (!active.some((s) => s.id === id)) kept.delete(id);

      const results = await Promise.all(
        active.map(async (source) => {
          try {
            const result = await source.catalogue();

            if (run === generation && options.sources().some((s) => s.id === source.id))
              kept.set(source.id, result);

            return null;
          } catch {
            return source.label;
          }
        }),
      );

      if (run === generation)
        state.set((s) => ({
          loading: false,
          failures: results.filter((s): s is string => s !== null),
          revision: s.revision + 1,
        }));
    },
    /** The browse tabs that have titles, in their order. */
    tabs(kind: TitleKind) {
      const c = made(kind);

      return (
        [
          ["for-you", collectionRows(c, "for-you", null).length > 0],
          ["new", collectionRows(c, "new", null).length > 0],
          ["genres", c.genres().length > 0],
          ["services", c.services().length > 0],
          ["4k", c.size("4k") > 0],
          ["all", c.size("all") > 0],
        ] as const
      ).flatMap(([tab, shown]) => (shown ? [tab] : []));
    },
    title(kind: TitleKind, key: string) {
      return kindOf(catalogue(), kind).titles.find((t) => t.key === key);
    },
    search(kind: TitleKind, query: string, pages = 1) {
      return searchPage(catalogue(), kind, query, undefined, Math.max(1, pages) * 20);
    },
    async details(title: Title): Promise<DetailState> {
      const language = options.language();
      const key = `${title.kind}:${title.subscriptionId}:${title.id}`;
      const read = (detailReads.get(key) ?? 0) + 1;
      detailReads.set(key, read);
      let providerFailed = false;

      try {
        const source = options.sources().find((s) => s.id === title.subscriptionId);

        if (!source) throw new Error("Source removed");
        const value = await source.details(title.kind, title.id);

        if (
          detailReads.get(key) !== read ||
          !options.sources().some((s) => s.id === title.subscriptionId)
        )
          throw new Error("Source changed");
        provided.set(key, value);
      } catch {
        providerFailed = true;
      }

      const aboutKey = `${language}:${title.kind}:${title.tmdbId}`;
      let metadataFailed = false;

      if (options.metadata && title.tmdbId) {
        try {
          const value = await options.metadata.about(title.kind, title.tmdbId, language);

          if (detailReads.get(key) === read) abouts.set(aboutKey, { at: now(), value });
        } catch {
          metadataFailed = true;
        }
      }

      const saved = abouts.get(aboutKey);
      const about = saved && now() - saved.at < TMDB_EXPIRE_MS ? saved.value : null;
      const details = provided.get(key);

      return {
        value: !details
          ? null
          : title.kind === "movie"
            ? movieDetails(title, details, about)
            : seriesDetails(title, details, about, language),
        providerFailed,
        metadataFailed,
      };
    },
  };
}

export type LibraryModel = ReturnType<typeof libraryModel>;
