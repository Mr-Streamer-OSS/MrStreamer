// Catch-up as HLS, for the native player, at the address Xtream panels give it with `.m3u8` in
// place of the `.ts` the desktop asks for (core's `archiveStream`):
//
//   /timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<id>.m3u8
//
// The start is on the panel's clock, Europe/Amsterdam, as the fake panel's login answer says. The
// channels that keep catch-up are the panel's: "TEST | H.264 + AAC" (1000) three days and
// "TEST | HEVC + AAC" (1006) two. A window they hold, one that has started within those days,
// answers a recording from that start (see `recordingPlaylist`), looping the fixture server's
// ten-minute catch-up picture, whose counter shows the seconds since the start: the whole
// window once it has ended, and while it is still on, an event playlist of what has aired so far,
// which grows until it ends, as a programme started over. Its segments, `/hls/<id>/past/<n>.ts`,
// are logged as "archive", apart from live ones. A channel without catch-up and a window outside
// the days kept answer 404, a wrong login 401. scripts/fixture-server.ts's `/fail-live` fails a
// channel's catch-up playlists as it does its live ones.
import { recordingPlaylist, type Media } from "./media.ts";

/** The fake panel's own clock, which its timeshift addresses are on. */
const PANEL_TIME_ZONE = "Europe/Amsterdam";
const DAY_MS = 24 * 60 * 60 * 1000;

const panelClock = new Intl.DateTimeFormat("en-US", {
  timeZone: PANEL_TIME_ZONE,
  ...{ year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" },
  hourCycle: "h23",
});
/** How far `time` on the panel's clock is ahead of UTC, in ms. */
function panelOffset(time: number) {
  const parts = Object.fromEntries(
    panelClock.formatToParts(time).map((p) => [p.type, Number(p.value)]),
  );
  const { year = 0, month = 1, day = 1, hour = 0, minute = 0 } = parts;
  return Date.UTC(year, month - 1, day, hour, minute) - (time - (time % 60_000));
}

/** The moment "2026-10-13:14-00" on the panel's clock names, or null when it names none. */
function panelTime(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}):(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const asUtc = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  // The offset at the moment, which a first guess finds unless the clock changed between them.
  const guess = asUtc - panelOffset(asUtc);
  return asUtc - panelOffset(guess);
}

/**
 * What a catch-up playlist answers for `minutes` from `start`, as the address writes it, of a
 * channel whose panel keeps `days` of it, recorded as `media` loops: its playlist, or 404.
 */
export function catchUpPlaylist(
  { id, days, media }: { id: string; days: number | undefined; media: Media },
  minutes: number,
  start: string,
  now = Date.now(),
): { status: 200; body: string } | { status: 404 } {
  const from = panelTime(start);
  if (!days || from === null || minutes < 1) return { status: 404 };
  if (from >= now || from < now - days * DAY_MS) return { status: 404 };
  const end = from + minutes * 60_000;
  const seconds = (Math.min(end, now) - from) / 1000;
  const uri = (n: number) => `/hls/${id}/past/${n}.ts`;
  return { status: 200, body: recordingPlaylist(media, from, seconds, uri, end <= now) };
}
