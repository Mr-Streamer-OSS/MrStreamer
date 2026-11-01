import { Stack } from "expo-router";
import { useTabScreenOptions } from "../../../header.tsx";
import { t as live } from "../../../i18n/live.ts";
import { t } from "../../../i18n/navigation.ts";
import { t as page } from "../../../i18n/pages.ts";

/**
 * Live: its tabs of shelves, tiles and the channel list, with a category's channels, every
 * favourite, one of the viewer's lists and Find countries or categories pushed over them, and the shared top bar's Downloads
 * and Settings, which close as the viewer leaves the tab.
 */
export default function LiveLayout() {
  return (
    <Stack screenOptions={useTabScreenOptions("live")}>
      <Stack.Screen name="index" options={{ title: t("Live"), headerLargeTitle: true }} />
      <Stack.Screen name="category" options={{ title: "" }} />
      <Stack.Screen name="favourites" options={{ title: live("Favourites") }} />
      <Stack.Screen name="list" options={{ title: "" }} />
      <Stack.Screen name="discover" options={{ title: "" }} />
      <Stack.Screen name="schedule" options={{ title: live("Schedule") }} />
      <Stack.Screen name="programme" options={{ title: live("Programme") }} />
      <Stack.Screen name="downloads" options={{ title: t("Downloads") }} />
      <Stack.Screen name="settings" options={{ title: t("Settings") }} />
      <Stack.Screen name="provider" options={{ title: "" }} />
      <Stack.Screen name="licences" options={{ title: page("Licences") }} />
      <Stack.Screen name="licence" options={{ title: "" }} />
      <Stack.Screen name="guides" options={{ title: page("Guides") }} />
      <Stack.Screen name="guide-map" options={{ title: page("Map channels") }} />
    </Stack>
  );
}
