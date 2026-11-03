import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import {
  SafeAreaInsetsContext,
  SafeAreaProvider,
  useSafeAreaInsets,
  type EdgeInsets,
} from "react-native-safe-area-context";
import { formatList } from "@mrstreamer/core/i18n";
import { sources } from "../bootstrap/sources.ts";
import { layoutFor, type NavigationLayout } from "../navigation/destinations.ts";
import { footOverlay } from "../navigation/screen.tsx";
import { useOpenShared } from "../navigation/open.ts";
import { useStore } from "../platform/store.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import { IconButton, type IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { useLocale } from "./catalogue.ts";
import { t } from "./copy.ts";
import { discover } from "./discovery.ts";

// Live's own pieces of Paper A that the shared ui/ and navigation/ components don't offer yet: a
// screen frame whose top app bar a screen draws itself (Find's field, Edit's Close and Save, the
// tablet header's shortcuts), a sheet as tall as its content, Material dialogs, a snackbar and the
// providers' status line.

/** Paper A's destructive and error red. */
export const RED = "#FF5A4E";

/** Rules inside a sheet, and the outline of a channel that doesn't show. */
export const RAISED_RULE = "#262626";

/** A disabled icon. */
export const DISABLED = "#5C5C5C";

/** Paper's 200% text. From 1.5x the edit rows drop their move buttons under the lines. */
export const useLargeText = () => useWindowDimensions().fontScale >= 1.5;

/** The layout and insets a Live screen frames itself with, as navigation/screen.tsx's `Screen`. */
export function useFrame() {
  const layout = layoutFor(useWindowDimensions().width);
  const insets = useSafeAreaInsets();
  // The navigation bar takes the bottom below 600dp; the rail takes the left from 600dp.
  const framed: EdgeInsets = { ...insets, ...(layout === "bar" ? { bottom: 0 } : { left: 0 }) };

  return { layout, framed };
}

/**
 * The frame of a Live screen that draws its own top app bar: `bar` over `children`, which pad only
 * the bottom inset left to them, as under `Screen`. `Body` pads it for a screen. It adds
 * the measured mini player height from `footOverlay` to that inset.
 */
export function Frame({
  framed,
  bar,
  children,
}: {
  framed: EdgeInsets;
  bar: ReactNode;
  children: ReactNode;
}) {
  const overlaid = useStore(footOverlay);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {bar}
      <SafeAreaInsetsContext.Provider
        value={{ ...framed, top: 0, left: 0, right: 0, bottom: framed.bottom + overlaid }}
      >
        <View style={{ flex: 1, paddingLeft: framed.left, paddingRight: framed.right }}>
          {children}
        </View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

/** A screen's content under its bar, padding the bottom inset the frame leaves to it, once. */
export function Body({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();

  return <View style={{ flex: 1, paddingBottom: insets.bottom }}>{children}</View>;
}

/**
 * A top app bar with a leading icon button (Back or Close), a title and trailing actions. Paper A:
 * 64dp on phones and 56dp beside the rail, the icon's 48dp target 4dp from the edge on phones.
 */
export function Bar({
  layout,
  framed,
  leading,
  title,
  trailing,
  height,
  rule = false,
}: {
  layout: NavigationLayout;
  framed: EdgeInsets;
  leading: { icon: IconName; label: string; onPress: () => void };
  title: ReactNode;
  trailing?: ReactNode;
  /** Overrides the layout's height, as the tablet's edit bar's 72dp. */
  height?: number | undefined;
  rule?: boolean;
}) {
  const bar = layout === "bar";

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        minHeight: framed.top + (height ?? (bar ? 64 : 56)),
        paddingTop: framed.top,
        paddingLeft: framed.left + (bar ? 4 : 12),
        paddingRight: framed.right + (bar ? 4 : 12),
        backgroundColor: colors.background,
        borderBottomWidth: rule ? 1 : 0,
        borderColor: colors.hairline,
      }}
    >
      <IconButton {...leading} />
      {typeof title === "string" ? (
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={{
            flex: 1,
            paddingLeft: 8,
            color: colors.text,
            fontSize: 22,
            lineHeight: 28,
            fontWeight: "700",
            letterSpacing: -0.22,
          }}
        >
          {title}
        </Text>
      ) : (
        title
      )}
      {trailing}
    </View>
  );
}

