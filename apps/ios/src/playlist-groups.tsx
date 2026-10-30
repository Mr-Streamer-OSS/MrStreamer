import type { AppError } from "@mrstreamer/contracts/errors";
import type {
  PlaylistGroup,
  PlaylistMode,
  PlaylistOmission,
  PlaylistOmissionReason,
  PlaylistSample,
} from "@mrstreamer/contracts/playlist";
import { formatNumber } from "@mrstreamer/core/i18n";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  mapPlaylist,
  playlistReport,
  useRoster,
  type Member,
  type PlaylistReport,
} from "./account.ts";
import { appError, failureOf, type Failure } from "./errors.ts";
import { useTabs, type Tab } from "./header.tsx";
import { NO_SHORTCUTS, useShortcuts, type Shortcut } from "./key-commands.ts";
import { colors, largeText, Message, Notice, TextButton, useListWidth } from "./ui.tsx";

// A playlist's groups, from Settings: what each imports as, one group's pick with sample entries,
// and every entry left out with why. Names and reasons only: the link never shows. Compact
// windows push each as a screen of its own; from 700 points (Live's rule, `splitAt`) the groups
// list sits beside the selected group, which starts as the first needing mapping, and Left out
// takes the group's place until a group is picked again or Escape closes it.

const MODES = [
  { mode: "live", label: "Live TV" },
  { mode: "movie", label: "Movies" },
  { mode: "series", label: "Series" },
  { mode: "skip", label: "Skip" },
] as const satisfies readonly { mode: PlaylistMode; label: string }[];

/** Why an entry stays out of the lists, in the desktop's words. */
const OMISSIONS = {
  unmapped: "Group needs mapping",
  "conflicting-groups": "Groups have different mappings",
  "unsupported-address": "Unsupported stream address",
  "missing-name": "No title name",
  "invalid-episode": "No unambiguous episode number",
  skip: "Skipped by mapping",
} as const satisfies Record<PlaylistOmissionReason, string>;

/** Left out entries shown at a time; Show more adds as many again. */
const PAGE = 50;

const ESCAPE: readonly Shortcut<"close">[] = [
  { id: "close", input: "escape", command: false, title: "Back to the group" },
];

/** Where the playlist screen opens on `tab`: Home's at the root, the others' under their tab. */
export const playlistHref = (tab: Tab) => (tab === "(home)" ? "/playlist" : `/${tab}/playlist`);

/** What the screen shows: every group, one group by its id, or the entries left out. */
export type PlaylistView =
  | { readonly kind: "groups" }
  | { readonly kind: "group"; readonly group: string }
  | { readonly kind: "left-out" };

type Reading =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly report: PlaylistReport }
  | { readonly kind: "failed"; readonly error: AppError };

/** The read each list of `member` last landed from, which a new report follows. */
const readOf = (member: Member) => (member.live.kind === "ready" ? member.live.fetchedAt : null);

/**
 * How many of a playlist's groups wait for a pick, for its Settings row: null for anything but
 * a playlist whose channels its provider gave this launch, so Settings never reads it afresh.
 */
export function useUnmapped(member: Member): number | null {
  const { entry, live, needsSecret } = member;
  const read =
    entry.kind === "m3u" && !needsSecret && live.kind === "ready" && live.from === "provider"
      ? live.fetchedAt
      : null;
  const [counted, setCounted] = useState<{ read: number; unmapped: number } | null>(null);
  useEffect(() => {
    if (read === null) return;
    const controller = new AbortController();
    playlistReport(entry.id, controller.signal).then(
      ({ groups }) => {
        if (controller.signal.aborted) return;
        setCounted({ read, unmapped: groups.filter((group) => group.mode === null).length });
      },
      // The row says how the playlist stands without it.
      () => undefined,
    );
    return () => controller.abort();
  }, [entry.id, read]);
  return counted && counted.read === read ? counted.unmapped : null;
}

/**
 * The playlist `id` as `view` asks. A pick saves at once, its row saying Saving and the others
 * waiting, and stays shown once the playlist was read with it; a failed one says why under the
 * modes. The report is read again as the playlist's lists land.
 */
