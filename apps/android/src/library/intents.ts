import type { TitleVersion } from "@mrstreamer/contracts/ondemand";
import type { PlayIntent } from "../player/intent.ts";
import { store } from "../platform/store.ts";

/** Provider ids stay opaque. A series action always names an episode as well as its version. */
export type MediaIdentity = {
  readonly sourceId: string;
  readonly titleKey: string;
  readonly titleId: string;
  readonly version: TitleVersion;
} & ({ readonly kind: "movie" } | { readonly kind: "episode"; readonly episodeId: string });

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

/** Downloads owns the words and actions; Library only renders this optional presentation. */
export interface DownloadPresentation {
  readonly text: string;
  readonly label: string;
  readonly icon: "done" | "stop" | "empty" | "retry";
  readonly progress: number;
  readonly activate: () => void;
}

export interface DownloadPresentationAdapter {
  readonly read: (media: MediaIdentity) => DownloadPresentation | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  /** A change token for useSyncExternalStore: equal strings mean nothing to redraw. */
  readonly snapshot: () => string;
}

export function downloadPresentationRegistry() {
  const state = store<DownloadPresentationAdapter | undefined>(undefined);

  return {
    state,
    register(adapter: DownloadPresentationAdapter) {
      state.set(adapter);

      return () => {
        if (state.get() === adapter) state.set(undefined);
      };
    },
  };
}

export const libraryDownloads = downloadPresentationRegistry();
