// Builds the Windows installer on Windows, macOS or Linux: `pnpm dist:win`.
// On Linux, electron-builder runs the NSIS uninstaller through Wine, and the Wine it downloads by
// itself has no Windows DLLs. This script fetches a pinned standalone Wine that runs 32- and
// 64-bit Windows programs without 32-bit system libraries, and points electron-builder at it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { build, Platform } from "electron-builder";

const WINE = {
  name: "wine-11.0-amd64-wow64",
  url: "https://github.com/Kron4ek/Wine-Builds/releases/download/11.0/wine-11.0-amd64-wow64.tar.xz",
  sha256: "39574efa1132c3ca0d5c77dd2eddbe4a49cca0d6cc2c290ff4924493a1c40314",
};

const wine = process.platform === "linux" ? await prepareWine() : null;
try {
  if (wine) process.env["ELECTRON_BUILDER_WINE_TOOLSET_DIR"] = wine.dir;
  await build({ targets: Platform.WINDOWS.createTarget(), publish: "never" });
} finally {
  // Wine leaves background services running after the uninstaller step.
  if (wine) spawnSync(join(wine.dir, "bin", "wineserver"), ["-k"], { env: wine.env });
}

/** Downloads and unpacks Wine once, then sets up the Windows environment electron-builder uses. */
async function prepareWine() {
  const cache = join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "mr-streamer");
  const dir = join(cache, WINE.name);
  if (!existsSync(join(dir, "bin", "wine"))) {
    console.log(`Downloading ${WINE.name}`);
    const response = await fetch(WINE.url);
    if (!response.ok) throw new Error(`Wine download failed with HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== WINE.sha256) throw new Error(`Wine download has checksum ${digest}`);
    await mkdir(cache, { recursive: true });
    const file = join(cache, `${WINE.name}.tar.xz`);
    await writeFile(file, archive);
    run("tar", ["-xJf", file, "-C", cache]);
    await rm(file);
  }

  // electron-builder uses this prefix and waits two minutes for the uninstaller. Creating the
  // prefix takes about one, so it happens here, once. Without a display Wine opens no windows.
  const prefix = join(dir, "wine-home");
  const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...base } = process.env;
  const env = {
    ...base,
    WINEPREFIX: prefix,
    WINEDEBUG: "-all",
    WINEDLLOVERRIDES: "mscoree,mshtml=",
  };
  if (!existsSync(join(prefix, "system.reg"))) {
    console.log("Setting up Wine, once");
    run(join(dir, "bin", "wine"), ["wineboot", "--init"], env);
    run(join(dir, "bin", "wineserver"), ["-w"], env);
  }
  return { dir, env };
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}
