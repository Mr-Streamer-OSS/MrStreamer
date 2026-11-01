import { COLLECTION_SORTS, type TitleKind } from "@mrstreamer/contracts/ondemand";
import type { QualityHint } from "@mrstreamer/contracts/title-filters";
import { formatNumber } from "@mrstreamer/core/i18n";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { languageName as trackLanguageName } from "@mrstreamer/core/ondemand/tracks";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { t } from "./i18n/library.ts";
import { DEFAULT_BROWSE, type BrowseChoices, type BrowsedCollection } from "./title-browse.ts";

// Sort and filter values are ids; only their names are words of the interface language. File and
// track language names stay as core gives them, apart from Unknown and Multiple languages.
const sorts = {
  added: "Recently added",
  popular: "Popular",
  rating: "Rating",
  title: "Title",
} as const;
const qualities: Record<Exclude<QualityHint, "unknown">, string> = {
  "4k": "4K",
  "full-hd": "Full HD",
  hd: "HD",
  sd: "SD",
};
const qualityName = (quality: QualityHint) =>
  quality === "unknown" ? t("Unknown") : qualities[quality];
const languageName = (code: string) =>
  TITLE_LANGUAGES.find((language) => language.code === code)?.name ??
  (code === "multi" ? t("Multiple languages") : t("Unknown"));
// Observed languages are canonical codes, including those outside the offered hint languages.
const knownLanguageName = (code: string) =>
  code === "unknown" ? t("Unknown") : (trackLanguageName(code) ?? code);
/** "Audio: Dutch" or "Subtitles: Dutch", for a known track's choice. */
const trackLabel = (kind: "audio" | "subtitles", code: string) =>
  t(kind === "audio" ? "Audio: {language}" : "Subtitles: {language}", {
    language: knownLanguageName(code),
  });

