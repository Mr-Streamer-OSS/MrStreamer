// Plays on a stand-in AirPlay TV through a development build's real window on macOS, and closes
// that window while the TV plays. Only macOS keeps an app running without its window, so only
// there does it show what the window does for a TV: its page counts down to the next episode and
// holds the system's media controls.
//
//   node test/e2e/airplay-tv.ts node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
//
// From `apps/desktop`, after `pnpm build`. It plays an episode here and closes the window while a
// connect is still under way; moves the episode to the TV and closes the window for over a
// minute, pausing and playing on meanwhile; has the TV play to the end; brings the window back
// as the Dock does; closes it again from full screen and has the TV let go; then quits with the
// window closed while the TV plays. It passes when closing left the page running only while the
// TV had playback, the next episode started on the TV ten seconds after the end, the same window
// came back, nothing played here unseen, and quitting ended the TV's playback and the app.
//
// The TV is the suite's stand-in for the AirPlay helper (../fake-airplay-helper.ts). The script
// plays the system, the viewer at Apple's list and the TV, which fetches what it is sent from the
// app's address on the local network as a TV's player would. The app looks for its helper in its
// own folder, so the script starts the built app from a folder it makes, with the stand-in in the
// helper's place; the app itself is as built. It needs a private IPv4 address on an interface
// that isn't a tunnel (see src/main/playback/lan.ts).
//
// The window closes as from its close button, `BrowserWindow.close` through the main process's
// inspector, and comes back by the event a click on the Dock icon sends. `--use-mock-keychain`
// keeps the run away from the real Keychain. The system's media keys are not pressed: they go to
// whatever plays on the Mac. The script reads what the page tells the system instead.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lanAddresses } from "../../src/main/playback/lan.ts";
import { startFakeAirplayHelper } from "../fake-airplay-helper.ts";
import { startFakeProvider } from "../fake-provider.ts";
import { connect, delay, key, launch, login, press, says, waitFor, type Page } from "./app.ts";
import { segmentsOf } from "./tv-player.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) throw new Error("Usage: node test/e2e/airplay-tv.ts <Electron> [-- args]");
if (process.platform !== "darwin") throw new Error("AirPlay and a windowless app are macOS's.");
if (lanAddresses().length === 0) {
  throw new Error("This computer has no address on a local network for a TV to reach.");
}

const work = mkdtempSync(join(tmpdir(), "mr-streamer-airplay-"));
const results: boolean[] = [];
function check(ok: boolean, what: string, detail = ""): void {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
}

/** Fails `what` when it takes longer than `ms`. */
function within<T>(what: string, ms: number, pending: Promise<T>): Promise<T> {
  return Promise.race([
    pending,
    delay(ms).then(() => Promise.reject(new Error(`Timed out: ${what}`))),
  ]);
}

// The app, started from a folder that holds the stand-in where it looks for its AirPlay helper.
const helper = await startFakeAirplayHelper();
const desktop = fileURLToPath(new URL("../..", import.meta.url));
const built = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as {
  readonly productName: string;
  readonly version: string;
  readonly main: string;
};
const folder = join(work, "app");
const standIn = join(folder, "vendor", "airplay", "mac-arm64", "MrStreamerAirPlay");
mkdirSync(join(standIn, ".."), { recursive: true });
symlinkSync(join(desktop, "out"), join(folder, "out"));
writeFileSync(
  join(folder, "package.json"),
  JSON.stringify({
    name: "mrstreamer",
    productName: built.productName,
    version: built.version,
    type: "module",
    main: built.main,
  }),
);
writeFileSync(
  standIn,
  `#!/bin/sh\nexec ${[helper.helper, ...helper.args].map((part) => `'${part}'`).join(" ")}\n`,
  { mode: 0o755 },
);

const provider = await startFakeProvider();
const port = 20000 + Math.floor(Math.random() * 20000);
const app = launch(executable, [`--inspect=${port + 1}`, "--use-mock-keychain", folder, ...rest], {
  port,
  profile: join(work, "profile"),
});
const main = await connect(port + 1, "node");

