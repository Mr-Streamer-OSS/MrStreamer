import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createUpdates, finishFreshStart, type Installer } from "../src/main/services/updates.ts";
import { fetchReleases, type PublishedRelease } from "../src/main/updates/feed.ts";
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

/**
 * Records what the updates service asked of the installer. `failures` downloads fail before one
 * succeeds; `hold` keeps a download open until `release()`, and `finishesAnyway` lets it finish
 * even after a cancel, as a real one can at that moment; `refuse` is the reason the system gives
 * for rejecting the install.
 */
function fakeInstaller(
  options: { failures?: number; hold?: boolean; finishesAnyway?: boolean; refuse?: string } = {},
) {
  const downloads: { feedUrl: string; version: string; allowDowngrade: boolean }[] = [];
  let installs = 0;
  let failures = options.failures ?? 0;
  let release: (() => void) | null = null;
  const installer: Installer = {
    async download(target, onProgress, signal) {
      downloads.push(target);
      onProgress(50);
      if (options.hold) {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          if (options.finishesAnyway) return;
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      }
      if (failures-- > 0) throw new Error("The download broke off.");
      onProgress(100);
    },
    async install() {
      installs++;
      if (options.refuse) throw new Error(options.refuse);
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

    await service.restart();
    expect(fake.installs()).toBe(1);
  });

  it.each([false, true])(
    "goes back to the available update when a download is cancelled (finishes anyway: %s)",
    async (finishesAnyway) => {
      const fake = fakeInstaller({ hold: true, finishesAnyway });
      const { service } = await updates("0.2.0", PUBLISHED, { installer: fake.installer });
      await service.check();

      const download = service.download();
      await Promise.resolve();
      service.cancel();
      fake.release();

      expect((await download).update).toEqual({ kind: "available", version: "0.2.1" });
    },
  );

  it("reports a failed download, and downloads again on Try again", async () => {
    const fake = fakeInstaller({ failures: 1 });
    const { service } = await updates("0.2.0", PUBLISHED, { installer: fake.installer });
    await service.check();

    expect((await service.download()).update).toEqual({
      kind: "failed",
      step: "download",
      detail: "The download broke off.",
    });
    expect((await service.download()).update).toEqual({ kind: "ready", version: "0.2.1" });
    expect(fake.downloads).toHaveLength(2);
  });

  it("reports an install the system refuses, and can download it again", async () => {
    const refusal = "The update's signature doesn't match this app.";
    const { service } = await updates("0.2.0", PUBLISHED, {
      installer: fakeInstaller({ refuse: refusal }).installer,
    });
    await service.check();
    await service.download();

    await service.restart();

    expect((await service.status()).update).toEqual({
      kind: "failed",
      step: "install",
      detail: refusal,
    });
    expect((await service.download()).update).toEqual({ kind: "ready", version: "0.2.1" });
  });

  it("drops a downloaded nightly when the user switches to Stable", async () => {
    const fake = fakeInstaller();
    const { service } = await updates("0.3.0-nightly.20261001.10", PUBLISHED, {
      installer: fake.installer,
    });
    await service.check();
    await service.download();

    expect((await service.setChannel("stable")).update).toEqual({ kind: "idle" });
    await service.restart();
    expect(fake.installs()).toBe(0);
    // Nothing on Stable is newer than the installed nightly.
    expect((await service.check()).update).toEqual({ kind: "current" });
  });

  it("drops a nightly download that finishes after the switch to Stable", async () => {
    const fake = fakeInstaller({ hold: true, finishesAnyway: true });
    const { service } = await updates("0.3.0-nightly.20261001.10", PUBLISHED, {
      installer: fake.installer,
    });
    await service.check();
    const download = service.download();
    await Promise.resolve();

    await service.setChannel("stable");
    fake.release();

    expect((await download).update).toEqual({ kind: "idle" });
    await service.restart();
    expect(fake.installs()).toBe(0);
  });

  it("keeps a downloaded stable release when a Nightly user switches to Stable", async () => {
    const { service } = await updates("0.3.0-nightly.20261001.10", [
      ...PUBLISHED,
      release("v0.3.0"),
    ]);
    await service.check();
    await service.download();

    expect((await service.setChannel("stable")).update).toEqual({
      kind: "ready",
      version: "0.3.0",
    });
  });
});

