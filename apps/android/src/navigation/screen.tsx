import type { ReactNode } from "react";
import { useWindowDimensions, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../ui/theme.ts";
import { TopAppBar } from "../ui/top-app-bar.tsx";
import { layoutFor } from "./destinations.ts";

/**
 * The frame of every screen on a destination's stack: its top app bar over `children`. A feature
 * renders its screen as `children` and pads only the insets left to it: the top app bar takes the
 * top, the navigation bar the bottom on phones and the rail the left from 600dp, so a list padding
 * `useSafeAreaInsets().bottom` still clears the system's navigation bar on a tablet.
 */
export function Screen({
  title,
  pushed = false,
  children,
}: {
  title: string;
  /** Opened over a destination's root, so the bar offers Back. */
  pushed?: boolean;
  children?: ReactNode;
}) {
  const layout = layoutFor(useWindowDimensions().width);
  const insets = useSafeAreaInsets();
  const framed = { ...insets, ...(layout === "bar" ? { bottom: 0 } : { left: 0 }) };
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <TopAppBar title={title} layout={layout} pushed={pushed} insets={framed} />
      <SafeAreaInsetsContext.Provider value={{ ...framed, top: 0 }}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}
