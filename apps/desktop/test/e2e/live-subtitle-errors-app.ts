// A built app, throwaway profile and public fixture host. Broken subtitle playlists and segments
// must leave pictures moving, both during discovery and after a manual pick. Healthy languages
// remain reachable. A subsequent video stall must still reconnect, not inherit a subtitle 404.
//   node test/e2e/live-subtitle-errors-app.ts <electron> [-- app arguments]
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, connectPlaylist, delay, key, launch, waitFor, type Page } from "./app.ts";

const [executable, ...args] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) throw new Error("Pass an app executable and its arguments.");
const modes = [
  "healthy",
  "playlist404",
  "playlist503",
  "playlist-stall",
  "segment404",
  "segment-stall",
  "later-video-stall",
] as const;
const only = process.env["MR_STREAMER_SUBTITLE_ERRORS_ONLY"];
const watched = Number(process.env["MR_STREAMER_SUBTITLE_ERRORS_SECONDS"] ?? 35);
const requests: {
  mode: string;
  file: string;
  at: number;
  status: number | "held";
  closedAt?: number;
}[] = [];
const held = new Set<ServerResponse>();
const started = Date.now();
const video = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-PLAYLIST-TYPE:VOD",
  ...Array.from({ length: 24 }, (_, index) => [
    ...(index > 0 && index % 4 === 0 ? ["#EXT-X-DISCONTINUITY"] : []),
    "#EXTINF:4.000,",
    `video-${index}.mpegts`,
  ]).flat(),
  "#EXT-X-ENDLIST",
  "",
].join("\n");
const master = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  ...[
    ["en", "English", "YES"],
    ["de", "Deutsch", "NO"],
    ["fr", "Français", "NO"],
  ].map(
    ([lang, name, preset]) =>
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${name}",LANGUAGE="${lang}",DEFAULT=${preset},AUTOSELECT=YES,FORCED=NO,URI="${lang}.m3u8"`,
  ),
  '#EXT-X-STREAM-INF:BANDWIDTH=120000,RESOLUTION=128x72,CODECS="avc1.64000a",SUBTITLES="subs"',
  "video.m3u8",
  "",
].join("\n");
const subtitlePlaylist = (language: string) =>
  [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:96",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXTINF:96.000,",
    `${language}.vtt`,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://fixture");
  const [, mode = "", file = ""] = pathname.split("/");
  const note = (status: number | "held") => {
    const entry: (typeof requests)[number] = {
      mode,
      file,
      at: (Date.now() - started) / 1000,
      status,
    };
    requests.push(entry);
    response.on("close", () => {
      entry.closedAt = (Date.now() - started) / 1000;
    });
  };
  if (pathname === "/playlist.m3u") {
    const body = [
      "#EXTM3U",
      ...modes.flatMap((mode) => [
        `#EXTINF:-1 tvg-id="${mode}" group-title="Test",TEST | Subtitle ${mode}`,
        `${origin}/${mode}/master.m3u8`,
      ]),
      "",
    ].join("\n");
    return response.writeHead(200).end(body);
  }
  const missing =
    (file === "fr.m3u8" && ["playlist404", "playlist503", "later-video-stall"].includes(mode)) ||
    (file === "fr.vtt" && mode === "segment404");
  if (missing) {
    const status = mode === "playlist503" ? 503 : 404;
    note(status);
    return response.writeHead(status).end();
  }
  const clip = /^video-(\d+)\.mpegts$/.exec(file);
  if (
    (file === "fr.m3u8" && mode === "playlist-stall") ||
    (file === "fr.vtt" && mode === "segment-stall") ||
    (clip && Number(clip[1]) >= 3 && mode === "later-video-stall")
  ) {
    note("held");
    held.add(response);
    response.on("close", () => held.delete(response));
    return;
  }
  let body: string | Buffer | null = null;
  if (file === "master.m3u8") body = master;
  else if (file === "video.m3u8") body = video;
  else if (/^(en|de|fr)\.m3u8$/.test(file)) body = subtitlePlaylist(file.slice(0, 2));
  else if (/^(en|de|fr)\.vtt$/.test(file))
    body = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\n00:00:00.000 --> 00:01:36.000\nHealthy ${file.slice(0, 2)}\n`;
  else if (clip)
    body = readFileSync(
      join(import.meta.dirname, `../fixtures/hls/video-${Number(clip[1]) % 4}.mpegts`),
    );
  note(body === null ? 404 : 200);
  response
    .writeHead(body === null ? 404 : 200, {
      "Content-Type": file.endsWith("m3u8")
        ? "application/vnd.apple.mpegurl"
        : file.endsWith("vtt")
          ? "text/vtt"
          : "video/mp2t",
    })
    .end(body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const profile = mkdtempSync(join(tmpdir(), "mr-streamer-subtitle-errors-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const app = launch(executable, args, { port, profile });
let page: Page | undefined;
let failed = false;
async function click(expression: string) {
  await waitFor(() => page!.evaluate<boolean>(`!!(${expression})`), 15_000);
  await page!.evaluate(`(${expression}).click()`);
}
async function pick(language: string) {
  await click(`document.querySelector('[data-view="watch"] [aria-label^="Subtitles"]')`);
  const popup = `document.querySelector('[role="dialog"][aria-label^="Subtitles"]')`;
  await click(
    `[...${popup}?.querySelectorAll('[data-item][aria-pressed]') ?? []].find((item) => item.textContent.trim() === ${JSON.stringify(language)})`,
  );
}
const sample = () =>
  page!.evaluate<{
    time: number;
    width: number;
    cc: string;
    line: string;
    failure: string;
  }>(`(() => {
  const video = document.querySelector('video');
  const watch = document.querySelector('[data-view="watch"]');
  const cc = watch?.querySelector('[aria-label^="Subtitles"]');
  return { time: video?.currentTime ?? -1, width: video?.videoWidth ?? 0,
    cc: !cc ? 'absent' : cc.getAttribute('aria-pressed') === 'true' ? 'on' : 'off',
    line: document.querySelector('[data-subtitle-text]')?.textContent ?? '',
    failure: /No stream right now|HTTP 404|HTTP 503|Reconnecting|Keeps dropping|Waiting for data/.exec(watch?.textContent ?? '')?.[0] ?? '' };
})()`);
try {
  page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await connectPlaylist(page, `${origin}/playlist.m3u`);
  for (const mode of modes) {
    if (only && !only.split(",").includes(mode)) continue;
    const from = requests.length;
    await click(`document.querySelector('[aria-label="Search"]')`);
    await delay(300);
    await page.send("Input.insertText", { text: `TEST | Subtitle ${mode}` });
    await delay(600);
    await key(page, "Enter", 13);
    await waitFor(async () => {
      const now = await sample();
      return now.width > 0 && now.time > 0.3;
    }, 30_000);
    await waitFor(
      () => Promise.resolve(requests.slice(from).some((request) => request.file === "fr.m3u8")),
      15_000,
    );
    await delay(5500);
    const automatic = await sample();
    await pick("Français");
    await delay(5500);
    const explicit = await sample();
    if (mode === "playlist-stall") {
      // A viewer who changes their mind need not wait out even the five-second deadline.
      await pick("Français");
      await delay(500);
      await key(page, "c", 67);
      await delay(300);
    }
    await pick("English");
    await waitFor(async () => (await sample()).line.includes("Healthy en"), 10_000);
    const english = await sample();
    if (mode === "later-video-stall") {
      // Leave a subtitle 404 as the last failed request, after the healthy rendition is loaded.
      await pick("Français");
      await delay(1000);
    }
    const observations = [await sample()];
    for (let second = 0; second < watched; second++) {
      await delay(1000);
      observations.push(await sample());
    }
    const mine = requests.slice(from).filter((request) => request.mode === mode);
    const masters = mine.filter((request) => request.file === "master.m3u8").length;
    const bad = mine.filter((request) => /^fr\./.test(request.file)).length;
    const subtitles = mine.filter((request) => /^(en|de|fr)\./.test(request.file)).length;
    const errors = [...new Set(observations.map((sample) => sample.failure).filter(Boolean))];
    const backwards = observations.some(
      (sample, index) => index > 0 && sample.time + 1 < observations[index - 1]!.time,
    );
    const last = observations.at(-1)!;
    const videoOkay =
      mode === "later-video-stall"
        ? masters > 1 &&
          errors.includes("Reconnecting") &&
          !errors.some((error) => /404|503|No stream/.test(error))
        : masters === 1 &&
          !backwards &&
          errors.length === 0 &&
          last.width > 0 &&
          last.time > observations[0]!.time + watched - 3;
    const cancelled = mine
      .filter((request) => /^fr\./.test(request.file) && request.status === "held")
      .every((request) => request.closedAt !== undefined && request.closedAt - request.at < 5.8);
    const ok =
      cancelled &&
      videoOkay &&
      automatic.cc === "off" &&
      explicit.cc === (mode === "healthy" ? "on" : "off") &&
      english.cc === "on" &&
      subtitles <= (mode === "later-video-stall" ? 24 : 12) &&
      bad <= (mode === "later-video-stall" ? 10 : 4);
    console.log(
      `${ok ? "PASS" : "FAIL"} ${mode}: discovery CC ${automatic.cc}, picked CC ${explicit.cc}, English "${english.line}", video ${observations[0]!.time.toFixed(1)} -> ${last.time.toFixed(1)}, ${masters} masters, ${subtitles} subtitle requests (${bad} French), errors [${errors}]`,
    );
    console.log(JSON.stringify({ mode, requests: mine, observations }));
    failed ||= !ok;
    // Keep preferences Off on the next tune so every case exercises discovery.
    if ((await sample()).cc === "on") await key(page, "c", 67);
    await key(page, "Escape", 27);
  }
} catch (error) {
  failed = true;
  console.error(`FAIL ${String(error)}`);
  console.log(JSON.stringify(requests));
} finally {
  page?.close();
  if (app.exitCode === null && app.signalCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGKILL");
    await exited;
  }
  for (const response of held) response.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
