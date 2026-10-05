// Opens Apple's list of AirPlay receivers through a development build's real window on macOS,
// and checks where the app asks for it and when it takes it down again. The window's place, the
// page's zoom and the mini player are Electron's, so only a real window shows them.
//
//   node test/e2e/airplay-list.ts node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
//
// From `apps/desktop`, after `pnpm build`. It plays an episode here and opens the list with O: at
// the output button, where it moves the window under the list, then with the page zoomed, and
// from the mini player. It has a TV play, and minimises and closes the window under a list opened
// again. It passes when each list was asked for where the button was on screen at that moment,
// when a window that moved or went out of sight took its list down and nothing else, and when a
// window out of sight opened none.
//
// The helper is the suite's stand-in (../fake-airplay-helper.ts), which shows no list: it says
// where the app asked for one and when the app took it back. See airplay-tv.ts for how the app
// comes to start it, and for what the script needs of the Mac. The window never goes full screen,
// and nothing is typed or clicked on the Mac itself: keys and window calls go through the app's
// own inspectors.
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
if (!executable) throw new Error("Usage: node test/e2e/airplay-list.ts <Electron> [-- args]");
if (process.platform !== "darwin") throw new Error("Apple's list of receivers is macOS's.");
if (lanAddresses().length === 0) {
  throw new Error("This computer has no address on a local network for a TV to reach.");
}

const work = mkdtempSync(join(tmpdir(), "mr-streamer-airplay-list-"));
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

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The app's window and Electron's `screen` in its main process, for the inspector. */
const ELECTRON = `process.getBuiltinModule("node:module").createRequire(process.cwd() + "/")("electron")`;
const WINDOW = `${ELECTRON}.BrowserWindow.getAllWindows()[0]`;
/** Where the window's page is on screen, in points. */
const content = () => main.evaluate<Box>(`${WINDOW}.getContentBounds()`);
/**
 * Where the output button is on screen now, in points. The page's own pixels count `zoom` points
 * each: what the page draws a pixel with, over what the display draws a point with.
 */
async function button(page: Page): Promise<Box & { readonly zoom: number }> {
  const at = await content();
  const scale = await main.evaluate<number>(
    `${ELECTRON}.screen.getDisplayMatching(${WINDOW}.getBounds()).scaleFactor`,
  );
  const seen = await page.evaluate<{ box: Box; ratio: number }>(`(() => {
    const box = document.querySelector("[data-output]").getBoundingClientRect();
    return {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      ratio: devicePixelRatio,
    };
  })()`);
  const zoom = seen.ratio / scale;
  return {
    x: at.x + seen.box.x * zoom,
    y: at.y + seen.box.y * zoom,
    width: seen.box.width * zoom,
    height: seen.box.height * zoom,
    zoom,
  };
}
const near = (one: Box, other: Box) =>
  (["x", "y", "width", "height"] as const).every((side) => Math.abs(one[side] - other[side]) <= 1);
const text = (box: Box) =>
  `${box.x.toFixed(0)},${box.y.toFixed(0)} ${box.width.toFixed(0)}x${box.height.toFixed(0)}`;

/** How often the app asked for Apple's list, and how often it took one back. */
const sent = (cmd: "showPicker" | "hidePicker") =>
  helper.commands.filter((command) => command.cmd === cmd).length;
/** Presses O and gives the place the app then asked for the list at. */
async function openList(page: Page): Promise<Box> {
  const before = sent("showPicker");
  await key(page, "o", 79);
  await waitFor(async () => sent("showPicker") > before, 20_000);
  const asked = helper.commands.findLast((command) => command.cmd === "showPicker");
  if (asked?.cmd !== "showPicker") throw new Error("The app asked for no list.");
  return asked.anchor;
}
/** Whether the app took a list back since `before` of them, within a few seconds. */
const tookBack = (before: number) =>
  waitFor(async () => sent("hidePicker") > before, 5000).then(
    () => true,
    () => false,
  );

const output = async (page: Page) =>
  (
    await page.evaluate<{
      value?: { output: { kind: string; media?: { state: string } | null } };
    }>(`window.mrStreamer.invoke("output.status")`)
  ).value?.output;
const clock = (page: Page) =>
  page.evaluate<number>(`document.querySelector("video")?.currentTime ?? 0`);

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
 * The TV takes the app's next load, fetches the piece it starts at, and says it plays. Gives the
 * address it plays from, and how many commands the helper had taken by then.
 */
async function tvPlays(): Promise<{ readonly url: string; readonly since: number }> {
  const load = await within("the app sends the TV a stream", 40_000, helper.took("load"));
  const get = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(25_000) }).catch(() => null);
    return response?.ok ? Buffer.from(await response.arrayBuffer()) : null;
  };
  const segments = await segmentsOf(load.url, get);
  const at = segments.find((each) => each.start + each.length > load.position) ?? segments[0];
  if (at) await get(at.url);
  const last = segments.at(-1);
  helper.status("playing", load.position, last ? last.start + last.length : 0);
  return { url: load.url, since: helper.commands.length };
}
/**
 * What the TV lost of what it played, or null when it has it all: connected and playing, in the
 * helper it was given to, which was told nothing that ends it.
 */
