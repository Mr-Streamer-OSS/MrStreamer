import type { ListedChannel } from "@mrstreamer/core/catalogue/variants";
import { SymbolView } from "expo-symbols";
import type { Channel } from "./library.ts";
import { memo, type ReactNode } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type AccessibilityActionEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useArtwork } from "./artwork-cache.ts";
import type { Failure } from "./errors.ts";

// Plain true-black content: rows, logos, lines of text and the one text button. No glass here.

export const colors = { text: "#FFFFFF", dim: "#A1A1A6", fill: "#1C1C1E", line: "#2C2C2E" };

/** A row's height, which grows with Dynamic Type so lists can still measure rows up front. */
export function useRowHeight(): number {
  const { fontScale } = useWindowDimensions();
  return Math.round(Math.max(60, 24 + 38 * fontScale));
}

/** Accessibility text sizes (iOS's AX1 is 1.786), which need wider windows and taller rows. */
export const largeText = (fontScale: number) => fontScale >= 1.5;

/**
 * Whether Live shows its list and a detail column side by side, from the window's width alone:
 * 700 points, or 1000 at accessibility text sizes. Never the device, screen or orientation, so an
 * iPhone, a Duo's outer display, its inner one in portrait and an iPad's half-width window keep
 * the iPhone's layout, and a resize or fold crosses it as the width does.
 */
export function splitAt(width: number, fontScale: number): boolean {
  return width >= (largeText(fontScale) ? 1000 : 700);
}

/**
 * Live's list column, as wide as the window when compact. Beside the detail column it is 456
 * points in a Duo's inner landscape window (951), 468 in an iPad's portrait one (1032) and 520
 * from an iPad's landscape one (1376); `gutter` is the detail column's side margin there.
 */
export function useListWidth(): {
  readonly split: boolean;
  readonly width: number;
  readonly gutter: number;
} {
  const { width, fontScale } = useWindowDimensions();
  const split = splitAt(width, fontScale);
  if (!split) return { split, width, gutter: 16 };
  const gutter = width >= 1200 ? 32 : width >= 1000 ? 24 : 20;
  return { split, width: Math.min(520, Math.floor(314 + width * 0.15)), gutter };
}

/** What a ChannelRow's Schedule and star add under its lines at large text: 44 point targets, 4 above. */
export const stackedActions = 48;

/** "VRT 1" as "V1", "Channel 4" as "C4": the stand-in for a channel without a logo. */
function monogram(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.map((word) => word[0]).join("") : title;
  return letters.slice(0, 3).toUpperCase();
}

/**
 * The channel's logo as its provider lists it, on a dark tile so dark and transparent logos still
 * read, or its monogram when it has none or the logo doesn't load. The tile stays empty while the
 * logo is fetched (artwork-cache.ts).
 */
export function ChannelLogo({
  channel,
  style,
  large = false,
}: {
  channel: Pick<ListedChannel, "title" | "logoUrl">;
  style?: StyleProp<ViewStyle>;
  /** A tile, not a row's mark: the monogram larger. */
  large?: boolean;
}) {
  const logo = useArtwork(channel.logoUrl);
  return (
    <View style={[styles.mark, style]}>
      {logo.kind === "shown" ? (
        <Image
          source={{ uri: logo.uri }}
          style={styles.logo}
          resizeMode="contain"
          onError={logo.broke}
          accessibilityIgnoresInvertColors
        />
      ) : logo.kind === "pending" ? null : (
        <Text
          style={[styles.markText, large && styles.markLarge]}
          allowFontScaling={false}
          numberOfLines={1}
        >
          {monogram(channel.title)}
        </Text>
      )}
    </View>
  );
}

/**
 * A channel as a row that plays it when pressed. With `onFavourite`, a star at its end stars or
 * unstars it without playing, which VoiceOver offers as the row's action.
 */
