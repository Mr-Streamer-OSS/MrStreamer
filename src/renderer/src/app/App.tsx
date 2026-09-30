import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ConnectScreen } from "../features/connect/ConnectScreen.tsx";
import { HomeScreen } from "../features/home/HomeScreen.tsx";
import { GuidePage } from "../features/live/GuidePage.tsx";
import { SearchPalette } from "../features/search/SearchPalette.tsx";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { UpdateDialogs } from "../features/updates/UpdateDialogs.tsx";
import { WatchScreen } from "../features/watch/WatchScreen.tsx";
import { appError, describeError } from "../lib/errors.ts";
import { queries, useLastChannel } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";
import { player, usePlayer } from "../player/player.ts";
import { hasModifier } from "./platform.ts";
import { useUi } from "./ui-store.ts";

export function App() {
  const subscription = useQuery(queries.subscription());
  const preferences = useQuery(queries.preferences());
  const editingLogin = useUi((state) => state.editingLogin);

  // Restore volume and the last category once, before anything plays.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!preferences.data || hydrated.current) return;
    hydrated.current = true;
    player.hydrate(preferences.data);
    const { lastCategoryId } = preferences.data;
    useUi.setState({
      list: lastCategoryId ? { kind: "category", id: lastCategoryId } : { kind: "all" },
    });
  }, [preferences.data]);

  if (subscription.isPending || preferences.isPending) return null;
  if (subscription.isError) {
    return (
      <p className="p-10 text-sm text-destructive">{describeError(appError(subscription.error))}</p>
    );
  }
  if (!subscription.data || subscription.data.needsPassword || editingLogin) {
    return <ConnectScreen existing={subscription.data} />;
  }
  return <Shell />;
}

/**
 * Home or the Live TV guide, with Watch opening over them. The page stays laid out underneath, so
 * leaving Watch finds it scrolled where it was. Search and settings are available everywhere.
 */
function Shell() {
  const view = useUi((state) => state.view);
  const watching = useUi((state) => state.watching);
  usePreview(watching);
  // The login form replaces everything: nothing may keep playing, or holding the connection, behind it.
  useEffect(() => () => player.suspend(), []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!hasModifier(event)) return;
      if (event.key === "k") useUi.setState((state) => ({ searchOpen: !state.searchOpen }));
      else if (event.key === ",") useUi.setState({ settings: "subscription", searchOpen: false });
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className={cn("h-full", watching && "invisible")}>
        {view === "home" ? <HomeScreen active={!watching} /> : <GuidePage active={!watching} />}
      </div>
      {watching && <WatchScreen />}
      <SearchPalette />
      <SettingsPage />
      <UpdateDialogs />
    </>
  );
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Keeps the last channel playing, muted, behind the pages. A minimised or hidden window stops a
 * muted preview, and showing it again starts the preview again. A preview that failed, as when
 * another device holds the connection, stays failed. Watch is left alone.
 */
function usePreview(watching: boolean): void {
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
  );
  const playing = usePlayer((state) => state.channel);
  const audible = usePlayer((state) => state.audible);
  const failed = usePlayer((state) => state.phase.kind === "failed");
  const last = useLastChannel();
  const channel = playing ?? last;
  useEffect(() => {
    if (watching) return;
    if (!visible) {
      if (!audible && !failed) player.suspend();
    } else if (channel) player.preview(channel);
  }, [watching, visible, audible, failed, channel]);
}
