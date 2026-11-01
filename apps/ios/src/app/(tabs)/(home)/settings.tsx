import type { AnalyticsSettings } from "@mrstreamer/contracts/analytics";
import { QUALITIES, type Quality } from "@mrstreamer/contracts/library";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { AccountStatus } from "@mrstreamer/contracts/subscription";
import { LANGUAGE_NAMES, LOCALES, type LanguageChoice } from "@mrstreamer/contracts/language";
import { formatDate } from "@mrstreamer/core/i18n";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { languageName } from "@mrstreamer/core/ondemand/tracks";
import Constants from "expo-constants";
import { router, useNavigation } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useLayoutEffect } from "react";
import {
  ActionSheetIOS,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import {
  members,
  endDemo,
  resetDemo,
  reloadChannels,
  reloadTitles,
  remove,
  retry,
  useRoster,
  type Member,
  type DemoErase,
  type DemoStart,
} from "../../../account.ts";
import { DownloadsLink } from "../../../downloads-screen.tsx";
import { failureOf } from "../../../errors.ts";
import { tabHref, useTabs, type Tab } from "../../../header.tsx";
import { t } from "../../../i18n/settings.ts";
import { chooseLanguage, useInterfaceLanguage } from "../../../language.ts";
import { licences } from "../../../licences.ts";
import {
  getMediaPreferences,
  SUBTITLE_SIZES,
  updateMediaPreferences,
  useMediaPreferences,
} from "../../../media-preferences.ts";
import { openLink } from "../../../open-link.ts";
import { playlistHref, useUnmapped } from "../../../playlist-groups.tsx";
import { removeSubtitleKey, saveSubtitleKey, useSubtitleKey } from "../../../online-subtitles.ts";
import { setStatistics, useStatistics } from "../../../telemetry/index.ts";
import {
  removeTmdbKey,
  retryMetadata,
  saveTmdbKey,
  useMetadataStanding,
  useTitleTimings,
  type MetadataStanding,
} from "../../../titles.ts";
import { ChannelLogo, colors, TextButton } from "../../../ui.tsx";

const PRIVACY_POLICY = "https://mrstreamer.app/privacy";

/**
 * Settings as one list: the interface language first, then the providers, each a row with Add
 * provider and Guides, the XMLTV guides added apart from theirs, under them, then Downloads, a
 * row with what they take that opens them, Media policies, Subtitles, TMDB with the viewer's key
 * and how it answers, Privacy with its policy in the browser and Diagnostics, and About with
 * Licences. TMDB's terms ask for its logo and notice, as the desktop's Settings show them. It
 * opens on whichever tab's top bar asked for it, and what it opens goes on that tab too. All of
 * it, its title too, shows in the interface language, and again at once in the one chosen here.
 */
export default function Settings() {
  const roster = useRoster();
  const statistics = useStatistics();
  const media = useMediaPreferences();
  const subtitleKey = useSubtitleKey();
  const tmdb = useMetadataStanding();
  const tab = useTabs()?.tab ?? "(home)";
  const language = useInterfaceLanguage();
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ title: t("Settings") });
  }, [navigation, language.locale]);
  if (roster.kind !== "ready") return null;
  const systemLanguage = t("System default ({language})", {
    language: mediaLanguageName(deviceLanguage),
  });
  const systemInterface = t("System default ({language})", {
    language: LANGUAGE_NAMES[language.system],
  });
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Section name={t("General")} />
      <Opens
        label={t("Interface language")}
        value={language.choice === "system" ? systemInterface : LANGUAGE_NAMES[language.locale]}
        role="button"
        onPress={() => pickLanguage(systemInterface)}
        testID="settings-interface-language"
      />

      <Section name={t("Providers")} />
      {roster.members.map((member) => (
        <Provider key={member.entry.id} member={member} tab={tab} />
      ))}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push(tabHref(tab, "provider"))}
        style={({ pressed }) => [styles.provider, pressed && styles.pressed]}
        testID="settings-add-provider"
      >
        <SymbolView name="plus" size={20} tintColor={colors.text} style={styles.mark} />
        <Text style={styles.name}>{t("Add provider")}</Text>
      </Pressable>
      <Opens
        label={t("Guides")}
        role="button"
        // Home's at the root, as tabHref places Settings' own screens.
        onPress={() => router.push(tab === "(home)" ? "/guides" : `/${tab}/guides`)}
        testID="settings-guides"
      />

      <Section name={t("Downloads")} />
      <DownloadsLink onPress={() => router.push(tabHref(tab, "downloads"))} />

      <Section name={t("Media")} />
      <Opens
        label={t("Titles language")}
        value={
          media.titleLanguage === null ? systemLanguage : mediaLanguageName(media.titleLanguage)
        }
        role="button"
        onPress={() =>
          chooseMedia("titleLanguage", t("Titles language"), [
            { label: systemLanguage, value: null },
            ...TITLE_LANGUAGES.map(({ code, name }) => ({ label: name, value: code })),
          ])
        }
        testID="settings-title-language"
      />
      <Opens
        label={t("Audio")}
        value={
          media.audio.kind === "language"
            ? mediaLanguageName(media.audio.language)
            : t(audioNames[media.audio.kind])
        }
        role="button"
        onPress={() =>
          chooseMedia("audio", t("Audio"), [
            { label: t(audioNames["follow-title"]), value: { kind: "follow-title" } },
            { label: t(audioNames.original), value: { kind: "original" } },
            ...TITLE_LANGUAGES.map(({ code, name }) => ({
              label: name,
              value: { kind: "language" as const, language: code },
            })),
          ])
        }
        testID="settings-audio"
      />
      <Opens
        label={t("Subtitles")}
        value={
          media.subtitles.kind === "language"
            ? mediaLanguageName(media.subtitles.language)
            : t(subtitleNames[media.subtitles.kind])
        }
        role="button"
        onPress={() =>
          chooseMedia("subtitles", t("Subtitles"), [
            { label: t(subtitleNames["forced-only"]), value: { kind: "forced-only" } },
            { label: t(subtitleNames.off), value: { kind: "off" } },
            ...TITLE_LANGUAGES.map(({ code, name }) => ({
              label: name,
              value: { kind: "language" as const, language: code },
            })),
          ])
        }
        testID="settings-subtitles"
      />
      <Opens
        label={t("Live quality")}
        value={qualityNames[media.liveQuality]}
        role="button"
        onPress={() =>
          chooseMedia(
            "liveQuality",
            t("Live quality"),
            QUALITIES.map((quality) => ({ label: qualityNames[quality], value: quality })),
          )
        }
        testID="settings-live-quality"
      />

      <Section name={t("Subtitles")} />
      <Opens
        label={t("SubDL API key")}
        value={subtitleKey === null ? undefined : t(subtitleKey ? "Saved" : "Not set")}
        role="button"
        // Until the Keychain answers, whether there is one to replace isn't known.
        onPress={
          subtitleKey === null ? undefined : subtitleKey ? manageSubtitleKey : enterSubtitleKey
        }
        testID="settings-subdl-key"
      />
      <Opens
        label={t("Text size")}
        value={t(sizeNames[media.subtitleSize])}
        role="button"
        onPress={() =>
          chooseMedia(
            "subtitleSize",
            t("Text size"),
            SUBTITLE_SIZES.map((size) => ({ label: t(sizeNames[size]), value: size })),
          )
        }
        testID="settings-subtitle-size"
      />
      <Text style={styles.paragraph}>
        {t(
          "Find online in Watch searches SubDL with your own key. Text size is for downloaded subtitles.",
        )}
      </Text>

      <Section name={t("TMDB")} />
      <Tmdb tmdb={tmdb} />

      <Section name={t("Privacy")} />
      <View style={styles.toggle}>
        <Text style={styles.label} importantForAccessibility="no" accessibilityElementsHidden>
          {t("Share basic usage statistics")}
        </Text>
        <Switch
          accessibilityLabel={t("Share basic usage statistics")}
          value={statistics.enabled}
          onValueChange={(enabled) => void setStatistics(enabled)}
          testID="settings-statistics"
        />
      </View>
      <Text style={styles.paragraph}>
        {[
          t("Counts app use, the screens you open, and whether playback works and for how long."),
          t("No viewing history, searches or provider details. Off until you choose to share."),
          transportNote(statistics),
        ]
          .filter(Boolean)
          .join(" ")}
      </Text>
      <Opens
        label={t("Privacy policy")}
        role="link"
        onPress={() => openLink(PRIVACY_POLICY)}
        testID="settings-privacy-policy"
      />
      <Opens
        label={t("Diagnostics")}
        role="button"
        onPress={() => router.push(tab === "(home)" ? "/diagnostics" : `/${tab}/diagnostics`)}
        testID="settings-diagnostics"
      />

      <Section name={t("About")} />
      <Line
        label={t("Version")}
        value={`${Constants.expoConfig?.version ?? "?"} (${Constants.platform?.ios?.buildNumber ?? "?"})`}
      />
      <Opens
        label={t("Licences")}
        value={String(licences.components.length)}
        role="button"
        onPress={() => router.push(tabHref(tab, "licences"))}
        testID="settings-licences"
      />
      {/* Always: TMDB facts saved before stay without a key. */}
      <View style={styles.notice}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="TMDB"
          onPress={() => void Linking.openURL("https://www.themoviedb.org")}
        >
          <Image
            source={require("../../../../assets/tmdb.png") as number}
            style={styles.logo}
            resizeMode="contain"
          />
        </Pressable>
        <Text style={styles.noticeText}>
          {t(
            "This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.",
          )}{" "}
          {t("Where titles stream comes from {justWatch}.", { justWatch: "JustWatch" })}
        </Text>
      </View>
      {__DEV__ ? <Development /> : null}
      <View style={styles.end} />
    </ScrollView>
  );
}

