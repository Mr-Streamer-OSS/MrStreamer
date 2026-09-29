// Picks the release an update installs from the published releases.
//
// A release counts only when its version and its GitHub pre-release flag name the same channel
// and it carries this platform's update metadata. Stable takes the highest stable release;
// Nightly the highest of all. Highest by version order, never by date, so a build published late
// cannot replace a newer one. Drafts are invisible to the app.
import {
  channelOf,
  compareVersions,
  parseVersion,
  type Channel,
  type Version,
} from "../../shared/version.ts";

export interface PublishedRelease {
  readonly tag: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
  readonly assets: readonly { readonly name: string; readonly url: string }[];
}

export interface Candidate {
  readonly version: Version;
  /** The folder holding the release's files, for electron-updater's generic provider. */
  readonly feedUrl: string;
}

/** Releases this platform can update to, newest first. */
export function candidates(
  releases: readonly PublishedRelease[],
  metadataFile: string,
): Candidate[] {
  return releases
    .flatMap((release) => {
      const version = parseVersion(release.tag);
      if (!version || release.draft) return [];
      if ((channelOf(version) === "nightly") !== release.prerelease) return [];
      const metadata = release.assets.find((asset) => asset.name === metadataFile);
      if (!metadata) return [];
      return [{ version, feedUrl: metadata.url.slice(0, metadata.url.lastIndexOf("/")) }];
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The newest release a channel receives, whether or not it is newer than the installed one. */
export function newestOn(channel: Channel, available: readonly Candidate[]): Candidate | null {
  return available.find((candidate) => channel === "nightly" || !candidate.version.nightly) ?? null;
}

/** The update metadata file electron-builder writes for this platform. */
export function metadataFileFor(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "win32") return "latest.yml";
  return "latest-linux.yml";
}

/** Reads published releases from a GitHub-compatible API: GitHub itself, or a test feed. */
export async function fetchReleases(
  api: string,
  repository: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedRelease[]> {
  const response = await fetchImpl(`${api}/repos/${repository}/releases?per_page=100`, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`The release list answered HTTP ${response.status}.`);
  const body = (await response.json()) as {
    tag_name: string;
    prerelease: boolean;
    draft: boolean;
    assets: { name: string; browser_download_url: string }[];
  }[];
  return body.map((release) => ({
    tag: release.tag_name,
    prerelease: release.prerelease,
    draft: release.draft,
    assets: release.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
  }));
}
