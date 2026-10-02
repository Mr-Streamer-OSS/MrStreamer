// Measures a built app against the fake provider at the size of a large subscription: 13,000
// channels, about 2,000 of them with a guide, a continuous 720p stream from ffmpeg on every test
// channel, and a series of 520 episodes. Prints medians for slice comparisons, and how many streams
// each tune, switch and return to Watch opens at the provider; see docs/maintainers/testing.md.
//
//   node test/e2e/measure-app.ts [--json results.json] <app executable> [-- extra app arguments]
//
// `--json` also writes every run of every measure, for compare-builds.ts. Needs ffmpeg on PATH
// (or MR_STREAMER_FFMPEG). On macOS pass --use-mock-keychain.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fakeGuide, startFakeProvider } from "../fake-provider.ts";
import { connect, delay, key, launch, login, waitFor, type Page } from "./app.ts";

const { values: options, positionals } = parseArgs({
  options: { json: { type: "string" } },
  allowPositionals: true,
});
const [executable, ...rest] = positionals;
if (!executable) {
  throw new Error("Usage: node test/e2e/measure-app.ts [--json file] <app executable> [-- args]");
}

const ffmpeg = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const RUNS = 3;
const IDLE_MS = 30_000;
const TEST_CHANNELS = ["H.264 + AAC", "H.264 + MP2", "H.264 + MP3", "H.264 + AC-3"];

