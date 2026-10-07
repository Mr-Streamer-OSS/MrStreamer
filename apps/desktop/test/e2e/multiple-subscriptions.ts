// Checks several subscriptions in a built app, against two fake providers whose panels number
// everything alike, and the fake TMDB: what the suite can't, because the window, the player, the
// worker and the main process meet only there. It connects the first, then checks, in order:
//
// - A second subscription is added in Settings > Subscriptions while a channel of the first
//   plays: the stream goes on, on the connection it had, and the row says what plays.
// - A subscription renamed there is listed under its new name.
// - Live TV and search show both subscriptions' channels. Two that read the same say whose each
//   is, and a channel only one has says nothing.
// - Watching the other subscription's channel ends the first's stream: one plays at a time.
// - A film both list is one tile in Movies, under ids that differ, while the same id at each
//   stays two films. Play's menu names each version's subscription, the one picked plays from
//   its own provider, and the other's then starts from the beginning.
// - A series both list shows the seasons and episodes of the version picked, and no other's.
// - Favourites of both are one list, which the keys put in another order, and each guide shows
//   on its own channels.
// - After a restart both are listed, under their names, with their lists and the order made.
// - Removing the one that plays, the channel watched last, says what stops and what stays, ends
//   its stream and takes its lists and its folder away. Home then plays the channel watched last
//   of the one left, behind Settings. Its favourite is back once it is added again.
// - Removing one that plays nothing leaves that stream as it is, and removing the last returns
//   to Connect with none open.
//
//   node test/e2e/multiple-subscriptions.ts <app executable> [-- extra app arguments]
//
// The app runs with a throwaway profile and remote debugging on a random port; on macOS pass
// --use-mock-keychain so the test never touches a real keychain.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { SeriesDetails, Title } from "@mrstreamer/contracts/ondemand";
import type { OwnedId, SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type { TitleProgress, Viewing } from "@mrstreamer/contracts/viewing";
import { startFakeProvider } from "../fake-provider.ts";
import { startFakeTmdb } from "../fake-tmdb.ts";
import {
  addSubscription,
  connect,
  delay,
  fill,
  key,
  launch,
  login,
  MODIFIERS,
  openSubscriptions,
  press,
  subscriptionRow,
  waitFor,
  type Page,
} from "./app.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) {
  throw new Error("Usage: node test/e2e/multiple-subscriptions.ts <app executable> [-- args]");
}

/** What the viewer names the two: the first only once it is renamed. */
const NORTHLINE = "Northline";
const HOLIDAY = "Holiday house";
/** A channel both list, under the same id, that plays a picture. */
const CHANNEL = "TEST | H.264 + AAC";

const profile = mkdtempSync(join(tmpdir(), "mr-streamer-e2e-"));
const first = await startFakeProvider({ channels: 300, live: true });
const second = await startFakeProvider({ channels: 200, live: true, second: true });
const tmdb = await startFakeTmdb();
// The app this starts reads both: the stand-in for TMDB, and a key to ask it with.
process.env["MR_STREAMER_TMDB_API"] = tmdb.url;
process.env["MR_STREAMER_TMDB_KEY"] = "e2e";
const randomPort = () => 20000 + Math.floor(Math.random() * 20000);
let port = randomPort();
let app = launch(executable, rest, { port, profile });

let failed = false;
/** Prints how a check went. */
function report(name: string, problems: readonly string[]): void {
  console.log(
    `${problems.length === 0 ? "PASS" : "FAIL"} ${name}${problems.map((each) => `\n     ${each}`).join("")}`,
  );
  failed ||= problems.length > 0;
}

const invoke = async <T>(page: Page, method: string, input?: unknown): Promise<T> => {
  const result = await page.evaluate<{ ok: boolean; value: T; error?: unknown }>(
    `window.mrStreamer.invoke(${JSON.stringify(method)}, ${JSON.stringify(input)})`,
  );
  if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.value;
};

