import type { ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import { colors } from "./theme.ts";

/**
 * A modal bottom sheet over the screen that opened it. Back, Escape and a tap on the scrim close
 * it before anything under it, and TalkBack stays inside it while it shows. Its content fills it,
 * up to 640dp wide on tablets, and pads the system's navigation bar itself.
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
          style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0, 0, 0, 0.6)" }}
        />
        <View
          style={{
            height: "88%",
            width: "100%",
            maxWidth: 640,
            alignSelf: "center",
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: colors.hairline,
            backgroundColor: colors.background,
            overflow: "hidden",
          }}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}
