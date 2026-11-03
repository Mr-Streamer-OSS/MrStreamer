import { languageCode } from "@mrstreamer/core/ondemand/tracks";

// What a TV gets of a stream, decided on the phone: the first media profile a Cast Default Media
// Receiver is given, and each HLS playlist rewritten so the TV reads only the phone's relay. For
// cast.ts, which serves them.
//
// The TV never sees a provider's address. Every URI a playlist names becomes an opaque path under
// the relay's token for this load; tags whose URIs the first slice doesn't relay are dropped. A
// stream with a key is refused, whenever its key appears, since the receiver would have to fetch
// it from the provider. Subtitles are left out of the first slice, and of a title's sound tracks
// only the chosen one goes, so the TV can't pick another the viewer didn't.

/** Why a stream can't play on a TV, said before anything reaches it. */
export type Refusal =
  /** A file the first profile has no way to send, such as AVI. */
  | "format"
  /** A key, so the TV would need the provider's address. */
  | "protected"
  /** Picture or sound outside the first profile, such as HEVC or AC-3. */
  | "codec"
  /** A channel that isn't HLS, which the relay doesn't carry. */
  | "stream";

/** How a source goes to the TV: through a format session as HLS, as it is, or not at all. */
export type TvPath =
  | { readonly kind: "session" }
  | { readonly kind: "file"; readonly contentType: string }
  | { readonly kind: "hls" }
  | { readonly kind: "refused"; readonly refusal: Refusal };

const FILES: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/mp4",
};

/**
 * The way a source with `container` goes to a TV. A channel goes only as HLS; a title in Matroska
 * through a format session from its start, and an MP4 or MOV as it is, ranges and all.
 */
export function tvPath(container: string, live: boolean): TvPath {
  const type = container.toLowerCase();
  if (type === "m3u8") return { kind: "hls" };
  if (live) return { kind: "refused", refusal: "stream" };
  if (type === "mkv") return { kind: "session" };
  const file = FILES[type];
  return file ? { kind: "file", contentType: file } : { kind: "refused", refusal: "format" };
}

/** Whether the URI points at a playlist, which the relay reads and rewrites, or at media. */
export type RouteKind = "playlist" | "media";

/** One rewritten playlist: its text, and the segment format a LOAD names, once a segment says. */
export type Rewritten =
  | {
      readonly kind: "playlist";
      readonly text: string;
      /** The first variant's address, for a master playlist; null for a media playlist. */
      readonly variant: string | null;
      /** "fmp4" with an EXT-X-MAP, "ts" for MPEG-TS segments; null when no segment says. */
      readonly segments: "fmp4" | "ts" | null;
    }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** The H.264 profiles of the first profile: Baseline, Main, Extended and High. */
const AVC_PROFILES = new Set(["42", "4D", "58", "64"]);
/** Level 4.1, the first profile's highest. */
const AVC_LEVEL = 0x29;
/** AAC-LC, HE-AAC and HE-AACv2. */
const SOUNDS = new Set(["mp4a.40.2", "mp4a.40.5", "mp4a.40.29"]);

/** The attributes of a tag's `NAME=value` list, quoted values kept quoted. */
function attributes(list: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name = "", value = ""] of list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    found.set(name, value);
  }
  return found;
}

const unquoted = (value: string | undefined) => value?.replace(/^"|"$/g, "") ?? null;
const written = (values: Map<string, string>) =>
  [...values].map(([name, value]) => `${name}=${value}`).join(",");

/**
 * A variant's CODECS within the first profile, keeping only the sounds it plays; null when its
 * picture is outside it or none of its sounds is in it. A variant that names no codecs is let
 * through: the TV decides.
 */
