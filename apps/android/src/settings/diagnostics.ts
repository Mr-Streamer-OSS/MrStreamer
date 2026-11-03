import { formatDate, formatNumber } from "@mrstreamer/core/i18n";
import type { Sources } from "../connect/sources.ts";

const checked = (value: string, pattern: RegExp) => (pattern.test(value) ? value : "unknown");

/** Anonymous kinds, status and counts only. Never interpolate source labels, errors or rows. */
export function diagnosticsText(input: {
  readonly version: string;
  readonly build: string;
  readonly release: string;
  readonly api: number;
  readonly sources: Sources;
  readonly now: number;
}): string {
  const all = input.sources.kind === "ready" ? input.sources.sources : [];
  const kinds = { xtream: "Xtream", m3u: "M3U" } as const;

  const counts = Object.entries(kinds).flatMap(([kind, name]) => {
    const count = all.filter((source) => source.kind === kind).length;

    return count ? [`${formatNumber(count)} ${name}`] : [];
  });

  return [
    `Mr. Streamer ${checked(input.version, /^\d{1,4}\.\d{1,4}\.\d{1,4}$/)} (${checked(input.build, /^\d{1,9}$/)})`,
    `Android release: ${checked(input.release, /^\d{1,3}(\.\d{1,3}){0,2}$/)}`,
    `API level: ${Number.isInteger(input.api) && input.api >= 26 && input.api < 100 ? input.api : "unknown"}`,
    `Providers: ${input.sources.kind === "restoring" ? "checking" : counts.join(", ") || "none"}`,
    "",
    ...all.flatMap((source, at) => [
      `Provider ${at + 1}, ${kinds[source.kind]}`,
      `  Channels: ${source.channels.kind === "ready" ? `loaded (${formatNumber(source.channels.rows.length)})` : source.channels.kind === "loading" ? "loading" : "failed"}`,
      ...(source.channels.kind === "failed" && source.channels.error.kind === "needs-secret"
        ? ["  Account: needs its password or link again"]
        : []),
    ]),
    "",
    `Made ${formatDate(input.now, "date")}, ${formatDate(input.now, "time")}`,
    "",
    "Addresses, logins, provider and title names, viewing history and file paths are left out.",
    "",
  ].join("\n");
}
