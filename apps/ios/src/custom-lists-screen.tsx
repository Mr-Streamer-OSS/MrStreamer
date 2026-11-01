import { formatNumber } from "@mrstreamer/core/i18n";
import { normalize } from "@mrstreamer/core/text";
import { router, useIsFocused } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import {
  AccessibilityInfo,
  ActionSheetIOS,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type AccessibilityActionEvent,
} from "react-native";
import type { AppError } from "@mrstreamer/contracts/errors";
import { currentCatalogue, playChannel, useCatalogue } from "./account.ts";
import {
  arrangeList,
  createList,
  currentChannelLists,
  listsHolding,
  deleteList,
  removeMember,
  renameList,
  setMember,
  useChannelLists,
  type ChannelList,
  type ListEntry,
} from "./custom-lists.ts";
import { appError, describeError } from "./errors.ts";
import { NO_SHORTCUTS, useShortcuts, type Shortcut } from "./key-commands.ts";
import type { Unavailable } from "./favourites.ts";
import { useLocale } from "./i18n/catalogue.ts";
import { t } from "./i18n/live.ts";
import type { Channel } from "./library.ts";
import { useDockInset } from "./loading.tsx";
import { channelStatus, usePlayback } from "./playback.ts";
import {
  anchorOf,
  ChannelLogo,
  colors,
  largeText,
  Message,
  monogram,
  Notice,
  TextButton,
  useRowHeight,
} from "./ui.tsx";

// The viewer's own channel lists (custom-lists.ts) as Live shows them: a row each under
// Favourites, in the order they were made, opening the list pushed on Live's stack. Holding a
// channel's row in Live, a category, Favourites or a list, or its VoiceOver action Lists, opens the
// channel's lists as a system sheet: a list marked ✓ holds it and takes it out, any other adds it at
// its end, and New list… makes one holding it. A list's row plays its channel in Watch while its
// entry is still that channel at the press. An entry that doesn't open keeps its place, named as
// it was last listed, and plays nothing; one no longer listed can be removed at once. Edit arranges
// the rows as Favourites' editor does and removes them from the draft; Save writes the order and
// the removals together, only while the list still shows the rows it was made from. A refused write
// keeps the draft for Try again. Rename and Delete list write at once.

const WHY = {
  loading: "channels still loading",
  failed: "channels didn't load",
  "needs-secret": "password needed in Settings",
  "not-listed": "no longer listed",
} as const satisfies Record<Unavailable, string>;

/** What a saved channel that doesn't show says, after its provider's name, here and in Favourites. */
export const why = (reason: Unavailable) => t(WHY[reason]);

/** Where list `id` opens, on Live's stack. */
const listHref = (id: string) => `/live/list?id=${encodeURIComponent(id)}` as const;

/** How many of a list's channels open now, as its row on Live counts them. */
const openCount = (list: ChannelList) =>
  list.entries.filter((entry) => entry.kind === "listed").length;

/** A list that changed nothing, in a sentence: the channel's own state, or the write's error. */
function whyNot(error: AppError): string {
  switch (error.kind) {
    case "no-list":
      return t("It was deleted.");
    case "list-changed":
      return t("Its provider lists the channel as more than one channel now.");
    case "no-subscription":
      return t("Its provider was removed.");
    case "channel-not-found":
      return t("Its provider no longer lists the channel.");
    default:
      return describeError(error);
  }
}

/** Makes one write to list `name`, saying so when it changed nothing. Answers whether it was made. */
function change(name: string, write: () => void): boolean {
  try {
    write();
    return true;
  } catch (cause) {
    Alert.alert(t("{name} wasn't changed", { name }), whyNot(appError(cause)));
    return false;
  }
}

/** A name asked for in a system prompt: New list from a row's sheet, or Rename in Edit. */
interface Naming {
  readonly title: string;
  readonly message?: string;
  readonly action: string;
  readonly typed: string;
  /** What a failure's alert says, given the name typed. */
  readonly failed: (name: string) => string;
  readonly write: (name: string) => void;
}

