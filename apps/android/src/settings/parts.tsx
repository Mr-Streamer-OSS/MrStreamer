import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useEffect, useState, type ComponentRef, type ReactNode, type Ref } from "react";
import { AccessibilityInfo, Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardFocus } from "../ui/focus.ts";
import type { IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";

// Paper A's Settings parts: caps section labels over 56dp rows, a Material switch, a snackbar,
// a dialog, and a sheet's action rows. Every screen under src/settings builds from these.

const body = { fontSize: 16, lineHeight: 20 } as const;
const small = { fontSize: 14, lineHeight: 18 } as const;

/** A group of rows under its caps label, a hairline above all but the first. */
export function Section({
  name,
  first = false,
  children,
}: {
  name: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={first ? null : { borderTopWidth: 1, borderColor: colors.hairline, paddingTop: 8 }}>
      <View style={{ height: 40, justifyContent: "flex-end", paddingBottom: 8, paddingLeft: 16 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: colors.secondary,
            fontSize: 12,
            lineHeight: 16,
            fontWeight: "700",
            letterSpacing: 0.72,
          }}
        >
          {name.toLocaleUpperCase()}
        </Text>
      </View>
      {children}
    </View>
  );
}

/**
 * A pressable row with Android's ripple and the keyboard's focus mark. `selected` tells TalkBack,
 * and fills the row unless `fill` is false (a checkmark marks it instead).
 */
export function Pressed({
  onPress,
  label,
  value,
  role = "button",
  selected = false,
  fill = selected,
  rowRef,
  minHeight,
  style,
  children,
}: {
  onPress: () => void;
  label: string;
  value?: string | undefined;
  role?: "button" | "link";
  selected?: boolean | undefined;
  fill?: boolean;
  rowRef?: Ref<ComponentRef<typeof Pressable>> | undefined;
  minHeight: number;
  style?: object;
  children: ReactNode;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      ref={rowRef}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityValue={value ? { text: value } : undefined}
      accessibilityState={{ selected }}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight,
        paddingHorizontal: 16,
        backgroundColor: focused ? colors.focus : fill ? colors.raised : undefined,
        ...style,
      }}
    >
      {children}
    </Pressable>
  );
}

/**
 * A setting: its label, then its value, and a trailing chevron (`next`) or new-window icon. One
 * without `onPress` only shows its value.
 */
export function Row({
  label,
  value,
  trailing,
  onPress,
  selected,
  rowRef,
}: {
  label: string;
  value?: string;
  trailing?: "next" | "external";
  onPress?: () => void;
  selected?: boolean | undefined;
  rowRef?: Ref<ComponentRef<typeof Pressable>>;
}) {
  if (!onPress) {
    return (
      <View
        accessible
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 16,
          minHeight: 56,
          paddingHorizontal: 16,
        }}
      >
        <Text style={{ flex: 1, color: colors.text, ...body }}>{label}</Text>
        {value ? <Text style={{ color: colors.secondary, ...small }}>{value}</Text> : null}
      </View>
    );
  }

  return (
    <Pressed
      onPress={onPress}
      label={label}
      value={value}
      role={trailing === "external" ? "link" : "button"}
      selected={selected}
      rowRef={rowRef}
      minHeight={56}
    >
      <Text style={{ flex: 1, color: colors.text, ...body }}>{label}</Text>
      {value ? <Text style={{ color: colors.secondary, ...small }}>{value}</Text> : null}
      {trailing ? (
        <MaterialIcons
          importantForAccessibility="no-hide-descendants"
          name={trailing === "next" ? "chevron-right" : "open-in-new"}
          size={24}
          color={colors.secondary}
        />
      ) : null}
    </Pressed>
  );
}

/**
 * A setting that is on or off, with Material's switch: off, an outlined 52x32dp track with a 16dp
 * grey handle at its start; on, a white track with a 24dp black handle at its end. No motion.
 */
export function SwitchRow({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      onPress={() => onChange(!on)}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 56,
        paddingHorizontal: 16,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <Text style={{ flex: 1, color: colors.text, ...body }}>{label}</Text>
      <View
        style={{
          width: 52,
          height: 32,
          borderRadius: 16,
          borderWidth: 2,
          borderColor: on ? colors.text : colors.inactive,
          backgroundColor: on ? colors.text : undefined,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: on ? "flex-end" : "flex-start",
          paddingHorizontal: on ? 2 : 6,
        }}
      >
        <View
          style={{
            width: on ? 24 : 16,
            height: on ? 24 : 16,
            borderRadius: on ? 12 : 8,
            backgroundColor: on ? colors.background : colors.inactive,
          }}
        />
      </View>
    </Pressable>
  );
}