const mediaLanguageName = (code: string) =>
  TITLE_LANGUAGES.find((language) => language.code === code)?.name ?? languageName(code) ?? code;
const deviceLanguage = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).language;
const audioNames = {
  "follow-title": "Follow title language",
  original: "Original language",
} as const;
const subtitleNames = { "forced-only": "Only when forced", off: "Off" } as const;
const qualityNames: Record<Quality, string> = { uhd: "4K", fhd: "Full HD", hd: "HD", sd: "SD" };
const sizeNames = { small: "Small", medium: "Medium", large: "Large" } as const;

/**
 * Offers System default, labelled `system`, and each interface language by its own name, as a
 * system sheet. A pick shows at once; one that couldn't be saved changes nothing and says so.
 */
function pickLanguage(system: string) {
  const choices: readonly { readonly label: string; readonly value: LanguageChoice }[] = [
    { label: system, value: "system" },
    ...LOCALES.map((locale) => ({ label: LANGUAGE_NAMES[locale], value: locale })),
  ];
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: t("Interface language"),
      options: [...choices.map(({ label }) => label), t("Cancel")],
      cancelButtonIndex: choices.length,
    },
    (index) => {
      const choice = choices[index];
      if (choice && !chooseLanguage(choice.value)) {
        Alert.alert(
          t("Couldn't save the language"),
          t("Your previous choice is still saved. Try again."),
        );
      }
    },
  );
}