/**
 * Asks for a list's name, trimmed, and writes it: an empty one writes nothing, and one another list
 * has asks again, keeping the text typed.
 */
function askName(naming: Naming) {
  Alert.prompt(
    naming.title,
    naming.message,
    [
      { text: t("Cancel"), style: "cancel" },
      {
        text: naming.action,
        onPress: (typed = "") => {
          const name = typed.trim();
          if (!name) return;
          try {
            naming.write(name);
          } catch (cause) {
            const error = appError(cause);
            if (error.kind === "invalid-input") {
              return askName({ ...naming, message: error.detail, typed });
            }
            if (error.kind !== "list-name-taken") {
              return Alert.alert(naming.failed(name), whyNot(error));
            }
            const folded = normalize(name);
            const other = currentChannelLists().find((list) => normalize(list.name) === folded);
            askName({
              ...naming,
              message: t("There's already a list called {name}.", { name: other?.name ?? name }),
              typed,
            });
          }
        },
      },
    ],
    "plain-text",
    naming.typed,
  );
}

/**
 * Opens `channel`'s lists as a system sheet, a popover at `anchor` on iPad: every list, those
 * holding it marked, then New list…. Choosing one adds the channel or takes it out.
 */
export function openListSheet(channel: Channel, anchor?: number) {
  const lists = currentChannelLists();
  const holding = listsHolding(channel);
  const holds = lists.map((list) => holding.has(list.id));
  const catalogue = currentCatalogue();
  const provider =
    channel.ambiguous && catalogue.kind === "ready"
      ? catalogue.library.labels.get(channel.subscriptionId)
      : undefined;
  const named = provider ? `${channel.title}, ${provider}` : channel.title;
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: named,
      options: [
        ...lists.map((list, at) => (holds[at] ? `✓ ${list.name}` : list.name)),
        t("New list…"),
        t("Cancel"),
      ],
      cancelButtonIndex: lists.length + 1,
      anchor,
    },
    (index) => {
      const list = lists[index];
      if (list) return void change(list.name, () => setMember(list.id, channel, !holds[index]));
      if (index !== lists.length) return;
      askName({
        title: t("New list"),
        message: t("{name} goes in it.", { name: named }),
        action: t("Create"),
        typed: "",
        failed: (name) => t("Couldn't make {name}", { name }),
        write: (name) => void createList(name, channel),
      });
    },
  );
}

