// One actual playable file must satisfy the whole filter. Different versions never lend each
// other hints or tracks. The caller supplies only facts validated against its current lists.
import type { Title, TitleVersion } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import {
  QUALITY_HINTS,
  type FilterOptions,
  type QualityHint,
  type TitleFilters,
} from "@mrstreamer/contracts/title-filters";
import { languageHints } from "./languages.ts";

export interface FilterFile {
  /** Episode name hints can differ from the series name; movie files use their version's. */
  readonly tags: readonly string[];
  readonly tracks?: {
    readonly audio: readonly (string | null)[];
    readonly subtitles: readonly (string | null)[];
  };
}

/** Each listed version's current files. An empty series still has its name hints, but no tracks. */
export type FilterFiles = ReadonlyMap<string, readonly FilterFile[]>;

export function qualityHint(tags: readonly string[]): QualityHint {
  const marks = new Set(tags);
  if (marks.has("4K") || marks.has("UHD") || marks.has("2160p")) return "4k";
  if (marks.has("FHD") || marks.has("1080p")) return "full-hd";
  if (marks.has("HD") || marks.has("720p")) return "hd";
  if (marks.has("SD") || marks.has("480p") || marks.has("576p")) return "sd";
  return "unknown";
}

function filesOf(version: TitleVersion, files: FilterFiles): readonly FilterFile[] {
  return files.get(ownedKey(version)) ?? [{ tags: version.tags }];
}

function trackLanguages(file: FilterFile, kind: "audio" | "subtitles"): readonly string[] {
  const tracks = file.tracks?.[kind];
  return tracks?.length ? tracks.map((code) => code ?? "unknown") : ["unknown"];
}

/** Keeps catalogue order and all choices, while making the matching real version the tile's id. */
export function filterTitles(
  titles: readonly Title[],
  filters: TitleFilters,
  files: FilterFiles,
): readonly Title[] {
  if (!filters.quality && !filters.language && !filters.verified) return titles;
  return titles.flatMap((title) => {
    const match = title.versions.find((version) =>
      filesOf(version, files).some(
        (file) =>
          (!filters.quality || qualityHint(file.tags) === filters.quality) &&
          (!filters.language || languageHints(file.tags).includes(filters.language)) &&
          (!filters.verified ||
            trackLanguages(file, filters.verified.kind).includes(filters.verified.language)),
      ),
    );
    return match
      ? [{ ...title, subscriptionId: match.subscriptionId, id: match.id, tags: match.tags }]
      : [];
  });
}

/** Available words come only from the current kind's loaded files, never a network read. */
export function filterOptions(titles: readonly Title[], files: FilterFiles): FilterOptions {
  const qualities = new Set<QualityHint>();
  const languages = new Set<string>();
  const audio = new Set<string>();
  const subtitles = new Set<string>();
  const seen = new Set<string>();
  let verifiedFiles = 0;
  for (const title of titles)
    for (const version of title.versions) {
      const key = ownedKey(version);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const file of filesOf(version, files)) {
        qualities.add(qualityHint(file.tags));
        for (const hint of languageHints(file.tags)) languages.add(hint);
        if (file.tracks) verifiedFiles++;
        for (const code of trackLanguages(file, "audio")) audio.add(code);
        for (const code of trackLanguages(file, "subtitles")) subtitles.add(code);
      }
    }
  const sorted = (values: Set<string>) =>
    [...values].sort((a, b) => (a === "unknown" ? 1 : b === "unknown" ? -1 : a.localeCompare(b)));
  return {
    qualities: QUALITY_HINTS.filter((value) => qualities.has(value)),
    languages: sorted(languages),
    verified: verifiedFiles
      ? [
          ...sorted(audio).map((language) => ({ kind: "audio" as const, language })),
          ...sorted(subtitles).map((language) => ({ kind: "subtitles" as const, language })),
        ]
      : [],
    files: verifiedFiles,
  };
}
