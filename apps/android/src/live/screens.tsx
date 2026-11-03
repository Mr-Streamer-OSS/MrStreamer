import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useLocalSearchParams } from "expo-router";
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { sources } from "../bootstrap/sources.ts";
import type { ChannelRow, Sources } from "../connect/sources.ts";
import { ConnectScreen } from "../connect/connect-screen.tsx";
import { hrefOn, type NavigationLayout } from "../navigation/destinations.ts";
import { Screen } from "../navigation/screen.tsx";
import { store, useStore } from "../platform/store.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import { IconButton, type IconName } from "../ui/icon-button.tsx";
import { Sheet } from "../ui/sheet.tsx";
import { colors } from "../ui/theme.ts";
import { TopAppBar } from "../ui/top-app-bar.tsx";
import { useLocale } from "./catalogue.ts";
import {
  Bar,
  Body,
  FitSheet,
  Frame,
  SheetRow,
  SheetTitle,
  StatusLine,
  TextButton,
  useFrame,
  useGaps,
} from "./chrome.tsx";
import { t } from "./copy.ts";
import { discover, findGroups, type Group } from "./discovery.ts";
import { identity, keyOf, resolve, type ChannelList, type Entry } from "./model.ts";
import { lists } from "./runtime.ts";
import { FAVOURITES } from "./store.ts";
import { Channel, Empty, GapRows, ListsSheet, NavRow, StillRows } from "./ui.tsx";

/** Find's text, kept while Find is on the stack and when it opens again. */
const findQuery = store("");

const root = "/(tabs)/(live)" as const;

const GuideGrid = lazy(() =>
  import("../guide/grid.tsx").then((module) => ({ default: module.GuideGrid })),
);

type Tab = "For you" | "Categories" | "All" | "Guide";

const count = (rows: number) => t("{count} channels", { count: rows });

/** How many of a list's channels open now; unsaid while a provider is still loading. */
function opens(list: ChannelList, state: Sources, loading: boolean) {
  if (loading) return undefined;

  return String(list.entries.filter((entry) => resolve(entry, state).kind === "listed").length);
}

const openList = (list: ChannelList) =>
  list.id === FAVOURITES
    ? router.push(`${root}/favourites`)
    : router.push({ pathname: `${root}/list/[id]`, params: { id: list.id } });

/** Shortcuts scroll away before the phone tabs stick above the list's rows. */
function BrowseRows<Item>({
  data,
  keyExtractor,
  renderItem,
  header,
  tabs,
  empty,
  footer,
}: {
  data: readonly Item[];
  keyExtractor: (item: Item) => string;
  renderItem: (item: Item, index: number) => ReactNode;
  header?: ReactNode;
  tabs?: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
}) {
  const rows = data.map((item) => ({ kind: "row" as const, item }));
  const cells = tabs ? [{ kind: "tabs" as const }, ...rows] : rows;

  return (
    <FlatList
      style={{ flex: 1 }}
      data={cells}
      keyExtractor={(cell) => (cell.kind === "tabs" ? "tabs" : keyExtractor(cell.item))}
      renderItem={({ item: cell, index }) =>
        cell.kind === "tabs" ? (
          <View style={{ backgroundColor: colors.background }}>{tabs}</View>
        ) : (
          renderItem(cell.item, index - (tabs ? 1 : 0))
        )
      }
      ListHeaderComponent={<>{header}</>}
      stickyHeaderIndices={tabs ? [1] : undefined}
      ListFooterComponent={
        <>
          {!data.length ? empty : null}
          {footer}
        </>
      }
    />
  );
}

/**
 * Channel rows with one Lists sheet for whichever is held, and still rows after them while a
 * provider is loading.
 */
function Channels({
  entries,
  still,
  empty,
  header,
  tabs,
  section,
  footer,
}: {
  entries: readonly Entry[];
  still: boolean;
  empty?: ReactNode;
  header?: ReactNode;
  tabs?: ReactNode;
  section?: ReactNode;
  footer?: (onLists: (entry: Entry) => void) => ReactNode;
}) {
  const [held, setHeld] = useState<Entry | null>(null);

  return (
    <>
      <BrowseRows
        data={entries}
        keyExtractor={keyOf}
        renderItem={(item, index) => (
          <>
            {index === 0 ? section : null}
            <Channel entry={item} onLists={setHeld} />
          </>
        )}
        header={header}
        tabs={tabs}
        footer={
          <>
            {still ? <StillRows /> : null}
            {footer?.(setHeld)}
          </>
        }
        empty={
          <>
            {section}
            {still ? null : empty}
          </>
        }
      />
      <ListsSheet entry={held} onClose={() => setHeld(null)} />
    </>
  );
}

