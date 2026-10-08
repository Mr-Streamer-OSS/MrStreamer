import { describe, expect, it } from "vitest";
import { phaseTable, timePhases, type Line } from "../scripts/mac-release-phases.ts";

/** Lines of a Mac release step, each read this many seconds after the step began. */
const transcript = (...lines: [seconds: number, text: string][]): Line[] =>
  lines.map(([seconds, text]) => ({ at: 1_000_000 + seconds * 1000, text }));

const seconds = (phases: ReturnType<typeof timePhases>) =>
  Object.fromEntries(phases.map((phase) => [phase.name, phase.seconds]));

// Lines as electron-builder, its notarizer (DEBUG=electron-notarize*) and notarize-dmg.ts print
// them. The 24-minute run of 6 October waited on Apple in both notarizations.
const slow = transcript(
  [2, "  • electron-builder  version=26.15.3 os=24.6.0"],
  [
    14,
    "  • signing         file=dist/mac-arm64/Mr. Streamer.app platform=darwin type=distribution",
  ],
  [40, "2026-10-06T23:44:52.000Z electron-notarize notarizing using notarytool"],
  [
    45,
    "2026-10-06T23:44:57.000Z electron-notarize:notarytool zip succeeded, attempting to upload to Apple",
  ],
  [
    840,
    "2026-10-06T23:58:12.000Z electron-notarize:notarytool notarization success (id: 6f9c0d2e-1111-4a5b-9c3d-0123456789ab)",
  ],
  [
    841,
    "2026-10-06T23:58:13.000Z electron-notarize:staple attempting to staple app: /a/Mr. Streamer.app",
  ],
  [850, "2026-10-06T23:58:22.000Z electron-notarize:staple staple succeeded"],
  [851, "  • notarization successful"],
  [852, "  • building        target=DMG arch=arm64 file=dist/Mr-Streamer-0.0.8-mac-arm64.dmg"],
  [866, "  • building block map  blockMapFile=dist/Mr-Streamer-0.0.8-mac-arm64.dmg.blockmap"],
  [868, "Submitting Mr-Streamer-0.0.8-mac-arm64.dmg for notarization"],
  [1450, "Notarization 0a1b2c3d-2222-4b6c-8d4e-abcdefabcdef Accepted"],
  [1450, "Stapling Mr-Streamer-0.0.8-mac-arm64.dmg"],
  [1451, "Processing: /a/dist/Mr-Streamer-0.0.8-mac-arm64.dmg"],
  [1452, "Notarized and stapled Mr-Streamer-0.0.8-mac-arm64.dmg."],
);

describe("timing a Mac release step", () => {
  it("splits the step by what the build printed, and the wait on Apple from the runner's work", () => {
    const phases = timePhases(1_000_000, slow);

    expect(seconds(phases)).toEqual({
      Package: 14,
      Sign: 26,
      "Check and zip the app": 5,
      "App notary round trip": 796,
      "Staple the app": 9,
      "Create the DMG and ZIP": 18,
      "DMG notary round trip": 582,
      "Staple the DMG and update its checksum": 2,
    });
    expect(phases.filter((phase) => phase.finished === false)).toEqual([]);
    expect(phases.flatMap((phase) => phase.submission ?? [])).toEqual([
      "6f9c0d2e-1111-4a5b-9c3d-0123456789ab",
      "0a1b2c3d-2222-4b6c-8d4e-abcdefabcdef",
    ]);
  });

  it("tables the totals, with the Apple share apart", () => {
    const table = phaseTable("Mac release phases", timePhases(1_000_000, slow));

    expect(table).toContain(
      "| App notary round trip | Apple | 796.0 | 6f9c0d2e-1111-4a5b-9c3d-0123456789ab |",
    );
    expect(table).toContain("| Runner total | | 63.0 | |");
    expect(table).toContain("| Apple total | | 1389.0 | |");
    expect(table).toContain("| Unattributed | | 0.0 | |");
  });

  it("tables an unobserved phase's neighbour as unknown time, not as work of its own kind", () => {
    // A notarizer that stops printing its debug lines leaves the signing phase covering Apple's
    // wait and the disk image's creation. Nothing says how much of the 854 seconds was the runner's.
    const quiet = slow.filter((line) => !/electron-notarize/.test(line.text));
    const phases = timePhases(1_000_000, quiet);
    const table = phaseTable("t", phases);

    expect(phases.find((phase) => phase.name === "App notary round trip")?.seconds).toBeNull();
    expect(phases.find((phase) => phase.name === "Sign")).toMatchObject({
      seconds: 854,
      covers: [
        "Check and zip the app",
        "App notary round trip",
        "Staple the app",
        "Create the DMG and ZIP",
      ],
    });
    expect(table).toContain("| App notary round trip | Apple | not observed |");
    expect(table).toContain(
      "| Sign | unknown | 854.0 | also covers Check and zip the app, App notary round trip, Staple the app, Create the DMG and ZIP |",
    );
    // Only what was seen is counted, and the rest is said to be missing from the totals.
    expect(table).toContain("| Unattributed | | 854.0 | |");
    expect(table).toMatch(/\| Runner total \| \| 14\.0 \| at least/);
    expect(table).toMatch(/\| Apple total \| \| 584\.0 \| at least/);
  });

  it("does not hand the wait on Apple to the phase before a lost upload marker", () => {
    const noUpload = slow.filter((line) => !/attempting to upload/.test(line.text));
    const phases = timePhases(1_000_000, noUpload);

    expect(phases.find((phase) => phase.name === "Check and zip the app")).toMatchObject({
      seconds: 801,
      covers: ["App notary round trip"],
    });
    expect(phaseTable("t", phases)).toContain("| Unattributed | | 801.0 | |");
  });

  it("covers a phase whose marker is lost at the end of a build that finished", () => {
    const noStaple = slow.filter((line) => !/^Stapling /.test(line.text));
    const phases = timePhases(1_000_000, noStaple);

    expect(phases.find((phase) => phase.name === "DMG notary round trip")).toMatchObject({
      seconds: 584,
      covers: ["Staple the DMG and update its checksum"],
    });
  });

  it("reports the phase a failed build stopped in as unfinished", () => {
    const rejected = slow.slice(
      0,
      slow.findIndex((line) => line.text.startsWith("Notarization ")),
    );
    const last = timePhases(1_000_000, rejected).findLast((phase) => phase.seconds !== null);

    expect(last).toMatchObject({ name: "DMG notary round trip", finished: false });
  });
});
