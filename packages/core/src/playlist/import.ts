// Explicit group classification. Names never imply a movie, and unknown groups wait for a pick.
import { createHash } from "node:crypto";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type {
  PlaylistMapping,
  PlaylistMode,
  PlaylistOmission,
  PlaylistSample,
} from "@mrstreamer/contracts/playlist";
import type { ProviderDetails, ProviderEpisode, ProviderTitle } from "../provider.ts";
import {
  playlistCatalogue,
  streamFormat,
  type ImportedPlaylist,
  type PlaylistFile,
} from "./catalogue.ts";
import { playlistEpisode } from "./episode.ts";
import type { PlaylistEntry } from "./m3u.ts";

export type { ImportedPlaylist } from "./catalogue.ts";

export function playlistGroups(entry: PlaylistEntry): string[] {
  const groups = (entry.attributes["group-title"] || entry.group || "")
    .split(";")
    .map((group) => group.trim())
    .filter(Boolean);
  return groups.length ? [...new Set(groups)] : [""];
}

/** Unmapped Live uses the original catalogue without exact-title or mapping-report bookkeeping. */
export function importPlaylist(
  entries: readonly PlaylistEntry[],
  mapping?: PlaylistMapping,
): ImportedPlaylist {
  if (mapping) return classifiedPlaylist(entries, mapping);
  const live = playlistCatalogue(entries);
  return {
    live,
    catalogue: { movieCategories: [], movies: [], seriesCategories: [], series: [] },
    files: new Map<string, PlaylistFile>(),
    details: new Map<string, ProviderDetails>(),
    groups: new Map<string, readonly PlaylistSample[]>(),
    omissions: [],
    status: {
      explicit: false,
      groups: 0,
      live: live.channels.length,
      movies: 0,
      series: 0,
      episodes: 0,
      omitted: 0,
    },
  };
}

/** Settings inspects an unmapped source under the same limits as its first explicit mapping. */
export function inspectPlaylist(entries: readonly PlaylistEntry[]): ImportedPlaylist {
  return classifiedPlaylist(entries);
}

