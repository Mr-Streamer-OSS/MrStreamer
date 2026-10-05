// Checks a built app on a playlist subscription, against the fake playlist host: what the suite
// can't, because hls.js plays nothing without a real browser. It connects by an M3U link, then
// checks, in order:
//
// - Settings > Subscription says the playlist names no guide, without an error, also after its
//   refresh button; finds the guide once the playlist names one; and drops it again.
// - An HLS channel with two sound renditions and three subtitle renditions offers Sound and CC,
//   plays its own sound, and shows no subtitles though the stream marks some as its default.
// - Picking the other sound switches where the stream plays: the same stream goes on, now
//   loading the other rendition's segments, with sound still decoded.
// - Picking subtitles without a line in them stops saying Loading once hls.js has read them.
//   Picking others shows that rendition's lines at their seconds; C turns them off, and on again
//   with the lines hls.js had read before.
// - A channel whose picture carries closed captions offers them under CC and shows them. After
//   Stop and the same channel again they are still chosen, and show as the new stream brings them.
// - Back on the first channel, the sound and subtitles in the languages picked come on by
//   themselves; a stream with nothing to choose shows neither button.
// - After the keychain loses the link, the app asks for the link again, naming only its host, and
//   the same link brings back the same account with its favourite.
//
//   node test/e2e/playlist-app.ts <app executable> [-- extra app arguments]
//
// The app runs with a throwaway profile and remote debugging on a random port; on macOS pass
// --use-mock-keychain so the test never touches a real keychain. No sound device is needed:
// sound counts as playing when the element decodes it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYLIST_CHANNELS, startFakePlaylist } from "../fake-playlist.ts";
import { connect, connectPlaylist, delay, key, launch, waitFor, type Page } from "./app.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) throw new Error("Usage: node test/e2e/playlist-app.ts <app executable> [-- args]");

const profile = mkdtempSync(join(tmpdir(), "mr-streamer-e2e-"));
const host = await startFakePlaylist();
const randomPort = () => 20000 + Math.floor(Math.random() * 20000);
let port = randomPort();
let app = launch(executable, rest, { port, profile });

