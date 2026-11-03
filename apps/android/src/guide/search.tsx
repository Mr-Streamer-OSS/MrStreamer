import { router, useLocalSearchParams, useSegments } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { destinationIn } from "../navigation/open.ts";
import { Screen } from "../navigation/screen.tsx";
import { useLocale } from "./catalogue.ts";
import { BrowseProgramme, t } from "./grid.tsx";
import { type FoundProgramme, type ProgrammeSearch, localDay } from "./guide.ts";
import { useGuideStart, useListingRevision } from "./hooks.ts";
import { dayLabel, programmeRange } from "./present.ts";
import { BESIDE, guidesHref, param, programmeHref, type ChannelIdentity } from "./routes.ts";
import { guide, useGuideStatus } from "./runtime.ts";
import { Button, Field, Press, Still, text } from "./ui.tsx";

/** Search is owned by this route, so a programme push leaves its query, results and list mounted. */
export function GuideSearchScreen() {
  useGuideStart();
  useLocale();
  useGuideStatus();
  const revision = useListingRevision();
  const params = useLocalSearchParams<{ query?: string }>();
  const query = param(params.query);
  const destination = destinationIn(useSegments());
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
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
        if (!controller.signal.aborted) setRead({ query, value });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRead((before) => ({
            query,
            value: { found: before?.query === query ? before.value.found : [], unsearched: true },
          }));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });

    return () => controller.abort();
  }, [query, revision, attempt]);
  const value = read?.query === query ? read.value : null;
  const now = Date.now();

  const found = (value?.found ?? [])
    .filter((f) => f.programme.stop > now)
    .slice()
    .sort((a, b) => {
      const aNow = a.programme.start <= now,
        bNow = b.programme.start <= now;

      return Number(bNow) - Number(aNow) || a.programme.start - b.programme.start;
    })
    .slice(0, 20);

  const identityOf = (key: string): ChannelIdentity | null => {
    for (const [sourceId, channels] of guide.channels()) {
      const channel = channels.find((c) => c.key === key);

      if (channel) return { sourceId, channelId: channel.id };
    }

    return null;
  };

  return (
    <Screen
      title={t("Search programmes")}
      pushed
      detail={
        selection
          ? {
              title: selection.found.programme.title,
              content: (
                <BrowseProgramme
                  identity={selection.identity}
                  start={selection.found.programme.start}
                  detail={selection.found.programme.detail}
                />
              ),
              onClose: () => setSelection(null),
            }
          : undefined
      }
    >
      <Field
        icon="search"
        label={t("Search programmes")}
        value={query}
        onChangeText={(query) => router.setParams({ query })}
      />
      {busy ? <Still text={t("Searching.")} /> : null}
      {value?.unsearched ? (
        <View style={{ padding: 16, gap: 8 }}>
          <Text accessibilityLiveRegion="polite" style={text.note}>
            {t("Some programmes not searched.")}
          </Text>
          <Button label={t("Guides")} onPress={() => router.push(guidesHref(destination))} />
          <Button label={t("Retry")} onPress={() => retry((n) => n + 1)} />
        </View>
      ) : null}
      <FlatList
        data={found}
        keyExtractor={(f) => `${f.key} ${f.programme.start}`}
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        ListEmptyComponent={
          !busy && value && !found.length ? (
            <Still text={t('Nothing named "{query}"', { query })} />
          ) : undefined
        }
        renderItem={({ item }) => {
          const channel = guide.channel(item.key);
          const day = localDay(item.programme.start);
          const line = `${day.from === localDay(now).from ? "" : `${dayLabel(day, now)} · `}${programmeRange(item.programme)} · ${channel?.title ?? ""}`;

          return (
            <Press
              accessibilityLabel={`${item.programme.title}, ${line}`}
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
              style={{ padding: 16, gap: 4 }}
            >
              <Text style={text.heading}>{item.programme.title}</Text>
              <Text style={text.secondary}>{line}</Text>
            </Press>
          );
        }}
      />
    </Screen>
  );
}
