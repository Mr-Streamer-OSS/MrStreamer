// electron-builder afterExtract hook: keeps Chromium's credits, Node.js's licence among them, in the
// Mac app. Electron's download keeps LICENSES.chromium.html next to Electron.app, and electron-builder
// deletes it there while it turns Electron.app into the app, before any extraResources are copied.
// So it moves into Electron.app's Resources first, which become the app's, where Settings > About
// reads it (src/main/services/licences.ts). Linux and Windows installers keep it next to the
// executable without help.
import { rename } from "node:fs/promises";
import { join } from "node:path";
// The context afterExtract gets is the one afterPack gets, which electron-builder exports.
import type { AfterPackContext } from "electron-builder";

const CREDITS = "LICENSES.chromium.html";

export default async function keepMacCredits(context: AfterPackContext): Promise<void> {
  if (context.electronPlatformName !== "darwin") return;
  const app = context.packager.info.framework.distMacOsAppName;
  await rename(
    join(context.appOutDir, CREDITS),
    join(context.appOutDir, app, "Contents", "Resources", CREDITS),
  );
}
