import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { withoutAddresses } from "@mrstreamer/core/provider";
import { t as failure } from "./i18n/failures.ts";

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
    case "catch-up":
      return error.reason === "none"
        ? t("This channel has no catch-up.")
        : t("Catch-up on this channel goes back {count} days.", { count: error.days });
    case "title-not-found":
      return t("The provider no longer lists this title.");
    case "no-subscription":
      return t("No subscription is connected.");
    case "needs-secret":
      return t("This subscription needs its password or link again, in Settings.");
    case "stream":
      return describeStreamFailure(error.failure);
    default:
      return error.kind === "unexpected" ? error.detail : error.kind;
  }
}

/** Why a stream or a provider file didn't come, in the desktop's words. */
function describeStreamFailure(failure: StreamFailure): string {
  switch (failure.kind) {
    case "refused":
      return t("The provider refused this title. Another device may be using your connection.");
    case "unavailable":
      return t("The provider has no file for this title right now.");
    case "provider-error":
      return t("The provider answered with an error (HTTP {status}).", {
        status: String(failure.status),
      });
    case "network":
      return `${t("The connection to the provider failed.")} ${failure.detail}`;
    case "unsupported":
      return `${t("Mr. Streamer can't play this file.")} ${failure.detail}`;
  }
}

/** The desktop's reading of a provider's HTTP status for a stream or a file. */
export function statusFailure(status: number): StreamFailure {
  if ([401, 403, 429, 458, 509].includes(status)) return { kind: "refused", status };
  if (status === 404 || status === 410) return { kind: "unavailable", status };
  return { kind: "provider-error", status };
}

/** A failure as a screen puts it: what happened, then what to do about it. */
export interface Failure {
  readonly headline: string;
  readonly advice: string | null;
}

/** "tv.example.net" from "http://tv.example.net:8080/": how the screens name a provider. */
export function hostOf(server: string): string {
  return (
    URL.parse(server)?.hostname ||
    URL.parse(`http://${server}`)?.hostname ||
    server.replace(/^https?:\/\//, "").replace(/[:/?#].*$/, "")
  );
}

/**
 * A provider failure in two short sentences, for Connect and the screens that load from the
 * provider, in the interface language with the provider's host as it is. Status codes and the
 * system's own words stay out; `describeError` keeps them.
 */
export function failureOf(error: AppError, server: string): Failure {
  const host = hostOf(error.kind === "unreachable" ? error.server : server);
  switch (error.kind) {
    case "unreachable":
      return {
        headline: failure("Couldn't reach {host}", { host }),
        advice: failure("Check the address and that your iPhone is online."),
      };
    case "invalid-login":
      return {
        headline: failure("{host} didn't accept this login", { host }),
        advice: failure("Check the username and password from your provider."),
      };
    case "account-inactive":
      if (error.state === "expired") {
        return {
          headline: error.expiresAt
            ? failure("This subscription expired on {date}", {
                date: formatDate(Date.parse(error.expiresAt), "date"),
              })
            : failure("This subscription has expired"),
          advice: failure("Renew it with {host}, then try again.", { host }),
        };
      }
      return {
        headline:
          error.state === "banned"
            ? failure("{host} reports this subscription as banned", { host })
            : failure("{host} reports this subscription as disabled", { host }),
        advice: failure("Ask {host} about it, then try again.", { host }),
      };
    case "provider-error":
      return {
        headline: failure("{host} isn't answering", { host }),
        advice: failure("This usually passes. Try again in a minute."),
      };
    case "needs-secret":
      return {
        headline: failure("Enter the password for {host} again", { host }),
        advice: failure("Your iPhone no longer gives it back. Enter it in Settings."),
      };
    case "keychain-refused":
      return {
        headline: failure("Your iPhone wouldn't save the password"),
        advice: failure("Try again. If it keeps failing, restart the iPhone."),
      };
    default:
      return { headline: describeError(error), advice: null };
  }
}

/**
 * `text` as the viewer may see it, for messages the native player writes: every address cut to
 * its origin (core's rule for provider messages), and the raw, URI and form spellings of each
 * login part removed. Uncertain query values are removed only as whole names, as core's `whole`
 * reads them, so an ordinary word containing a short setting still reads whole.
 */
export function withoutLogin(
  text: string,
  login: readonly string[],
  uncertain: readonly string[] = [],
): string {
  const spellings = (parts: readonly string[]) =>
    parts
      .filter((part) => part !== "")
      .flatMap((part) => [
        part,
        encodeURIComponent(part),
        new URLSearchParams({ part }).toString().slice("part=".length),
      ])
      // The longest first, so a part inside a longer spelling doesn't leave the rest behind.
      .toSorted((a, b) => b.length - a.length)
      .map((spelling) => spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const known = spellings(login);
  const shown =
    known.length === 0
      ? withoutAddresses(text)
      : withoutAddresses(text).replace(new RegExp(known.join("|"), "gi"), "…");
  const words = spellings(uncertain);
  if (words.length === 0) return shown;
  const name = /[\p{L}\p{N}\-._~]/u;
  // Lookahead visits overlapping occurrences, including after a rejected boundary.
  return words.reduce((text, word) => {
    let result = "";
    let through = 0;
    for (const match of text.matchAll(new RegExp(`(?=(${word}))`, "gi"))) {
      const part = match[1];
      const at = match.index;
      if (!part || name.test(text[at - 1] ?? "") || name.test(text[at + part.length] ?? ""))
        continue;
      if (at >= through) result += text.slice(through, at) + "…";
      through = Math.max(through, at + part.length);
    }
    return result + text.slice(through);
  }, shown);
}
