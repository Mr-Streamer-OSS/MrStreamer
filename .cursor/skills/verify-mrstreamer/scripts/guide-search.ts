// Public window proof for the full-horizon guide search. Only the provider boundary is fake.
import { translate } from "../../../../packages/core/src/i18n.ts";
import { addBackup, openList } from "./custom-lists.ts";
import type { Driver } from "./language.ts";

const named = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;

const rows = "document.querySelectorAll('[data-guide-row]').length";
const field = "document.querySelector('section input')";

/** The fixture's channel, as rows name it. */
const CHANNEL = "H.264 + AAC";

/**
 * Whether ⌘K's guide row, brought into view the way a viewer scrolls the results, lies inside the
 * window where a pointer lands on it.
 */
const PRESSABLE = `(async () => {
  const row = document.querySelector('[data-guide-search]');
  row.scrollIntoView({ block: 'nearest' });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const box = row.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return box.top >= 0 && box.bottom <= innerHeight && !!hit && row.contains(hit);
})()`;

/**
 * What the open guide search hides: a field or button reaching outside the window or a box that
 * clips it, and a row whose programme title or channel is cut. Text is measured as painted, so the
 * check holds whatever elements the row is built from.
 */
const LAYOUT = `(() => {
  const problems = [];
  const section = document.querySelector('[data-guide-row]').closest('section');
  const cut = (box, from) => {
    if (box.left < -0.5 || box.right > innerWidth + 0.5) return true;
    for (let parent = from; parent && parent !== document.documentElement; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX === 'visible') continue;
      const edge = parent.getBoundingClientRect();
      if (box.left < edge.left - 0.5 || box.right > edge.right + 0.5) return true;
    }
    return false;
  };
  const name = e => e.getAttribute('aria-label') || e.placeholder || e.textContent.trim();
  for (const control of section.querySelectorAll('input, button:not([data-guide-row])'))
    if (control.checkVisibility() && cut(control.getBoundingClientRect(), control.parentElement))
      problems.push('"' + name(control) + '" reaches outside the window');
  const text = (row, test) => {
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode())
      if (test(node.data.trim())) {
        const range = document.createRange();
        range.selectNodeContents(node);
        return { box: range.getBoundingClientRect(), from: node.parentElement, data: node.data.trim() };
      }
  };
  const rows = [...section.querySelectorAll('[data-guide-row]')];
  const titles = [], channels = [];
  for (const row of rows) {
    const title = text(row, data => data.startsWith('Weekly '));
    const channel = text(row, data => data === ${JSON.stringify(CHANNEL)});
    if (!title || title.box.width === 0 || cut(title.box, title.from)) titles.push(title?.data ?? '?');
    if (!channel || channel.box.width === 0 || cut(channel.box, channel.from)) channels.push(title?.data ?? '?');
  }
  if (titles.length) problems.push(titles.length + ' of ' + rows.length + ' titles are cut, such as ' + titles[0]);
  if (channels.length) problems.push(channels.length + ' of ' + rows.length + ' channels are cut, such as on ' + channels[0]);
  return {
    problems,
    rows: rows.length,
    scrollWidth: document.documentElement.scrollWidth,
    field: section.querySelector('input').getBoundingClientRect().toJSON(),
    firstRow: rows[0].getBoundingClientRect().toJSON(),
  };
})()`;

/** A multi-page guide with past, current and future airings and optional episode facts. */
export function searchGuide(): string {
  const stamp = (n: number) =>
    new Date(n).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";

  const now = Math.floor(Date.now() / 3600000) * 3600000;
  const id = "aac.test";

  const programmes = Array.from({ length: 240 }, (_, i) => {
    const start = now + (i - 48) * 3600000;

    const metadata =
      i % 3 === 0
        ? '<episode-num system="xmltv_ns">1.3.</episode-num><sub-title>The Final Lap</sub-title><previously-shown/><premiere>Festival</premiere>'
        : i % 3 === 1
          ? '<episode-num system="xmltv_ns">broken</episode-num><new/>'
          : "";

    return `<programme channel="${id}" start="${stamp(start)}" stop="${stamp(start + 3600000)}"><title>Weekly ${i === 0 ? "ArchiveOnly" : i}</title><desc>Fixture programme ${i}</desc>${metadata}</programme>`;
  });

  return `<tv><channel id="${id}"><display-name>Fixture</display-name></channel>${programmes.join("")}</tv>`;
}

