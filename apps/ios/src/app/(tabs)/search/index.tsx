import type { ListedChannel } from "@mrstreamer/core/catalogue/variants";
import { useNavigation } from "expo-router";
import { useCallback, useDeferredValue, useLayoutEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet } from "react-native";
import { playChannel, useCatalogue } from "../../../account.ts";
import { searchChannels } from "../../../library.ts";
import { usePlayback } from "../../../playback.ts";
import { ChannelRow, Message, useRowHeight } from "../../../ui.tsx";

/** Live channels by name, matched as the desktop's search matches words. Films and series later. */
export default function Search() {
  const navigation = useNavigation();
  const catalogue = useCatalogue();
  const { phase } = usePlayback();
  const height = useRowHeight();
  const [query, setQuery] = useState("");
  const typed = useDeferredValue(query);
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const found = useMemo(() => (library ? searchChannels(library, typed) : []), [library, typed]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: "Channels",
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          setQuery(event.nativeEvent.text),
      },
    });
  }, [navigation]);

  const watch = useCallback(
    (channel: ListedChannel) =>
      library && playChannel(channel, library.placeOf.get(channel.id) ?? "", { watch: true }),
    [library],
  );
  const playingId = phase.kind === "idle" ? null : phase.channel.id;
  return (
    <FlatList
      style={styles.screen}
      data={found}
      keyExtractor={(channel) => channel.id}
      extraData={playingId}
      renderItem={({ item }) => (
        <ChannelRow
          channel={item}
          detail={library?.placeOf.get(item.id) ?? ""}
          playing={item.id === playingId}
          height={height}
          onPress={watch}
        />
      )}
      getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      ListEmptyComponent={typed.trim() ? <Message text="No channel has that name." /> : undefined}
      testID="search-list"
    />
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: "#000000" } });