const provider = await startFakeProvider({
  channels: 13_000,
  maxConnections: 1,
  longSeries: true,
  // Every channel plays the same endless 720p programme, encoded as it goes.
  streams: (_channel, out, signal) => {
    const encoder = spawn(
      ffmpeg,
      [
        ...["-hide_banner", "-loglevel", "error", "-re"],
        ...["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25"],
        ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
        ...["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "50"],
        ...["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-f", "mpegts", "pipe:1"],
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    encoder.stdout.pipe(out);
    signal.addEventListener("abort", () => encoder.kill("SIGKILL"), { once: true });
  },
});
provider.serveGuide(
  fakeGuide(
    {
      ...provider.catalogue,
      channels: provider.catalogue.channels.filter((channel) => channel.streamId % 6 === 0),
    },
    Date.now(),
  ),
);

const results = new Map<string, number[]>();
const record = (name: string, value: number) =>
  results.set(name, [...(results.get(name) ?? []), value]);
const profile = mkdtempSync(join(tmpdir(), "mr-streamer-measure-"));
let app: ChildProcess | null = null;

try {
  // First run: log in, let the catalogue and guide arrive, then tune, switch and browse.
  let port = randomPort();
  app = launch(executable, rest, { port, profile });
  let page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page, provider);
  await waitFor(() => Promise.resolve(provider.guideRequests() > 0), 30_000);
  await delay(5000);

  for (let run = 0; run < RUNS; run++) {
    await clickText(page, "Home");
    await delay(1000);
    await timed(
      "guide open",
      () => clickText(page, "Live TV"),
      () => rowsShown(page),
    );
    await clickText(page, "TEST | Formats and failures");
    await delay(1000);
    await timed(
      "guide list of 13,000",
      () => clickText(page, "All channels"),
      () => rowsShown(page),
    );
  }
  await clickText(page, "TEST | Formats and failures");
  await waitFor(() => rowsShown(page));
  for (const channel of TEST_CHANNELS.slice(0, RUNS)) {
    const requests = provider.streamRequests();
    await timed(
      "time to picture",
      () => clickRow(page, channel),
      () => freshPicture(page),
    );
    await delay(1000);
    record("streams opened per tune (count)", provider.streamRequests() - requests);
    await key(page, "Escape", 27);
    await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[data-view="watch"]')`));
  }
  await clickRow(page, TEST_CHANNELS[0]!);
  await waitFor(() => freshPicture(page));
  for (let run = 0; run < RUNS; run++) {
    const requests = provider.streamRequests();
    await timed(
      "channel switch",
      () => key(page, "ArrowDown", 40),
      () => freshPicture(page),
    );
    await delay(1000);
    record("streams opened per switch (count)", provider.streamRequests() - requests);
  }
  await key(page, "Escape", 27);
  await clickText(page, "Home");
  await delay(1000);
  for (let run = 0; run < RUNS; run++) {
    await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
    await delay(500);
    await timed(
      "search, typed to programmes shown",
      () => page.send("Input.insertText", { text: "news" }),
      () => page.evaluate<boolean>(`document.body.innerText.includes("On now")`),
    );
    await key(page, "Escape", 27);
    await delay(500);
  }

  // Idle on Home: first with the muted preview playing, then with playback stopped.
  await delay(3000);
  const withPreview = await idle(app);
  record("idle CPU, Home with preview (%)", withPreview.cpu);
  record("memory, Home with preview (MB)", withPreview.memory);
  // Watch takes over the preview's stream.
  const requests = provider.streamRequests();
  await clickText(page, "Watch");
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-view="watch"]')`));
  await delay(1000);
  record("streams opened, Home to Watch (count)", provider.streamRequests() - requests);
  await page.evaluate(`document.querySelector('[aria-label="Stop"]').click()`);
  await key(page, "Escape", 27);
  await delay(3000);
  const stopped = await idle(app);
  record("idle CPU, Home stopped (%)", stopped.cpu);
  record("memory, Home stopped (MB)", stopped.memory);
  page.close();
  await quit(app);

  // Cold starts: the same profile, logged in, with the catalogue and guide on disk. Each then
  // opens the long series, which the app has not asked the provider about since it started.
  for (let run = 0; run < RUNS; run++) {
    port = randomPort();
    const started = performance.now();
    app = launch(executable, rest, { port, profile });
    page = await connect(port);
    await waitFor(() =>
      page.evaluate<boolean>(
        `!!document.querySelector("section h1") && !document.body.innerText.includes("Loading channels")`,
      ),
    );
    record("cold start to Home", performance.now() - started);
    await openLongSeries(page);
    page.close();
    await quit(app);
  }
  app = null;

  record("installed size (MB)", installedSize(executable));
  report();
  if (options.json) writeFileSync(options.json, JSON.stringify(Object.fromEntries(results)));
} finally {
  app?.kill("SIGKILL");
  await provider.close();
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}

async function timed(
  name: string,
  act: () => Promise<unknown>,
  done: () => Promise<boolean>,
): Promise<void> {
  const started = performance.now();
  await act();
  await waitFor(done, 60_000);
  record(name, performance.now() - started);
}

/**
 * Opens the long series from All series, the newest first, and times in the window when its name
 * shows and when the first season's 26 episodes do.
 */
async function openLongSeries(page: Page): Promise<void> {
  await page.evaluate(
    `[...document.querySelectorAll("header button")].find((b) => b.textContent.trim() === "Series").click()`,
  );
  const allTab = `[...document.querySelectorAll("nav button")].find((b) => b.textContent.trim() === "All series")`;
  await waitFor(() => page.evaluate<boolean>(`!!${allTab}`));
  await page.evaluate(`${allTab}.click()`);
  const poster = `[...document.querySelectorAll("button[title]")].find((b) => b.title.includes("Long-running"))`;
  await waitFor(() => page.evaluate<boolean>(`!!${poster}`));
  await delay(1000);
  const shown = await page.evaluate<{ title: number; episodes: number }>(`(async () => {
    const started = performance.now();
    const when = (check) => new Promise((resolve) => {
      const poll = () => (check() ? resolve(performance.now() - started) : setTimeout(poll, 5));
      poll();
    });
    ${poster}.click();
    const dialog = () => document.querySelector('[role="dialog"]');
    const title = await when(() => dialog()?.querySelector("h2")?.textContent.includes("Long-running"));
    const episodes = await when(() => [...(dialog()?.querySelectorAll("button") ?? [])]
      .filter((row) => /^\\d+$/.test(row.firstElementChild?.textContent.trim() ?? "")).length >= 26);
    return { title, episodes };
  })()`);
  record("long series details, name shown", shown.title);
  record("long series details, episodes shown", shown.episodes);
  await key(page, "Escape", 27);
}

function clickText(page: Page, text: string): Promise<unknown> {
  return page.evaluate(`(() => {
    const target = [...document.querySelectorAll("button, [role=button]")]
      .find((element) => element.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!target) throw new Error("No button " + ${JSON.stringify(text)});
    target.click();
  })()`);
}

function clickRow(page: Page, channel: string): Promise<unknown> {
  return page.evaluate(`(() => {
    window.__source = document.querySelector("video")?.currentSrc ?? "";
    [...document.querySelectorAll("[role=button]")]
      .find((row) => row.textContent.includes(${JSON.stringify(channel)})).click();
  })()`);
}

/** Channel rows are on screen. */
function rowsShown(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`document.querySelectorAll("main [role=button]").length > 5`);
}

