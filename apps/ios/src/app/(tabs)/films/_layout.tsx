import { Stack } from "expo-router";
import { tabScreenOptions, useCloseOnLeave } from "../../../header.tsx";

/**
 * Movies: its tabs of shelves and grids, with collections and details pushed over them, and the
 * shared top bar's Downloads and Settings, which close as the viewer leaves the tab while the
 * details under them stay.
 */
export default function FilmsLayout() {
  useCloseOnLeave();
  return (
    <Stack screenOptions={tabScreenOptions("films")}>
      <Stack.Screen name="index" options={{ title: "Movies", headerLargeTitle: true }} />
      <Stack.Screen name="collection/[id]" options={{ title: "" }} />
      <Stack.Screen name="title/[id]" options={{ title: "", headerTransparent: true }} />
      <Stack.Screen name="downloads" options={{ title: "Downloads" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="provider" options={{ title: "" }} />
    </Stack>
  );
}
