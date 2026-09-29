// Downloads and installs releases with electron-updater, on the updates service's terms: nothing
// downloads before the user asks, nothing installs at quit, and the release is the one the
// service picked. electron-updater checks the SHA-512 from the release's update metadata, and on
// macOS Squirrel accepts only an update signed by the same Developer ID.
import electronUpdater from "electron-updater";
import type { Installer } from "../services/updates.ts";

export function electronInstaller(): Installer {
  const { autoUpdater, CancellationToken } = electronUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  return {
    async download(target, onProgress, signal) {
      autoUpdater.allowDowngrade = target.allowDowngrade;
      autoUpdater.setFeedURL({ provider: "generic", url: target.feedUrl });
      const result = await autoUpdater.checkForUpdates();
      // The metadata has to describe the release the service chose, not whatever sits there.
      const offered = result?.updateInfo.version;
      if (offered !== target.version) {
        throw new Error(`The release offers ${offered ?? "nothing"} instead of ${target.version}.`);
      }
      const token = new CancellationToken();
      signal.addEventListener("abort", () => token.cancel(), { once: true });
      const progress = (info: { percent: number }) => onProgress(Math.floor(info.percent));
      autoUpdater.on("download-progress", progress);
      try {
        await autoUpdater.downloadUpdate(token);
      } finally {
        autoUpdater.off("download-progress", progress);
      }
    },

    install() {
      // Silent on Windows, then start the new version.
      autoUpdater.quitAndInstall(true, true);
    },
  };
}
