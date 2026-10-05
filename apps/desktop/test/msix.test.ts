import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion } from "@mrstreamer/contracts/version";
import { comparePackageVersions, packageVersion } from "@mrstreamer/contracts/package-version";

describe("Microsoft Store package versions", () => {
  it("numbers a stable release one major version up, with the Store's last part 0", () => {
    expect(packageVersion("0.0.4")).toBe("1.0.4.0");
    expect(packageVersion("0.1.0")).toBe("1.1.0.0");
    expect(packageVersion("1.0.0")).toBe("2.0.0.0");
  });

  it("numbers a nightly as a test package the Store refuses, between the stable releases around it", () => {
    const nightly = packageVersion("0.0.4-nightly.20261002.14");

    expect(nightly).toBe("1.0.3.14");
    expect(nightly.endsWith(".0")).toBe(false);
  });

  it("keeps the order of releases across stable boundaries", () => {
    const releases = [
      "0.0.3",
      "0.0.4-nightly.20261001.9",
      "0.0.4-nightly.20261002.14",
      "0.0.4",
      "0.0.5-nightly.20261003.20",
      "0.0.5",
      "0.1.0",
      "0.1.1-nightly.20261010.31",
      "1.0.0",
    ];
    const byRelease = [...releases].sort((a, b) =>
      compareVersions(parseVersion(a)!, parseVersion(b)!),
    );
    const byPackage = [...releases].sort((a, b) =>
      comparePackageVersions(packageVersion(a), packageVersion(b)),
    );

    expect(byRelease).toEqual(releases);
    expect(byPackage).toEqual(releases);
  });

  it("refuses what doesn't fit the Store's numbers", () => {
    expect(packageVersion("65534.65535.65535")).toBe("65535.65535.65535.0");
    expect(() => packageVersion("65535.0.0")).toThrow();
    expect(() => packageVersion("0.65536.0")).toThrow();
    expect(() => packageVersion("0.0.4-nightly.20261002.65536")).toThrow();
    expect(() => packageVersion("0.1.0-nightly.20261002.14")).toThrow();
    expect(() => packageVersion("0.0.4-beta")).toThrow();
  });
});