/** A new stream has started moving since the last click or key. */
function freshPicture(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const video = document.querySelector("video");
    const fresh = video && video.currentSrc && video.currentSrc !== window.__source;
    if (fresh && video.currentTime > 0.2 && video.videoWidth > 0) {
      window.__source = video.currentSrc;
      return true;
    }
    return false;
  })()`);
}

async function quit(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(10_000)]);
  child.kill("SIGKILL");
  await delay(1000);
}

/** CPU use in percent of one core, and memory, of the app's processes over `IDLE_MS`. */
async function idle(root: ChildProcess): Promise<{ cpu: number; memory: number }> {
  const before = usage(root.pid!);
  await delay(IDLE_MS);
  const after = usage(root.pid!);
  return {
    cpu: Math.round(((after.cpuSeconds - before.cpuSeconds) / (IDLE_MS / 1000)) * 1000) / 10,
    memory: Math.round(after.rssKb / 1024),
  };
}

/** CPU seconds used so far and resident memory of `root` and every process under it. */
function usage(root: number): { cpuSeconds: number; rssKb: number } {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,time="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, rss, time]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      rss: Number(rss),
      time: time ?? "0",
    }));
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }
  const members = rows.filter((row) => tree.has(row.pid));
  const cpuSeconds = members.reduce(
    (sum, row) => sum + (process.platform === "linux" ? linuxCpu(row.pid) : psTime(row.time)),
    0,
  );
  return { cpuSeconds, rssKb: members.reduce((sum, row) => sum + row.rss, 0) };
}

/** Linux's ps rounds to whole seconds, so read the clock ticks instead. */
function linuxCpu(pid: number): number {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? [];
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch {
    return 0;
  }
}

/** macOS's ps time: [[dd-]hh:]mm:ss.cc. */
function psTime(text: string): number {
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = (clock ?? "0").split(":").map(Number);
  const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
  return Number(days) * 86_400 + seconds;
}

/** The size of the installed app: the .app bundle on macOS, its folder elsewhere. */
function installedSize(file: string): number {
  const folder = process.platform === "darwin" ? dirname(dirname(dirname(file))) : dirname(file);
  const bytes = sizeOf(folder);
  return Math.round(bytes / 1024 / 1024);
}

function sizeOf(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += sizeOf(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

function report(): void {
  const median = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  console.log(`| Measure | Median | Runs |\n| --- | --- | --- |`);
  for (const [name, values] of results) {
    const unit = name.includes("(") ? "" : " ms";
    const shown = (value: number) => `${Math.round(value * 10) / 10}${unit}`;
    console.log(`| ${name} | ${shown(median(values))} | ${values.map(shown).join(", ")} |`);
  }
}

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}
