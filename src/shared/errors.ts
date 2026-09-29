// Failures the UI knows how to explain. Every IPC call resolves to a value or one of these.

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
  /** The provider answered with an HTTP status the app does not expect. */
  | { readonly kind: "provider-error"; readonly status: number }
  | { readonly kind: "no-subscription" }
  /** The system keychain would not store the password, or no longer gives it back. */
  | { readonly kind: "keychain-refused" }
  | { readonly kind: "channel-not-found"; readonly channelId: string }
  /**
   * The provider sent no channels, or far fewer than before and not twice in a row. The previous
   * channel list stays.
   */
  | { readonly kind: "incomplete-catalogue"; readonly received: number; readonly previous: number }
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
