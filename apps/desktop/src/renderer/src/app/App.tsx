import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ConnectScreen } from "../features/connect/ConnectScreen.tsx";
import { HomeScreen } from "../features/home/HomeScreen.tsx";
import { GuidePage } from "../features/live/GuidePage.tsx";
import { SearchPalette } from "../features/search/SearchPalette.tsx";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { TitlesPage } from "../features/titles/TitlesPage.tsx";
import { DetailsView } from "../features/titles/DetailsView.tsx";
import { TitleWatch } from "../features/titles/TitleWatch.tsx";
import { WatchScreen } from "../features/watch/WatchScreen.tsx";
import { appError, describeError } from "../lib/errors.ts";
import { queries, useLastChannel } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";
import { player, usePlayer } from "../player/player.ts";
import { titlePlayer } from "../player/title-player.ts";
import { hasModifier } from "./platform.ts";
import { isLivePage, useUi, type View } from "./ui-store.ts";

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
  return <Shell liveOnly={subscription.data.kind === "m3u"} />;
}

/**
 * The page (Home, Live TV, Movies or Series), with details, Watch and a playing title opening over
 * it. The page stays laid out underneath, so leaving any of them finds it scrolled where it was,
 * and takes no input meanwhile. Search and settings are available everywhere. A subscription with
 * live TV only, a playlist, has no Movies or Series: Home stands in for them.
 */
function Shell({ liveOnly }: { liveOnly: boolean }) {
  const view = useUi((state) => (liveOnly && !isLivePage(state.view) ? "home" : state.view));
  const watching = useUi((state) => state.watching);
  const playingTitle = useUi((state) => state.playingTitle);
  const details = useUi((state) => state.details);
  const settingsOpen = useUi((state) => state.settings !== null);
  const covered = watching || playingTitle;
  // Watch and a playing title play sound, at the viewer's volume; the page underneath goes back to
  // a muted preview. One place decides, so a channel picked over a playing title, which opens Watch
  // before the title has gone, keeps its sound.
  useEffect(() => player.setAudible(covered), [covered]);
  usePreview(covered, view);
  // The login form replaces everything: nothing may keep playing, or holding the connection, behind it.
  useEffect(
    () => () => {
      titlePlayer.close();
      player.suspend();
    },
    [],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!hasModifier(event)) return;
      if (event.key === "k") useUi.setState((state) => ({ searchOpen: !state.searchOpen }));
      else if (event.key === ",") useUi.setState({ settings: "general", searchOpen: false });
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pageActive = !covered && !details;
  return (
    <>
      <div
        className={cn("h-full", covered && "invisible")}
        inert={!pageActive || settingsOpen ? true : undefined}
      >
        {view === "home" ? (
          <HomeScreen active={pageActive} />
        ) : view === "live" ? (
          <GuidePage active={pageActive} />
        ) : (
          // Its own page per kind, so one never shows the other's lists while its own load.
          <TitlesPage
            key={view}
            kind={view === "movies" ? "movie" : "series"}
            active={pageActive}
          />
        )}
      </div>
      {/* Closed under Settings, whose Escape would otherwise reach the sheet's focus first. */}
      {details && !covered && !settingsOpen && (
        <DetailsView key={`${details.kind}:${details.id}`} target={details} />
      )}
      {watching && <WatchScreen />}
      {playingTitle && <TitleWatch />}
      <SearchPalette />
      <SettingsPage />
    </>
  );
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Pages that show the last channel's muted preview. Movies and Series show artwork instead. */
const PREVIEWS: Record<View, boolean> = { home: true, live: true, movies: false, series: false };

/**
 * Keeps the last channel playing, muted, behind Home and the guide. Movies and Series stop it, and
 * coming back starts it again, muted. A minimised or hidden window stops a muted preview too, and
 * showing it again starts the preview again. A preview that failed, as when another device holds
 * the connection, stays failed. Watch and a playing title are left alone.
 */
function usePreview(covered: boolean, view: View): void {
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
  );
  const playing = usePlayer((state) => state.channel);
  const audible = usePlayer((state) => state.audible);
  const failed = usePlayer((state) => state.phase.kind === "failed");
  const last = useLastChannel();
  const channel = playing ?? last;
  // Channels for adults show only in Live TV, while Settings shows them, so none plays behind
  // Home, nor behind the guide once they are turned off.
  const adults = useQuery(queries.preferences()).data?.adultTitles ?? false;
  const previews = PREVIEWS[view] && !(channel?.adult && (view === "home" || !adults));
  useEffect(() => {
    if (covered) return;
    if (!previews) {
      player.setAudible(false);
      if (!failed) player.suspend();
      return;
    }
    if (!visible) {
      if (!audible && !failed) player.suspend();
    } else if (channel) player.preview(channel);
  }, [covered, previews, visible, audible, failed, channel]);
}
