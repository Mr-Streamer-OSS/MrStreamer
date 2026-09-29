import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ConnectScreen } from "../features/connect/ConnectScreen.tsx";
import { HomeScreen } from "../features/home/HomeScreen.tsx";
import { LiveScreen } from "../features/live/LiveScreen.tsx";
import { SearchPalette } from "../features/search/SearchPalette.tsx";
import { SettingsSheet } from "../features/settings/SettingsSheet.tsx";
import { UpdateDialogs } from "../features/updates/UpdateDialogs.tsx";
import { appError, describeError } from "../lib/errors.ts";
import { queries } from "../lib/queries.ts";
import { player } from "../player/player.ts";
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
    useUi.setState({ categoryId: preferences.data.lastCategoryId });
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

/** Home or Live TV, with search and settings available from both. */
function Shell() {
  const view = useUi((state) => state.view);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!hasModifier(event)) return;
      if (event.key === "k") useUi.setState((state) => ({ searchOpen: !state.searchOpen }));
      else if (event.key === ",") useUi.setState({ settingsOpen: true, searchOpen: false });
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {view === "home" ? <HomeScreen /> : <LiveScreen />}
      <SearchPalette />
      <SettingsSheet />
      <UpdateDialogs />
    </>
  );
}
