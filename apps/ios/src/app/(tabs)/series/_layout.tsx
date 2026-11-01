import { Stack } from "expo-router";
import { useTabScreenOptions } from "../../../header.tsx";
import { t } from "../../../i18n/navigation.ts";
import { t as page } from "../../../i18n/pages.ts";

/**
 * Series: its tabs of shelves and grids, with collections and details pushed over them, and the
 * shared top bar's Downloads and Settings, which close as the viewer leaves the tab while the
 * details under them stay.
 */
export default function SeriesLayout() {
  return (
    <Stack screenOptions={useTabScreenOptions("series")}>
      <Stack.Screen name="index" options={{ title: t("Series"), headerLargeTitle: true }} />
      <Stack.Screen name="collection/[id]" options={{ title: "" }} />
      <Stack.Screen name="title/[id]" options={{ title: "", headerTransparent: true }} />
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
