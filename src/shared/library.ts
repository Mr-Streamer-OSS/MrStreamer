// The library model: how the app sees content, independent of the provider that supplied it.

/** A live TV channel. */
export interface LiveChannel {
  /** Stable within one subscription. */
  readonly id: string;
  /** The provider's name, for search: "BE | VRT 1 FHD (VLAANDEREN)". */
  readonly name: string;
  /** The name to show: "VRT 1". */
  readonly title: string;
  /** Quality and format markers from the name: "FHD". */
  readonly tags: readonly string[];
  /** The provider's channel number, if it assigns one. */
  readonly number: number | null;
  readonly logoUrl: string | null;
  readonly categoryIds: readonly string[];
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
}
