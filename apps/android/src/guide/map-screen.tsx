import { catalogueFailures, retryGuideChannels } from "./runtime.ts";
import type { Listing } from "@mrstreamer/contracts/guide";
import { formatDate, t as sharedT } from "@mrstreamer/core/i18n";
import { router, useLocalSearchParams, useSegments } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ScrollView,
  SectionList,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sources } from "../bootstrap/sources.ts";
import { destinationIn } from "../navigation/open.ts";
import { Screen } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { colors } from "../ui/theme.ts";
import { useLocale } from "./catalogue.ts";
import { guides, type GuideRefusal } from "./guide-sources.ts";
import { useGuideStart, useListingRevision, useMapInput } from "./hooks.ts";
import { describe, initials, labelOf, mapSections, refusalText, type Mappable } from "./present.ts";
import { BESIDE, channelKey, channelMapHref, param } from "./routes.ts";
import { guide } from "./runtime.ts";
import { t } from "./strings.ts";
import { Button, Icon, Labelled, Press, guideColors, text, useFieldFocus } from "./ui.tsx";

// Map channels: which guide id a channel's programmes are read by before its own. The list shows
// the mapped channels first, those no longer listed too, then every other channel; a channel's
// page shows its own ids, a Guide id field with what that id has on now and next, Save, and Clear
// back to Automatic. From 840dp (Screen's pane width) a channel's page opens beside the list, its
// selection kept in the route's params; narrower it is pushed (`channelMapHref`).

/** Map channels, with a channel's mapping beside it on wide windows. */
export function MapScreen() {
  useGuideStart();
  const locale = useLocale();
  const input = useMapInput();
  const state = useStore(sources.state);
  const destination = destinationIn(useSegments());
  const insets = useSafeAreaInsets();
  const beside = useWindowDimensions().width >= BESIDE;
  const params = useLocalSearchParams<{ source?: string; channel?: string }>();

  const identity = { sourceId: param(params.source), channelId: param(params.channel) };
  const selected = identity.sourceId && identity.channelId ? channelKey(identity) : null;

  const [query, setQuery] = useState("");
  const sections = mapSections(input, query);
  const ready = state.kind === "ready" ? state.sources : [];
  const failedCatalogue = useStore(catalogueFailures);

  const failed = ready.filter(
    (source) => source.channels.kind === "failed" || failedCatalogue.has(source.id),
  );

  const count = [...input.channels.values()].reduce((sum, list) => sum + list.length, 0);

  // A catalogue read but not yet given to the guide still loads; a failed one says so above.
  const loading =
    state.kind === "restoring" ||
    ready.some(
      (source) =>
        source.channels.kind === "loading" ||
        (source.channels.kind === "ready" &&
          source.channels.rows.length > 0 &&
          !input.channels.has(source.id) &&
          !failedCatalogue.has(source.id)),
    );

  const close = () => router.setParams({ source: undefined, channel: undefined });

  const open = (row: Mappable) => {
    if (beside) router.setParams({ source: row.sourceId, channel: row.channelId });
    else router.push(channelMapHref(destination, row));
  };

  return (
    <Screen
      title={sharedT("Map channels")}
      pushed
      detail={
        selected
          ? {
              title: describe(selected, input).title,
              content: (
                <ChannelMap key={selected} channelKey={selected} pane={beside} onDone={close} />
              ),
              onClose: close,
            }
          : undefined
      }
    >
      <SectionList
        sections={sections}
        keyExtractor={(row) => row.key}
        // Rows write again in a new language.
        extraData={locale}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        initialNumToRender={16}
        windowSize={7}
        ListHeaderComponent={
          <>
            {failed.length ? (
              <View style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 16 }}>
                <Text accessibilityLiveRegion="polite" style={text.heading}>
                  {t("Couldn't load channels")}
                </Text>
                <View style={{ flexDirection: "row" }}>
                  <Button
                    label={sharedT("Try again")}
                    icon="refresh"
                    onPress={() => {
                      failed.forEach((source) => sources.retry(source.id));
                      retryGuideChannels();
                    }}
                  />
                </View>
              </View>
            ) : null}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 16,
                minHeight: 56,
                paddingHorizontal: 16,
                borderBottomWidth: 1,
                borderColor: colors.hairline,
              }}
            >
              <Icon name="search" color={colors.secondary} />
              <TextInput
                accessibilityLabel={sharedT("Search channels")}
                value={query}
                onChangeText={setQuery}
                placeholder={t("Search {count} channels", { count })}
                placeholderTextColor={colors.secondary}
                selectionColor={colors.text}
                cursorColor={colors.text}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                style={{ flex: 1, minHeight: 48, color: colors.text, fontSize: 16, padding: 0 }}
              />
            </View>
          </>
        }
        ListEmptyComponent={
          failed.length && !query.trim() ? undefined : (
            <Text style={[text.secondary, { paddingHorizontal: 16, paddingTop: 16 }]}>
              {query.trim()
                ? t("No channel by that name")
                : loading
                  ? t("Loading channels")
                  : t("No channels")}
            </Text>
          )
        }
        renderSectionHeader={({ section }) => (
          <View
            style={{
              minHeight: 48,
              justifyContent: "center",
              paddingHorizontal: 16,
              paddingTop: 8,
            }}
          >
            <Text accessibilityRole="header" style={text.heading}>
              {section.title}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <MapRow row={item} selected={item.key === selected} onPress={() => open(item)} />
        )}
      />
    </Screen>
  );
}

