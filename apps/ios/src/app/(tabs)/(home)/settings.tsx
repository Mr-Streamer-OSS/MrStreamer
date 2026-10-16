import type { AnalyticsSettings } from "@mrstreamer/contracts/analytics";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { AccountStatus } from "@mrstreamer/contracts/subscription";
import { formatDate } from "@mrstreamer/core/i18n";
import Constants from "expo-constants";
import { router } from "expo-router";
import { isPictureInPictureSupported } from "expo-video";
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { reloadChannels, reloadTitles, remove, useRoster, type Member } from "../../../account.ts";
import { failureOf } from "../../../errors.ts";
import { setStatistics, useStatistics } from "../../../telemetry/index.ts";
import { hasTmdb, useMetadataStatus, useTitleTimings } from "../../../titles.ts";
import { colors, TextButton } from "../../../ui.tsx";

/**
 * Settings as one list: the provider first, then Downloads, Playback, Privacy and About. iOS has
 * one subscription so far; several, M3U playlists, downloads and guide sources come here as they
 * come to iOS, and until then nothing here offers them. TMDB's terms ask for its logo and notice,
 * as the desktop's Settings show them.
 */
export default function Settings() {
  const roster = useRoster();
  const statistics = useStatistics();
  if (roster.kind !== "ready") return null;
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Section name={roster.members.length > 1 ? "Providers" : "Provider"} />
      {roster.members.map((member) => (
        <Provider key={member.entry.id} member={member} />
      ))}

      <Section name="Downloads" />
      <Text style={styles.paragraph}>
        Downloads aren't on iPhone yet. Movies and episodes play while online.
      </Text>

      <Section name="Playback" />
      <Line
        label="Picture in Picture"
        value={isPictureInPictureSupported() ? "Supported" : "Not on this iPhone"}
      />

      <Section name="Privacy" />
      <View style={styles.toggle}>
        <Text style={styles.label} importantForAccessibility="no" accessibilityElementsHidden>
          Share basic usage statistics
        </Text>
        <Switch
          accessibilityLabel="Share basic usage statistics"
          value={statistics.enabled}
          onValueChange={(enabled) => void setStatistics(enabled)}
          testID="settings-statistics"
        />
      </View>
      <Text style={styles.paragraph}>
        {[
          "Counts app use, the screens you open, and whether playback works and for how long.",
          "No viewing history, searches or provider details. Off unless you turn it on.",
          transportNote(statistics),
        ]
          .filter(Boolean)
          .join(" ")}
      </Text>

      <Section name="About" />
      <Line
        label="Version"
        value={`${Constants.expoConfig?.version ?? "?"} (${Constants.platform?.ios?.buildNumber ?? "?"})`}
      />
      <TmdbLine />
      {hasTmdb ? (
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
            This application uses TMDB and the TMDB APIs but is not endorsed, certified, or
            otherwise approved by TMDB. Where titles stream comes from JustWatch.
          </Text>
        </View>
      ) : null}
      {__DEV__ ? <Development /> : null}
      <View style={styles.end} />
    </ScrollView>
  );
}

/** A provider: its name, account and lists, with its own reloads. */
function Provider({ member }: { member: Member }) {
  const { entry, label, account, live, titles } = member;
  // Only what needs the viewer: a load under way or one that failed.
  const loads = [
    live.kind === "loading"
      ? "Loading channels"
      : live.kind === "failed"
        ? `Channels: ${failureOf(live.error, entry.server).headline}`
        : null,
    titles.kind === "loading"
      ? "Loading movies and series"
      : titles.kind === "failed"
        ? `Movies and series: ${failureOf(titles.error, entry.server).headline}`
        : null,
  ].filter((line) => line !== null);
  return (
    <>
      <View style={styles.block} accessible testID={`settings-provider-${entry.id}`}>
        <Text style={styles.name} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.plain} numberOfLines={2}>
          {[entry.username, accountLine(account, entry.server)].join(" · ")}
        </Text>
        {loads.map((line) => (
          <Text key={line} style={styles.plain} numberOfLines={2}>
            {line}
          </Text>
        ))}
      </View>
      <View style={styles.actions}>
        <TextButton label="Reload channels" onPress={() => reloadChannels(entry.id)} />
        <TextButton label="Reload movies and series" onPress={() => reloadTitles(entry.id)} />
        <TextButton
          label="Disconnect"
          onPress={() => void remove(entry.id, { keepHistory: false }).catch(() => undefined)}
          destructive
        />
      </View>
    </>
  );
}

/** Where statistics go in this build, when that isn't PostHog. */
function transportNote({ enabled, transport }: AnalyticsSettings): string | null {
  if (transport === "unavailable") return "They can't be saved on this iPhone right now.";
  if (!enabled || transport === "production") return null;
  return transport === "local"
    ? "This development build sends them to a test endpoint on this computer only."
    : "This build sends nothing.";
}

/** TMDB's part: movie and series facts and pictures, when the build has a key. */
function TmdbLine() {
  const tmdb = useMetadataStatus();
  return (
    <Line
      label="TMDB"
      value={
        !hasTmdb
          ? "Not in this build"
          : !tmdb
            ? "Waiting for the lists"
            : tmdb.refused
              ? "Refused the key"
              : tmdb.known < tmdb.wanted
                ? `${tmdb.known} of ${tmdb.wanted} titles`
                : `${tmdb.known} titles`
      }
    />
  );
}

/** What development builds also show. Release builds leave it out. */
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

/** The account as one plain line: "Active until 12 Mar 2027, 1 of 2 streams". */
function accountLine(account: AccountStatus | AppError | null, server: string): string {
  if (!account) return "Checking";
  if ("kind" in account) return failureOf(account, server).headline;
  const state = account.state === "active" ? "Active" : capitalised(account.state);
  const until = account.expiresAt
    ? ` until ${formatDate(Date.parse(account.expiresAt), "date")}`
    : "";
  const streams =
    account.maxConnections !== null
      ? `, ${account.activeConnections ?? 0} of ${account.maxConnections} streams`
      : "";
  return `${state}${until}${streams}`;
}

const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

function Section({ name }: { name: string }) {
  return (
    <Text style={styles.section} accessibilityRole="header">
      {name}
    </Text>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={2}>
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
  block: { marginHorizontal: 16, marginTop: 4, gap: 2 },
  name: { color: colors.text, fontSize: 17, fontWeight: "600" },
  plain: { color: colors.text, fontSize: 15 },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 44,
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
    marginHorizontal: 16,
  },
  label: { color: colors.text, fontSize: 17, flexShrink: 1 },
  value: { color: colors.dim, fontSize: 17, flexShrink: 1, textAlign: "right" },
  paragraph: {
    color: colors.dim,
    fontSize: 13,
    lineHeight: 18,
    marginHorizontal: 16,
    marginTop: 4,
  },
  actions: { marginHorizontal: 16, marginTop: 4 },
  notice: { marginHorizontal: 16, marginTop: 24, gap: 10 },
  logo: { width: 108, height: 14 },
  noticeText: { color: colors.dim, fontSize: 13, lineHeight: 18 },
  end: { height: 32 },
});
