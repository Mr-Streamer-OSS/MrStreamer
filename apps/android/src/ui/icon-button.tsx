import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ComponentProps } from "react";
import { Pressable } from "react-native";
import { colors } from "./theme.ts";

export type IconName = ComponentProps<typeof MaterialIcons>["name"];

/**
 * An icon-only button, named for TalkBack by `label`: a 24dp icon centred in a target of at least
 * 48dp, which the rail widens to its own 56dp slots.
 */
export function IconButton({
  icon,
  label,
  onPress,
  color = colors.text,
  width = 48,
  height = 48,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color?: string;
  width?: number;
  height?: number;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        width: Math.max(width, 48),
        height: Math.max(height, 48),
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <MaterialIcons
        importantForAccessibility="no-hide-descendants"
        name={icon}
        size={24}
        color={color}
      />
    </Pressable>
  );
}
