import type { Json, JsonObject } from "../../packages/contracts/src/json.ts";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { realpathSync, readFileSync, writeFileSync } from "node:fs";

export const profile = "desktop-v1";

/** Effective validation code/config and toolchain. Source SHA is checked separately. */
export function validationIdentity() {
  const sourceRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();

  const inputs = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "HEAD",
      "--",
      ".github",
      "scripts",
      "test",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "vitest.config.ts",
      "tsconfig.json",
      "tsconfig.base.json",
    ],
    { cwd: sourceRoot, encoding: "utf8" },
  );

  const tools = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "HEAD",
      "--",
      ".github/actions/validation",
      ".github/scripts/ci-inputs.ts",
      ".github/scripts/test-shards.ts",
      ".github/scripts/validation-evidence.ts",
      ".github/tests/ci-inputs.test.ts",
      ".github/tests/test-shards.test.ts",
      ".github/tests/validation-evidence.test.ts",
      ".github/workflows/checks.yml",
      // The merge's reporter runs from these tools, whatever the candidate has.
      "scripts/test-durations.ts",
    ],
    {
      cwd: resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../.."),
      encoding: "utf8",
    },
  );

  return createHash("sha256")
    .update(
      JSON.stringify({
        inputs,
        tools,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        imageOS: process.env["ImageOS"],
        imageVersion: process.env["ImageVersion"],
      }),
    )
    .digest("hex");
}

/** Metadata must come from the Actions API, not from an artifact's own trust claims. */
export interface Producer {
  repository: string;
  event: string;
  branch: string;
  workflow: string;
  sha: string;
  conclusion: string;
}

export type Evidence = {
  version: 1;
  sha: string;
  identity: string;
  profile: typeof profile;
  identities: { check: string; test: string; website: string };
  results: { check: string; test: string; website: string };
};

/** Release consumers must authenticate the producer before passing its downloaded artifact here. */
export function acceptsEvidence(
  value: Json | undefined,
  expected: { sha: string; identity: string },
  producer: Producer,
): boolean {
  const object = (value: Json | undefined): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  if (!object(value) || !object(value["identities"]) || !object(value["results"])) return false;
  const evidence = value;
  const identities = value["identities"];
  const results = value["results"];

  return (
    producer.repository === "Mr-Streamer-OSS/MrStreamer" &&
    producer.event === "push" &&
    producer.branch === "main" &&
    producer.workflow === ".github/workflows/checks.yml" &&
    producer.conclusion === "success" &&
    producer.sha === expected.sha &&
    /^[a-f0-9]{40}$/.test(expected.sha) &&
    evidence["version"] === 1 &&
    evidence["sha"] === expected.sha &&
    evidence["identity"] === expected.identity &&
    evidence["profile"] === profile &&
    identities["check"] === expected.identity &&
    identities["test"] === expected.identity &&
    results["check"] === "success" &&
    results["test"] === "success" &&
    (results["website"] === "success" || results["website"] === "skipped")
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const [command, file] = process.argv.slice(2);

  if (command === "identity") console.log(validationIdentity());
  else if (command === "record" && file) {
    const evidence: Evidence = {
      version: 1,
      sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      // The collector does not perform validation. Preserve the producer jobs' identities.
      identity: process.env["CHECK_IDENTITY"] ?? "",
      identities: {
        check: process.env["CHECK_IDENTITY"] ?? "",
        test: process.env["TEST_IDENTITY"] ?? "",
        website: process.env["WEBSITE_IDENTITY"] ?? "",
      },
      profile,
      results: {
        check: process.env["CHECK_RESULT"] ?? "unknown",
        test: process.env["TEST_RESULT"] ?? "unknown",
        website: process.env["WEBSITE_RESULT"] ?? "unknown",
      },
    };

    writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
  } else if (command === "verify" && file) {
    const producer = JSON.parse(readFileSync(process.argv[4]!, "utf8")) as Producer;
    process.exitCode = acceptsEvidence(
      JSON.parse(readFileSync(file, "utf8")),
      {
        sha: process.env["VALIDATION_SHA"] ?? "",
        identity: validationIdentity(),
      },
      producer,
    )
      ? 0
      : 1;
  } else
    throw new Error("Use identity, record <file> or verify <evidence> <API producer metadata>");
}
