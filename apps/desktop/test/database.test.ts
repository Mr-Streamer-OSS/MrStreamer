import { AppFailure } from "@mrstreamer/contracts/errors";
import { Failed } from "@mrstreamer/core/failure";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { expect, it } from "vitest";
import { attempt } from "../src/main/platform/database.ts";

it("keeps structured advice from a synthetic AppFailure thrown through attempt", () => {
  const result = Effect.runSync(
    Effect.result(
      attempt(() => {
        throw new AppFailure({ kind: "invalid-input", detail: "Choose an existing profile." });
      }),
    ),
  );

  expect(Result.isFailure(result)).toBe(true);

  if (!Result.isFailure(result)) throw new Error("Expected attempt to fail.");

  expect(result.failure.error).toStrictEqual({
    kind: "invalid-input",
    detail: "Choose an existing profile.",
  });
});

it("uses only the message of a synthetic Error as unexpected detail", () => {
  const result = Effect.runSync(
    Effect.result(
      attempt(() => {
        throw new Error("This viewing profile is being deleted.");
      }),
    ),
  );

  expect(Result.isFailure(result)).toBe(true);

  if (!Result.isFailure(result)) throw new Error("Expected attempt to fail.");

  expect(result.failure.error).toStrictEqual({
    kind: "unexpected",
    detail: "This viewing profile is being deleted.",
  });
});

it.each([
  { cause: "Read refused", detail: "Read refused" },
  { cause: 42, detail: "42" },
  { cause: null, detail: "null" },
  { cause: undefined, detail: "undefined" },
])("keeps the string fallback for synthetic primitive $cause", ({ cause, detail }) => {
  const result = Effect.runSync(
    Effect.result(
      attempt(() => {
        throw cause;
      }),
    ),
  );

  expect(Result.isFailure(result)).toBe(true);

  if (!Result.isFailure(result)) throw new Error("Expected attempt to fail.");

  expect(result.failure.error).toStrictEqual({ kind: "unexpected", detail });
});

it("preserves the identity and advice of a synthetic Failed", () => {
  const failure = new Failed({
    error: { kind: "invalid-input", detail: "Unknown viewing profile." },
  });

  const result = Effect.runSync(
    Effect.result(
      attempt(() => {
        throw failure;
      }),
    ),
  );

  expect(Result.isFailure(result)).toBe(true);

  if (!Result.isFailure(result)) throw new Error("Expected attempt to fail.");

  expect(result.failure).toBe(failure);
  expect(result.failure.error).toBe(failure.error);
  expect(result.failure.error).toStrictEqual({
    kind: "invalid-input",
    detail: "Unknown viewing profile.",
  });
});
