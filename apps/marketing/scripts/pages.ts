import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Marked, type MarkedToken } from "marked";
import type { Downloads } from "../src/downloads.ts";
import { PACKAGE_ROUTES, type PackageName, type PackageRoutes } from "../src/packages.ts";
import { RELEASES, type Release } from "./releases.ts";

export const SITE = "https://mrstreamer.app";
const REPOSITORY = "https://github.com/Mr-Streamer-OSS/MrStreamer";
const root = join(import.meta.dirname, "..");
const repository = resolve(root, "../..");

/** The guides in reading order. `summary` is the guides index's line; `description` is metadata. */
export const GUIDES = [
  {
    slug: "subscriptions",
    title: "Subscriptions",
    description:
      "Connect and manage Xtream Codes subscriptions and M3U playlists, programme guides and channel mappings in Mr. Streamer.",
    summary: "Xtream Codes logins and M3U playlists, programme guides and channel mappings.",
  },
  {
    slug: "live-tv",
    title: "Live TV",
    description:
      "Watch live TV in Mr. Streamer, use the programme guide, search channels and control playback with the keyboard.",
    summary: "The programme guide, your own lists, search, reminders and keyboard control.",
  },
  {
    slug: "movies-and-series",
    title: "Movies and series",
    description:
      "Find movies and series, use the watchlist and continue episodes from your Xtream Codes subscriptions in Mr. Streamer.",
    summary: "Find titles, keep a watchlist and continue episodes.",
  },
  {
    slug: "downloads",
    title: "Downloads",
    description:
      "Download movies and episodes in Mr. Streamer, manage the queue and watch saved copies offline.",
    summary: "Save movies and episodes, manage the queue, watch offline.",
  },
  {
    slug: "updates",
    title: "Updates and channels",
    description:
      "Update Mr. Streamer, choose Stable or Nightly, and understand how Microsoft Store updates work.",
    summary: "Stable or Nightly, Homebrew and the AUR, and how Microsoft Store updates work.",
  },
  {
    slug: "playback",
    title: "What plays",
    description:
      "The streams, formats, sound and subtitles Mr. Streamer plays, playing on a TV, and known playback limits.",
    summary: "Formats, sound and subtitles, playing on a TV, known limits.",
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    description:
      "Fix login, programme guide, playback and update problems in Mr. Streamer, and find your local data.",
    summary: "Login, guide, playback and update problems, and where your data lives.",
  },
] as const;

type GuideSlug = (typeof GUIDES)[number]["slug"];

/** The guides index's most asked tasks, each a section of a guide. The build checks the fragments. */
const TASKS: readonly (readonly [task: string, guide: GuideSlug, fragment: string])[] = [
  ["Add an Xtream Codes login", "subscriptions", "adding-one"],
  ["Add an M3U playlist", "subscriptions", "adding-one"],
  ["Add an XMLTV guide", "subscriptions", "guides-from-other-addresses"],
  ["Play a programme from its start", "live-tv", "the-guide"],
  ["Watch on a TV", "playback", "playing-on-a-tv"],
  ["Download a whole series", "downloads", "downloading"],
  ["A channel won't play", "playback", "when-something-wont-play"],
  ["Login not accepted", "troubleshooting", "channels-or-login-stop-working"],
  ["Switch to Nightly", "updates", "stable-and-nightly"],
];

interface Page {
  readonly address: string;
  readonly file: string;
  readonly title: string;
  readonly description: string;
  readonly markdown?: string;
}

