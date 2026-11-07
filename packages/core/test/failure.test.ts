import { AppFailure } from "@mrstreamer/contracts/errors";
import { expect, it } from "vitest";
import { Failed, failedWith } from "../src/failure.ts";

it("preserves structured advice when converting an existing failure", () => {
  const failure = new Failed({
    error: { kind: "incomplete-catalogue", received: 12, previous: 200, list: "movies" },
  });

  expect(failedWith(failure).error).toStrictEqual({
    kind: "incomplete-catalogue",
    received: 12,
    previous: 200,
    list: "movies",
  });
});

it("keeps AppFailure advice when converting a thrown application error", () => {
  const failure = new AppFailure({
    kind: "account-inactive",
    state: "expired",
    expiresAt: "2026-11-01",
  });

  expect(failedWith(failure).error).toStrictEqual({
    kind: "account-inactive",
    state: "expired",
    expiresAt: "2026-11-01",
  });
});

it("uses an ordinary Error's message as unexpected failure detail", () => {
  expect(failedWith(new Error("Connection timed out")).error).toStrictEqual({
    kind: "unexpected",
    detail: "Connection timed out",
  });
});

it.each([
  { cause: "Request refused", detail: "Request refused" },
  { cause: 42, detail: "42" },
  { cause: null, detail: "null" },
  { cause: undefined, detail: "undefined" },
])("uses the string form of thrown $cause as unexpected failure detail", ({ cause, detail }) => {
  expect(failedWith(cause).error).toStrictEqual({ kind: "unexpected", detail });
});