let failed = false;
/** Prints how a check went. */
function report(name: string, result: { ok: boolean; detail: string }): void {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${name}: ${result.detail}`);
  failed ||= !result.ok;
}

try {
  let page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await connectPlaylist(page, host.link);
  report("The Guide row follows the playlist", await guideRow(page));
  report("An HLS channel lists its tracks", await listsTracks(page));
  report("Sound switches in place", await switchesSound(page));
  report("Subtitles show, and C toggles them", await showsSubtitles(page));
  report("Captions in the picture show", await showsCaptions(page));
  report("The picked languages carry over", await carriesOver(page));
  report("A stream without tracks has no buttons", await plainStream(page));
  await favourite(page);
  page.close();
  app.kill("SIGKILL");
  await delay(1500);

  loseLink();
  port = randomPort();
  app = launch(executable, rest, { port, profile });
  page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  report("A lost link is asked for again", await asksForLink(page));
  page.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  failed = true;
} finally {
  app.kill("SIGKILL");
  await host.close();
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);

/** A button by its exact words, as an expression for the page. */
function buttonNamed(text: string, within = "document"): string {
  return `[...${within}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
}

/** Clicks what `expression` finds in the page, once it is there. */
async function click(page: Page, expression: string): Promise<void> {
  await waitFor(() => page.evaluate<boolean>(`!!(${expression})`), 15_000);
  await page.evaluate(`(${expression}).click()`);
}

/** What the Guide row of Settings > Subscription says, and the line under it when one shows. */
async function guideRow(page: Page): Promise<{ ok: boolean; detail: string }> {
  await click(page, `document.querySelector('[aria-label="Settings"]')`);
  await click(page, buttonNamed("Subscription", `document.querySelector("nav")`));
  const refresh = `document.querySelector('[aria-label="Refresh guide"]')`;
  const read = () =>
    page.evaluate<{ row: string; under: string | null; busy: boolean }>(`(() => {
      const button = ${refresh};
      const row = button?.parentElement?.parentElement;
      const under = row?.nextElementSibling;
      return {
        row: row?.textContent ?? "",
        under: under?.tagName === "P" ? under.textContent : null,
        busy: !!button?.disabled,
      };
    })()`);
  /** Presses Refresh and waits for the row to settle on `wanted`. */
  const refreshed = async (wanted: RegExp) => {
    await click(page, refresh);
    await waitFor(async () => {
      const now = await read();
      return !now.busy && wanted.test(now.row);
    }, 20_000).catch(() => {});
    return read();
  };
  await waitFor(async () => (await read()).row.includes("none in this playlist"), 20_000).catch(
    () => {},
  );
  const first = await read();
  const again = await refreshed(/none in this playlist/);
  host.nameGuide(true);
  const found = await refreshed(/1 channels/);
  host.nameGuide(false);
  const dropped = await refreshed(/none in this playlist/);
  await key(page, "Escape", 27);
  const none = "Guide · none in this playlist";
  const ok =
    first.row === none &&
    again.row === none &&
    found.row.startsWith("Guide · 1 channels") &&
    dropped.row === none &&
    [first, again, found, dropped].every((each) => each.under === null);
  return {
    ok,
    detail: `"${first.row}", after Refresh "${again.row}", once named "${found.row}", once dropped "${dropped.row}", ${[first, again, found, dropped].filter((each) => each.under).length} error lines`,
  };
}

/** Picks a channel through search and waits for its picture to move. */
async function play(page: Page, channel: string): Promise<void> {
  await click(page, `document.querySelector('[aria-label="Search"]')`);
  await delay(500);
  await page.send("Input.insertText", { text: channel });
  await delay(800);
  await key(page, "Enter", 13);
  await waitFor(
    () =>
      page.evaluate<boolean>(`(() => {
        const video = document.querySelector("video");
        return !!document.querySelector('[data-view="watch"]') && !!video &&
          video.currentTime > 0.3 && video.videoWidth > 0;
      })()`),
    30_000,
  );
}

interface Playing {
  readonly time: number;
  readonly paused: boolean;
  /** Bytes of sound the element decoded so far. */
  readonly sound: number;
  /** The lines on the element's subtitle track that show at its position. */
  readonly lines: readonly string[];
  /** Every line on that track. */
  readonly loaded: number;
  /** Whether the CC button is there, and lit. */
  readonly cc: "on" | "off" | "absent";
  readonly soundButton: boolean;
}

function playing(page: Page): Promise<Playing> {
  return page.evaluate<Playing>(`(() => {
    const video = document.querySelector("video");
    const track = [...video.textTracks].find((each) => each.kind === "subtitles");
    const cc = document.querySelector('[data-view="watch"] [aria-label^="Subtitles"]');
    return {
      time: video.currentTime,
      paused: video.paused,
      sound: video.webkitAudioDecodedByteCount ?? 0,
      lines: [...(track?.activeCues ?? [])].map((cue) => cue.text),
      loaded: track?.cues?.length ?? 0,
      cc: !cc ? "absent" : cc.getAttribute("aria-pressed") === "true" ? "on" : "off",
      soundButton: !!document.querySelector('[data-view="watch"] [aria-label="Sound"]'),
    };
  })()`);
}

/** Opens the Sound or CC menu and reads its choices, the chosen one marked, then closes it. */
async function choices(page: Page, menu: "Sound" | "Subtitles"): Promise<string[]> {
  const items = await openMenu(page, menu);
  await key(page, "Escape", 27);
  await delay(300);
  return items;
}

async function openMenu(page: Page, menu: "Sound" | "Subtitles"): Promise<string[]> {
  const trigger = `document.querySelector('[data-view="watch"] [aria-label^="${menu}"]')`;
  await click(page, trigger);
  const popup = `document.querySelector('[role="dialog"][aria-label^="${menu}"]')`;
  await waitFor(() => page.evaluate<boolean>(`!!${popup}?.querySelector("[data-item]")`), 10_000);
  return page.evaluate<string[]>(
    `[...${popup}.querySelectorAll("[data-item]")].map((item) =>
      (item.getAttribute("aria-pressed") === "true" ? "*" : "") + item.textContent.trim())`,
  );
}

/** Chooses `label` in the Sound or CC menu. */
async function choose(page: Page, menu: "Sound" | "Subtitles", label: string): Promise<void> {
  await openMenu(page, menu);
  const popup = `document.querySelector('[role="dialog"][aria-label^="${menu}"]')`;
  await click(
    page,
    `[...${popup}.querySelectorAll("[data-item]")].find((item) => item.textContent.trim().startsWith(${JSON.stringify(label)}))`,
  );
  await delay(300);
}

/** Holds the picture at `seconds`, where the stream's lines are known. */
async function holdAt(page: Page, seconds: number): Promise<void> {
  await page.evaluate(`(() => {
    const video = document.querySelector("video");
    video.pause();
    video.currentTime = ${seconds};
  })()`);
  await waitFor(
    () =>
      page.evaluate<boolean>(`(() => {
        const video = document.querySelector("video");
        return !video.seeking && Math.abs(video.currentTime - ${seconds}) < 0.05;
      })()`),
    10_000,
  );
  await delay(300);
}

function resume(page: Page): Promise<void> {
  return page.evaluate(`void document.querySelector("video").play()`);
}

/** How often the host was asked for a path matching `pattern`. */
function asked(pattern: RegExp): number {
  return host.requests().filter((path) => pattern.test(path)).length;
}

async function listsTracks(page: Page): Promise<{ ok: boolean; detail: string }> {
  await play(page, PLAYLIST_CHANNELS.tracks.name);
  await waitFor(async () => (await playing(page)).sound > 0, 20_000).catch(() => {});
  const sound = await choices(page, "Sound");
  const subtitles = await choices(page, "Subtitles");
  const now = await playing(page);
  const ok =
    sound.join() === "*English,Español" &&
    subtitles.join() === "*Off,English,Deutsch,Français" &&
    now.cc === "off" &&
    now.loaded === 0 &&
    now.sound > 0 &&
    asked(/subtitles-/) === 0 &&
    asked(/sound-es/) === 0;
  return {
    ok,
    detail: `Sound [${sound}], CC [${subtitles}], CC ${now.cc}, ${now.loaded} lines loaded, ${now.sound} bytes of sound decoded, ${asked(/subtitles-/)} subtitle requests`,
  };
}

async function switchesSound(page: Page): Promise<{ ok: boolean; detail: string }> {
  const before = await playing(page);
  const opened = asked(/master\.m3u8$/);
  await choose(page, "Sound", "Español");
  await waitFor(async () => asked(/sound-es-\d+\.mpegts$/) > 0, 15_000).catch(() => {});
  await waitFor(async () => (await playing(page)).sound > before.sound, 15_000).catch(() => {});
  const after = await playing(page);
  const sound = await choices(page, "Sound");
  const ok =
    asked(/sound-es-\d+\.mpegts$/) > 0 &&
    asked(/master\.m3u8$/) === opened &&
    after.time > before.time &&
    after.sound > before.sound &&
    sound.join() === "English,*Español";
  return {
    ok,
    detail: `Sound [${sound}], ${asked(/sound-es-\d+\.mpegts$/)} Spanish segments loaded, the stream opened ${asked(/master\.m3u8$/) - opened} more times, clock ${before.time.toFixed(1)} to ${after.time.toFixed(1)} s, sound ${before.sound} to ${after.sound} bytes`,
  };
}

async function showsSubtitles(page: Page): Promise<{ ok: boolean; detail: string }> {
  await choose(page, "Subtitles", "English");
  await waitFor(async () => (await playing(page)).loaded > 0, 15_000).catch(() => {});
  // "English line 3" shows from 4.25 to 5.75 s.
  await holdAt(page, 5);
  const english = await playing(page);
  // "Français" has no line: its row says Loading until hls.js has read it, not until one comes.
  await choose(page, "Subtitles", "Français");
  const row = async () =>
    (await choices(page, "Subtitles")).find((choice) => choice.startsWith("*")) ?? "";
  await waitFor(async () => (await row()) === "*Français", 15_000).catch(() => {});
  const silent = { row: await row(), ...(await playing(page)) };
  await choose(page, "Subtitles", "Deutsch");
  await waitFor(async () => (await playing(page)).lines.join().includes("Deutsche"), 15_000).catch(
    () => {},
  );
  const german = await playing(page);
  await key(page, "c", 67);
  await delay(500);
  const off = await playing(page);
  await key(page, "c", 67);
  await delay(500);
  // The lines read before come back, and nothing is left to load.
  const on = { row: await row(), ...(await playing(page)) };
  const between = await (async () => {
    // Between two lines nothing shows.
    await holdAt(page, 6);
    return playing(page);
  })();
  await resume(page);
  const ok =
    english.lines.join() === "English line 3" &&
    english.cc === "on" &&
    silent.row === "*Français" &&
    silent.cc === "on" &&
    silent.loaded === 0 &&
    asked(/subtitles-fr\.vtt$/) > 0 &&
    german.lines.join() === "Deutsche Zeile 3" &&
    off.cc === "off" &&
    off.loaded === 0 &&
    on.cc === "on" &&
    on.row === "*Deutsch" &&
    on.lines.join() === "Deutsche Zeile 3" &&
    between.lines.length === 0;
  return {
    ok,
    detail: `at 5 s "${english.lines}", without lines "${silent.row}" and ${silent.loaded} lines, then "${german.lines}"; C: ${off.cc} with ${off.loaded} lines, C: ${on.cc} "${on.row}" with "${on.lines}"; at 6 s ${between.lines.length} lines`,
  };
}

async function showsCaptions(page: Page): Promise<{ ok: boolean; detail: string }> {
  await play(page, PLAYLIST_CHANNELS.captions.name);
  // hls.js finds the captions as it reads the picture; CC shows from then on.
  await waitFor(async () => (await playing(page)).cc !== "absent", 15_000).catch(() => {});
  const before = await playing(page);
  const listed = before.cc === "absent" ? [] : await choices(page, "Subtitles");
  // "HELLO CAPTIONS" shows from 1 to 3 s.
  await holdAt(page, 2);
  if (listed.length > 0) await choose(page, "Subtitles", "Captions");
  await waitFor(async () => (await playing(page)).lines.length > 0, 10_000).catch(() => {});
  const shown = await playing(page);
  await holdAt(page, 3.5);
  const after = await playing(page);
  // Stop, then the same channel: a new stream, whose picture tells of its captions only at their
  // first line. The lines of the stream before are marked, to tell them from the ones it brings.
  const marked = await markedLines(page, true);
  const stop = `document.querySelector('[data-view="watch"] [aria-label="Stop"]')`;
  await click(page, stop);
  await waitFor(() => page.evaluate<boolean>(`!${stop}`), 10_000);
  await play(page, PLAYLIST_CHANNELS.captions.name);
  await waitFor(async () => (await playing(page)).cc !== "absent", 15_000).catch(() => {});
  const reopened = await playing(page);
  const kept = reopened.cc === "absent" ? [] : await choices(page, "Subtitles");
  await holdAt(page, 2);
  await waitFor(async () => (await playing(page)).lines.length > 0, 10_000).catch(() => {});
  const again = await playing(page);
  const old = await markedLines(page, false);
  const said = (lines: readonly string[]) => lines.join(" ").replace(/\s+/g, " ").trim();
  const ok =
    listed.join() === "*Off,Captions" &&
    !before.soundButton &&
    shown.cc === "on" &&
    said(shown.lines) === "HELLO CAPTIONS" &&
    after.lines.length === 0 &&
    marked > 0 &&
    reopened.cc === "on" &&
    kept.join() === "Off,*Captions" &&
    said(again.lines) === "HELLO CAPTIONS" &&
    old === 0;
  return {
    ok,
    detail: `CC [${listed}], at 2 s "${shown.lines.join(" | ")}", at 3.5 s ${after.lines.length} lines, Sound ${before.soundButton ? "shown" : "hidden"}; after Stop and the same channel CC ${reopened.cc} [${kept}], at 2 s "${again.lines.join(" | ")}", ${old} of ${marked} earlier lines left`,
  };
}

/**
 * How many lines on the element's subtitle track bear a mark, after marking all of them when
 * `mark` says so. A line read from a later stream bears none.
 */
function markedLines(page: Page, mark: boolean): Promise<number> {
  return page.evaluate<number>(`(() => {
    const video = document.querySelector("video");
    const track = [...video.textTracks].find((each) => each.kind === "subtitles");
    const lines = [...(track?.cues ?? [])];
    if (${mark}) for (const line of lines) line.id = "before-stop";
    return lines.filter((line) => line.id === "before-stop").length;
  })()`);
}

async function carriesOver(page: Page): Promise<{ ok: boolean; detail: string }> {
  const english = asked(/sound-en-\d+\.mpegts$/);
  await play(page, PLAYLIST_CHANNELS.tracks.name);
  await waitFor(async () => (await playing(page)).cc === "on", 15_000).catch(() => {});
  await waitFor(async () => (await playing(page)).loaded > 0, 15_000).catch(() => {});
  await holdAt(page, 9);
  const now = await playing(page);
  const sound = await choices(page, "Sound");
  const subtitles = await choices(page, "Subtitles");
  await resume(page);
  const ok =
    sound.join() === "English,*Español" &&
    subtitles.join() === "Off,English,*Deutsch,Français" &&
    now.lines.join() === "Deutsche Zeile 5" &&
    asked(/sound-en-\d+\.mpegts$/) === english;
  return {
    ok,
    detail: `Sound [${sound}], CC [${subtitles}], at 9 s "${now.lines}", ${asked(/sound-en-\d+\.mpegts$/) - english} English segments loaded`,
  };
}

async function plainStream(page: Page): Promise<{ ok: boolean; detail: string }> {
  await play(page, PLAYLIST_CHANNELS.plain.name);
  await delay(1500);
  const now = await playing(page);
  return {
    ok: !now.soundButton && now.cc === "absent" && now.lines.length === 0,
    detail: `Sound ${now.soundButton ? "shown" : "hidden"}, CC ${now.cc}, ${now.lines.length} lines`,
  };
}

/** The account's favourites, as the main process keeps them. */
function favourites(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(
    `window.mrStreamer.invoke("viewing.get").then((viewing) => viewing.ok ? viewing.value.favourites : [])`,
  );
}

/** Stars the channel on screen, for the account to be recognised by later. */
async function favourite(page: Page): Promise<void> {
  await key(page, "s", 83);
  await waitFor(async () => (await favourites(page)).length === 1, 10_000);
}

/** Has the profile hold a link its keychain can't open, as after a reset keychain. */
function loseLink(): void {
  const path = join(profile, "subscription.json");
  const stored = JSON.parse(readFileSync(path, "utf8")) as { sealedLink: string };
  writeFileSync(path, JSON.stringify({ ...stored, sealedLink: "bm90IGEgc2VhbGVkIGxpbms=" }));
}

async function asksForLink(page: Page): Promise<{ ok: boolean; detail: string }> {
  await waitFor(() => page.evaluate<boolean>("!!document.querySelector('form h1')"), 30_000);
  const asking = await page.evaluate<{
    heading: string;
    line: string;
    fields: string[];
    focused: boolean;
    page: string;
  }>(`(() => {
    const fields = [...document.querySelectorAll("form input")];
    return {
      heading: document.querySelector("form h1").textContent,
      line: document.querySelector("form h1 + p").textContent,
      fields: fields.map((field) => field.value),
      focused: document.activeElement === fields[0],
      page: document.body.innerText,
    };
  })()`);
  const { host: from } = new URL(host.origin);
  await connectPlaylist(page, host.link);
  const kept = await favourites(page);
  const ok =
    asking.heading === "Enter your playlist link again" &&
    asking.line === `Your keychain no longer gives Mr. Streamer the saved link from ${from}.` &&
    asking.fields.join("|") === "" &&
    asking.fields.length === 1 &&
    asking.focused &&
    !/t0k3n|playlist\.m3u|password/i.test(asking.page) &&
    kept.length === 1;
  return {
    ok,
    detail: `"${asking.heading}", ${asking.fields.length} empty field${asking.focused ? " with the cursor" : ""}, the host named ${asking.line.includes(from) ? "alone" : "wrongly"}, ${kept.length} favourite after the same link`,
  };
}
