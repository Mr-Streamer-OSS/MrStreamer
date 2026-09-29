import { describe, expect, it } from "vitest";
import { planRelease, type ReleaseRequest } from "../scripts/release-plan.ts";
import { compareVersions, formatVersion, parseVersion } from "../src/shared/version.ts";

const request = (overrides: Partial<ReleaseRequest>): ReleaseRequest => ({
  channel: "stable",
  version: "0.2.0",
  date: "20261002",
  run: 14,
  ...overrides,
});

describe("release versions", () => {
  it("orders stable releases and the nightlies between them", () => {
    const shuffled = [
      "0.3.0",
      "0.3.0-nightly.20261002.14",
      "0.2.0",
      "0.10.0",
      "0.3.0-nightly.20261002.9",
      "0.3.0-nightly.20261001.20",
      "0.2.1",
    ];

    const sorted = shuffled
      .map((text) => parseVersion(text))
      .flatMap((version) => (version ? [version] : []))
      .sort(compareVersions)
      .map(formatVersion);

    expect(sorted).toEqual([
      "0.2.0",
      "0.2.1",
      "0.3.0-nightly.20261001.20",
      "0.3.0-nightly.20261002.9",
      "0.3.0-nightly.20261002.14",
      "0.3.0",
      "0.10.0",
    ]);
  });

  it("reads only the stable and nightly formats", () => {
    expect(parseVersion("v0.2.0")).toMatchObject({ minor: 2, nightly: null });
    expect(parseVersion("0.2.0-beta.1")).toBeNull();
    expect(parseVersion("0.2")).toBeNull();
  });
});

describe("release plans", () => {
  it("prepares the first stable release", () => {
    expect(planRelease(request({}), [])).toEqual({
      version: "0.2.0",
      tag: "v0.2.0",
      channel: "stable",
    });
  });

  it("names a nightly after the stable version it leads up to, the date and the run", () => {
    expect(planRelease(request({ channel: "nightly", version: "0.3.0" }), ["v0.2.0"])).toEqual({
      version: "0.3.0-nightly.20261002.14",
      tag: "v0.3.0-nightly.20261002.14",
      channel: "nightly",
    });
  });

  it("refuses a stable release that is not newer than the newest stable", () => {
    expect(() => planRelease(request({ version: "0.2.0" }), ["v0.2.0"])).toThrow("already exists");
    expect(() => planRelease(request({ version: "0.1.9" }), ["v0.2.0"])).toThrow(
      "not newer than 0.2.0",
    );
  });

  it("refuses a nightly that does not lead past the newest stable", () => {
    expect(() =>
      planRelease(request({ channel: "nightly", version: "0.2.0" }), ["v0.1.0", "v0.2.0"]),
    ).toThrow("after 0.2.0");
  });

  it("allows a stable release after nightlies of the same version", () => {
    const tags = ["v0.2.0", "v0.3.0-nightly.20261001.3", "v0.3.0-nightly.20261002.14"];

    expect(planRelease(request({ version: "0.3.0" }), tags).tag).toBe("v0.3.0");
  });

  it("refuses a version that is not a plain stable number", () => {
    expect(() => planRelease(request({ version: "0.3.0-nightly.20261002.1" }), [])).toThrow(
      "not a stable version",
    );
  });
});
