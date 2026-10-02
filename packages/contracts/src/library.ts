// The library model: how the app sees content, independent of the provider that supplied it.
import type { AppError } from "./errors.ts";

/**
 * A live TV channel: the provider's streams of one channel, one per quality or backup. Most have
 * one; streams join only when their names, regions, languages and categories agree (see
 * @mrstreamer/core/catalogue/variants).
 */
export interface LiveChannel {
  /**
   * Stable within one subscription: the lowest of its streams' ids. Any of its streams' ids finds
   * the channel too, so favourites and history kept by stream still do.
   */
  readonly id: string;
  /** The provider's name of its first stream: "BE | VRT 1 FHD (VLAANDEREN)". */
  readonly name: string;
  /** The name to show: "VRT 1". */
  readonly title: string;
  /** Quality and format markers every stream's name carries: "FHD" for a channel with one. */
  readonly tags: readonly string[];
  /** The provider's channel number of its first stream, if it assigns one. */
  readonly number: number | null;
  readonly logoUrl: string | null;
  /** Every category one of its streams is in. */
  readonly categoryIds: readonly string[];
  /** Its streams, in the provider's order. */
  readonly variants: readonly ChannelVariant[];
}

/** How sharp a stream's picture is, best first: 4K, Full HD, HD and SD. */
export const QUALITIES = ["uhd", "fhd", "hd", "sd"] as const;
export type Quality = (typeof QUALITIES)[number];

/** One of a channel's streams. */
export interface ChannelVariant {
  /** The provider's stream id: what plays, and what a chosen quality remembers. */
  readonly id: string;
  /** The provider's name, for search: "BE | VRT 1 HD". */
  readonly name: string;
  /** Quality and format markers from its name: "HD", "HEVC". */
  readonly tags: readonly string[];
  /** The quality its name says, or null when it says none or contradicts itself. */
  readonly quality: Quality | null;
}

export interface Category {
  readonly id: string;
  /** The provider's name: "BE | VLAANDEREN". */
  readonly name: string;
  /** The country or region it is grouped under: "Belgium". Null when it stands on its own. */
  readonly group: string | null;
  /** The name to show, within its group if it has one: "Vlaanderen". */
  readonly title: string;
  readonly channelCount: number;
}

/** When the live catalogue was last fetched, and how big it is. */
export interface CatalogueStatus {
  readonly channelCount: number;
  /** Epoch milliseconds, or null before the first successful fetch. */
  readonly fetchedAt: number | null;
  /** Why the latest refresh failed, when it did. The catalogue from `fetchedAt` stays in use. */
  readonly failure: AppError | null;
}