/** One address list for Vite, Vercel, metadata and the sitemap checks. */
export const PAGES: readonly Page[] = [
  {
    address: "/",
    file: "index.html",
    title: "Mr. Streamer: free IPTV player for Mac, Windows and Linux",
    description: "Free, open source IPTV player for Mac, Windows and Linux.",
  },
  {
    address: "/faq",
    file: "faq/index.html",
    title: "Mr. Streamer: questions",
    description:
      "Answers about channels, M3U playlists, downloads, supported systems, updates and privacy in Mr. Streamer.",
  },
  {
    address: "/privacy",
    file: "privacy/index.html",
    title: "Mr. Streamer: privacy policy",
    description:
      "What Mr. Streamer stores on your computer, what it sends, and how the website uses analytics.",
    markdown: "docs/privacy.md",
  },
  {
    address: "/docs",
    file: "docs/index.html",
    title: "Mr. Streamer guides",
    description:
      "Set up Mr. Streamer, watch live TV, movies and series, manage updates and fix common problems.",
  },
  ...GUIDES.map((guide) => ({
    address: `/docs/${guide.slug}`,
    file: `docs/${guide.slug}/index.html`,
    title: `${guide.title} | Mr. Streamer guides`,
    description: guide.description,
    markdown: `docs/user/${guide.slug}.md`,
  })),
  {
    address: "/about",
    file: "about/index.html",
    title: "About Mr. Streamer: free IPTV player for Mac, Windows and Linux",
    description: "What Mr. Streamer plays, supported systems, its limits, licence and source code.",
    markdown: "docs/about.md",
  },
  {
    address: "/security",
    file: "security/index.html",
    title: "Mr. Streamer: security",
    description:
      "How Mr. Streamer stores logins, how to report security problems, installer signing and checking downloads.",
    markdown: "docs/security.md",
  },
  {
    address: "/download",
    file: "download/index.html",
    title: "Download Mr. Streamer for Mac, Windows and Linux",
    description:
      "Download Mr. Streamer's stable installers for macOS, Windows and Linux, with requirements, checksums and source code.",
  },
  {
    address: "/releases",
    file: "releases/index.html",
    title: "Mr. Streamer releases",
    description:
      "Stable Mr. Streamer releases, newest first, with release dates and the complete release notes.",
  },
];

/** Vercel's answer for an unknown address: the 404 page, with status 404. */
export const MISSING = { status: 404, dest: "/404.html" } as const;

/**
 * Vercel's routes for the pages, ahead of its filesystem: each page at its address, in its exact
 * case (Vercel ignores case unless told) and with or without a trailing slash, then the 404 page for
 * HTML aliases, addresses without a file extension and percent-encoded addresses. Vercel matches
 * the path as sent, but its filesystem decodes it and answers a folder with its index.html, so
 * `/doc%73`, `/docs/index.htm%6c` or `/docs/index.html/` would otherwise show a page at an
 * address that isn't its own. Vercel anchors each src with `^` and `$`, so every src matches the
 * whole path.
 */
export const PAGE_ROUTES = [
  ...PAGES.map(({ address, file }) => ({
    src: address === "/" ? "^/$" : `^${address}/?$`,
    dest: `/${file}`,
    caseSensitive: true,
  })),
  { src: "^/.*\\.html/?$", ...MISSING },
  { src: "^/[^.]*$", ...MISSING },
  { src: "^/.*%.*$", ...MISSING },
];

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

/** Home's platform lanes name a route in the fewest words: its link, then what it is for. */
const LANE: Readonly<Record<PackageName, readonly [link: string, after: string]>> = {
  homebrew: ["Homebrew tap", ""],
  aur: ["AUR", " for Arch"],
};

/** Writes only independently verified package routes, never inferred from the release feed. */
export function writePackages(html: string, routes: PackageRoutes = PACKAGE_ROUTES): string {
  return html.replaceAll(
    /<!-- package:(homebrew|aur):(link|command|details|availability|lane) -->/g,
    (_mark, name: PackageName, part: "link" | "command" | "details" | "availability" | "lane") => {
      const route = routes[name];
      if (
        route.publication.state !== "published" ||
        !/^\d+\.\d+\.\d+$/.test(route.publication.lastVerifiedVersion)
      )
        return "";
      const anchor = (words: string) =>
        `<a data-package="${name}" href="${escapeHtml(route.url)}">${escapeHtml(words)}</a>`;
      if (part === "lane") return ` <span>·</span> ${anchor(LANE[name][0])}${LANE[name][1]}`;
      if (part === "command")
        return `<p class="command"><span>or</span> <code>${escapeHtml(route.install)}</code></p>`;
      const link = anchor(`${route.name} · ${route.platform}, ${route.architecture}`);
      if (part === "availability") return `<span>Also on ${link}.</span>`;
      if (part === "link") return link;
      return `<div class="package-route">${link}<small>${escapeHtml(route.updates)} Package ${escapeHtml(route.publication.lastVerifiedVersion)}.</small><pre><code>${escapeHtml(route.install)}</code></pre></div>`;
    },
  );
}

