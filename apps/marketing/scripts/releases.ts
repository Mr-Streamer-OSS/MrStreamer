import { buildFeed } from "../../../packages/contracts/src/update-feed.ts";

const REPOSITORY = "https://github.com/Mr-Streamer-OSS/MrStreamer";
export const RELEASES = `${REPOSITORY}/releases`;
const API = "https://api.github.com/repos/Mr-Streamer-OSS/MrStreamer/releases";

export interface Release {
  readonly version: string;
  readonly published: string;
  readonly notes: string;
  readonly assets: readonly string[];
}

/** The highest complete stable release. Removing update manifests withdraws it from both owners. */
export function newestStable(releases: readonly Release[]): Release | null {
  const { stable } = buildFeed(
    REPOSITORY,
    releases.map((release) => ({
      tag: `v${release.version}`,
      draft: false,
      prerelease: false,
      publishedAt: release.published,
      page: `${RELEASES}/tag/v${release.version}`,
      notes: release.notes,
      assets: release.assets,
    })),
    "",
  );
  return releases.find((release) => release.version === stable?.version) ?? null;
}

/** All published stable releases, or null if the complete history could not be read. */
export async function stableReleases(request: typeof fetch = fetch): Promise<Release[] | null> {
  const signal = AbortSignal.timeout(20_000);
  const releases: Release[] = [];
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  try {
    // One deadline for the entire history, including pagination. An incomplete history is never
    // presented as all releases. The page limit also bounds a server that repeats full pages.
    for (let page = 1; page <= 100; page++) {
      const response = await request(`${API}?per_page=100&page=${page}`, {
        signal,
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) return null;
      const rows: unknown = await response.json();
      if (!Array.isArray(rows)) return null;
      for (const row of rows) {
        if (typeof row !== "object" || row === null) return null;
        if (!("draft" in row) || !("prerelease" in row)) return null;
        if (row.draft === true || row.prerelease === true) continue;
        if (row.draft !== false || row.prerelease !== false) return null;
        if (!("tag_name" in row) || typeof row.tag_name !== "string") return null;
        if (!/^v\d+\.\d+\.\d+$/.test(row.tag_name)) continue;
        if (
          !("published_at" in row) ||
          typeof row.published_at !== "string" ||
          !Number.isFinite(Date.parse(row.published_at)) ||
          !("body" in row) ||
          (row.body !== null && typeof row.body !== "string") ||
          !("assets" in row) ||
          !Array.isArray(row.assets)
        )
          return null;
        const assets: string[] = [];
        for (const asset of row.assets) {
          if (
            typeof asset !== "object" ||
            asset === null ||
            !("name" in asset) ||
            typeof asset.name !== "string"
          )
            return null;
          assets.push(asset.name);
        }
        releases.push({
          version: row.tag_name.slice(1),
          published: row.published_at,
          notes: row.body ?? "",
          assets,
        });
      }
      if (rows.length < 100) {
        return releases.sort(
          (left, right) => Date.parse(right.published) - Date.parse(left.published),
        );
      }
    }
  } catch {
    // Offline, rate limited, malformed or past the deadline: the page links to GitHub instead.
  }
  return null;
}
