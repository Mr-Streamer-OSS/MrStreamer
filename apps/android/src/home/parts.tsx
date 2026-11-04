import type { ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { formatNumber } from "@mrstreamer/core/i18n";
import { Artwork, Icon, typeScale } from "../library/parts.tsx";
import { RED } from "../live/chrome.tsx";
import { useKeyboardFocus } from "../ui/focus.ts";
import type { IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";

// Home's pieces of Paper A's "Android Home and viewing" page, built on the library's and Live's
// parts: shelf headings, channel and title tiles, the rows shelves become at 200% text, the still
// loading shapes, the failed-provider notice and the hold sheet's header and rows.

/** The empty track under a progress fill, a step above a poster's placeholder. */
const TRACK = "#3A3A3A";

/** Live's thinner programme track. */
const PROGRAMME_TRACK = "#262626";

/** A tile's 120dp width and its 10dp gap, as every Home shelf lays them out on phones. */
export const TILE = 120;
const TILE_GAP = 10;

/** One TalkBack action of a tile or row, and what it does. */
export interface Action {
  readonly name: string;
  readonly label: string;
  readonly run: () => void;
}

/**
 * A pressable that names itself for TalkBack by `label` and offers `actions` in its actions
 * menu. Holding it runs `onHold`. Android's ripple and the keyboard's focus mark, as `Press`.
 */
export function Tappable({
  label,
  onPress,
  onHold,
  actions = [],
  style,
  children,
}: {
  label: string;
  onPress: () => void;
  onHold?: (() => void) | undefined;
  actions?: readonly Action[];
  style?: ViewStyle;
  children: ReactNode;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityActions={actions.map(({ name, label }) => ({ name, label }))}
      onAccessibilityAction={({ nativeEvent }) =>
        actions.find((action) => action.name === nativeEvent.actionName)?.run()
      }
      onPress={onPress}
      onLongPress={onHold}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{ ...style, ...(focused ? { backgroundColor: colors.focus } : null) }}
    >
      {children}
    </Pressable>
  );
}

/** How far something got, as a white fill over its track; Paper A's 3dp on posters. */
export function Progress({
  done,
  height = 3,
  track = TRACK,
}: {
  done: number | null;
  height?: number;
  track?: string;
}) {
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      style={{
        height,
        borderRadius: height === 2 ? 0 : 2,
        backgroundColor: done === null ? undefined : track,
        overflow: "hidden",
      }}
    >
      {done === null ? null : (
        <View
          style={{
            width: `${Math.round(Math.min(1, Math.max(0, done)) * 100)}%`,
            height,
            backgroundColor: colors.text,
          }}
        />
      )}
    </View>
  );
}

/**
 * A shelf's 48dp heading: its 20sp title, the full count after it, and a chevron when it opens a
 * screen. At 200% text it grows to 64dp with 12dp above, as Paper's large-text frame.
 */
export function ShelfHeading({
  title,
  count,
  inset,
  large,
  onOpen,
}: {
  title: string;
  count?: number | undefined;
  inset: number;
  large: boolean;
  onOpen?: (() => void) | undefined;
}) {
  const content = (
    <>
      <Text
        accessibilityRole="header"
        style={{ ...typeScale.section, letterSpacing: -0.2, flexShrink: 1 }}
      >
        {title}
      </Text>
      <Text style={{ ...typeScale.meta, flex: 1 }}>
        {count === undefined ? "" : formatNumber(count)}
      </Text>
      {onOpen ? (
        <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}>
          <Icon name="chevron-right" color={colors.secondary} />
        </View>
      ) : null}
    </>
  );

  const style: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: large ? 12 : 8,
    minHeight: large ? 64 : 48,
    paddingTop: large ? 12 : 0,
    paddingLeft: inset,
    paddingRight: 4,
  };

  return onOpen ? (
    <Tappable
      label={count === undefined ? title : `${title}, ${formatNumber(count)}`}
      onPress={onOpen}
      style={style}
    >
      {content}
    </Tappable>
  ) : (
    <View style={style}>{content}</View>
  );
}

/** A shelf's tiles in one sideways row on the heading's inset, 10dp apart. */
export function Shelf({ inset, children }: { inset: number; children: ReactNode }) {
  return (
    <View style={{ overflow: "hidden" }}>
      <View
        style={{ flexDirection: "row", gap: TILE_GAP, paddingLeft: inset, paddingRight: inset }}
      >
        {children}
      </View>
    </View>
  );
}

