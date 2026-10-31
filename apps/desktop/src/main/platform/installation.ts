import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { t } from "@mrstreamer/core/i18n";
import {
  INSTALLATION_MARKER,
  PACMAN_INSTALLATION,
  type Distribution,
} from "@mrstreamer/contracts/updates";

/**
 * The Snap's instance name, as `snap connect` takes it, when this copy runs from a Snap. Snapd
 * mounts the app at $SNAP; a SNAP variable inherited from another snap's terminal, with the app
 * itself outside it, does not count. Synchronous, so the keyring is chosen before `ready`.
 */
export function snapName(env: NodeJS.ProcessEnv, resources: string): string | null {
  const root = env["SNAP"];
  const name = env["SNAP_INSTANCE_NAME"];
  return root && name && resources.startsWith(`${root}/`) ? name : null;
}

/**
 * The keyring a Snap must use. Left to itself, Chromium picks one by desktop and falls back to a
 * fixed key outside GNOME and KDE (on Openbox or Xfce, say). Pinned, it refuses instead: KWallet
 * on KDE, the Secret Service, as GNOME Keyring offers it, everywhere else.
 */
export function snapPasswordStore(env: NodeJS.ProcessEnv): string {
  const desktops = (env["XDG_CURRENT_DESKTOP"] ?? "").split(":");
  if (!desktops.includes("KDE")) return "gnome-libsecret";
  const version = env["KDE_SESSION_VERSION"];
  return version === "5" || version === "6" ? `kwallet${version}` : "kwallet";
}

/** Resolves installation-owned metadata before Analytics or an updater is constructed. */
export async function installedDistribution(options: {
  readonly platform: string;
  readonly packaged: boolean;
  readonly store: boolean;
  readonly snap: boolean;
  readonly resources: string;
}): Promise<Distribution> {
  if (options.store) return "store";
  if (options.snap) return "snap";
  if (options.platform !== "linux" || !options.packaged) return "direct";
  const path = join(options.resources, INSTALLATION_MARKER);
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "direct";
    throw new Error(
      t("Cannot inspect {path}. Reinstall Mr. Streamer with your package manager.", { path }),
      {
        cause: error,
      },
    );
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      t("Cannot read {path}. Reinstall Mr. Streamer with your package manager.", { path }),
      {
        cause: error,
      },
    );
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      "schema" in value &&
      value.schema === PACMAN_INSTALLATION.schema &&
      "updates" in value &&
      value.updates === PACMAN_INSTALLATION.updates
    )
      return "pacman";
  } catch {
    // A present marker is authoritative; damage must never enable direct updating.
  }
  throw new Error(t("Invalid {path}. Reinstall Mr. Streamer with your package manager.", { path }));
}
