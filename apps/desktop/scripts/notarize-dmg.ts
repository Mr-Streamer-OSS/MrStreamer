// Notarizes and staples the signed DMG electron-builder made, so a downloaded copy passes
// Gatekeeper even offline. electron-builder notarizes the app inside but not the disk image.
//
//   node scripts/notarize-dmg.ts dist/Mr-Streamer-0.2.0-mac-arm64.dmg
//
// Needs APPLE_API_KEY (path of the .p8 key), APPLE_API_KEY_ID and APPLE_API_ISSUER, the same
// variables electron-builder notarizes the app with. Stapling changes the file, so the script
// then updates the DMG's checksum and size in latest-mac.yml and drops its stale block map.
// The lines it prints at each step mark the phases scripts/mac-release-phases.ts times; the wait
// for Apple is the one between "Submitting" and "Notarization ... Accepted", and a rejection ends
// the run there.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";

const STAPLE_DELAYS_MS = [30_000, 60_000, 120_000];
const STAPLE_DEADLINE_MS = 300_000;
const STAPLE_ATTEMPT_MS = 60_000;
const TICKET_LOOKUP =
  "api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup";

/** Retry only a lost connection while fetching an accepted DMG's CloudKit ticket. */
async function stapleDmg(dmg: string): Promise<void> {
  const deadline = Date.now() + STAPLE_DEADLINE_MS;
  for (let attempt = 1; attempt <= STAPLE_DELAYS_MS.length + 1; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("DMG stapling retry deadline exceeded.");

    const result = spawnSync("xcrun", ["stapler", "staple", dmg], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      timeout: Math.min(STAPLE_ATTEMPT_MS, remaining),
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status === 0 && !result.error) return;

    const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const lostTicketConnection =
      !result.error &&
      result.status === 68 &&
      /NSURLErrorDomain Code=-1005\b/.test(diagnostic) &&
      diagnostic.includes(TICKET_LOOKUP);
    const detail = result.error?.message ?? `exit ${result.status ?? "unknown"}`;
    if (!lostTicketConnection)
      throw new Error(`DMG stapling failed on attempt ${attempt}: ${detail}.`);

    const delay = STAPLE_DELAYS_MS[attempt - 1];
    if (delay === undefined || deadline - Date.now() <= delay) {
      throw new Error(
        `DMG ticket download failed after ${attempt} attempts: retry budget exhausted.`,
      );
    }
    console.error(
      `DMG ticket download lost connection (attempt ${attempt}); retrying in ${delay / 1000}s.`,
    );
    await setTimeout(delay);
  }
}

const dmg = process.argv[2];
if (!dmg?.endsWith(".dmg")) throw new Error("Usage: node scripts/notarize-dmg.ts <file>.dmg");
const key = process.env["APPLE_API_KEY"];
const keyId = process.env["APPLE_API_KEY_ID"];
const issuer = process.env["APPLE_API_ISSUER"];
if (!key || !keyId || !issuer) {
  throw new Error("Set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER.");
}
const credentials = ["--key", key, "--key-id", keyId, "--issuer", issuer];

console.log(`Submitting ${basename(dmg)} for notarization`);
const submission = JSON.parse(
  execFileSync(
    "xcrun",
    ["notarytool", "submit", dmg, ...credentials, "--wait", "--output-format", "json"],
    { encoding: "utf8" },
  ),
) as { id: string; status: string };
if (submission.status !== "Accepted") {
  const log = execFileSync("xcrun", ["notarytool", "log", submission.id, ...credentials], {
    encoding: "utf8",
  });
  throw new Error(`Notarization ended as ${submission.status}:\n${log}`);
}
console.log(`Notarization ${submission.id} ${submission.status}`);
console.log(`Stapling ${basename(dmg)}`);
await stapleDmg(dmg);
execFileSync("xcrun", ["stapler", "validate", dmg], { stdio: "inherit" });

rmSync(`${dmg}.blockmap`, { force: true });
const metadata = join(dirname(dmg), "latest-mac.yml");
if (existsSync(metadata)) {
  const sha512 = createHash("sha512").update(readFileSync(dmg)).digest("base64");
  const size = statSync(dmg).size;
  // The entry is "- url: <name>" followed by its sha512, size and blockMapSize lines.
  const lines = readFileSync(metadata, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `- url: ${basename(dmg)}`);
  if (start === -1) throw new Error(`${metadata} does not list ${basename(dmg)}.`);
  for (
    let index = start + 1;
    index < lines.length && !lines[index]?.trim().startsWith("-");
    index++
  ) {
    const line = lines[index] ?? "";
    const indent = line.slice(0, line.length - line.trimStart().length);
    if (!indent) break;
    if (line.trim().startsWith("sha512:")) lines[index] = `${indent}sha512: ${sha512}`;
    if (line.trim().startsWith("size:")) lines[index] = `${indent}size: ${size}`;
    if (line.trim().startsWith("blockMapSize:")) lines[index] = "";
  }
  writeFileSync(
    metadata,
    lines.filter((line, index) => line !== "" || index === lines.length - 1).join("\n"),
  );
}
console.log(`Notarized and stapled ${basename(dmg)}.`);
