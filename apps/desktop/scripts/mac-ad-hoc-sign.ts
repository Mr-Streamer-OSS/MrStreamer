// electron-builder afterPack hook: seals the Mac app with an ad hoc signature.
// Without a Developer ID, electron-builder skips signing and leaves Electron's own signature, which
// no longer matches the finished bundle. macOS then calls a downloaded copy damaged and offers no
// way to open it. With the ad hoc seal it blocks the first launch instead, and System Settings >
// Privacy & Security > Open Anyway starts the app. A Developer ID, when present, signs over this.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { AfterPackContext } from "electron-builder";

export default function adHocSign(context: AfterPackContext): void {
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", app], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`Ad hoc signing ${app} failed`);
}
