import type { Download } from "@mrstreamer/contracts/downloads";
import { formatBytes } from "@mrstreamer/core/i18n";
import { runtime, timeLeftOf } from "@mrstreamer/core/viewing/continue";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { memo, useMemo } from "react";
import {
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type AccessibilityActionEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  actionsOf,
  episodeLine,
  statusLine,
  transferred,
  showActions,
  waitingTurn,
} from "./download-controls.tsx";
import { playDownload, useDownloads } from "./downloads.ts";
import { Glass } from "./glass.tsx";
import { useLocale } from "./i18n/catalogue.ts";
import { t } from "./i18n/downloads.ts";
import { Swipe } from "./swipe.tsx";
import { Artwork } from "./titles-ui.tsx";
import { colors, Notice } from "./ui.tsx";

// Downloads as one list: the queue in its order, then the copies on this iPhone, newest
// first, as the desktop's page. Empty sections are left out; how much the copies take and what is
// free closes the list. Each row has one trailing glass button for what fits its state, Pause or
// Resume in the queue, the rest in its long-press sheet, a swipe to the left and VoiceOver's
// actions; there, one waiting its turn also moves a place up or down among the others. A copy
// plays offline when its row is tapped; queue rows don't answer a tap, so a stray touch changes
// nothing.
// Home pushes it with providers saved, and Connect without any, as copies play with none.

/** A finished copy, or one whose file went, rather than something in the queue. */
const onPhone = (item: Download) =>
  item.status.kind === "complete" || item.status.kind === "missing";

interface Section {
  readonly key: "queue" | "copies";
  readonly data: readonly Download[];
}

/** A section's heading, said in the interface language as it draws. */
const heading = (key: Section["key"]) => (key === "queue" ? t("Queue") : t("On this iPhone"));

export function DownloadsScreen() {
  // Drawn again in a new language where it stands; the queue and its order are left as they are.
  const locale = useLocale();
  const list = useDownloads();
  const sections = useMemo(
    () =>
      (
        [
          { key: "queue", data: list.items.filter((item) => !onPhone(item)) },
          { key: "copies", data: list.items.filter(onPhone) },
        ] satisfies readonly Section[]
      ).filter((section) => section.data.length > 0),
    [list.items],
  );
  // Those waiting their turn, in order: Move leaves out the first's up and the last's down.
  const line = useMemo(() => list.items.filter(waitingTurn), [list.items]);
  const storage = [
    list.bytes > 0 ? t("{size} on this iPhone", { size: formatBytes(list.bytes) }) : null,
    list.free !== null ? t("{size} free", { size: formatBytes(list.free) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SectionList<Download, Section>
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      sections={sections}
      keyExtractor={(item) => item.id}
      extraData={locale}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <Text style={styles.section} accessibilityRole="header">
          {heading(section.key)}
        </Text>
      )}
      renderSectionFooter={({ section }) =>
        section.key === "queue" ? (
          <Text style={styles.note}>
            {t("A download continues in the background; the next starts once the app is open.")}
          </Text>
        ) : null
      }
      renderItem={({ item }) => (
        <Row item={item} first={line[0] === item} last={line.at(-1) === item} />
      )}
      ItemSeparatorComponent={Separator}
      ListEmptyComponent={
        <Notice
          failure={{
            headline: t("Nothing downloaded yet."),
            advice: t("Download a movie or an episode from its details."),
          }}
        />
      }
      {...(sections.length > 0 && storage
        ? { ListFooterComponent: <Text style={styles.note}>{storage}</Text> }
        : {})}
      contentContainerStyle={styles.content}
      testID="downloads"
    />
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

/**
 * The trailing button's symbol and its test id's English word for the first action of each
 * state. VoiceOver leaves the button out: the row offers the same as its first action.
 */
const PRIMARY: Record<Download["status"]["kind"], { symbol: SFSymbol; label: string }> = {
  queued: { symbol: "pause.fill", label: "Pause" },
  waiting: { symbol: "pause.fill", label: "Pause" },
  paused: { symbol: "arrow.down", label: "Resume" },
  transferring: { symbol: "pause.fill", label: "Pause" },
  failed: { symbol: "arrow.clockwise", label: "Retry" },
  complete: { symbol: "play.fill", label: "Play offline" },
  missing: { symbol: "trash", label: "Delete download" },
};

/** What a swipe to the left reveals: the state's destructive action, in a word. */
const SWIPED = {
  queued: "Cancel",
  waiting: "Cancel",
  paused: "Cancel",
  transferring: "Cancel",
  failed: "Remove",
  complete: "Delete",
  missing: "Delete",
} as const satisfies Record<Download["status"]["kind"], string>;

const Row = memo(function Row({
  item,
  first,
  last,
}: {
  item: Download;
  /** Whether it is the first, or last, of the downloads waiting their turn. */
  first: boolean;
  last: boolean;
}) {
  const { fontScale } = useWindowDimensions();
  // A row draws again by itself in a new language, as the list keeps its rows.
  useLocale();
  const { status } = item;
  const copy = onPhone(item);
  const actions = actionsOf(item, { first, last });
  const destructive = actions.find((action) => action.destructive);
  const sized = [
    copy && item.duration ? runtime(item.duration) : null,
    item.size ? formatBytes(item.size) : null,
  ];
  const facts = [episodeLine(item) ?? item.year, ...sized].filter(Boolean).join(" · ");
  const line = statusLine(item);
  const done = transferred(item);
  const watched =
    status.kind === "complete" &&
    item.progress &&
    item.progress.duration > 0 &&
    !isFinished(item.progress.position, item.progress.duration)
      ? item.progress
      : null;
  const left = watched ? timeLeftOf({ ...watched, finished: false }) : null;
  const kept = copy && !item.subscription ? t("Provider removed, copy kept") : null;
  const red = status.kind === "failed" || status.kind === "missing";
  const primary = PRIMARY[status.kind];
  // One element for VoiceOver: "Paper Harbor, season 1 episode 3, The Tide Table, 42%, ...".
  const spoken = [
    item.name,
    spokenEpisode(item),
    item.title.kind === "movie" ? item.year : item.episodeName,
    ...sized,
    line.replaceAll(" · ", ", "),
    left,
    kept,
  ]
    .filter(Boolean)
    .join(", ");
  const act = (event: AccessibilityActionEvent) => {
    const { actionName } = event.nativeEvent;
    if (actionName === "activate") {
      if (status.kind === "complete") playDownload(item.id);
      return;
    }
    actions.find((action) => action.name === actionName)?.run();
  };
  return (
    <Swipe label={t(SWIPED[status.kind])} action={destructive} testID="download-swiped">
      <Pressable
        accessible
        accessibilityLabel={spoken}
        {...(status.kind === "complete" ? { accessibilityRole: "button" as const } : {})}
        accessibilityActions={[
          ...(status.kind === "complete" ? [{ name: "activate" }] : []),
          ...actions.map((action) => ({ name: action.name, label: action.label })),
        ]}
        onAccessibilityAction={act}
        // A queue row doesn't answer a tap: only its button and sheet change it.
        {...(status.kind === "complete" ? { onPress: () => playDownload(item.id) } : {})}
        onLongPress={() => showActions(item, actions)}
        style={({ pressed }) => [
          styles.row,
          fontScale > 1.2 && styles.top,
          pressed && status.kind === "complete" && styles.pressed,
        ]}
        testID={`download-${item.id}`}
      >
        <Artwork url={item.posterUrl} name={item.name} width={154} style={styles.poster} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={2}>
            {item.name}
          </Text>
          {facts ? (
            <Text style={styles.facts} numberOfLines={2}>
              {facts}
            </Text>
          ) : null}
          {done !== null ? <Bar done={done} style={styles.transfer} /> : null}
          {watched ? (
            <View style={styles.progress}>
              <Bar done={watched.position / watched.duration} style={styles.watched} />
              {left ? <Text style={styles.dim}>{left}</Text> : null}
            </View>
          ) : null}
          {line ? (
            <Text
              style={[styles.status, red && styles.red, status.kind === "queued" && styles.dim]}
            >
              {line}
            </Text>
          ) : null}
          {kept ? <Text style={styles.dim}>{kept}</Text> : null}
        </View>
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => actions[0]?.run()}
          style={({ pressed }) => [styles.target, pressed && styles.pressed]}
          testID={`download-${item.id}-${primary.label}`}
        >
          <Glass style={styles.circle}>
            <SymbolView
              name={primary.symbol}
              size={15}
              tintColor={red ? "#FF453A" : "#FFFFFF"}
              weight="semibold"
            />
          </Glass>
        </Pressable>
      </Pressable>
    </Swipe>
  );
});

/** "season 1 episode 3", or "special 3", as VoiceOver says an episode. */
function spokenEpisode({ title }: Download): string | null {
  if (title.kind !== "episode") return null;
  return title.season === 0
    ? t("special {episode}", { episode: title.episode })
    : t("season {season} episode {episode}", { season: title.season, episode: title.episode });
}

/** A still line of how far something got. */
function Bar({ done, style }: { done: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.bar, style]}>
      <View style={[styles.barDone, { width: `${Math.min(100, Math.round(done * 100))}%` }]} />
    </View>
  );
}

