// Catch-up as playlists describe it, in the conventions of Kodi's IPTV Simple Client, which most
// providers and players follow:
//
//   #EXTM3U catchup="shift" catchup-days="7"
//   #EXTINF:-1 catchup="append" catchup-days="3" catchup-source="?utc={utc}&lutc={lutc}",One HD
//   https://example.com/one/index.m3u8
//
// What is read:
// - The mode, from `catchup`, or as `catch-up` or `catchup-type` spell it, the entry's or else the
//   #EXTM3U line's:
//   - `default`: `catchup-source` is the recording's whole http(s) address.
//   - `append`: `catchup-source` goes after the stream's address.
//   - `shift`, or `timeshift`: `utc={utc}&lutc={lutc}` goes after it as a query (SIPTV's way).
//   - `flussonic`, or `fs`: Flussonic's archive addresses beside the stream's. `…/name/mpegts`
//     gives `…/name/timeshift_abs-{utc}.ts`, which plays on from that moment with no end, as
//     Kodi asks for it (playback stops it at the window's end), and `…/name/index.m3u8` (or
//     another playlist name) gives `…/name/index-{utc}-{duration}.m3u8`, with the stream's query.
//   - `xc`: an Xtream Codes stream address, `…/[live/]user/pass/id[.ext]`, gives
//     `…/timeshift/user/pass/{duration:60}/{Y}-{m}-{d}:{H}-{M}/id.ext`, `.ts` without one.
// - The days, from `catchup-days`, else `tvg-rec` or `timeshift`, whole days above zero; the
//   entry's, or else the #EXTM3U line's.
// - The placeholders, in a source and in what a mode makes of the stream's address. Times are Unix
//   seconds: `{utc}` and `${start}` the start, `{utcend}` and `${end}` the end, `{lutc}`, `${now}`
//   and `${timestamp}` the moment asked. `{duration}` and `${duration}` the length in seconds,
//   `{duration:N}` that divided by N; `{offset}`, `{offset:N}` and `${offset}` how long ago the
//   start was, the same way. `{Y}`, `{m}`, `{d}`, `{H}`, `{M}` and `{S}` the start's year, month,
//   day, hour, minute and second, in UTC. An address that names the start to the minute only,
//   with `{M}` and no second (`{S}`, `{utc}`, `${start}`, an offset), as `xc`'s does, starts on
//   the minute before the window's start; the length counts from there, and divisions round up,
//   so the end is never cut short.
//
// Not supported, so no catch-up: a mode without days or days without a mode, whose meaning players
// don't agree on; `vod` and modes not named here; a source a mode needs that is missing; a stream
// address a derived mode can't read. Ignored: `catchup-correction`, and date formats such as
// `{(b)YmdHMS}` and `${(b)yyyy-MM-dd}`. A playlist doesn't say an `xc` server's time zone, so its
// times are taken as UTC.
import type { ArchiveWindow } from "@mrstreamer/contracts/playback";
import { wallClock } from "../catchup.ts";
import type { PlaylistEntry } from "./m3u.ts";

/**
 * A stream's catch-up: the days its archive holds, and the address of a recording with the
 * placeholders still in it. It can hold the stream's login, so it stays in the main process.
 */
export interface PlaylistCatchup {
  readonly days: number;
  readonly template: string;
}

/** The entry's catch-up, or null when it has none or none this reads (see above). */
export function playlistCatchup(
  entry: Pick<PlaylistEntry, "attributes" | "header" | "url">,
): PlaylistCatchup | null {
  const read = (...names: string[]) =>
    names.map((name) => entry.attributes[name]).find((value) => value?.trim()) ??
    names.map((name) => entry.header[name]).find((value) => value?.trim());
  const mode = read("catchup", "catch-up", "catchup-type")?.trim().toLowerCase();
  const days = Number(read("catchup-days", "tvg-rec", "timeshift")?.trim());
  if (!mode || !Number.isInteger(days) || days <= 0) return null;
  const source = read("catchup-source")?.trim() ?? null;
  const template = templateOf(mode, entry.url, source);
  // A template that doesn't make an address once filled in is none.
  if (!template || !archiveAddress({ days, template }, { start: 0, end: 1 }, 1)) return null;
  return { days, template };
}

