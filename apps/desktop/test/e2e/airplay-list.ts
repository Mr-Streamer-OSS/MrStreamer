// Opens Apple's list of AirPlay receivers through a development build's real window on macOS,
// and checks where the app asks for it and when it takes it down again. The window's place, the
// page's zoom and the mini player are Electron's, so only a real window shows them.
//
//   node test/e2e/airplay-list.ts node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
//
// From `apps/desktop`, after `pnpm build`. It plays an episode here and opens the list with O: at
// the output button, where it moves the window under the list, then with the page zoomed, from
// the mini player, and from a mini player that was full screen. It presses P while an O still
// waits for the window. It presses O as the window goes full screen and goes back to this computer
// before the window settled, from here and from a TV that plays. It asks for a list by name as the
// window goes full screen, as the page does, and takes it back by that name and by another's, as
// the page does when a view closes. It has a TV play, and minimises and closes the window under a
// list opened again. It passes when each list was asked for where the button was on screen at
// that moment, when a window that moved or went out of sight took its list down and nothing else,
// when the O that P overtook and the lists given up or taken back before the window settled
// opened none, when a name took down its own list alone, and when a window out of sight opened
// none.
//
// The helper is the suite's stand-in (../fake-airplay-helper.ts), which shows no list: it says
// where the app asked for one and when the app took it back. See airplay-tv.ts for how the app
// comes to start it, and for what the script needs of the Mac. The window fills the screen for a
// few seconds, in a Space of its own that goes with it. Nothing is typed or clicked on the Mac
// itself: keys and window calls go through the app's own inspectors.
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

/**
 * How each thing the script started ends, in the order they started. `takeDown` runs them from
 * the last, however the script goes, so a start that fails halfway ends what it had started and
 * nothing else.
 */
const started: (() => unknown)[] = [];
async function takeDown(): Promise<void> {
  for (const end of started.reverse()) await end();
}

/**
 * The app, started from a folder that holds the stand-in where it looks for its AirPlay helper,
 * with the inspector of its main process.
 */
const start = async () => {
  const work = mkdtempSync(join(tmpdir(), "mr-streamer-airplay-list-"));
  started.push(() => rmSync(work, { recursive: true, force: true, maxRetries: 5 }));
  const helper = await startFakeAirplayHelper();
  started.push(() => helper.close());
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
  started.push(() => provider.close());
  const port = 20000 + Math.floor(Math.random() * 20000);
  const app = launch(
    executable,
    [`--inspect=${port + 1}`, "--use-mock-keychain", folder, ...rest],
    { port, profile: join(work, "profile") },
  );
  // Killed, the app takes a moment to let go of its profile, which the folder holds.
  started.push(async () => {
    app.kill("SIGKILL");
    await delay(1000);
  });
  // An app that can't start, as from a wrong path, fails the wait for its inspector.
  const main = await Promise.race([
    connect(port + 1, "node"),
    new Promise<never>((_, reject) => app.once("error", reject)),
  ]);
  started.push(() => main.close());
  return { helper, provider, port, main };
};
const { helper, provider, port, main } = await start().catch(async (error: unknown) => {
  await takeDown();
  throw error;
});

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
 * How often the window arrived in full screen and how often it was back out of it, by its own
 * events. macOS takes over half a second for each, and the window says it is full screen from
 * the start of the way there.
 */
const fullScreens = () =>
  main.evaluate<{ readonly arrived: number; readonly left: number }>(`(() => {
    const window = ${WINDOW};
    globalThis.fullScreens ??= (() => {
      const count = { arrived: 0, left: 0 };
      window.on("enter-full-screen", () => count.arrived++);
      window.on("leave-full-screen", () => count.left++);
      return count;
    })();
    return { ...globalThis.fullScreens };
  })()`);
/** Does `act`, and waits until the window has then arrived in full screen, or is back out of it. */
async function until(what: "arrived" | "left", act: () => Promise<unknown>): Promise<void> {
  const before = (await fullScreens())[what];
  await act();
  await waitFor(async () => (await fullScreens())[what] > before, 10_000);
}
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
/**
 * Presses F and waits until the window says it is on its way into full screen, from where the
 * app holds a list back until the window has settled there. Gives how often the window had
 * arrived in full screen before.
 */
