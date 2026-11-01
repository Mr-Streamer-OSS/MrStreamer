import { useRef, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";

/** How far the row slides to show its swiped action. */
const REVEAL = 92;

/**
 * A row that slides left under the finger to show `action` in red, as iOS's lists do, for
 * Downloads and the reminders. It follows the finger and settles open or shut; tapping the red
 * part runs the action. Without one it is the row alone. VoiceOver reaches the action through the
 * row's own actions instead, so the red part is hidden from it.
 */
export function Swipe({
  label,
  action,
  children,
  testID,
}: {
  label: string;
  action: { run(): void } | undefined;
  children: ReactNode;
  testID: string;
}) {
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const settle = (to: number) => {
    open.current = to !== 0;
    Animated.timing(x, { toValue: to, duration: 180, useNativeDriver: true }).start();
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, move) =>
        Math.abs(move.dx) > 12 && Math.abs(move.dx) > Math.abs(move.dy) * 1.5,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, move) =>
        x.setValue(Math.min(0, Math.max(-REVEAL * 1.3, (open.current ? -REVEAL : 0) + move.dx))),
      onPanResponderRelease: (_, move) =>
        settleRef.current((open.current ? -REVEAL : 0) + move.dx < -REVEAL / 2 ? -REVEAL : 0),
      onPanResponderTerminate: () => settleRef.current(open.current ? -REVEAL : 0),
    }),
  ).current;
  if (!action) return children;
  return (
    <View style={styles.swipe}>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={() => {
          settle(0);
          action.run();
        }}
        style={styles.reveal}
        testID={testID}
      >
        <Text style={styles.revealLabel}>{label}</Text>
      </Pressable>
      <Animated.View
        style={[styles.slide, { transform: [{ translateX: x }] }]}
        {...pan.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  swipe: { overflow: "hidden" },
  slide: { backgroundColor: "#000000" },
  reveal: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: REVEAL,
    backgroundColor: "#FF453A",
    alignItems: "center",
    justifyContent: "center",
  },
  revealLabel: { color: "#FFFFFF", fontSize: 17, fontWeight: "600" },
});
