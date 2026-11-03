import { router, useIsFocused, useLocalSearchParams, useSegments } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Text, TextInput, useWindowDimensions, View } from "react-native";
import { Bar, Body, Frame, TextButton, useFrame } from "../live/chrome.tsx";
import { t as liveText } from "../live/copy.ts";
import { destinationIn } from "../navigation/open.ts";
import { IconButton } from "../ui/icon-button.tsx";
import { useLocale } from "./catalogue.ts";
import { Beside, CatalogueNotice, useCatalogueState, t } from "./grid.tsx";
import { type FoundProgramme, type ProgrammeSearch, localDay } from "./guide.ts";
import { useGuideStart, useListingRevision } from "./hooks.ts";
import { dayLabel, initials, programmeRange } from "./present.ts";
import { BESIDE, guidesHref, param, programmeHref, type ChannelIdentity } from "./routes.ts";
import { guide, useGuideStatus } from "./runtime.ts";
import { ProgrammeDetails } from "./schedule-screen.tsx";
import { Press, guideColors } from "./ui.tsx";

/** A status line under the field: Searching., or Nothing named "x". */
const quiet = { color: guideColors.secondary, fontSize: 14, lineHeight: 20, padding: 16 } as const;

/**
 * Guide Search, pushed with its field in the top app bar as Live's Find. The query is the route's,
 * so a programme pushed from it leaves the text, results and list mounted. From 840dp a programme
 * shows beside the results. Some programmes not searched. stays under them with Guides and Retry.
 */
