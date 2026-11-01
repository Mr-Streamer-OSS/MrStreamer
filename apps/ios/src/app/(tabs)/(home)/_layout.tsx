import { Stack } from "expo-router";
import { useTabScreenOptions } from "../../../header.tsx";
import { t } from "../../../i18n/live.ts";
import { t as nav } from "../../../i18n/navigation.ts";
import { t as page } from "../../../i18n/pages.ts";

/**
 * Home, with the shared top bar (`header.tsx`): Downloads and Settings open on its stack, and
 * Settings' provider form and Licences above Settings. Those close as the viewer leaves for
 * another tab. Settings' Guides and Map channels go on the same stack. The Watchlist and
 * Favourites are Home's own, and stay, as Movies' and Series' details do.
 */
export default function HomeLayout() {
  return (
    <Stack screenOptions={useTabScreenOptions("(home)")}>
      <Stack.Screen name="index" options={{ title: "", headerTransparent: true }} />
      <Stack.Screen name="watchlist" options={{ title: page("Watchlist") }} />
      <Stack.Screen name="favourites" options={{ title: t("Favourites") }} />
      <Stack.Screen name="schedule" options={{ title: t("Schedule") }} />
      <Stack.Screen name="programme" options={{ title: t("Programme") }} />
      <Stack.Screen name="downloads" options={{ title: nav("Downloads") }} />
      <Stack.Screen name="settings" options={{ title: nav("Settings") }} />
      <Stack.Screen name="provider" options={{ title: "" }} />
      <Stack.Screen name="licences" options={{ title: page("Licences") }} />
      <Stack.Screen name="licence" options={{ title: "" }} />
      <Stack.Screen name="guides" options={{ title: page("Guides") }} />
      <Stack.Screen name="guide-map" options={{ title: page("Map channels") }} />
    </Stack>
  );
}
