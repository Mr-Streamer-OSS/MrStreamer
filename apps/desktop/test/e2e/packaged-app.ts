// Smoke test for a built app: connects it to the fake provider through the login form, then plays
// a stream the player decodes directly and one the bundled ffmpeg has to convert. Then it leaves
// Watch for Home and comes back, which must keep the one stream rather than open another. Last, it
// plays a movie from Movies, which the bundled ffprobe reads and ffmpeg repackages, skips ahead and
// leaves it.
//
//   node test/e2e/packaged-app.ts <app executable> [-- extra app arguments]
//
// Passes when both channels show a moving picture with decoded sound, Home and Watch share the
// stream: muted on Home, with sound in Watch, and no second request to the provider, and the movie
// plays with sound, skips 10 seconds and lets go of its connection when left. The app runs with a
// throwaway profile and remote debugging on a random port; on macOS pass --use-mock-keychain so
// the test never touches a real keychain.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeProvider } from "../fake-provider.ts";
import { connect, delay, key, launch, login, waitFor, type Page } from "./app.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) throw new Error("Usage: node test/e2e/packaged-app.ts <app executable> [-- args]");

const CHANNELS = ["TEST | H.264 + AAC", "TEST | H.264 + MP2"];
const port = 20000 + Math.floor(Math.random() * 20000);
const profile = mkdtempSync(join(tmpdir(), "mr-streamer-e2e-"));
const provider = await startFakeProvider({ channels: 60, live: true });
const app = launch(executable, rest, { port, profile });

let failed = false;
try {
  const page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page, provider);
  for (const channel of CHANNELS) {
    const result = await play(page, channel);
    console.log(`${result.ok ? "PASS" : "FAIL"} ${channel}: ${result.detail}`);
    failed ||= !result.ok;
  }
  const shared = await homeAndBack(page);
  console.log(`${shared.ok ? "PASS" : "FAIL"} Home and Watch share one stream: ${shared.detail}`);
  failed ||= !shared.ok;
  const movie = await playMovie(page);
  console.log(`${movie.ok ? "PASS" : "FAIL"} A movie plays, skips and lets go: ${movie.detail}`);
  failed ||= !movie.ok;
  page.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  failed = true;
} finally {
  app.kill("SIGKILL");
  await provider.close();
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);

/** Picks a channel through search and waits for picture and sound. */
async function play(page: Page, channel: string): Promise<{ ok: boolean; detail: string }> {
  await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
  await delay(500);
  await page.send("Input.insertText", { text: channel });
  await delay(800);
  await key(page, "Enter", 13);
  const until = Date.now() + 25_000;
  let last = { time: 0, width: 0, audio: 0, title: "" };
  while (Date.now() < until) {
    await delay(250);
    last = await page.evaluate(`(() => {
      const video = document.querySelector("video");
      return {
        time: video?.currentTime ?? 0,
        width: video?.videoWidth ?? 0,
        audio: video?.webkitAudioDecodedByteCount ?? 0,
        title: document.querySelector("h2")?.textContent ?? "",
      };
    })()`);
    if (last.time >= 1 && last.width > 0 && last.audio > 0) {
      return {
        ok: true,
        detail: `picture ${last.width} px wide, ${last.audio} bytes of sound decoded`,
      };
    }
  }
  return {
    ok: false,
    detail: `clock ${last.time.toFixed(2)} s, width ${last.width}, sound ${last.audio} bytes, "${last.title}"`,
  };
}

/** Leaves Watch for Home, where the stream plays on muted, then watches it again from there. */
async function homeAndBack(page: Page): Promise<{ ok: boolean; detail: string }> {
  const requests = provider.streamRequests();
  const state = () =>
    page.evaluate<{ watching: boolean; muted: boolean; playing: boolean }>(`(() => {
      const video = document.querySelector("video");
      return {
        watching: !!document.querySelector('[data-view="watch"]'),
        muted: !!video?.muted,
        playing: !!video && video.isConnected && !video.paused,
      };
    })()`);
  await key(page, "Escape", 27);
  await waitFor(async () => !(await state()).watching, 10_000);
  const home = await state();
  await page.evaluate(
    `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Watch").click()`,
  );
  await waitFor(async () => (await state()).watching, 10_000);
  await delay(1000);
  const watch = await state();
  const extra = provider.streamRequests() - requests;
  const ok = home.playing && home.muted && watch.playing && !watch.muted && extra === 0;
  return {
    ok,
    detail: `Home ${home.playing ? "playing" : "stopped"}${home.muted ? " muted" : " with sound"}, Watch ${watch.playing ? "playing" : "stopped"}${watch.muted ? " muted" : " with sound"}, ${extra} more stream requests, ${provider.activeStreams()} open`,
  };
}

/** Plays the test movie with two sound tracks from Movies, skips ahead, then leaves it. */
async function playMovie(page: Page): Promise<{ ok: boolean; detail: string }> {
  await key(page, "Escape", 27);
  await page.evaluate(
    `[...document.querySelectorAll("header button")].find((b) => b.textContent.trim() === "Movies").click()`,
  );
  const poster = `[...document.querySelectorAll("button[title]")].find((b) => b.title.includes("Two sound tracks"))`;
  await waitFor(() => page.evaluate<boolean>(`!!${poster}`), 60_000);
  await page.evaluate(`${poster}.click()`);
  const play = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Play")`;
  await waitFor(() => page.evaluate<boolean>(`!!${play}`), 20_000);
  await page.evaluate(`${play}.click()`);
  const state = () =>
    page.evaluate<{ time: number; width: number; audio: number }>(`(() => {
      const video = document.querySelector("video");
      return {
        time: video?.currentTime ?? 0,
        width: video?.videoWidth ?? 0,
        audio: video?.webkitAudioDecodedByteCount ?? 0,
      };
    })()`);
  let started = { time: 0, width: 0, audio: 0 };
  const until = Date.now() + 30_000;
  while (Date.now() < until && !(started.time >= 1 && started.width > 0 && started.audio > 0)) {
    await delay(250);
    started = await state();
  }
  if (started.time < 1 || started.audio === 0) {
    return {
      ok: false,
      detail: `clock ${started.time.toFixed(2)} s, sound ${started.audio} bytes`,
    };
  }
  await key(page, "ArrowRight", 39);
  await delay(1500);
  const skipped = await state();
  await key(page, "Escape", 27);
  await delay(1500);
  const open = provider.activeStreams();
  const ok = skipped.time >= started.time + 9 && open === 0;
  return {
    ok,
    detail: `played to ${started.time.toFixed(1)} s with ${started.audio} bytes of sound, skipped to ${skipped.time.toFixed(1)} s, ${open} connections open after leaving`,
  };
}
