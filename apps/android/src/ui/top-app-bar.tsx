import { Text, View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import type { NavigationLayout } from "../navigation/destinations.ts";
import { useOpenShared } from "../navigation/open.ts";
import { IconButton } from "./icon-button.tsx";
import { colors } from "./theme.ts";

/**
 * A screen's top app bar. A destination's root shows its title, with Search, Downloads and
 * Settings on phones (the rail carries them from 600dp); a pushed screen, or a detail pane
 * folded over its list, shows Back before its title instead. Paper A: 64dp with a 16dp margin on phones, 56dp with 24dp margins beside the
 * rail; Back's icon sits on the title's margin.
 */
export function TopAppBar({
  title,
  layout,
  insets,
  onBack,
}: {
  title: string;
  layout: NavigationLayout;
  /** The screen's insets, but the side the rail already covers. */
  insets: EdgeInsets;
  /** Given, the bar offers Back, which calls it, in place of Search, Downloads and Settings. */
  onBack?: (() => void) | undefined;
}) {
  const open = useOpenShared();
  const bar = layout === "bar";
  const margin = bar ? 16 : 24;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: insets.top + (bar ? 64 : 56),
        paddingTop: insets.top,
        // Back's 48dp target pads its 24dp icon by 12dp.
        paddingLeft: insets.left + (onBack ? margin - 12 : margin),
        paddingRight: insets.right + (bar ? 4 : margin),
        backgroundColor: colors.background,
      }}
    >
      {onBack ? <IconButton icon="arrow-back" label="Back" onPress={onBack} /> : null}
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={{
          flex: 1,
          paddingLeft: onBack ? 12 : 0,
          color: colors.text,
          fontSize: 22,
          lineHeight: 28,
          fontWeight: "700",
          letterSpacing: -0.22,
        }}
      >
        {title}
      </Text>
      {!onBack && bar ? (
        <>
          <IconButton icon="search" label="Search" onPress={() => open("search")} />
          <IconButton icon="download" label="Downloads" onPress={() => open("downloads")} />
          <IconButton icon="settings" label="Settings" onPress={() => open("settings")} />
        </>
      ) : null}
    </View>
  );
}