/** Relative documentation links keep their public address and section, or go to GitHub. */
function linkTo(href: string, source: string): string | null {
  if (href.startsWith("#")) {
    const page = PAGES.find((page) => page.markdown === source);
    return page ? page.address + href : `${REPOSITORY}/blob/main/${source}${href}`;
  }
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^(\/\/|[a-z][\w+.-]*:)/i.test(href)) return null;
  const [path = "", fragment] = href.split("#", 2);
  const suffix = fragment === undefined ? "" : `#${fragment}`;
  if (path.startsWith("/")) return PAGES.some((page) => page.address === path) ? href : null;
  const target = relative(repository, resolve(repository, dirname(source), path));
  const page = PAGES.find((page) => page.markdown === target);
  if (page) return page.address + suffix;
  if (target.startsWith("..")) return null;
  // Contributing and maintainer documents are not public website routes.
  return `${REPOSITORY}/blob/main/${target}${suffix}`;
}

/** A paragraph that is only an empty anchor: a renamed heading's old fragment. */
const LEGACY_ANCHOR = /^<a id="([a-z0-9_-]+)"><\/a>$/;

/**
 * A Markdown renderer without embedded HTML, unsafe URLs or third-party image requests. The one
 * HTML kept is an empty anchor alone in a paragraph, which holds a renamed heading's old fragment.
 * One renderer numbers repeated headings across everything it renders, so render a document's
 * parts with the same one, in order.
 */
function markdownFor(source: string, headingOffset = 0, anchorPrefix = ""): Marked {
  const headings = new Map<string, number>();
  return new Marked({
    renderer: {
      heading({ text, tokens, depth }) {
        const slug = text
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-");
        const count = headings.get(slug) ?? 0;
        headings.set(slug, count + 1);
        const id = anchorPrefix + (count === 0 ? slug : `${slug}-${count}`);
        const level = Math.min(depth + headingOffset, 6);
        // styles.css sizes a page title so its longest word fits the width.
        const longest = Math.max(...text.split(/\s+/).map((word) => word.length));
        const fit = level === 1 ? ` style="--longest: ${longest}"` : "";
        return `<h${level} id="${id}"${fit}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      link({ href, title, tokens }) {
        const target =
          anchorPrefix && href.startsWith("#")
            ? `/releases#${anchorPrefix}${href.slice(1)}`
            : linkTo(href, source);
        const text = this.parser.parseInline(tokens);
        return target
          ? `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${text}</a>`
          : text;
      },
      image({ href, text }) {
        const target = linkTo(href, source);
        return target
          ? `<a href="${escapeHtml(target)}">${escapeHtml(text || "Image")}</a>`
          : escapeHtml(text);
      },
      paragraph({ text }) {
        const legacy = LEGACY_ANCHOR.exec(text.trim())?.[1];
        return legacy ? `<a id="${anchorPrefix}${legacy}"></a>\n` : false;
      },
      html({ text }) {
        return escapeHtml(text);
      },
      // A table of three or more columns stacks on phones (styles.css), so each cell carries its
      // column's name to show above it there.
      table({ header, rows }) {
        if (header.length < 3) return false;
        const cells = (row: typeof header, tag: "th" | "td") =>
          row
            .map((cell, column) => {
              const label =
                tag === "td" ? ` data-label="${escapeHtml(header[column]?.text ?? "")}"` : "";
              return `<${tag}${label}>${this.parser.parseInline(cell.tokens)}</${tag}>`;
            })
            .join("");
        const body = rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("\n");
        return `<table>\n<thead>\n<tr>${cells(header, "th")}</tr>\n</thead>\n<tbody>\n${body}\n</tbody>\n</table>\n`;
      },
    },
  });
}

