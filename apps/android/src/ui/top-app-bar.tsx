import { router } from "expo-router";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NavigationLayout } from "../navigation/destinations.ts";
import { useOpenShared } from "../navigation/open.ts";
import { IconButton } from "./icon-button.tsx";
import { colors } from "./theme.ts";

/**
 * A screen's top app bar. A destination's root shows its title, with Search, Downloads and
 * Settings on phones (the rail carries them from 600dp); a pushed screen shows Back before its
 * title instead.
 */
export function TopAppBar({
  title,
  layout,
  pushed,
}: {
  title: string;
  layout: NavigationLayout;
  pushed: boolean;
}) {
  const insets = useSafeAreaInsets();
  const open = useOpenShared();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: 64,
        paddingTop: insets.top,
        paddingLeft: insets.left + (pushed ? 4 : 16),
        paddingRight: insets.right + 4,
        backgroundColor: colors.background,
      }}
    >
      {pushed ? <IconButton icon="arrow-back" label="Back" onPress={() => router.back()} /> : null}
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={{
          flex: 1,
          paddingLeft: pushed ? 12 : 0,
          color: colors.text,
          fontSize: 22,
          lineHeight: 28,
          fontWeight: "700",
          letterSpacing: -0.22,
        }}
      >
        {title}
      </Text>
      {!pushed && layout === "bar" ? (
        <>
          <IconButton icon="search" label="Search" onPress={() => open("search")} />
          <IconButton icon="download" label="Downloads" onPress={() => open("downloads")} />
          <IconButton icon="settings" label="Settings" onPress={() => open("settings")} />
        </>
      ) : null}
    </View>
  );
}