async function tvLost(page: Page, tv: Awaited<ReturnType<typeof tvPlays>>): Promise<string | null> {
  const now = await output(page);
  if (now?.kind !== "receiver" || now.media?.state !== "playing") {
    return `output ${now?.kind}, ${now?.media?.state ?? "no media"}`;
  }
  const ended = helper.commands
    .slice(tv.since)
    .filter(
      (command) => command.cmd === "stop" || command.cmd === "unload" || command.cmd === "quit",
    );
  if (ended.length > 0) return `the helper was told ${ended.map((each) => each.cmd).join(", ")}`;
  if (helper.running().length !== 1) return "the helper was started again";
  const answers = await fetch(tv.url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return answers?.ok ? null : "its stream no longer answers";
}

let broke = false;
try {
  const page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page, provider);
  await playEpisode(page);
  await waitFor(async () => (await clock(page)) > 0.5, 30_000);

  // O opens the list at the output button, where it is on screen.
  let asked = await openList(page);
  let at = await button(page);
  check(near(asked, at), "The list is asked for at the output button", `${text(asked)}`);

  // The window moves under the list: the list goes, and what plays here plays on.
  let hidden = sent("hidePicker");
  const before = await clock(page);
  await main.evaluate(`(() => {
    const [x, y] = ${WINDOW}.getPosition();
    ${WINDOW}.setPosition(x + 40, y + 30);
  })()`);
  const moved = await tookBack(hidden);
  await waitFor(async () => (await output(page))?.kind === "local", 5000).catch(() => {});
  await waitFor(async () => (await clock(page)) > before, 5000).catch(() => {});
  check(
    moved && (await output(page))?.kind === "local" && (await clock(page)) > before,
    "A window that moves takes its list down, and the episode plays on here",
    `output ${(await output(page))?.kind}`,
  );

  // Zoomed, the page's pixels are larger than the screen's points, and the button is elsewhere.
  at = await button(page);
  await main.evaluate(`${WINDOW}.webContents.setZoomFactor(1.25)`);
  await waitFor(async () => (await button(page)).zoom > 1.2, 10_000);
  asked = await openList(page);
  const zoomed = await button(page);
  check(
    near(asked, zoomed) && !near(zoomed, at),
    "With the page zoomed, it is asked for where the button is then",
    `${text(asked)}, the button at ${text(zoomed)}, unzoomed at ${text(at)}`,
  );
  await main.evaluate(`${WINDOW}.webContents.setZoomFactor(1)`);
  await waitFor(async () => (await button(page)).zoom < 1.05, 10_000);

  // From the mini player, which has no output button: the window goes back first.
  await key(page, "p", 80);
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector("[data-mini]")`), 10_000);
  await delay(1000);
  const mini = await content();
  hidden = sent("hidePicker");
  asked = await openList(page);
  await waitFor(() => page.evaluate<boolean>(`!document.querySelector("[data-mini]")`), 10_000);
  at = await button(page);
  check(
    near(asked, at) && (await content()).width > mini.width,
    "From the mini player, it is asked for at the button of the window put back",
    `${text(asked)}, the button at ${text(at)}, the mini player was at ${text(mini)}`,
  );
  // What the window still does as it settles takes no list down that was asked for after.
  await delay(2000);
  check(sent("hidePicker") === hidden, "The list stays up once the window is back");

  // The viewer picks the TV in that list, and the list opens on it again as it plays. Minimised,
  // the window takes the list down and leaves the TV what it plays.
  helper.choose();
  const tv = await tvPlays();
  await waitFor(says(page, "Playing over AirPlay", "[data-view=title]"), 20_000);
  await openList(page);
  hidden = sent("hidePicker");
  await main.evaluate(`${WINDOW}.minimize()`);
  const minimised = await tookBack(hidden);
  let lost = await tvLost(page, tv);
  check(
    minimised && lost === null,
    "A minimised window takes its list down, and the TV plays on",
    lost ?? "",
  );
  await main.evaluate(`${WINDOW}.restore()`);
  await waitFor(() => main.evaluate<boolean>(`${WINDOW}.isVisible()`), 10_000);
  await delay(1000);

  // Closed while the TV plays, the window only goes out of sight, and its list goes with it.
  await openList(page);
  hidden = sent("hidePicker");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await main.evaluate(`${WINDOW}.close()`);
  const closed = await tookBack(hidden);
  await waitFor(async () => !(await main.evaluate<boolean>(`${WINDOW}.isVisible()`)), 10_000);
  lost = await tvLost(page, tv);
  check(
    closed && lost === null,
    "A closed window takes its list down, and the TV plays on",
    lost ?? "",
  );

  // Out of sight, the window has no place for a list: one asked for now opens nowhere.
  const lists = sent("showPicker");
  const answer = await page.evaluate<{ ok: boolean; value?: { output: { kind: string } } }>(
    `window.mrStreamer.invoke("output.pick", { anchor: { x: 10, y: 10, width: 10, height: 10 } })`,
  );
  await delay(500);
  check(
    answer.ok && answer.value?.output.kind === "receiver" && sent("showPicker") === lists,
    "A window out of sight opens no list",
    `answered ${answer.ok ? answer.value?.output.kind : "an error"}`,
  );
  page.close();
  main.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  console.error(
    `     The helper's last commands: ${helper.commands
      .slice(-8)
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