describe("update feed", () => {
  /** A GitHub-like API: 100 newer nightlies fill the first page, Stable is further back. */
  function github(stable: string | null) {
    const asRelease = (tag: string) => ({
      tag_name: tag,
      prerelease: tag.includes("-nightly."),
      draft: false,
      assets: [
        {
          name: METADATA,
          browser_download_url: `https://example.test/download/${tag}/${METADATA}`,
        },
      ],
    });
    const nightlies = Array.from({ length: 100 }, (_, run) =>
      asRelease(`v0.0.2-nightly.20261002.${200 - run}`),
    );
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/releases/latest")) {
        return stable ? json(asRelease(stable)) : json({ message: "Not Found" }, 404);
      }
      if (url.includes("page=2")) return json(stable ? [asRelease(stable)] : []);
      return json(nightlies);
    });
  }

  it("finds Stable behind a full page of newer nightlies", async () => {
    const fetchImpl = github("v0.0.1");
    const dataDir = await tempDir();
    const service = (installed: string) =>
      createUpdates({
        dataDir,
        installed,
        metadataFile: METADATA,
        releases: () => fetchReleases("https://api.example.test", "owner/app", fetchImpl),
        installer: fakeInstaller().installer,
        freshOutcome: { kind: "idle" },
        onChanged: () => {},
      });

    const stableUser = service("0.0.0");
    await stableUser.setChannel("stable");
    expect((await stableUser.check()).update).toEqual({ kind: "available", version: "0.0.1" });
    expect((await service("0.0.2-nightly.20261002.200").prepareFresh()).fresh).toEqual({
      kind: "ready",
      version: "0.0.1",
    });
  });

  it("works before the first stable release", async () => {
    const releases = await fetchReleases("https://api.example.test", "owner/app", github(null));

    expect(releases).toHaveLength(100);
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
      installer: fakeInstaller({ failures: 1 }).installer,
    });
    expect((await failing.service.prepareFresh()).fresh).toMatchObject({ kind: "failed" });

    const keeping = await updates("0.3.0-nightly.20261002.14", PUBLISHED, { dataDir });
    await keeping.service.prepareFresh();
    expect((await keeping.service.keepEverything()).fresh).toEqual({ kind: "idle" });
    expect(existsSync(join(dataDir, "subscription.json"))).toBe(true);
  });

  it("installs Stable after the final confirmation, and Stable erases the data when it starts", async () => {
    const dataDir = await deviceWithData();
    const fake = fakeInstaller();
    const { service } = await updates("0.3.0-nightly.20261002.14", PUBLISHED, {
      dataDir,
      installer: fake.installer,
    });
    await service.prepareFresh();

    await service.startFresh();

    expect(fake.installs()).toBe(1);
    // The nightly quits with its data intact; Stable erases it before reading anything.
    expect(existsSync(join(dataDir, "subscription.json"))).toBe(true);
    const eraseBrowserData = vi.fn(async () => {});
    expect(await finishFreshStart(dataDir, "0.2.1", eraseBrowserData)).toEqual({ kind: "idle" });
    for (const file of ["subscription.json", "preferences.json", "catalogue.json"]) {
      expect(existsSync(join(dataDir, file))).toBe(false);
    }
    expect(eraseBrowserData).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(dataDir, "updates.json"), "utf8"))).toEqual({
      channel: "stable",
    });
  });

  it("keeps the data when the system refuses Stable", async () => {
    const dataDir = await deviceWithData();
    const refusal = "The update's signature doesn't match this app.";
    const { service } = await updates("0.3.0-nightly.20261002.14", PUBLISHED, {
      dataDir,
      installer: fakeInstaller({ refuse: refusal }).installer,
    });
    await service.prepareFresh();

    await service.startFresh();

    expect((await service.status()).fresh).toEqual({
      kind: "not-installed",
      version: "0.2.1",
      detail: refusal,
    });
    const eraseBrowserData = vi.fn(async () => {});
    expect(await finishFreshStart(dataDir, "0.3.0-nightly.20261002.14", eraseBrowserData)).toEqual({
      kind: "idle",
    });
    expect(existsSync(join(dataDir, "subscription.json"))).toBe(true);
    expect(eraseBrowserData).not.toHaveBeenCalled();
  });

  it("keeps the data when an interrupted install leaves the nightly running", async () => {
    const dataDir = await deviceWithData();
    // The marker went down, then the nightly started again instead of Stable.
    await writeFile(join(dataDir, "fresh-start.json"), JSON.stringify({ version: "0.2.1" }));

    const outcome = await finishFreshStart(dataDir, "0.3.0-nightly.20261002.14", async () => {});

    expect(outcome).toEqual({ kind: "not-installed", version: "0.2.1", detail: null });
    expect(existsSync(join(dataDir, "subscription.json"))).toBe(true);
    expect(existsSync(join(dataDir, "fresh-start.json"))).toBe(false);
    const { service } = await updates("0.3.0-nightly.20261002.14", PUBLISHED, {
      dataDir,
      freshOutcome: outcome,
    });
    expect((await service.status()).fresh).toEqual(outcome);
  });

  it("finishes an erase a crash interrupted once Stable runs", async () => {
    const dataDir = await deviceWithData();
    await writeFile(join(dataDir, "fresh-start.json"), JSON.stringify({ version: "0.2.1" }));

    expect(await finishFreshStart(dataDir, "0.2.1", async () => {})).toEqual({ kind: "idle" });

    expect(existsSync(join(dataDir, "subscription.json"))).toBe(false);
    expect(existsSync(join(dataDir, "fresh-start.json"))).toBe(false);
  });
});
