import { AppFailure, type AppError } from "../../../shared/errors.ts";

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
    case "channel-not-found":
      return "This channel is no longer in the provider's list.";
    case "invalid-input":
    case "unexpected":
      return `Something went wrong: ${error.detail}`;
  }
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
