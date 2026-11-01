import type { AppError } from "@mrstreamer/contracts/errors";
import { formatDate, formatNumber } from "@mrstreamer/core/i18n";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { members, type Loadable, type Member } from "./account.ts";
import { metadataStanding, type MetadataStanding } from "./titles.ts";

// Diagnostics the viewer reads before sharing them: how the app and each provider stand, as kinds
// and counts. Every line is written from known fields, never from a log or an error's own words,
// which can hold an address or a login. Providers are numbered, never named. No address, login,
// provider or title name, viewing history, file path or device identity is part of it, and
// nothing is sent anywhere: the viewer shares the text themselves.

/** What the text leaves out, said at its end. */
const OMITTED =
  "Addresses, logins, provider and title names, viewing history and file paths are left out.";

/** `value` when it reads as `pattern` whole, else "unknown". */
const checked = (value: unknown, pattern: RegExp) =>
  typeof value === "string" && pattern.test(value) ? value : "unknown";

/** An error's kind, which is a word of the app's own; never its detail. */
const kindOf = (error: AppError) => checked(error.kind, /^[a-z][a-z-]{0,39}$/);

function loaded(list: Loadable<unknown>): string {
  switch (list.kind) {
    case "idle":
      return "not loaded";
    case "loading":
      return "loading";
    case "ready":
      return list.from === "cache" ? "saved copy" : "loaded";
    case "failed":
      return `failed (${kindOf(list.error)})${list.last ? ", saved copy shown" : ""}`;
  }
}

function account({ entry, account, needsSecret }: Member): string {
  if (entry.kind === "demo") return "demo";
  if (needsSecret) return "needs its password or link again";
  if (!account) return "checking";
  if ("kind" in account) return `failed (${kindOf(account)})`;
  return checked(account.state, /^(active|expired|banned|disabled|unknown)$/);
}

const PROVIDER_KINDS = { xtream: "Xtream", m3u: "M3U", demo: "Demo" } as const;

/** "2 Xtream, 1 M3U", in the order of the kinds above. */
function providerCount(all: readonly Member[]): string {
  const counted = Object.entries(PROVIDER_KINDS).flatMap(([kind, name]) => {
    const count = all.filter((member) => member.entry.kind === kind).length;
    return count > 0 ? [`${count} ${name}`] : [];
  });
  return counted.join(", ") || "none";
}

function provider(member: Member, at: number): string[] {
  return [
    `Provider ${at + 1}, ${PROVIDER_KINDS[member.entry.kind]}`,
    `  Channels: ${loaded(member.live)}`,
    `  Movies and series: ${loaded(member.titles)}`,
    `  Account: ${account(member)}`,
  ];
}

const KEYS = { yours: "yours, in the Keychain", app: "the app's" } as const;

function tmdb(standing: MetadataStanding): string[] {
  if (standing.kind === "reading") return ["TMDB", "  Key: checking"];
  if (standing.kind === "no-key") return ["TMDB", "  Key: none"];
  const status = {
    waiting: "waiting for the lists",
    unlinked: "no titles with a TMDB id",
    refused: "refused the key",
    unavailable: "not answering",
    fetching: "asking",
    answered: "answered",
  }[standing.kind];
  return [
    "TMDB",
    `  Key: ${KEYS[standing.key]}`,
    `  Status: ${status}`,
    ...(standing.wanted > 0
      ? [`  Titles: ${formatNumber(standing.known)} of ${formatNumber(standing.wanted)}`]
      : []),
  ];
}

/** The diagnostics as the viewer previews and shares them, read now. */
export function diagnosticsText(): string {
  const version = checked(Constants.expoConfig?.version, /^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
  const build = checked(Constants.platform?.ios?.buildNumber, /^\d{1,9}$/);
  const system = checked(String(Platform.Version), /^\d{1,3}(\.\d{1,3}){0,2}$/);
  const all = members();
  const now = Date.now();
  return [
    `Mr. Streamer ${version} (${build})`,
    `iOS ${system}`,
    `Providers: ${providerCount(all)}`,
    "",
    ...all.flatMap(provider),
    ...(all.length > 0 ? [""] : []),
    ...tmdb(metadataStanding()),
    "",
    `Made ${formatDate(now, "date")}, ${formatDate(now, "time")}`,
    "",
    OMITTED,
    "",
  ].join("\n");
}
