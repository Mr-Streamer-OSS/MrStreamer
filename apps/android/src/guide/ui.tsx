import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { t as sharedT } from "@mrstreamer/core/i18n";
import { useState, type ReactNode } from "react";
import {
  Modal,
  ScrollView,
  Pressable,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardFocus } from "../ui/focus.ts";
import type { IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";

// The guide screens' pieces, as Paper A's guide page draws them: rows and fields on one lane (a
// 24dp icon at 16dp, text at 56dp), a content-high action sheet, Material's confirm dialog, A's
// 12dp buttons and still text for loading and empty states. Nothing here animates in a loop.

export const guideColors = {
  ...colors,
  /** A failure, and Remove. */
  failure: "#FF5A4E",
  /** A field's trailing hint. */
  hint: "#8A8A8A",
  /** The programme on now. */
  current: "#1F1F1F",
  track: "#262626",
  outline: "#3A3A3A",
  description: "#D0D0D0",
} as const;

export const text = {
  title: { color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "500" },
  heading: { color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" },
  secondary: { color: colors.secondary, fontSize: 14, lineHeight: 18 },
  note: { color: colors.secondary, fontSize: 14, lineHeight: 20 },
  large: {
    color: colors.text,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "700",
    letterSpacing: -0.42,
  },
} as const;

/** A pressable row or control that marks keyboard and D-pad focus, with Android's ripple. */
export function Press({
  style,
  children,
  ...props
}: Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      android_ripple={{ color: colors.ripple }}
      {...props}
      {...handlers}
      style={[style, focused && { backgroundColor: colors.focus }]}
    >
      {children}
    </Pressable>
  );
}

export function Icon({
  name,
  color = colors.text,
  size = 24,
}: {
  name: IconName;
  color?: string;
  size?: number;
}) {
  return (
    <MaterialIcons
      importantForAccessibility="no-hide-descendants"
      name={name}
      size={size}
      color={color}
    />
  );
}

/** Still text where a list or programme shows: loading, empty and unavailable states. */
export function Still({ text: words, inset = 16 }: { text: string; inset?: number }) {
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      style={{
        paddingTop: 24,
        paddingHorizontal: inset,
        borderTopWidth: 1,
        borderColor: colors.hairline,
      }}
    >
      <Text style={text.heading}>{words}</Text>
    </View>
  );
}

/** "Guide may be out of date", under a Schedule's day and on a programme. */
export function OutOfDate({ label, style }: { label: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      accessible
      style={[{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 40 }, style]}
    >
      <Icon name="history" color={colors.secondary} size={20} />
      <Text style={[text.secondary, { flexShrink: 1 }]}>{label}</Text>
    </View>
  );
}

/** A programme's progress: a 4dp white bar on its track, named for TalkBack. */
export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
      style={{
        height: 4,
        borderRadius: 2,
        backgroundColor: guideColors.track,
        flexDirection: "row",
      }}
    >
      <View style={{ width: `${value * 100}%`, borderRadius: 2, backgroundColor: colors.text }} />
    </View>
  );
}

/** A's 12dp buttons: white filled for the primary action, outlined for the rest. */
export function Button({
  label,
  onPress,
  filled = false,
  icon,
  disabled = false,
  grow = false,
}: {
  label: string;
  onPress: () => void;
  filled?: boolean;
  icon?: IconName;
  disabled?: boolean;
  grow?: boolean;
}) {
  return (
    <Press
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight: 48,
        paddingVertical: 8,
        paddingLeft: icon ? 16 : 20,
        paddingRight: 20,
        borderRadius: 12,
        overflow: "hidden",
        opacity: disabled ? 0.5 : 1,
        ...(grow && { flexGrow: 1, flexBasis: 0 }),
        ...(filled
          ? { backgroundColor: colors.text }
          : { borderWidth: 1, borderColor: guideColors.outline }),
      }}
    >
      {icon ? (
        <Icon name={icon} size={20} color={filled ? colors.background : colors.text} />
      ) : null}
      <Text
        style={{
          color: filled ? colors.background : colors.text,
          fontSize: 15,
          lineHeight: 18,
          fontWeight: filled ? "700" : "500",
          textAlign: "center",
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
    </Press>
  );
}

