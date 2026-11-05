import { t } from "./copy.ts";
import { collections } from "@mrstreamer/core/ondemand/collections";
import { libraryModel, type LibraryModel } from "../library/model.ts";
import { details, titles } from "./catalogue.ts";

/** Screen read model only: no Provider, source, reader, URL or metadata port. */
export const exampleLibrary: LibraryModel = {
  ...libraryModel({ sources: () => [], language: () => "en" }),
  made: (kind) =>
    collections({
      kind,
      titles: titles.filter((t) => t.kind === kind),
      language: "en",
      metadata: () => null,
      names: () => null,
      services: [],
      now: Date.now(),
    }),
  tabs: () => ["all"],
  title: (kind, key) => titles.find((t) => t.kind === kind && t.key === key),
  search: (kind, query) => {
    const found = titles.filter(
      (t) => t.kind === kind && t.title.toLowerCase().includes(query.toLowerCase()),
    );

    return { titles: found, total: found.length };
  },
  details: async (title) => ({
    value: details(title),
    containers: new Map([
      [title.id, "example"],
      ...[1, 2].flatMap((s) => [1, 2].map((e) => [`episode-${s}-${e}`, "example"] as const)),
    ]),
    providerFailed: false,
    metadataFailed: false,
  }),
  sourceLabel: () => t("Example"),
};

exampleLibrary.state.set({ loading: false, failures: [], needsLogin: [], revision: 0 });