async function startsFilling(page: Page): Promise<number> {
  const { arrived } = await fullScreens();
  await key(page, "f", 70);
  while (!(await main.evaluate<boolean>(`${WINDOW}.isFullScreen()`))) await delay(5);
  return arrived;
}
/** Presses F, and O once the window is on its way into full screen. */
async function listWhileFilling(page: Page): Promise<number> {
  const arrived = await startsFilling(page);
  await key(page, "o", 79);
  return arrived;
}
/** What the main process answered a call from the page with. */
interface Answer {
  readonly ok: boolean;
  readonly value?: { readonly output: { readonly kind: string } };
}
/**
 * Asks for a list as the page does, under a name the script knows. The answer comes once the
 * viewer is done at the list or it was given up, and is waited for later: a call that fails
 * meanwhile fails there.
 */
function pickAs(page: Page, request: string): Promise<Answer> {
  const answer = page.evaluate<Answer>(
    `window.mrStreamer.invoke("output.pick", { anchor: { x: 10, y: 10, width: 10, height: 10 }, request: ${JSON.stringify(request)} })`,
  );
  answer.catch(() => {});
  return answer;
}
/** Takes the list of that name back, as the page does when the view it was asked from closes. */
const takeBack = (page: Page, request: string) =>
  page.evaluate(
    `window.mrStreamer.invoke("output.closePicker", { request: ${JSON.stringify(request)} })`,
  );
/**
 * Whether the window is still on its way into full screen for the first time since `arrived`,
 * and then waits until it has been there for a second, well past the time it takes to settle.
 */
