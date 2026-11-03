import type { TitleVersion } from "@mrstreamer/contracts/ondemand";
import { store } from "../platform/store.ts";

/** Provider ids stay opaque. A series action always names an episode as well as its version. */
export type MediaIdentity = {
  readonly sourceId: string;
  readonly titleKey: string;
  readonly titleId: string;
  readonly version: TitleVersion;
} & ({ readonly kind: "movie" } | { readonly kind: "episode"; readonly episodeId: string });

export interface PlayIntent {
  readonly action: "play";
  readonly media: MediaIdentity;
}

export interface DownloadIntent {
  readonly action: "download";
  readonly media: MediaIdentity;
}

export interface IntentHandlers {
  readonly play?: (intent: PlayIntent) => void;
  readonly download?: (intent: DownloadIntent) => void;
}

/** Later feature owners register here. Unregistering an older owner cannot remove its successor. */
export function intentRegistry() {
  const state = store<IntentHandlers>({});

  return {
    state,
    register(handlers: IntentHandlers) {
      state.set((current) => ({ ...current, ...handlers }));

      return () => {
        const next = { ...state.get() };

        for (const action of ["play", "download"] as const) {
          if (handlers[action] && next[action] === handlers[action]) delete next[action];
        }

        state.set(next);
      };
    },
  };
}

export const libraryIntents = intentRegistry();
