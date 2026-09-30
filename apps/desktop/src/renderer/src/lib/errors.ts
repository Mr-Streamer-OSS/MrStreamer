import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
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
    case "provider-error":
      return `The provider answered with an error (HTTP ${error.status}).`;
    case "no-subscription":
      return "No subscription is connected.";
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

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
