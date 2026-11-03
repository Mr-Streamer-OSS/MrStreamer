import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useMemo, type ComponentProps } from "react";
import { Alert, FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { describeFailure } from "./failure.ts";
import type { ChannelRow, ConnectedSource, SourcesOwner } from "./sources.ts";

const SECONDARY = "#A3A3A3";
const HAIRLINE = "#1C1C1C";

/**
 * Every source's channels in one list, under a row per source saying whether its channels are
 * loading, failed (with Try again) or listed, and offering Remove.
 */
export function CatalogueScreen({
  owner,
  sources,
  onAdd,
}: {
  owner: SourcesOwner;
  sources: readonly ConnectedSource[];
  onAdd: () => void;
}) {
  const insets = useSafeAreaInsets();
  const rows = useMemo(
    () =>
      sources.flatMap((source) => (source.channels.kind === "ready" ? source.channels.rows : [])),
    [sources],
  );

  const remove = (source: ConnectedSource) =>
    Alert.alert(`Remove ${source.label}?`, "Its login is erased from this phone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void owner.remove(source.id).catch(() => Alert.alert("Couldn't remove this provider.")),
      },
    ]);

  const header = (
    <View style={{ borderBottomWidth: 1, borderColor: HAIRLINE }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: 64,
          paddingLeft: 16,
          paddingRight: 4,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{
            flex: 1,
            color: "#FFFFFF",
            fontSize: 22,
            lineHeight: 28,
            fontWeight: "700",
            letterSpacing: -0.22,
          }}
        >
          Channels
        </Text>
        <IconButton icon="add" label="Add provider" onPress={onAdd} />
      </View>
      {sources.map((source) => {
        const { channels } = source;
        const failed = channels.kind === "failed";
        return (
          <View
            key={source.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 16,
              minHeight: 72,
              paddingLeft: 16,
              paddingRight: 4,
            }}
          >
            {/* The channel rows' badge lane, so source and channel names line up. */}
            <View style={{ width: 48, alignItems: "center", flexShrink: 0 }}>
              <MaterialIcons
                name={source.kind === "m3u" ? "playlist-play" : "dns"}
                size={24}
                color="#FFFFFF"
              />
            </View>
            <View accessible style={{ flex: 1, gap: 4, paddingVertical: 12 }}>
              <Text
                numberOfLines={1}
                style={{ color: "#FFFFFF", fontSize: 16, lineHeight: 20, fontWeight: "500" }}
              >
                {source.label}
              </Text>
              <Text style={{ color: failed ? "#FFFFFF" : SECONDARY, fontSize: 14, lineHeight: 18 }}>
                {channels.kind === "loading"
                  ? "Loading channels"
                  : channels.kind === "failed"
                    ? describeFailure(channels.error)
                    : `${channels.rows.length} channels`}
              </Text>
            </View>
            {channels.kind === "failed" && channels.error.kind !== "needs-secret" ? (
              <IconButton
                icon="refresh"
                label={`Try ${source.label} again`}
                onPress={() => owner.retry(source.id)}
              />
            ) : null}
            <IconButton
              icon="delete-outline"
              label={`Remove ${source.label}`}
              onPress={() => remove(source)}
            />
          </View>
        );
      })}
    </View>
  );

  return (
    <FlatList<ChannelRow>
      data={rows}
      keyExtractor={(row) => row.key}
      ListHeaderComponent={header}
      contentContainerStyle={{ paddingBottom: insets.bottom }}
      renderItem={({ item }) => (
        <View
          accessible
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 16,
            minHeight: 72,
            paddingHorizontal: 16,
          }}
        >
          <View
            importantForAccessibility="no-hide-descendants"
            style={{
              width: 48,
              height: 36,
              flexShrink: 0,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              backgroundColor: "#141414",
            }}
          >
            <Text style={{ color: "#FFFFFF", fontSize: 12, lineHeight: 16, fontWeight: "700" }}>
              {monogram(item.title)}
            </Text>
          </View>
          <View style={{ flex: 1, gap: 4, paddingVertical: 12 }}>
            <Text
              numberOfLines={1}
              style={{ color: "#FFFFFF", fontSize: 16, lineHeight: 20, fontWeight: "500" }}
            >
              {item.title}
            </Text>
            {item.category ? (
              <Text numberOfLines={1} style={{ color: SECONDARY, fontSize: 14, lineHeight: 18 }}>
                {item.category}
              </Text>
            ) : null}
          </View>
        </View>
      )}
    />
  );
}

/** A 48dp icon-only button, named for TalkBack by `label`. */
function IconButton({
  icon,
  label,
  onPress,
}: {
  icon: ComponentProps<typeof MaterialIcons>["name"];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        width: 48,
        height: 48,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <MaterialIcons name={icon} size={24} color="#FFFFFF" />
    </Pressable>
  );
}

/** Up to two initials for a channel's badge: "Harbour HD" is "HH", a one-word "Nova" is "NO". */
function monogram(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const [first, second] = words.map((word) => Array.from(word));
  const letters = second ? [first?.[0], second[0]] : (first ?? []).slice(0, 2);
  return letters.join("").toLocaleUpperCase();
}
