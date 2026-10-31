import type { AppError } from "@mrstreamer/contracts/errors";
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

const PROVIDER_KINDS = { xtream: "Xtream", m3u: "M3U playlist", demo: "Demo" } as const;

function tmdb(standing: MetadataStanding): string {
  if (standing.kind === "reading") return "checking the key";
  if (standing.kind === "no-key") return "no key";
  const key = standing.key === "yours" ? "your key" : "the app's key";
  const count = `${standing.known} of ${standing.wanted} titles answered`;
  switch (standing.kind) {
    case "waiting":
      return `${key}, waiting for the lists`;
    case "refused":
      return `${key}, refused by TMDB`;
    case "unavailable":
      return `${key}, not answering, ${count}`;
    case "fetching":
      return `${key}, asking, ${count}`;
    case "answered":
      return `${key}, ${count}`;
  }
}

/** The diagnostics as the viewer previews and shares them, read now. */
export function diagnosticsText(): string {
  const version = checked(Constants.expoConfig?.version, /^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
  const build = checked(Constants.platform?.ios?.buildNumber, /^\d{1,9}$/);
  const system = checked(String(Platform.Version), /^\d{1,3}(\.\d{1,3}){0,2}$/);
  const all = members();
  return [
    `Mr. Streamer ${version} (${build}) · iOS ${system}`,
    `Providers: ${all.length}`,
    ...all.map(
      (member, at) =>
        `Provider ${at + 1}: ${PROVIDER_KINDS[member.entry.kind]} · account ${account(member)} · channels ${loaded(member.live)} · movies and series ${loaded(member.titles)}`,
    ),
    `TMDB: ${tmdb(metadataStanding())}`,
    "",
    OMITTED,
    "",
  ].join("\n");
}
