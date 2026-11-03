import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ComponentProps } from "react";
import { Pressable } from "react-native";
import { useKeyboardFocus } from "./focus.ts";
import { colors } from "./theme.ts";

export type IconName = ComponentProps<typeof MaterialIcons>["name"];

/**
 * An icon-only button, named for TalkBack by `label`: a 24dp icon centred in a 48dp target, which
 * the rail widens to its own 56dp slots.
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
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...handlers}
      android_ripple={{
        color: colors.ripple,
        borderless: true,
        radius: Math.min(width, height) / 2,
      }}
      style={{
        width,
        height,
        borderRadius: Math.min(width, height) / 2,
        backgroundColor: focused ? colors.focus : undefined,
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
