// Checks marking episodes watched and unwatched in a built app, against two fake providers and
// the fake TMDB: what the suite can't, because happy-dom moves no real focus, lays nothing out
// and keeps no database between starts. The first provider's subscription is saved alone at
// first. In order:
//
// - In a series' details, Tab reaches an episode's dots from its row; Enter opens them, the
//   arrow keys and Enter mark the episode watched, and the keyboard stays on the dots. The row
//   gets its check, the line under the tabs offers Undo, Play moves on to the next episode, and
//   the provider is asked for no file and no stream.
// - A real click on Undo puts the episode back, and Play with it.
// - A real click on the dots and on Mark watched marks it again, and plays nothing: the dots are
//   no part of the row's button.
// - An episode stopped partway offers both marks. Marked unwatched it loses its resume point,
//   and Undo brings back Resume with the same time left, also when the play that was going saved
//   how far it got meanwhile.
// - After a restart the marks are there, in the details and on Home's Continue watching, which
//   offers the episode the details' Play names.
// - When the provider takes that episode out of the series, the details go on with the next one
//   once they are opened again, and so does Home.
// - With a second provider that lists the series under the same ids, its version shows none of
//   the first's marks; the dots and the line name the subscription; a mark made there is kept in
//   its own record, and taking it back leaves the first's.
//
//   node test/e2e/episode-marks.ts <app executable> [-- extra app arguments]
//
// The app runs with a throwaway profile and remote debugging on a random port; on macOS pass
// --use-mock-keychain so the test never touches a real keychain. Nothing here plays, so it needs
// neither ffmpeg nor ffprobe.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OnDemandStatus, TitleDetails } from "@mrstreamer/contracts/ondemand";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type { SeriesViewing, Viewing } from "@mrstreamer/contracts/viewing";
import { startFakeProvider } from "../fake-provider.ts";
import { startFakeTmdb } from "../fake-tmdb.ts";
import { addSubscription, connect, delay, key, launch, login, waitFor, type Page } from "./app.ts";

const [given, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!given) {
  throw new Error("Usage: node test/e2e/episode-marks.ts <app executable> [-- args]");
}
const executable: string = given;

/** The series both providers list, by a part of its name and by the first's Dutch version. */
const SERIES = { name: "TEST | Formats", id: "80000" };
/** What the second subscription is called in Settings. */
const SECOND = "Holiday house";

const profile = mkdtempSync(join(tmpdir(), "mr-streamer-e2e-"));
const provider = await startFakeProvider({ channels: 60 });
// Another provider beside it, which lists the series under the same series and episode ids.
const second = await startFakeProvider({ channels: 60, second: true });
const tmdb = await startFakeTmdb();
process.env["MR_STREAMER_TMDB_API"] = tmdb.url;
process.env["MR_STREAMER_TMDB_KEY"] = "test-key";
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

/** How the series' episodes stand in a subscription's record. */
const standing = (page: Page, subscriptionId: string) =>
  invoke<SeriesViewing>(page, "viewing.episodes", {
    series: { subscriptionId, id: SERIES.id },
  });

/** The episodes a subscription marked, as "1:2 watched". */
const marks = async (page: Page, subscriptionId: string) =>
  (await standing(page, subscriptionId)).marks.map(
    (mark) => `${mark.season}:${mark.episode} ${mark.watched ? "watched" : "unwatched"}`,
  );

/** Whether every saved subscription's movie and series lists are loaded. */
async function listsLoaded(page: Page): Promise<boolean> {
  const { lists } = await invoke<OnDemandStatus>(page, "ondemand.status");
  return lists.length > 0 && lists.every((each) => each.fetchedAt !== null);
}

/** What the provider was asked to send of files and streams: a mark asks for neither. */
const sent = () => [provider.fileRequests(), provider.streamRequests(), provider.activeStreams()];

