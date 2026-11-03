import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { colors } from "./theme.ts";

/**
 * A modal bottom sheet over the screen that opened it. Back and a tap on the scrim close it before
 * anything under it (React Native's Modal also takes Escape as Back), and TalkBack stays inside
 * it while it shows. Its content fills it under the drag handle, up to 560dp wide, and must pad
 * the system's navigation bar itself from `useSafeAreaInsets`, which here gives the sheet's own
 * window's insets. Paper A: a #141414 surface with 28dp top corners over a 60% black scrim, a
 * 32x4dp handle in a 36dp band.
 *
 * It is 88% of the window tall, its content laying itself out in that height. With `fit` it is
 * as tall as its content up to that 88%, and scrolls it past there, as Watch's media sheets are.
 */
export function Sheet({
  visible,
  label,
  onClose,
  fit = false,
  children,
}: {
  visible: boolean;
  /** What TalkBack calls the scrim that closes it. */
  label: string;
  onClose: () => void;
  fit?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      {/* Its own window's insets, not those of the screen it opened over, which may have left
          the navigation bar's to the destinations' bar. */}
      <SafeAreaProvider style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Close {label}", { label })}
          onPress={onClose}
          // TalkBack offers it; the keyboard skips it for the sheet's own controls.
          focusable={false}
          style={{ position: "absolute", inset: 0, backgroundColor: colors.scrim }}
        />
        <View
          style={{
            ...(fit ? { maxHeight: "88%" } : { height: "88%" }),
            width: "100%",
            maxWidth: 560,
            alignSelf: "center",
            paddingBottom: 8,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            backgroundColor: colors.surface,
            overflow: "hidden",
          }}
        >
          <View
            importantForAccessibility="no-hide-descendants"
            style={{ height: 36, alignItems: "center", justifyContent: "center" }}
          >
            <View
              style={{ width: 32, height: 4, borderRadius: 2, backgroundColor: colors.handle }}
            />
          </View>
          {fit ? <ScrollView style={{ flexGrow: 0 }}>{children}</ScrollView> : children}
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}
