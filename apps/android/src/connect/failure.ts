import { t } from "./copy.ts";
import type { AppError } from "@mrstreamer/contracts/errors";
import { t as coreText } from "@mrstreamer/core/i18n";

/**
 * One sentence for the failures connecting and listing channels meet, in the desktop and iOS
 * apps' words, so all three say the same and share their translations; the two about the login
 * this phone keeps are Android's own. A provider's address appears as its host only; no login
 * reaches a failure.
 */
export function describeFailure(error: AppError): string {
  switch (error.kind) {
    case "incomplete-login":
    case "invalid-input":
      return error.detail;
    case "invalid-login":
      return coreText("The provider rejected this username or password.");
    case "account-inactive":
      return error.state === "expired"
        ? coreText("The provider reports this subscription as expired.")
        : error.state === "banned"
          ? coreText("The provider reports this subscription as banned.")
          : coreText("The provider reports this subscription as disabled.");
    case "unreachable":
      // The host alone: an Xtream server's path can hold a token of its own.
      return `${coreText("Can't reach {server}.", { server: URL.parse(error.server)?.host ?? "" })} ${error.detail}`;
    case "provider-error":
      return coreText("The provider answered with an error (HTTP {status}).", {
        status: String(error.status),
      });
    case "keychain-refused":
      return t("This phone would not keep the login safe. Nothing was saved.");
    case "needs-secret":
      return t("This phone no longer has its login. Add the provider again to sign in.");
    case "unexpected":
      return error.detail;
    default:
      return error.kind;
  }
}
