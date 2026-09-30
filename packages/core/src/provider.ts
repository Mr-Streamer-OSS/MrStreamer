import type { StreamFormat } from "@mrstreamer/contracts/playback";
import type { AccountStatus } from "@mrstreamer/contracts/subscription";

/** A category as the provider lists it. */
export interface ProviderCategory {
  readonly id: string;
  /** Exactly as the provider wrote it: "BE | VLAANDEREN". */
  readonly name: string;
}

/** A channel as the provider lists it, with the provider's loose fields made consistent. */
export interface ProviderChannel {
  readonly id: string;
  /** Exactly as the provider wrote it: "BE | VRT 1 FHD (VLAANDEREN)". */
  readonly name: string;
  readonly number: number | null;
  readonly logoUrl: string | null;
  readonly categoryIds: readonly string[];
  /** The channel's id in the provider's programme guide, when it has one. */
  readonly guideId: string | null;
}

/**
 * A live catalogue as the provider delivers it. Adapters report names as they are; the catalogue
 * module decides how to show them, the same way for every provider.
 */
export interface LiveCatalogue {
  readonly categories: readonly ProviderCategory[];
  readonly channels: readonly ProviderChannel[];
}

/** A movie or a series as the provider lists it. */
export interface ProviderTitle {
  readonly id: string;
  /** Exactly as the provider wrote it: "Blow 2001 (NL)". */
  readonly name: string;
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
  /** Out of 10. */
  readonly rating: number | null;
  /** Movies: when added. Series: when last changed. Epoch milliseconds. */
  readonly addedAt: number | null;
  /** "2026-08-20", for the year when the name has none. */
  readonly releaseDate: string | null;
  readonly categoryIds: readonly string[];
  readonly adult: boolean;
  /** The file type movies stream as: "mkv", "mp4". Null for series, whose episodes have their own. */
  readonly container: string | null;
}

/** Movies and series as the provider delivers them, each with its own categories. */
export interface OnDemandCatalogue {
  readonly movieCategories: readonly ProviderCategory[];
  readonly movies: readonly ProviderTitle[];
  readonly seriesCategories: readonly ProviderCategory[];
  readonly series: readonly ProviderTitle[];
}

/** What the provider knows about one movie or series beyond its list entry. */
export interface ProviderDetails {
  readonly originalName: string | null;
  readonly plot: string | null;
  readonly genres: readonly string[];
  readonly cast: readonly string[];
  readonly directors: readonly string[];
  readonly releaseDate: string | null;
  /** Seconds: the movie, or a usual episode. */
  readonly duration: number | null;
  readonly posterUrl: string | null;
  readonly backdropUrl: string | null;
  /** Series only, in any order; empty for movies. */
  readonly seasons: readonly {
    readonly number: number;
    readonly name: string | null;
    readonly posterUrl: string | null;
  }[];
  /** Series only, in any order; empty for movies. */
  readonly episodes: readonly ProviderEpisode[];
  /** Movies only: the file type, when the details name it. */
  readonly container: string | null;
}

export interface ProviderEpisode {
  readonly id: string;
  readonly season: number;
  readonly number: number;
  /** Exactly as the provider wrote it: "Race Across the World (NL) - S02E03 - Tbilisi". */
  readonly name: string;
  readonly plot: string | null;
  readonly duration: number | null;
  readonly stillUrl: string | null;
  readonly airDate: string | null;
  readonly container: string;
}

/**
 * One connected subscription. Adapters translate a provider's API into the catalogue model and
 * throw `AppFailure` with a specific error when the provider refuses or cannot be reached.
 */
export interface Provider {
  authenticate(signal?: AbortSignal): Promise<AccountStatus>;
  liveCatalogue(signal?: AbortSignal): Promise<LiveCatalogue>;
  /** Upstream stream location for a channel. Contains credentials, so it stays in the main process. */
  liveStream(channelId: string): { readonly url: string; readonly format: StreamFormat };
  /** The provider's programme guide, an XMLTV document, as it downloads. */
  liveGuide(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  onDemandCatalogue(signal?: AbortSignal): Promise<OnDemandCatalogue>;
  movieDetails(id: string, signal?: AbortSignal): Promise<ProviderDetails>;
  seriesDetails(id: string, signal?: AbortSignal): Promise<ProviderDetails>;
  /**
   * Upstream file location of a movie or an episode, with its file type. Contains credentials, so
   * it stays in the main process.
   */
  titleFile(kind: "movie" | "episode", id: string, container: string): string;
}

/** Options every adapter shares. `fetch` is injectable so tests can run against a local server. */
export interface ProviderOptions {
  readonly userAgent: string;
  readonly fetch?: typeof fetch;
}