/** One native sheet, with scrollable choices that grow with the viewer's text size. */
export function BrowseControls({
  kind,
  choices,
  result,
  onChange,
}: {
  kind: TitleKind;
  choices: BrowseChoices;
  result: BrowsedCollection | null;
  onChange: (choices: BrowseChoices) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = result
    ? t(kind === "movie" ? "{shown} of {count} movies" : "{shown} of {count} series", {
        shown: result.titles.length,
        count: result.total,
      })
    : null;
  const active = Boolean(
    choices.sort || choices.filters.quality || choices.filters.language || choices.filters.verified,
  );
  const verified = choices.filters.verified;
  return (
    <View>
      <View style={styles.summary}>
        {count ? (
          <Text style={styles.text} accessibilityLiveRegion="polite">
            {count}
          </Text>
        ) : null}
        <Choice label={t("Sort & filter")} selected={active} onPress={() => setOpen(true)} />
      </View>
      {open ? (
        <Modal
          visible
          presentationStyle="pageSheet"
          animationType="slide"
          onRequestClose={() => setOpen(false)}
        >
          <SafeAreaView
            accessibilityViewIsModal
            style={styles.sheet}
            edges={["top", "bottom", "left", "right"]}
          >
            <ScrollView contentContainerStyle={styles.content}>
              <Text style={styles.heading} accessibilityRole="header">
                {t("Sort & filter")}
              </Text>
              {count ? (
                <Text style={styles.text} accessibilityLiveRegion="polite">
                  {count}
                </Text>
              ) : null}
              <Text style={styles.section} accessibilityRole="header">
                {t("Sort")}
              </Text>
              {COLLECTION_SORTS.map((sort) => (
                <Choice
                  key={sort}
                  label={t(sorts[sort])}
                  selected={(choices.sort ?? result?.sort) === sort}
                  onPress={() => onChange({ ...choices, sort })}
                />
              ))}
              <Text style={styles.section} accessibilityRole="header">
                {t("Quality")}
              </Text>
              <Choice
                label={t("Any quality")}
                selected={!choices.filters.quality}
                onPress={() => {
                  const { quality: _quality, ...filters } = choices.filters;
                  onChange({ ...choices, filters });
                }}
              />
              {result?.qualities.map(({ value, count }) => (
                <Choice
                  key={value}
                  label={`${qualityName(value)} · ${formatNumber(count)}`}
                  selected={choices.filters.quality === value}
                  onPress={() =>
                    onChange({ ...choices, filters: { ...choices.filters, quality: value } })
                  }
                />
              ))}
              {choices.filters.quality &&
              !result?.qualities.some(({ value }) => value === choices.filters.quality) ? (
                <Text style={styles.text}>
                  {t("Selected quality: {quality}. No matching files listed.", {
                    quality: qualityName(choices.filters.quality),
                  })}
                </Text>
              ) : null}
              <Text style={styles.section} accessibilityRole="header">
                {t("File language")}
              </Text>
              <Text style={styles.text}>
                {t("Quality and language are provider name hints, not verified tracks.")}
              </Text>
              <Choice
                label={t("Any file language")}
                selected={!choices.filters.language}
                onPress={() => {
                  const { language: _language, ...filters } = choices.filters;
                  onChange({ ...choices, filters });
                }}
              />
              {result?.languages.map(({ value, count }) => (
                <Choice
                  key={value}
                  label={`${languageName(value)} · ${formatNumber(count)}`}
                  selected={choices.filters.language === value}
                  onPress={() =>
                    onChange({ ...choices, filters: { ...choices.filters, language: value } })
                  }
                />
              ))}
              {choices.filters.language &&
              !result?.languages.some(({ value }) => value === choices.filters.language) ? (
                <Text style={styles.text}>
                  {t("Selected file language: {language}. No matching files listed.", {
                    language: languageName(choices.filters.language),
                  })}
                </Text>
              ) : null}
              {result && result.files > 0 ? (
                <>
                  <Text style={styles.section} accessibilityRole="header">
                    {t("Known audio/subtitles")}
                  </Text>
                  <Choice
                    label={t("Any known track")}
                    selected={!verified}
                    onPress={() => {
                      const { verified: _verified, ...filters } = choices.filters;
                      onChange({ ...choices, filters });
                    }}
                  />
                  {result.verified.map(({ value, count }) => (
                    <Choice
                      key={`${value.kind}:${value.language}`}
                      label={`${trackLabel(value.kind, value.language)} · ${formatNumber(count)}`}
                      selected={
                        verified?.kind === value.kind && verified.language === value.language
                      }
                      onPress={() =>
                        onChange({ ...choices, filters: { ...choices.filters, verified: value } })
                      }
                    />
                  ))}
                </>
              ) : null}
              {verified &&
              !result?.verified.some(
                ({ value }) => value.kind === verified.kind && value.language === verified.language,
              ) ? (
                <Text style={styles.text}>
                  {t(
                    verified.kind === "audio"
                      ? "Selected audio: {language}. No matching files listed."
                      : "Selected subtitles: {language}. No matching files listed.",
                    { language: knownLanguageName(verified.language) },
                  )}
                </Text>
              ) : null}
              <Choice label={t("Reset")} onPress={() => onChange(DEFAULT_BROWSE)} />
              <Choice
                label={
                  result
                    ? t(kind === "movie" ? "Show {count} movies" : "Show {count} series", {
                        count: result.titles.length,
                      })
                    : t("Done")
                }
                onPress={() => setOpen(false)}
              />
            </ScrollView>
          </SafeAreaView>
        </Modal>
      ) : null}
    </View>
  );
}

function Choice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? {} : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.choice, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.text}>
        {label}
        {selected ? " ✓" : ""}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  summary: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  sheet: { flex: 1, backgroundColor: "#000000" },
  content: { padding: 20, paddingBottom: 32 },
  heading: { color: "#FFFFFF", fontSize: 28, fontWeight: "700", marginBottom: 12 },
  section: { color: "#FFFFFF", fontSize: 20, fontWeight: "600", marginTop: 24, marginBottom: 8 },
  text: { color: "#FFFFFF", fontSize: 17, flexShrink: 1 },
  choice: { minHeight: 44, justifyContent: "center", paddingVertical: 10 },
});
