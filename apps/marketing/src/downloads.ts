// The home page's download links: where each installer of the current stable release is, and how
// the page shows it. README.md, Downloads, has the whole account.
//
// - index.html is written with every installer link on the Releases page and no version: what
//   the page says when nothing is known.
// - The build asks the update feed for the stable version, asks GitHub whether each installer
//   answers (`verifiedDownloads`), and writes the ones that do into the page (`writeDownloads`).
// - The open page reads the feed once and shows the installers it lists (`listedDownloads`,
//   `showDownloads`), so a release published after the build still reaches the page.
//
// A link is never guessed. Its address is this repository's release folder, a version shaped
// like a stable one and a file name from INSTALLERS, and it is written only after GitHub
// answered for that file or the feed listed it. Nothing else from the feed reaches the page.

const RELEASES = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases";

/** The update feed the release workflow publishes (packages/contracts/src/update-feed.ts). */
export const FEED = "https://mr-streamer-oss.github.io/MrStreamer/updates.json";

/** The newest stable release's page. An installer link goes here while its file is unknown. */
export const LATEST = `${RELEASES}/latest`;

/**
 * The installers the page links, each with how its file name ends after the version, as
 * apps/desktop/electron-builder.yml names it. index.html marks a link with one of these names in
 * data-installer.
 */
const INSTALLERS = {
  dmg: "mac-arm64.dmg",
  exe: "win-x64-setup.exe",
  appImage: "linux-x86_64.AppImage",
  deb: "linux-amd64.deb",
} as const;

type Installer = keyof typeof INSTALLERS;
export const installers = Object.keys(INSTALLERS) as Installer[];

/** A stable release and the installers known to be there. */
export interface Downloads {
  /** Such as 0.0.7. */
  readonly version: string;
  readonly installers: readonly Installer[];
}

const fileOf = (version: string, installer: Installer): string =>
  `Mr-Streamer-${version}-${INSTALLERS[installer]}`;

const urlOf = (version: string, installer: Installer): string =>
  `${RELEASES}/download/v${version}/${fileOf(version, installer)}`;

/**
 * The feed's stable version, or null when the feed is not one, names no stable release, or names
 * one this site won't link: a nightly, or files from anywhere but this repository's release of
 * that version.
 */
function stableOf(feed: unknown): { version: string; listed: unknown } | null {
  if (!isRecord(feed) || feed["schema"] !== 1 || !isRecord(feed["stable"])) return null;
  const { version, files, installers: listed } = feed["stable"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  return files === `${RELEASES}/download/v${version}` ? { version, listed } : null;
}

/**
 * What the open page shows: the feed's stable release and the installers the feed lists for it.
 * null leaves the page as the build wrote it: when the feed can't be trusted, and when it comes
 * from before feeds listed installers.
 */
export function listedDownloads(feed: unknown): Downloads | null {
  const stable = stableOf(feed);
  const listed = stable?.listed;
  if (!stable || !Array.isArray(listed)) return null;
  return {
    version: stable.version,
    installers: installers.filter((installer) =>
      listed.includes(fileOf(stable.version, installer)),
    ),
  };
}

/**
 * What the build writes: the feed's stable release and the installers GitHub answers for, one
 * HEAD request each. null when the feed can't be read, which leaves the page on the Releases
 * page. `request` is fetch, or a test's stand-in.
 */
export async function verifiedDownloads(request: typeof fetch = fetch): Promise<Downloads | null> {
  const feed = await request(FEED, { signal: AbortSignal.timeout(10_000) })
    .then((response): Promise<unknown> | null => (response.ok ? response.json() : null))
    .catch(() => null);
  const stable = stableOf(feed);
  if (!stable) return null;
  // GitHub answers 302 for an installer that exists and 404 for one that doesn't. Other redirects
  // don't count: a renamed repository redirects every address, a missing file's too.
  const answers = await Promise.all(
    installers.map((installer) =>
      request(urlOf(stable.version, installer), {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      }).then(
        ({ ok, status }) => ok || status === 302,
        () => false,
      ),
    ),
  );
  return {
    version: stable.version,
    installers: installers.filter((_, index) => answers[index]),
  };
}

/** Where an installer link goes: its file when the release is known to hold it. */
function hrefOf(downloads: Downloads, installer: string | undefined): string {
  const known = downloads.installers.find((each) => each === installer);
  return known ? urlOf(downloads.version, known) : LATEST;
}

/** What a system's line says about the version, and nothing when its installer isn't linked. */
function versionOf(downloads: Downloads, installer: string | undefined): string {
  return hrefOf(downloads, installer) === LATEST ? "" : `Version ${downloads.version}.`;
}

/**
 * The open page with `downloads` in it: every a[data-installer] goes to its installer, and every
 * [data-version] names the version beside it. An installer the release lacks goes to the
 * Releases page, without a version.
 */
export function showDownloads(page: ParentNode, downloads: Downloads): void {
  for (const link of page.querySelectorAll<HTMLAnchorElement>("a[data-installer]")) {
    link.href = hrefOf(downloads, link.dataset["installer"]);
  }
  for (const line of page.querySelectorAll<HTMLElement>("[data-version]")) {
    line.textContent = versionOf(downloads, line.dataset["version"]);
  }
}

/** The page's HTML with `downloads` in it, as `showDownloads` leaves the open page. */
export function writeDownloads(html: string, downloads: Downloads): string {
  return html
    .replace(/<a\s[^>]*\bdata-installer="(\w+)"[^>]*>/g, (tag, installer: string) =>
      tag.replace(/\shref="[^"]*"/, ` href="${hrefOf(downloads, installer)}"`),
    )
    .replace(
      /(<span\s[^>]*\bdata-version="(\w+)"[^>]*>)[^<]*/g,
      (_, tag: string, installer: string) => tag + versionOf(downloads, installer),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
