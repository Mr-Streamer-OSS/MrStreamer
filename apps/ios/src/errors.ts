import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import { formatDate, t } from "@mrstreamer/core/i18n";

/** The typed error behind a failed call, or an `unexpected` error for anything else. */
export function appError(cause: unknown): AppError {
  if (cause instanceof AppFailure) return cause.error;
  return { kind: "unexpected", detail: cause instanceof Error ? cause.message : String(cause) };
}

/**
 * One sentence for the errors the iOS app meets so far, in the desktop app's words (its
 * renderer's lib/errors.ts), so both say the same and share their translations.
 */
export function describeError(error: AppError): string {
  switch (error.kind) {
    case "incomplete-login":
    case "invalid-input":
      return error.detail;
    case "invalid-login":
      return t("The provider rejected this username or password.");
    case "account-inactive":
      if (error.state === "expired" && error.expiresAt) {
        return t("This subscription expired on {date}.", {
          date: formatDate(Date.parse(error.expiresAt), "date"),
        });
      }
      return error.state === "expired"
        ? t("The provider reports this subscription as expired.")
        : error.state === "banned"
          ? t("The provider reports this subscription as banned.")
          : t("The provider reports this subscription as disabled.");
    case "unreachable":
      return `${t("Can't reach {server}.", { server: error.server.replace(/^https?:\/\//, "") })} ${error.detail}`;
    case "provider-error":
      return t("The provider answered with an error (HTTP {status}).", {
        status: String(error.status),
      });
    case "keychain-refused":
      return t("Your system's keychain would not store your password.");
    case "channel-not-found":
      return t("This channel is no longer in the provider's list.");
    default:
      return error.kind === "unexpected" ? error.detail : error.kind;
  }
}
