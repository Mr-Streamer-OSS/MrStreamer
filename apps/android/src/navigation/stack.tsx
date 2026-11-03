import { Stack } from "expo-router";
import { colors } from "../ui/theme.ts";

/**
 * Each destination's root is under whatever opens on its stack, a link straight to
 * `/movies/settings` included, so Back from it reaches the root.
 */
export const unstable_settings = { anchor: "index" };

/**
 * Each destination's own stack: its root, then what is pushed over it. Search, Downloads and
 * Settings are on it at most once: opening one already there moves it to the top rather than
 * adding another (the rail offers them over each other).
 */
export function DestinationStack() {
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    >
      <Stack.Screen name="search" dangerouslySingular />
      <Stack.Screen name="downloads" dangerouslySingular />
      <Stack.Screen name="settings" dangerouslySingular />
    </Stack>
  );
}
