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
  readonly snapshot: () => unknown;
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

/**
 * A line Details docks above the navigation bar: a kept episode mark with Undo, or a refused one
 * with Try again. Details dismisses it when it closes.
 */
export interface ViewingNotice {
  readonly message: string;
  readonly failed: boolean;
  readonly action: string;
  run(): void;
  dismiss(): void;
}

/** Viewing owns persistence and failure presentation; Library exposes current title/episode facts. */
export interface ViewingPresentationAdapter {
  subscribe(listener: () => void): () => void;
  snapshot(): unknown;
  watchlist(title: import("@mrstreamer/contracts/ondemand").Title): {
    label: string;
    activate(): void;
    available?: boolean;
  };
  /** An episode's mark, hidden while its saved state is unavailable. */
  episode(
    title: import("@mrstreamer/contracts/ondemand").Title,
    episode: import("@mrstreamer/contracts/ondemand").Episode,
  ): { label: string; activate(): void; detail?: string; available?: boolean };
  notice(): ViewingNotice | null;
  play(media: MediaIdentity, episode?: { season: number; number: number }): void;
}

export const libraryViewing = (() => {
  const state = store<ViewingPresentationAdapter | undefined>(undefined);

  return {
    state,
    register(adapter: ViewingPresentationAdapter) {
      state.set(adapter);

      return () => {
        if (state.get() === adapter) state.set(undefined);
      };
    },
  };
})();
