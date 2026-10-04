// Captures the four windows the marketing site is made from, as docs/assets/marketing-*.png: a
// series' details, an episode playing with its subtitle menu open, Live TV and Home. See
// docs/contributing/marketing-artwork.md.
//
//   xvfb-run -a node apps/desktop/scripts/marketing-capture.ts --cache-dir <folder outside the repository>
//
// Runs the development build (`pnpm build` first) with a throwaway profile against the made-up
// subscription of marketing-demo.ts, and drives it through its DevTools port as a viewer would:
// it opens the series, plays its first episode, stars two channels and watches two. Each capture is
// the window's page at 1280 × 800 and twice the pixels, 2560 × 1600, written only once it shows
// what it should: the names, a decoded picture, the tracks and the subtitle.
//
// Linux draws the app in the system's sans-serif font; the captures use Inter, which must be
// installed. Nothing here reaches a real provider: the app's images are answered from the demo
// through the page's DevTools session, and any other remote image is refused.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import manifest from "../../../docs/assets/marketing-demo-sources.json" with { type: "json" };
import { connect, delay, key, launch, login, waitFor, type Page } from "../test/e2e/app.ts";
import { cacheDirectory, prepareMedia, startMarketingDemo } from "./marketing-demo.ts";

const desktop = join(import.meta.dirname, "..");
const assets = join(desktop, "../../docs/assets");
/** The window's size, and how many pixels a capture holds for each of its points. */
const WINDOW = { width: 1280, height: 800 };
const SCALE = 2;
const { featured } = manifest;
const [episode, nextEpisode] = featured.episodes;
if (!episode || !nextEpisode) throw new Error("The manifest lists no two episodes.");
/** The subtitle the capture of the playing episode shows. */
const [, line] = featured.subtitles.eng;
if (!line) throw new Error("The manifest lists no second subtitle.");

const media = await prepareMedia(cacheDirectory());
const demo = await startMarketingDemo(media);
const profile = mkdtempSync(join(tmpdir(), "mr-streamer-marketing-"));
// The app asks for the system's font, which fontconfig answers: Inter, for this run only.
const fonts = join(profile, "fonts.conf");
writeFileSync(
  fonts,
  `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>` +
    `<include ignore_missing="yes">/etc/fonts/fonts.conf</include>` +
    ["sans-serif", "system-ui"]
      .map(
        (family) =>
          `<alias binding="strong"><family>${family}</family><prefer><family>Inter</family></prefer></alias>`,
      )
      .join("") +
    `</fontconfig>`,
);
process.env["FONTCONFIG_FILE"] = fonts;
const font = execFileSync("fc-match", ["-f", "%{family}", "system-ui"], { encoding: "utf8" });
if (!font.includes("Inter")) throw new Error(`Install Inter: the system font is ${font}.`);
// TMDB's stand-in takes any key.
process.env["MR_STREAMER_TMDB_API"] = demo.tmdbApi;
process.env["MR_STREAMER_TMDB_KEY"] = "marketing-capture";

