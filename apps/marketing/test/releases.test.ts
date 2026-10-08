import { describe, expect, it, vi } from "vitest";
import { newestStable, stableReleases } from "../scripts/releases.ts";

const platforms = ["latest-mac.yml", "latest.yml", "latest-linux.yml"];

const row = (version: string, published: string, extra = {}) => ({
  tag_name: `v${version}`,
  published_at: published,
  body: "- Published notes",
  draft: false,
  prerelease: false,
  assets: platforms.map((name) => ({ name })),
  ...extra,
});

describe("stable GitHub release history", () => {
  it("keeps withdrawn releases in history but stops offering their retained installers", async () => {
    const history = await stableReleases(
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json([
          row("0.0.8", "2026-10-07T18:00:00Z", {
            assets: [{ name: "Mr-Streamer-0.0.8-mac-arm64.dmg" }],
          }),
          row("0.0.7", "2026-10-06T18:00:00Z"),
        ]),
      ),
    );
    expect(history?.map((release) => release.version)).toEqual(["0.0.8", "0.0.7"]);
    expect(newestStable(history ?? [])?.version).toBe("0.0.7");
    expect(newestStable(history?.slice(0, 1) ?? [])).toBeNull();
  });
  it("selects the highest stable version even when an older version was published later", async () => {
    const history = await stableReleases(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json([
            row("1.9.0", "2026-10-07T18:00:00Z"),
            row("1.10.0", "2026-10-06T18:00:00Z"),
            row("1.2.10", "2026-10-05T18:00:00Z"),
          ]),
        ),
    );
    expect(history?.[0]?.version).toBe("1.9.0");
    expect(newestStable(history ?? [])?.version).toBe("1.10.0");
    expect(newestStable([])).toBeNull();
  });
  it("reads subsequent pages, excludes nightlies/drafts and orders by the actual publication date", async () => {
    const first = [
      row("1.0.0", "2026-01-01T00:00:00Z"),
      ...Array.from({ length: 99 }, () =>
        row("1.0.1-nightly.1", "2026-01-02T00:00:00Z", { prerelease: true }),
      ),
    ];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(first))
      .mockResolvedValueOnce(
        Response.json([
          row("1.0.1", "2026-01-03T00:00:00Z"),
          row("1.0.2", "2026-01-04T00:00:00Z", { draft: true }),
          row("1.0.3-nightly.1", "2026-01-05T00:00:00Z"),
        ]),
      );
    expect(await stableReleases(request)).toEqual([
      {
        version: "1.0.1",
        published: "2026-01-03T00:00:00Z",
        notes: "- Published notes",
        assets: platforms,
      },
      {
        version: "1.0.0",
        published: "2026-01-01T00:00:00Z",
        notes: "- Published notes",
        assets: platforms,
      },
    ]);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/Mr-Streamer-OSS/MrStreamer/releases?per_page=100&page=1",
      "https://api.github.com/repos/Mr-Streamer-OSS/MrStreamer/releases?per_page=100&page=2",
    ]);
  });

  it("discards partial history when a later page fails, rather than claiming it is complete", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(Array.from({ length: 100 }, () => row("1.0.0", "2026-01-01T00:00:00Z"))),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect(await stableReleases(request)).toBeNull();
  });

  it("falls back on network and invalid-data failures", async () => {
    expect(
      await stableReleases(vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"))),
    ).toBeNull();
    expect(
      await stableReleases(
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({ message: "rate limited" })),
      ),
    ).toBeNull();
    expect(
      await stableReleases(
        vi.fn<typeof fetch>().mockResolvedValue(Response.json([row("1.0.0", "not a date")])),
      ),
    ).toBeNull();
  });

  it("uses an available workflow token only in the GitHub API request, with redirects refused", async () => {
    vi.stubEnv("GH_TOKEN", "test-workflow-token");
    try {
      const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
      await stableReleases(request);
      expect(request.mock.calls[0]?.[1]).toMatchObject({
        redirect: "error",
        headers: { Authorization: "Bearer test-workflow-token" },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
