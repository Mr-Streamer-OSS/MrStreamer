import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useDeferredValue, useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { retry, retryChannels, useCatalogue, useRoster } from "./account.ts";
import { failureOf } from "./errors.ts";
import { tabHref } from "./header.tsx";
import { searchPlaces, type Library, type Place } from "./library.ts";
import { categoryHref, chooseCountry } from "./live-screen.tsx";
import { Docked, libraryStatus, useDockInset } from "./loading.tsx";
import { colors, Message, Notice, TextButton } from "./ui.tsx";

// Live's Find countries or categories, pushed on Live's stack: a field that finds countries (the
// providers' groups, which can be languages or labels) and categories by name in every provider's
// channels, whatever country Live shows and however few shelves For you has. A country goes back
// to Live showing it, on the tab Live showed; a category opens all its channels, every provider's
// in it, on its own screen, and Back from there finds the text and results as they were. Cancel,
// and Back, go to Live as it was; Clear empties the field and stays. Nothing here plays. Each
// opening starts with an empty field. Results are of the channels as they show now: a reload or a
// failure keeps the last ones, and says so in the status line, as Live does.

/** Live's discovery screen. */
export function DiscoverScreen() {
  const catalogue = useCatalogue();
  const roster = useRoster();
  const [query, setQuery] = useState("");
  // Results follow the latest text; typing goes on while an earlier search is drawn.
  const typed = useDeferredValue(query);
  const providers = roster.kind === "ready" ? roster.members : [];
  const status =
    catalogue.kind === "failed"
      ? null
      : libraryStatus(providers, {
          channels: true,
          retry,
          settings: () => router.push(tabHref("live", "settings")),
        });
  return (
    <Docked status={status}>
      <View style={styles.screen}>
        <View style={styles.bar}>
          <View style={styles.field}>
            <SymbolView name="magnifyingglass" size={17} tintColor={colors.dim} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              autoFocus
              placeholder="Countries or categories"
              placeholderTextColor={colors.dim}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              keyboardAppearance="dark"
              selectionColor="#FFFFFF"
              accessibilityLabel="Find countries or categories"
              style={styles.input}
              testID="discover-field"
            />
            {query ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear"
                onPress={() => setQuery("")}
                style={styles.clear}
                testID="discover-clear"
              >
                <SymbolView name="xmark.circle.fill" size={17} tintColor={colors.dim} />
              </Pressable>
            ) : null}
          </View>
          <TextButton label="Cancel" onPress={() => router.back()} testID="discover-cancel" />
        </View>
        {catalogue.kind === "ready" ? (
          <Results library={catalogue.library} query={typed} />
        ) : catalogue.kind === "loading" ? (
          <Message text="Channels are still loading." />
        ) : (
          <Notice
            failure={{
              headline: "Couldn't load channels",
              advice: failureOf(catalogue.error, catalogue.member.entry.server).headline,
            }}
            actions={[{ label: "Try again", onPress: retryChannels }]}
          />
        )}
      </View>
    </Docked>
  );
}

/** The countries, then the categories, `query` finds in `library`. */
function Results({ library, query }: { library: Library; query: string }) {
  const inset = useDockInset();
  const sections = useMemo(() => {
    const found = searchPlaces(library, query);
    const countries = found.filter((place) => place.kind === "country");
    const categories = found.filter((place) => place.kind === "category");
    return [
      ...(countries.length > 0 ? [{ title: "Countries", data: countries }] : []),
      ...(categories.length > 0 ? [{ title: "Categories", data: categories }] : []),
    ];
  }, [library, query]);
  const searched = query.trim();
  if (library.regions.length === 0) return <Message text="Your providers list no channels." />;
  if (searched && sections.length === 0) {
    return <Message text={`No country or category is called “${searched}”.`} />;
  }
  return (
    <SectionList
      style={styles.screen}
      sections={sections}
      keyExtractor={keyOf}
      renderSectionHeader={({ section }) => (
        <Text style={styles.section} accessibilityRole="header">
          {`${section.title} · ${section.data.length}`}
        </Text>
      )}
      renderItem={({ item }) => <Row place={item} />}
      keyboardDismissMode="on-drag"
      // A tap on a result opens it, with the keyboard up or not.
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 24 + inset }}
      testID="discover-results"
    />
  );
}

const keyOf = (place: Place) =>
  place.kind === "country" ? `country\n${place.region.name}` : `category\n${place.shelf.id}`;

/** "42 channels", or "1 channel". */
const channelCount = (count: number) => `${count} ${count === 1 ? "channel" : "channels"}`;

/**
 * A country, with how many channels it has; or a category, with its country unless it stands
 * alone, so two of one name read apart.
 */
function Row({ place }: { place: Place }) {
  const { region } = place;
  const name = place.kind === "country" ? region.name : place.shelf.title;
  const count = (place.kind === "country" ? region : place.shelf).channels.length;
  const context =
    place.kind === "category" && place.shelf.title !== region.name ? region.name : null;
  const line = [context, channelCount(count)].filter(Boolean).join(" · ");
  const open = () => {
    if (place.kind === "category") return router.push(categoryHref(place));
    chooseCountry(region);
    router.back();
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[name, place.kind, line].join(", ")}
      onPress={open}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`discover-${keyOf(place).replace("\n", "-")}`}
    >
      <View style={styles.names}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.line} numberOfLines={1}>
          {line}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={13} tintColor={colors.text} weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  pressed: { opacity: 0.5 },
  // The field and headings as Search draws them.
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  field: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 40,
    borderRadius: 10,
    paddingLeft: 10,
    backgroundColor: colors.fill,
  },
  input: { flex: 1, color: colors.text, fontSize: 17, paddingVertical: 8 },
  clear: { width: 44, height: 40, alignItems: "center", justifyContent: "center" },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  names: { flex: 1, minWidth: 0 },
  name: { color: colors.text, fontSize: 17 },
  line: { color: colors.dim, fontSize: 13, marginTop: 2 },
});
