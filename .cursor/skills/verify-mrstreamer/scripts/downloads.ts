// The downloads scenario of `pnpm verify:desktop`: the built app, started three times on one
// profile, driven through its window. It downloads a movie and an episode from their details,
// gives a running download's connection to playback of the same subscription, cancels, retries
// and deletes through the Downloads page, then plays a copy offline: seeking, changing its sound
// track, leaving and resuming. The second start has the fake provider, TMDB and picture server
// stopped; the subscription is removed there, and the third start plays both copies from the
// Connect screen's Downloads with no subscription saved. Main's outbound connections are recorded
// by network-hook.cjs, the window's requests over CDP, and each local playback window must have
// none but the window's own loopback proxy requests.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { connect, type Page } from "../../../../apps/desktop/test/e2e/app.ts";
import {
  startFakeProvider,
  type FakeProvider,
} from "../../../../apps/desktop/test/fake-provider.ts";
import { startFakeTmdb, type FakeTmdb } from "../../../../apps/desktop/test/fake-tmdb.ts";
import { freePort, record, stop } from "./session.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const desktop = join(root, "apps/desktop");
const hook = fileURLToPath(new URL("./network-hook.cjs", import.meta.url));

/** One connection a main process made, as network-hook.cjs wrote it. */
interface Connection {
  readonly at: number;
  readonly kind: "tcp" | "udp" | "ipc" | "artwork";
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
}

/** A request the window made, as CDP said it. */
interface WindowRequest {
  readonly at: number;
  readonly url: string;
}