export function GuideSearchScreen() {
  useGuideStart();
  useLocale();
  useGuideStatus();
  const revision = useListingRevision();
  const focused = useIsFocused();
  const params = useLocalSearchParams<{ query?: string }>();
  const [query, setQuery] = useState(() => param(params.query));

  const changeQuery = (text: string) => {
    setQuery(text);
    router.setParams({ query: text });
  };

  const catalogue = useCatalogueState();
  const destination = destinationIn(useSegments());
  const { width } = useWindowDimensions();
  const { layout, framed } = useFrame();
  const [attempt, retry] = useState(0);
  const [read, setRead] = useState<{ query: string; value: ProgrammeSearch } | null>(null);
  const [busy, setBusy] = useState(false);

  const [selection, setSelection] = useState<{
    identity: ChannelIdentity;
    found: FoundProgramme;
  } | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setBusy(false);

      return;
    }

    const controller = new AbortController();
    setBusy(true);
    void guide
      .search(
        query,
        [...guide.channels().values()].flatMap((rows) => rows.map((r) => r.key)),
        { signal: controller.signal },
      )
      .then((value) => {
        if (!controller.signal.aborted)
          setRead((before) => ({
            query,
            value: retain(value, before?.query === query ? before.value : null),
          }));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRead((before) => ({
            query,
            value: retain(
              { found: [], unsearched: true },
              before?.query === query ? before.value : null,
            ),
          }));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });

    return () => controller.abort();
  }, [query, revision, attempt, catalogue.loading, catalogue.failed]);
  const value = read?.query === query ? read.value : null;
  const now = Date.now();

  // Up to 20 programmes on now or later: those on now first, then by start.
  const found = (value?.found ?? [])
    .filter((f) => f.programme.stop > now)
    .sort(
      (a, b) =>
        Number(b.programme.start <= now) - Number(a.programme.start <= now) ||
        a.programme.start - b.programme.start,
    )
    .slice(0, 20);

  // Refill the bounded result set when one of the shown programmes ends.
  const nextEnd = value?.found.length
    ? Math.min(...value.found.map((f) => f.programme.stop))
    : null;

  useEffect(() => {
    if (nextEnd === null || !focused) return;

    const timer = setTimeout(
      () => retry((n) => n + 1),
      Math.min(2_147_483_647, Math.max(0, nextEnd - Date.now())),
    );

    return () => clearTimeout(timer);
  }, [nextEnd, attempt, focused]);

  const identityOf = (key: string): ChannelIdentity | null => {
    for (const [sourceId, channels] of guide.channels()) {
      const channel = channels.find((c) => c.key === key);

      if (channel) return { sourceId, channelId: channel.id };
    }

    return null;
  };

  const field = (
    <TextInput
      autoFocus={!query}
      accessibilityLabel={t("Search programmes")}
      placeholder={t("Search programmes")}
      placeholderTextColor={guideColors.secondary}
      cursorColor={guideColors.text}
      selectionColor={guideColors.focus}
      value={query}
      onChangeText={changeQuery}
      returnKeyType="search"
      style={{
        flex: 1,
        minHeight: 48,
        paddingLeft: 12,
        color: guideColors.text,
        fontSize: 18,
        lineHeight: 24,
      }}
    />
  );

  const pane = selection ? (
    <ProgrammeDetails
      key={`${selection.found.key} ${selection.found.programme.start}`}
      identity={selection.identity}
      start={selection.found.programme.start}
      detail={selection.found.programme.detail}
      pane
    />
  ) : null;

  return (
    <Frame
      framed={framed}
      bar={
        <Bar
          layout={layout}
          framed={framed}
          height={64}
          rule
          leading={{
            icon: "arrow-back",
            label: liveText("Back"),
            onPress: () => (selection ? setSelection(null) : router.back()),
          }}
          title={field}
          trailing={
            query ? (
              <IconButton
                icon="close"
                label={liveText("Clear")}
                color={guideColors.secondary}
                onPress={() => changeQuery("")}
              />
            ) : null
          }
        />
      }
    >
      <Body>
        <Beside detail={pane} onClose={() => setSelection(null)}>
          <FlatList
            data={found}
            keyboardShouldPersistTaps="handled"
            keyExtractor={(f) => `${f.key} ${f.programme.start}`}
            contentContainerStyle={{ paddingBottom: 16 }}
            ListHeaderComponent={
              <>
                <CatalogueNotice {...catalogue} />
                {busy ? (
                  <Text accessibilityLiveRegion="polite" style={quiet}>
                    {t("Searching.")}
                  </Text>
                ) : null}
                {found.length ? (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      paddingTop: 12,
                      paddingBottom: 8,
                      paddingHorizontal: 16,
                      borderBottomWidth: 1,
                      borderColor: guideColors.hairline,
                    }}
                  >
                    <Text
                      accessibilityRole="header"
                      style={{
                        color: guideColors.text,
                        fontSize: 20,
                        lineHeight: 26,
                        fontWeight: "700",
                        letterSpacing: -0.2,
                      }}
                    >
                      {t("Programmes")}
                    </Text>
                    <Text style={{ color: guideColors.secondary, fontSize: 14, lineHeight: 18 }}>
                      {found.length}
                    </Text>
                  </View>
                ) : null}
              </>
            }
            ListEmptyComponent={
              !busy &&
              !catalogue.failed &&
              !catalogue.loading &&
              value &&
              !value.unsearched &&
              !found.length ? (
                <Text accessibilityLiveRegion="polite" style={quiet}>
                  {t('Nothing named "{query}"', { query })}
                </Text>
              ) : undefined
            }
            renderItem={({ item }) => {
              const channel = guide.channel(item.key)?.title ?? "";
              const day = localDay(item.programme.start);
              const line = `${day.from === localDay(now).from ? "" : `${dayLabel(day, now)} · `}${programmeRange(item.programme)} · ${channel}`;

              const shown =
                selection?.found.key === item.key &&
                selection.found.programme.start === item.programme.start;

              return (
                <Press
                  accessibilityLabel={`${item.programme.title}, ${line}`}
                  accessibilityState={{ selected: shown }}
                  onPress={() => {
                    const identity = identityOf(item.key);

                    if (!identity) return;

                    if (width >= BESIDE) setSelection({ identity, found: item });
                    else
                      router.push(
                        programmeHref(
                          destination,
                          identity,
                          item.programme.start,
                          item.programme.detail,
                        ),
                      );
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 16,
                    minHeight: 72,
                    paddingVertical: 8,
                    paddingHorizontal: 16,
                    backgroundColor: shown ? guideColors.current : undefined,
                  }}
                >
                  <View
                    style={{
                      width: 48,
                      height: 36,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 4,
                      backgroundColor: guideColors.surface,
                    }}
                  >
                    <Text
                      style={{
                        color: guideColors.text,
                        fontSize: 12,
                        lineHeight: 16,
                        fontWeight: "700",
                      }}
                    >
                      {initials(channel)}
                    </Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{
                        color: guideColors.text,
                        fontSize: 15,
                        lineHeight: 20,
                        fontWeight: "500",
                      }}
                    >
                      {item.programme.title}
                    </Text>
                    <Text style={{ color: guideColors.secondary, fontSize: 13, lineHeight: 18 }}>
                      {line}
                    </Text>
                  </View>
                </Press>
              );
            }}
          />
        </Beside>
        {value?.unsearched ? (
          <View
            style={{
              gap: 4,
              paddingTop: 12,
              paddingBottom: 4,
              paddingLeft: 16,
              paddingRight: 4,
              borderTopWidth: 1,
              borderColor: guideColors.hairline,
            }}
          >
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: guideColors.text, fontSize: 14, lineHeight: 20, paddingRight: 12 }}
            >
              {t("Some programmes not searched.")}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end" }}>
              <TextButton
                label={t("Guides")}
                strong
                onPress={() => router.push(guidesHref(destination))}
              />
              <TextButton label={t("Retry")} strong onPress={() => retry((n) => n + 1)} />
            </View>
          </View>
        ) : null}
      </Body>
    </Frame>
  );
}

/** Keep useful same-query results during partial reads; fresh identities replace retained ones. */
function retain(value: ProgrammeSearch, previous: ProgrammeSearch | null): ProgrammeSearch {
  const keys = new Set([...guide.channels().values()].flatMap((rows) => rows.map((r) => r.key)));
  const now = Date.now();
  const merged = new Map<string, FoundProgramme>();

  for (const found of [...(value.unsearched ? (previous?.found ?? []) : []), ...value.found]) {
    if (keys.has(found.key) && found.programme.stop > now)
      merged.set(`${found.key} ${found.programme.start}`, found);
  }

  return {
    ...value,
    found: [...merged.values()]
      .sort(
        (a, b) =>
          Number(b.programme.start <= now) - Number(a.programme.start <= now) ||
          a.programme.start - b.programme.start,
      )
      .slice(0, 20),
  };
}