function expect(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

/** Header and palette entry, paging/reset, day filters, save/restart/remove and keyboard exit. */
export async function guideSearchScenario(d: Driver, otherUrl: string): Promise<void> {
  const button = (text: string) => named("section button", text);

  const search = async (text: string) => {
    await d.click("Focus guide search", field);

    for (const type of ["rawKeyDown", "keyUp"])
      await d.send("Input.dispatchKeyEvent", {
        type,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
    await d.send("Input.insertText", { text });
    await d.wait(async () => (await d.evaluate<number>(rows)) > 0);
  };

  /** Ctrl K, "Weekly", until the row that searches every guide day is listed and settled. */
  const palette = async (text = "Weekly") => {
    for (const type of ["rawKeyDown", "keyUp"])
      await d.send("Input.dispatchKeyEvent", {
        type,
        key: "k",
        code: "KeyK",
        windowsVirtualKeyCode: 75,
        modifiers: 2,
      });
    await d.wait(() => d.exists("document.querySelector('[role=dialog] input[role=combobox]')"));
    await d.send("Input.insertText", { text });
    await d.wait(() => d.exists("document.querySelector('[data-guide-search]')"));
    await d.wait(() =>
      d.evaluate<boolean>(
        "document.querySelector('[role=dialog]').getAnimations({ subtree: true }).every(a => a.playState !== 'running')",
      ),
    );
  };

  await d.click("Open Live TV", named("header button", "Live TV"));
  await openList(d, "News");
  await d.click("Oversized list search", "document.querySelector('[data-guide-search-opener]')");
  expect(
    await d.evaluate<boolean>(`${button("News")}.disabled`),
    "Oversized list cannot be applied",
  );
  expect(
    await d.evaluate<boolean>(
      "document.querySelector('section').textContent.includes('Over 100 channels')",
    ),
    "Oversized list explains why",
  );
  await d.capture("guide-oversized-list");
  await d.click(
    "Close oversized list",
    "document.querySelector('button[aria-label=\"Close guide search\"]')",
  );
  await openList(d, "Favourites");
  await d.click("Empty favourites search", "document.querySelector('[data-guide-search-opener]')");
  await d.wait(() => d.exists(button("Favourites")));
  expect(
    await d.evaluate<boolean>(`${button("Favourites")}.disabled`),
    "Empty list cannot be applied",
  );
  expect(
    await d.evaluate<boolean>(
      "document.querySelector('section').textContent.includes('None from this subscription')",
    ),
    "Empty list explains why",
  );
  await d.capture("guide-empty-favourites");
  await d.click(
    "Close empty favourites",
    "document.querySelector('button[aria-label=\"Close guide search\"]')",
  );
  await openList(d, "All channels");
  await d.click(
    "Favourite playable channel",
    "document.querySelector('main [data-index] button[aria-label=\"Add to favourites\"]')",
  );
  await openList(d, "Favourites");
  await d.click("Small list search", "document.querySelector('[data-guide-search-opener]')");
  await search("Weekly");
  await d.click("Apply small list", button("Favourites"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  await d.click("Leave small list filter", button("All channels"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  await d.click("Revisit small list filter", button("Favourites"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  await d.capture("guide-small-list-revisited");
  d.observed.smallListRevisitAndEmpty = true;
  await d.click(
    "Close list search",
    "document.querySelector('button[aria-label=\"Close guide search\"]')",
  );
  await openList(d, "All channels");
  await d.click("Header calendar", "document.querySelector('[data-guide-search-opener]')");
  await d.wait(() => d.exists(`${field} === document.activeElement`));
  await search("Weekly");
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  await d.capture("guide-first-page");
  await d.click("Show more", button("Show more"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 100);
  d.observed.paging = { first: 50, next: 100 };
  await d.capture("guide-second-page");
  await d.click("Tomorrow", button("Tomorrow"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 24);
  await d.click("Save search", button("Save search"));
  await d.wait(() => d.exists(button("Weekly")));
  await d.capture("guide-saved-tomorrow");
  await d.click("Any day", button("Any day"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  await d.click("Saved Weekly", button("Weekly"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 24);
  await d.quit();
  await d.launch();
  await d.click("Open Live TV after restart", named("header button", "Live TV"));
  await d.click(
    "Header calendar after restart",
    "document.querySelector('[data-guide-search-opener]')",
  );
  await d.wait(() => d.exists(button("Weekly")));
  await d.click("Apply saved search after restart", button("Weekly"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 24);
  d.observed.savedRestart = true;
  await d.capture("guide-restarted-save");
  await d.click(
    "Remove saved search",
    "document.querySelector('section button[aria-label=\"Remove Weekly\"]')",
  );
  await d.wait(async () => !(await d.exists(button("Weekly"))));
  await d.click("Any day", button("Any day"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);

  const labels = await d.evaluate<string[]>(
    "[...document.querySelectorAll('[data-guide-row]')].map(e=>e.getAttribute('aria-label'))",
  );

  expect(
    labels.some((s) => s.includes("S2 E4") && s.includes("Shown before")),
    "Valid optional episode metadata is visible",
  );
  expect(
    labels.some((s) => !s.includes("S2 E4")),
    "Missing/malformed episode metadata does not hide programme",
  );
  d.observed.episodeLabels = labels;
  await d.click("Focus field for keyboard", field);
  await d.key("ArrowDown", 40);
  await d.key("End", 35);
  expect(
    await d.exists(
      "document.activeElement === [...document.querySelectorAll('[data-guide-row]')].at(-1)",
    ),
    "End reaches final row",
  );
  await d.key("Home", 36);
  await d.key("Enter", 13);
  await d.capture("guide-row-detail");
  await d.key("Escape", 27);
  await d.wait(() => d.exists(`${field} === document.activeElement`));
  await d.key("Escape", 27);
  await d.wait(() => d.exists(`${field}?.value === ''`));
  await d.key("Escape", 27);
  await d.wait(() => d.exists("document.activeElement?.matches('[data-guide-search-opener]')"));
  d.observed.escapeRestoresOpener = true;

  await palette();
  await d.capture("palette-guide-last-row");
  await d.click("Palette guide search", "document.querySelector('[data-guide-search]')");
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  expect(await d.exists(`${field}.value === 'Weekly'`), "Palette preserves typed words");
  d.observed.paletteSeed = "Weekly";
  await d.capture("guide-from-palette");

  // ArchiveOnly is past the ordinary palette guide horizon and has no catalogue/channel match.
  await d.click(
    "Close search before keyboard palette",
    "document.querySelector('button[aria-label=\"Close guide search\"]')",
  );
  await palette("ArchiveOnly");
  expect(
    await d.evaluate<boolean>(
      "document.querySelectorAll('[role=dialog] [role=treeitem]').length === 1",
    ),
    "Only the guide-search action remains",
  );
  expect(
    await d.evaluate<boolean>(
      "!document.querySelector('[role=dialog]').textContent.includes('No matches')",
    ),
    "Guide-only palette is not labelled empty",
  );

  const guideIndex = await d.evaluate<number>(
    "Number(document.querySelector('[data-guide-search]').dataset.index)",
  );

  for (let i = 0; i < guideIndex; i++) await d.key("ArrowDown", 40);
  await d.key("Enter", 13);
  await d.wait(async () => (await d.evaluate<number>(rows)) === 1);
  expect(await d.exists(`${field}.value === 'ArchiveOnly'`), "Keyboard palette transfers query");
  d.observed.paletteKeyboardGuideOnly = true;

  await search("Weekly 49");
  await d.wait(async () => (await d.evaluate<number>(rows)) > 0);
  await d.click(
    "Open future programme",
    "[...document.querySelectorAll('[data-guide-row]')].find(e => /, Weekly 49(?:,|$)/.test(e.getAttribute('aria-label')))",
  );
  await d.click("Remind from search", button("Remind me"));
  await d.wait(() =>
    d.exists("document.querySelector('[data-guide-row] [aria-label=\"Reminder set\"]')"),
  );
  await d.click(
    "Close search to inspect header bell",
    "document.querySelector('button[aria-label=\"Close guide search\"]')",
  );
  await d.wait(() =>
    d.exists("document.querySelector('button[aria-label=\"Reminders, 1 to come\"]')"),
  );
  await d.click(
    "Open reminder bell",
    "document.querySelector('button[aria-label=\"Reminders, 1 to come\"]')",
  );
  await d.wait(() => d.exists("document.querySelector('[role=dialog][aria-label=Reminders]')"));
  await d.capture("guide-reminder-bell");
  await d.key("Escape", 27);

  await d.capture("guide-future-reminder");
  await d.quit();
  await d.launch();
  await d.click("Return Live TV for reminder", named("header button", "Live TV"));
  await d.click(
    "Search after reminder restart",
    "document.querySelector('[data-guide-search-opener]')",
  );
  await search("Weekly 49");
  await d.wait(() =>
    d.exists("document.querySelector('[data-guide-row] [aria-label=\"Reminder set\"]')"),
  );
  await d.click("Open persisted reminder", "document.querySelector('[data-guide-row]')");
  await d.click("Remove reminder from search", button("Reminder set"));
  await d.wait(
    async () =>
      !(await d.exists("document.querySelector('[data-guide-row] [aria-label=\"Reminder set\"]')")),
  );
  d.observed.searchReminderPersistedAndRemoved = true;
  await search("Weekly 48");
  await d.wait(async () => (await d.evaluate<number>(rows)) > 0);
  await d.click(
    "Open on-now programme",
    "[...document.querySelectorAll('[data-guide-row]')].find(e => /, Weekly 48(?:,|$)/.test(e.getAttribute('aria-label')))",
  );
  await d.click("Watch from search", button("Watch"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=watch]') && (document.querySelector('video')?.videoWidth ?? 0) > 0 && (document.querySelector('video')?.currentTime ?? 0) > 0",
    ),
  );
  d.observed.searchWatch = await d.evaluate(
    "(() => { const v = document.querySelector('video'); return { width: v.videoWidth, time: v.currentTime }; })()",
  );
  await d.wait(() => d.evaluate<boolean>("!document.body.innerText.includes('Tuning')"));
  await d.capture("guide-watch-playback");
  await d.click("Stop proved playback", "document.querySelector('button[aria-label=Stop]')");

  if (await d.exists("document.querySelector('[data-view=watch]')")) await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=watch]')")));
  await addBackup(d, otherUrl);
  await d.click("Live TV with two sources", named("header button", "Live TV"));

  if (await d.exists("document.querySelector('[data-guide-search-opener]')"))
    await d.click("Open two-source search", "document.querySelector('[data-guide-search-opener]')");

  const primary = await d.evaluate<string>(
    "[...document.querySelectorAll('section button[aria-pressed=true]')].map(e=>e.textContent).find(t=>t !== 'Any day' && t !== 'All channels')",
  );

  await d.click("Choose Backup source", button("Backup"));
  await search("BackupWeekly");
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  expect(
    await d.evaluate<boolean>(
      "[...document.querySelectorAll('[data-guide-row]')].every(e=>e.textContent.includes('Backup') && e.textContent.includes('BackupWeekly'))",
    ),
    "Backup results identify their own source",
  );
  await d.click("Save Backup search", button("Save search"));
  await d.wait(() => d.exists(button("BackupWeekly")));
  await d.capture("guide-backup-save");
  await d.click("Return first source", button(primary));
  await d.wait(async () => !(await d.exists(button("BackupWeekly"))));
  await search("Weekly");
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  expect(
    await d.evaluate<boolean>(
      "[...document.querySelectorAll('[data-guide-row]')].every(e=>!e.textContent.includes('Backup'))",
    ),
    "First source results stay separate",
  );
  await d.click("Return Backup saved search", button("Backup"));
  await d.wait(() => d.exists(button("BackupWeekly")));
  await d.click("Apply Backup saved search", button("BackupWeekly"));
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  d.observed.twoSourcesResultsAndSaves = true;
  await d.click(
    "Settings to remove chosen Backup",
    "document.querySelector('header button[aria-pressed]')",
  );
  await d.click("Subscriptions to remove chosen source", named("nav button", "Subscriptions"));
  const backup = "document.querySelectorAll('main section > ul > li')[1]";

  if (!(await d.exists(`${backup}.querySelector('[role=region]')`)))
    await d.click("Expand Backup subscription", `${backup}.querySelector('button')`);
  await d.click(
    "Ask remove Backup",
    `[...${backup}.querySelectorAll('button')].find(e=>e.textContent.trim() === 'Remove Backup')`,
  );
  await d.wait(() => d.exists(`${backup}.querySelector('[role=checkbox]')`));
  await d.click(
    "Remove Backup keeping saved data",
    `[...${backup}.querySelectorAll('button')].find(e=>e.textContent.trim() === 'Remove')`,
  );
  await d.wait(() =>
    d.evaluate<boolean>("document.querySelectorAll('main section > ul > li').length === 1"),
  );
  await d.key("Escape", 27);
  await d.click("Live TV after source removal", named("header button", "Live TV"));
  await search("Weekly");
  await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
  expect(
    await d.evaluate<boolean>(
      "[...document.querySelectorAll('[data-guide-row]')].every(e=>!e.textContent.includes('Backup'))",
    ),
    "Removed chosen source falls back to remaining guide",
  );
  d.observed.sourceRemovalFallback = true;
  await d.capture("guide-source-removal-fallback");

  // Every language at the smallest window with text enlarged by a quarter: ⌘K's guide row is
  // pressed by pointer, and the panel keeps its controls, titles and channels inside the window.
  const problems: string[] = [];

  for (const locale of ["en_US", "nl_NL", "fr_FR", "de_DE", "es_ES"]) {
    await d.quit();
    await d.launch(locale);
    await d.send("Emulation.setDeviceMetricsOverride", {
      width: 960,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await d.wait(() => d.evaluate<boolean>("innerWidth === 960 && innerHeight === 600"));
    // Text enlargement is a rendering probe; application state still changes through controls.
    await d.evaluate("document.documentElement.style.fontSize = '125%'");

    const language = await d.evaluate<"en-US" | "nl-NL" | "fr-FR" | "de-DE" | "es-ES">(
      "document.documentElement.lang",
    );

    await d.click("Open localized Live TV", named("header button", translate(language, "Live TV")));
    await palette();
    const pressable = await d.evaluate<boolean>(PRESSABLE);

    await d.capture(`palette-${locale}-960-text125`);

    if (pressable) {
      await d.click(
        "Localized palette guide search",
        "document.querySelector('[data-guide-search]')",
      );
      await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
      expect(await d.exists(`${field}.value === 'Weekly'`), "Palette preserves typed words");
    } else {
      problems.push(`${locale}: ⌘K's guide row can't be pressed inside the window`);
      await d.key("Escape", 27);
      await d.wait(async () => !(await d.exists("document.querySelector('[role=dialog]')")));
      await d.click(
        "Localized header calendar",
        "document.querySelector('[data-guide-search-opener]')",
      );
      await search("Weekly");
      await d.wait(async () => (await d.evaluate<number>(rows)) === 50);
    }

    const layout = await d.evaluate<{ problems: string[] }>(LAYOUT);

    problems.push(...layout.problems.map((problem) => `${locale}: ${problem}`));
    d.observed[`layout-${locale}`] = {
      lang: language,
      font: await d.evaluate<string>("getComputedStyle(document.documentElement).fontSize"),
      ...layout,
    };
    await d.capture(`guide-${locale}-960-text125`);
  }

  d.observed.layoutProblems = problems;
  expect(problems.length === 0, `Readable at 960 × 600 with 125% text:\n${problems.join("\n")}`);
}