/** A text field on the Connect lane: its icon, the input, and an optional trailing hint. */
export function Field({
  icon,
  label,
  hint,
  ...input
}: { icon: IconName; label: string; hint?: string } & TextInputProps) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 56,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderColor: colors.hairline,
      }}
    >
      <Icon name={icon} color={colors.secondary} />
      <TextInput
        accessibilityLabel={hint ? `${label}, ${hint}` : label}
        placeholder={label}
        placeholderTextColor={colors.secondary}
        selectionColor={colors.text}
        cursorColor={colors.text}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ flex: 1, minHeight: 48, color: colors.text, fontSize: 16, padding: 0 }}
        {...input}
      />
      {hint ? (
        <Text style={{ color: guideColors.hint, fontSize: 14, lineHeight: 18 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** A labelled value on a 104dp label lane: a channel's own ids, and the Guide id field. */
export function Labelled({
  label,
  children,
  focused = false,
  top = false,
  inset,
}: {
  label: string;
  children: ReactNode;
  focused?: boolean;
  top?: boolean;
  inset: number;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 56,
        paddingVertical: 8,
        paddingHorizontal: inset,
        borderBottomWidth: 1,
        borderBottomColor: focused ? colors.text : colors.hairline,
        ...(top && { borderTopWidth: 1, borderTopColor: colors.hairline }),
      }}
    >
      <Text style={[text.secondary, { width: 104 }]}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}

/** One action of an `ActionSheet`. */
export interface Action {
  readonly label: string;
  readonly icon: IconName;
  readonly run: () => void;
  readonly destructive?: true;
}

/**
 * A modal bottom sheet of actions under its title, as high as they are (the shared `Sheet` fills
 * 88%). Back, Escape and the scrim close it; an action closes it before it runs.
 */
export function ActionSheet({
  title,
  actions,
  onClose,
}: {
  /** Null hides it. */
  title: string | null;
  actions: readonly Action[];
  onClose: () => void;
}) {
  return (
    <Modal
      visible={title !== null}
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <SafeAreaProvider style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={sharedT("Close")}
          onPress={onClose}
          focusable={false}
          style={{ position: "absolute", inset: 0, backgroundColor: colors.scrim }}
        />
        <SheetBody title={title ?? ""} actions={actions} onClose={onClose} />
      </SafeAreaProvider>
    </Modal>
  );
}

function SheetBody({
  title,
  actions,
  onClose,
}: {
  title: string;
  actions: readonly Action[];
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View
      accessibilityViewIsModal
      style={{
        width: "100%",
        maxWidth: 560,
        maxHeight: "88%",
        alignSelf: "center",
        paddingBottom: insets.bottom + 8,
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
        <View style={{ width: 32, height: 4, borderRadius: 2, backgroundColor: colors.handle }} />
      </View>
      <ScrollView>
        <Text
          numberOfLines={3}
          accessibilityRole="header"
          style={[text.heading, { paddingHorizontal: 24, paddingBottom: 12 }]}
        >
          {title}
        </Text>
        {actions.map((action) => {
          const color = action.destructive ? guideColors.failure : colors.text;

          return (
            <Press
              key={action.label}
              accessibilityLabel={action.label}
              onPress={() => {
                onClose();
                action.run();
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 16,
                minHeight: 56,
                paddingHorizontal: 24,
              }}
            >
              <Icon name={action.icon} color={color} />
              <Text style={[text.title, { color, flexShrink: 1 }]}>{action.label}</Text>
            </Press>
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * Material's confirm dialog: a title, its consequence, Cancel and the confirming action, which
 * `destructive` colours as a failure. Back, Escape and Cancel close it; TalkBack stays inside.
 */
export function ConfirmDialog({
  title,
  body,
  confirm,
  onConfirm,
  onClose,
}: {
  /** Null hides it. */
  title: string | null;
  body: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={title !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 48,
          backgroundColor: colors.scrim,
        }}
      >
        <View
          accessibilityViewIsModal
          style={{
            width: "100%",
            maxWidth: 560,
            gap: 16,
            paddingTop: 24,
            paddingHorizontal: 24,
            paddingBottom: 16,
            borderRadius: 28,
            backgroundColor: colors.surface,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{
              color: colors.text,
              fontSize: 22,
              lineHeight: 28,
              fontWeight: "700",
              letterSpacing: -0.22,
            }}
          >
            {title}
          </Text>
          <Text style={text.note}>{body}</Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: 8,
              paddingTop: 8,
            }}
          >
            <DialogButton label={sharedT("Cancel")} onPress={onClose} />
            <DialogButton
              label={confirm}
              onPress={() => {
                onClose();
                onConfirm();
              }}
              destructive
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function DialogButton({
  label,
  onPress,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <Press
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: 48,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: 24,
        overflow: "hidden",
      }}
    >
      <Text
        style={{
          color: destructive ? guideColors.failure : colors.text,
          fontSize: 15,
          lineHeight: 18,
          fontWeight: destructive ? "700" : "500",
        }}
      >
        {label}
      </Text>
    </Press>
  );
}

/** Whether a text field has focus, for its underline to show it. */
export function useFieldFocus() {
  const [focused, setFocused] = useState(false);

  return { focused, onFocus: () => setFocused(true), onBlur: () => setFocused(false) };
}