/** A button by its exact words, as an expression for the page. */
const buttonNamed = (text: string, within = "document"): string =>
  `[...${within}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;

/** Clicks what `expression` finds in the page, once it is there. */
async function click(page: Page, expression: string): Promise<void> {
  await waitFor(() => page.evaluate<boolean>(`!!(${expression})`), 20_000);
  await page.evaluate(`(${expression}).click()`);
}

/** What the page shows, within the element `selector` names. */
const shown = (page: Page, selector = "body") =>
  page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);

/** The saved subscriptions, in their order. */
const saved = (page: Page) => invoke<SubscriptionSummary[]>(page, "subscription.list");

/** A subscription's line in Settings > Subscriptions: its name, kind, standing and what plays. */
const rowLine = (page: Page, name: string) =>
  page.evaluate<string>(
    `(${subscriptionRow(name)})?.querySelector("button")?.textContent.trim() ?? ""`,
  );

/** Whether the picture on screen moves, with the stream it plays still the one it had. */
async function moves(page: Page): Promise<boolean> {
  const time = () => page.evaluate<number>(`document.querySelector("video")?.currentTime ?? 0`);
  const before = await time();
  await delay(1500);
  return (await time()) > before;
}

/**
 * The channel Home lists first under Recently watched, as its tile reads: the one watched last,
 * as the window has its record. Home stays laid out under Watch and Settings.
 */
const watchedLast = (page: Page) =>
  page.evaluate<string>(`(() => {
    const row = [...document.querySelectorAll("section")].find(
      (each) => each.querySelector("h2")?.textContent === "Recently watched",
    );
    return row?.lastElementChild?.firstElementChild?.textContent ?? "";
  })()`);

/**
 * Waits for the picture in Home's backdrop to run: its clock moves on. The picture is there only
 * for the channel Home names. False when it doesn't run within 20 seconds.
 */
async function backdropRuns(page: Page): Promise<boolean> {
  let before: number | null = null;
  return waitFor(async () => {
    const now = await page.evaluate<number | null>(`(() => {
      const video = document.querySelector("section video");
      return video && !video.paused ? video.currentTime : null;
    })()`);
    const moved = before !== null && now !== null && now > before;
    before = now;
    return moved;
  }, 20_000).then(
    () => true,
    () => false,
  );
}

/** The search's results as the viewer reads them, by their place. */
const results = (page: Page) =>
  page.evaluate<string[]>(
    `[...document.querySelectorAll('[role="dialog"] [data-index]')].map((row) => row.innerText.replaceAll("\\n", " / "))`,
  );

/** Opens search on `words` and waits for what it finds. */
async function search(page: Page, words: string): Promise<string[]> {
  await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
  await waitFor(
    () => page.evaluate<boolean>(`document.activeElement?.closest('[role="dialog"]') !== null`),
    10_000,
  );
  await page.send("Input.insertText", { text: words });
  await waitFor(async () => (await results(page)).length > 0, 15_000).catch(() => {});
  // What was typed last is searched for after a pause.
  await delay(800);
  return results(page);
}

/** Watches the result at `index` of the search that is open, and waits for its picture. */
async function watch(page: Page, index: number): Promise<void> {
  await page.evaluate(`document.querySelector('[role="dialog"] [data-index="${index}"]').click()`);
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

/** Leaves Watch, a title or a sheet for the page under it. */
async function leave(page: Page, view: "watch" | "title" | "dialog"): Promise<void> {
  const selector = view === "dialog" ? '[role="dialog"]' : `[data-view="${view}"]`;
  await key(page, "Escape", 27);
  await waitFor(() => page.evaluate<boolean>(`!document.querySelector('${selector}')`), 10_000);
}

/**
 * Opens Movies or Series, finds `title` with the page's own search, and opens its sheet. Says how
 * many tiles showed it.
 */
async function openTitle(page: Page, kind: "Movies" | "Series", title: Title): Promise<number> {
  await click(page, buttonNamed(kind, `document.querySelector("header")`));
  const field = `document.querySelector('[aria-label="Search ${kind.toLowerCase()}"]')`;
  await waitFor(() => page.evaluate<boolean>(`!!${field}`), 60_000);
  await page.evaluate(`${field}.focus()`);
  await page.send("Input.insertText", { text: title.title });
  const tiles = `[...document.querySelectorAll("button[title]")].filter((b) => b.title === ${JSON.stringify(title.name)})`;
  await waitFor(() => page.evaluate<boolean>(`${tiles}.length > 0`), 60_000);
  await delay(500);
  const count = await page.evaluate<number>(`${tiles}.length`);
  await page.evaluate(`${tiles}[0].click()`);
  await waitFor(
    () =>
      page.evaluate<boolean>(`!!document.querySelector('[role="dialog"] [aria-label="Versions"]')`),
    30_000,
  );
  return count;
}

/** The versions Play's menu offers, as the viewer reads them; picks the one saying `words`. */
async function pickVersion(page: Page, words: string): Promise<string[]> {
  await click(page, `document.querySelector('[role="dialog"] [aria-label="Versions"]')`);
  const items = `[...document.querySelectorAll('[role="menuitemradio"]')]`;
  await waitFor(() => page.evaluate<boolean>(`${items}.length > 1`), 10_000);
  const offered = await page.evaluate<string[]>(
    `${items}.map((item) => item.innerText.replaceAll("\\n", " / "))`,
  );
  await page.evaluate(
    `${items}.find((item) => item.innerText.includes(${JSON.stringify(words)}))?.click()`,
  );
  await waitFor(() => page.evaluate<boolean>(`${items}.length === 0`), 10_000).catch(() => {});
  await delay(800);
  return offered;
}

/**
 * What the sheet of a series shows: its facts, and how many episodes of the season in view, by
 * the buttons that play them, which start with the episode's number. The dots beside each are
 * another button.
 */
const seriesSheet = (page: Page) =>
  page.evaluate<{ words: string; episodes: number }>(`(() => {
    const sheet = document.querySelector('[role="dialog"]');
    const [episodes] = [...(sheet?.querySelectorAll("section") ?? [])].slice(-1);
    return {
      words: sheet?.innerText ?? "",
      episodes: [...(episodes?.querySelectorAll("button") ?? [])].filter((row) =>
        /^\\d+$/.test(row.firstElementChild?.textContent.trim() ?? ""),
      ).length,
    };
  })()`);

try {
  let page = await connect(port);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page, first);
  const [one] = await saved(page);
  if (!one) throw new Error("The login saved no subscription.");
  const host = new URL(first.url).host;

  {
    const found = await search(page, CHANNEL);
    await watch(page, 0);
    await leave(page, "watch");
    const requests = first.streamRequests();
    await addSubscription(page, second, HOLIDAY);
    const problems: string[] = [];
    if (found.length !== 1) problems.push(`one subscription found ${found.length} channels`);
    if (first.streamRequests() !== requests || first.activeStreams() !== 1) {
      problems.push(
        `the stream was asked for ${first.streamRequests() - requests} more times, ${first.activeStreams()} open`,
      );
    }
    if (!(await moves(page))) problems.push("the picture stopped");
    const line = await rowLine(page, host);
    if (!line.includes("playing H.264 + AAC")) problems.push(`its row says "${line}"`);
    if ((await rowLine(page, HOLIDAY)) === "") problems.push("no row for the one added");
    if (!(await shown(page)).includes("One stream plays at a time.")) {
      problems.push("nothing says the subscriptions show together");
    }
    report("A subscription is added while another one's channel plays", problems);
  }

  {
    await click(page, buttonNamed("Edit", `(${subscriptionRow(host)})`));
    await waitFor(() => page.evaluate<boolean>("!!document.querySelector('form input')"), 10_000);
    await fill(page, [NORTHLINE]);
    const problems: string[] = [];
    await waitFor(async () => (await rowLine(page, NORTHLINE)) !== "", 20_000).catch(() =>
      problems.push("no row under the new name"),
    );
    const names = (await saved(page)).map((each) => each.name);
    if (names.join() !== [NORTHLINE, HOLIDAY].join()) problems.push(`saved as ${names.join()}`);
    if (first.streamRequests() !== 1) problems.push("a new name asked for the stream again");
    await leave(page, "dialog");
    report("A subscription is renamed", problems);
  }

  const [, two] = await saved(page);
  if (!two) throw new Error("The second subscription wasn't saved.");
  const own = (subscription: SubscriptionSummary, id: string): OwnedId => ({
    subscriptionId: subscription.id,
    id,
  });
  // Its channels, then its movies and series, arrive behind the pages.
  await waitFor(async () => {
    const lists = await invoke<{ lists: { fetchedAt: number | null }[] }>(page, "ondemand.status");
    const channels = await invoke<{ fetchedAt: number | null }[]>(page, "library.status");
    return [...lists.lists, ...channels].filter((each) => each.fetchedAt !== null).length === 4;
  }, 90_000);

  {
    const problems: string[] = [];
    const channels = await invoke<LiveChannel[]>(page, "library.channels", {});
    const of = (subscription: SubscriptionSummary) =>
      channels.filter((each) => each.subscriptionId === subscription.id);
    if (of(one).length === 0 || of(two).length === 0) {
      problems.push(`${of(one).length} channels of the first and ${of(two).length} of the second`);
    }
    const found = await search(page, CHANNEL);
    const named = [NORTHLINE, HOLIDAY].map(
      (name) => found.filter((row) => row.includes("H.264 + AAC") && row.includes(name)).length,
    );
    if (named.join() !== "1,1") problems.push(`search shows ${found.join(" | ")}`);
    await leave(page, "dialog");
    // A channel only the first lists: nothing reads like it, so nothing says whose it is.
    const single = of(one).find((each) => !each.ambiguous && !each.adult);
    if (!single) problems.push("every channel of the first reads like one of the second");
    else {
      const [row] = await search(page, single.name);
      if (!row?.includes(single.title) || row.includes(NORTHLINE)) {
        problems.push(`a channel only one lists shows as ${row}`);
      }
      await leave(page, "dialog");
    }
    await press(page, "Live TV");
    // The first rows are the first subscription's, which the second lists by the same names.
    await waitFor(async () => (await shown(page, "main")).includes(NORTHLINE), 20_000).catch(() =>
      problems.push("Live TV names no subscription on its rows"),
    );
    report(
      "Live TV and search show both, and say whose a channel is where two read the same",
      problems,
    );
  }

  {
    const found = await search(page, CHANNEL);
    const requests = second.streamRequests();
    await watch(
      page,
      found.findIndex((row) => row.includes(HOLIDAY)),
    );
    const problems: string[] = [];
    await waitFor(async () => first.activeStreams() === 0, 10_000).catch(() => {});
    if (first.activeStreams() !== 0 || second.activeStreams() !== 1) {
      problems.push(
        `${first.activeStreams()} open at the first, ${second.activeStreams()} at the second`,
      );
    }
    if (second.streamRequests() !== requests + 1) {
      problems.push(`${second.streamRequests() - requests} streams asked of the second`);
    }
    const watching = await shown(page, '[data-view="watch"]');
    if (!watching.includes(HOLIDAY)) problems.push("Watch doesn't say whose channel plays");
    await leave(page, "watch");
    report("Watching the other subscription's channel ends the first one's stream", problems);
  }

  {
    // The second lists the first's film 91001 as its 91000, and a film of its own as 91001.
    const [film] = await invoke<Title[]>(page, "ondemand.titles", {
      kind: "movie",
      versions: [own(two, "91000")],
    });
    const [other] = await invoke<Title[]>(page, "ondemand.titles", {
      kind: "movie",
      versions: [own(two, "91001")],
    });
    const problems: string[] = [];
    const versions = (film?.versions ?? []).map(
      ({ subscriptionId, id }) => `${subscriptionId}:${id}`,
    );
    if (versions.toSorted().join() !== [`${one.id}:91001`, `${two.id}:91000`].toSorted().join()) {
      problems.push(`the film has the versions ${versions.join()}`);
    }
    if (other?.versions.length !== 1) problems.push("the same id at each is one film");
    if (!film) throw new Error("The second subscription's film isn't listed.");
    const tiles = await openTitle(page, "Movies", film);
    if (tiles !== 1) problems.push(`${tiles} tiles show the film`);
    const offered = await pickVersion(page, HOLIDAY);
    if (offered.filter((each) => each.includes(NORTHLINE)).length !== 1 || offered.length !== 3) {
      problems.push(`Play's menu offers ${offered.join(" | ")}`);
    }
    const files = { first: first.fileRequests(), second: second.fileRequests() };
    await click(page, buttonNamed("Play", `document.querySelector('[role="dialog"]')`));
    await waitFor(
      () =>
        page.evaluate<boolean>(
          `!!document.querySelector('[data-view="title"]') && (document.querySelector("video")?.currentTime ?? 0) > 2`,
        ),
      45_000,
    ).catch(() => problems.push("the film didn't play"));
    if (second.fileRequests() === files.second || first.fileRequests() !== files.first) {
      problems.push(
        `${second.fileRequests() - files.second} file requests at the second, ${first.fileRequests() - files.first} at the first`,
      );
    }
    await leave(page, "title");
    const progress = await invoke<TitleProgress[]>(page, "viewing.progress", {
      movies: film.versions,
    });
    const played = progress.map((each) => each.title.subscriptionId);
    if (played.join() !== two.id) problems.push(`progress is kept for ${played.join() || "none"}`);
    // The first's file is another file: it starts from the beginning, with nothing to resume.
    await pickVersion(page, NORTHLINE);
    const sheet = await shown(page, '[role="dialog"]');
    if (sheet.includes("Resume")) problems.push("the other subscription's version resumes");
    await pickVersion(page, "Automatic");
    await leave(page, "dialog");
    report("A film both list is one tile, and plays from the subscription picked", problems);
  }

  {
    const [series] = await invoke<Title[]>(page, "ondemand.titles", {
      kind: "series",
      versions: [own(two, "80000")],
    });
    if (!series) throw new Error("The second subscription's series isn't listed.");
    const problems: string[] = [];
    const owners = new Set(series.versions.map((each) => each.subscriptionId));
    if (owners.size !== 2) problems.push(`the series has versions of ${owners.size} subscriptions`);
    const expected = async (version: OwnedId) => {
      const details = await invoke<SeriesDetails>(page, "ondemand.details", {
        kind: "series",
        version,
      });
      return { seasons: details.seasons.length, episodes: details.seasons[0]?.episodes.length };
    };
    const theirs = await expected(own(two, "80000"));
    const ours = await expected(own(one, "80000"));
    if (theirs.seasons !== 1 || theirs.episodes !== 2 || ours.seasons !== 2) {
      problems.push(`the same id lists ${JSON.stringify(ours)} and ${JSON.stringify(theirs)}`);
    }
    await openTitle(page, "Series", series);
    await pickVersion(page, HOLIDAY);
    await waitFor(async () => (await seriesSheet(page)).episodes === 2, 20_000).catch(() => {});
    const picked = await seriesSheet(page);
    if (picked.episodes !== 2 || !picked.words.includes("1 season")) {
      problems.push(`the second's version shows ${picked.episodes} episodes`);
    }
    await pickVersion(page, "Automatic");
    await leave(page, "dialog");
    report("A series both list shows the episodes of the version picked", problems);
  }

  // The channel both list, of each, and one more of the first: starred in this order.
  const both = (await invoke<LiveChannel[]>(page, "library.channels", {})).filter(
    (each) => each.name === CHANNEL,
  );
  const mine = both.find((each) => each.subscriptionId === one.id);
  const theirs = both.find((each) => each.subscriptionId === two.id);
  if (!mine || !theirs) throw new Error(`${CHANNEL} isn't listed by both.`);
  const extra = (await invoke<LiveChannel[]>(page, "library.channels", {})).find(
    (each) => each.subscriptionId === one.id && each.name === "TEST | H.264 + MP2",
  );
  if (!extra) throw new Error("The first lists no second test channel.");
  const starred: OwnedId[] = [mine, theirs, extra].map(({ subscriptionId, id }) => ({
    subscriptionId,
    id,
  }));
  const order = [starred[1]!, starred[2]!, starred[0]!];
  const favourites = async (from: Page) => (await invoke<Viewing>(from, "viewing.get")).favourites;

  {
    for (const channel of starred) {
      await invoke(page, "viewing.setFavourite", {
        commandId: crypto.randomUUID(),
        channel,
        favourite: true,
      });
    }
    const problems: string[] = [];
    if (mine.id !== theirs.id) problems.push("the two don't number the channel alike");
    await press(page, "Live TV");
    await delay(300);
    await press(page, "Favourites");
    const rows = () =>
      page.evaluate<string[]>(
        `[...document.querySelectorAll("main [data-index]")].map((row) => row.innerText.replaceAll("\\n", " / "))`,
      );
    await waitFor(async () => (await rows()).length === 3, 20_000).catch(() => {});
    const listed = await rows();
    if (
      listed.length !== 3 ||
      !listed[0]?.includes(NORTHLINE) ||
      !listed[1]?.includes(HOLIDAY) ||
      !listed[2]?.includes(NORTHLINE)
    ) {
      problems.push(`Favourites shows ${listed.join(" | ")}`);
    }
    // The guide of each shows on its own channel: both name the programme that is on.
    const listings = await invoke<Record<string, { now: { title: string } | null }>>(
      page,
      "guide.listings",
      { channels: starred.slice(0, 2) },
    );
    const guided = Object.values(listings).filter((each) => each.now !== null).length;
    const guides = await invoke<{ availability: string }[]>(page, "guide.status");
    if (guides.filter((each) => each.availability === "available").length !== 2) {
      problems.push(`the guides stand at ${guides.map((each) => each.availability).join()}`);
    }
    // A row's programme shows a moment after the row.
    const guidedRows = async () => (await rows()).slice(0, 2);
    if (guided === 2) {
      await waitFor(
        async () => (await guidedRows()).every((row) => /News \d+/.test(row)),
        10_000,
      ).catch(async () =>
        problems.push(`a row shows no programme: ${(await guidedRows()).join(" | ")}`),
      );
    }
    // R orders them; the first goes to the end, past the other subscription's, and Enter saves.
    await key(page, "r", 82);
    await delay(400);
    await key(page, "Home", 36);
    await delay(200);
    await key(page, "End", 35, MODIFIERS.alt);
    await delay(400);
    await key(page, "Enter", 13);
    await waitFor(
      async () => JSON.stringify(await favourites(page)) === JSON.stringify(order),
      15_000,
    ).catch(async () =>
      problems.push(`the record holds ${JSON.stringify(await favourites(page))}`),
    );
    report("Favourites of both are one list, in the order the viewer makes", problems);
  }

  {
    const before = (await invoke<LiveChannel[]>(page, "library.channels", {})).length;
    const folders = readdirSync(join(profile, "subscriptions"));
    page.close();
    app.kill("SIGKILL");
    await delay(1500);
    port = randomPort();
    app = launch(executable, rest, { port, profile });
    page = await connect(port);
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await waitFor(() => page.evaluate<boolean>("!!document.querySelector('header')"));
    const problems: string[] = [];
    const again = await saved(page);
    if (
      again.map((each) => `${each.id}:${each.name}`).join() !==
      [`${one.id}:${NORTHLINE}`, `${two.id}:${HOLIDAY}`].join()
    ) {
      problems.push(`saved as ${again.map((each) => each.name).join()}`);
    }
    if (folders.join() !== two.id) problems.push(`the added one's folder is ${folders.join()}`);
    await waitFor(
      async () => (await invoke<LiveChannel[]>(page, "library.channels", {})).length === before,
      30_000,
    ).catch(async () =>
      problems.push(
        `${(await invoke<LiveChannel[]>(page, "library.channels", {})).length} channels, ${before} before`,
      ),
    );
    if (JSON.stringify(await favourites(page)) !== JSON.stringify(order)) {
      problems.push("the favourites lost their order");
    }
    await openSubscriptions(page);
    await waitFor(async () => (await rowLine(page, HOLIDAY)) !== "", 20_000).catch(() => {});
    if ((await rowLine(page, NORTHLINE)) === "" || (await rowLine(page, HOLIDAY)) === "") {
      problems.push("Settings doesn't list both");
    }
    await leave(page, "dialog");
    report("A restart keeps both, their names, their lists and the order", problems);
  }

  {
    const found = await search(page, CHANNEL);
    await watch(
      page,
      found.findIndex((row) => row.includes(HOLIDAY)),
    );
    // The window has it as the channel watched last, which is what Home goes back to once
    // nothing plays, for as long as its record says so.
    await waitFor(async () => (await watchedLast(page)).includes(HOLIDAY), 20_000);
    await openSubscriptions(page);
    await click(page, `(${subscriptionRow(HOLIDAY)})?.querySelector("button")`);
    await click(page, buttonNamed(`Remove ${HOLIDAY}`));
    await waitFor(async () => (await shown(page)).includes("from this device?"), 10_000);
    const asked = await shown(page);
    const problems: string[] = [];
    if (!asked.includes(`H.264 + AAC is playing from it and stops. ${NORTHLINE} stays.`)) {
      problems.push("the question doesn't say what stops and what stays");
    }
    await click(page, buttonNamed("Remove"));
    await waitFor(async () => (await saved(page)).length === 1, 20_000);
    await waitFor(async () => second.activeStreams() === 0, 10_000).catch(() =>
      problems.push(`${second.activeStreams()} streams still open at the one removed`),
    );
    if (await page.evaluate<boolean>(`!!document.querySelector('[data-view="watch"]')`)) {
      problems.push("Watch is still open");
    }
    // Home, under Settings, goes on with the channel watched last of the one left: its picture
    // runs in the backdrop, on the one stream open.
    const behind = await backdropRuns(page);
    if (!behind || first.activeStreams() !== 1 || second.activeStreams() !== 0) {
      problems.push(
        `Home plays ${behind ? "a" : "no"} picture, with ${first.activeStreams()} open at the one left and ${second.activeStreams()} at the one removed`,
      );
    }
    await waitFor(async () => (await rowLine(page, HOLIDAY)) === "", 10_000).catch(() =>
      problems.push("its row is still listed"),
    );
    const channels = await invoke<LiveChannel[]>(page, "library.channels", {});
    if (channels.some((each) => each.subscriptionId !== one.id)) {
      problems.push("channels of the one removed still show");
    }
    const left = await favourites(page);
    if (left.some((each) => each.subscriptionId !== one.id) || left.length !== 2) {
      problems.push(`the favourites are ${JSON.stringify(left)}`);
    }
    if (readdirSync(join(profile, "subscriptions")).length !== 0) {
      problems.push("its folder is still there");
    }
    if (!existsSync(join(profile, "subscription.json"))) problems.push("the first's login went");
    // Its favourites were kept for the account: added again, under another id, they are back.
    await leave(page, "dialog");
    await addSubscription(page, second, HOLIDAY);
    const [, back] = await saved(page);
    await waitFor(async () => (await favourites(page)).length === 3, 20_000).catch(() => {});
    const kept = (await favourites(page)).filter((each) => each.subscriptionId === back?.id);
    if (back?.id === two.id || kept.map((each) => each.id).join() !== theirs.id) {
      problems.push(`added again it has the favourites ${JSON.stringify(kept)}`);
    }
    report("Removing the one that plays ends its stream and leaves the other", problems);
  }

  {
    const problems: string[] = [];
    const requests = first.streamRequests();
    for (const [name, last] of [
      [HOLIDAY, false],
      [NORTHLINE, true],
    ] as const) {
      // One subscription alone shows its details already; a row of several opens them.
      if (!last) await click(page, `(${subscriptionRow(name)})?.querySelector("button")`);
      await click(page, buttonNamed(`Remove ${name}`));
      await waitFor(async () => (await shown(page)).includes("from this device?"), 10_000);
      const returns = (await shown(page)).includes(
        "It's your only subscription, so Mr. Streamer returns to Connect.",
      );
      if (returns !== last)
        problems.push(`removing ${name} ${returns ? "says" : "doesn't say"} it returns to Connect`);
      await click(page, buttonNamed("Remove"));
      if (last) continue;
      await waitFor(async () => (await rowLine(page, name)) === "", 20_000);
      // Nothing of it played: the other's channel goes on behind, on the stream it had.
      const behind = await backdropRuns(page);
      const streams = [first.activeStreams(), second.activeStreams()];
      if (!behind || streams.join() !== "1,0" || first.streamRequests() !== requests) {
        problems.push(
          `removing ${name} left ${behind ? "a" : "no"} picture behind, ${streams.join(" and ")} open, and asked for the other's stream ${first.streamRequests() - requests} more times`,
        );
      }
    }
    await waitFor(
      () =>
        page.evaluate<boolean>(
          "!document.querySelector('header') && document.querySelectorAll('form input').length >= 3",
        ),
      20_000,
    ).catch(() => problems.push("Connect didn't show"));
    // A channel still previewed behind the page ends with the last one, and its provider counts
    // the connection a moment longer.
    const open = () => first.activeStreams() + second.activeStreams();
    await waitFor(async () => open() === 0, 10_000).catch(() =>
      problems.push(`${open()} streams still open`),
    );
    if (existsSync(join(profile, "subscription.json"))) problems.push("a login is still saved");
    report("Removing the last subscription returns to Connect", problems);
  }
  page.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  failed = true;
} finally {
  app.kill("SIGKILL");
  await Promise.all([first.close(), second.close(), tmdb.close()]);
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
