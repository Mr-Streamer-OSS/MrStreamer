import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useState } from "react";
import { ActionSheetIOS, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import {
  playChannel,
  reloadAllChannels,
  retry,
  retryChannels,
  useCatalogue,
  useRoster,
  type Member,
} from "../../../account.ts";
import { failureOf } from "../../../errors.ts";
import { tabHref } from "../../../header.tsx";
import type { Channel, Library, Region } from "../../../library.ts";
import { playingChannel, usePlayback } from "../../../playback.ts";
import { useSavedState, writeState } from "../../../storage.ts";
import { TextTabs } from "../../../titles-ui.tsx";
import {
  ChannelRow,
  colors,
  Notice,
  PlaceholderRows,
  TextButton,
  useRowHeight,
} from "../../../ui.tsx";

/** The text tab for all of a country's categories. Provider category ids are never "*". */
const ALL = "*";

/**
 * Live: one country's channels, or one of its categories', in a virtualised list of rows of one
 * fixed height. The country is the first item of the row of text tabs above the list, its
 * categories the rest; the top bar is the shared one. Rows show the channel's category until iOS
 * reads a guide, which brings now and next.
 */
export default function Live() {
  const catalogue = useCatalogue();
  const roster = useRoster();
  const height = useRowHeight();
  const providers = roster.kind === "ready" ? roster.members : [];
  // One provider is named; several are "your providers".
  const host = providers.length === 1 && providers[0] ? providers[0].label : "";
  if (catalogue.kind === "loading") {
    return (
      <View style={styles.screen}>
        <Text style={styles.note} accessibilityLiveRegion="polite">
          {host ? `Loading channels from ${host}` : "Loading channels"}
        </Text>
        <PlaceholderRows height={height} />
      </View>
    );
  }
  if (catalogue.kind === "failed") {
    const failure = failureOf(catalogue.error, catalogue.member.entry.server);
    return (
      <View style={styles.screen}>
        <Notice
          failure={{
            headline: "Couldn't load channels",
            advice: [failure.headline, failure.advice].filter(Boolean).join(". "),
          }}
          actions={[
            { label: "Try again", onPress: retryChannels },
            { label: "Provider settings", onPress: openSettings },
          ]}
        />
      </View>
    );
  }
  if (catalogue.library.regions.length === 0) {
    return (
      <View style={styles.screen}>
        <Notice
          failure={{
            headline: "No live channels",
            advice: `${host || "Your providers"} ${host ? "lists" : "list"} no live channels.`,
          }}
          actions={[{ label: "Reload", onPress: reloadAllChannels }]}
        />
      </View>
    );
  }
  return <Channels library={catalogue.library} failing={catalogue.failing} height={height} />;
}

/** Settings, on Live's own stack. */
const openSettings = () => router.push(tabHref("live", "settings"));

/**
 * One line for a provider whose channels didn't load, or whose password the iPhone no longer
 * gives back: its channels as they were stay in the list, and the others carry on.
 */
function Failing({ member }: { member: Member }) {
  const { entry, label, needsSecret } = member;
  return (
    <View style={styles.failing} testID={`live-failing-${entry.id}`}>
      <Text style={styles.failingText} numberOfLines={2}>
        {needsSecret
          ? `Enter the password for ${label} in Settings.`
          : `Couldn't load channels from ${label}.`}
      </Text>
      {needsSecret ? (
        <TextButton label="Settings" onPress={openSettings} />
      ) : (
        <TextButton label="Retry" onPress={() => retry(entry.id)} />
      )}
    </View>
  );
}

function Channels({
  library,
  failing,
  height,
}: {
  library: Library;
  failing: readonly Member[];
  height: number;
}) {
  const saved = useSavedState();
  const { phase } = usePlayback();
  const [shelfId, setShelfId] = useState<string>(ALL);
  const found = library.regions.find((each) => each.name === saved.region);
  const region = found ?? library.regions[0]!;
  const shelf = region.shelves.find((each) => each.id === shelfId) ?? null;
  const channels = shelf?.channels ?? region.channels;

  const choose = useCallback((next: Region) => {
    writeState((state) => ({ ...state, region: next.name }));
    setShelfId(ALL);
  }, []);

  const playing = playingChannel(phase);
  const watch = useCallback(
    (channel: Channel) =>
      playChannel(channel, library.placeOf.get(channel.key) ?? "", { watch: true }),
    [library],
  );
  const tabs =
    region.shelves.length > 1
      ? [
          { value: ALL, label: "All" },
          ...region.shelves.map((each) => ({ value: each.id, label: each.title })),
        ]
      : [];
  return (
    <View style={styles.screen}>
      {failing.map((member) => (
        <Failing key={member.entry.id} member={member} />
      ))}
      {saved.region && !found ? (
        <Text style={styles.note}>{`${saved.region} isn't listed any more.`}</Text>
      ) : null}
      {tabs.length > 0 || library.regions.length > 1 ? (
        <View style={styles.tabs}>
          <TextTabs
            lead={
              library.regions.length > 1 ? (
                <Country regions={library.regions} region={region} onChoose={choose} />
              ) : null
            }
            tabs={tabs}
            value={shelf?.id ?? ALL}
            onChange={setShelfId}
          />
        </View>
      ) : null}
      {/* The tabs sit above the list, not in it, so every row's offset stays height × index. */}
      <FlatList
        key={`${region.name}\n${shelf?.id ?? ALL}`}
        style={styles.screen}
        data={channels}
        keyExtractor={(channel) => channel.key}
        extraData={playing}
        renderItem={({ item }) => (
          <ChannelRow
            channel={item}
            detail={library.placeOf.get(item.key) ?? ""}
            playing={item.key === playing}
            height={height}
            onPress={watch}
          />
        )}
        getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
        contentInsetAdjustmentBehavior="automatic"
        initialNumToRender={16}
        maxToRenderPerBatch={16}
        windowSize={9}
        removeClippedSubviews
        testID="live-list"
      />
    </View>
  );
}

/** The country, first in the row of tabs: pressing it lists the others as a system sheet. */
function Country({
  regions,
  region,
  onChoose,
}: {
  regions: readonly Region[];
  region: Region;
  onChoose: (region: Region) => void;
}) {
  const open = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Country",
        options: [
          ...regions.map((each) => (each === region ? `✓ ${each.name}` : each.name)),
          "Cancel",
        ],
        cancelButtonIndex: regions.length,
      },
      (index) => {
        const next = regions[index];
        if (next) onChoose(next);
      },
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Country, ${region.name}`}
      accessibilityHint="Lists the other countries"
      onPress={open}
      style={({ pressed }) => [styles.country, pressed && styles.pressed]}
      testID="live-country"
    >
      <Text style={styles.countryName} numberOfLines={1}>
        {region.name}
      </Text>
      <SymbolView name="chevron.down" size={12} tintColor={colors.text} weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  note: { color: colors.text, fontSize: 15, marginHorizontal: 16, marginVertical: 12 },
  failing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
  },
  failingText: { color: colors.text, fontSize: 15, flex: 1 },
  tabs: { borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
  country: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44, maxWidth: 200 },
  countryName: { color: colors.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  pressed: { opacity: 0.5 },
});