/** A row on Live that opens a list of channels, with how many of them open. */
export function Entry({
  name,
  count,
  onPress,
  testID,
}: {
  name: string;
  count: number;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${name}, ${formatNumber(count)}` : name}
      onPress={onPress}
      style={({ pressed }) => [styles.entry, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={styles.entryName} numberOfLines={1}>
        {name}
      </Text>
      {count > 0 ? <Text style={styles.entryCount}>{formatNumber(count)}</Text> : null}
      <View style={styles.spacer} />
      <SymbolView name="chevron.right" size={13} tintColor={colors.text} weight="semibold" />
    </Pressable>
  );
}

/** Live's rows for the viewer's lists, under Favourites; none without lists. */
export function ListEntries() {
  const lists = useChannelLists();
  return (
    <>
      {lists.map((list) => (
        <Entry
          key={list.id}
          name={list.name}
          count={openCount(list)}
          onPress={() => router.push(listHref(list.id))}
          testID={`live-list-${list.id}`}
        />
      ))}
    </>
  );
}

/** The list's rows as being edited, from the list as it showed. */
interface Draft {
  readonly from: ChannelList;
  /** Its rows in their new order, without those removed. */
  readonly order: readonly ListEntry[];
}

/** A row's id among the screen's: its channel's key, or its entry's while it doesn't open. */
const rowId = (entry: ListEntry) => (entry.kind === "listed" ? entry.channel.key : entry.member);
const titleOf = (entry: ListEntry) => (entry.kind === "listed" ? entry.channel.title : entry.name);

/** Escape, which throws an edit away as Cancel does, titled in the interface language. */
const cancelShortcut = (): readonly Shortcut<"cancel">[] => [
  { id: "cancel", input: "escape", command: false, title: t("Cancel") },
];

/** "2 kept for removed providers": the channels kept for subscriptions removed with their history. */
const awayLine = (away: number) => t("{count} kept for removed providers", { count: away });

/** List `id`'s channels, pushed on Live; a list deleted meanwhile says so. */
export function ChannelListScreen({ id }: { id: string }) {
  const locale = useLocale();
  // Made again for a new language only: the native module installs them whenever they change.
  const shortcuts = useMemo(cancelShortcut, [locale]);
  const list = useChannelLists().find((each) => each.id === id);
  const catalogue = useCatalogue();
  const inset = useDockInset();
  const height = useRowHeight();
  const large = largeText(useWindowDimensions().fontScale);
  const { phase, watch } = usePlayback();
  const playing = channelStatus(phase);
  const focused = useIsFocused();
  const [draft, setDraft] = useState<Draft | null>(null);
  // Only while this edit shows: Watch, or a screen pushed over it, has its own Escape.
  useShortcuts(draft && focused && !watch ? shortcuts : NO_SHORTCUTS, () => setDraft(null));
  // The draft on show, for a Try again that comes later; none once the list closed.
  const open = useRef<Draft | null>(null);
  useEffect(() => {
    open.current = draft;
  }, [draft]);
  useEffect(() => () => void (open.current = null), []);
  if (!list) {
    return (
      <View style={styles.screen}>
        <Message text={t("This list was deleted.")} />
      </View>
    );
  }
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const placeOf = (channel: Channel) => library?.placeOf.get(channel.key) ?? "";
  const detailOf = (entry: ListEntry) =>
    entry.kind === "listed"
      ? entry.channel.key === playing?.id
        ? t(playing.word)
        : placeOf(entry.channel)
      : t("{provider}: {why}", { provider: entry.label, why: why(entry.why) });
  const rows = draft?.order ?? list.entries;
  /** The list's name now, which Rename may have changed since a draft began. */
  const nameNow = () => currentChannelLists().find((each) => each.id === id)?.name ?? list.name;

  // Plays only while the entry is still the channel the row showed, as the lists stand at the press.
  const play = (entry: ListEntry & { kind: "listed" }) => {
    const now = currentChannelLists()
      .find((each) => each.id === id)
      ?.entries.find((each) => each.member === entry.member);
    if (now?.kind === "listed" && now.channel.key === entry.channel.key) {
      return playChannel(now.channel, placeOf(now.channel), { watch: true });
    }
    Alert.alert(
      t("{name} didn't play", { name: entry.channel.title }),
      t("{list} changed meanwhile: choose it again as it shows now.", { list: nameNow() }),
    );
  };
  const remove = (entry: ListEntry) => change(list.name, () => removeMember(list.id, entry.member));

  const move = (entry: ListEntry, by: number) => {
    if (!draft) return;
    const from = draft.order.indexOf(entry);
    const to = Math.min(Math.max(from + by, 0), draft.order.length - 1);
    if (from < 0 || to === from) return;
    const order = draft.order.toSpliced(from, 1).toSpliced(to, 0, entry);
    setDraft({ ...draft, order });
    AccessibilityInfo.announceForAccessibility(
      t("{name}, {position} of {count}", {
        name: titleOf(entry),
        position: to + 1,
        count: order.length,
      }),
    );
  };
  const drop = (entry: ListEntry) => {
    if (draft) setDraft({ ...draft, order: draft.order.filter((each) => each !== entry) });
  };
  const save = (sent: Draft) => {
    const name = nameNow();
    const closed = () =>
      Alert.alert(t("{name} wasn't saved", { name }), t("Nothing was moved: the list was closed."));
    if (open.current !== sent) return closed();
    const order = sent.order.map((entry) => entry.member);
    const removed = sent.from.entries
      .filter((entry) => !sent.order.includes(entry))
      .map((entry) => entry.member);
    if (removed.length === 0 && order.every((each, at) => each === sent.from.entries[at]?.member)) {
      return setDraft(null);
    }
    try {
      arrangeList(sent.from, order, removed);
      setDraft(null);
    } catch (cause) {
      const error = appError(cause);
      if (error.kind === "no-list" || error.kind === "list-changed") {
        setDraft(null);
        if (error.kind === "no-list") return closed();
        return Alert.alert(
          t("{name} changed", { name }),
          t("Nothing was moved or removed. It changed while you edited it: edit it as it is now."),
        );
      }
      Alert.alert(t("Couldn't save {name}", { name }), describeError(error), [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Try again"), onPress: () => save(sent) },
      ]);
    }
  };
  const rename = () =>
    askName({
      title: t("Rename list"),
      action: t("Rename"),
      typed: nameNow(),
      failed: () => t("{name} wasn't changed", { name: nameNow() }),
      write: (name) => renameList(id, name),
    });
  const confirmDelete = () => {
    const name = nameNow();
    Alert.alert(t("Delete {name}?", { name }), t("Its channels stay in Live."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () => {
          if (!change(name, () => deleteList(id))) return;
          setDraft(null);
          router.back();
        },
      },
    ]);
  };

  return (
    <FlatList
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      data={rows}
      keyExtractor={(entry) => entry.member}
      // Rows draw again as editing starts or ends, as what plays changes, and in a new language.
      extraData={`${draft ? "editing" : "list"} ${list.name} ${playing?.id ?? ""} ${playing?.word ?? ""} ${locale}`}
      renderItem={({ item, index }) =>
        draft ? (
          <ArrangedRow
            entry={item}
            detail={detailOf(item)}
            listName={list.name}
            position={index}
            count={rows.length}
            height={height}
            large={large}
            onMove={move}
            onRemove={drop}
          />
        ) : (
          <ListRow
            entry={item}
            detail={detailOf(item)}
            listName={list.name}
            height={height}
            large={large}
            onPlay={play}
            onRemove={remove}
          />
        )
      }
      ListHeaderComponent={
        <View style={styles.bar}>
          {draft ? (
            <>
              <TextButton label={t("Cancel")} onPress={() => setDraft(null)} testID="list-cancel" />
              <TextButton label={t("Save")} onPress={() => save(draft)} testID="list-save" />
            </>
          ) : (
            <>
              <View />
              <TextButton
                label={t("Edit")}
                onPress={() => setDraft({ from: list, order: list.entries })}
                testID="list-edit"
              />
            </>
          )}
        </View>
      }
      ListFooterComponent={
        draft ? (
          <View style={styles.footer}>
            <TextButton label={t("Rename")} onPress={rename} testID="list-rename" />
            <TextButton
              label={t("Delete list")}
              destructive
              onPress={confirmDelete}
              testID="list-delete"
            />
          </View>
        ) : list.away > 0 ? (
          <Text style={styles.away}>{awayLine(list.away)}</Text>
        ) : undefined
      }
      ListEmptyComponent={
        draft ? undefined : (
          <Notice
            failure={{
              headline: t("No channels in {name}.", { name: list.name }),
              advice: t("Hold a channel in Live to add it."),
            }}
          />
        )
      }
      contentContainerStyle={{ paddingBottom: 32 + inset }}
      testID="list"
    />
  );
}

/**
 * A list's row: a channel that plays when pressed and opens its lists when held, or an entry that
 * doesn't open, named as it was last listed, with Remove while it is no longer listed.
 */
function ListRow({
  entry,
  detail,
  listName,
  height,
  large,
  onPlay,
  onRemove,
}: {
  entry: ListEntry;
  detail: string;
  listName: string;
  height: number;
  large: boolean;
  onPlay: (entry: ListEntry & { kind: "listed" }) => void;
  onRemove: (entry: ListEntry) => void;
}) {
  const row = useRef<ComponentRef<typeof Pressable>>(null);
  const removeAction = { name: "remove", label: t("Remove from {list}", { list: listName }) };
  if (entry.kind === "unavailable") {
    return (
      <View style={[styles.row, { minHeight: height }]}>
        <View
          accessible
          accessibilityLabel={`${entry.name}, ${detail}`}
          // As the screen offers Remove: once its provider no longer lists it.
          accessibilityActions={entry.why === "not-listed" ? [removeAction] : []}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === "remove") onRemove(entry);
          }}
          style={styles.main}
          testID={`list-row-${rowId(entry)}`}
        >
          <Lines entry={entry} detail={detail} large={large} />
        </View>
        {entry.why === "not-listed" ? (
          <View
            // VoiceOver removes it by the row's action instead.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.remove}
          >
            <TextButton
              label={t("Remove")}
              onPress={() => onRemove(entry)}
              testID={`list-row-${rowId(entry)}-remove`}
            />
          </View>
        ) : null}
      </View>
    );
  }
  const { channel } = entry;
  const act = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === "activate") onPlay(entry);
    if (nativeEvent.actionName === "lists") openListSheet(channel);
    if (nativeEvent.actionName === "remove") onRemove(entry);
  };
  return (
    <View style={[styles.row, { minHeight: height }]}>
      <Pressable
        ref={row}
        accessibilityRole="button"
        accessibilityLabel={[channel.title, detail.replaceAll(" · ", ", ")]
          .filter(Boolean)
          .join(", ")}
        accessibilityActions={[
          { name: "activate" },
          { name: "lists", label: t("Lists") },
          removeAction,
        ]}
        onAccessibilityAction={act}
        onPress={() => onPlay(entry)}
        onLongPress={() => openListSheet(channel, anchorOf(row.current))}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        testID={`list-row-${channel.key}`}
      >
        <Lines entry={entry} detail={detail} large={large} />
      </Pressable>
    </View>
  );
}

/**
 * A row being edited: no playing, removed from the draft at its start, moved with Move up and Move
 * down at its end, or under its lines at large text; VoiceOver has all three as its actions.
 */
function ArrangedRow({
  entry,
  detail,
  listName,
  position,
  count,
  height,
  large,
  onMove,
  onRemove,
}: {
  entry: ListEntry;
  detail: string;
  listName: string;
  position: number;
  count: number;
  height: number;
  large: boolean;
  onMove: (entry: ListEntry, by: number) => void;
  onRemove: (entry: ListEntry) => void;
}) {
  const id = rowId(entry);
  const title = titleOf(entry);
  const first = position === 0;
  const last = position === count - 1;
  const act = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === "up") onMove(entry, -1);
    if (nativeEvent.actionName === "down") onMove(entry, 1);
    if (nativeEvent.actionName === "remove") onRemove(entry);
  };
  const glyph = large ? 28 : 17;
  const moves = (
    <>
      <Hidden
        symbol="chevron.up"
        size={glyph}
        disabled={first}
        onPress={() => onMove(entry, -1)}
        testID={`arranged-${id}-up`}
      />
      <Hidden
        symbol="chevron.down"
        size={glyph}
        disabled={last}
        onPress={() => onMove(entry, 1)}
        testID={`arranged-${id}-down`}
      />
    </>
  );
  return (
    <View style={[styles.arranged, { minHeight: height }, large && styles.arrangedLarge]}>
      <View style={[styles.arrangedLine, large && styles.arrangedTop]}>
        <Hidden
          symbol="minus.circle"
          size={large ? 28 : 22}
          onPress={() => onRemove(entry)}
          testID={`arranged-${id}-remove`}
        />
        <View
          accessible
          accessibilityLabel={[
            title,
            detail,
            t("{position} of {count}", { position: position + 1, count }),
          ]
            .filter(Boolean)
            .join(", ")}
          accessibilityActions={[
            ...(first ? [] : [{ name: "up", label: t("Move up") }]),
            ...(last ? [] : [{ name: "down", label: t("Move down") }]),
            { name: "remove", label: t("Remove from {list}", { list: listName }) },
          ]}
          onAccessibilityAction={act}
          style={styles.main}
          testID={`arranged-${id}`}
        >
          <Lines entry={entry} detail={detail} large={large} stacked={large} />
        </View>
        {large ? null : moves}
      </View>
      {large ? <View style={styles.under}>{moves}</View> : null}
    </View>
  );
}

/** A 44 point button VoiceOver skips, as its row offers the same as an action. */
function Hidden({
  symbol,
  size,
  disabled,
  onPress,
  testID,
}: {
  symbol: "chevron.up" | "chevron.down" | "minus.circle";
  size: number;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.target, (pressed || disabled) && styles.dimmed]}
      testID={testID}
    >
      <SymbolView name={symbol} size={size} tintColor={colors.text} weight="semibold" />
    </Pressable>
  );
}

/**
 * A row's logo, name and detail. An entry that doesn't open is grey on an outlined tile. Large
 * text wraps both lines to two, and `stacked` puts the logo above them.
 */
function Lines({
  entry,
  detail,
  large,
  stacked = false,
}: {
  entry: ListEntry;
  detail: string;
  large: boolean;
  stacked?: boolean;
}) {
  const listed = entry.kind === "listed";
  const tags = listed ? entry.channel.tags.join(" ") : "";
  const lines = large ? 2 : 1;
  return (
    <View style={[styles.lines, stacked && styles.linesStacked]}>
      {listed ? (
        <ChannelLogo channel={entry.channel} style={styles.mark} />
      ) : (
        <View style={[styles.mark, styles.outlined]}>
          <Text style={styles.markText} allowFontScaling={false} numberOfLines={1}>
            {monogram(entry.name)}
          </Text>
        </View>
      )}
      <View style={[styles.names, stacked && styles.namesStacked]}>
        <Text style={[styles.title, !listed && styles.grey]} numberOfLines={lines}>
          {titleOf(entry)}
          {tags ? <Text style={styles.tags}>{`  ${tags}`}</Text> : null}
        </Text>
        {detail ? (
          <Text style={styles.detail} numberOfLines={lines}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  pressed: { opacity: 0.5 },
  dimmed: { opacity: 0.3 },
  spacer: { flex: 1 },
  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  entryName: { color: colors.text, fontSize: 17, fontWeight: "600", flexShrink: 1 },
  entryCount: { color: colors.dim, fontSize: 17 },
  bar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  footer: { paddingHorizontal: 16, paddingTop: 16, alignItems: "flex-start" },
  away: { color: colors.text, fontSize: 15, paddingHorizontal: 16, paddingTop: 16 },
  row: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 4 },
  main: { flex: 1, flexDirection: "row", alignItems: "center", alignSelf: "stretch" },
  remove: { paddingHorizontal: 12 },
  arranged: { justifyContent: "center", paddingHorizontal: 4 },
  arrangedLarge: { paddingTop: 10, paddingBottom: 4 },
  arrangedLine: { flexDirection: "row", alignItems: "center" },
  arrangedTop: { alignItems: "flex-start" },
  under: { flexDirection: "row", justifyContent: "flex-end", gap: 4, paddingTop: 4 },
  lines: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  linesStacked: { flexDirection: "column", alignItems: "flex-start", gap: 6, paddingTop: 4 },
  mark: { width: 56, height: 36 },
  outlined: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },
  markText: { color: colors.dim, fontSize: 11, fontWeight: "700" },
  names: { flex: 1, minWidth: 0 },
  namesStacked: { flex: 0, alignSelf: "stretch" },
  title: { color: colors.text, fontSize: 17 },
  grey: { color: colors.dim },
  tags: { color: colors.dim, fontSize: 13 },
  detail: { color: colors.dim, fontSize: 13, marginTop: 2 },
  target: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
