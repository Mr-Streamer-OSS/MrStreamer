import { EventEmitter } from "node:events";
import type { CancellationToken } from "electron-updater";
import { describe, expect, it } from "vitest";
import { electronInstaller, type Updater } from "../src/main/platform/installer.ts";

/** Stands in for electron-updater's autoUpdater: each step waits until the test lets it go on. */
class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = false;
  logger: unknown = console;
  readonly metadata = Promise.withResolvers<void>();
  readonly transfer = Promise.withResolvers<void>();
  readonly downloads: CancellationToken[] = [];
  refusal: Error | null = null;

  setFeedURL(): void {}

  async checkForUpdates() {
    await this.metadata.promise;
    return { updateInfo: { version: "0.0.2" } };
  }

  async downloadUpdate(token: CancellationToken) {
    this.downloads.push(token);
    await this.transfer.promise;
    return [];
  }

  quitAndInstall(): void {
    // Squirrel checks the update's signature here, and reports a mismatch as an error.
    if (this.refusal) this.emit("error", this.refusal);
  }
}

const TARGET = { feedUrl: "https://example.test/v0.0.2", version: "0.0.2", allowDowngrade: false };

describe("electron-updater installer", () => {
  it("never starts the download when cancelled while the metadata loads", async () => {
    const updater = new FakeUpdater();
    const controller = new AbortController();
    const download = electronInstaller(updater).download(TARGET, () => {}, controller.signal);

    controller.abort();
    updater.metadata.resolve();

    await expect(download).rejects.toThrow();
    expect(updater.downloads).toEqual([]);
  });

  it("cancels a download in progress", async () => {
    const updater = new FakeUpdater();
    updater.metadata.resolve();
    const controller = new AbortController();
    const download = electronInstaller(updater).download(TARGET, () => {}, controller.signal);
    await expect.poll(() => updater.downloads.length).toBe(1);

    controller.abort();
    updater.transfer.resolve();

    await expect(download).rejects.toThrow();
    expect(updater.downloads[0]?.cancelled).toBe(true);
  });

  it("reports an install the system refuses", async () => {
    const updater = new FakeUpdater();
    updater.refusal = new Error("Code signature did not pass validation.");

    await expect(electronInstaller(updater).install()).rejects.toThrow(
      "Code signature did not pass validation.",
    );
  });
});
