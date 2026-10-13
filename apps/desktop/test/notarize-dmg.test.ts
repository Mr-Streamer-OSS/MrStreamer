import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));

const xcrun = `#!/usr/bin/env node
const fs = await import("node:fs");
const args = process.argv.slice(2);
const calls = fs.existsSync(process.env.STAPLE_CALLS) ? fs.readFileSync(process.env.STAPLE_CALLS, "utf8") : "";
const staples = calls.split("\\n").filter((line) => line === "staple").length;
fs.appendFileSync(process.env.STAPLE_CALLS, args[1] + "\\n");
if (args[0] === "notarytool") {
  process.stdout.write(JSON.stringify({ id: "accepted-id", status: "Accepted" }));
} else if (args[1] === "staple") {
  if (process.env.STAPLE_SCENARIO === "hang") {
    setTimeout(() => {}, 120000);
  } else if (process.env.STAPLE_SCENARIO === "exhaust" ||
    (process.env.STAPLE_SCENARIO === "recover" && staples === 0)) {
    process.stderr.write('error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\\n');
    process.stderr.write("NSErrorFailingURLStringKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup\\n");
    process.stderr.write("CloudKit's response is inconsistent with expections: (null)\\n");
    process.exitCode = 68;
  } else if (process.env.STAPLE_SCENARIO === "permanent") {
    process.stderr.write("The ticket is invalid. The staple and validate action failed! Error 68.\\n");
    process.exitCode = 68;
  } else if (process.env.STAPLE_SCENARIO === "other-network") {
    process.stderr.write("Error Domain=NSURLErrorDomain Code=-1005\\n");
    process.stderr.write("NSErrorFailingURLStringKey=https://example.com/unrelated\\n");
    process.exitCode = 68;
  } else {
    process.stdout.write("The staple and validate action worked!\\n");
  }
}
`;

describe("notarizing and stapling a release DMG", () => {
  let directory: string;
  let dmg: string;
  let calls: string;
  let metadata: string;
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mrstreamer-dmg-staple-"));
    dmg = join(directory, "release.dmg");
    calls = join(directory, "calls.txt");
    metadata = join(directory, "latest-mac.yml");
    const fakeXcrun = join(directory, "xcrun");
    writeFileSync(fakeXcrun, xcrun);
    chmodSync(fakeXcrun, 0o755);
    writeFileSync(dmg, "signed DMG bytes");
    writeFileSync(`${dmg}.blockmap`, "stale");
    writeFileSync(
      metadata,
      "files:\n  - url: release.dmg\n    sha512: old\n    size: 1\n    blockMapSize: 5\n",
    );
    originalArgv = process.argv;
    originalEnv = { ...process.env };
    process.argv = [process.argv[0] ?? "node", "notarize-dmg.ts", dmg];
    process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
    process.env.APPLE_API_KEY = join(directory, "fake-key.p8");
    process.env.APPLE_API_KEY_ID = "test-key";
    process.env.APPLE_API_ISSUER = "test-issuer";
    process.env.STAPLE_CALLS = calls;
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const run = () => import("../scripts/notarize-dmg.ts");
  const commands = () => readFileSync(calls, "utf8").trim().split("\n");

  it("recovers a lost ticket connection and still validates and updates the release metadata", async () => {
    process.env.STAPLE_SCENARIO = "recover";
    await run();

    expect(commands()).toEqual(["submit", "staple", "staple", "validate"]);
    expect(readFileSync(metadata, "utf8")).toContain(
      `sha512: ${createHash("sha512").update(readFileSync(dmg)).digest("base64")}`,
    );
    expect(readFileSync(metadata, "utf8")).not.toContain("blockMapSize:");
    expect(() => readFileSync(`${dmg}.blockmap`)).toThrow();
  });

  it("rejects a permanent ticket failure immediately", async () => {
    process.env.STAPLE_SCENARIO = "permanent";
    await expect(run()).rejects.toThrow("DMG stapling failed on attempt 1: exit 68");
    expect(commands()).toEqual(["submit", "staple"]);
    expect(readFileSync(metadata, "utf8")).toContain("sha512: old");
    expect(readFileSync(`${dmg}.blockmap`, "utf8")).toBe("stale");
  });

  it("does not retry a lost connection outside ticket delivery", async () => {
    process.env.STAPLE_SCENARIO = "other-network";
    await expect(run()).rejects.toThrow("DMG stapling failed on attempt 1: exit 68");
    expect(commands()).toEqual(["submit", "staple"]);
  });

  it("stops after the bounded ticket-retrieval retry budget", async () => {
    process.env.STAPLE_SCENARIO = "exhaust";
    await expect(run()).rejects.toThrow("failed after 4 attempts: retry budget exhausted");
    expect(commands()).toEqual(["submit", "staple", "staple", "staple", "staple"]);
    expect(readFileSync(metadata, "utf8")).toContain("sha512: old");
  });

  it("stops a hanging stapler at the subprocess deadline", async () => {
    process.env.STAPLE_SCENARIO = "hang";
    await expect(run()).rejects.toThrow("DMG stapling failed on attempt 1");
    expect(commands()).toEqual(["submit", "staple"]);
    expect(readFileSync(metadata, "utf8")).toContain("sha512: old");
  }, 75_000);
});
