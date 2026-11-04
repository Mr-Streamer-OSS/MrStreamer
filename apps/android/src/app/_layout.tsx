import { startReminders } from "../reminders/runtime.ts";
import { useReminderRouting } from "../reminders/routing.ts";
import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
import { StatusBar } from "react-native";
import { sources } from "../bootstrap/sources.ts";
import { startDownloads } from "../downloads/runtime.ts";
import { player } from "../player/instance.ts";
import { MiniPlayer } from "../player/mini-player.tsx";
import { useStore } from "../platform/store.ts";
import { colors } from "../ui/theme.ts";

// The app: Connect until a source is saved, then the destinations (`(tabs)`). Nothing shows until
// the saved sources are read, so a returning viewer never sees Connect flash first. Watch opens
// over the destinations and hands notification links for files to OfflinePlay. Offline stays
// available without a provider; a local copy also keeps its mini player while Connect is showing.

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.background,
    text: colors.text,
    primary: colors.text,
  },
};

export default function RootLayout() {
  const state = useStore(sources.state);
  useReminderRouting(state.kind === "ready" && state.sources.length > 0);
  useEffect(() => startReminders(), []);

  const localFile = useSyncExternalStore(player.state.subscribe, () => {
    const state = player.state.get();

    return state.kind === "playing" && state.intent.kind === "file";
  });

  useEffect(() => {
    let stop: (() => void) | undefined;

    try {
      stop = startDownloads();
    } catch {
      // A native Downloads startup failure must not prevent saved sources from restoring.
    }

    void sources.restore();

    return stop;
  }, []);

  if (state.kind === "restoring") return null;
  const signedIn = state.sources.length > 0;

  return (
    <ThemeProvider value={theme}>
      <StatusBar barStyle="light-content" />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      >
        <Stack.Screen name="offline" />
        <Stack.Protected guard={signedIn} redirectTo="/connect">
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        <Stack.Protected guard={signedIn || localFile} redirectTo="/connect">
          <Stack.Screen name="watch" options={{ animation: "fade" }} />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn} redirectTo="/">
          <Stack.Screen name="connect" />
        </Stack.Protected>
      </Stack>
      {signedIn || localFile ? <MiniPlayer /> : null}
    </ThemeProvider>
  );
}