export function PlaylistScreen({ id, view }: { id: string; view: PlaylistView }) {
  const roster = useRoster();
  const member =
    roster.kind === "ready" ? roster.members.find((each) => each.entry.id === id) : undefined;
  const read = member ? readOf(member) : null;
  const [reading, setReading] = useState<Reading>({ kind: "loading" });
  const [asked, setAsked] = useState(0);
  const [saving, setSaving] = useState<{ group: string; mode: PlaylistMode } | null>(null);
  const [refused, setRefused] = useState<{ group: string; failure: Failure } | null>(null);
  const leaving = useRef(new AbortController());
  const show = (signal: AbortSignal) => (report: PlaylistReport) => {
    if (!signal.aborted) setReading({ kind: "ready", report });
  };
  const failed = (signal: AbortSignal) => (cause: unknown) => {
    if (!signal.aborted) setReading({ kind: "failed", error: appError(cause) });
  };
  useEffect(() => {
    const controller = new AbortController();
    leaving.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    playlistReport(id, controller.signal).then(show(controller.signal), failed(controller.signal));
    return () => controller.abort();
  }, [id, read, asked]);

  if (roster.kind === "ready" && !member) return <Message text="This provider was removed." />;
  if (reading.kind === "loading") return <Message text="Reading playlist" />;
  if (reading.kind === "failed") {
    return (
      <Notice
        failure={readFailure(reading.error)}
        actions={[
          {
            label: "Try again",
            onPress: () => {
              setReading({ kind: "loading" });
              setAsked((count) => count + 1);
            },
          },
        ]}
      />
    );
  }

  const pick = (group: string, mode: PlaylistMode) => {
    if (saving) return;
    const { signal } = leaving.current;
    setSaving({ group, mode });
    setRefused(null);
    mapPlaylist(id, group, mode)
      .then(
        // Saved: the pick shows once the playlist was read with it.
        () => playlistReport(id, signal).then(show(signal), failed(signal)),
        (cause: unknown) => {
          if (signal.aborted) return;
          setRefused({ group, failure: failureOf(appError(cause), member?.entry.server ?? "") });
        },
      )
      .finally(() => {
        if (!signal.aborted) setSaving(null);
      });
  };
  const detail = { report: reading.report, saving, refused, pick };

  if (view.kind === "left-out") return <LeftOut omissions={reading.report.omissions} />;
  if (view.kind === "group") {
    const group = reading.report.groups.find((each) => each.group === view.group);
    if (!group) return <Message text="This group is no longer in the playlist." />;
    return (
      <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
        <GroupDetail group={group} {...detail} />
      </ScrollView>
    );
  }
  return <Groups id={id} {...detail} />;
}

/** Why the report couldn't be read, under the screen's own headline. */
function readFailure(error: AppError): Failure {
  const advice =
    error.kind === "unreachable" || error.kind === "provider-error"
      ? "Your provider didn't answer. Try again in a moment."
      : error.kind === "needs-secret"
        ? "Enter the playlist link again in Settings."
        : failureOf(error, "").headline;
  return { headline: "Couldn't read the playlist", advice };
}

interface Detail {
  readonly report: PlaylistReport;
  readonly saving: { readonly group: string; readonly mode: PlaylistMode } | null;
  readonly refused: { readonly group: string; readonly failure: Failure } | null;
  readonly pick: (group: string, mode: PlaylistMode) => void;
}

/**
 * Every group, under what the playlist holds and Left out, with the selected group beside them
 * when wide.
 */
