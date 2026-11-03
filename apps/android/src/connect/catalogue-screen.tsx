import { useMemo } from "react";
import { Alert, FlatList, Pressable, Text, View } from "react-native";
import { describeFailure } from "./failure.ts";
import type { ChannelRow, ConnectedSource, SourcesOwner } from "./sources.ts";

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
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", padding: 16 }}>
        <Text
          accessibilityRole="header"
          style={{ flex: 1, color: "#ffffff", fontSize: 22, fontWeight: "700" }}
        >
          Channels
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onAdd}
          style={{ minHeight: 48, justifyContent: "center" }}
        >
          <Text style={{ color: "#ffffff", fontSize: 16 }}>Add provider</Text>
        </Pressable>
      </View>
      {sources.map((source) => (
        <View key={source.id} style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={{ flex: 1, color: "#ffffff", fontSize: 16 }}>{source.label}</Text>
            {source.channels.kind === "failed" && source.channels.error.kind !== "needs-secret" ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => owner.retry(source.id)}
                style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 8 }}
              >
                <Text style={{ color: "#ffffff" }}>Try again</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${source.label}`}
              onPress={() => remove(source)}
              style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 8 }}
            >
              <Text style={{ color: "#ffffff" }}>Remove</Text>
            </Pressable>
          </View>
          <Text style={{ color: "#bdbdbd" }}>
            {source.channels.kind === "loading"
              ? "Loading channels…"
              : source.channels.kind === "failed"
                ? describeFailure(source.channels.error)
                : `${source.channels.rows.length} channels`}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <FlatList<ChannelRow>
      data={rows}
      keyExtractor={(row) => row.key}
      ListHeaderComponent={header}
      renderItem={({ item }) => (
        <View style={{ paddingHorizontal: 16, minHeight: 56, justifyContent: "center" }}>
          <Text style={{ color: "#ffffff", fontSize: 16 }}>{item.title}</Text>
          {item.category ? <Text style={{ color: "#bdbdbd" }}>{item.category}</Text> : null}
        </View>
      )}
    />
  );
}