export async function runDownloads(build: Record<string, unknown> & { executable: string }) {
  const evidenceRoot = join(root, ".local/verification");
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(evidenceRoot, "downloads-"));
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Verification interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const actions: { action: string; at: string }[] = [];
  const observed: Record<string, unknown> = { build };
  const log: string[] = [];
  const networkLog = join(evidence, "main-network.jsonl");
  const windowRequests: WindowRequest[] = [];
  let profile: string | undefined;
  let provider: FakeProvider | undefined;
  let tmdb: FakeTmdb | undefined;
  let pictures: Server | undefined;
  let running: { app: ChildProcess; page: Page } | undefined;
  let failed: unknown;
  const cleanupErrors: string[] = [];
  try {
    profile = await mkdtemp(join(tmpdir(), "mrstreamer-verify-"));
    provider = await startFakeProvider({ channels: 20, titles: 10, live: true });
    tmdb = await startFakeTmdb();
    pictures = await pictureServer();
    const picturesUrl = `http://127.0.0.1:${(pictures.address() as AddressInfo).port}`;
    const fixturePorts = [provider.url, tmdb.url, picturesUrl].map((url) =>
      Number(new URL(url).port),
    );
    observed["fixturePorts"] = fixturePorts;

    /** Starts the app on the run's profile, its main process recorded, and checks it is ours. */
    const start = async (label: string) => {
      const port = await freePort();
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !name.startsWith("MR_STREAMER_") &&
            name !== "ELECTRON_RUN_AS_NODE" &&
            name !== "NODE_OPTIONS",
        ),
      );
      const app = spawn(
        build.executable,
        [
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${profile}`,
          "--enable-automation",
          "--use-mock-keychain",
          ...(process.platform === "linux" ? ["--no-sandbox"] : []),
          desktop,
        ],
        {
          cwd: root,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...env,
            ...(process.env["MR_STREAMER_FFMPEG"]
              ? { MR_STREAMER_FFMPEG: process.env["MR_STREAMER_FFMPEG"] }
              : {}),
            MR_STREAMER_UPDATE_CHECKS: "off",
            MR_STREAMER_TMDB_API: tmdb!.url,
            MR_STREAMER_TMDB_KEY: "test-key",
            NODE_OPTIONS: `--require ${JSON.stringify(hook).slice(1, -1)}`,
            VERIFY_NETWORK_LOG: networkLog,
            VERIFY_IMAGES: picturesUrl,
          },
        },
      );
      for (const stream of [app.stdout, app.stderr])
        stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
      const page = await connect(port);
      running = { app, page };
      const command = await page.send("Browser.getBrowserCommandLine");
      const args = record(command.result) ? command.result["arguments"] : null;
      if (
        !Array.isArray(args) ||
        !args.includes(`--user-data-dir=${profile}`) ||
        !args.includes(desktop)
      )
        throw new Error("CDP belongs to a different app instance.");
      const url = await page.evaluate<string>("location.href");
      if (!url.startsWith(pathToFileURL(join(desktop, "out/renderer/")).href))
        throw new Error(`Wrong renderer: ${url}`);
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.send("Network.enable");
      page.on("Network.requestWillBeSent", (params) => {
        if (record(params) && record(params["request"]))
          windowRequests.push({ at: Date.now(), url: String(params["request"]["url"]) });
      });
      actions.push({ action: `Start the app (${label}) on the run's profile`, at: now() });
      return driver(page);
    };

    const quit = async (label: string) => {
      if (!running) return;
      actions.push({ action: `Quit the app (${label})`, at: now() });
      await stop(running.app, running.page);
      running.page.close();
      running = undefined;
    };

    /** Window driving with real pointer and key input; observations read the DOM. */
    const driver = (page: Page) => {
      const wait = async (check: () => Promise<boolean>, timeout = 30_000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          abort.signal.throwIfAborted();
          if (await check().catch(() => false)) return;
          await delay(150, undefined, { signal: abort.signal });
        }
        throw new Error(`Timed out waiting for ${check.toString()}`);
      };
      const exists = (expression: string) => page.evaluate<boolean>(`!!(${expression})`);
      const capture = async (name: string) => {
        const shot = await page.send("Page.captureScreenshot", { format: "png" });
        if (!record(shot.result) || typeof shot.result["data"] !== "string")
          throw new Error("No screenshot returned.");
        await writeFile(join(evidence, `${name}.png`), Buffer.from(shot.result["data"], "base64"));
        const tree = await page.send("Accessibility.getFullAXTree");
        await writeFile(join(evidence, `${name}.ax.json`), JSON.stringify(tree.result, null, 2));
      };
      const click = async (label: string, element: string) => {
        await wait(() => exists(element));
        actions.push({ action: label, at: now() });
        await page.evaluate(`${element}.scrollIntoView({ block: "nearest" })`);
        const point = await page.evaluate<{ x: number; y: number }>(`(() => {
          const box = ${element}.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        })()`);
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
          await page.send("Input.dispatchMouseEvent", {
            type,
            ...point,
            button: "left",
            clickCount: 1,
          });
        }
      };
      const key = async (name: string, code: number) => {
        actions.push({ action: `Press ${name}`, at: now() });
        for (const type of ["rawKeyDown", "keyUp"])
          await page.send("Input.dispatchKeyEvent", {
            type,
            key: name,
            code: name,
            windowsVirtualKeyCode: code,
          });
      };
      const text = (selector = "body") =>
        page.evaluate<string>(
          `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`,
        );
      const video = () =>
        page.evaluate<{
          time: number;
          width: number;
          audio: number;
          paused: boolean;
          title: boolean;
        }>(`(() => {
          const v = document.querySelector('video');
          return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0,
            audio: v?.webkitAudioDecodedByteCount ?? 0, paused: v?.paused ?? true,
            title: !!document.querySelector('[data-view=title]') };
        })()`);
      /** Main's list, read as the window reads it: an observation, never a change. */
      const listed = () =>
        page.evaluate<
          {
            id: string;
            name: string;
            status: { kind: string };
            subscription: unknown;
            progress: { position: number } | null;
            posterUrl: string | null;
            title: { kind: "movie" | "episode"; id: string };
          }[]
        >("window.mrStreamer.invoke('downloads.list').then(r => r.ok ? r.value.items : [])");
      return { page, wait, exists, capture, click, key, text, video, listed };
    };
    type Driver = ReturnType<typeof driver>;

    const button = (selector: string, words: string) =>
      `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;
    const labelled = (label: string) =>
      `document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`;
    const poster = (words: string) =>
      `[...document.querySelectorAll('button[title]')].find(b => b.title.includes(${JSON.stringify(words)}))`;
    const row = (id: string) => `document.querySelector('[data-download="${id}"]')`;
    /** The id of the download of a provider's title, as main lists it. */
    const idOf = async (d: Driver, kind: "movie" | "episode", id?: number) => {
      const found = (await d.listed()).find(
        (item) => item.title.kind === kind && (id === undefined || item.title.id === String(id)),
      );
      if (!found) throw new Error(`No download of ${kind} ${id ?? ""}`);
      return found.id;
    };

    /** Plays a copy from its row on the Downloads page, and proves a moving picture. */
    const watchOffline = async (d: Driver, id: string, label: string) => {
      await d.click(label, `(${row(id)})?.querySelector('button')`);
      await d.wait(async () => {
        const v = await d.video();
        return v.title && !v.paused && v.width > 0 && v.time > 0.5;
      }, 45_000);
    };

    // 1. Online: connect, then download a movie and an episode from their details.
    const online = await start("online");
    await online.wait(() =>
      online.page.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
    );
    for (const [index, value] of [provider.url, "demo", "demo"].entries()) {
      await online.click(
        `Fill Connect field ${index + 1}`,
        `document.querySelectorAll('form input')[${index}]`,
      );
      await online.page.send("Input.insertText", { text: value });
    }
    await online.click("Submit Connect", "document.querySelector('form button[type=submit]')");
    await online.wait(() => online.exists("document.querySelector('header')"));
    await online.click("Open Movies", button("header button", "Movies"));
    await online.click("Open All movies", button("nav button", "All movies"));
    await online.click("Open the two-sound-track movie", poster("Two sound tracks"));
    await online.click("Download the movie", button('[role="dialog"] button', "Download"));
    await online.wait(
      () => online.exists(button('[role="dialog"] button', "Watch offline")),
      60_000,
    );
    await online.capture("movie-downloaded");
    await online.key("Escape", 27);

    await online.click("Open Series", button("header button", "Series"));
    await online.click("Open All series", button("nav button", "All series"));
    await online.click("Open the Formats series", poster("Formats"));
    await online.click("Download S1 E2", labelled("Download S1 E2"));
    await online.wait(() => online.exists(labelled("Watch S1 E2 offline")), 60_000);
    await online.capture("episode-downloaded");
    await online.key("Escape", 27);

    // 2. Playback of the same subscription takes a running download's connection.
    const slow = provider.titles.movies.find((each) =>
      each.name.startsWith("TEST | Long subtitles"),
    )!;
    provider.stallMovieFile(slow.id, 40_000, 20_000);
    await online.click("Open Movies", button("header button", "Movies"));
    await online.click("Open All movies", button("nav button", "All movies"));
    await online.click("Open the long-subtitles movie", poster("Long subtitles"));
    await online.click(
      "Download it, held by the provider at 40 kB",
      button('[role="dialog"] button', "Download"),
    );
    await online.wait(async () => (await online.text('[role="dialog"]')).includes("%"));
    await online.key("Escape", 27);
    await online.click("Open the index-at-the-end movie", poster("Index at the end"));
    const filesBefore = provider.fileRequests();
    await online.click(
      "Play it from the same subscription",
      button('[role="dialog"] button', "Play"),
    );
    await online.wait(async () => {
      const v = await online.video();
      return v.title && !v.paused && v.width > 0 && v.time > 1;
    }, 45_000);
    const waiting = (await online.listed()).find(
      (item) => item.name.includes("Long") || item.status.kind === "waiting",
    );
    observed["preemption"] = {
      downloadStatusWhilePlaying: waiting?.status.kind ?? null,
      mostProviderFilesAtOnce: provider.mostFilesAtOnce(),
      providerFileRequestsForPlayback: provider.fileRequests() - filesBefore,
      playback: await online.video(),
    };
    await online.capture("playing-while-download-waits");
    if (waiting?.status.kind !== "waiting")
      throw new Error("The download didn't wait for playback.");
    if (provider.mostFilesAtOnce() !== 1) throw new Error("The provider saw two files at once.");
    await online.key("Escape", 27);
    await online.wait(async () => !(await online.video()).title);
    await online.key("Escape", 27);
    await online.click("Open Downloads", button("header button", "Downloads"));
    await online.wait(
      async () => (await online.listed()).every((item) => item.status.kind === "complete"),
      60_000,
    );
    observed["afterPlaybackDownloads"] = (await online.listed()).map((item) => [
      item.name,
      item.status.kind,
    ]);
    if (provider.mostFilesAtOnce() !== 1) throw new Error("The provider saw two files at once.");

    // 3. Failure, retry, delete and cancel through the page and the details.
    await online.click("Open Movies", button("header button", "Movies"));
    await online.click("Open All movies", button("nav button", "All movies"));
    await online.click("Open the missing-file movie", poster("Missing file"));
    await online.click(
      "Download a file the provider doesn't have",
      button('[role="dialog"] button', "Download"),
    );
    await online.wait(async () => (await online.text('[role="dialog"]')).includes("Retry"));
    const retried = provider.fileRequests();
    await online.click(
      "Retry from the details",
      `[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.includes('Retry'))`,
    );
    await online.wait(async () => provider!.fileRequests() > retried);
    await online.key("Escape", 27);
    const held = provider.titles.movies.find((each) =>
      each.name.startsWith("TEST | Index with a gap"),
    )!;
    provider.stallMovieFile(held.id, 30_000, 60_000);
    await online.click("Open the index-with-a-gap movie", poster("Index with a gap"));
    await online.click(
      "Download it, held by the provider",
      button('[role="dialog"] button', "Download"),
    );
    await online.wait(async () => (await online.text('[role="dialog"]')).includes("%"));
    await online.key("Escape", 27);
    await online.click("Open Downloads", button("header button", "Downloads"));
    await online.wait(async () => (await online.text()).includes("The provider has no file"));
    await online.capture("downloads-queue-and-copies");
    const heldId = await idOf(online, "movie", held.id);
    const missingId = await idOf(
      online,
      "movie",
      provider.titles.movies.find((each) => each.name.startsWith("TEST | Missing file"))!.id,
    );
    await online.click("Cancel the held download", `(${row(heldId)})?.querySelector('button')`);
    await online.wait(
      async () => provider!.activeStreams() === 0 && !(await online.exists(row(heldId))),
    );
    await online.click(
      "Delete the failed download",
      `[...(${row(missingId)})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === 'Delete')`,
    );
    await online.wait(async () => !(await online.exists(row(missingId))));
    observed["afterCancelAndDelete"] = (await online.listed()).map((item) => [
      item.name,
      item.status.kind,
    ]);
    await online.capture("downloads-after-cancel-delete");
    await quit("online");

    // 4. Offline: the provider, TMDB and pictures are gone. Play the movie's copy, seek, change
    // its sound, leave and resume.
    await provider.close();
    await tmdb.close();
    await new Promise<void>((resolve) => pictures!.close(() => resolve()));
    actions.push({ action: "Stop the fake provider, TMDB and picture server", at: now() });
    const offline = await start("network denied");
    await offline.wait(() => offline.exists("document.querySelector('header')"));
    await offline.click("Open Downloads", button("header button", "Downloads"));
    // The movie, the episode, and the movie that waited for playback.
    await offline.wait(async () => (await offline.listed()).length === 3);
    await offline.capture("downloads-offline");
    const movieId = await idOf(
      offline,
      "movie",
      provider.titles.movies.find((each) => each.name.startsWith("TEST | Two sound tracks"))!.id,
    );
    const episodeId = await idOf(offline, "episode");
    const playedFrom = Date.now();
    const requestsFrom = windowRequests.length;
    await watchOffline(offline, movieId, "Watch the movie offline");
    await offline.capture("copy-playing");
    const beforeSeek = (await offline.video()).time;
    await offline.key("ArrowRight", 39);
    await offline.wait(async () => (await offline.video()).time >= beforeSeek + 8);
    await offline.wait(async () => !(await offline.video()).paused);
    observed["seek"] = { from: beforeSeek, to: (await offline.video()).time };
    await offline.click("Open Sound", labelled("Sound"));
    const sounds = await offline.page.evaluate<string[]>(
      "[...document.querySelectorAll('[role=dialog] [role=menuitemradio], [role=dialog] button[aria-pressed]')].map(b => b.textContent.trim())",
    );
    observed["soundTracks"] = sounds;
    await offline.click(
      "Choose the other sound track",
      "[...document.querySelectorAll('[role=dialog] button[aria-pressed=false], [role=dialog] [role=menuitemradio][aria-checked=false]')][0]",
    );
    await offline.wait(async () => {
      const v = await offline.video();
      return !v.paused && v.audio > 0 && v.time > 1;
    }, 45_000);
    observed["afterTrackChange"] = await offline.video();
    await offline.capture("copy-other-sound");
    await offline.key("Escape", 27);
    await offline.wait(async () => !(await offline.video()).title);

    // The 20-second movie is all credits: resume and subtitles go by the 150-second one.
    const longId = await idOf(offline, "movie", slow.id);
    await watchOffline(offline, longId, "Watch the long-subtitles movie offline");
    for (let skip = 0; skip < 4; skip++) await offline.key("ArrowRight", 39);
    await offline.click("Open Subtitles", labelled("Subtitles"));
    await offline.click(
      "Choose the file's French text track",
      `[...document.querySelectorAll('aside[aria-label="Subtitle choices"] button[aria-pressed]')].find(b => b.textContent.trim() === 'Français')`,
    );
    await offline.click("Close Subtitles", labelled("Close subtitles"));
    await offline.wait(async () => {
      const v = await offline.video();
      return !v.paused && v.time >= 40;
    }, 45_000);
    await offline.wait(
      () =>
        offline.page.evaluate<boolean>(
          "[...document.querySelector('video').textTracks].some(t => t.kind === 'subtitles' && (t.cues?.length ?? 0) > 0)",
        ),
      45_000,
    );
    observed["embeddedSubtitleCues"] = await offline.page.evaluate<number>(
      "[...document.querySelector('video').textTracks].filter(t => t.kind === 'subtitles').reduce((n, t) => n + (t.cues?.length ?? 0), 0)",
    );
    await offline.capture("copy-subtitles");
    const leftAt = (await offline.video()).time;
    await offline.key("Escape", 27);
    await offline.wait(async () => !(await offline.video()).title);
    await offline.wait(
      async () =>
        ((await offline.listed()).find((item) => item.id === longId)?.progress?.position ?? 0) >=
        leftAt - 2,
    );
    await watchOffline(offline, longId, "Resume the long-subtitles movie offline");
    const resumedAt = (await offline.video()).time;
    observed["resume"] = { leftAt, resumedAt };
    if (resumedAt < leftAt - 8) throw new Error("The copy didn't resume where it was left.");
    await offline.key("Escape", 27);
    await offline.wait(async () => !(await offline.video()).title);
    const playedUntil = Date.now();
    observed["offlinePlayback"] = during(playedFrom, playedUntil, requestsFrom);

    // 5. Remove the subscription through Settings, restart, and play both copies with none saved.
    await offline.click("Open Settings", labelled("Settings"));
    await offline.click("Open Subscriptions", button("nav button", "Subscriptions"));
    const subscriptionRow = `[...document.querySelectorAll('li')].find(r => r.querySelector('button')?.textContent.includes(' · '))`;
    for (let attempt = 1; ; attempt++) {
      await offline.click(
        `Open the subscription (attempt ${attempt})`,
        `(${subscriptionRow})?.querySelector('button')`,
      );
      const opened = await offline
        .wait(() => offline.exists(`(${subscriptionRow})?.querySelector('[role=region]')`), 3000)
        .then(
          () => true,
          () => false,
        );
      if (opened) break;
      if (attempt === 3) throw new Error("The subscription's row didn't open.");
    }
    await offline.click(
      "Ask to remove it",
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Remove '))`,
    );
    await offline.wait(async () => (await offline.text()).includes("from this device?"));
    await offline.capture("remove-subscription-question");
    await offline.click("Confirm removal", button("button", "Remove"));
    await offline.wait(() => offline.exists("document.querySelector('form input')"), 30_000);
    await offline.wait(() => offline.exists(button("button", "Downloads")));
    await offline.capture("connect-with-downloads");
    await quit("network denied");

    const alone = await start("no subscription");
    await alone.click("Open Downloads from Connect", button("button", "Downloads"));
    await alone.wait(async () => (await alone.listed()).length === 3);
    await alone.wait(async () => (await alone.text()).includes("Subscription removed, copy kept"));
    observed["standalone"] = {
      items: (await alone.listed()).map((item) => ({
        name: item.name,
        status: item.status.kind,
        subscription: item.subscription,
        progress: item.progress,
        poster: item.posterUrl,
      })),
      artworkLoaded: await alone.page.evaluate<number>(
        "[...document.querySelectorAll('img')].filter(i => i.src.startsWith('mrstreamer:') && i.naturalWidth > 0).length",
      ),
    };
    await alone.capture("downloads-without-subscription");
    const aloneFrom = Date.now();
    const aloneRequests = windowRequests.length;
    await watchOffline(alone, episodeId, "Watch the episode offline");
    await alone.capture("episode-playing-without-subscription");
    await alone.key("Escape", 27);
    await alone.wait(async () => !(await alone.video()).title);
    await watchOffline(alone, longId, "Resume the long movie without a subscription");
    observed["resumeWithoutSubscription"] = await alone.video();
    await alone.key("Escape", 27);
    await alone.wait(async () => !(await alone.video()).title);
    observed["playbackWithoutSubscription"] = during(aloneFrom, Date.now(), aloneRequests);
    await alone.click("Back to the form", button("button", "Add subscription"));
    await alone.wait(() => alone.exists("document.querySelector('form input')"));
    await quit("no subscription");

    for (const name of ["offlinePlayback", "playbackWithoutSubscription"]) {
      const seen = observed[name] as ReturnType<typeof during>;
      if (seen.main.length > 0 || seen.window.length > 0)
        throw new Error(`${name} reached beyond the app's loopback proxy: ${JSON.stringify(seen)}`);
    }

    /** What main and the window asked of the network between two moments, but the proxy's own. */
    function during(from: number, until: number, requestsFrom: number) {
      const lines = readLines(networkLog).filter((line) => line.at >= from && line.at <= until);
      const local = (url: string) =>
        /^(mrstreamer:|data:|blob:|file:|http:\/\/127\.0\.0\.1:\d+\/(title|source)\/)/.test(url);
      return {
        main: lines.filter((line) => line.kind !== "ipc"),
        window: windowRequests
          .slice(requestsFrom)
          .filter((request) => request.at <= until && !local(request.url)),
        windowRequests: windowRequests.slice(requestsFrom).filter((request) => request.at <= until)
          .length,
      };
    }
  } catch (error) {
    failed = error;
    if (running) {
      const shot = await running.page
        .send("Page.captureScreenshot", { format: "png" })
        .catch(() => undefined);
      if (record(shot?.result) && typeof shot.result["data"] === "string")
        await writeFile(join(evidence, "failure.png"), Buffer.from(shot.result["data"], "base64"));
    }
  } finally {
    const clean = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    };
    if (running) {
      const owned = running;
      await clean(() => stop(owned.app, owned.page));
      owned.page.close();
    }
    if (provider) await clean(() => provider!.close().catch(() => {}));
    if (tmdb) await clean(() => tmdb!.close().catch(() => {}));
    if (pictures?.listening)
      await clean(() => new Promise<void>((resolve) => pictures!.close(() => resolve())));
    observed["mainNetwork"] = summarise(readLines(networkLog), observed["fixturePorts"]);
    if (profile && (!running || running.app.exitCode !== null || running.app.signalCode !== null))
      await clean(() => rm(profile!, { recursive: true, force: true, maxRetries: 5 }));
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (cleanupErrors.length) failed ??= new Error(cleanupErrors.join("\n"));
    await writeFile(join(evidence, "electron.log"), log.join(""));
    await writeFile(
      join(evidence, "proof.json"),
      JSON.stringify(
        {
          scenario: "downloads",
          status: failed ? "failed" : "passed",
          actions,
          observed,
          error: failed ? String(failed) : null,
          cleanup: {
            profileRemoved: profile
              ? await access(profile).then(
                  () => false,
                  () => true,
                )
              : true,
            errors: cleanupErrors,
          },
          limits: [
            "Fake provider/TMDB and a loopback picture server; no real subscription acceptance",
            "Development build on this platform; no installer or native-platform proof",
            "Decoded audio does not prove audible output",
            "Main's connections are recorded in JavaScript; Chromium's own, over CDP",
          ],
        },
        null,
        2,
      ),
    );
    console.log(`${failed ? "FAIL" : "PASS"} downloads: ${evidence}`);
  }
  if (failed) throw failed;
}