/** A system sheet commits only a picked value; Cancel has no action. */
function chooseMedia<K extends keyof ReturnType<typeof getMediaPreferences>>(
  field: K,
  title: string,
  choices: readonly {
    readonly label: string;
    readonly value: ReturnType<typeof getMediaPreferences>[K];
  }[],
) {
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title,
      options: [...choices.map(({ label }) => label), t("Cancel")],
      cancelButtonIndex: choices.length,
    },
    (index) => {
      const choice = choices[index];
      if (choice && !updateMediaPreferences(field, choice.value)) {
        Alert.alert(
          t("Couldn't save media preference"),
          t("Your previous choice is still saved. Try again."),
        );
      }
    },
  );
}

/** Asks for a SubDL key, the one Watch's Find online searches with, never showing one saved. */
function enterSubtitleKey() {
  Alert.prompt(
    t("SubDL API key"),
    t("From your account on subdl.com."),
    [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Save"),
        onPress: (typed = "") => {
          if (!typed.trim()) return;
          saveSubtitleKey(typed).catch(() =>
            Alert.alert(t("Couldn't save the key"), t("The Keychain refused it. Try again.")),
          );
        },
      },
    ],
    "secure-text",
  );
}

/** A saved key can be replaced, typed again in full, or removed. */
function manageSubtitleKey() {
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: t("SubDL API key"),
      options: [t("Replace"), t("Remove"), t("Cancel")],
      destructiveButtonIndex: 1,
      cancelButtonIndex: 2,
    },
    (index) => {
      if (index === 0) enterSubtitleKey();
      else if (index === 1) {
        removeSubtitleKey().catch(() =>
          Alert.alert(t("Couldn't remove the key"), t("It's still saved. Try again.")),
        );
      }
    },
  );
}