const port = 20000 + Math.floor(Math.random() * 20000);
const app = launch(
  join(desktop, "node_modules/electron/dist/electron"),
  ["--no-sandbox", desktop],
  { port, profile },
);
try {
  const page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", {
    ...WINDOW,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  // Images come from the demo; a remote image it doesn't know is refused.
  page.on("Fetch.requestPaused", (params) => {
    const { requestId, request } = params as { requestId: string; request: { url: string } };
    const picture = demo.artwork(request.url);
    if (!picture) {
      return void page.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    }
    void page.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: picture.contentType }],
      body: picture.body.toString("base64"),
    });
  });
  await page.send("Fetch.enable", {
    patterns: ["http://*", "https://*"].map((urlPattern) => ({
      urlPattern,
      resourceType: "Image",
    })),
  });
  await login(page, demo.provider);

  // Movies and series: the series' details, before anything was played.
  await click(page, "header button", "Series");
  await click(page, "button", featured.name);
  await shows(page, [
    featured.overview,
    ...featured.cast.map((person) => person.name),
    `Play S${episode.season} E${episode.number}`,
    episode.name,
    featured.creator,
  ]);
  await capture(page, "library", { fullScreen: true, pictures: '[role="dialog"] img' });

  // Sound and subtitles: the episode playing, its subtitle showing and the subtitle menu open.
  await click(page, '[role="dialog"] button', `Play S${episode.season} E${episode.number}`);
  const time = () => page.evaluate<number>(`document.querySelector("video")?.currentTime ?? 0`);
  await waitFor(async () => (await time()) > 0.5);
  await openMenu(page, "Subtitles");
  await click(page, "[data-item]", "English");
  // Higher up, so the menu the capture shows open doesn't cover the subtitle.
  await openMenu(page, "Playback");
  await click(page, "[data-page=look]", "Subtitle look");
  await click(page, "[role=radio]", "Higher");
  await key(page, "Escape", 27);
  const subtitle = () =>
    page.evaluate<string>(
      `[...document.querySelector("video").textTracks].flatMap((track) => [...(track.activeCues ?? [])]).map((cue) => cue.text).join("|")`,
    );
  for (let attempt = 1; ; attempt++) {
    await waitFor(async () => (await time()) >= line.from + 0.6);
    await openMenu(page, "Subtitles on");
    await shows(page, [
      featured.name,
      episode.name,
      "Off",
      "English",
      "Nederlands",
      "Next episode",
    ]);
    const taken = await capture(page, "watching", {
      video: true,
      holds: async () => (await subtitle()) === line.text,
    });
    if (taken) break;
    if (attempt === 3) throw new Error(`The capture missed "${line.text}".`);
    // Close the menu and go back ten seconds for another try.
    await key(page, "Escape", 27);
    await key(page, "ArrowLeft", 37);
  }
  await key(page, "Escape", 27);
  await key(page, "Escape", 27);
  await waitFor(() => page.evaluate<boolean>(`!document.querySelector("[data-view=title]")`));
  await key(page, "Escape", 27);

  // Live TV: two favourites, and the channel watched last on top.
  await click(page, "header button", "Live TV");
  for (const channel of manifest.favourites) {
    await page.evaluate(
      `${row(channel)}.querySelector('[aria-label="Add to favourites"]').click()`,
    );
  }
  await watch(page, manifest.guide);
  await shows(page, [
    "Favourites",
    "Recently watched",
    ...manifest.channels.flatMap((channel) => channel.programmes.slice(0, 2)),
  ]);
  await capture(page, "live-tv", { fullScreen: true, video: true, pictures: "img" });

  // Home: another channel on now, and the series to go on with.
  await watch(page, manifest.home);
  await click(page, "header button", "Home");
  await shows(page, ["Continue watching", featured.name, "Favourites", manifest.home]);
  await waitFor(() => playing(page));
  await capture(page, "home", { fullScreen: true, video: true, pictures: "img" });
  page.close();
} finally {
  app.kill("SIGKILL");
  await demo.close();
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}

/** Where the picture on screen is, in the window's points. */
function videoBox(page: Page) {
  return page.evaluate<{ left: number; top: number; width: number; height: number }>(`(() => {
    const video = [...document.querySelectorAll("video")].find((each) => each.offsetParent);
    const { left, top, width, height } = video.getBoundingClientRect();
    return { left, top, width, height };
  })()`);
}

/** Fills the screen, or goes back to a window. */
async function fullScreen(page: Page, on: boolean): Promise<void> {
  await page.send("Runtime.evaluate", {
    expression: on ? "document.documentElement.requestFullscreen()" : "document.exitFullscreen()",
    awaitPromise: true,
    userGesture: true,
  });
  // The main process tells the window once the system has followed.
  await waitFor(() =>
    page.evaluate<boolean>(
      `(getComputedStyle(document.querySelector("header")).paddingRight === getComputedStyle(document.querySelector("header")).paddingLeft) === ${on}`,
    ),
  );
}

/** Clicks the first element matching `selector` whose text starts with `text`, once it is there. */
async function click(page: Page, selector: string, text: string): Promise<void> {
  const target = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => element.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  await waitFor(() => page.evaluate<boolean>(`!!${target}`));
  await page.evaluate(`${target}.click()`);
}

/** A channel's row in Live TV. */
function row(channel: string): string {
  return `[...document.querySelectorAll("main [role=button]")].find((row) => row.textContent.includes(${JSON.stringify(channel)}))`;
}