/**
 * The row Settings and Connect open Downloads with: its name, what the copies take ("None"
 * without any) and a chevron.
 */
export function DownloadsLink({ onPress }: { onPress: () => void }) {
  useLocale();
  const { bytes } = useDownloads();
  const used = bytes > 0 ? formatBytes(bytes) : t("None");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Downloads, {status}", { status: used })}
      onPress={onPress}
      style={({ pressed }) => [styles.link, pressed && styles.pressed]}
      testID="downloads-link"
    >
      <Text style={styles.linkLabel}>{t("Downloads")}</Text>
      <View style={styles.linkValue}>
        <Text style={styles.linkUsed}>{used}</Text>
        <SymbolView name="chevron.right" size={14} tintColor={colors.dim} weight="semibold" />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { paddingBottom: 32 },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 6,
  },
  note: { color: colors.dim, fontSize: 13, paddingHorizontal: 16, paddingTop: 8 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 72 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  top: { alignItems: "flex-start" },
  pressed: { opacity: 0.5 },
  poster: { width: 44, height: 66, borderRadius: 6 },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  facts: { color: colors.dim, fontSize: 15 },
  status: { color: colors.text, fontSize: 15, fontVariant: ["tabular-nums"] },
  red: { color: "#FF453A" },
  dim: { color: colors.dim, fontSize: 13 },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: "hidden" },
  barDone: { height: 4, backgroundColor: "#FFFFFF" },
  transfer: { marginTop: 6, marginBottom: 4 },
  progress: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  watched: { width: 72 },
  target: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  circle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  link: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 44,
    paddingVertical: 10,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  linkLabel: { color: colors.text, fontSize: 17, flexShrink: 1 },
  linkValue: { flexDirection: "row", alignItems: "center", gap: 6 },
  linkUsed: { color: colors.dim, fontSize: 17 },
});