/** Up to two initials for a channel, as Live's badges show them. */
function initials(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const [first, second] = words.map((word) => Array.from(word));

  return (second ? [first?.[0], second[0]] : (first ?? []).slice(0, 2))
    .join("")
    .toLocaleUpperCase();
}

/** A favourite channel's tile: its initials on a 68dp block, its name and what's on under it. */
export function ChannelTile({
  title,
  detail,
  onPress,
  onHold,
  actions,
}: {
  title: string;
  detail: string | undefined;
  onPress: () => void;
  onHold: () => void;
  actions: readonly Action[];
}) {
  return (
    <Tappable
      label={detail ? `${title}, ${detail}` : title}
      onPress={onPress}
      onHold={onHold}
      actions={actions}
      style={{ width: TILE }}
    >
      <View
        importantForAccessibility="no-hide-descendants"
        style={{
          height: 68,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface,
        }}
      >
        <Text style={{ ...typeScale.label, fontSize: 15, lineHeight: 20 }}>{initials(title)}</Text>
      </View>
      <Text
        numberOfLines={2}
        style={{ ...typeScale.small, color: colors.text, lineHeight: 17, paddingTop: 6 }}
      >
        {title}
      </Text>
      {detail ? (
        <Text numberOfLines={1} style={{ ...typeScale.small, fontSize: 12, lineHeight: 16 }}>
          {detail}
        </Text>
      ) : null}
    </Tappable>
  );
}

/**
 * A title's 2:3 tile: its poster, a 3dp progress bar when `done` is given (a blank lane when
 * it is null, so names line up), its name and its line.
 */
export function TitleTile({
  name,
  url,
  line,
  done,
  label,
  onPress,
  onHold,
  actions,
}: {
  name: string;
  url: string | null;
  line: string;
  done?: number | null | undefined;
  label: string;
  onPress: () => void;
  onHold?: () => void;
  actions?: readonly Action[];
}) {
  return (
    <Tappable
      label={label}
      onPress={onPress}
      onHold={onHold}
      actions={actions ?? []}
      style={{ width: TILE }}
    >
      <Artwork url={url} width={TILE} height={TILE * 1.5} radius={8} name={name} />
      {done === undefined ? null : (
        <View style={{ marginTop: 6 }}>
          <Progress done={done} />
        </View>
      )}
      <Text
        numberOfLines={2}
        style={{ ...typeScale.small, color: colors.text, lineHeight: 17, paddingTop: 6 }}
      >
        {name}
      </Text>
      {line ? (
        <Text numberOfLines={1} style={{ ...typeScale.small, fontSize: 12, lineHeight: 16 }}>
          {line}
        </Text>
      ) : null}
    </Tappable>
  );
}

/**
 * What a shelf becomes at 200% text: one row per title with a 64x96dp poster and the full name
 * beside it, never cut short, and the progress bar under the line.
 */
export function TitleRow({
  name,
  url,
  line,
  done,
  label,
  onPress,
  onHold,
  actions,
}: Parameters<typeof TitleTile>[0]) {
  return (
    <Tappable
      label={label}
      onPress={onPress}
      onHold={onHold}
      actions={actions ?? []}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 16,
        paddingVertical: 12,
        paddingHorizontal: 16,
      }}
    >
      <Artwork url={url} width={64} height={96} radius={8} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={{ ...typeScale.label, fontWeight: "500" }}>{name}</Text>
        {line ? <Text style={{ ...typeScale.small, lineHeight: 17 }}>{line}</Text> : null}
        {done === undefined || done === null ? null : (
          <View style={{ marginTop: 6 }}>
            <Progress done={done} height={4} />
          </View>
        )}
      </View>
    </Tappable>
  );
}

/** A channel's 72dp On now row: initials, name, programme and its progress, then the star. */
export function ChannelLine({
  title,
  programme,
  done,
  label,
  onPress,
  onHold,
  actions,
  trailing,
}: {
  title: string;
  programme: string;
  done: number | null;
  label: string;
  onPress: () => void;
  onHold: () => void;
  actions: readonly Action[];
  trailing: ReactNode;
}) {
  return (
    <Tappable
      label={label}
      onPress={onPress}
      onHold={onHold}
      actions={actions}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 72,
        paddingLeft: 16,
      }}
    >
      <View
        importantForAccessibility="no-hide-descendants"
        style={{
          width: 48,
          height: 36,
          borderRadius: 4,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface,
        }}
      >
        <Text style={{ ...typeScale.label, fontSize: 12, lineHeight: 16 }}>{initials(title)}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4, paddingVertical: 12 }}>
        <Text style={{ ...typeScale.body, fontWeight: "500", lineHeight: 20 }}>{title}</Text>
        <Text numberOfLines={1} style={typeScale.meta}>
          {programme}
        </Text>
        {done === null ? null : <Progress done={done} height={2} track={PROGRAMME_TRACK} />}
      </View>
      <View importantForAccessibility="no-hide-descendants">{trailing}</View>
    </Tappable>
  );
}

