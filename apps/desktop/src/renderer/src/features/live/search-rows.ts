import type { ListingMatch } from "@mrstreamer/contracts/guide";
import { QUALITIES, type LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import type { LiveSearchGroup } from "@mrstreamer/core/catalogue/search";
import { shortQuality } from "../../lib/quality.ts";

/** Quality labels of real streams, including a copy that has only one stream. */
export function searchQualities(copies: readonly LiveChannel[]): string {
  const labelled = new Map(
    copies.flatMap((copy) =>
      copy.variants.map((variant) => [variant.quality, shortQuality(variant)] as const),
    ),
  );
  return QUALITIES.flatMap((quality) => labelled.get(quality) ?? []).join(" · ");
}

export interface SearchChannelRow {
  readonly key: string;
  readonly group: LiveSearchGroup;
  readonly copy: boolean;
  /** A matching guide's actual owner for display; Automatic playback is chosen separately. */
  readonly channel: LiveChannel;
}

/** A collapsed group contains every copy; an expanded copy represents only its own channel. */
export function rowPlays(
  channel: LiveChannel,
  row: SearchChannelRow | undefined,
  playingKey: string | null,
): boolean {
  const copies = row && !row.copy ? row.group.copies : [channel];
  return copies.some((copy) => ownedKey(copy) === playingKey);
}

/** Expand canonical copies without changing the collapsed result or stream counts. */
export function searchChannelRows(
  groups: readonly LiveSearchGroup[],
  expanded: ReadonlySet<string>,
  matches: Readonly<Record<string, ListingMatch>> = {},
): readonly SearchChannelRow[] {
  return groups.flatMap((group) => {
    const channel = group.copies.find((copy) => matches[ownedKey(copy)]) ?? group.copies[0]!;
    return [
      { key: group.key, group, copy: false, channel },
      ...(expanded.has(group.key) && group.copies.length > 1
        ? group.copies.map((channel) => ({
            key: `${group.key}/copy/${ownedKey(channel)}`,
            group,
            copy: true,
            channel,
          }))
        : []),
    ];
  });
}
