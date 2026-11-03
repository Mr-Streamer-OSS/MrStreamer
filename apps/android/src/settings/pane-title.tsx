import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { colors } from "../ui/theme.ts";

/**
 * A detail pane's own title while it shows beside its list, where the top app bar names the list
 * instead; `children` are its actions. Paper A: 64dp, the title on a 24dp margin.
 */
export function PaneTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: 64,
        paddingLeft: 24,
        paddingRight: children ? 12 : 24,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          flex: 1,
          color: colors.text,
          fontSize: 22,
          lineHeight: 28,
          fontWeight: "700",
          letterSpacing: -0.22,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
