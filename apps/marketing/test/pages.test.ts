// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_ROUTES, PAGES, renderMarkdown, renderPage, SITE } from "../scripts/pages.ts";
import {
  installers,
  LATEST,
  showDownloads,
  showFeedDownloads,
  writeDownloads,
  type Downloads,
} from "../src/downloads.ts";

const home = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
const released: Downloads = { version: "0.0.8", installers };
const open = (html: string) => {
  // These contracts are the readable static HTML. Do not fetch styles or execute page scripts.
  document.documentElement.innerHTML = html
    .replace(/<link rel="stylesheet"[^>]*>/g, "")
    .replace(/<script type="module"[^>]*><\/script>/g, "");
};
const appData = (): Record<string, unknown> =>
  JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent ?? "{}");
const links = () =>
  Object.fromEntries(
    [...document.querySelectorAll<HTMLAnchorElement>("a[data-installer]")].map((link) => [
      link.dataset["installer"],
      link.getAttribute("href"),
    ]),
  );

describe("public document pages without JavaScript", () => {
  it.each(PAGES.filter((page) => page.address !== "/"))(
    "has its own content and metadata at $address",
    (page) => {
      open(renderPage(page.file, null, null));
      expect(document.title).toBe(page.title);
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        SITE + page.address,
      );
      expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
        page.description,
      );
      expect(document.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe(
        SITE + page.address,
      );
      expect(document.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(
        page.title,
      );
      expect(document.querySelector("main h1")?.textContent?.length).toBeGreaterThan(0);
      expect(document.querySelector('footer a[href="/download"]')).not.toBeNull();
    },
  );

  it("keeps guide links and their fragments on the public site, including links in index summaries", () => {
    open(renderPage("docs/updates/index.html", null, null));
    expect(
      document.querySelector('a[href="/docs/updates#installed-from-the-microsoft-store"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('a[href="/docs/troubleshooting#where-your-data-is"]'),
    ).not.toBeNull();
    expect(document.querySelector('main a[href="https://mrstreamer.app/download"]')).not.toBeNull();
    expect(
      [...document.querySelectorAll(".guide-nav a")].map((link) => link.getAttribute("href")),
    ).toEqual(["/docs/downloads", "/docs/playback"]);
    open(renderPage("docs/index.html", null, null));
    expect(document.querySelectorAll(".guide-list dt a")).toHaveLength(7);
    expect(document.querySelector('a[href="/docs#installed-from-the-microsoft-store"]')).toBeNull();
  });

  it("opens a guide with its short answer and key points, and keeps every section collapsed with its old fragments", () => {
    open(renderPage("docs/playback/index.html", null, null));
    expect(document.querySelector(".opening .answer")?.textContent).toContain(
      "Most channels and files play directly.",
    );
    expect(
      [...document.querySelectorAll(".points li > strong")].map((point) => point.textContent),
    ).toEqual(["Plays directly", "Converted", "On a TV", "Left out"]);
    const sections = [...document.querySelectorAll("details.section")];
    expect(sections.map((section) => section.querySelector("summary h2")?.id)).toEqual([
      "live-channels",
      "movies-and-episodes",
      "recordings",
      "online-subtitles",
      "playing-on-a-tv",
      "known-limits",
      "when-something-wont-play",
    ]);
    expect(sections.some((section) => section.hasAttribute("open"))).toBe(false);
    expect(sections[0]?.querySelector(".dek")?.textContent).toBe(
      "MPEG-TS, HLS and radio. Most play directly.",
    );
    // A renamed heading's old address lands right before its section, not inside the one above.
    expect(document.querySelector("#online-subtitles-from-009")?.nextElementSibling).toBe(
      sections[3],
    );
  });

  it("names each cell's column in a wide table, for phones where its header is hidden", () => {
    open(renderPage("docs/live-tv/index.html", null, null));
    const keys = [...document.querySelectorAll("table")].find((table) =>
      table.querySelector("th")?.textContent?.includes("Key"),
    );
    const enter = [...(keys?.querySelectorAll("tr") ?? [])].find(
      (row) => row.cells[0]?.textContent === "Enter",
    );
    expect([...(enter?.cells ?? [])].map((cell) => cell.dataset["label"])).toEqual([
      "Key",
      "In the guide",
      "While watching",
    ]);
  });

  it("offers the grouped FAQ and its working guide links without JavaScript", () => {
    open(renderPage("faq/index.html", null, null));
    expect([...document.querySelectorAll("main h2")].map((heading) => heading.textContent)).toEqual(
      ["Getting started", "Watching", "Installing and updates", "Price and privacy"],
    );
    expect(document.querySelectorAll(".faq-rows > details[id]")).toHaveLength(15);
    expect(document.querySelector("#download")?.textContent).toContain(
      "Download a movie, an episode or a whole series",
    );
    expect(document.querySelector("#record")?.textContent).toContain("Live TV can't be recorded");
    expect(document.querySelector('main a[href="/docs/downloads"]')).not.toBeNull();
    expect(
      document.querySelector('main a[href="/docs/subscriptions#mapping-mixed-playlists"]'),
    ).not.toBeNull();
    expect(document.querySelector('nav a[href="/faq"][aria-current="page"]')).not.toBeNull();
    expect(document.querySelector('footer a[href="/faq"][aria-current="page"]')).not.toBeNull();
  });

  it("sends non-public documentation to the repository and renders untrusted notes safely", () => {
    open(
      renderMarkdown(
        '[Signing](../maintainers/signing.md#checking-a-build) [Privacy](../privacy.md#deleting-your-data)\n\n<a id="old-heading"></a>\n\n<a id="old_heading"></a>\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert(1)) ![Remote](https://example.com/image.png) <a id="inline" href="https://example.com">x</a>',
        "docs/user/playback.md",
      ),
    );
    expect(
      document.querySelector(
        'a[href="https://github.com/Mr-Streamer-OSS/MrStreamer/blob/main/docs/maintainers/signing.md#checking-a-build"]',
      ),
    ).not.toBeNull();
    expect(document.querySelector('a[href="/privacy#deleting-your-data"]')).not.toBeNull();
    expect(document.querySelector("a#old-heading:empty")).not.toBeNull();
    expect(document.querySelector("a#old_heading:empty")).not.toBeNull();
    expect(document.querySelector("#inline, script, img")).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it.each(["## Fixes", "Fixes\n-----"])(
    "renders sourced notes with %s and a truthful unavailable fallback",
    (heading) => {
      open(
        renderPage("releases/index.html", null, [
          {
            version: "1.2.3",
            published: "2026-02-03T20:00:00Z",
            notes: `${heading}\n\n- A published change\n- [Details](https://github.com/Mr-Streamer-OSS/MrStreamer/pull/1)\n- [This section](#fixes)\n\n\`\`\`sh\n# A shell comment\n\`\`\``,
            assets: [],
          },
        ]),
      );
      expect(document.querySelector("time")?.textContent).toBe("3 February 2026");
      expect(document.querySelector(".section li")?.textContent).toBe("A published change");
      expect(document.querySelector("details.section[open] h2#v1\\.2\\.3")).not.toBeNull();
      expect(document.querySelector('h3[id="v1.2.3-fixes"]')).not.toBeNull();
      expect(document.querySelector('a[href="/releases#v1.2.3-fixes"]')).not.toBeNull();
      open(renderPage("releases/index.html", null, null));
      expect(document.querySelector("main")?.textContent).toContain(
        "Release history is unavailable here.",
      );
      expect(document.querySelector(".section")).toBeNull();
    },
  );
});

describe("Vercel page routes", () => {
  // Vercel takes the first route whose src matches the path as sent, ignoring case unless the
  // route says otherwise, after anchoring each src with `^` and `$` (normalizeRoutes in
  // @vercel/routing-utils). An address no route takes goes on to the packaged files.
  const answer = (path: string) => {
    const route = PAGE_ROUTES.find(({ src, ...route }) =>
      new RegExp(
        `${src.startsWith("^") ? "" : "^"}${src}${src.endsWith("$") ? "" : "$"}`,
        "caseSensitive" in route ? "" : "i",
      ).test(path),
    );
    return route ? ("status" in route ? route.status : route.dest) : "file";
  };

  it("answers each page at its own address, with or without a trailing slash", () => {
    for (const { address, file } of PAGES) {
      expect(answer(address)).toBe(`/${file}`);
      expect(answer(address === "/" ? address : `${address}/`)).toBe(`/${file}`);
    }
  });

  it.each([
    "/DOCS",
    "/Docs/Live-TV",
    "/FAQ/",
    "/index.html",
    "/docs/index.html/",
    "/docs/index%2ehtml",
    "/doc%73",
    "/docs/live-tv%2F",
    "/docs/index.htm%6c",
    "/docs/index.html%2F",
    "/nothing/here",
  ])("answers %s with the 404 page", (path) => {
    expect(answer(path)).toBe(404);
  });

  it.each(["/robots.txt", "/sitemap.xml", "/llms.txt", "/generated/social.png"])(
    "leaves %s to the files",
    (path) => {
      expect(answer(path)).toBe("file");
    },
  );
});

describe("one stable download contract across pages and metadata", () => {
  it("keeps a freshly built release through an older cached feed but accepts a fresh withdrawal", () => {
    const verified = "2026-10-07T18:00:00Z";
    open(
      writeDownloads(
        renderPage("download/index.html", released, null),
        released,
        Date.parse(verified),
      ),
    );
    const before = document.documentElement.innerHTML;
    const feed = (generated: string, version: string) => ({
      schema: 1,
      generated,
      stable: {
        version,
        files: `https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download/v${version}`,
        installers: [`Mr-Streamer-${version}-mac-arm64.dmg`],
      },
    });
    showFeedDownloads(document, feed("2026-10-07T17:59:00Z", "0.0.7"));
    expect(document.documentElement.innerHTML).toBe(before);
    showFeedDownloads(document, feed("2026-10-07T18:01:00Z", "0.0.7"));
    expect(document.title).toBe("Download Mr. Streamer 0.0.7 for Mac, Windows and Linux");
    expect(document.querySelector("[data-release-version]")?.textContent).toBe("Version 0.0.7.");
    expect(links()["exe"]).toBe(LATEST);
    expect(links()["dmg"]).toContain("/v0.0.7/");
    open(writeDownloads(renderPage("download/index.html", null, null), null, Date.parse(verified)));
    showFeedDownloads(document, feed("2026-10-07T17:59:00Z", "0.0.8"));
    expect(document.title).toBe("Download Mr. Streamer for Mac, Windows and Linux");
    expect(Object.values(links()).every((link) => link === LATEST)).toBe(true);
  });

  it.each([{ available: [] }, { available: ["dmg", "exe", "appImage"] }] as const)(
    "repairs failed build-time installer checks from an older feed for the selected release: $available",
    ({ available }) => {
      const found: Downloads = { version: "0.0.8", installers: available };
      open(
        writeDownloads(
          renderPage("download/index.html", found, null),
          found,
          Date.parse("2026-10-07T18:00:00Z"),
        ),
      );
      expect(links()["deb"]).toBe(LATEST);
      showFeedDownloads(document, {
        schema: 1,
        generated: "2026-10-07T11:00:00Z",
        stable: {
          version: "0.0.8",
          files: "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download/v0.0.8",
          installers: [
            "Mr-Streamer-0.0.8-mac-arm64.dmg",
            "Mr-Streamer-0.0.8-win-x64-setup.exe",
            "Mr-Streamer-0.0.8-linux-x86_64.AppImage",
            "Mr-Streamer-0.0.8-linux-amd64.deb",
          ],
        },
      });
      expect(
        Object.values(links()).every(
          (link) => typeof link === "string" && link.includes("/v0.0.8/"),
        ),
      ).toBe(true);
      expect(document.title).toBe("Download Mr. Streamer 0.0.8 for Mac, Windows and Linux");
    },
  );
  it("describes the verified release on the home page and links its installers, checksums, notes and sources on the download page", () => {
    open(writeDownloads(home, released));
    expect(appData()["softwareVersion"]).toBe("0.0.8");
    expect(appData()["alternateName"]).toBe("Mr. Streamer: IPTV Player");
    expect(appData()["screenshot"]).toHaveLength(5);
    expect(appData()["downloadUrl"]).toBe("https://mrstreamer.app/download");
    // Every download action on the home page is a link to /download: no installer, no Store.
    expect(links()).toEqual({});
    expect(document.querySelectorAll('main a[href="/download"]')).toHaveLength(2);
    open(writeDownloads(renderPage("download/index.html", released, null), released));
    const files = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download/v0.0.8";
    expect(links()).toEqual({
      dmg: `${files}/Mr-Streamer-0.0.8-mac-arm64.dmg`,
      exe: `${files}/Mr-Streamer-0.0.8-win-x64-setup.exe`,
      appImage: `${files}/Mr-Streamer-0.0.8-linux-x86_64.AppImage`,
      deb: `${files}/Mr-Streamer-0.0.8-linux-amd64.deb`,
    });
    expect(document.title).toBe("Download Mr. Streamer 0.0.8 for Mac, Windows and Linux");
    expect(document.querySelector('[data-release-link="checksums"]')?.getAttribute("href")).toBe(
      "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.8#assets",
    );
    expect(document.querySelector('[data-release-link="source"]')?.getAttribute("href")).toBe(
      "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.8#assets",
    );
  });

  it("uses a versionless fallback when the feed or every installer is unavailable", () => {
    open(home);
    expect(appData()).not.toHaveProperty("softwareVersion");
    open(renderPage("download/index.html", null, null));
    expect(document.title).toBe("Download Mr. Streamer for Mac, Windows and Linux");
    expect(Object.values(links()).every((link) => link === LATEST)).toBe(true);
    open(writeDownloads(home, { version: "0.0.8", installers: [] }));
    expect(appData()).not.toHaveProperty("softwareVersion");
    const withdrawn: Downloads = { version: "0.0.8", installers: [] };
    open(writeDownloads(renderPage("download/index.html", withdrawn, null), withdrawn));
    expect(document.querySelector("[data-release-version]")?.textContent).toBe(
      "Stable release on GitHub.",
    );
  });

  it("moves the version, metadata and auxiliary links with the installers after a release or withdrawal", () => {
    for (const later of [
      { version: "0.0.9", installers },
      { version: "0.0.7", installers: ["dmg"] as const },
      { version: "0.0.9", installers: [] },
    ]) {
      open(writeDownloads(renderPage("download/index.html", released, null), released));
      showDownloads(document, later);
      const refreshed = document.documentElement.innerHTML;
      open(writeDownloads(renderPage("download/index.html", later, null), later));
      expect(document.documentElement.innerHTML).toBe(refreshed);
    }
  });
});
