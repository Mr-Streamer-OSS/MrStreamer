import { useSyncExternalStore } from "react";
import { store } from "../platform/store.ts";
import { currentLanguage } from "@mrstreamer/core/i18n";
import { sources } from "../bootstrap/sources.ts";
import { libraryModel, type MetadataPort } from "./model.ts";

const revision = store(0);

let metadata: MetadataPort | undefined;
let model: ReturnType<typeof libraryModel> | undefined;
let stop: (() => void) | undefined;

/** Settings owns consent/key changes. Replacing the port also replaces all in-memory metadata. */
export function setLibraryMetadata(port: MetadataPort | undefined) {
  metadata = port;
  model = undefined;
  stop?.();
  stop = undefined;
  revision.set((n) => n + 1);
}

/** Starts on first library screen; source replacement/removal immediately rebuilds its lists. */
export function library() {
  if (model) return model;

  const made = libraryModel({
    language: () => currentLanguage().locale.split("-")[0]!,
    metadata,
    sources: () => {
      const state = sources.state.get();

      return state.kind !== "ready"
        ? []
        : state.sources.flatMap((source) => {
            const reader = sources.onDemand(source.id);

            return reader
              ? [
                  {
                    id: source.id,
                    label: source.label,
                    catalogue: () => reader.onDemandCatalogue(),
                    details: (kind: "movie" | "series", id: string) =>
                      kind === "movie" ? reader.movieDetails(id) : reader.seriesDetails(id),
                  },
                ]
              : [];
          });
    },
  });

  model = made;
  stop = sources.state.subscribe(() => {
    void made.refresh();
  });
  void made.refresh();

  return made;
}

/** Rebind mounted screens after Settings changes metadata access. */
export function useLibraryModel(injected?: ReturnType<typeof libraryModel>) {
  useSyncExternalStore(revision.subscribe, revision.get);

  return injected ?? library();
}
