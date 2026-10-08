// The view holds opaque results only. Main owns service addresses, secrets and exact-file validity.
import { createStore, useStore } from "zustand";
import type {
  OnlineSubtitleResult,
  OnlineSubtitleSearch,
  SubtitleQuota,
} from "@mrstreamer/contracts/online-subtitles";
import { call } from "../lib/ipc.ts";
import { titlePlayer } from "./title-player.ts";

interface SearchState {
  readonly sessionId: string | null;
  readonly results: readonly OnlineSubtitleResult[];
  readonly failures: OnlineSubtitleSearch["failures"];
  readonly selected: string | null;
  readonly quota: SubtitleQuota | null;
  readonly pending: "search" | "download" | null;
  readonly searched: boolean;
  readonly error: string | null;
}
const empty = {
  sessionId: null,
  results: [],
  failures: [],
  selected: null,
  quota: null,
  pending: null,
  searched: false,
  error: null,
} satisfies SearchState;
const store = createStore<SearchState>(() => empty);
let request = 0;
export function useOnlineSubtitles<T>(select: (state: SearchState) => T): T {
  return useStore(store, select);
}
export const onlineSubtitles = {
  bind(sessionId: string | null): void {
    const previous = store.getState().sessionId;
    if (previous === sessionId) return;
    request++;
    if (previous) void call("subtitles.cancel", { sessionId: previous }).catch(() => {});
    store.setState({ ...empty, sessionId });
  },
  cancelPending(): void {
    const { sessionId, pending } = store.getState();
    if (!sessionId || !pending) return;
    request++;
    void call("subtitles.cancel", { sessionId }).catch(() => {});
    store.setState({ ...empty, sessionId });
  },
  async search(languages?: readonly string[]): Promise<void> {
    const { sessionId } = store.getState();
    if (!sessionId) return;
    const mine = ++request;
    store.setState({
      pending: "search",
      results: [],
      failures: [],
      selected: null,
      error: null,
      searched: false,
    });
    try {
      const answer = await call("subtitles.search", {
        sessionId,
        ...(languages ? { languages: [...languages] } : {}),
      });
      if (mine !== request || store.getState().sessionId !== sessionId) return;
      store.setState({ ...answer, pending: null, searched: true });
    } catch {
      if (mine === request)
        store.setState({
          pending: null,
          searched: true,
          error: "Search could not finish. Check the services in Settings and try again.",
        });
    }
  },
  async choose(resultId: string): Promise<void> {
    const { sessionId } = store.getState();
    if (!sessionId) return;
    const mine = ++request;
    store.setState({ pending: "download", error: null });
    try {
      await titlePlayer.downloadedEditsSaved();
      if (mine !== request || store.getState().sessionId !== sessionId) return;
      const answer = await call("subtitles.choose", { sessionId, resultId });
      if (mine !== request || !titlePlayer.acceptDownloaded(sessionId, answer.saved)) return;
      store.setState({ selected: resultId, quota: answer.quota, pending: null });
    } catch {
      if (mine === request)
        store.setState({
          pending: null,
          error:
            "This subtitle could not be downloaded. Choose another or check the service in Settings.",
        });
    }
  },
  tryNext(): void {
    const { results, selected, pending } = store.getState();
    if (!results.length || pending) return;
    const next = results[(results.findIndex((each) => each.id === selected) + 1) % results.length];
    if (next) void onlineSubtitles.choose(next.id);
  },
};