function profiled(codecs: string | null, strict: boolean): string | null | undefined {
  if (codecs === null) return strict ? null : undefined;
  // Text tracks, such as WebVTT or TTML, are left out with the subtitles.
  const named = codecs
    .split(",")
    .map((codec) => codec.trim())
    .filter((codec) => !/^(wvtt|stpp|tx3g|c608|c708)\b/i.test(codec));
  const pictures = named.filter((codec) => !codec.startsWith("mp4a.") && !/^[ae]c-3$/.test(codec));
  const sounds = named.filter((codec) => !pictures.includes(codec));
  const picturesFit = pictures.every((codec) => {
    const avc = /^avc1\.([0-9A-F]{2})[0-9A-F]{2}([0-9A-F]{2})$/i.exec(codec);
    return (
      avc !== null && AVC_PROFILES.has(avc[1]!.toUpperCase()) && parseInt(avc[2]!, 16) <= AVC_LEVEL
    );
  });
  const fitting = sounds.filter((codec) => SOUNDS.has(codec));
  if (!picturesFit || (sounds.length > 0 && fitting.length === 0)) return null;
  // The format session's sound tracks share one group whose renditions don't say their codec, so
  // the chosen one could be the AC-3 one: a file with any sound outside the profile is refused.
  if (strict && fitting.length < sounds.length) return null;
  return [...pictures, ...fitting].join(",");
}

/** Whether a variant's RESOLUTION is within 1080p; one that names none is let through. */
function fitsScreen(resolution: string | undefined): boolean {
  const size = /^(\d+)x(\d+)$/.exec(resolution ?? "");
  return !size || (Number(size[1]) <= 1920 && Number(size[2]) <= 1080);
}

/**
 * Rewrites one playlist read from `base`, its address after any redirect, for the TV. `route`
 * turns each URI it names into the relay's path for it, made once per playlist read. `sound` is
 * the chosen sound's language code: of each sound group only the track in it goes, else the group's
 * default, else its first. `strict` refuses a variant that names no codecs, as the format
 * session's own playlist names every codec it can.
 */
export function rewritePlaylist(
  text: string,
  base: string,
  route: (url: string, kind: RouteKind) => string,
  sound: string | null,
  strict = false,
): Rewritten {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "#EXTM3U") return { kind: "refused", refusal: "stream" };
  /** Set by a URI that isn't http or https, such as `file:`, which refuses the whole playlist. */
  let foreign = false;
  const absolute = (uri: string) => {
    const resolved = resolveUri(uri, base);
    if (resolved === null) foreign = true;
    return resolved ?? "";
  };
  const out: string[] = [];
  let segments: "fmp4" | "ts" | null = null;
  let variant: string | null = null;
  let master = false;
  let variants = 0;
  /** The STREAM-INF waiting for its URI line, or "skip" for one whose URI is left out. */
  let pending: string | "skip" | null = null;
  const sounds = soundsKept(lines, sound);

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("#")) {
      if (pending === "skip") {
        pending = null;
        continue;
      }
      if (pending !== null) {
        const path = route(absolute(line), "playlist");
        variant ??= path;
        out.push(pending, path);
        pending = null;
        continue;
      }
      segments ??= /\.(m4s|mp4|m4v|cmfv)(\?|$)/i.test(line) ? "fmp4" : "ts";
      out.push(route(absolute(line), "media"));
      continue;
    }
    const colon = line.indexOf(":");
    const tag = colon < 0 ? line : line.slice(0, colon);
    const values = attributes(colon < 0 ? "" : line.slice(colon + 1));
    switch (tag) {
      case "#EXT-X-KEY":
      case "#EXT-X-SESSION-KEY":
        if (unquoted(values.get("METHOD")) !== "NONE")
          return { kind: "refused", refusal: "protected" };
        continue;
      case "#EXT-X-STREAM-INF": {
        master = true;
        const codecs = profiled(unquoted(values.get("CODECS")), strict);
        if (codecs === null || !fitsScreen(values.get("RESOLUTION"))) {
          pending = "skip";
          continue;
        }
        if (codecs !== undefined) values.set("CODECS", `"${codecs}"`);
        values.delete("SUBTITLES");
        values.delete("CLOSED-CAPTIONS");
        variants++;
        pending = `${tag}:${written(values)}`;
        continue;
      }
      case "#EXT-X-MEDIA": {
        master = true;
        if (unquoted(values.get("TYPE")) !== "AUDIO" || !sounds.has(raw)) continue;
        values.set("DEFAULT", "YES");
        values.set("AUTOSELECT", "YES");
        const uri = unquoted(values.get("URI"));
        if (uri !== null) values.set("URI", `"${route(absolute(uri), "playlist")}"`);
        out.push(`${tag}:${written(values)}`);
        continue;
      }
      case "#EXT-X-MAP": {
        const uri = unquoted(values.get("URI"));
        if (uri === null) continue;
        segments = "fmp4";
        values.set("URI", `"${route(absolute(uri), "media")}"`);
        out.push(`${tag}:${written(values)}`);
        continue;
      }
      default:
        // Every other tag that names a URI, such as I-frame playlists, parts, preload hints,
        // steering and session data, would send the TV elsewhere: it goes.
        if (/URI=/.test(line)) continue;
        out.push(line);
    }
  }
  if (foreign) return { kind: "refused", refusal: "stream" };
  if (master && variants === 0) return { kind: "refused", refusal: "codec" };
  return { kind: "playlist", text: `${out.join("\n")}\n`, variant, segments };
}