/** Mapped exact copies collapse. Address, headers and attributes identify each title version. */
function classifiedPlaylist(
  entries: readonly PlaylistEntry[],
  mapping?: PlaylistMapping,
): ImportedPlaylist {
  if (entries.length > 100_000)
    throw new AppFailure({ kind: "unexpected", detail: "Playlist exceeds 100,000 entries." });
  const unique = new Map<string, PlaylistEntry>();
  for (const entry of entries) {
    const exact = JSON.stringify([
      entry.name,
      entry.url,
      Object.entries(entry.attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      entry.group,
      entry.userAgent,
      entry.referrer,
    ]);
    if (!unique.has(exact)) unique.set(exact, entry);
  }
  const modes = new Map(mapping?.groups.map(({ group, mode }) => [group, mode]));
  const files = new Map<string, PlaylistFile>();
  const details = new Map<string, ProviderDetails>();
  const groups = new Map<string, PlaylistSample[]>();
  const omissions: PlaylistOmission[] = [];
  const live: PlaylistEntry[] = [];
  const movies: ProviderTitle[] = [];
  const series = new Map<string, { title: ProviderTitle; episodes: ProviderEpisode[] }>();
  const movieCategories = new Map<string, { id: string; name: string }>();
  const seriesCategories = new Map<string, { id: string; name: string }>();
  let episodeCount = 0;
  for (const [exact, entry] of unique) {
    const names = playlistGroups(entry);
    const choices = names.map((group) => (mapping ? modes.get(playlistGroupId(group)) : "live"));
    const chosen = new Set(choices);
    const mode = chosen.size === 1 ? choices[0] : undefined;
    const name = entry.name || entry.attributes["tvg-name"] || "";
    const format = streamFormat(entry.url);
    const episode = mode === "series" ? playlistEpisode(name) : null;
    const reason =
      !format || (format === "hls" && (mode === "movie" || mode === "series"))
        ? "unsupported-address"
        : choices.some((each) => each === undefined)
          ? "unmapped"
          : chosen.size > 1
            ? "conflicting-groups"
            : mode === "skip"
              ? "skip"
              : mode !== "live" && !name
                ? "missing-name"
                : mode === "series" && !episode
                  ? "invalid-episode"
                  : null;
    const report: PlaylistSample = {
      name: safeName(name || "Unnamed entry"),
      groups: names.map(safeName),
      reason,
    };
    for (const group of names) {
      const samples = groups.get(group);
      if (samples) samples.push(report);
      else {
        if (groups.size === 10_000)
          throw new AppFailure({ kind: "unexpected", detail: "Playlist exceeds 10,000 groups." });
        groups.set(group, [report]);
      }
    }
    if (reason) {
      omissions.push({ ...report, reason });
      continue;
    }
    if (mode === "live") {
      if (!mapping) continue;
      live.push({
        ...entry,
        name: safeName(name),
        attributes: {
          ...entry.attributes,
          "tvg-id": safeName(entry.attributes["tvg-id"] || ""),
          "group-title": names.map(safeName).join(";"),
        },
      });
      continue;
    }
    if (mode !== "movie" && mode !== "series") continue;
    // tvg-id often identifies a channel, not an exact file. Hash the complete source version.
    const id = `m3u:${digest(exact)}`;
    const container = fileContainer(entry.url);
    const categories = mode === "movie" ? movieCategories : seriesCategories;
    for (const group of names)
      categories.set(group, { id: playlistGroupId(group), name: safeName(group || "Ungrouped") });
    const poster = artwork(entry.attributes["tvg-logo"]);
    const explicitTmdb = entry.attributes["tmdb-id"] ?? entry.attributes["tmdb_id"];
    const tmdbId = explicitTmdb && /^[1-9]\d{0,9}$/.test(explicitTmdb) ? explicitTmdb : null;
    const title: ProviderTitle = {
      id,
      name: safeName(name),
      posterUrl: poster,
      backdropUrl: null,
      rating: null,
      addedAt: null,
      releaseDate: null,
      categoryIds: names.map(playlistGroupId),
      adult: false,
      container,
      metadata: "lazy",
      tmdbId,
    };
    files.set(id, {
      url: entry.url,
      format: format!,
      container,
      kind: mode === "movie" ? "movie" : "episode",
      headers: {
        ...(entry.userAgent ? { "User-Agent": entry.userAgent } : {}),
        ...(entry.referrer ? { Referer: entry.referrer } : {}),
      },
    });
    if (mode === "movie") {
      movies.push(title);
      details.set(id, emptyDetails(safeName(name), poster, container));
    } else if (episode) {
      // Only exact series names in the same mapped groups join. No name matching across providers.
      const seriesId = `m3u-series:${digest(JSON.stringify([episode.series, names.toSorted(), tmdbId]))}`;
      let found = series.get(seriesId);
      if (!found) {
        found = {
          title: { ...title, id: seriesId, name: safeName(episode.series), container: null },
          episodes: [],
        };
        series.set(seriesId, found);
      }
      found.episodes.push({
        id,
        season: episode.season,
        number: episode.episode,
        name: safeName(name),
        plot: null,
        duration: null,
        stillUrl: null,
        airDate: null,
        addedAt: null,
        container,
      });
      episodeCount++;
    }
  }
  for (const [id, { title, episodes }] of series) {
    details.set(id, {
      ...emptyDetails(title.name, title.posterUrl, null),
      episodeOrder: "source",
      episodes,
    });
  }
  // Unmapped Live keeps its original names, ids, duplicates and order for saved favourites.
  const channels = playlistCatalogue(mapping ? live : entries);
  return {
    live: channels,
    catalogue: {
      movieCategories: [...movieCategories.values()],
      movies,
      seriesCategories: [...seriesCategories.values()],
      series: [...series.values()].map(({ title, episodes }) => ({
        ...title,
        episodeFiles: episodes.map((episode) => episode.id),
      })),
    },
    files,
    details,
    groups,
    omissions,
    status: {
      explicit: !!mapping,
      groups: groups.size,
      live: channels.channels.length,
      movies: movies.length,
      series: series.size,
      episodes: episodeCount,
      omitted: omissions.length,
    },
  };
}

/** First explicit pick keeps every other current group explicitly Live, but never future groups. */
export function mapPlaylistGroup(
  mapping: PlaylistMapping | undefined,
  groups: Iterable<string>,
  group: string,
  mode: PlaylistMode,
): PlaylistMapping {
  const all = new Map(
    mapping?.groups.map((each) => [each.group, each.mode]) ??
      [...groups].map((each) => [each, "live" as const]),
  );
  all.set(group, mode);
  return { version: 1, groups: [...all].map(([group, mode]) => ({ group, mode })) };
}

export function playlistGroupId(group: string): string {
  return digest(group);
}

export function fileContainer(address: string): string {
  return /\.([a-z0-9]{1,8})$/i.exec(new URL(address).pathname)?.[1]?.toLowerCase() ?? "ts";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyDetails(
  name: string,
  poster: string | null,
  container: string | null,
): ProviderDetails {
  return {
    originalName: name,
    plot: null,
    genres: [],
    cast: [],
    directors: [],
    releaseDate: null,
    duration: null,
    posterUrl: poster,
    backdropUrl: null,
    seasons: [],
    episodes: [],
    container,
  };
}

function artwork(value: string | undefined): string | null {
  const url = value ? URL.parse(value) : null;
  return url && /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search
    ? url.href
    : null;
}

/** Playlist names and groups are untrusted copy, and must never expose a provider link. */
export function safeName(value: string): string {
  return value
    .slice(0, 512)
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, "[address]")
    .slice(0, 512);
}
