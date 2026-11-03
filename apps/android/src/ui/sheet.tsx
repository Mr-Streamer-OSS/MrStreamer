import type { ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import { colors } from "./theme.ts";

/**
 * A modal bottom sheet over the screen that opened it. Back, Escape and a tap on the scrim close
 * it before anything under it, and TalkBack stays inside it while it shows. Its content fills it
 * under the drag handle, up to 560dp wide, and pads the system's navigation bar itself. Paper A: a
 * #141414 surface with 28dp top corners over a 60% black scrim, a 32x4dp handle in a 36dp band.
 */
export function Sheet({
  visible,
  label,
  onClose,
  children,
}: {
  visible: boolean;
  /** What TalkBack calls the scrim that closes it. */
  label: string;
  onClose: () => void;
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
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close ${label}`}
          onPress={onClose}
          style={{ position: "absolute", inset: 0, backgroundColor: colors.scrim }}
        />
        <View
          style={{
            height: "88%",
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
          {children}
        </View>
      </View>
    </Modal>
  );
}