/**
 * A provider as one row: its name and how it stands, in a line, with how many of a playlist's
 * groups need mapping. Pressing it offers what can be done with it, as a system sheet: Retry when
 * it didn't answer, a playlist's groups, the reloads, Edit and Remove. A playlist reloads as one.
 */
function Provider({ member, tab }: { member: Member; tab: Tab }) {
  const { entry, label } = member;
  const unmapped = useUnmapped(member);
  const line = [
    standing(member),
    unmapped ? t("{count} groups need mapping", { count: unmapped }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const edit = () => router.push({ pathname: tabHref(tab, "provider"), params: { id: entry.id } });
  const reloads =
    entry.kind === "m3u"
      ? [
          {
            label: t("Playlist groups"),
            run: () => router.push({ pathname: playlistHref(tab), params: { id: entry.id } }),
          },
          {
            label: t("Reload playlist"),
            run: () => {
              reloadChannels(entry.id);
              reloadTitles(entry.id);
            },
          },
        ]
      : [
          { label: t("Reload channels"), run: () => reloadChannels(entry.id) },
          { label: t("Reload movies and series"), run: () => reloadTitles(entry.id) },
        ];
  const open = () => {
    const actions =
      entry.kind === "demo"
        ? [
            { label: t("Reload channels"), run: () => reloadChannels(entry.id) },
            { label: t("Reload movies and series"), run: () => reloadTitles(entry.id) },
            { label: t("Reset demo data"), run: () => confirmDemo("reset") },
            { label: t("Exit demo"), run: () => confirmDemo("exit") },
          ]
        : [
            ...(member.needsSecret
              ? [
                  {
                    label: t(entry.kind === "m3u" ? "Enter playlist link" : "Enter password"),
                    run: edit,
                  },
                ]
              : failed(member)
                ? [{ label: t("Retry"), run: () => retry(entry.id) }]
                : []),
            ...(member.needsSecret ? [] : reloads),
            { label: t("Edit"), run: edit },
            { label: t("Remove"), run: () => confirmRemove(member) },
          ];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: label,
        options: [...actions.map((action) => action.label), t("Cancel")],
        destructiveButtonIndex: actions.length - 1,
        cancelButtonIndex: actions.length,
      },
      (index) => actions[index]?.run(),
    );
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${line}`}
      onPress={open}
      style={({ pressed }) => [styles.provider, pressed && styles.pressed]}
      testID={`settings-provider-${entry.id}`}
    >
      <ChannelLogo channel={{ title: label, logoUrl: null }} style={styles.mark} />
      <View style={styles.names}>
        <Text style={styles.name} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.plain, failed(member) && styles.failed]} numberOfLines={2}>
          {line}
        </Text>
      </View>
    </Pressable>
  );
}

/** Whether it needs the viewer: it didn't answer, or asks for its password again. */
const failed = (member: Member) =>
  member.needsSecret ||
  member.live.kind === "failed" ||
  member.titles.kind === "failed" ||
  (member.account !== null && "kind" in member.account);

/** How a provider stands, in a line: its account, or what needs the viewer, or what loads. */
function standing({ entry, account, needsSecret, live, titles }: Member): string {
  if (needsSecret) {
    return t(entry.kind === "m3u" ? "Enter the playlist link again" : "Enter the password again");
  }
  if (live.kind === "failed") return failureOf(live.error, entry.server).headline;
  if (titles.kind === "failed") {
    return t("Movies and series: {failure}", {
      failure: failureOf(titles.error, entry.server).headline,
    });
  }
  if (entry.kind === "demo") return t("Sample content");
  const loading =
    live.kind === "loading"
      ? t("Loading channels")
      : titles.kind === "loading"
        ? t("Loading")
        : null;
  // A playlist's provider says nothing of its account, only whether it answered.
  const state =
    entry.kind === "m3u" && !(account && "kind" in account)
      ? t("M3U playlist")
      : accountLine(account, entry.server);
  return [state, loading].filter(Boolean).join(" · ");
}

/** Both demo actions are ephemeral and name the data removed before the viewer confirms. */
function confirmDemo(action: "reset" | "exit") {
  const label = t(action === "reset" ? "Reset demo data" : "Exit demo");
  const report = (result: DemoErase | DemoStart) => {
    if (result.kind === "incomplete")
      Alert.alert(
        t("Demo removal incomplete"),
        t("Some demo data couldn't be removed. Reopen the app to retry cleanup."),
      );
    else if (result.kind === "refused")
      Alert.alert(t("Demo isn't available"), t("The operation couldn't continue."));
  };
  Alert.alert(
    t(action === "reset" ? "Reset demo data?" : "Exit demo?"),
    t("Demo downloads, favourites, watchlist, history and progress will be removed."),
    [
      {
        text: label,
        style: "destructive",
        onPress: () => {
          const operation = action === "reset" ? resetDemo() : endDemo();
          void operation
            .then(report)
            .catch(() =>
              Alert.alert(
                t("Demo isn't available"),
                t("The operation couldn't continue. Try again."),
              ),
            );
        },
      },
      { text: t("Cancel"), style: "cancel" },
    ],
  );
}

/**
 * Asks before removing, saying what goes. Its history stays unless the viewer deletes it too;
 * the last one removed returns to Connect. A failed removal says how it stands: still saved
 * when the registry refused it, else removed with history the next launch deletes.
 */
function confirmRemove({ entry, label }: Member) {
  const removing = (keepHistory: boolean) => () =>
    void remove(entry.id, { keepHistory }).catch(() => {
      if (members().some((member) => member.entry.id === entry.id)) {
        Alert.alert(
          t("Couldn't remove {name}", { name: label }),
          t("It's still saved and nothing was deleted. Try again."),
        );
      } else if (!keepHistory) {
        Alert.alert(
          t("{name} is removed", { name: label }),
          t("Its history couldn't all be deleted yet. The app tries again when it next opens."),
        );
      }
    });
  Alert.alert(
    t("Remove {name}?", { name: label }),
    t(
      "What plays from it stops. Its favourites, watchlist, history and progress stay for when you add it again, unless you delete them too.",
    ),
    [
      { text: t("Remove"), style: "destructive", onPress: removing(true) },
      { text: t("Remove and delete history"), style: "destructive", onPress: removing(false) },
      { text: t("Cancel"), style: "cancel" },
    ],
  );
}

/** Where statistics go in this build, when that isn't PostHog. */
function transportNote({ enabled, transport }: AnalyticsSettings): string | null {
  if (transport === "unavailable") return t("They can't be saved on this iPhone right now.");
  if (!enabled || transport === "production") return null;
  return transport === "local"
    ? t("This development build sends them to a test endpoint on this computer only.")
    : t("This build sends nothing.");
}

/** Whose key TMDB is asked with, as the key row says it. */
const tmdbKeyNames = { yours: "Saved", app: "This build's" } as const;

/**
 * TMDB's group, as the SubDL key's: the viewer's key, how TMDB answers, how many titles it gave
 * when it stopped, and Try again while it isn't answering. A refused key waits for another.
 */
function Tmdb({ tmdb }: { tmdb: MetadataStanding }) {
  const count = "known" in tmdb ? t("{known} of {wanted}", tmdb) : "";
  return (
    <>
      <Opens
        label={t("TMDB API key")}
        value={
          tmdb.kind === "reading" ? undefined : t("key" in tmdb ? tmdbKeyNames[tmdb.key] : "Add")
        }
        role="button"
        // Until the Keychain answers, whether there is one to replace isn't known.
        onPress={
          tmdb.kind === "reading"
            ? undefined
            : "key" in tmdb && tmdb.key === "yours"
              ? manageTmdbKey
              : enterTmdbKey
        }
        testID="settings-tmdb-key"
      />
      <Line
        label={t("Status")}
        value={tmdbStatus(tmdb)}
        alert={tmdb.kind === "refused" || tmdb.kind === "unavailable"}
        testID="settings-tmdb-status"
      />
      {tmdb.kind === "refused" || tmdb.kind === "unavailable" ? (
        <Line
          label={t("Titles")}
          value={tmdb.kind === "refused" ? t("{titles} saved", { titles: count }) : count}
          testID="settings-tmdb-titles"
        />
      ) : null}
      {tmdb.kind === "unavailable" ? (
        <View style={styles.retry}>
          <TextButton
            label={t("Try again")}
            accessibilityLabel={t("Ask TMDB again")}
            onPress={retryMetadata}
            testID="settings-tmdb-retry"
          />
        </View>
      ) : null}
      <Text style={styles.paragraph}>
        {t(
          "Facts and pictures for movies and series. Your key replaces this build's and stays in the Keychain. Titles TMDB already gave keep their saved facts.",
        )}
      </Text>
    </>
  );
}

function tmdbStatus(tmdb: MetadataStanding): string {
  switch (tmdb.kind) {
    case "reading":
      return t("Checking");
    case "no-key":
      return t("No key, provider facts only");
    case "waiting":
      return t("Waiting for the lists");
    case "unlinked":
      return t("No title has a TMDB id");
    case "refused":
      return t("Refused the key");
    case "unavailable":
      return t("Not answering");
    case "fetching":
    case "answered":
      return tmdb.known < tmdb.wanted
        ? t("{known} of {wanted} titles", tmdb)
        : t("{count} titles", { count: tmdb.known });
  }
}

/** Asks for the viewer's own TMDB key, which TMDB is then asked with, never showing one saved. */
function enterTmdbKey() {
  Alert.prompt(
    t("TMDB API key"),
    t("From your account settings on themoviedb.org."),
    [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Save"),
        onPress: (typed = "") => {
          if (!typed.trim()) return;
          saveTmdbKey(typed).catch(() =>
            Alert.alert(t("Couldn't save the key"), t("The Keychain refused it. Try again.")),
          );
        },
      },
    ],
    "secure-text",
  );
}

/** A saved key can be replaced, typed again in full, or removed, for this build's key again. */
function manageTmdbKey() {
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: t("TMDB API key"),
      options: [t("Replace"), t("Remove"), t("Cancel")],
      destructiveButtonIndex: 1,
      cancelButtonIndex: 2,
    },
    (index) => {
      if (index === 0) enterTmdbKey();
      else if (index === 1) {
        removeTmdbKey().catch(() =>
          Alert.alert(t("Couldn't remove the key"), t("It's still saved. Try again.")),
        );
      }
    },
  );
}

/** What development builds also show, in English only. Release builds leave it out. */
function Development() {
  const timings = useTitleTimings();
  return (
    <>
      <Section name="Development" />
      <Line
        label="Movies and series lists"
        value={timings ? `read ${timings.fetched} ms, indexed ${timings.indexed} ms` : "Not read"}
      />
      <View style={styles.actions}>
        <TextButton label="Runtime proof" onPress={() => router.push("/proof")} />
      </View>
    </>
  );
}

const stateNames = {
  active: "Active",
  expired: "Expired",
  banned: "Banned",
  disabled: "Disabled",
  unknown: "Unknown",
} as const;

/** The account as one plain line: "Active until 12 Mar 2027, 1 of 2 streams". */
function accountLine(account: AccountStatus | AppError | null, server: string): string {
  if (!account) return t("Checking");
  if ("kind" in account) return failureOf(account, server).headline;
  const state = t(stateNames[account.state]);
  const until = account.expiresAt
    ? t("{state} until {date}", {
        state,
        date: formatDate(Date.parse(account.expiresAt), "date"),
      })
    : state;
  return account.maxConnections !== null
    ? t("{account}, {active} of {max} streams", {
        account: until,
        active: account.activeConnections ?? 0,
        max: account.maxConnections,
      })
    : until;
}

function Section({ name }: { name: string }) {
  return (
    <Text style={styles.section} accessibilityRole="header">
      {name}
    </Text>
  );
}

/** A row that opens something: a screen of Settings' own, or a page in the browser as a link. */
function Opens({
  label,
  value,
  role,
  onPress,
  testID,
}: {
  label: string;
  value?: string | undefined;
  role: "button" | "link";
  /** Undefined while it can't open yet. */
  onPress: (() => void) | undefined;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.line, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={styles.label}>{label}</Text>
      <View style={styles.opens}>
        {value ? <Text style={styles.value}>{value}</Text> : null}
        <SymbolView name="chevron.right" size={14} tintColor={colors.dim} weight="semibold" />
      </View>
    </Pressable>
  );
}

/** A label and its value; `alert` reds the value, as a provider's failed line. */
function Line({
  label,
  value,
  alert = false,
  testID,
}: {
  label: string;
  value: string;
  alert?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.line} accessible accessibilityLabel={`${label}, ${value}`} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, alert && styles.failed]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 24,
    marginBottom: 4,
    marginHorizontal: 16,
  },
  provider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 8,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.5 },
  mark: { width: 36, height: 36 },
  names: { flex: 1, minWidth: 0 },
  failed: { color: "#FF453A" },
  name: { color: colors.text, fontSize: 17, fontWeight: "600" },
  plain: { color: colors.text, fontSize: 15 },
  // Keep wrapped labels clear of the row's separators.
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 44,
    paddingVertical: 10,
    alignItems: "center",
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggle: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    minHeight: 44,
    paddingVertical: 10,
    marginHorizontal: 16,
  },
  label: { color: colors.text, fontSize: 17, flexShrink: 1 },
  value: { color: colors.dim, fontSize: 17, flexShrink: 1, textAlign: "right" },
  // Shrinks with the label, so a long value at large text wraps rather than crushing it.
  opens: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  paragraph: {
    color: colors.dim,
    fontSize: 13,
    lineHeight: 18,
    marginHorizontal: 16,
    marginTop: 4,
  },
  actions: { marginHorizontal: 16, marginTop: 4 },
  retry: { marginHorizontal: 16 },
  notice: { marginHorizontal: 16, marginTop: 24, gap: 10 },
  logo: { width: 108, height: 14 },
  noticeText: { color: colors.dim, fontSize: 13, lineHeight: 18 },
  end: { height: 32 },
});