/** A channel's row: its tile, name and line, and its mapping or Automatic. */
function MapRow({
  row,
  selected,
  onPress,
}: {
  row: Mappable;
  selected: boolean;
  onPress: () => void;
}) {
  const mapping = row.mapped ?? sharedT("Automatic");

  return (
    <Press
      accessibilityLabel={[row.title, row.line, mapping].filter(Boolean).join(", ")}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 64,
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: selected ? guideColors.current : undefined,
      }}
    >
      <View
        style={{
          width: 40,
          height: 30,
          flexShrink: 0,
          borderRadius: 4,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            color: row.listed ? colors.text : colors.inactive,
            fontSize: row.listed ? 11 : 10,
            lineHeight: 14,
            fontWeight: "700",
          }}
        >
          {row.listed ? initials(row.title) : row.channelId}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={text.title}>{row.title}</Text>
        {row.line ? <Text style={text.secondary}>{row.line}</Text> : null}
      </View>
      <Text
        style={[
          text.secondary,
          { flexShrink: 1, maxWidth: "40%", textAlign: "right" },
          row.mapped !== null && { color: colors.text, fontWeight: "500" },
        ]}
      >
        {mapping}
      </Text>
    </Press>
  );
}

/** A channel's mapping pushed on narrow windows: Save and Clear go back to Map channels. */
export function ChannelMapScreen() {
  useGuideStart();
  useLocale();
  const input = useMapInput();
  const params = useLocalSearchParams<{ source?: string; channel?: string }>();
  const key = channelKey({ sourceId: param(params.source), channelId: param(params.channel) });

  return (
    <Screen title={describe(key, input).title} pushed>
      <ChannelMap key={key} channelKey={key} pane={false} onDone={() => router.back()} />
    </Screen>
  );
}

/** What guide answered a Guide id for the channel, and its now and next; null for none. */
interface Preview {
  readonly id: string;
  readonly read: { readonly guide: string; readonly listing: Listing } | null;
}

/**
 * Channel `channelKey`'s mapping: its own guide ids, the Guide id field with which guide answers
 * for it and what is on now and next, Save, and Clear back to Automatic once it is mapped. Both
 * call `onDone`. In a `pane` it heads itself with the channel's name, which a pushed screen's bar
 * carries instead.
 */
