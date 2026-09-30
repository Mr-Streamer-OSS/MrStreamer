import type { Programme } from "../../../shared/guide.ts";
import type { Category, LiveChannel } from "../../../shared/library.ts";
import type { StreamInfo } from "../player/engine.ts";

/** "818 · Vlaanderen": the channel number and its first category. */
export function channelLine(
  channel: LiveChannel,
  categories: ReadonlyMap<string, Category>,
): string {
  const category = channel.categoryIds.map((id) => categories.get(id)).find(Boolean);
  return [channel.number, category?.title].filter((part) => part != null).join(" · ");
}

/** The first category's name, for a channel without a programme to show. */
export function categoryOf(
  channel: LiveChannel,
  categories: ReadonlyMap<string, Category>,
): string {
  return channel.categoryIds.map((id) => categories.get(id)?.title).find(Boolean) ?? "";
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