// Expressions the page evaluates to an element, or nothing.
const SHEET = `document.querySelector('[role="dialog"]')`;
const withText = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((each) => each.textContent.trim() === ${JSON.stringify(text)})`;
/** The dots on the row of an episode, named as "S1 E2". */
const dots = (episode: string) => `document.querySelector('[aria-label="More for ${episode}"]')`;
/** That row, and the button on it that plays the episode. */
const row = (episode: string) => `${dots(episode)}?.closest(".group")`;
const playOf = (episode: string) => `${row(episode)}?.querySelector("button")`;
const ITEMS = `[...document.querySelectorAll('[role="menuitem"]')]`;

const exists = (page: Page, element: string) => page.evaluate<boolean>(`!!${element}`);
const textOf = (page: Page, element: string) =>
  page.evaluate<string>(`${element}?.innerText ?? ""`);
/** What has the keyboard: its words, or its label. */
const focused = (page: Page) =>
  page.evaluate<string>(
    `document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute("aria-label") || ""`,
  );
/** Whether an episode's row shows its check. */
const checked = (page: Page, episode: string) =>
  exists(page, `${row(episode)}?.querySelector('[aria-label="Watched"]')`);
/** What the sheet's main action reads: "Play S1 E2". */
const mainAction = (page: Page) =>
  page.evaluate<string>(
    `[...document.querySelectorAll('[role="dialog"] button')].map((each) => each.textContent.trim()).find((text) => /^(Play|Resume|Replay) S\\d/.test(text)) ?? ""`,
  );
/** The line under the season tabs about the last mark. */
const notice = (page: Page) => textOf(page, `${SHEET}?.querySelector('[role="status"]')`);

/** Clicks an element with the real pointer, once it is there. */
async function click(page: Page, element: string): Promise<void> {
  await waitFor(() => exists(page, element), 30_000).catch(() => {
    throw new Error(`Nothing to click: ${element}`);
  });
  await page.evaluate(`${element}.scrollIntoView({ block: "nearest" })`);
  await delay(150);
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const box = ${element}.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
  }
  await delay(150);
}

/** A real press of Enter, which a button takes as a click as the key goes down. */
async function enter(page: Page): Promise<void> {
  const pressed = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...pressed });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...pressed });
}

/** Opens the series' details from Series, on the season of `shown`: the one it goes on in. */
async function openSeries(page: Page, shown = "S1 E1"): Promise<void> {
  await click(page, withText("header button", "Series"));
  await click(page, withText("nav button", "All series"));
  await click(
    page,
    `[...document.querySelectorAll("button[title]")].find((each) => each.title.includes(${JSON.stringify(SERIES.name)}))`,
  );
  await waitFor(() => exists(page, dots(shown)), 30_000);
}

/** Picks `item` with the real pointer in the dots of an episode. */
async function mark(page: Page, episode: string, item: string): Promise<void> {
  await click(page, dots(episode));
  await waitFor(() => page.evaluate<boolean>(`${ITEMS}.length === 2`), 10_000);
  await click(page, `${ITEMS}.find((each) => each.innerText.startsWith(${JSON.stringify(item)}))`);
}

/** Starts the app again on the same profile, as after quitting it. */
async function restart(page: Page): Promise<Page> {
  page.close();
  app.kill("SIGKILL");
  await delay(1500);
  port = randomPort();
  app = launch(executable, rest, { port, profile });
  return ready(await connect(port));
}

/** A window that takes the keyboard, and asks no one outside this machine for pictures. */
async function ready(page: Page): Promise<Page> {
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Network.enable");
  await page.send("Network.setBlockedURLs", { urls: ["*image.tmdb.org*", "*image.example*"] });
  return page;
}

try {
  let page = await ready(await connect(port));
  await login(page, provider);
  const [one] = await invoke<SubscriptionSummary[]>(page, "subscription.list");
  if (!one) throw new Error("The login saved no subscription.");
  // The movie and series lists load after the channels.
  await waitFor(() => listsLoaded(page), 60_000);
  await openSeries(page);

  {
    const problems: string[] = [];
    const before = sent();
    const first = await mainAction(page);
    if (first !== "Play S1 E1") problems.push(`the series starts at "${first}"`);
    await page.evaluate(`${playOf("S1 E1")}.focus()`);
    await key(page, "Tab", 9);
    if ((await focused(page)) !== "More for S1 E1") {
      problems.push(`Tab from the row reached "${await focused(page)}"`);
    }
    await enter(page);
    await waitFor(() => page.evaluate<boolean>(`${ITEMS}.length === 2`), 10_000);
    const offered = await page.evaluate<string[]>(`${ITEMS}.map((each) => each.innerText.trim())`);
    if (offered.join() !== "Mark watched,Mark unwatched") problems.push(`it offers ${offered}`);
    // The menu can be drawn before its opening focus transfer has finished.
    await waitFor(
      () => page.evaluate<boolean>(`document.activeElement?.getAttribute("role") === "menuitem"`),
      10_000,
    );
    if ((await focused(page)) !== "Mark watched") await key(page, "ArrowDown", 40);
    await waitFor(
      () =>
        page.evaluate<boolean>(
          `document.activeElement?.getAttribute("role") === "menuitem" && document.activeElement.innerText.trim() === "Mark watched"`,
        ),
      10_000,
    );
    await enter(page);
    await waitFor(() => checked(page, "S1 E1"), 15_000).catch(() => {
      problems.push("the row got no check");
    });
    if ((await focused(page)) !== "More for S1 E1") {
      problems.push(`the keyboard went to "${await focused(page)}"`);
    }
    if ((await notice(page)) !== "S1 E1 marked watched\nUndo") {
      problems.push(`the line reads "${await notice(page)}"`);
    }
    if ((await mainAction(page)) !== "Play S1 E2") {
      problems.push(`Play reads "${await mainAction(page)}"`);
    }
    if ((await marks(page, one.id)).join() !== "1:1 watched") {
      problems.push(`the record holds ${await marks(page, one.id)}`);
    }
    if (sent().join() !== before.join()) problems.push(`the provider was asked: ${sent()}`);
    report(
      "The keyboard reaches an episode's dots and marks it watched, with the focus kept and nothing played",
      problems,
    );
  }

  {
    const problems: string[] = [];
    await click(page, withText('[role="dialog"] button', "Undo"));
    await waitFor(async () => !(await checked(page, "S1 E1")), 15_000).catch(() => {
      problems.push("the row kept its check");
    });
    if ((await mainAction(page)) !== "Play S1 E1") {
      problems.push(`Play reads "${await mainAction(page)}"`);
    }
    if (await notice(page)) problems.push(`the line still reads "${await notice(page)}"`);
    if ((await marks(page, one.id)).length > 0) problems.push("the record kept the mark");
    report("Undo puts the episode and the series back", problems);
  }

  {
    const problems: string[] = [];
    const before = sent();
    await mark(page, "S1 E1", "Mark watched");
    await waitFor(() => checked(page, "S1 E1"), 15_000).catch(() => {
      problems.push("the row got no check");
    });
    if (await exists(page, "document.querySelector('video[src]')")) {
      problems.push("something began to play");
    }
    if (sent().join() !== before.join()) problems.push(`the provider was asked: ${sent()}`);
    if (!(await exists(page, SHEET))) problems.push("the details closed");
    report("A click on the dots marks, and plays nothing", problems);
  }

  {
    const problems: string[] = [];
    // The second episode stopped a third of the way in, as a play would have saved it.
    const details = await invoke<TitleDetails>(page, "ondemand.details", {
      kind: "series",
      version: { subscriptionId: one.id, id: SERIES.id },
    });
    const file =
      details.kind === "series"
        ? details.seasons
            .flatMap((season) => season.episodes)
            .find((each) => each.season === 1 && each.number === 2)
        : undefined;
    if (!file) throw new Error("The series lists no second episode.");
    /** A checkpoint of the play of it that began just now. */
    const began = Date.now();
    const checkpoint = (position: number) =>
      invoke(page, "viewing.recordProgress", {
        commandId: crypto.randomUUID(),
        title: {
          kind: "episode",
          subscriptionId: one.id,
          id: file.id,
          seriesId: SERIES.id,
          season: 1,
          episode: 2,
        },
        position,
        duration: 2700,
        since: began,
      });
    await checkpoint(900);
    await waitFor(async () => (await mainAction(page)) === "Resume S1 E2", 15_000).catch(() => {
      problems.push("the details don't offer Resume");
    });
    const partway = await textOf(page, row("S1 E2"));
    if (!partway.includes("30 min left")) problems.push(`the row reads "${partway}"`);
    await click(page, dots("S1 E2"));
    await waitFor(() => page.evaluate<boolean>(`${ITEMS}.length === 2`), 10_000);
    const disabled = await page.evaluate<number>(
      `${ITEMS}.filter((each) => each.hasAttribute("data-disabled")).length`,
    );
    if (disabled > 0) problems.push("an episode stopped partway doesn't offer both marks");
    await click(page, `${ITEMS}.find((each) => each.innerText.startsWith("Mark unwatched"))`);
    await waitFor(async () => (await mainAction(page)) === "Play S1 E2", 15_000).catch(() => {
      problems.push("the series didn't go back to the episode's beginning");
    });
    if ((await textOf(page, row("S1 E2"))).includes("min left")) {
      problems.push("the row kept its resume point");
    }
    // The play that was going saves on: the mark stands, and its Undo stays.
    await checkpoint(1500);
    if ((await mainAction(page)) !== "Play S1 E2" || !(await notice(page)).endsWith("Undo")) {
      problems.push(`a play from before the mark changed it: "${await mainAction(page)}"`);
    }
    await click(page, withText('[role="dialog"] button', "Undo"));
    await waitFor(async () => (await mainAction(page)) === "Resume S1 E2", 15_000).catch(() => {
      problems.push("Undo didn't bring Resume back");
    });
    if (!(await textOf(page, row("S1 E2"))).includes("30 min left")) {
      problems.push("the row lost where the episode stopped");
    }
    const { progress } = await standing(page, one.id);
    if (progress.length !== 1 || progress[0]?.position !== 900) {
      problems.push(`the record holds ${JSON.stringify(progress)}`);
    }
    report("An episode stopped partway resets, and Undo brings its Resume back", problems);
  }

  {
    const problems: string[] = [];
    await mark(page, "S1 E2", "Mark watched");
    await waitFor(() => checked(page, "S1 E2"), 15_000);
    const kept = await marks(page, one.id);
    page = await restart(page);
    await waitFor(() => exists(page, "document.querySelector('header')"), 60_000);
    await waitFor(() => listsLoaded(page), 60_000);
    if ((await marks(page, one.id)).join() !== kept.join()) {
      problems.push(`the record holds ${await marks(page, one.id)}`);
    }
    const { marked } = await invoke<Viewing>(page, "viewing.get");
    // Home's first row offers the series where its last mark said.
    await waitFor(
      () =>
        page.evaluate<boolean>(
          `[...document.querySelectorAll("h2")].some((each) => each.textContent.trim() === "Continue watching")`,
        ),
      30_000,
    ).catch(() => problems.push("Home has no Continue watching row"));
    const next = marked[0]?.next;
    if (!next) problems.push("the record says the series goes nowhere");
    else if (
      !(await page.evaluate<boolean>(
        `document.body.innerText.includes(${JSON.stringify(`S${next.season} E${next.episode}`)})`,
      ))
    ) {
      problems.push(`Home doesn't offer S${next.season} E${next.episode}`);
    }
    await openSeries(page);
    if (!(await checked(page, "S1 E1")) || !(await checked(page, "S1 E2"))) {
      problems.push("the rows lost their checks");
    }
    // The details go on with the episode Home offered.
    if (next && (await mainAction(page)) !== `Play S${next.season} E${next.episode}`) {
      problems.push(`the details read "${await mainAction(page)}"`);
    }
    report("The marks are there after a restart, in the details and on Home", problems);
  }

  {
    const problems: string[] = [];
    // The provider takes the first season's third episode out of the series.
    provider.serveTitles((all) => ({
      ...all,
      series: all.series.map((each) =>
        String(each.id) === SERIES.id
          ? {
              ...each,
              seasons: each.seasons.map((season, at) => (at === 0 ? season.slice(0, 2) : season)),
            }
          : each,
      ),
    }));
    await invoke(page, "ondemand.refresh", { subscriptionId: one.id });
    await key(page, "Escape", 27);
    // The sheet opens on the season the series now goes on in.
    await openSeries(page, "S2 E1");
    await waitFor(async () => (await mainAction(page)) === "Play S2 E1", 30_000).catch(() =>
      problems.push("the details still go on with the episode that went"),
    );
    await waitFor(async () => {
      const { marked } = await invoke<Viewing>(page, "viewing.get");
      return marked[0]?.next?.season === 2 && marked[0].next.episode === 1;
    }, 15_000).catch(() => problems.push("the record still goes on with the episode that went"));
    await key(page, "Escape", 27);
    await click(page, withText("header button", "Home"));
    await waitFor(
      () => page.evaluate<boolean>(`document.body.innerText.includes("S2 E1")`),
      15_000,
    ).catch(() => problems.push("Home doesn't offer S2 E1"));
    if (await page.evaluate<boolean>(`document.body.innerText.includes("S1 E3")`)) {
      problems.push("Home still offers S1 E3");
    }
    report("Home and the details go on past an episode the provider took out", problems);
  }

  {
    const problems: string[] = [];
    await key(page, "Escape", 27);
    await addSubscription(page, second, SECOND);
    await key(page, "Escape", 27);
    await waitFor(() => listsLoaded(page), 60_000);
    const two = (await invoke<SubscriptionSummary[]>(page, "subscription.list")).find(
      (each) => each.name === SECOND,
    );
    if (!two) throw new Error("The second subscription wasn't saved.");
    const mine = await marks(page, one.id);
    await openSeries(page, "S2 E1");
    // The second's version, from the menu beside Play, which names each one's subscription.
    await click(page, `${SHEET}.querySelector('[aria-label="Versions"]')`);
    const versions = `[...document.querySelectorAll('[role="menuitemradio"]')]`;
    await waitFor(() => page.evaluate<boolean>(`${versions}.length > 1`), 10_000);
    await click(
      page,
      `${versions}.find((each) => each.innerText.includes(${JSON.stringify(SECOND)}))`,
    );
    await waitFor(
      async () =>
        (await exists(page, dots("S1 E1"))) &&
        !(await checked(page, "S1 E1")) &&
        (await textOf(page, SHEET)).includes(SECOND),
      30_000,
    ).catch(() => problems.push("the second's episodes show the first's checks"));

    await click(page, dots("S1 E1"));
    await waitFor(() => page.evaluate<boolean>(`${ITEMS}.length === 2`), 10_000);
    const named = await page.evaluate<string[]>(`${ITEMS}.map((each) => each.innerText)`);
    if (!named.every((each) => each.includes(SECOND))) problems.push(`the dots offer ${named}`);
    await click(page, `${ITEMS}.find((each) => each.innerText.startsWith("Mark watched"))`);
    await waitFor(() => checked(page, "S1 E1"), 15_000).catch(() => {
      problems.push("the row got no check");
    });
    if (!(await notice(page)).startsWith(`S1 E1 marked watched on ${SECOND}`)) {
      problems.push(`the line reads "${await notice(page)}"`);
    }
    if ((await marks(page, two.id)).join() !== "1:1 watched") {
      problems.push(`the second's record holds ${await marks(page, two.id)}`);
    }
    if ((await marks(page, one.id)).join() !== mine.join()) {
      problems.push(`the first's record changed to ${await marks(page, one.id)}`);
    }
    await click(page, withText('[role="dialog"] button', "Undo"));
    await waitFor(async () => (await marks(page, two.id)).length === 0, 15_000).catch(() => {
      problems.push("the second's mark wasn't taken back");
    });
    if ((await marks(page, one.id)).join() !== mine.join()) {
      problems.push(`Undo changed the first's record to ${await marks(page, one.id)}`);
    }
    report("Each subscription keeps its own marks of a series both list, and says whose", problems);
  }
  page.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  failed = true;
} finally {
  app.kill("SIGKILL");
  await Promise.all([provider.close(), second.close(), tmdb.close()]);
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