function ChannelMap({
  channelKey,
  pane,
  onDone,
}: {
  channelKey: string;
  pane: boolean;
  onDone: () => void;
}) {
  const input = useMapInput();
  const links = guides.useLinks();
  const revision = useListingRevision();
  const insets = useSafeAreaInsets();
  const saved = input.mappings.get(channelKey) ?? null;
  const channel = describe(channelKey, input);
  const own = guide.guideIdsOf(channelKey);
  const inset = pane ? 24 : 16;
  const [id, setId] = useState(saved ?? "");
  const [answered, setAnswered] = useState<Preview | null>(null);
  const [refusal, setRefusal] = useState<GuideRefusal | null>(null);
  const field = useFieldFocus();
  const wanted = id.trim();
  // The last answer stays while the same id is read again, and shows only for that id.
  const preview = answered?.id === wanted ? answered : null;
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    guide
      .preview(channelKey, wanted, { signal: controller.signal })
      .catch(() => null)
      .then((read) => {
        if (!controller.signal.aborted) setAnswered({ id: wanted, read });
      });

    return () => controller.abort();
  }, [channelKey, wanted, revision]);
  // The keyboard's Done and Save can both land before the first change answers.
  const pending = useRef(false);

  const change = (guideId: string | null) => {
    if (pending.current) return;
    pending.current = true;
    void guides
      .map(channelKey, guideId)
      .catch((): GuideRefusal => "saving")
      .then((refused) => {
        pending.current = false;

        if (!refused) return onDone();
        setRefusal(refused);
        AccessibilityInfo.announceForAccessibility(refusalText(refused));
      });
  };

  const source = (owner: string) => {
    const link = links.find((each) => each.id === owner);
    const name = link ? labelOf(link) : input.providers.get(owner);

    return name ? t("From {guide}", { guide: name }) : t("From its provider's guide");
  };

  const read = preview?.read ?? null;

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
    >
      {pane ? (
        <View style={{ gap: 2, paddingVertical: 16, paddingHorizontal: inset }}>
          <Text accessibilityRole="header" style={text.large}>
            {channel.title}
          </Text>
          {channel.line ? <Text style={text.secondary}>{channel.line}</Text> : null}
        </View>
      ) : channel.line ? (
        // Under the bar's title, on its lane.
        <Text style={[text.secondary, { paddingLeft: 64, paddingRight: 16, paddingBottom: 12 }]}>
          {channel.line}
        </Text>
      ) : null}
      <Labelled label={t("Its guide ids")} inset={inset} top>
        <Text style={{ color: colors.text, fontSize: 15, lineHeight: 20 }}>
          {own.length ? own.join(", ") : t("None")}
        </Text>
      </Labelled>
      <Labelled label={t("Guide id")} inset={inset} focused={field.focused}>
        <TextInput
          accessibilityLabel={t("Guide id")}
          value={id}
          onChangeText={(value) => {
            setId(value);
            setRefusal(null);
          }}
          onFocus={field.onFocus}
          onBlur={field.onBlur}
          placeholder={own[0] ?? sharedT("Automatic")}
          placeholderTextColor={colors.secondary}
          selectionColor={colors.text}
          cursorColor={colors.text}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => change(id)}
          style={{
            minHeight: 40,
            color: colors.text,
            fontSize: 16,
            fontWeight: "500",
            padding: 0,
          }}
        />
      </Labelled>
      {wanted && preview ? (
        <View
          accessible
          accessibilityLiveRegion="polite"
          style={{ gap: 8, paddingTop: 16, paddingBottom: 8, paddingHorizontal: inset }}
        >
          {read ? (
            <>
              <Text style={text.secondary}>{source(read.guide)}</Text>
              {(["now", "next"] as const).map((at) => {
                const programme = read.listing[at];

                return programme ? (
                  <View key={at} style={{ flexDirection: "row", alignItems: "baseline", gap: 16 }}>
                    <Text style={[text.note, { width: 104 }]}>
                      {sharedT(at === "now" ? "Now" : "Next")}
                    </Text>
                    <Text
                      style={{ color: colors.text, fontSize: 15, lineHeight: 20, minWidth: 40 }}
                    >
                      {formatDate(programme.start, "time")}
                    </Text>
                    <Text
                      style={{
                        flex: 1,
                        color: colors.text,
                        fontSize: 15,
                        lineHeight: 20,
                        fontWeight: "500",
                      }}
                    >
                      {programme.title}
                    </Text>
                  </View>
                ) : null;
              })}
              {read.listing.now || read.listing.next ? null : (
                <Text style={{ color: colors.text, fontSize: 15, lineHeight: 20 }}>
                  {t("Nothing now or next")}
                </Text>
              )}
            </>
          ) : (
            <Text style={{ color: colors.text, fontSize: 15, lineHeight: 20 }}>
              {t("No guide has programmes for this id now")}
            </Text>
          )}
        </View>
      ) : null}
      {refusal ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[
            text.secondary,
            { color: guideColors.failure, paddingHorizontal: inset, paddingTop: 12 },
          ]}
        >
          {refusalText(refusal)}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          paddingTop: 16,
          paddingHorizontal: inset,
        }}
      >
        <Button label={sharedT("Save")} filled grow onPress={() => change(id)} />
        {saved ? <Button label={t("Clear")} grow onPress={() => change(null)} /> : null}
      </View>
      <Text style={[text.note, { paddingTop: 16, paddingHorizontal: inset }]}>
        {t("Clear goes back to Automatic: its own ids, in its provider's guide first.")}
      </Text>
    </ScrollView>
  );
}
