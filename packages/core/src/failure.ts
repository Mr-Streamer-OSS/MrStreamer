// How services fail: with the error the UI explains. Adapters throw `AppFailure`, which keeps its
// error here; anything else counts as unexpected. The main process turns a `Failed` into the IPC
// result, so every service uses this one type.
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import * as Data from "effect/Data";

export class Failed extends Data.TaggedError("Failed")<{ readonly error: AppError }> {}

/** The failure for something thrown or rejected. */
export function failedWith(cause: unknown): Failed {
  if (cause instanceof AppFailure) return new Failed({ error: cause.error });
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Failed({ error: { kind: "unexpected", detail } });
}