/** Renders a whole Markdown text in reading order, as release notes are. */
export function renderMarkdown(
  text: string,
  source: string,
  headingOffset = 0,
  anchorPrefix = "",
): string {
  return markdownFor(source, headingOffset, anchorPrefix).parse(text, { async: false });
}

/** One collapsed part of a page: its heading, a line that answers it, and the rest. */
interface Section {
  readonly anchors?: string;
  readonly heading: string;
  readonly dek?: string | undefined;
  readonly body: string;
  readonly open?: boolean;
}

/** The answer-first opening every document page shares, before its sections. */
interface Opening {
  readonly eyebrow?: string | undefined;
  readonly title: string;
  readonly answer?: string | undefined;
  readonly after?: string | undefined;
}

function opening({ eyebrow, title, answer, after = "" }: Opening): string {
  return `<div class="opening">${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ""}${title}${
    answer ? `<div class="answer">${answer}</div>` : ""
  }${after}</div>`;
}

/**
 * Collapsed sections that open with a click, the keyboard or a link to anything inside them, and
 * without scripts. The heading stays in the summary, so its fragment always shows.
 */
function sections(parts: readonly Section[]): string {
  return `<div class="sections">${parts
    .map(
      ({ anchors = "", heading, dek, body, open }) =>
        `${anchors}<details class="section"${open ? " open" : ""}><summary>${heading}${
          dek ? `<span class="dek">${dek}</span>` : ""
        }</summary><div class="body">${body}</div></details>`,
    )
    .join("")}</div>`;
}

/**
 * A Markdown document, answer first. The source keeps an order that reads on GitHub too:
 * - The first paragraph under the title is the short answer.
 * - A list right after it whose every item opens in bold is the key points, side by side.
 * - Anything else before the first `##` follows them.
 * - Each `##` is a collapsed section. An italic paragraph right under its heading is the line
 *   beside the heading that answers it. A section with one table puts the table beside the text.
 */