export const ChannelRow = memo(function ChannelRow({
  channel,
  detail,
  status,
  height,
  onPress,
  favourite = false,
  onFavourite,
  programme,
  programmeHint,
  providerLabel,
  onSchedule,
  selected,
}: {
  channel: Channel;
  detail: string;
  programme?: ReactNode;
  programmeHint?: string;
  providerLabel?: string | undefined;
  onSchedule?: ((channel: Channel) => void) | undefined;
  /**
   * In Live's list beside the detail column, whether its Schedule shows there. Left out
   * elsewhere; rows in the column are inset from its edges, so the chosen one's fill is too.
   */
  selected?: boolean | undefined;
  /** How the channel stands while it is the one playing (`channelStatus`), in place of `detail`. */
  status: string | null;
  height: number;
  onPress: (channel: Channel) => void;
  favourite?: boolean;
  onFavourite?: ((channel: Channel, favourite: boolean) => void) | undefined;
}) {
  const tags = channel.tags.join(" ");
  const star = favourite ? "Remove from Favourites" : "Add to Favourites";
  // At large text, Schedule and the star go under the lines, so the name keeps the row's width.
  const stacked = largeText(useWindowDimensions().fontScale) && Boolean(onSchedule ?? onFavourite);
  return (
    <View
      style={[
        styles.row,
        { height },
        onFavourite && styles.starred,
        stacked && styles.stacked,
        selected !== undefined && styles.inset,
        selected && styles.selected,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          channel.title,
          providerLabel,
          favourite && "favourite",
          programmeHint,
          status?.toLowerCase(),
        ]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint={programmeHint ? undefined : detail}
        {...(onFavourite
          ? {
              accessibilityActions: [{ name: "activate" }, { name: "favourite", label: star }],
              onAccessibilityAction: ({ nativeEvent }: AccessibilityActionEvent) => {
                if (nativeEvent.actionName === "activate") onPress(channel);
                if (nativeEvent.actionName === "favourite") onFavourite(channel, !favourite);
              },
            }
          : {})}
        accessibilityState={{ selected }}
        onPress={() => onPress(channel)}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        testID={`channel-${channel.key}`}
      >
        <ChannelLogo channel={channel} style={styles.rowMark} />
        <View style={styles.names}>
          <Text style={styles.title} numberOfLines={1}>
            {channel.title}
            {tags ? <Text style={styles.tags}>{`  ${tags}`}</Text> : null}
          </Text>
          {programme ?? (
            <Text style={styles.detail} numberOfLines={1}>
              {status ?? detail}
            </Text>
          )}
          {programme && status ? <Text style={styles.detail}>{status}</Text> : null}
        </View>
      </Pressable>
      <View style={[styles.actions, stacked && styles.under]}>
        {onSchedule ? (
          <TextButton
            label="Schedule"
            accessibilityLabel={[`Schedule for ${channel.title}`, providerLabel]
              .filter(Boolean)
              .join(", ")}
            onPress={() => onSchedule(channel)}
            testID={`schedule-${channel.key}`}
          />
        ) : null}
        {onFavourite ? (
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            accessibilityLabel={star}
            onPress={() => onFavourite(channel, !favourite)}
            style={({ pressed }) => [styles.star, pressed && styles.pressed]}
            testID={`star-${channel.key}`}
          >
            <SymbolView
              name={favourite ? "star.fill" : "star"}
              size={stacked ? 28 : 18}
              tintColor={colors.text}
              weight="semibold"
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

/** A line of text where a screen has nothing else, with an optional action under it. */
export function Message({
  text,
  action,
}: {
  text: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.message}>
      <Text style={styles.messageText}>{text}</Text>
      {action ? <TextButton {...action} /> : null}
    </View>
  );
}

/**
 * What went wrong or why a screen is empty, in a line or two, with what the viewer can do about
 * it. White headline, the advice under it, the actions as text buttons.
 */
export function Notice({
  failure,
  actions = [],
}: {
  failure: Failure;
  actions?: readonly { label: string; onPress: () => void }[];
}) {
  return (
    <View style={styles.message}>
      <View accessible accessibilityLiveRegion="polite">
        <Text style={styles.headline} accessibilityRole="header">
          {failure.headline}
        </Text>
        {failure.advice ? <Text style={styles.messageText}>{failure.advice}</Text> : null}
      </View>
      {actions.map((action) => (
        <TextButton key={action.label} {...action} />
      ))}
    </View>
  );
}

export function TextButton({
  label,
  onPress,
  disabled,
  destructive,
  testID,
  accessibilityLabel,
  primary,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
  testID?: string;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled ?? false }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.textButton,
        primary && styles.primaryButton,
        (pressed || disabled) && styles.pressed,
      ]}
      testID={testID}
    >
      <Text
        style={[
          styles.textButtonLabel,
          primary && styles.primaryLabel,
          destructive && styles.destructive,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16 },
  starred: { paddingRight: 4 },
  stacked: { flexDirection: "column", alignItems: "stretch", gap: 4, paddingVertical: 8 },
  inset: { marginHorizontal: 8, paddingLeft: 8, borderRadius: 10 },
  selected: { backgroundColor: colors.fill },
  actions: { flexDirection: "row", alignItems: "center" },
  under: { alignSelf: "flex-end", gap: 8 },
  main: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, alignSelf: "stretch" },
  star: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.5 },
  mark: {
    borderRadius: 6,
    backgroundColor: colors.fill,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  rowMark: { width: 56, height: 36 },
  logo: { position: "absolute", top: "10%", left: "8%", right: "8%", bottom: "10%" },
  markText: { color: colors.text, fontSize: 11, fontWeight: "700" },
  markLarge: { fontSize: 20 },
  names: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17 },
  tags: { color: colors.dim, fontSize: 13 },
  detail: { color: colors.dim, fontSize: 13, marginTop: 2 },
  message: { padding: 24, gap: 12, alignItems: "flex-start" },
  messageText: { color: colors.dim, fontSize: 15, marginTop: 4 },
  headline: { color: colors.text, fontSize: 17, fontWeight: "600" },
  textButton: { minHeight: 44, justifyContent: "center" },
  textButtonLabel: { color: colors.text, fontSize: 17, fontWeight: "600" },
  primaryButton: {
    minHeight: 52,
    borderRadius: 10,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
  },
  primaryLabel: { color: "#000000" },
  destructive: { color: "#FF453A" },
});
