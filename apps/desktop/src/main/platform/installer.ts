// Downloads and installs releases with electron-updater, on the updates service's terms: nothing
// downloads before the user asks, nothing installs at quit, and the release is the one the
// service picked. electron-updater checks the SHA-512 from the release's update metadata, and on
// macOS Squirrel accepts only an update signed by the same Developer ID. Squirrel checks that
// when installing, so a refused update surfaces from `install`.
import electronUpdater, { type CancellationToken } from "electron-updater";
import type { Installer } from "../services/updates.ts";

/** The part of electron-updater's autoUpdater this adapter drives. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  logger: unknown;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>;
  downloadUpdate(token: CancellationToken): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  off(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export function electronInstaller(updater: Updater = electronUpdater.autoUpdater): Installer {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.logger = null;
  /**
   * The download before, until it has stopped. electron-updater shares one check and one
   * download at a time, so a new download waits for a cancelled one to wind down instead of
   * joining it and staging the release the user dropped.
   */
  let previous: Promise<unknown> = Promise.resolve();

  const downloadOne: Installer["download"] = async (target, onProgress, signal) => {
    // Listening from the start, so a cancel during any step stops the download.
    const token = new electronUpdater.CancellationToken();
    const cancel = () => token.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    const progress = (info: { percent: number }) => onProgress(Math.floor(info.percent));
    try {
      signal.throwIfAborted();
      updater.allowDowngrade = target.allowDowngrade;
      updater.setFeedURL({ provider: "generic", url: target.feedUrl });
      const result = await updater.checkForUpdates();
      signal.throwIfAborted();
      // The metadata has to describe the release the service chose, not whatever sits there.
      const offered = result?.updateInfo.version;
      if (offered !== target.version) {
        throw new Error(`The release offers ${offered ?? "nothing"} instead of ${target.version}.`);
      }
      updater.on("download-progress", progress);
      await updater.downloadUpdate(token);
      signal.throwIfAborted();
    } finally {
      updater.off("download-progress", progress);
      signal.removeEventListener("abort", cancel);
    }
  };

  return {
    download(target, onProgress, signal) {
      const next = previous.then(() => downloadOne(target, onProgress, signal));
      previous = next.catch(() => {});
      return next;
    },

    install() {
      return new Promise((_resolve, reject) => {
        updater.once("error", reject);
        // Silent on Windows, then start the new version.
        updater.quitAndInstall(true, true);
      });
    },
  };
}
