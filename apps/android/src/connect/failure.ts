import type { AppError } from "@mrstreamer/contracts/errors";
import { t } from "@mrstreamer/core/i18n";

/**
 * One sentence for the failures connecting and listing channels meet, in the desktop and iOS
 * apps' words, so all three say the same and share their translations. A provider's address
 * appears as its host only; no login reaches a failure.
 */
export function describeFailure(error: AppError): string {
  switch (error.kind) {
    case "incomplete-login":
    case "invalid-input":
      return error.detail;
    case "invalid-login":
      return t("The provider rejected this username or password.");
    case "account-inactive":
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
    case "needs-secret":
      return t("This subscription needs its password or link again, in Settings.");
    case "unexpected":
      return error.detail;
    default:
      return error.kind;
  }
}
