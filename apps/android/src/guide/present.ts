import type { Programme } from "@mrstreamer/contracts/guide";
import { formatDate, t as sharedT } from "@mrstreamer/core/i18n";
import { localDay } from "./days.ts";
import { GUIDE_LIMIT, MAPPING_MAX, type GuideLink, type GuideRefusal } from "./guide-sources.ts";
import type { Day } from "./guide.ts";
import type { GuideChannel } from "./part.ts";
import { t } from "./strings.ts";

// What the guide screens write, apart from React: day headings, programme times, the add form's
// refusals and Map channels' rows. Words follow the interface language; guide, channel and
// provider names and guide ids stay as they are.

/** What a guide's row, sheet and dialog call it: its name, else its link's host. */
export const labelOf = (link: Pick<GuideLink, "name" | "origin">) =>
  link.name ?? URL.parse(link.origin)?.host ?? link.origin;

/** A day's heading over a Schedule: Today, Tomorrow, else its short date, as "Thu 5 Nov". */
export function dayLabel(day: Day, now: number): string {
  if (day.from === localDay(now).from) return t("Today");

  if (day.from === localDay(now, 1).from) return t("Tomorrow");

  return formatDate(day.from, "weekdayDay");
}

/** "14:00–15:00" in the interface language's time of day. */
export const programmeRange = ({ start, stop }: Pick<Programme, "start" | "stop">) =>
  `${formatDate(start, "time")}–${formatDate(stop, "time")}`;

/** How far an ongoing programme is, 0 to 1, or null when it isn't on at `now`. */
export const progressOf = ({ start, stop }: Pick<Programme, "start" | "stop">, now: number) =>
  start <= now && stop > now ? (now - start) / (stop - start) : null;

/** What is left of a programme on at `now`, "28 min left", or null when it isn't on. */
export function timeLeft(programme: Pick<Programme, "start" | "stop">, now: number) {
  if (progressOf(programme, now) === null) return null;
  const minutes = Math.ceil((programme.stop - now) / 60_000);
  const hours = Math.floor(minutes / 60);

  if (hours === 0) return sharedT("{minutes} min left", { minutes });

  return minutes % 60 === 0
    ? sharedT("{hours} h left", { hours })
    : sharedT("{hours} h {minutes} min left", { hours, minutes: minutes % 60 });
}

/** Why an add, a new link or a mapping wasn't taken. */
export function refusalText(refusal: GuideRefusal): string {
  switch (refusal) {
    case "address":
      return t("That isn't a web link");
    case "duplicate":
      return t("That guide is added already");
    case "name":
      return t("A name can't be a link");
    case "limit":
      return t("{count} guides is the most this phone reads", { count: GUIDE_LIMIT });
    case "long":
      return t("A guide id is at most {count} bytes", { count: MAPPING_MAX });
    case "saving":
      return t("Couldn't save. Nothing changed.");
  }
}

/** A channel Map channels lists: one a catalogue lists, or a mapped one no longer listed. */
export interface Mappable {
  /** `Channel.key`, which its mapping is saved by. */
  readonly key: string;
  readonly sourceId: string;
  readonly channelId: string;
  readonly title: string;
  /** Its category, or for one no longer listed its provider and so; null while unknown. */
  readonly line: string | null;
  readonly listed: boolean;
  readonly mapped: string | null;
}

/** What Map channels reads: the guide's channels, mappings and the providers' own words. */
export interface MapInput {
  /** Each subscription's channels whose catalogue the guide has read (`guide.channels()`). */
  readonly channels: ReadonlyMap<string, readonly GuideChannel[]>;
  readonly mappings: ReadonlyMap<string, string>;
  /** A provider's name by subscription id. */
  readonly providers: ReadonlyMap<string, string>;
  /** A channel's category by its key, as the catalogue lists it. */
  readonly categories: ReadonlyMap<string, string | null>;
}

const split = (key: string) => {
  const at = key.indexOf(":");

  return { sourceId: key.slice(0, at), channelId: key.slice(at + 1) };
};

/** How Map channels names channel `key`, from its catalogue once read. */
export function describe(key: string, input: Omit<MapInput, "mappings">): Omit<Mappable, "mapped"> {
  const { sourceId, channelId } = split(key);
  const read = input.channels.get(sourceId);
  const listed = read?.find((channel) => channel.key === key);

  if (listed)
    return {
      key,
      sourceId,
      channelId,
      title: listed.title,
      line: input.categories.get(key) ?? null,
      listed: true,
    };

  return {
    key,
    sourceId,
    channelId,
    title: t("Channel {id}", { id: channelId }),
    // Until its catalogue is read, nothing says it isn't listed.
    line: read
      ? [input.providers.get(sourceId), t("No longer listed")].filter(Boolean).join(" · ")
      : null,
    listed: false,
  };
}

/**
 * Map channels' sections: every mapped channel first, those no longer listed too, then every other
 * channel listed, each whose name or mapped id holds `query`. Empty sections are left out.
 */
export function mapSections(input: MapInput, query: string) {
  const words = query.trim().toLocaleLowerCase();

  const found = ({ title, mapped }: Mappable) =>
    !words ||
    title.toLocaleLowerCase().includes(words) ||
    !!mapped?.toLocaleLowerCase().includes(words);

  const mapped = [...input.mappings].flatMap(([key, id]) => {
    const row = { ...describe(key, input), mapped: id };

    return found(row) ? [row] : [];
  });

  const others = [...input.channels.values()].flat().flatMap((channel) => {
    if (input.mappings.has(channel.key)) return [];
    const row = { ...describe(channel.key, input), mapped: null };

    return found(row) ? [row] : [];
  });

  return [
    { title: t("Mapped"), data: mapped },
    { title: sharedT("Channels"), data: others },
  ].filter((section) => section.data.length > 0);
}

/** A channel row's tile: its name's first letters, "EM" for Estuary Max. */
export const initials = (title: string) =>
  title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]?.toLocaleUpperCase() ?? "")
    .join("");
