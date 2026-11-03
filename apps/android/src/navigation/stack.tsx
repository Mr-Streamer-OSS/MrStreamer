import { Stack } from "expo-router";
import { colors } from "../ui/theme.ts";

/** Each destination's own stack: its root, then what is pushed over it, Search to Settings. */
export function DestinationStack() {
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    />
  );
}