function renderDocument(text: string, source: string, eyebrow?: string, after?: string): string {
  const markdown = markdownFor(source);
  const render = (tokens: MarkedToken[]) => markdown.parser(tokens);
  // marked types its tokens with an open-ended member; every token its lexer makes is a MarkedToken.
  const tokens = (markdown.lexer(text) as MarkedToken[]).filter((token) => token.type !== "space");
  const isSection = (token: MarkedToken | undefined) =>
    token?.type === "heading" && token.depth === 2;
  const isAnchor = (token: MarkedToken | undefined) =>
    token?.type === "paragraph" && LEGACY_ANCHOR.test(token.text.trim());
  // A section starts at its heading, or at the first of the old fragments' anchors right above it.
  const anchorsThenSection = (index: number): boolean =>
    isSection(tokens[index]) || (isAnchor(tokens[index]) && anchorsThenSection(index + 1));
  const starts = (index: number) => !isAnchor(tokens[index - 1]) && anchorsThenSection(index);

  const [title] = tokens;
  if (title?.type !== "heading" || title.depth !== 1)
    throw new Error(`${source} doesn't open with its title.`);
  const groups: MarkedToken[][] = [[]];
  for (const [index, token] of tokens.entries()) {
    if (index === 0) continue;
    if (starts(index)) groups.push([]);
    groups.at(-1)?.push(token);
  }
  const [intro = [], ...parts] = groups;

  const [first, second] = intro;
  const answer = first?.type === "paragraph" ? first : undefined;
  const points =
    answer &&
    second?.type === "list" &&
    second.items.every(
      ({ tokens: [lead] }) => lead?.type === "text" && lead.tokens?.[0]?.type === "strong",
    )
      ? second
      : undefined;
  const others = intro.slice((answer ? 1 : 0) + (points ? 1 : 0));

  return (
    opening({
      eyebrow,
      title: render([title]),
      answer: answer && render([answer]),
      after,
    }) +
    (points
      ? render([points])
          .replace("<ul>", '<ul class="points">')
          .replace(/<li><strong>([\s\S]*?)\.?<\/strong>\s*/g, "<li><strong>$1</strong> ")
      : "") +
    (others.length ? `<div class="intro">${render(others)}</div>` : "") +
    sections(
      parts.map((part) => {
        const at = part.findIndex(isSection);
        const anchors = part.slice(0, at);
        const [heading, lead, ...rest] = part.slice(at);
        const dek =
          lead?.type === "paragraph" && lead.tokens.length === 1 && lead.tokens[0]?.type === "em"
            ? lead
            : undefined;
        const body = dek || !lead ? rest : [lead, ...rest];
        const tables = body.filter((token) => token.type === "table");
        const table =
          tables.length === 1 && body.length > 1 && !body.some(({ type }) => type === "heading")
            ? tables[0]
            : undefined;
        return {
          anchors: render(anchors),
          heading: render(heading ? [heading] : []),
          dek: dek && render([dek]).replace(/^<p><em>([\s\S]*)<\/em><\/p>\s*$/, "$1"),
          body: table
            ? `<div class="split"><div>${render(body.filter((token) => token !== table))}</div>${render([table])}</div>`
            : render(body),
        };
      }),
    )
  );
}

const markdownOf = (file: string) => readFileSync(join(repository, file), "utf8");

function guideIndex(): string {
  const tasks = TASKS.map(([task, slug, fragment]) => {
    const guide = GUIDES.find((guide) => guide.slug === slug);
    return `<li><a href="/docs/${slug}#${fragment}">${escapeHtml(task)}<span>${guide?.title ?? ""}</span></a></li>`;
  }).join("");
  const guides = GUIDES.map(
    (guide) =>
      `<div><dt><a href="/docs/${guide.slug}">${guide.title}</a></dt><dd>${escapeHtml(guide.summary)}</dd></div>`,
  ).join("");
  return (
    opening({
      title: "<h1>Guides</h1>",
      answer: "<p>Pick what you want to do. Each guide opens with the short answer.</p>",
    }) +
    `<section class="tasks" aria-labelledby="most-asked"><h2 class="label" id="most-asked">Most asked</h2><ul>${tasks}</ul></section>` +
    `<section aria-labelledby="every-guide"><h2 class="label" id="every-guide">All seven guides</h2><dl class="guide-list">${guides}</dl></section>`
  );
}

/** The guides before and after this one, wrapping around, so every guide leads on. */
function guideNav(slug: GuideSlug): string {
  const index = GUIDES.findIndex((guide) => guide.slug === slug);
  const previous = GUIDES[(index + GUIDES.length - 1) % GUIDES.length];
  const next = GUIDES[(index + 1) % GUIDES.length];
  if (!previous || !next) return "";
  return `<nav class="guide-nav" aria-label="Other guides"><h2>Other guides</h2><a class="previous" href="/docs/${previous.slug}"><span>Previous guide</span><b><span aria-hidden="true">← </span>${previous.title}</b></a><a class="next" href="/docs/${next.slug}"><span>Next guide</span><b>${next.title}<span aria-hidden="true"> →</span></b></a></nav>`;
}

