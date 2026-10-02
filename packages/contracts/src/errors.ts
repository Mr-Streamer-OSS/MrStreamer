// Failures the UI knows how to explain. Every IPC call resolves to a value or one of these.
import type { StreamFailure } from "./playback.ts";

export type AppError =
  /** The login form is missing something, or the server address is not a URL. */
  | { readonly kind: "incomplete-login"; readonly detail: string }
  /** The provider rejected the username or password. */
  | { readonly kind: "invalid-login" }
  /** The login is valid but the account cannot stream. */
  | {
      readonly kind: "account-inactive";
      readonly state: "expired" | "banned" | "disabled";
      readonly expiresAt: string | null;
    }
  /** DNS failure, refused connection, timeout, or a server that is not an Xtream API. */
  | { readonly kind: "unreachable"; readonly server: string; readonly detail: string }
  /**
   * An address typed without http:// or https:// didn't work over https, `server`, so connecting
   * stopped before the login went out unencrypted. The UI asks before trying it with http://.
   */
  | { readonly kind: "unencrypted-only"; readonly server: string }
  /** The provider answered with an HTTP status the app does not expect. */
  | { readonly kind: "provider-error"; readonly status: number }
  | { readonly kind: "no-subscription" }
  /** The system keychain would not store the password, or no longer gives it back. */
  | { readonly kind: "keychain-refused" }
  | { readonly kind: "channel-not-found"; readonly channelId: string }
  /** A movie, series or episode the provider no longer lists. */
  | { readonly kind: "title-not-found"; readonly titleId: string }
  /** A movie or episode couldn't be opened: the provider refused its file, or it can't play. */
  | { readonly kind: "stream"; readonly failure: StreamFailure }
  /**
   * The provider sent no channels, or far fewer than before; or no movies or no series, where it
   * had some. Not twice in a row: the second time counts. The previous list stays.
   */
  | {
      readonly kind: "incomplete-catalogue";
      readonly received: number;
      readonly previous: number;
      /** Which list, when it isn't the channels. */
      readonly list?: "movies" | "series";
    }
  /** An IPC call carried input that failed validation. Indicates a UI bug. */
  | { readonly kind: "invalid-input"; readonly detail: string }
  | { readonly kind: "unexpected"; readonly detail: string };

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppError };

/** Thrown inside the main process to fail an IPC call with a specific AppError. */
export class AppFailure extends Error {
  readonly error: AppError;

  constructor(error: AppError) {
    super(error.kind);
    this.name = "AppFailure";
    this.error = error;
  }
}
