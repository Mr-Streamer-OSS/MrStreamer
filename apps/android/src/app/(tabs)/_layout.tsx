import { Tabs } from "expo-router/js-tabs";
import { useWindowDimensions } from "react-native";
import { DestinationBar } from "../../navigation/destination-bar.tsx";
import { DESTINATIONS, layoutFor, START_DESTINATION } from "../../navigation/destinations.ts";
import { colors } from "../../ui/theme.ts";

export const unstable_settings = { anchor: START_DESTINATION };

// Home, Live, Movies and Series, each keeping its own stack while another shows. Back at a
// destination's root returns to Live, and at Live's root leaves the app.
export default function DestinationsLayout() {
  const layout = layoutFor(useWindowDimensions().width);

  return (
    <Tabs
      backBehavior="initialRoute"
      tabBar={(props) => <DestinationBar {...props} layout={layout} />}
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
  );
}
