import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createUpdates,
  eraseDeviceData,
  finishFreshStart,
  type Installer,
} from "../src/main/services/updates.ts";
import type { PublishedRelease } from "../src/main/updates/feed.ts";
import type { FreshStart } from "../src/shared/updates.ts";
import { tempDir } from "./support.ts";

const METADATA = "latest-mac.yml";

function release(
  tag: string,
  options: { prerelease?: boolean; draft?: boolean } = {},
): PublishedRelease {
  const prerelease = options.prerelease ?? tag.includes("-nightly.");
  return {
    tag,
    prerelease,
    draft: options.draft ?? false,
    assets: [{ name: METADATA, url: `https://example.test/download/${tag}/${METADATA}` }],
  };
}

/** Records what the updates service asked of the installer. */
function fakeInstaller(options: { fail?: boolean; hold?: boolean } = {}) {
  const downloads: { feedUrl: string; version: string; allowDowngrade: boolean }[] = [];
  let installs = 0;
  let release: (() => void) | null = null;
  const installer: Installer = {
    async download(target, onProgress, signal) {
      downloads.push(target);
      onProgress(50);
      if (options.hold) {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      }
      if (options.fail) throw new Error("The download broke off.");
      onProgress(100);
    },
    install() {
      installs++;
    },
  };
  return { installer, downloads, installs: () => installs, release: () => release?.() };
}

async function updates(
  installed: string,
  releases: readonly PublishedRelease[],
  options: { dataDir?: string; installer?: Installer; freshOutcome?: FreshStart } = {},
) {
  const dataDir = options.dataDir ?? (await tempDir());
  const installer = options.installer ?? fakeInstaller().installer;
  const service = createUpdates({
    dataDir,
    installed,
    metadataFile: METADATA,
    releases: async () => releases,
    installer,
    erase: () => eraseDeviceData(dataDir),
    freshOutcome: options.freshOutcome ?? { kind: "idle" },
    onChanged: () => {},
  });
  return { dataDir, service };
}

const PUBLISHED = [
  release("v0.2.0"),
  release("v0.2.1"),
  release("v0.3.0-nightly.20261001.10"),
  release("v0.3.0-nightly.20261002.14"),
];

describe("update channels", () => {
  it("starts on the channel of the downloaded build", async () => {
    expect((await (await updates("0.2.0", [])).service.status()).channel).toBe("stable");
    expect((await (await updates("0.3.0-nightly.20261002.14", [])).service.status()).channel).toBe(
      "nightly",
    );
  });

  it("offers Stable users the newest stable release only", async () => {
    const { service } = await updates("0.2.0", PUBLISHED);

    expect((await service.check()).update).toEqual({ kind: "available", version: "0.2.1" });
  });

  it("offers Nightly users the newest build of either channel", async () => {
    const { service } = await updates("0.3.0-nightly.20261001.10", [
      ...PUBLISHED,
      release("v0.3.0"),
    ]);

    expect((await service.check()).update).toEqual({ kind: "available", version: "0.3.0" });
  });

  it("orders by version, not by publication, and ignores releases whose flag and version disagree", async () => {
    const { service } = await updates("0.2.0", [
      release("v0.2.1"),
      // Published later, but older.
      release("v0.2.0"),
      // A stable version marked as a pre-release, and a nightly marked as stable.
      release("v0.9.0", { prerelease: true }),
      release("v0.8.0-nightly.20261003.1", { prerelease: false }),
      release("v0.7.0", { draft: true }),
    ]);

    expect((await service.check()).update).toEqual({ kind: "available", version: "0.2.1" });
  });

  it("keeps a Nightly user on Nightly after installing a stable release", async () => {
    const dataDir = await tempDir();
    await (await updates("0.3.0-nightly.20261002.14", [], { dataDir })).service.status();

    const afterUpdate = await updates("0.3.0", [], { dataDir });

    expect((await afterUpdate.service.status()).channel).toBe("nightly");
  });

  it("switches to Stable without downgrading a newer nightly", async () => {
    const { service } = await updates("0.3.0-nightly.20261002.14", PUBLISHED);

    await service.setChannel("stable");
    const status = await service.check();

    expect(status.update).toEqual({ kind: "current" });
    expect(status.aheadOf).toBe("0.2.1");
    expect(status.channel).toBe("stable");
  });

  it("reports a failed check", async () => {
    const dataDir = await tempDir();
    const service = createUpdates({
      dataDir,
      installed: "0.2.0",
      metadataFile: METADATA,
      releases: () => Promise.reject(new Error("The release list answered HTTP 404.")),
      installer: fakeInstaller().installer,
      erase: async () => {},
      freshOutcome: { kind: "idle" },
      onChanged: () => {},
    });

    expect((await service.check()).update).toEqual({
      kind: "failed",
      step: "check",
      detail: "The release list answered HTTP 404.",
    });
  });
});

