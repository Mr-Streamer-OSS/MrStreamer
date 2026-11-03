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
            if (source.kind === "m3u") return [];
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
              : [
                  {
                    id: source.id,
                    label: source.label,
                    needsLogin: true,
                    catalogue: async () => {
                      throw new Error("Login unavailable");
                    },
                    details: async () => {
                      throw new Error("Login unavailable");
                    },
                  },
                ];
          });
    },
  });

  model = made;

  const identities = () => {
    const state = sources.state.get();

    return new Map(
      state.kind === "ready"
        ? state.sources
            .filter((s) => s.kind === "xtream")
            .map((s) => [s.id, sources.onDemand(s.id)] as const)
        : [],
    );
  };

  let previous = identities();
  stop = sources.state.subscribe(() => {
    const next = identities();

    if (
      next.size === previous.size &&
      [...next].every(([id, reader]) => previous.has(id) && previous.get(id) === reader)
    )
      return;
    previous = next;
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
