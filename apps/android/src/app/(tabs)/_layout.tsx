import { PreviewBack, PreviewFrame } from "../../preview/controls.tsx";
import { lazy, Suspense, useSyncExternalStore } from "react";
import * as Native from "react-native";
import { currentLanguage, onLanguageChange } from "@mrstreamer/core/i18n";

import { Tabs } from "expo-router/js-tabs";
import { useWindowDimensions } from "react-native";
import { DestinationBar } from "../../navigation/destination-bar.tsx";
import { DESTINATIONS, layoutFor, START_DESTINATION } from "../../navigation/destinations.ts";
import { colors } from "../../ui/theme.ts";

// The statistics choice, loaded only on Android: a runtime without `Platform` (the navigation
// tests' React Native) never loads its storage and telemetry.
const Preferences = lazy(() => import("../../settings/consent-prompt.tsx"));

export const unstable_settings = { anchor: START_DESTINATION };

// Home, Live, Movies and Series, each keeping its own stack while another shows. Back at a
// destination's root returns to Live, and at Live's root leaves the app (in preview, returns to
// Connect). While previewing, each destination's scene sits under the Preview mode strip.
export default function DestinationsLayout() {
  useSyncExternalStore(onLanguageChange, currentLanguage);
  const layout = layoutFor(useWindowDimensions().width);

  return (
    <>
      <PreviewBack />
      {"Platform" in Native && Native.Platform.OS === "android" ? (
        <Suspense fallback={null}>
          <Preferences />
        </Suspense>
      ) : null}
      <Tabs
        backBehavior="initialRoute"
        tabBar={(props) => <DestinationBar {...props} layout={layout} />}
        screenLayout={({ children }) => <PreviewFrame>{children}</PreviewFrame>}
        screenOptions={{
          headerShown: false,
          tabBarPosition: layout === "rail" ? "left" : "bottom",
          sceneStyle: { backgroundColor: colors.background },
        }}
      >
        {DESTINATIONS.map(({ route, label }) => (
          <Tabs.Screen key={route} name={route} options={{ title: label }} />
        ))}
      </Tabs>
    </>
  );
}