describe("in-app updates", () => {
  it("downloads only when asked and installs only after the restart is confirmed", async () => {
    const fake = fakeInstaller();
    const { service } = await updates("0.2.0", PUBLISHED, { installer: fake.installer });

    await service.check();
    expect(fake.downloads).toEqual([]);
    expect((await service.download()).update).toEqual({ kind: "ready", version: "0.2.1" });
    expect(fake.downloads).toEqual([
      { feedUrl: "https://example.test/download/v0.2.1", version: "0.2.1", allowDowngrade: false },
    ]);
    expect(fake.installs()).toBe(0);

    service.restart();
    expect(fake.installs()).toBe(1);
  });

  it("goes back to the available update when a download is cancelled", async () => {
    const fake = fakeInstaller({ hold: true });
    const { service } = await updates("0.2.0", PUBLISHED, { installer: fake.installer });
    await service.check();

    const download = service.download();
    await Promise.resolve();
    service.cancel();

    expect((await download).update).toEqual({ kind: "available", version: "0.2.1" });
  });

  it("reports a failed download", async () => {
    const { service } = await updates("0.2.0", PUBLISHED, {
      installer: fakeInstaller({ fail: true }).installer,
    });
    await service.check();

    expect((await service.download()).update).toEqual({
      kind: "failed",
      step: "download",
      detail: "The download broke off.",
    });
  });
});

describe("starting fresh on Stable", () => {
  async function deviceWithData() {
    const dataDir = await tempDir();
    for (const file of ["subscription.json", "preferences.json", "catalogue.json"]) {
      await writeFile(join(dataDir, file), "{}");
    }
    return dataDir;
  }

  it("downloads the newest stable release, even when it is older, before erasing anything", async () => {
    const dataDir = await deviceWithData();
    const fake = fakeInstaller();
    const { service } = await updates("0.3.0-nightly.20261002.14", PUBLISHED, {
      dataDir,
      installer: fake.installer,
    });

    expect((await service.prepareFresh()).fresh).toEqual({ kind: "ready", version: "0.2.1" });
    expect(fake.downloads.at(-1)).toMatchObject({ version: "0.2.1", allowDowngrade: true });
    expect(existsSync(join(dataDir, "subscription.json"))).toBe(true);
    expect(fake.installs()).toBe(0);
  });

  it("changes nothing when the download fails or the user keeps everything", async () => {
    const dataDir = await deviceWithData();
    const failing = await updates("0.3.0-nightly.20261002.14", PUBLISHED, {
      dataDir,
      installer: fakeInstaller({ fail: true }).installer,
    });
    expect((await failing.service.prepareFresh()).fresh).toMatchObject({ kind: "failed" });

    const keeping = await updates("0.3.0-nightly.20261002.14", PUBLISHED, { dataDir });
    await keeping.service.prepareFresh();
    expect((await keeping.service.keepEverything()).fresh).toEqual({ kind: "idle" });
    expect(existsSync(join(dataDir, "subscription.json"))).toBe(true);
  });

  it("erases this device's data and installs Stable after the final confirmation", async () => {
    const dataDir = await deviceWithData();
    const fake = fakeInstaller();
    const { service } = await updates("0.3.0-nightly.20261002.14", PUBLISHED, {
      dataDir,
      installer: fake.installer,
    });
    await service.prepareFresh();

    await service.startFresh();

    expect(existsSync(join(dataDir, "subscription.json"))).toBe(false);
    expect(existsSync(join(dataDir, "preferences.json"))).toBe(false);
    expect(existsSync(join(dataDir, "catalogue.json"))).toBe(false);
    expect(fake.installs()).toBe(1);
    // Stable starts clean, on Stable.
    expect(await finishFreshStart(dataDir, "0.2.1")).toEqual({ kind: "idle" });
    expect(JSON.parse(await readFile(join(dataDir, "updates.json"), "utf8"))).toEqual({
      channel: "stable",
    });
  });

  it("finishes an interrupted erase and reports when Stable did not install", async () => {
    const dataDir = await deviceWithData();
    // The marker went down, then the app stopped before erasing everything.
    await writeFile(join(dataDir, "fresh-start.json"), JSON.stringify({ version: "0.2.1" }));

    const outcome = await finishFreshStart(dataDir, "0.3.0-nightly.20261002.14");

    expect(outcome).toEqual({ kind: "not-installed", version: "0.2.1" });
    expect(existsSync(join(dataDir, "subscription.json"))).toBe(false);
    expect(existsSync(join(dataDir, "fresh-start.json"))).toBe(false);
    const { service } = await updates("0.3.0-nightly.20261002.14", PUBLISHED, {
      dataDir,
      freshOutcome: outcome,
    });
    expect((await service.status()).fresh).toEqual(outcome);
  });
});
