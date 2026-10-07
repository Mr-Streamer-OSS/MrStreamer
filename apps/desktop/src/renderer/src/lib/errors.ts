import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { GuideFailure } from "@mrstreamer/contracts/guide";
import type { OutputFailure } from "@mrstreamer/contracts/output";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import { GUIDE_LIMITS } from "@mrstreamer/core/guide/limits";
import { isMac } from "../app/platform.ts";

/** The typed error behind a failed call, or an `unexpected` error for anything else. */
export function appError(cause: unknown): AppError {
  if (cause instanceof AppFailure) return cause.error;
  return { kind: "unexpected", detail: cause instanceof Error ? cause.message : String(cause) };
}

/** One sentence the UI can show for an error. */
export function describeError(error: AppError): string {
  switch (error.kind) {
    case "incomplete-login":
      return error.detail;
    case "invalid-login":
      return "The provider rejected this username or password.";
    case "account-inactive":
      return error.state === "expired" && error.expiresAt
        ? `This subscription expired on ${formatDate(error.expiresAt)}.`
        : `The provider reports this subscription as ${error.state}.`;
    case "unreachable":
      return `Can't reach ${error.server.replace(/^https?:\/\//, "")}. ${error.detail}`;
    case "unencrypted-only":
      return `${URL.parse(error.server)?.hostname ?? error.server} has no encrypted connection.`;
    case "provider-error":
      return `The provider answered with an error (HTTP ${error.status}).`;
    case "no-subscription":
      return "No subscription is connected.";
    case "needs-secret":
      return "This subscription needs its password or link again, in Settings.";
    case "keychain-refused":
      return isMac
        ? 'The macOS Keychain would not store your password. Open Keychain Access, delete "Mr. Streamer Safe Storage", then quit and reopen Mr. Streamer.'
        : "Your system's keychain would not store your password.";
    case "channel-not-found":
      return "This channel is no longer in the provider's list.";
    case "title-not-found":
      return "The provider no longer lists this title.";
    case "stream":
      return describeStreamFailure(error.failure);
    case "output":
      return describeOutputFailure(error.failure);
    case "guide":
      return describeGuideFailure(error.failure);
    case "favourites-changed":
      return "Your favourites changed.";
    case "mark-changed":
      return "This can no longer be undone.";
    case "incomplete-catalogue":
      if (error.list) return `The provider sent no ${error.list}, so the previous list stays.`;
      return error.received === 0
        ? "The provider sent an empty channel list, so the previous list stays."
        : `The provider sent ${error.received.toLocaleString()} of ${error.previous.toLocaleString()} channels, so the previous list stays.`;
    case "invalid-input":
    case "unexpected":
      return `Something went wrong: ${error.detail}`;
  }
}

/** Why a movie or episode didn't open. */
function describeStreamFailure(failure: StreamFailure): string {
  switch (failure.kind) {
    case "refused":
      return "The provider refused this title. Another device may be using your connection.";
    case "unavailable":
      return "The provider has no file for this title right now.";
    case "provider-error":
      return `The provider answered with an error (HTTP ${failure.status}).`;
    case "network":
      return `The connection to the provider failed. ${failure.detail}`;
    case "unsupported":
      return `Mr. Streamer can't play this file. ${failure.detail}`;
  }
}

/** Why a receiver on the network doesn't play. */
function describeOutputFailure(failure: OutputFailure): string {
  switch (failure.kind) {
    case "unreachable":
      return "The receiver didn't answer.";
    case "not-fetched":
      return "The receiver couldn't reach this computer. Check that your firewall allows Mr. Streamer on private networks.";
    case "media":
      return `The receiver couldn't play this. ${failure.detail}`;
    case "no-network":
      return "This computer isn't on a local network.";
    case "unavailable":
      return `Mr. Streamer can't reach receivers right now. ${failure.detail}`;
    case "stream":
      return describeStreamFailure(failure.failure);
  }
}

/** Why a guide can't be used, or why a change to one didn't happen. */
function describeGuideFailure(failure: GuideFailure): string {
  switch (failure.kind) {
    case "address":
      return "Enter the address of an XMLTV guide.";
    case "locked":
      return "This guide needs its address again.";
    case "redirect":
      return failure.reason === "unencrypted"
        ? "The address redirected to an unencrypted one, so Mr. Streamer stopped."
        : "The address redirected too many times.";
    case "not-xmltv":
      return "The address answered, but not with an XMLTV guide.";
    case "incomplete":
      return "The guide stopped before its end, or is damaged.";
    case "empty":
      return "The guide lists no programmes.";
    case "ended":
      return "Every programme in this guide has ended.";
    case "too-large":
      return `This guide is larger than Mr. Streamer reads: ${tooLarge(failure.limit)}.`;
    case "changed":
      return "The guide changed meanwhile, so nothing was changed.";
    case "cancelled":
      return "Stopped.";
  }
}

/** Which of the limits a guide is read under it is past, in the limit's own measure. */
function tooLarge(limit: Extract<GuideFailure, { kind: "too-large" }>["limit"]): string {
  const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString()} MB`;
  switch (limit) {
    case "bytes":
      return `over ${megabytes(GUIDE_LIMITS.bytes)} unpacked`;
    case "element":
      return `one of its entries is over ${megabytes(GUIDE_LIMITS.elementBytes)}`;
    case "channels":
      return `over ${GUIDE_LIMITS.channels.toLocaleString()} channels`;
    case "programmes":
      return `over ${GUIDE_LIMITS.programmes.toLocaleString()} programmes still to come`;
  }
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