/** Watches a channel from Live TV until its picture moves, then goes back to the list. */
async function watch(page: Page, channel: string): Promise<void> {
  await waitFor(() => page.evaluate<boolean>(`!!${row(channel)}`));
  await page.evaluate(`${row(channel)}.click()`);
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-view="watch"]')`));
  await waitFor(() => playing(page));
  await key(page, "Escape", 27);
  await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[data-view="watch"]')`));
}

/** The picture on screen is decoded and moving. */
function playing(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const video = [...document.querySelectorAll("video")].find((each) => each.offsetParent);
    return !!video && video.videoWidth > 0 && video.currentTime > 1 && !video.paused;
  })()`);
}

/** Opens one of the player's menus by its button's label, with the controls awake. */
async function openMenu(page: Page, label: string): Promise<void> {
  const button = `document.querySelector('[data-view=title] [aria-label=${JSON.stringify(label)}]')`;
  await page.evaluate(
    `document.querySelector("[data-view=title]").dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))`,
  );
  await waitFor(() => page.evaluate<boolean>(`!!${button}`));
  await page.evaluate(`${button}.click()`);
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector("[data-item]")`));
}

/** Waits until the window shows every one of these texts. */
async function shows(page: Page, texts: readonly string[]): Promise<void> {
  await waitFor(() =>
    page.evaluate<boolean>(
      `${JSON.stringify(texts)}.every((text) => document.body.innerText.includes(text))`,
    ),
  );
}

/**
 * Writes the window as docs/assets/marketing-<name>.png once it is whole: every image in view
 * matching `pictures` loaded, and with `video`, the picture decoded, which the capture itself must
 * show. `fullScreen` fills the screen for the capture: a page's top bar then keeps no room for the
 * window's buttons, which a capture doesn't show. A player stays in its window, where it keeps the
 * top bar. `holds` is asked once the capture is taken; when it no longer does, nothing is written
 * and the answer is false.
 */
async function capture(
  page: Page,
  name: string,
  wanted: {
    readonly fullScreen?: boolean;
    readonly video?: boolean;
    readonly pictures?: string;
    readonly holds?: () => Promise<boolean>;
  },
): Promise<boolean> {
  if (wanted.fullScreen) await fullScreen(page, true);
  if (wanted.pictures) {
    await waitFor(() =>
      page.evaluate<boolean>(`(() => {
        // Those in view: the app loads the rest once they scroll in.
        const images = [...document.querySelectorAll(${JSON.stringify(wanted.pictures)})].filter(
          (image) => image.getBoundingClientRect().top < innerHeight,
        );
        return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
      })()`),
    );
  }
  // The pointer rests in a corner, over nothing that lights up, while transitions settle.
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  await delay(600);
  const reply = await page.send("Page.captureScreenshot", { format: "png" });
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  if (wanted.holds && !(await wanted.holds())) return false;
  const box = wanted.video ? await videoBox(page) : null;
  if (wanted.fullScreen) await fullScreen(page, false);
  const image = sharp(Buffer.from((reply.result as { data: string }).data, "base64"));
  const { width, height } = await image.metadata();
  const expected = { width: WINDOW.width * SCALE, height: WINDOW.height * SCALE };
  if (width !== expected.width || height !== expected.height) {
    throw new Error(`${name} is ${width} × ${height}, not ${expected.width} × ${expected.height}.`);
  }
  if (box) {
    const left = Math.max(Math.round(box.left * SCALE), 0);
    const top = Math.max(Math.round(box.top * SCALE), 0);
    const stats = await image
      .clone()
      .extract({
        left,
        top,
        width: Math.min(Math.round(box.width * SCALE), expected.width - left),
        height: Math.min(Math.round(box.height * SCALE), expected.height - top),
      })
      .stats();
    // A picture that didn't reach the capture is one flat colour.
    const spread = Math.max(...stats.channels.map((channel) => channel.stdev));
    if (spread < 10) throw new Error(`${name} shows no picture where the video is.`);
  }
  const file = join(assets, `marketing-${name}.png`);
  // Lossless: every pixel as the window drew it, without the alpha channel it never uses.
  await image.removeAlpha().png({ compressionLevel: 9 }).toFile(file);
  console.log(`Wrote ${file}`);
  return true;
}
