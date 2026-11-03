import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ReactNode } from "react";
import { Image, Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { formatNumber } from "@mrstreamer/core/i18n";
import { useKeyboardFocus } from "../ui/focus.ts";
import type { IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";

// The library's pieces of Paper A's "Android library" page: text tabs, the count row, radio rows,
// buttons, posters and the recovery and status lines every library screen shares.

/** Lines inside a sheet, and the outline of a secondary button. */
export const sheetLine = "#262626";
const outline = "#3A3A3A";

/** What a title's name sits on while its artwork is missing. */
const placeholder = "#1C1C1C";

const font = { fontFamily: "Roboto" } as const;

export const typeScale = {
  title: { ...font, color: colors.text, fontSize: 22, lineHeight: 28, fontWeight: "700" },
  section: { ...font, color: colors.text, fontSize: 20, lineHeight: 26, fontWeight: "700" },
  heading: {
    ...font,
    color: colors.secondary,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    letterSpacing: 0.72,
    textTransform: "uppercase",
  },
  body: { ...font, color: colors.text, fontSize: 16, lineHeight: 22 },
  row: { ...font, color: colors.text, fontSize: 15, lineHeight: 20, fontWeight: "500" },
  label: { ...font, color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "700" },
  meta: { ...font, color: colors.secondary, fontSize: 14, lineHeight: 18 },
  small: { ...font, color: colors.secondary, fontSize: 13, lineHeight: 18 },
  message: { ...font, color: colors.text, fontSize: 18, lineHeight: 24, fontWeight: "500" },
} as const;

/**
 * A pressable surface with Android's ripple and the keyboard's focus mark. Named for TalkBack by
 * `label`, which replaces what its children say.
 */
export function Press({
  label,
  onPress,
  role = "button",
  state,
  style,
  children,
}: {
  label: string;
  onPress: () => void;
  role?: "button" | "radio" | "tab";
  state?: { selected?: boolean; checked?: boolean };
  style?: ViewStyle;
  children: ReactNode;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={state}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{ ...style, ...(focused ? { backgroundColor: colors.focus } : null) }}
    >
      {children}
    </Pressable>
  );
}

export function Icon({
  name,
  size = 24,
  color = colors.text,
}: {
  name: IconName;
  size?: number;
  color?: string;
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

/**
 * A 48dp row of text tabs under a 1dp hairline, the selected one bold and underlined in white.
 * It scrolls sideways when the tabs outgrow the width; `trailing` ends the row on tablets.
 */
export function TextTabs<T extends string>({
  tabs,
  selected,
  onSelect,
  inset,
  trailing,
}: {
  tabs: readonly { value: T; label: string }[];
  selected: T | undefined;
  onSelect: (value: T) => void;
  inset: number;
  trailing?: ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "stretch",
        minHeight: 48,
        borderBottomWidth: 1,
        borderColor: colors.hairline,
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        style={{ flexGrow: trailing ? 0 : 1, flexShrink: 1 }}
        contentContainerStyle={{ minHeight: 48, paddingLeft: inset }}
      >
        {tabs.map((tab) => {
          const on = tab.value === selected;

          return (
            <Press
              key={tab.value}
              label={tab.label}
              role="tab"
              state={{ selected: on }}
              onPress={() => onSelect(tab.value)}
              style={{
                justifyContent: "center",
                paddingHorizontal: 12,
                paddingTop: on ? 3 : 0,
                borderBottomWidth: on ? 3 : 0,
                borderColor: colors.text,
              }}
            >
              <Text
                style={{
                  ...typeScale.label,
                  color: on ? colors.text : colors.secondary,
                  fontWeight: on ? "700" : "500",
                }}
              >
                {tab.label}
              </Text>
            </Press>
          );
        })}
      </ScrollView>
      {trailing ? (
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          {trailing}
        </View>
      ) : null}
    </View>
  );
}

/** "18 of 64 series" and Sort & filter, with a white dot while a choice differs from the default. */
export function CountSummary({
  count,
  label,
  active,
  onPress,
}: {
  count: string;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <>
      <Text style={{ ...typeScale.meta, flexShrink: 1, paddingHorizontal: 12 }}>{count}</Text>
      <Press
        label={label}
        state={{ selected: active }}
        onPress={onPress}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 48,
          paddingHorizontal: 12,
        }}
      >
        <Icon name="tune" size={20} />
        <Text style={typeScale.label}>{label}</Text>
        {active ? (
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.text }} />
        ) : null}
      </Press>
    </>
  );
}

/** The 48dp row that starts a collection on phones: its count, then Sort & filter. */
export function CountRow({
  inset,
  ...summary
}: Parameters<typeof CountSummary>[0] & { inset: number }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: 48,
        paddingLeft: inset - 12,
        paddingRight: 4,
        borderBottomWidth: 1,
        borderColor: colors.hairline,
      }}
    >
      <CountSummary {...summary} />
    </View>
  );
}

/** A section heading in a sheet: small capitals over its rows. */
export function SheetHeading({ children, first = false }: { children: string; first?: boolean }) {
  return (
    <Text
      accessibilityRole="header"
      style={{
        ...typeScale.heading,
        paddingTop: first ? 16 : 20,
        paddingBottom: 4,
        paddingHorizontal: 24,
      }}
    >
      {children}
    </Text>
  );
}

