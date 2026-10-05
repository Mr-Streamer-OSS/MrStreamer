// The Microsoft Store's version of a release: the four-part package version the Store reads, which
// electron-builder can't work out from a release version.
//
// The Store takes 0 to 65535 in each part, never 0 in the first, and keeps the fourth for itself, so
// it must be 0. Only stable releases go to the Store, with 1 added to the major version: 0.0.4 is
// 1.0.4.0. The 1 stays added for good, because the Store only moves a package up: without it, 1.0.0
// would be 1.0.0.0 and sort below 0.0.9's 1.0.9.0.
//
// A nightly makes a test package for sideloading, numbered between the stable release before it and
// the one it previews: 0.0.4-nightly.20261002.14 is 1.0.3.14, the run in the fourth part. The Store
// refuses a fourth part that isn't 0, so a test package can't be submitted by mistake.
//
// The app itself, in Settings, keeps reporting the release version.
//
// The Store scripts run this with plain node before installing packages, so it imports only
// ./version.ts, by relative path.
import { parseVersion } from "./version.ts";

/** Each part of a Windows package version is a 16-bit number. */
const PART_MAX = 65535;

/** The package version for a release version, such as 1.0.4.0 for 0.0.4. Throws when it has none. */
export function packageVersion(release: string): string {
  const version = parseVersion(release);
  if (!version) throw new Error(`${release} is not a release version.`);
  const { major, minor, patch, nightly } = version;
  if (nightly && patch === 0) {
    throw new Error(`${release} previews a .0 release, so no test package sorts before it.`);
  }
  const parts = nightly ? [major + 1, minor, patch - 1, nightly.run] : [major + 1, minor, patch, 0];
  if (parts.some((part) => part > PART_MAX)) {
    throw new Error(`${release} makes ${parts.join(".")}, past the Store's ${PART_MAX} per part.`);
  }
  return parts.join(".");
}

/**
 * Orders two package versions the way Windows and the Store do, part by part: negative when `a`
 * is older than `b`, positive when newer. Throws for anything but four numbers.
 */
export function comparePackageVersions(a: string, b: string): number {
  const [left, right] = [a, b].map((version) => {
    const parts = /^\d+\.\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : [];
    if (parts.length !== 4 || parts.some((part) => part > PART_MAX)) {
      throw new Error(`"${version}" is not a package version such as 1.0.4.0.`);
    }
    return parts;
  });
  for (let part = 0; part < 4; part++) {
    const difference = (left?.[part] ?? 0) - (right?.[part] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
