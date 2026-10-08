import { describe, expect, it } from "vitest";
import { FEED, listedDownloads, verifiedDownloads } from "../src/downloads.ts";

const RELEASES = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases";
const NAMES = {
  dmg: "mac-arm64.dmg",
  exe: "win-x64-setup.exe",
  appImage: "linux-x86_64.AppImage",
  deb: "linux-amd64.deb",
};
const names = (version: string) =>
  Object.values(NAMES).map((ending) => `Mr-Streamer-${version}-${ending}`);

/** A feed as the release workflow publishes it, naming `version` as the stable release. */
const feed = (version: string, stable: Record<string, unknown> = {}) => ({
  schema: 1,
  generated: "2026-10-06T06:57:32.055Z",
  stable: {
    version,
    published: "2026-10-06T06:57:11Z",
    page: `${RELEASES}/tag/v${version}`,
    files: `${RELEASES}/download/v${version}`,
    notes: "",
    platforms: ["latest-mac.yml", "latest.yml", "latest-linux.yml"],
    installers: names(version),
    ...stable,
  },
  nightly: null,
});

describe("the installers the open page takes from the feed", () => {
  it("are the stable release's, as the feed lists them", () => {
    expect(listedDownloads(feed("0.0.8"))).toEqual({
      version: "0.0.8",
      installers: ["dmg", "exe", "appImage", "deb"],
    });
  });

  it("leave out one the release doesn't list, and any file the page has no link for", () => {
    const installers = [
      "Mr-Streamer-0.0.8-mac-arm64.dmg",
      "Mr-Streamer-0.0.8-linux-x86_64.AppImage",
      // Another release's file, a renamed one, and one the page never linked.
      "Mr-Streamer-0.0.7-linux-amd64.deb",
      "Mr-Streamer-0.0.8-win-arm64-setup.exe",
      "Mr-Streamer-0.0.8-mac-x64.dmg",
    ];

    expect(listedDownloads(feed("0.0.8", { installers }))).toEqual({
      version: "0.0.8",
      installers: ["dmg", "appImage"],
    });
    expect(listedDownloads(feed("0.0.8", { installers: [] }))?.installers).toEqual([]);
  });

  it("are left as the build wrote them by a feed from before it listed installers", () => {
    expect(listedDownloads(feed("0.0.7", { installers: undefined }))).toBeNull();
  });

  it.each<[string, unknown]>([
    ["a nightly named as stable", feed("0.0.8-nightly.20261007.190")],
    ["a version that is a path", feed("../../../evil/releases/download/v1.0.0")],
    [
      "files on another host",
      feed("0.0.8", { files: "https://example.com/releases/download/v0.0.8" }),
    ],
    [
      "files of another repository",
      feed("0.0.8", { files: "https://github.com/someone/else/releases/download/v0.0.8" }),
    ],
    ["files of another release", feed("0.0.8", { files: `${RELEASES}/download/v0.0.7` })],
    ["no stable release", { ...feed("0.0.8"), stable: null }],
    ["another schema", { ...feed("0.0.8"), schema: 2 }],
    ["something that is no feed", "<!doctype html>"],
    ["nothing", null],
  ])("are left as the build wrote them by %s", (_, json) => {
    expect(listedDownloads(json)).toBeNull();
  });
});

describe("the installers the build writes", () => {
  /**
   * GitHub and the feed's site, answering `updates` for the feed and redirecting to the
   * installers in `present`. Records every request as "METHOD address".
   */
  function web(updates: unknown, present: readonly string[] = []) {
    const asked: string[] = [];
    const request: typeof fetch = async (input, init) => {
      const address = String(input);
      asked.push(`${init?.method ?? "GET"} ${address}`);
      if (address.split("?")[0] === FEED) {
        if (updates instanceof Error) throw updates;
        return typeof updates === "number"
          ? new Response(null, { status: updates })
          : Response.json(updates);
      }
      const found = present.some((name) => address.endsWith(`/${name}`));
      return new Response(null, { status: found ? 302 : 404 });
    };
    return { asked, request };
  }

  it("are the stable release's that GitHub answers for, each asked for by its own address", async () => {
    // The feed lists none: the build asks GitHub, whatever the feed says.
    const { asked, request } = web(feed("0.0.7", { installers: undefined }), names("0.0.7"));

    expect(await verifiedDownloads(request)).toEqual({
      version: "0.0.7",
      installers: ["dmg", "exe", "appImage", "deb"],
    });
    expect(asked[0]).toBe(`GET ${FEED}`);
    expect(asked.slice(1)).toEqual([
      `HEAD ${RELEASES}/download/v0.0.7/Mr-Streamer-0.0.7-mac-arm64.dmg`,
      `HEAD ${RELEASES}/download/v0.0.7/Mr-Streamer-0.0.7-win-x64-setup.exe`,
      `HEAD ${RELEASES}/download/v0.0.7/Mr-Streamer-0.0.7-linux-x86_64.AppImage`,
      `HEAD ${RELEASES}/download/v0.0.7/Mr-Streamer-0.0.7-linux-amd64.deb`,
    ]);
  });

  it("follow the feed to a newer release, and leave out an installer GitHub has none of", async () => {
    const present = names("0.0.8").filter((name) => !name.endsWith(".deb"));
    // The feed lists the .deb, and GitHub answers 404 for it.
    const { request } = web(feed("0.0.8"), present);

    expect(await verifiedDownloads(request)).toEqual({
      version: "0.0.8",
      installers: ["dmg", "exe", "appImage"],
    });
  });

  it("uses fresh release history instead of a cached older feed, while checking actual files", async () => {
    const { asked, request } = web(
      feed("0.0.7"),
      names("0.0.8").filter((name) => !name.endsWith(".deb")),
    );
    const published = "2026-10-07T18:00:00Z";
    expect(await verifiedDownloads(request, { version: "0.0.8", published })).toEqual({
      version: "0.0.8",
      installers: ["dmg", "exe", "appImage"],
    });
    expect(asked).toHaveLength(4);
    expect(asked.every((request) => request.startsWith(`HEAD ${RELEASES}/download/v0.0.8/`))).toBe(
      true,
    );
  });

  it("leave out an installer that couldn't be asked for", async () => {
    const { request } = web(feed("0.0.8"), names("0.0.8"));
    const offline: typeof fetch = (input, init) =>
      String(input).endsWith(".dmg") ? Promise.reject(new Error("offline")) : request(input, init);

    expect((await verifiedDownloads(offline))?.installers).toEqual(["exe", "appImage", "deb"]);
  });

  it("offers no installers when complete history says every stable release was withdrawn", async () => {
    const { asked, request } = web(feed("0.0.8"), names("0.0.8"));
    expect(await verifiedDownloads(request, null)).toBeNull();
    expect(asked).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["is unreachable", new Error("offline")],
    ["answers an error", 503],
    ["names no stable release", { ...feed("0.0.8"), stable: null }],
    ["names a nightly as stable", feed("0.0.8-nightly.20261007.190")],
    ["names files elsewhere", feed("0.0.8", { files: "https://example.com/v0.0.8" })],
  ])("are none, and nothing else is asked for, when the feed %s", async (_, updates) => {
    const { asked, request } = web(updates, names("0.0.8"));

    expect(await verifiedDownloads(request)).toBeNull();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.split("?")[0]).toBe(`GET ${FEED}`);
  });
});
