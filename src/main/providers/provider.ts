import type { StreamFormat } from "../../shared/playback.ts";
import type { AccountStatus } from "../../shared/subscription.ts";

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
}

/**
 * A live catalogue as the provider delivers it. Adapters report names as they are; the catalogue
 * module decides how to show them, the same way for every provider.
 */
export interface LiveCatalogue {
  readonly categories: readonly ProviderCategory[];
  readonly channels: readonly ProviderChannel[];
}

/**
 * One connected subscription. Adapters translate a provider's API into the catalogue model and
 * throw `AppFailure` with a specific error when the provider refuses or cannot be reached.
 */
export interface LiveProvider {
  authenticate(signal?: AbortSignal): Promise<AccountStatus>;
  liveCatalogue(signal?: AbortSignal): Promise<LiveCatalogue>;
  /** Upstream stream location for a channel. Contains credentials, so it stays in the main process. */
  liveStream(channelId: string): { readonly url: string; readonly format: StreamFormat };
}

/** Options every adapter shares. `fetch` is injectable so tests can run against a local server. */
export interface ProviderOptions {
  readonly userAgent: string;
  readonly fetch?: typeof fetch;
}
