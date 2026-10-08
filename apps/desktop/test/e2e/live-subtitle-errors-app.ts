// A built app, throwaway profile and public fixture host. Broken subtitle playlists and segments
// must leave pictures moving, both during discovery and after a manual pick. Healthy languages
// remain reachable. A subsequent video stall must still reconnect, not inherit a subtitle 404.
//   node test/e2e/live-subtitle-errors-app.ts <electron> [-- app arguments]
import { spawnSync } from "node:child_process";
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
  "live-six-off",
  "live-six-remembered",
  "live-aborts",
] as const;
const only = process.env["MR_STREAMER_SUBTITLE_ERRORS_ONLY"];
const watched = Number(process.env["MR_STREAMER_SUBTITLE_ERRORS_SECONDS"] ?? 35);
const requests: {
  mode: string;
  file: string;
  at: number;
  status: number | "held";
  closedAt?: number;
  completed?: boolean;
}[] = [];
const held = new Set<ServerResponse>();
const started = Date.now();
const liveStarts = new Map<string, number>();
const slowVideo = new Set<string>();
const live = (mode: string) => mode.startsWith("live-");
// Six-second segments with continuous timestamps, owned by this throwaway test directory.
const clips = mkdtempSync(join(tmpdir(), "mr-streamer-live-six-"));
const encoded = spawnSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=128x72:rate=25",
  "-t",
  "24",
  "-an",
  "-c:v",
  "libx264",
  "-threads",
  "1",
  "-g",
  "150",
  "-keyint_min",
  "150",
  "-sc_threshold",
  "0",
  "-f",
  "hls",
  "-hls_time",
  "6",
  "-hls_list_size",
  "0",
  "-hls_segment_filename",
  join(clips, "video-%d.mpegts"),
  join(clips, "video.m3u8"),
]);
if (encoded.status !== 0) throw new Error(`Six-second fixture encoding failed: ${encoded.stderr}`);
const livePlaylist = (mode: string, language?: string) => {
  const first = Math.floor((Date.now() - (liveStarts.get(mode) ?? Date.now())) / 6000);
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:6",
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / 4)}`,
    ...Array.from({ length: 5 }, (_, at) => {
      const index = first + at;
      return [
        ...(index > 0 && index % 4 === 0 ? ["#EXT-X-DISCONTINUITY"] : []),
        "#EXTINF:6.000,",
        language ? `${language}-${index}.vtt` : `video-${index}.mpegts`,
      ];
    }).flat(),
    "",
  ].join("\n");
};
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
    response.on("finish", () => {
      entry.completed = true;
    });
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
  if (file === "master.m3u8") {
    if (live(mode) && !liveStarts.has(mode)) liveStarts.set(mode, Date.now());
    body = master;
  } else if (file === "video.m3u8") body = live(mode) ? livePlaylist(mode) : video;
  else if (/^(en|de|fr)\.m3u8$/.test(file))
    body = live(mode) ? livePlaylist(mode, file.slice(0, 2)) : subtitlePlaylist(file.slice(0, 2));
  else if (/^(en|de|fr)\.vtt$/.test(file))
    body = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\n00:00:00.000 --> 00:01:36.000\nHealthy ${file.slice(0, 2)}\n`;
  else if (/^(en|de|fr)-\d+\.vtt$/.test(file)) {
    const index = Number(file.match(/-(\d+)/)?.[1]);
    const at = (index % 4) * 6;
    body = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\n00:00:${String(at).padStart(2, "0")}.000 --> 00:00:${String(at + 6).padStart(2, "0")}.000\nHealthy ${file.slice(0, 2)}\n`;
  } else if (clip && live(mode))
    body = readFileSync(join(clips, `video-${Number(clip[1]) % 4}.mpegts`));
  else if (clip)
    body = readFileSync(
      join(import.meta.dirname, `../fixtures/hls/video-${Number(clip[1]) % 4}.mpegts`),
    );
  note(body === null ? 404 : 200);
  const answer = () =>
    response
      .writeHead(body === null ? 404 : 200, {
        "Content-Type": file.endsWith("m3u8")
          ? "application/vnd.apple.mpegurl"
          : file.endsWith("vtt")
            ? "text/vtt"
            : "video/mp2t",
      })
      .end(body);
  // The video playlist loses the initial playlist race. The first video fragment takes six
  // seconds even though the subtitle rendition is healthy and ready on localhost.
  if (live(mode) && file === "video.m3u8") setTimeout(answer, 300);
  else if (live(mode) && clip && !slowVideo.has(mode)) {
    slowVideo.add(mode);
    setTimeout(answer, 6000);
  } else if (mode === "live-aborts" && /^(en|de|fr)-\d+\.vtt$/.test(file)) setTimeout(answer, 1200);
  else answer();
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
    frames: number;
    cc: string;
    line: string;
    failure: string;
  }>(`(() => {
  const video = document.querySelector('video');
  const watch = document.querySelector('[data-view="watch"]');
  const cc = watch?.querySelector('[aria-label^="Subtitles"]');
  return { time: video?.currentTime ?? -1, width: video?.videoWidth ?? 0, frames: video?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
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
    if (mode === "live-six-remembered") {
      await page.evaluate(
        `window.mrStreamer.invoke('preferences.update', { subtitleLanguage: 'en' })`,
      );
    }
    const tuningAt = Date.now();
    await click(`document.querySelector('[aria-label="Search"]')`);
    await delay(300);
    await page.send("Input.insertText", { text: `TEST | Subtitle ${mode}` });
    await delay(600);
    await key(page, "Enter", 13);
    await waitFor(async () => {
      const now = await sample();
      return now.width > 0 && now.time > 0.3;
    }, 30_000);
    const startup = await sample();
    const startupMs = Date.now() - tuningAt;
    if (live(mode)) {
      await waitFor(async () => (await sample()).cc !== "absent", 25_000);
      const available = await sample();
      if (mode === "live-six-remembered")
        await waitFor(
          async () => (await sample()).cc === "on" && (await sample()).line.includes("Healthy en"),
          20_000,
        );
      const remembered = await sample();
      await pick("English");
      await waitFor(async () => (await sample()).line.includes("Healthy en"), 15_000);
      if (mode === "live-aborts") {
        // Switch and Off while subtitle requests can be in flight. Repeated picks are public
        // actions, and request completion/abort evidence below records what actually happened.
        await key(page, "c", 67);
        await delay(700);
        await pick("English");
        await pick("Deutsch");
        await delay(300);
        await key(page, "c", 67);
        await delay(300);
        await pick("English");
        await waitFor(async () => (await sample()).line.includes("Healthy en"), 20_000);
      }
      await delay(12_000);
      const final = await sample();
      const mine = requests.slice(from).filter((entry) => entry.mode === mode);
      const abortedVideo = mine.filter((entry) => /^video-/.test(entry.file) && !entry.completed);
      const masters = mine.filter((entry) => entry.file === "master.m3u8").length;
      const ok =
        startup.frames > 0 &&
        available.cc !== "absent" &&
        (mode !== "live-six-remembered" || remembered.cc === "on") &&
        final.cc === "on" &&
        final.line.includes("Healthy en") &&
        !final.failure &&
        masters === 1 &&
        abortedVideo.length === 0 &&
        final.frames > startup.frames;
      console.log(
        `${ok ? "PASS" : "FAIL"} ${mode}: startup ${(startupMs / 1000).toFixed(1)}s to picture, ${startup.frames} decoded startup frames, availability ${available.cc}, remembered ${remembered.cc}, final ${JSON.stringify(final)}, ${masters} masters, ${abortedVideo.length} unfinished video requests`,
      );
      console.log(JSON.stringify({ mode, startup, available, remembered, final, requests: mine }));
      failed ||= !ok;
      await key(page, "c", 67);
      await key(page, "Escape", 27);
      continue;
    }
    await waitFor(
      () => Promise.resolve(requests.slice(from).some((request) => request.file === "fr.m3u8")),
      15_000,
    );
    await delay(1500);
    const automatic = await sample();
    await pick("Français");
    if (mode === "healthy") await delay(500);
    else await waitFor(async () => (await sample()).cc === "off", 25_000);
    const explicit = await sample();
    if (mode === "playlist-stall") {
      // Changing the choice cancels subtitle fragments; playlists keep hls.js network deadlines.
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
      .every((request) => request.closedAt !== undefined && request.closedAt - request.at < 21);
    const ok =
      cancelled &&
      videoOkay &&
      automatic.cc === "off" &&
      explicit.cc === (mode === "healthy" ? "on" : "off") &&
      english.cc === "on" &&
      subtitles <= (mode === "later-video-stall" ? 36 : 24) &&
      bad <= (mode === "later-video-stall" ? 15 : 10);
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
  rmSync(clips, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
