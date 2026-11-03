import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { sources } from "../bootstrap/sources.ts";
import { useStore } from "../platform/store.ts";
import { colors } from "../ui/theme.ts";

// The app: Connect until a source is saved, then the destinations (`(tabs)`). Nothing shows until
// the saved sources are read, so a returning viewer never sees Connect flash first.

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
  useEffect(() => void sources.restore(), []);

  if (state.kind === "restoring") return null;
  const signedIn = state.sources.length > 0;

  return (
    <ThemeProvider value={theme}>
      <StatusBar barStyle="light-content" />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      >
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="connect" />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  );
}