/** The app's windows in its main process, for the inspector. */
const WINDOWS = `process.getBuiltinModule("node:module")
  .createRequire(process.cwd() + "/")("electron").BrowserWindow.getAllWindows()`;
/** Whether each of the app's windows shows, as the app itself says. */
const windows = () => main.evaluate<boolean[]>(`${WINDOWS}.map((each) => each.isVisible())`);
const fullScreen = () => main.evaluate<boolean>(`${WINDOWS}[0].isFullScreen()`);
/**
 * Closes the window as its close button does. The focus the script lends the page for its keys
 * goes first: Chromium counts it as a capture, and never treats a captured page as hidden.
 */
async function closeWindow(page: Page): Promise<void> {
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await main.evaluate(`${WINDOWS}[0]?.close()`);
}
const shows =
  (...visible: boolean[]) =>
  async () =>
    JSON.stringify(await windows()) === JSON.stringify(visible);
/** What a click on the app's Dock icon sends it: the reopen event. */
function clickDock(): void {
  execFileSync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import("Foundation");
    $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
      0x61657674, 0x72617070,
      $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(${app.pid}), -1, 0
    ).sendEventWithOptionsTimeoutError(1, 5, null);`,
  ]);
}
const pages = async () =>
  ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string }[]).filter(
    (target) => target.type === "page",
  ).length;

const output = async (page: Page) =>
  (
    await page.evaluate<{
      value?: { output: { kind: string; media?: { state: string } | null } };
    }>(`window.mrStreamer.invoke("output.status")`)
  ).value?.output;
const clock = (page: Page) =>
  page.evaluate<number>(`document.querySelector("video")?.currentTime ?? 0`);
/** What the page tells the system's media controls. */
const session = (page: Page) =>
  page.evaluate<{ state: string; title: string; album: string }>(
    `({ state: navigator.mediaSession.playbackState,
        title: navigator.mediaSession.metadata?.title ?? "",
        album: navigator.mediaSession.metadata?.album ?? "" })`,
  );
const onTv = (page: Page, words: string) =>
  says(page, `${words} over AirPlay`, "[data-view=title]");
/** Clicks the title's own Pause or Play button, which needs no focus. */
const click = (page: Page, label: "Pause" | "Play") =>
  page.evaluate(`[...document.querySelectorAll("[data-view=title] button")]
    .find((b) => b.getAttribute("aria-label") === "${label}").click()`);

/** Plays the first episode of the series with three, here or where playback goes. */
async function playEpisode(page: Page): Promise<void> {
  await press(page, "Series");
  const tab = `[...document.querySelectorAll("nav button")].find((b) => b.textContent.trim() === "All series")`;
  await waitFor(() => page.evaluate<boolean>(`!!${tab}`), 60_000);
  await page.evaluate(`${tab}.click()`);
  const poster = `[...document.querySelectorAll("button[title]")].find((b) => b.title.includes("Formats"))`;
  await waitFor(() => page.evaluate<boolean>(`!!${poster}`), 60_000);
  await page.evaluate(`${poster}.click()`);
  const row = `[...document.querySelectorAll('[role="dialog"] button')].find((b) =>
    b.firstElementChild?.tagName === "SPAN" && b.firstElementChild.textContent.trim() === "1")`;
  await waitFor(() => page.evaluate<boolean>(`!!${row}`), 20_000);
  await page.evaluate(`${row}.click()`);
}

/**
 * The TV. It takes the app's next load, reads its playlists and fetches the piece it starts at,
 * as a TV's player does, and says it plays. `position` and `duration` are the stream's.
 */
const served = { pieces: 0, refused: 0 };
async function get(url: string): Promise<Buffer | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) }).catch(() => null);
  if (!response?.ok) served.refused++;
  return response?.ok ? Buffer.from(await response.arrayBuffer()) : null;
}
async function tvPlays(): Promise<{ url: string; position: number; duration: number }> {
  const load = await within("the app sends the TV a stream", 40_000, helper.took("load"));
  const segments = await segmentsOf(load.url, get);
  const at = segments.find((each) => each.start + each.length > load.position) ?? segments[0];
  if (at && (await get(at.url))) served.pieces++;
  const last = segments.at(-1);
  const duration = last ? last.start + last.length : 0;
  helper.status("playing", load.position, duration);
  return { url: load.url, position: load.position, duration };
}
/** Opens the system's list from the player, as O does, and has the viewer pick the TV there. */
async function chooseTv(page: Page): Promise<void> {
  await key(page, "o", 79);
  await within("the app opens Apple's list", 20_000, helper.took("showPicker"));
  helper.choose();
}

let broke = false;
/** The app's window, as far as the script got, for what it showed when a step failed. */
let opened: Page | null = null;
try {
  let page = await connect(port);
  opened = page;
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page, provider);

  // An episode plays here. Closing the window while a connect to a TV is still under way closes
  // it: the stream ends and the connect is given up.
  await playEpisode(page);
  await waitFor(async () => (await clock(page)) > 0.5, 30_000);
  await key(page, "o", 79);
  await within("the app opens Apple's list", 20_000, helper.took("showPicker"));
  await waitFor(says(page, "Connecting over AirPlay"), 10_000);
  await closeWindow(page);
  await waitFor(shows(), 10_000);
  await within("the app closes Apple's list", 10_000, helper.took("hidePicker"));
  await waitFor(async () => provider.activeStreams() === 0, 10_000).catch(() => {});
  check(
    provider.activeStreams() === 0,
    "Closing the window while it plays here ends the stream and a connect under way",
    `${provider.activeStreams()} open`,
  );
  clickDock();
  await waitFor(shows(true), 15_000);
  page.close();
  page = await connect(port);
  opened = page;
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await waitFor(() => page.evaluate<boolean>("!!document.querySelector('header')"), 30_000);
  check((await output(page))?.kind === "local", "The Dock opens a new window, playing here");

  // The episode moves to the TV, and the window closes for over a minute: by then Chromium wakes
  // a hidden page's timers once a minute. The page runs on, out of sight, and works the TV.
  await playEpisode(page);
  await waitFor(async () => (await clock(page)) > 0.5, 30_000);
  await chooseTv(page);
  const first = await tvPlays();
  await waitFor(onTv(page, "Playing"), 20_000);
  await page.evaluate("window.sameWindow = true");
  await closeWindow(page);
  const closedAt = Date.now();
  await waitFor(shows(false), 10_000);
  await click(page, "Pause");
  await within("the page pauses the TV", 10_000, helper.took("pause"));
  helper.status("paused", first.position, first.duration);
  await waitFor(onTv(page, "Paused"), 10_000);
  const paused = await session(page);
  check(
    paused.state === "paused" && paused.album === "S1 E1" && (await pages()) === 1,
    "Closing the window while the TV plays keeps its page, which pauses the TV",
    `the system is told ${paused.state}, ${paused.album}`,
  );
  await delay(Math.max(0, closedAt + 70_000 - Date.now()));
  await click(page, "Play");
  await within("the page plays the TV on", 10_000, helper.took("play"));
  helper.status("playing", first.position, first.duration);
  await waitFor(onTv(page, "Playing"), 10_000);
  const pieces = served.pieces;
  const [next] = (await segmentsOf(first.url, get)).slice(1);
  if (next && (await get(next.url))) served.pieces++;
  check(
    served.pieces > pieces && provider.activeStreams() <= 1,
    "The app serves the TV with the window closed, on the one connection",
    `${provider.activeStreams()} open`,
  );

  // The TV plays to the end: the next episode starts there after the ten seconds, unseen.
  helper.status("ended", first.duration, first.duration);
  const ended = Date.now();
  await tvPlays();
  const waited = (Date.now() - ended) / 1000;
  await waitFor(async () => (await session(page)).album === "S1 E2", 15_000).catch(() => {});
  const following = await session(page);
  check(
    waited > 9 && waited < 16 && following.album === "S1 E2" && following.state === "playing",
    "The next episode starts on the TV ten seconds after the end, with the window closed",
    `${waited.toFixed(1)} s, the system is told ${following.state}, ${following.album}`,
  );

  // The Dock brings the same window back, on what the TV plays now.
  clickDock();
  await waitFor(shows(true), 15_000);
  await waitFor(onTv(page, "Playing"), 10_000);
  check(
    (await page.evaluate<boolean>("window.sameWindow === true")) &&
      (await pages()) === 1 &&
      (await says(page, "S1 E2", "[data-view=title]")()),
    "The Dock brings the same window back, on the TV's controls",
    `${await pages()} window`,
  );

  // Closed again, from full screen, which it leaves first: macOS shows a black screen in place
  // of a full-screen window that hides.
  await main.evaluate(`${WINDOWS}[0].setFullScreen(true)`);
  await waitFor(fullScreen, 15_000);
  await closeWindow(page);
  await waitFor(async () => !(await fullScreen()) && (await shows(false)()), 15_000).catch(
    () => {},
  );
  check(
    !(await fullScreen()) && (await shows(false)()) && (await onTv(page, "Playing")()),
    "A full-screen window leaves full screen as it goes out of sight",
  );

  // The TV lets go: the window closes for good, and nothing plays here unseen.
  helper.external(false);
  await waitFor(shows(), 15_000);
  await delay(3000);
  check(
    provider.activeStreams() === 0 && (await pages()) === 0,
    "A TV that lets go with the window closed closes it, and nothing plays here",
    `${provider.activeStreams()} open`,
  );
  clickDock();
  await waitFor(shows(true), 15_000);
  page.close();
  page = await connect(port);
  opened = page;
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await waitFor(() => page.evaluate<boolean>("!!document.querySelector('header')"), 30_000);

  // Quitting with the window closed while the TV plays ends it, and the app.
  await playEpisode(page);
  await waitFor(async () => (await clock(page)) > 0.5, 30_000);
  await chooseTv(page);
  const last = await tvPlays();
  await waitFor(onTv(page, "Playing"), 20_000);
  await closeWindow(page);
  await waitFor(shows(false), 10_000);
  page.close();
  main.close();
  const asked = Date.now();
  const exited = new Promise<number>((resolve) =>
    app.once("exit", () => resolve(Date.now() - asked)),
  );
  app.kill("SIGTERM");
  const took = await Promise.race([exited, delay(10_000).then(() => null)]);
  const gone = await fetch(last.url).then(
    (response) => !response.ok,
    () => true,
  );
  check(
    app.exitCode === 0 && gone && helper.running().length === 0 && provider.activeStreams() === 0,
    "Quitting with the window closed ends the TV's playback and the app",
    took === null ? "still running after 10 s" : `${took} ms, exit code ${app.exitCode}`,
  );
  check(
    served.refused === 0,
    "The app answered every request of the TV",
    `${served.refused} refused`,
  );
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  // A wait that ran out doesn't say what happened instead. The window and the helper do.
  const view = await opened
    ?.evaluate<string>(
      `(document.querySelector("[data-view]") ?? document.body).innerText.replaceAll("\\n", " | ").slice(0, 400)`,
    )
    .catch(() => null);
  const status = opened ? await output(opened).catch(() => null) : null;
  console.error(`     The window showed: ${view ?? "nothing"}`);
  console.error(
    `     Output ${status?.kind ?? "unknown"}, the helper's last commands: ${helper.commands
      .slice(-6)
      .map((command) => command.cmd)
      .join(", ")}`,
  );
  broke = true;
} finally {
  app.kill("SIGKILL");
  await helper.close();
  await provider.close();
  await delay(1000);
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(broke || results.includes(false) ? 1 : 0);
