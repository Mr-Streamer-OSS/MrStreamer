// Release versions and their order. Stable releases are "0.2.0"; nightly builds are
// "0.3.0-nightly.20261002.14": the stable version they lead up to, the build date and the unique
// workflow run. A nightly sorts after the stable before it and before the stable it leads up to,
// so both the release workflow and the updater can compare any two builds.

export type Channel = "stable" | "nightly";

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Set for nightly builds. */
  readonly nightly: { readonly date: number; readonly run: number } | null;
}

const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d{8})\.(\d+))?$/;

/** Reads "0.2.0" or "0.3.0-nightly.20261002.14", with or without a leading "v". Null otherwise. */
export function parseVersion(text: string): Version | null {
  const match = PATTERN.exec(text.replace(/^v/, ""));
  if (!match) return null;
  const [, major, minor, patch, date, run] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    nightly: date && run ? { date: Number(date), run: Number(run) } : null,
  };
}

export function formatVersion(version: Version): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.nightly ? `${base}-nightly.${version.nightly.date}.${version.nightly.run}` : base;
}

export function channelOf(version: Version): Channel {
  return version.nightly ? "nightly" : "stable";
}

/** Negative when `a` is older than `b`, positive when newer, 0 when the same build. */
export function compareVersions(a: Version, b: Version): number {
  const base = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (base !== 0) return base;
  if (!a.nightly || !b.nightly) return (a.nightly ? -1 : 0) - (b.nightly ? -1 : 0);
  return a.nightly.date - b.nightly.date || a.nightly.run - b.nightly.run;
}
