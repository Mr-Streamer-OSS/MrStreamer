import type { Programme } from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import type { StreamInfo } from "../player/engine.ts";

/**
 * A channel's first category that `categories` has, which hold them by `ownedKey`: a channel's
 * categories are its own subscription's.
 */
function firstCategory(
  channel: LiveChannel,
  categories: ReadonlyMap<string, Category>,
): Category | undefined {
  const { subscriptionId } = channel;
  return channel.categoryIds
    .map((id) => categories.get(ownedKey({ subscriptionId, id })))
    .find(Boolean);
}

/** "818 · Vlaanderen": the channel number and its first category. */
export function channelLine(
  channel: LiveChannel,
  categories: ReadonlyMap<string, Category>,
): string {
  const category = firstCategory(channel, categories);
  return [channel.number, category?.title].filter((part) => part != null).join(" · ");
}

/** The first category's name, for a channel without a programme to show. */
export function categoryOf(
  channel: LiveChannel,
  categories: ReadonlyMap<string, Category>,
): string {
  return firstCategory(channel, categories)?.title ?? "";
}

/** "Holiday house and Openlist playlist", "A, B and C". */
export function namesList(names: readonly string[]): string {
  const last = names.at(-1) ?? "";
  return names.length < 2 ? last : `${names.slice(0, -1).join(", ")} and ${last}`;
}

/** A server's host, without its scheme: "tv.example.net:8080". */
export function hostOf(server: string): string {
  return URL.parse(server)?.host || server;
}

/** "1080p · 50 fps · Stereo" from whatever the engine knows. */
export function techLine(info: StreamInfo | null): string {
  if (!info) return "";
  const parts: string[] = [];
  if (info.height) parts.push(`${info.height}p`);
  if (info.fps) parts.push(`${Math.round(info.fps)} fps`);
  if (info.audioChannels) {
    parts.push(
      info.audioChannels === 1
        ? "Mono"
        : info.audioChannels === 2
          ? "Stereo"
          : `${info.audioChannels} ch`,
    );
  }
  return parts.join(" · ");
}

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** "21:00", or "Tomorrow 06:00" when it's after today. */
export function clockTime(at: number, now: number): string {
  const dayOf = (moment: number) => new Date(moment).setHours(0, 0, 0, 0);
  return `${dayOf(at) > dayOf(now) ? "Tomorrow " : ""}${time.format(at)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayOfMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** How many days `at` is after today, by the calendar: -1 for any time yesterday. */
function daysFrom(now: number, at: number): number {
  const dayOf = (moment: number) => new Date(moment).setHours(0, 0, 0, 0);
  return Math.round((dayOf(at) - dayOf(now)) / DAY_MS);
}

/** "2 Oct" */
export function shortDay(at: number): string {
  return dayOfMonth.format(at);
}

/** A time that has been: "14:02" earlier today, "yesterday 14:02", "2 Oct 14:02" before. */
export function pastTime(at: number, now: number): string {
  const days = daysFrom(now, at);
  if (days >= 0) return time.format(at);
  return `${days === -1 ? "yesterday" : shortDay(at)} ${time.format(at)}`;
}

/** A time still to come: "today 23:00", "tomorrow 06:00", "Fri 23:00" this week, "12 Oct 23:00". */
export function comingTime(at: number, now: number): string {
  const days = daysFrom(now, at);
  const day =
    days <= 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? weekday.format(at) : shortDay(at);
  return `${day} ${time.format(at)}`;
}

/** The midnight that ends the day of `at`. */
export function endOfDay(at: number): number {
  return new Date(at).setHours(24, 0, 0, 0);
}

/** "34 min left", "1 h 20 min left". */
export function timeLeft(programme: Programme, now: number): string {
  const minutes = Math.max(1, Math.ceil((programme.stop - now) / 60_000));
  if (minutes < 60) return `${minutes} min left`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""} left`;
}

/** How far a programme has run, from 0 to 1. */
export function progressOf(programme: Programme, now: number): number {
  const length = programme.stop - programme.start;
  return length > 0 ? Math.min(1, Math.max(0, (now - programme.start) / length)) : 0;
}