/** Live's tabs after the country it shows: For you, Categories and All. Scrolls when text grows. */
function Tabs({
  tab,
  onTab,
  country,
  onCountry,
}: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  country: string;
  onCountry: () => void;
}) {
  const label = country || t("All countries");
  const { focused, handlers } = useKeyboardFocus();

  return (
    <View style={{ borderBottomWidth: 1, borderColor: colors.hairline }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ minHeight: 48, paddingLeft: 8, alignItems: "stretch" }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Country, {name}", { name: label })}
          onPress={onCountry}
          {...handlers}
          android_ripple={{ color: colors.ripple }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 2,
            paddingHorizontal: 8,
            backgroundColor: focused ? colors.focus : undefined,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "500" }}>
            {label}
          </Text>
          <MaterialIcons name="arrow-drop-down" size={20} color={colors.text} />
        </Pressable>
        <View
          style={{ alignSelf: "center", width: 1, height: 24, backgroundColor: colors.hairline }}
        />
        {(["For you", "Categories", "All", "Guide"] as const).map((name) => (
          <TabButton
            key={name}
            label={t(name)}
            selected={tab === name}
            onPress={() => onTab(name)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function TabButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        justifyContent: "center",
        paddingHorizontal: 12,
        paddingTop: selected ? 3 : 0,
        borderBottomWidth: selected ? 3 : 0,
        borderColor: colors.text,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <Text
        style={{
          color: selected ? colors.text : colors.secondary,
          fontSize: 14,
          lineHeight: 18,
          fontWeight: selected ? "700" : "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** One of the tablet header's shortcuts: a 20dp icon and its 14sp label. */
function Chip({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 48,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <MaterialIcons name={icon} size={20} color={colors.text} />
      <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "500" }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Live's top: on phones the shared top app bar; shortcuts scroll with the channels;
 * beside the rail one 56dp header with them as its shortcuts.
 */
function LiveTop({
  layout,
  framed,
  shortcuts,
}: {
  layout: NavigationLayout;
  framed: ReturnType<typeof useFrame>["framed"];
  shortcuts: readonly {
    id: string;
    icon: IconName;
    label: string;
    count?: string | undefined;
    onPress: () => void;
  }[];
}) {
  if (layout === "bar")
    return (
      <>
        <TopAppBar title={t("Live")} layout={layout} insets={framed} />
      </>
    );

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 24,
        minHeight: framed.top + 56,
        paddingTop: framed.top,
        paddingLeft: framed.left + 24,
        paddingRight: framed.right + 24,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{
          color: colors.text,
          fontSize: 22,
          lineHeight: 28,
          fontWeight: "700",
          letterSpacing: -0.22,
        }}
      >
        {t("Live")}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end", gap: 24 }}
      >
        {shortcuts.map((shortcut) => (
          <Chip key={shortcut.id} {...shortcut} />
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * Live: every provider's channels together, opening on All of every country. Favourites, each
 * list and Find head it; Country is a sheet, and the status line names a provider still loading or
 * failed while what loaded shows at once.
 */
export function LiveScreen() {
  useLocale();
  const { layout, framed } = useFrame();
  const state = useStore(sources.state);
  const saved = useStore(lists.state);
  const { country = "" } = useLocalSearchParams<{ country?: string }>();
  const [tab, setTab] = useState<Tab>("All");
  const [choosing, setChoosing] = useState(false);
  const [adding, setAdding] = useState(false);
  const view = discover(state);
  const gaps = useGaps();
  const loading = view.restoring || view.loading.length > 0;
  const chosen = country ? view.countries.find((group) => group.name === country) : undefined;
  const rows = useMemo(() => (country ? (chosen?.rows ?? []) : view.rows), [country, chosen, view]);
  const inCountry = useMemo(() => new Set(rows), [rows]);
  const all = saved.lists;
  const favourites = all.find((list) => list.id === FAVOURITES);

  const shortcuts = [
    ...[...(favourites ? [favourites] : []), ...all.filter((list) => list.id !== FAVOURITES)].map(
      (list) => ({
        id: list.id,
        icon: (list.id === FAVOURITES ? "star" : "list") as IconName,
        label: list.id === FAVOURITES ? t("Favourites") : list.name,
        count: opens(list, state, loading),
        onPress: () => openList(list),
      }),
    ),
    {
      id: "find",
      icon: "search" as const,
      label: t("Find countries or categories"),
      onPress: () => router.push(`${root}/find`),
    },
    {
      id: "providers",
      icon: "dns" as const,
      label: t("Providers"),
      onPress: () => router.push(hrefOn("(live)", "settings")),
    },
  ];

  const header = (
    <>
      {layout === "bar"
        ? shortcuts.map((shortcut) => <NavRow key={shortcut.id} size="shortcut" {...shortcut} />)
        : null}
      {saved.kind === "failed" ? (
        <Empty
          title={t("Couldn't read your lists.")}
          action={<TextButton label={t("Try again")} onPress={lists.read} />}
        />
      ) : null}
    </>
  );

  const empty =
    state.kind === "ready" && state.sources.length === 0 ? (
      <Empty
        title={t("No live channels")}
        action={<TextButton label={t("Add provider")} onPress={() => setAdding(true)} />}
      />
    ) : loading || gaps.failed ? null : country && !chosen ? (
      <Empty title={t("{name} isn't listed any more.", { name: country })} />
    ) : (
      <Empty title={t("Your providers list no channels.")} />
    );

  const categories = view.categories
    .map((group) => ({ name: group.name, rows: group.rows.filter((row) => inCountry.has(row)) }))
    .filter((group) => group.rows.length);

  const forYou = (favourites?.entries ?? []).filter((entry) => {
    const found = resolve(entry, state);

    return !country || found.kind !== "listed" || inCountry.has(found.row);
  });

  const tabs = (
    <Tabs tab={tab} onTab={setTab} country={country} onCountry={() => setChoosing(true)} />
  );

  const scrollingTabs = layout === "bar" ? tabs : undefined;

  return (
    <Frame framed={framed} bar={<LiveTop layout={layout} framed={framed} shortcuts={shortcuts} />}>
      <Body>
        {layout !== "bar" ? tabs : null}
        {tab === "Guide" ? (
          <>
            {layout === "bar" ? tabs : null}
            <Suspense fallback={null}>
              <GuideGrid country={country} />
            </Suspense>
          </>
        ) : tab === "All" ? (
          <Channels
            header={header}
            tabs={scrollingTabs}
            entries={rows.map(identity)}
            still={loading}
            empty={empty}
          />
        ) : tab === "For you" ? (
          <Channels
            header={header}
            tabs={scrollingTabs}
            section={<SheetTitle>{t("Favourites")}</SheetTitle>}
            entries={saved.kind === "ready" ? forYou : []}
            still={loading}
            empty={
              saved.kind !== "ready" ? null : !favourites?.entries.length ? (
                <Empty title={t("No favourites yet.")} body={t("Star a channel in Live.")} />
              ) : loading || gaps.failed ? null : (
                <Empty title={t("No favourites in this country.")} />
              )
            }
            footer={(onLists) =>
              categories.slice(0, 4).map((group) => (
                <View key={group.name}>
                  <NavRow
                    icon="label-outline"
                    label={group.name}
                    count={count(group.rows.length)}
                    onPress={() =>
                      router.push({
                        pathname: `${root}/category`,
                        params: { name: group.name, country },
                      })
                    }
                  />
                  {group.rows.slice(0, 6).map((row) => (
                    <Channel key={row.key} entry={identity(row)} onLists={onLists} />
                  ))}
                </View>
              ))
            }
          />
        ) : (
          <BrowseRows
            header={header}
            tabs={scrollingTabs}
            data={categories}
            keyExtractor={(group) => group.name}
            renderItem={(item) => (
              <NavRow
                icon="label-outline"
                label={item.name}
                count={count(item.rows.length)}
                onPress={() =>
                  router.push({
                    pathname: `${root}/category`,
                    params: { name: item.name, country },
                  })
                }
              />
            )}
            footer={loading ? <StillRows count={3} /> : undefined}
            empty={loading ? undefined : (empty ?? undefined)}
          />
        )}
        <StatusLine />
      </Body>
      <CountrySheet
        visible={choosing}
        countries={view.countries}
        total={view.rows.length}
        chosen={country}
        onChoose={(name) => {
          router.setParams({ country: name });
          setChoosing(false);
        }}
        onClose={() => setChoosing(false)}
      />
      <Sheet visible={adding} label={t("Add provider")} onClose={() => setAdding(false)}>
        <ConnectScreen
          owner={sources}
          onDone={() => setAdding(false)}
          onConnected={() => setAdding(false)}
        />
      </Sheet>
    </Frame>
  );
}

/** Country: every country with its channels that loaded, and which providers they leave out. */
function CountrySheet({
  visible,
  countries,
  total,
  chosen,
  onChoose,
  onClose,
}: {
  visible: boolean;
  countries: readonly Group[];
  total: number;
  chosen: string;
  onChoose: (name: string) => void;
  onClose: () => void;
}) {
  const { loading, failed } = useGaps();

  return (
    <FitSheet visible={visible} label={t("Country")} onClose={onClose}>
      <SheetTitle>{t("Country")}</SheetTitle>
      <SheetRow
        role="radio"
        icon={chosen ? undefined : "check"}
        selected={!chosen}
        label={t("All countries")}
        trailing={count(total)}
        onPress={() => onChoose("")}
      />
      {countries.map((group) => (
        <SheetRow
          key={group.name}
          role="radio"
          icon={chosen === group.name ? "check" : undefined}
          selected={chosen === group.name}
          label={group.name}
          trailing={count(group.rows.length)}
          onPress={() => onChoose(group.name)}
        />
      ))}
      {[failed, loading].map((gap) =>
        gap ? (
          <Text
            key={gap}
            style={{
              minHeight: 48,
              paddingTop: 8,
              paddingLeft: 64,
              paddingRight: 24,
              color: colors.secondary,
              fontSize: 14,
              lineHeight: 18,
            }}
          >
            {gap}
          </Text>
        ) : null,
      )}
    </FitSheet>
  );
}

/**
 * Find countries or categories, pushed with its field in the top app bar. A country returns to
 * Live showing it, on the tab Live was on; a category opens its channels; Back from there finds
 * the text and results as they were. Nothing here plays.
 */
export function FindScreen() {
  useLocale();
  const { layout, framed } = useFrame();
  const query = useStore(findQuery);
  const view = discover(useStore(sources.state));
  const gaps = useGaps();
  const countries = findGroups(view.countries, query);
  const categories = findGroups(view.categories, query);

  const result = (group: Group, kind: "country" | "category") => (
    <NavRow
      key={`${kind}:${group.name}`}
      icon={kind === "country" ? "public" : "label-outline"}
      label={group.name}
      count={count(group.rows.length)}
      accessibilityLabel={`${group.name}, ${t(kind)}, ${count(group.rows.length)}`}
      onPress={() =>
        kind === "country"
          ? router.dismissTo({ pathname: root, params: { country: group.name } })
          : router.push({ pathname: `${root}/category`, params: { name: group.name } })
      }
    />
  );

  const field = (
    <TextInput
      autoFocus
      accessibilityLabel={t("Countries or categories")}
      placeholder={t("Countries or categories")}
      placeholderTextColor={colors.secondary}
      cursorColor={colors.text}
      selectionColor={colors.focus}
      value={query}
      onChangeText={(text) => findQuery.set(text)}
      returnKeyType="search"
      style={{ flex: 1, minHeight: 48, paddingLeft: 8, color: colors.text, fontSize: 16 }}
    />
  );

  return (
    <Frame
      framed={framed}
      bar={
        <Bar
          layout={layout}
          framed={framed}
          rule
          leading={{ icon: "arrow-back", label: t("Back"), onPress: () => router.back() }}
          title={field}
          trailing={
            query ? (
              <IconButton icon="close" label={t("Clear")} onPress={() => findQuery.set("")} />
            ) : null
          }
        />
      }
    >
      <Body>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: 8 }}>
          {countries.map((group) => result(group, "country"))}
          {categories.map((group) => result(group, "category"))}
          {!countries.length && !categories.length && query ? (
            <Empty
              title={t(
                gaps.failed
                  ? "No country or category is called “{query}” in the channels that loaded."
                  : gaps.loading
                    ? "No country or category is called “{query}” yet."
                    : "No country or category is called “{query}”.",
                { query },
              )}
            />
          ) : null}
          <GapRows />
        </ScrollView>
      </Body>
    </Frame>
  );
}

/**
 * A category's channels, in the country Live showed when it opened. Back returns to Live or Find
 * as it was.
 */
export function CategoryScreen() {
  useLocale();
  const { name = "", country = "" } = useLocalSearchParams<{ name: string; country?: string }>();
  const view = discover(useStore(sources.state));
  const group = view.categories.find((each) => each.name === name);
  const loading = view.restoring || view.loading.length > 0;

  const allowed = new Set<ChannelRow>(
    country ? (view.countries.find((each) => each.name === country)?.rows ?? []) : view.rows,
  );

  return (
    <Screen pushed title={name}>
      <Body>
        {group ? (
          <Channels
            entries={group.rows.filter((row) => allowed.has(row)).map(identity)}
            still={loading}
          />
        ) : (
          <View style={{ flex: 1 }}>
            {loading ? (
              <StillRows />
            ) : view.failed.length ? null : (
              <Empty title={t("This category isn't listed any more.")} />
            )}
          </View>
        )}
        <StatusLine />
      </Body>
    </Screen>
  );
}