/** A radio row of a sheet, with its count in a 48dp right-hand lane when it has one. */
export function RadioRow({
  label,
  count,
  selected,
  onPress,
  height = 48,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onPress: () => void;
  height?: number;
}) {
  return (
    <Press
      label={label}
      role="radio"
      state={{ checked: selected }}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: height,
        paddingHorizontal: 24,
      }}
    >
      <Icon
        name={selected ? "radio-button-checked" : "radio-button-unchecked"}
        color={selected ? colors.text : colors.inactive}
      />
      <Text style={{ ...typeScale.body, flex: 1, fontWeight: selected ? "600" : "400" }}>
        {label}
      </Text>
      {count === undefined ? null : (
        <Text
          style={{
            ...typeScale.meta,
            minWidth: 48,
            textAlign: "right",
            color: selected ? colors.text : colors.secondary,
          }}
        >
          {formatNumber(count)}
        </Text>
      )}
    </Press>
  );
}

/** A white 48dp button with 12dp corners: a sheet's or a screen's main action. */
export function FilledButton({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
}) {
  return (
    <Press
      label={label}
      onPress={onPress}
      style={{
        flexGrow: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight: 48,
        paddingHorizontal: 20,
        borderRadius: 12,
        backgroundColor: colors.text,
      }}
    >
      {icon ? <Icon name={icon} size={22} color={colors.background} /> : null}
      <Text style={{ ...typeScale.label, fontSize: 15, color: colors.background }}>{label}</Text>
    </Press>
  );
}

/** An outlined 48dp button; `iconOnly` makes it a square icon button named by `label`. */
export function OutlinedButton({
  label,
  icon,
  onPress,
  iconOnly = false,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  iconOnly?: boolean;
}) {
  return (
    <Press
      label={label}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight: 48,
        minWidth: 48,
        paddingHorizontal: iconOnly ? 0 : 20,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: outline,
      }}
    >
      {icon ? <Icon name={icon} size={20} /> : null}
      {iconOnly ? null : (
        <Text style={{ ...typeScale.label, fontSize: 15, fontWeight: "500" }}>{label}</Text>
      )}
    </Press>
  );
}

/** A bold text button with a 48dp target: Reset, Retry, Settings, Try again. */
export function TextButton({
  label,
  onPress,
  size = 14,
}: {
  label: string;
  onPress: () => void;
  size?: number;
}) {
  return (
    <Press
      label={label}
      onPress={onPress}
      style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 12 }}
    >
      <Text style={{ ...typeScale.label, fontSize: size, fontWeight: size > 14 ? "500" : "700" }}>
        {label}
      </Text>
    </Press>
  );
}

/** A trailing 48dp icon action in a list row's lane. */
export function RowAction({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Press
      label={label}
      onPress={onPress}
      style={{
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={icon} color={colors.secondary} />
    </Press>
  );
}

/**
 * Artwork, or the dark fill a missing image leaves, with the title's name on it when `name`.
 * Hidden from TalkBack: the row or poster it sits in names the title.
 */
export function Artwork({
  url,
  width,
  height,
  radius,
  name,
}: {
  url: string | null;
  width?: number;
  height: number;
  radius: number;
  name?: string;
}) {
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      style={{
        width,
        height,
        borderRadius: radius,
        overflow: "hidden",
        backgroundColor: placeholder,
        alignItems: "center",
        justifyContent: "center",
        padding: url ? 0 : 8,
      }}
    >
      {url ? (
        <Image source={{ uri: url }} resizeMode="cover" style={{ width: "100%", height: "100%" }} />
      ) : name ? (
        <Text
          numberOfLines={4}
          style={{
            ...typeScale.small,
            color: "rgba(255, 255, 255, 0.56)",
            lineHeight: 17,
            fontWeight: "600",
            textAlign: "center",
          }}
        >
          {name}
        </Text>
      ) : null}
    </View>
  );
}

/** A 2:3 poster with the title and its year under it, opening the title. */
export function Poster({
  title,
  width,
  onPress,
}: {
  title: Title;
  width: number;
  onPress: () => void;
}) {
  return (
    <Press label={title.title} onPress={onPress} style={{ width }}>
      <Artwork
        url={title.posterUrl}
        height={Math.round(width * 1.5)}
        radius={8}
        name={title.title}
      />
      <Text
        numberOfLines={2}
        style={{ ...typeScale.small, color: colors.text, lineHeight: 17, paddingTop: 6 }}
      >
        {title.title}
      </Text>
      {title.year ? (
        <Text style={{ ...typeScale.small, fontSize: 12, lineHeight: 16 }}>
          {formatNumber(title.year)}
        </Text>
      ) : null}
    </Press>
  );
}

/**
 * A screen's recovery or empty state, left-aligned in the space under its bars: an icon, one line
 * and the action that recovers. Still, with no motion.
 */
export function Recovery({
  icon,
  message,
  action,
}: {
  icon?: IconName;
  message: string;
  action?: ReactNode;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flex: 1,
        alignItems: "flex-start",
        justifyContent: "center",
        gap: 16,
        paddingHorizontal: 24,
        paddingBottom: 64,
      }}
    >
      {icon ? <Icon name={icon} size={32} color={colors.secondary} /> : null}
      <Text style={typeScale.message}>{message}</Text>
      {action}
    </View>
  );
}

/** A line docked above the navigation bar while a list is stale, with its two actions under it. */
export function StatusLine({ message, actions }: { message: string; actions: ReactNode }) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        gap: 4,
        paddingTop: 12,
        paddingLeft: 16,
        paddingRight: 4,
        paddingBottom: 4,
        borderTopWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: colors.background,
      }}
    >
      <Text style={{ ...typeScale.meta, color: colors.text, lineHeight: 20, paddingRight: 12 }}>
        {message}
      </Text>
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>{actions}</View>
    </View>
  );
}