/** The EXT-X-MEDIA sound lines kept: one per group, in the language chosen when one is. */
function soundsKept(lines: readonly string[], sound: string | null): Set<string> {
  const groups = new Map<string, Array<{ line: string; values: Map<string, string> }>>();
  for (const line of lines) {
    if (!line.startsWith("#EXT-X-MEDIA:")) continue;
    const values = attributes(line.slice(13));
    if (unquoted(values.get("TYPE")) !== "AUDIO") continue;
    const group = unquoted(values.get("GROUP-ID")) ?? "";
    groups.set(group, [...(groups.get(group) ?? []), { line, values }]);
  }
  const kept = new Set<string>();
  for (const members of groups.values()) {
    const isDefault = ({ values }: (typeof members)[number]) =>
      unquoted(values.get("DEFAULT")) === "YES";
    // As the phone decides: in the language, its default track first; else the default.
    const spoken =
      sound === null
        ? []
        : members.filter(({ values }) => languageCode(unquoted(values.get("LANGUAGE"))) === sound);
    const chosen = spoken.find(isDefault) ?? spoken[0] ?? members.find(isDefault) ?? members[0];
    if (chosen) kept.add(chosen.line);
  }
  return kept;
}

const HTTP = /^(https?:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i;

/**
 * `uri` resolved against `base` as RFC 3986 does, or null unless both are http or https. React
 * Native's own `URL` joins a relative path onto the whole base, playlist name and all, so it isn't
 * used here.
 */
function resolveUri(uri: string, base: string): string | null {
  const from = HTTP.exec(base);
  if (!from) return null;
  const [, scheme = "", authority = "", path = "", query = ""] = from;
  const target = uri.trim().replace(/#.*$/, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return HTTP.test(target) ? target.replace(/^[a-z]+/i, (name) => name.toLowerCase()) : null;
  }
  if (target.startsWith("//")) return `${scheme}${target}`;
  if (target === "") return `${scheme}//${authority}${path}${query}`;
  if (target.startsWith("?")) return `${scheme}//${authority}${path}${target}`;
  const [relative = "", rest = ""] = /^([^?]*)(.*)$/.exec(target)!.slice(1);
  const merged = relative.startsWith("/")
    ? relative
    : `${path.slice(0, path.lastIndexOf("/") + 1) || "/"}${relative}`;
  const kept: string[] = [];
  const parts = merged.split("/");
  parts.forEach((part, at) => {
    if (part === "..") {
      if (kept.length > 1) kept.pop();
    } else if (part !== ".") kept.push(part);
    // A path ending in "." or ".." still names a directory.
    if (at === parts.length - 1 && (part === "." || part === "..")) kept.push("");
  });
  return `${scheme}//${authority}${kept.join("/")}${rest}`;
}
