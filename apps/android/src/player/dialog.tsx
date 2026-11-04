import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Pressable, Text, View } from "react-native";
import { colors } from "../ui/theme.ts";

/** Paper A's secondary text over the picture and in dialogs. */
export const DIM = "#D0D0D0";

/**
 * Watch's dialog over a 60% scrim, as Paper A's media controls and online subtitles draw it: a
 * 20sp title, a 14sp body, an optional field, then its text buttons along the end. Back and the
 * scrim do `onClose`, which `closeLabel` names for TalkBack.
 */
export function PlayerDialog({
  title,
  body,
  children,
  actions,
  closeLabel,
  onClose,
}: {
  title: string;
  body?: string | undefined;
  children?: ReactNode;
  actions: ReactNode;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          focusable={false}
          onPress={onClose}
          style={{ position: "absolute", inset: 0, backgroundColor: colors.scrim }}
        />
        <View
          accessibilityViewIsModal
          style={{
            width: "100%",
            maxWidth: 400,
            gap: 16,
            paddingTop: 24,
            paddingHorizontal: 24,
            paddingBottom: 12,
            borderRadius: 28,
            backgroundColor: colors.surface,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ color: colors.text, fontSize: 20, lineHeight: 24, fontWeight: "700" }}
          >
            {title}
          </Text>
          {body ? <Text style={{ color: DIM, fontSize: 14, lineHeight: 20 }}>{body}</Text> : null}
          {children}
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {actions}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
