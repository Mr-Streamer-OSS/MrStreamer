import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptsEvidence,
  profile,
  type Evidence,
  type Producer,
} from "../scripts/validation-evidence.ts";

const expected = { sha: "a".repeat(40), identity: "b".repeat(64) };
const producer: Producer = {
  repository: "Mr-Streamer-OSS/MrStreamer",
  event: "push",
  branch: "main",
  workflow: ".github/workflows/checks.yml",
  sha: expected.sha,
  conclusion: "success",
};
const evidence: Evidence = {
  version: 1,
  ...expected,
  profile,
  identities: { check: expected.identity, test: expected.identity, website: "" },
  results: { check: "success", test: "success", website: "skipped" },
};

test("only complete exact-source validation from a successful trusted main producer is reusable", () => {
  assert.equal(acceptsEvidence(evidence, expected, producer), true);
  for (const patch of [
    { repository: "fork/repo" },
    { event: "pull_request" },
    { branch: "feature" },
    { workflow: ".github/workflows/other.yml" },
    { sha: "c".repeat(40) },
    { conclusion: "failure" },
  ])
    assert.equal(acceptsEvidence(evidence, expected, { ...producer, ...patch }), false);
  for (const value of [
    null,
    {},
    { ...evidence, version: 2 },
    { ...evidence, identities: undefined },
    { ...evidence, identities: { ...evidence.identities, test: "different runner" } },
    { ...evidence, identities: { ...evidence.identities, check: "different runner" } },
    { ...evidence, sha: "c".repeat(40) },
    { ...evidence, identity: "c".repeat(64) },
    { ...evidence, profile: "other" },
  ])
    assert.equal(acceptsEvidence(value, expected, producer), false);
  for (const result of ["skipped", "failure"]) {
    for (const part of ["check", "test"])
      assert.equal(
        acceptsEvidence(
          { ...evidence, results: { ...evidence.results, [part]: result } },
          expected,
          producer,
        ),
        false,
      );
  }
  assert.equal(
    acceptsEvidence(
      { ...evidence, results: { ...evidence.results, website: "failure" } },
      expected,
      producer,
    ),
    false,
  );
});