async function settles(arrived: number): Promise<boolean> {
  const onItsWay = (await fullScreens()).arrived === arrived;
  await waitFor(async () => (await fullScreens()).arrived > arrived, 10_000);
  await delay(1000);
  return onItsWay;
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
  started.push(() => page.close());
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

  // From a mini player that was full screen, the window fills the screen again first. The page
  // has full screen at once, and the window changes size on its way there: a list asked for
  // before it arrived would hang from where the button was, and go with the next change.
  const shrinks = async () => {
    await key(page, "p", 80);
    await waitFor(async () => (await content()).width <= mini.width + 1, 10_000);
    await delay(1000);
  };
  // The episode lasts twelve seconds, and its end takes the place of the controls the output
  // button is in.
  const fromItsStart = async () => {
    await key(page, "ArrowLeft", 37);
    await waitFor(async () => {
      const at = await clock(page);
      return at > 0.2 && at < 3;
    }, 20_000);
  };
  await fromItsStart();
  await until("arrived", () => key(page, "f", 70));
  await shrinks();
  hidden = sent("hidePicker");
  await until("arrived", async () => (asked = await openList(page)));
  at = await button(page);
  check(
    near(asked, at) && (await content()).width > mini.width,
    "From a mini player that was full screen, it is asked for at the button of the window full screen again",
    `${text(asked)}, the button at ${text(at)}, the page at ${text(await content())}`,
  );
  await delay(2000);
  check(sent("hidePicker") === hidden, "The list stays up once the window fills the screen");

  // P while an O still waits for the window: the viewer took the full window away again, so no
  // list opens over the mini player, and the next way back is to full screen as before. P comes
  // before the window is back at its size, or just after, when it has begun to fill the screen:
  // either way the window has shrunk again well within three seconds.
  await shrinks();
  let lists = sent("showPicker");
  await key(page, "o", 79);
  await key(page, "p", 80);
  await delay(3000);
  const small = await content();
  const overtaken =
    sent("showPicker") === lists &&
    small.width <= mini.width + 1 &&
    (await page.evaluate<boolean>(`!!document.querySelector("[data-mini]")`)) &&
    !(await main.evaluate<boolean>(`${WINDOW}.isFullScreen()`));
  const filled = await until("arrived", () => key(page, "p", 80)).then(
    () => true,
    () => false,
  );
  check(
    overtaken && filled,
    "P while O waits for the window leaves the mini player and no list, and P again fills the screen",
    `${sent("showPicker") - lists} lists asked for, the mini player at ${text(small)}`,
  );
  if (filled) await until("left", () => key(page, "f", 70));
  await delay(1000);

  // O as the window goes full screen waits until the window has settled there. Going back to
  // this computer before that is the viewer's last word, and no list opens after it.
  await fromItsStart();
  lists = sent("showPicker");
  let arrived = await listWhileFilling(page);
  await page.evaluate(`window.mrStreamer.invoke("output.disconnect")`);
  let waited = await settles(arrived);
  check(
    waited && sent("showPicker") === lists && (await output(page))?.kind === "local",
    "A list given up while its window still fills the screen opens none once it has",
    `${sent("showPicker") - lists} lists asked for, given up ${waited ? "before" : "after"} the window arrived`,
  );
  // The next O is its own.
  asked = await openList(page);
  at = await button(page);
  check(near(asked, at), "The O after it opens the list at the button", `${text(asked)}`);
  await until("left", () => key(page, "f", 70));
  await delay(1000);

  // A view that closes takes back the list it asked for, by the name it gave it. The window
  // stands still, so nothing but that word keeps the list from opening once the window has
  // settled, and the episode plays on here.
  await fromItsStart();
  lists = sent("showPicker");
  arrived = await startsFilling(page);
  let named = pickAs(page, "closed");
  await takeBack(page, "closed");
  let answer = await within("the list taken back answers", 10_000, named);
  waited = await settles(arrived);
  let here = await clock(page);
  await waitFor(async () => (await clock(page)) > here, 20_000).catch(() => {});
  check(
    waited &&
      answer.ok &&
      sent("showPicker") === lists &&
      (await output(page))?.kind === "local" &&
      (await clock(page)) > here,
    "A list taken back by its name while its window still fills the screen opens none once it has, and the episode plays on here",
    `${sent("showPicker") - lists} lists asked for, output ${(await output(page))?.kind}, taken back ${waited ? "before" : "after"} the window arrived`,
  );
  await until("left", () => key(page, "f", 70));
  await delay(1000);

  // Another list's name takes nothing from this one, however late it comes: the list opens once
  // the window has settled. Its own name then takes it down, open, and nothing else.
  await fromItsStart();
  lists = sent("showPicker");
  hidden = sent("hidePicker");
  arrived = await startsFilling(page);
  named = pickAs(page, "open");
  await takeBack(page, "closed");
  waited = await settles(arrived);
  const opened = sent("showPicker") - lists;
  await takeBack(page, "open");
  const taken = await tookBack(hidden);
  answer = await within("the list taken down answers", 10_000, named);
  await waitFor(async () => (await output(page))?.kind === "local", 5000).catch(() => {});
  here = await clock(page);
  await waitFor(async () => (await clock(page)) > here, 20_000).catch(() => {});
  check(
    waited &&
      opened === 1 &&
      taken &&
      answer.ok &&
      (await output(page))?.kind === "local" &&
      (await clock(page)) > here,
    "Another list's name leaves a list to open once its window has settled, and its own takes it down with the episode playing on here",
    `${opened} lists asked for, ${taken ? "taken down" : "left up"}, output ${(await output(page))?.kind}, the other name ${waited ? "before" : "after"} the window arrived`,
  );
  await until("left", () => key(page, "f", 70));
  await delay(1000);

  // The same from a TV that plays, where Play here is that last word: the episode comes back
  // here, and no list opens over it.
  await fromItsStart();
  await openList(page);
  helper.choose();
  await tvPlays();
  await waitFor(says(page, "Playing over AirPlay", "[data-view=title]"), 20_000);
  lists = sent("showPicker");
  arrived = await listWhileFilling(page);
  await press(page, "Play here");
  waited = await settles(arrived);
  await waitFor(async () => (await output(page))?.kind === "local", 10_000).catch(() => {});
  here = await clock(page);
  await waitFor(async () => (await clock(page)) > here, 20_000).catch(() => {});
  check(
    waited &&
      sent("showPicker") === lists &&
      (await output(page))?.kind === "local" &&
      (await clock(page)) > here,
    "Play here while a list waits for its window to fill the screen opens none, and the episode plays on here",
    `${sent("showPicker") - lists} lists asked for, output ${(await output(page))?.kind}, Play here ${waited ? "before" : "after"} the window arrived`,
  );
  await until("left", () => key(page, "f", 70));
  await delay(1000);

  // The viewer picks the TV in the list, and the list opens on it again as it plays. Minimised,
  // the window takes the list down and leaves the TV what it plays.
  await fromItsStart();
  await openList(page);
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
  lists = sent("showPicker");
  answer = await pickAs(page, "out of sight");
  await delay(500);
  check(
    answer.ok && answer.value?.output.kind === "receiver" && sent("showPicker") === lists,
    "A window out of sight opens no list",
    `answered ${answer.ok ? answer.value?.output.kind : "an error"}`,
  );
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
  await takeDown();
}
process.exit(broke || results.includes(false) ? 1 : 0);