function Groups({ id, ...detail }: Detail & { id: string }) {
  const { report } = detail;
  const tab = useTabs()?.tab ?? "(home)";
  const { split, width, gutter } = useListWidth();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [leftOut, setLeftOut] = useState(false);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? report.groups.filter((group) => group.name.toLowerCase().includes(needle))
    : report.groups;
  const group =
    report.groups.find((each) => each.group === selected) ??
    report.groups.find((each) => each.mode === null) ??
    report.groups[0];
  useShortcuts(split && leftOut ? ESCAPE : NO_SHORTCUTS, () => setLeftOut(false));

  const push = (params: { group: string } | { left: "1" }) =>
    router.push({ pathname: playlistHref(tab), params: { id, ...params } });
  const list = (
    <FlatList
      style={split ? { width, flexGrow: 0 } : styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      data={shown}
      keyExtractor={(each) => each.group}
      ListHeaderComponent={
        <View>
          <View style={styles.counts}>
            <Count value={report.status.live} label="Channels" />
            <Count value={report.status.movies} label="Movies" />
            <Count value={report.status.series} label="Series" />
            <Count value={report.status.episodes} label="Episodes" />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Left out, ${formatNumber(report.omissions.length)}`}
            accessibilityState={{ selected: split && leftOut }}
            onPress={() => (split ? setLeftOut(true) : push({ left: "1" }))}
            style={({ pressed }) => [styles.leftOut, pressed && styles.pressed]}
            testID="playlist-left-out"
          >
            <Text style={styles.label}>Left out</Text>
            <Text style={styles.value}>{formatNumber(report.omissions.length)}</Text>
            <SymbolView name="chevron.right" size={14} tintColor={colors.dim} weight="semibold" />
          </Pressable>
          <View style={styles.search}>
            <SymbolView name="magnifyingglass" size={15} tintColor={colors.dim} />
            <TextInput
              accessibilityLabel="Search groups"
              value={query}
              onChangeText={setQuery}
              placeholder={`Search ${formatNumber(report.groups.length)} groups`}
              placeholderTextColor={colors.dim}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
              keyboardAppearance="dark"
              selectionColor="#FFFFFF"
              style={styles.searchInput}
              testID="playlist-search"
            />
          </View>
        </View>
      }
      renderItem={({ item }) => (
        <GroupRow
          group={item}
          selected={split && !leftOut && item.group === group?.group}
          chevron={!split}
          onPress={() => {
            if (!split) return push({ group: item.group });
            setSelected(item.group);
            setLeftOut(false);
          }}
        />
      )}
      ListEmptyComponent={<Text style={styles.none}>No group matches.</Text>}
    />
  );
  if (!split) return list;
  return (
    <View style={styles.split}>
      {list}
      <ScrollView
        style={[styles.detail, { paddingHorizontal: gutter - 16 }]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.readable}>
          {leftOut ? (
            <LeftOutEntries omissions={report.omissions} />
          ) : group ? (
            <GroupDetail group={group} {...detail} />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function Count({ value, label }: { value: number; label: string }) {
  return (
    <View accessible accessibilityLabel={`${formatNumber(value)} ${label}`}>
      <Text style={styles.count}>{formatNumber(value)}</Text>
      <Text style={styles.small}>{label}</Text>
    </View>
  );
}

const entries = (count: number) => `${formatNumber(count)} ${count === 1 ? "entry" : "entries"}`;
const modeLabel = (mode: PlaylistMode | null) =>
  MODES.find((each) => each.mode === mode)?.label ?? "Needs mapping";

/** A group as a row: its name and size, and what it imports as, or that it needs mapping. */
function GroupRow({
  group,
  selected,
  chevron,
  onPress,
}: {
  group: PlaylistGroup;
  selected: boolean;
  chevron: boolean;
  onPress: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  const stacked = largeText(fontScale);
  const mode = (
    <Text style={group.mode === null ? styles.unmapped : styles.value}>
      {modeLabel(group.mode)}
    </Text>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${group.name}, ${entries(group.entries)}, ${modeLabel(group.mode)}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.group,
        selected && styles.selected,
        pressed && styles.pressed,
      ]}
      testID={`playlist-group-${group.group}`}
    >
      <View style={styles.names}>
        <Text style={styles.label}>{group.name}</Text>
        <Text style={styles.small}>{entries(group.entries)}</Text>
        {stacked ? mode : null}
      </View>
      {stacked ? null : mode}
      {chevron ? (
        <SymbolView name="chevron.right" size={14} tintColor={colors.dim} weight="semibold" />
      ) : null}
    </Pressable>
  );
}

/** One group: what it imports as, which a press saves, and a few entries with why any stay out. */
function GroupDetail({ group, saving, refused, pick }: Detail & { group: PlaylistGroup }) {
  const here = saving?.group === group.group ? saving : null;
  return (
    <View style={styles.body}>
      <View style={styles.heading}>
        <Text style={styles.title} accessibilityRole="header">
          {group.name}
        </Text>
        <Text style={styles.subtitle}>{entries(group.entries)}</Text>
      </View>
      <Text style={styles.section} accessibilityRole="header">
        Import as
      </Text>
      {MODES.map(({ mode, label }) => {
        const current = here ? here.mode === mode : group.mode === mode;
        const waiting = saving !== null && here?.mode !== mode;
        return (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityState={{ selected: current, disabled: Boolean(saving) }}
            disabled={Boolean(saving)}
            onPress={() => !current && pick(group.group, mode)}
            style={({ pressed }) => [styles.mode, (waiting || pressed) && styles.pressed]}
            testID={`playlist-mode-${mode}`}
          >
            <Text style={styles.label}>{label}</Text>
            <View style={styles.trailing}>
              {here?.mode === mode ? (
                <Text style={styles.value}>Saving</Text>
              ) : current ? (
                <SymbolView name="checkmark" size={17} tintColor={colors.text} weight="semibold" />
              ) : null}
            </View>
          </Pressable>
        );
      })}
      {refused?.group === group.group ? (
        <View accessible accessibilityLiveRegion="polite" style={styles.refused}>
          <Text style={styles.error}>{refused.failure.headline}</Text>
          {refused.failure.advice ? (
            <Text style={styles.advice}>{refused.failure.advice}</Text>
          ) : null}
        </View>
      ) : null}
      <Text style={styles.note}>
        New groups wait for mapping. Entries in groups with different mappings stay out.
      </Text>
      {group.samples.length > 0 ? (
        <>
          <Text style={[styles.section, styles.samples]} accessibilityRole="header">
            Sample entries
          </Text>
          {group.samples.map((sample, index) => (
            <Entry key={index} name={sample.name} why={sampleReason(sample, group.name)} />
          ))}
        </>
      ) : null}
    </View>
  );
}

/** Why a sample stays out, naming the other groups it is in when they disagree. */
function sampleReason({ reason, groups }: PlaylistSample, here: string): string | null {
  if (!reason) return null;
  const others = groups.map((name) => name || "Ungrouped").filter((name) => name !== here);
  return reason === "conflicting-groups" && others.length > 0
    ? `${OMISSIONS[reason]} · also in ${others.join(", ")}`
    : OMISSIONS[reason];
}

/** Every entry left out of the lists, a page at a time, as a screen of its own. */
function LeftOut({ omissions }: { omissions: readonly PlaylistOmission[] }) {
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.body}>
        <LeftOutEntries omissions={omissions} />
      </View>
    </ScrollView>
  );
}

function LeftOutEntries({ omissions }: { omissions: readonly PlaylistOmission[] }) {
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      <View style={styles.heading}>
        <Text style={styles.title} accessibilityRole="header">
          Left out
        </Text>
        <Text style={styles.subtitle}>{entries(omissions.length)}</Text>
      </View>
      <View style={styles.entries}>
        {omissions.slice(0, shown).map((omission, index) => (
          <Entry
            key={index}
            name={omission.name}
            why={[
              OMISSIONS[omission.reason],
              omission.groups.map((name) => name || "Ungrouped").join(", "),
            ].join(" · ")}
          />
        ))}
      </View>
      {shown < omissions.length ? (
        <View style={styles.more}>
          <TextButton
            label="Show more"
            onPress={() => setShown((count) => count + PAGE)}
            testID="playlist-show-more"
          />
        </View>
      ) : null}
    </>
  );
}

function Entry({ name, why }: { name: string; why: string | null }) {
  return (
    <View style={styles.entry} accessible>
      <Text style={styles.label}>{name}</Text>
      {why ? <Text style={styles.small}>{why}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  split: { flex: 1, flexDirection: "row", backgroundColor: "#000000" },
  detail: {
    flex: 1,
    borderLeftColor: colors.line,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  readable: { maxWidth: 664 },
  body: { paddingBottom: 32 },
  counts: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 20,
    rowGap: 6,
    paddingTop: 16,
    paddingBottom: 16,
    marginHorizontal: 16,
  },
  count: { color: colors.text, fontSize: 22, lineHeight: 28, fontWeight: "700" },
  small: { color: colors.dim, fontSize: 13, lineHeight: 18 },
  leftOut: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    marginHorizontal: 16,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingTop: 8,
    marginHorizontal: 16,
  },
  searchInput: { flex: 1, color: colors.text, fontSize: 17, minHeight: 36 },
  none: { color: colors.dim, fontSize: 15, marginHorizontal: 16, marginTop: 12 },
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 60,
    paddingVertical: 8,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // The selected group's row reaches the column's edges, its text still in line with the rest.
  selected: {
    backgroundColor: colors.fill,
    borderRadius: 10,
    marginHorizontal: 8,
    paddingHorizontal: 8,
  },
  pressed: { opacity: 0.5 },
  names: { flex: 1, minWidth: 0 },
  label: { color: colors.text, fontSize: 17, lineHeight: 22, flexShrink: 1 },
  value: { color: colors.dim, fontSize: 17, lineHeight: 22, textAlign: "right" },
  unmapped: {
    color: colors.text,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    textAlign: "right",
  },
  heading: { gap: 2, paddingTop: 8, paddingBottom: 4, marginHorizontal: 16 },
  title: {
    color: colors.text,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "700",
    letterSpacing: -0.28,
  },
  subtitle: { color: colors.dim, fontSize: 15, lineHeight: 20 },
  section: {
    color: colors.text,
    fontSize: 20,
    lineHeight: 25,
    fontWeight: "700",
    paddingTop: 20,
    paddingBottom: 4,
    marginHorizontal: 16,
  },
  samples: { paddingTop: 24 },
  mode: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  trailing: { width: 72, alignItems: "flex-end" },
  refused: { marginHorizontal: 16, marginTop: 8 },
  error: { color: "#FF453A", fontSize: 15, fontWeight: "600" },
  advice: { color: colors.text, fontSize: 15, marginTop: 2 },
  note: { color: colors.dim, fontSize: 13, lineHeight: 18, paddingTop: 8, marginHorizontal: 16 },
  entries: { paddingTop: 4 },
  more: { marginHorizontal: 16 },
  entry: {
    paddingVertical: 10,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