/** A still #141414 block standing in for what hasn't loaded. It never shimmers or pulses. */
export function Still({
  width,
  height,
  radius = 4,
}: {
  width?: number;
  height: number;
  radius?: number;
}) {
  return (
    <View
      style={{
        width,
        height,
        flexShrink: 0,
        borderRadius: radius,
        backgroundColor: colors.surface,
      }}
    />
  );
}

/** Still shapes in the On now rows' lanes while channels load. */
export function StillChannels() {
  return (
    <View importantForAccessibility="no-hide-descendants">
      {(
        [
          [120, 180],
          [96, 200],
          [132, 160],
        ] as const
      ).map(([name, line], index) => (
        <View
          key={index}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 16,
            height: 72,
            paddingLeft: 16,
            paddingRight: 68,
          }}
        >
          <Still width={48} height={36} />
          <View style={{ flex: 1, gap: 8 }}>
            <Still width={name} height={16} />
            <Still width={line} height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Still tiles in a shelf's lane: channel blocks or posters. */
export function StillTiles({ inset, height }: { inset: number; height: number }) {
  return (
    <View importantForAccessibility="no-hide-descendants">
      <Shelf inset={inset}>
        {[0, 1, 2, 3].map((index) => (
          <Still key={index} width={TILE} height={height} radius={8} />
        ))}
      </Shelf>
    </View>
  );
}

/**
 * A provider that failed, inline under On now: a red mark, what failed and its two ways forward.
 * Its buttons drop under the line when the text needs the width.
 */
export function Notice({ message, actions }: { message: string; actions: ReactNode }) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        marginTop: 8,
        paddingVertical: 4,
        paddingLeft: 16,
        paddingRight: 4,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: colors.hairline,
      }}
    >
      <Icon name="error-outline" size={20} color={RED} />
      <Text style={{ ...typeScale.meta, color: colors.text, flex: 1, minWidth: 160 }}>
        {message}
      </Text>
      <View style={{ flexDirection: "row" }}>{actions}</View>
    </View>
  );
}

/**
 * A line docked above the navigation bar: what loads (a still sync mark) or what a write did,
 * with its one action. Paper A's status line: 56dp, a hairline above.
 */
export function DockedLine({
  icon,
  failed = false,
  message,
  action,
}: {
  icon: IconName;
  failed?: boolean;
  message: string;
  action?: ReactNode;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        minHeight: 56,
        paddingVertical: 4,
        paddingLeft: 16,
        paddingRight: action ? 4 : 16,
        borderTopWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: colors.background,
      }}
    >
      <Icon name={icon} size={20} color={failed ? RED : colors.secondary} />
      <Text style={{ ...typeScale.meta, color: colors.text, flex: 1, minWidth: 160 }}>
        {message}
      </Text>
      {action}
    </View>
  );
}

/** The hold sheet's header: the title's poster, its name, and up to two grey lines. */
export function SheetHeader({
  name,
  url,
  lines,
}: {
  name: string;
  url: string | null;
  lines: readonly string[];
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        paddingBottom: 12,
        paddingHorizontal: 24,
        borderBottomWidth: 1,
        borderColor: PROGRAMME_TRACK,
      }}
    >
      <Artwork url={url} width={48} height={72} radius={6} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          accessibilityRole="header"
          style={{ ...typeScale.body, fontWeight: "700", lineHeight: 20 }}
        >
          {name}
        </Text>
        {lines.map((line) => (
          <Text key={line} style={typeScale.meta}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** A hold sheet's 56dp action; `danger` sets a removal in red. */
export function SheetAction({
  icon,
  label,
  danger = false,
  onPress,
}: {
  icon: IconName;
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  const color = danger ? RED : colors.text;

  return (
    <Tappable
      label={label}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 56,
        paddingHorizontal: 24,
      }}
    >
      <Icon name={icon} color={color} />
      <Text style={{ ...typeScale.body, color, flex: 1, lineHeight: 20 }}>{label}</Text>
    </Tappable>
  );
}