function now(): string {
  return new Date().toISOString();
}

/** Every connection network-hook.cjs wrote down. */
function readLines(path: string): Connection[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Connection);
  } catch {
    return [];
  }
}

/** Main's connections by where they went, with the fixtures named. */
function summarise(lines: readonly Connection[], fixtures: unknown) {
  const ports = new Set(Array.isArray(fixtures) ? fixtures : []);
  const by = new Map<string, number>();
  for (const line of lines) {
    if (line.kind === "ipc") continue;
    const where =
      line.kind === "artwork"
        ? `artwork ${line.host}`
        : `${line.kind} ${line.host}:${line.port}${ports.has(line.port) ? " (fixture)" : ""}`;
    by.set(where, (by.get(where) ?? 0) + 1);
  }
  return Object.fromEntries(by);
}

/** Answers every path with a picture of its own colour, as an artwork CDN would. */
async function pictureServer(): Promise<Server> {
  const server = createServer((request, response) => {
    const [r, g, b] = createHash("sha256")
      .update(request.url ?? "/")
      .digest();
    response
      .writeHead(200, { "Content-Type": "image/png" })
      .end(solidPng(300, 450, [r! / 2 + 40, g! / 2 + 40, b! / 2 + 40]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

/** A PNG of one colour. */
function solidPng(width: number, height: number, rgb: readonly number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const line = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) line.set(rgb.map(Math.round), 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => line));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