function releaseHistory(releases: readonly Release[] | null): string {
  const title = "<h1>Releases</h1>";
  if (!releases?.length)
    return opening({
      title,
      answer: `<p>Release history is unavailable here. Read the stable releases and notes on <a href="${RELEASES}">GitHub Releases</a>.</p>`,
    });
  return (
    opening({
      title,
      answer: `<p>Every stable release, newest first. Nightly builds are on <a href="${RELEASES}">GitHub</a>.</p>`,
    }) +
    sections(
      releases.map((release, index) => {
        const date = new Intl.DateTimeFormat("en-GB", {
          dateStyle: "long",
          timeZone: "UTC",
        }).format(new Date(release.published));
        const headings: number[] = [];
        const markdown = new Marked();
        markdown.walkTokens(markdown.lexer(release.notes), (token) => {
          if (token.type === "heading") headings.push(token.depth);
        });
        const offset = 3 - (headings.length ? Math.min(...headings) : 3);
        return {
          heading: `<h2 id="v${release.version}">${release.version}</h2>`,
          dek: `<time datetime="${escapeHtml(release.published)}">${date}</time>`,
          body: `<p><a href="${RELEASES}/tag/v${release.version}">Download and source</a></p>${release.notes ? renderMarkdown(release.notes, "README.md", offset, `v${release.version}-`) : "<p>No release notes were published.</p>"}`,
          open: index === 0,
        };
      }),
    )
  );
}

/** The policy's own website analytics switch, under its heading. analytics.ts brings it to life. */
function withAnalyticsSwitch(policy: string): string {
  const heading = /<h\d id="website-analytics">.*?<\/h\d>\n/;
  if (!heading.test(policy))
    throw new Error("docs/privacy.md lacks its Website analytics heading.");
  return policy.replace(
    heading,
    (found) =>
      `${found}<p class="site-analytics" data-site-analytics="policy"><span data-site-analytics-status>Website analytics are off in this browser.</span></p>\n`,
  );
}

/** About's line naming the stable release, which downloads.ts keeps current. */
const RELEASE_LINE = `<p class="release-line"><span data-release-version>Stable release on GitHub.</span> <a data-release-link="notes" href="${RELEASES}/latest">Release notes</a>.</p>`;

/** Expands the shared document layout before Vite resolves its stylesheet and script. */
export function renderPage(
  file: string,
  downloads: Downloads | null,
  releases: readonly Release[] | null,
): string {
  const page = PAGES.find((page) => page.file === file);
  if (!page || page.address === "/") throw new Error(`No document page for ${file}`);
  const version = downloads?.installers.length ? downloads.version : null;
  const title =
    page.address === "/download" && version
      ? `Download Mr. Streamer ${version} for Mac, Windows and Linux`
      : page.title;
  const guide = GUIDES.find((guide) => page.address === `/docs/${guide.slug}`);
  let content = page.markdown
    ? renderDocument(
        markdownOf(page.markdown),
        page.markdown,
        guide ? '<a href="/docs">Guides</a>' : undefined,
        page.address === "/about" ? RELEASE_LINE : undefined,
      )
    : "";
  if (page.address === "/privacy") content = withAnalyticsSwitch(content);
  if (page.address === "/docs") content = guideIndex();
  if (page.address === "/faq")
    content = writePackages(readFileSync(join(root, "src/faq.html"), "utf8"));
  if (page.address === "/download")
    content = writePackages(readFileSync(join(root, "src/download.html"), "utf8"));
  if (page.address === "/releases") content = releaseHistory(releases);
  // The article names its kind for styles.css: "guide" for every guide, else its address.
  const kind = guide ? "guide" : page.address.slice(1);
  let html = readFileSync(join(root, "src/page.html"), "utf8")
    .replaceAll("<!-- title -->", escapeHtml(title))
    .replaceAll("<!-- description -->", escapeHtml(page.description))
    .replaceAll("<!-- address -->", SITE + page.address)
    .replaceAll("<!-- kind -->", kind)
    .replaceAll(`href="${guide ? "/docs" : page.address}"`, `$& aria-current="page"`)
    .replace("<!-- content -->", () => content + (guide ? guideNav(guide.slug) : ""));
  if (page.address === "/download")
    html = html
      .replace("<title>", "<title data-download-title>")
      .replace('<meta property="og:title"', '<meta property="og:title" data-download-title');
  return html;
}