/** A Material text button: 48dp tall, 12dp padding, 14sp labels; `strong` for the dialog's own. */
export function TextButton({
  label,
  onPress,
  strong = false,
  color = colors.text,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  strong?: boolean;
  color?: string;
  accessibilityLabel?: string;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        minHeight: 48,
        flexShrink: 0,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: 24,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <Text style={{ color, fontSize: 14, lineHeight: 18, fontWeight: strong ? "700" : "500" }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A Material basic dialog over a 60% scrim: a 22sp title, 14sp body, then its buttons at the end.
 * Back and the scrim close it; TalkBack stays inside while it shows.
 */
export function Dialog({
  visible = true,
  title,
  body,
  children,
  actions,
  onClose,
}: {
  visible?: boolean;
  title: string;
  body?: string | undefined;
  children?: ReactNode;
  actions: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 24 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Cancel")}
          focusable={false}
          onPress={onClose}
          style={{ position: "absolute", inset: 0, backgroundColor: colors.scrim }}
        />
        <View
          accessibilityViewIsModal
          style={{
            width: "100%",
            maxWidth: 560,
            alignSelf: "center",
            paddingTop: 24,
            paddingHorizontal: 24,
            paddingBottom: 8,
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
          {body ? (
            <Text style={{ paddingTop: 12, color: colors.secondary, fontSize: 14, lineHeight: 20 }}>
              {body}
            </Text>
          ) : null}
          {children}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: 8,
              paddingTop: 16,
            }}
          >
            {actions}
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * A modal bottom sheet as tall as its content, up to 88% of the window, which ui/sheet.tsx's
 * fixed-height `Sheet` doesn't offer: the same #141414 surface, 28dp corners, handle and Back.
 */
export function FitSheet({
  visible,
  label,
  onClose,
  children,
}: {
  visible: boolean;
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
      <SafeAreaProvider style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t("Close")} ${label}`}
          onPress={onClose}
          focusable={false}
          style={{ position: "absolute", inset: 0, backgroundColor: colors.scrim }}
        />
        <SheetBody>{children}</SheetBody>
      </SafeAreaProvider>
    </Modal>
  );
}

function SheetBody({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        maxHeight: "88%",
        width: "100%",
        maxWidth: 560,
        alignSelf: "center",
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
      <ScrollView contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}>
        {children}
      </ScrollView>
    </View>
  );
}

/** A sheet's 16sp bold heading, 48dp tall on the sheet's 24dp margin. */
export function SheetTitle({ children }: { children: string }) {
  return (
    <View style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 24 }}>
      <Text
        accessibilityRole="header"
        style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}
      >
        {children}
      </Text>
    </View>
  );
}

/**
 * A sheet's row: a 24dp icon slot (empty keeps the lane), its label, bold while `selected`, and a
 * trailing count. Paper A: 56dp on the sheet's 24dp margin.
 */
export function SheetRow({
  icon,
  label,
  selected = false,
  trailing,
  onPress,
  role = "button",
}: {
  icon?: IconName | undefined;
  label: string;
  selected?: boolean;
  trailing?: string | undefined;
  onPress: () => void;
  role?: "button" | "checkbox" | "radio";
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={role === "button" ? undefined : { checked: selected }}
      accessibilityLabel={trailing ? `${label}, ${trailing}` : label}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 56,
        paddingHorizontal: 24,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <View style={{ width: 24, flexShrink: 0 }}>
        {icon ? <MaterialIcons name={icon} size={24} color={colors.text} /> : null}
      </View>
      <Text
        style={{
          flex: 1,
          paddingVertical: 8,
          color: colors.text,
          fontSize: 16,
          lineHeight: 20,
          fontWeight: selected ? "500" : "400",
        }}
      >
        {label}
      </Text>
      {trailing ? (
        <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>{trailing}</Text>
      ) : null}
    </Pressable>
  );
}

/**
 * A Material snackbar 8dp over the screen's bottom, announced as it shows: what failed and the
 * action that retries it. It stays until that action succeeds or its screen closes it.
 */
export function Snackbar({
  message,
  action,
  onAction,
}: {
  message: string;
  action: string;
  onAction: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 8,
        right: 8,
        bottom: 8 + insets.bottom,
        alignItems: "center",
      }}
    >
      <View
        accessibilityLiveRegion="polite"
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          width: "100%",
          maxWidth: 560,
          minHeight: 56,
          paddingVertical: 4,
          paddingLeft: 16,
          paddingRight: 4,
          borderRadius: 4,
          backgroundColor: colors.hairline,
        }}
      >
        <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 }}>{message}</Text>
        <TextButton label={action} strong onPress={onAction} />
      </View>
    </View>
  );
}

/** What the providers still owe Live: those loading, and those that failed. */
export function useGaps() {
  useLocale();
  const view = discover(useStore(sources.state));

  const loading = view.restoring
    ? t("Loading channels…")
    : view.loading.length
      ? t("Loading channels from {providers}.", { providers: formatList(view.loading) })
      : undefined;

  const failed = view.failed.length
    ? t("Couldn't load channels from {providers}.", { providers: formatList(view.failed) })
    : undefined;

  return { loading, failed };
}

/** Retries every provider whose channels failed. */
export function retryFailed() {
  const state = sources.state.get();

  if (state.kind !== "ready") return;

  for (const source of state.sources) {
    if (source.channels.kind === "failed") sources.retry(source.id);
  }
}

/**
 * The providers' status line under a screen's rows: "Loading channels from {providers}." with a
 * still sync icon, or "Couldn't load channels from {providers}." with Retry and Settings. Nothing
 * while every provider has loaded. Still: no spinner, no animation.
 */
export function StatusLine() {
  const { loading, failed } = useGaps();
  const open = useOpenShared();

  if (!loading && !failed) return null;

  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexShrink: 0,
        borderTopWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: colors.background,
      }}
    >
      {failed ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            minHeight: 56,
            paddingVertical: 4,
            paddingLeft: 16,
            paddingRight: 4,
          }}
        >
          <MaterialIcons
            importantForAccessibility="no-hide-descendants"
            name="error-outline"
            size={20}
            color={RED}
          />
          <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 18 }}>
            {failed}
          </Text>
          <TextButton label={t("Retry")} onPress={retryFailed} />
          <TextButton label={t("Settings")} onPress={() => open("settings")} />
        </View>
      ) : null}
      {loading ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            minHeight: 56,
            paddingVertical: 4,
            paddingHorizontal: 16,
          }}
        >
          <MaterialIcons
            importantForAccessibility="no-hide-descendants"
            name="sync"
            size={20}
            color={colors.secondary}
          />
          <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 18 }}>
            {loading}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