/**
 * The address of the recording in `window`, asked at `now`, with the moment in epoch ms the
 * recording it names starts at: the template with its placeholders filled in. Null when that is
 * no http(s) address.
 */
export function archiveAddress(
  catchup: PlaylistCatchup,
  window: ArchiveWindow,
  now: number,
): { readonly url: string; readonly start: number } | null {
  const unit = byMinute(catchup.template) ? 60_000 : 1000;
  const from = window.start - (window.start % unit);
  const start = from / 1000;
  const end = Math.ceil(window.end / 1000);
  const asked = Math.floor(now / 1000);
  const duration = end - start;
  const clock = wallClock(from, null);
  const divided = (seconds: number, by: string | undefined) =>
    String(Math.max(0, Math.ceil(seconds / (by ? Math.max(1, Number(by)) : 1))));
  const filled = catchup.template
    .replaceAll(/\$\{(start|end|now|timestamp|duration|offset)\}/g, (_, name: string) =>
      name === "start"
        ? String(start)
        : name === "end"
          ? String(end)
          : name === "duration"
            ? String(duration)
            : name === "offset"
              ? divided(asked - start, undefined)
              : String(asked),
    )
    .replaceAll(/\{(duration|offset)(?::(\d+))?\}/g, (_, name: string, by: string | undefined) =>
      divided(name === "duration" ? duration : asked - start, by),
    )
    .replaceAll(/\{(utc|utcend|lutc|Y|m|d|H|M|S)\}/g, (_, name: string) => {
      switch (name) {
        case "utc":
          return String(start);
        case "utcend":
          return String(end);
        case "lutc":
          return String(asked);
        case "Y":
          return clock.year;
        case "m":
          return clock.month;
        case "d":
          return clock.day;
        case "H":
          return clock.hour;
        case "M":
          return clock.minute;
        default:
          return clock.second;
      }
    });
  const url = URL.parse(filled);
  return url && (url.protocol === "http:" || url.protocol === "https:")
    ? { url: filled, start: from }
    : null;
}

/** Whether a template names its start to the minute only: `{M}`, and no second of it. */
function byMinute(template: string): boolean {
  return (
    template.includes("{M}") && !/\{(S|utc|offset(:\d+)?)\}|\$\{(start|offset)\}/.test(template)
  );
}

/** The recording address with placeholders that `mode` makes for the stream at `url`. */
function templateOf(mode: string, url: string, source: string | null): string | null {
  switch (mode) {
    case "default":
      return source && /^https?:\/\//i.test(source) ? source : null;
    case "append":
      return source ? url + source : null;
    case "shift":
    case "timeshift":
      return `${url}${url.includes("?") ? "&" : "?"}utc={utc}&lutc={lutc}`;
    case "flussonic":
    case "fs":
      return flussonic(url);
    case "xc":
      return xtreamCodes(url);
    default:
      return null;
  }
}

/** Flussonic's archive address beside a stream's: MPEG-TS from a moment on, or an HLS stretch. */
function flussonic(url: string): string | null {
  const match = /^(https?:\/\/[^/?#]+\/.+)\/([^/?#]+?)(\.m3u8)?(\?[^#]*)?$/i.exec(url);
  if (!match) return null;
  const [, base, name = "", playlist, query = ""] = match;
  if (playlist) return `${base}/${name}-{utc}-{duration}.m3u8${query}`;
  return name === "mpegts" ? `${base}/timeshift_abs-{utc}.ts${query}` : null;
}

/** Xtream Codes' timeshift address of a stream's. */
function xtreamCodes(url: string): string | null {
  const match =
    /^(https?:\/\/[^/?#]+(?:\/[^?#]*?)??)\/(?:live\/)?([^/?#]+)\/([^/?#]+)\/(\d+)(\.\w+)?$/i.exec(
      url,
    );
  if (!match) return null;
  const [, base, user, pass, id, extension = ".ts"] = match;
  return `${base}/timeshift/${user}/${pass}/{duration:60}/{Y}-{m}-{d}:{H}-{M}/${id}${extension}`;
}