/** A sentence under a setting, in secondary grey. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        paddingHorizontal: 16,
        paddingBottom: 8,
        color: colors.secondary,
        fontSize: 14,
        lineHeight: 20,
      }}
    >
      {children}
    </Text>
  );
}

/** An action in a sheet: a 24dp icon, then its label, 56dp tall on the sheet's 24dp margins. */
export function SheetAction({
  icon,
  label,
  onPress,
  primary = false,
  selected = false,
}: {
  icon: IconName | null;
  label: string;
  onPress: () => void;
  primary?: boolean;
  /** A picker's choice: TalkBack hears it, the checkmark `icon` shows it. */
  selected?: boolean;
}) {
  return (
    <Pressed
      onPress={onPress}
      label={label}
      minHeight={56}
      selected={selected}
      fill={false}
      style={{ paddingHorizontal: 24 }}
    >
      <View style={{ width: 24, flexShrink: 0 }}>
        {icon ? (
          <MaterialIcons
            importantForAccessibility="no-hide-descendants"
            name={icon}
            size={24}
            color={colors.text}
          />
        ) : null}
      </View>
      <Text style={{ flex: 1, color: colors.text, ...body, fontWeight: primary ? "500" : "400" }}>
        {label}
      </Text>
    </Pressed>
  );
}

export interface SnackbarMessage {
  readonly text: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

/**
 * What a screen tells the viewer about a write that didn't hold: `show` a message, and render
 * `snackbar` last inside the screen's content, which it sits over, 12dp in from its edges. TalkBack
 * reads it as it shows; it goes after ten seconds, on its action, or when another replaces it.
 */
export function useSnackbar() {
  const [message, show] = useState<SnackbarMessage | null>(null);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!message) return;
    AccessibilityInfo.announceForAccessibility(message.text);
    const timer = setTimeout(() => show(null), 10_000);

    return () => clearTimeout(timer);
  }, [message]);

  const snackbar = message ? (
    <View
      accessibilityLiveRegion="polite"
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        bottom: insets.bottom + 12,
        maxWidth: 560,
        alignSelf: "center",
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 6,
        paddingLeft: 16,
        paddingRight: 8,
        borderRadius: 4,
        backgroundColor: colors.raised,
      }}
    >
      <Text
        style={{ flex: 1, paddingVertical: 8, color: colors.text, fontSize: 14, lineHeight: 20 }}
      >
        {message.text}
      </Text>
      {message.action ? (
        <TextButton
          label={message.action.label}
          onPress={() => {
            show(null);
            message.action?.run();
          }}
          padding={8}
        />
      ) : null}
    </View>
  ) : null;

  return { snackbar, show };
}

/** A Material text button: 40dp tall, bold 14dp, in white or `color`. */
function TextButton({
  label,
  onPress,
  weight = "700",
  padding = 12,
}: {
  label: string;
  onPress: () => void;
  weight?: "500" | "700";
  padding?: number;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        minHeight: 40,
        justifyContent: "center",
        paddingHorizontal: padding,
        borderRadius: 20,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: weight }}>
        {label}
      </Text>
    </Pressable>
  );
}

export interface DialogButton {
  readonly label: string;
  readonly onPress: () => void;
  /** Cancel and its kind, set in a lighter weight than the answers. */
  readonly dismiss?: boolean;
}

/**
 * A Material dialog over a 60% black scrim: its title, `children` as its body, and its buttons
 * along its end, or `stacked` one under another. `onDismiss`, when given, is what Back and a tap
 * on the scrim do; without it neither closes the dialog, so only its buttons answer it.
 */
export function Dialog({
  visible,
  title,
  buttons,
  stacked = false,
  onDismiss,
  children,
}: {
  visible: boolean;
  title: string;
  buttons: readonly DialogButton[];
  stacked?: boolean;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onDismiss ?? (() => {})}
    >
      <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 24 }}>
        {onDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={buttons.find((each) => each.dismiss)?.label}
            onPress={onDismiss}
            focusable={false}
            style={{ position: "absolute", inset: 0, backgroundColor: colors.scrim }}
          />
        ) : (
          <View style={{ position: "absolute", inset: 0, backgroundColor: colors.scrim }} />
        )}
        <View
          style={{
            width: "100%",
            maxWidth: 560,
            alignSelf: "center",
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
          <View style={{ gap: 12 }}>{children}</View>
          <View
            style={
              stacked
                ? { alignItems: "flex-end", paddingTop: 8 }
                : { flexDirection: "row", justifyContent: "flex-end", gap: 8, paddingTop: 8 }
            }
          >
            {buttons.map((button) => (
              <TextButton
                key={button.label}
                label={button.label}
                onPress={button.onPress}
                weight={button.dismiss ? "500" : "700"}
              />
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** A dialog's paragraph. */
export function DialogText({ children }: { children: ReactNode }) {
  return <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 20 }}>{children}</Text>;
}
