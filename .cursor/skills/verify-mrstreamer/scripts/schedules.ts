// Scheduling through the built window, against the fake provider's one connection: Record's At a
// time, the guide grid's schedule panel for a programme once and on its weekday, the conflict the
// channel below shows at the same time, Scheduled in Recordings with Edit and Cancel schedule, and
// a missed and a late row. Those two are written into recordings.json while the app is closed, as
// the Recordings service writes them (apps/desktop/test/recordings.test.ts proves the service
// does). Each state is captured at 1280 × 800, 960 × 600, with a quarter larger text, and in German.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Driver } from "./language.ts";

const named = (selector: string, text: string, within = "document") =>
  `[...${within}.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const POPUP = "document.querySelector('[role=dialog][aria-label=Record]')";
const GRID = "document.querySelector('[role=grid]')";
const DETAILS = "document.querySelector('[role=grid] [role=region]')";
const PANEL = "document.querySelector('[role=grid] [role=group]')";
const expect = (value: boolean, message: string, seen?: unknown) => {
  if (!value) throw new Error(`${message}${seen === undefined ? "" : `: ${JSON.stringify(seen)}`}`);
};

async function size(d: Driver, width: number, height: number) {
  d.action(`Size the page ${width} × ${height}`);
  await d.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await d.wait(() => d.evaluate<boolean>(`innerWidth === ${width} && innerHeight === ${height}`));
}

const text = (d: Driver, expression: string) =>
  d.evaluate<string>(`${expression}?.innerText ?? ''`);

export async function schedulesScenario(d: Driver) {
  await size(d, 1280, 800);
  await d.click("Open global Search", "document.querySelector('button[aria-label=Search]')");
  await d.send("Input.insertText", { text: "TEST | H.264 + AAC" });
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
    ),
  );
  await d.key("Enter", 13);
  await d.wait(() =>
    d.evaluate<boolean>(
      "!!document.querySelector('[data-view=watch]') && (document.querySelector('video')?.currentTime ?? 0) >= 1",
    ),
  );
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[data-view=watch]')")));
  await d.click("Open Live TV", named("header button", "Live TV"));
  const record = named("button", "Record");
  await d.wait(() => d.exists(record));

  // 1 · Record now's At a time.
  await d.click("Open Record", record);
  await d.wait(() => d.exists(POPUP));
  await d.click("At a time…", `${POPUP}.querySelector("[data-choice=at]")`);
  await d.wait(() =>
    d.evaluate<boolean>("document.activeElement?.matches('input[type=time]') ?? false"),
  );
  d.observed["atATime"] = await text(d, POPUP);
  await d.capture("1-record-at-a-time");
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(POPUP)));

  // 2 · The grid's next programme, its schedule panel, Once and a repeat.
  await d.key("g", 71);
  await d.wait(() => d.exists(GRID));
  await d.wait(() => d.evaluate<boolean>(`${GRID}.querySelectorAll('[role=gridcell]').length > 4`));
  await d.key("ArrowRight", 39);
  await d.wait(() => d.exists(DETAILS));
  const detailsRecord = named("[role=grid] [role=region] button", "Record");
  await d.click("Record the next programme", detailsRecord);
  await d.wait(() => d.exists(PANEL));
  await d.wait(async () => (await text(d, PANEL)).includes("A connection is free then."));
  d.observed["focusInPanel"] = await d.evaluate<boolean>(
    `${PANEL}.contains(document.activeElement)`,
  );
  d.observed["once"] = await text(d, PANEL);
  await d.capture("2-guide-once");
  await d.click("Repeat on its weekday", `${PANEL}.querySelector('[data-repeat=day]')`);
  await d.click(
    "A minute more at the end",
    `[...${PANEL}.querySelectorAll('button[aria-hidden]')].filter(e => e.textContent.trim() === '+')[1]`,
  );
  await d.wait(async () => (await text(d, PANEL)).includes("6 min late"));
  await d.wait(async () => (await text(d, PANEL)).includes("days "));
  // Arrows inside the panel step the padding, and the grid stays where it is.
  const selected = () =>
    d.evaluate<string>(
      `document.querySelector('[role=grid] [role=gridcell][aria-selected=true]')?.getAttribute('aria-label') ?? ''`,
    );
  const before = await selected();
  await d.evaluate(`${PANEL}.querySelector('[role=spinbutton]').focus()`);
  await d.key("ArrowUp", 38);
  await d.key("ArrowDown", 40);
  await d.key("ArrowUp", 38);
  await d.wait(async () => (await text(d, PANEL)).includes("3 min early"));
  expect((await selected()) === before, "Keys in the panel moved the grid");
  d.observed["repeat"] = await text(d, PANEL);
  await d.capture("2-guide-repeat");
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists(PANEL)));
  d.observed["escapeFocus"] = await d.evaluate<string>("document.activeElement?.textContent ?? ''");
  expect(
    await d.evaluate<boolean>(`document.activeElement === ${detailsRecord}`),
    "Escape left the focus elsewhere",
  );
  expect(await d.exists(GRID), "Escape left the grid");

  await d.click("Record again", detailsRecord);
  await d.wait(async () => (await text(d, PANEL)).includes("A connection is free then."));
  await d.click("Schedule", named("button", "Schedule", PANEL));
  await d.wait(async () => !(await d.exists(PANEL)));
  await d.wait(() => d.exists(named("[role=grid] [role=region] button", "Scheduled")));
  d.observed["scheduledCell"] = await selected();
  await d.capture("2-guide-scheduled");

  // 3 · The channel below at the same time: the one connection is the first schedule's.
  await d.key("ArrowDown", 40);
  await d.wait(async () => (await selected()) !== d.observed["scheduledCell"]);
  await d.click("Record below", detailsRecord);
  await d.wait(async () => (await text(d, PANEL)).includes("Every connection is in use"));
  d.observed["conflict"] = await text(d, PANEL);
  await d.capture("3-guide-conflict");
  await d.click("Every day", `${PANEL}.querySelector('[data-repeat=every]')`);
  await d.wait(async () => (await text(d, PANEL)).includes("Every day "));
  await d.click("Schedule anyway", named("button", "Schedule anyway", PANEL));
  await d.wait(async () => !(await d.exists(PANEL)));

  // 5 · Recordings, with a missed and a late one written in while the app is closed.
  await d.click("Open Recordings", named("header button", "Recordings"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelectorAll('section[aria-label=Scheduled] li').length === 2",
    ),
  );
  await d.capture("5-recordings-scheduled");
  await d.click(
    "Edit the first schedule",
    "document.querySelector('section[aria-label=Scheduled] button[aria-label^=Edit]')",
  );
  await d.wait(() => d.exists("document.querySelector('[role=dialog] [role=group]')"));
  await d.wait(async () =>
    (await text(d, "document.querySelector('[role=dialog]')")).includes(" on "),
  );
  await d.capture("5-recordings-edit");
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.exists("document.querySelector('[role=dialog]')")));

  // The channel the first schedule records, for the rows written in.
  const channel = await d.evaluate<{ subscriptionId: string; id: string }>(`(async () => {
    const read = await window.mrStreamer.invoke('recordings.schedules');
    return read.value[0].plan.channel;
  })()`);
  await d.quit();
  const root = join(d.profile, "recordings");
  await mkdir(root, { recursive: true });
  const path = join(root, "recordings.json");
  const kept = await readFile(path, "utf8").then(
    (raw) => JSON.parse(raw) as { version: number; recordings: unknown[] },
    () => ({ version: 1, recordings: [] as unknown[] }),
  );
  const now = Date.now();
  const hour = 3_600_000;
  await mkdir(join(root, "late1"), { recursive: true });
  await writeFile(join(root, "late1", "late.ts"), Buffer.alloc(188 * 1000));
  kept.recordings.push(
    {
      id: "missed1",
      file: "missed.ts",
      channel,
      channelName: "TEST | H.264 + AAC",
      title: "Tide Tables",
      start: now - 30 * hour,
      stop: now - 29 * hour,
      scheduled: { schedule: "gone", from: now - 30 * hour, late: "away" },
      ended: null,
      bytes: 0,
      status: { kind: "missed", why: "away" },
    },
    {
      id: "late1",
      file: "late.ts",
      channel,
      channelName: "TEST | H.264 + AAC",
      title: "The Long Table",
      start: now - 50 * hour + 6 * 60_000,
      stop: now - 49 * hour,
      scheduled: { schedule: "gone", from: now - 50 * hour, late: "busy" },
      ended: now - 49 * hour,
      bytes: 188 * 1000,
      status: { kind: "complete" },
    },
  );
  await writeFile(path, JSON.stringify(kept));
  await d.launch();
  await size(d, 1280, 800);
  await d.click("Open Recordings", named("header button", "Recordings"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelectorAll('section[aria-label=Recorded] li').length === 2",
    ),
  );
  d.observed["page"] = await text(d, "document.querySelector('#root')");
  await d.capture("5-recordings-1280");

  // 10 · Narrow.
  await size(d, 960, 600);
  await d.capture("10-recordings-960");
  await d.click(
    "Edit at 960",
    "document.querySelector('section[aria-label=Scheduled] button[aria-label^=Edit]')",
  );
  await d.wait(() => d.exists("document.querySelector('[role=dialog] [role=group]')"));
  await d.capture("10-recordings-edit-960");
  await d.key("Escape", 27);
  await d.click("Live TV at 960", named("header button", "Live TV"));
  if (!(await d.exists(GRID))) await d.key("g", 71);
  await d.wait(() => d.exists(GRID));
  await d.wait(() => d.evaluate<boolean>(`${GRID}.querySelectorAll('[role=gridcell]').length > 4`));
  await d.key("ArrowRight", 39);
  await d.key("ArrowRight", 39);
  await d.wait(() => d.exists(DETAILS));
  await d.click(
    "Record at 960",
    `[...document.querySelectorAll('[role=grid] [role=region] button')].find(e => /^(Record|Scheduled)$/.test(e.textContent.trim()))`,
  );
  await d.wait(() => d.exists(PANEL));
  await d.wait(async () => (await text(d, PANEL)).includes(" on "));
  await d.capture("10-guide-960");
  await d.key("Escape", 27);

  // Cancel a schedule from its menu.
  await d.click("Recordings at 960", named("header button", "Recordings"));
  await d.click(
    "Open the schedule's menu",
    "document.querySelector('section[aria-label=Scheduled] button[aria-label^=\"More for\"]')",
  );
  await d.click("Cancel schedule", named("[role=menuitem]", "Cancel schedule"));
  await d.wait(() =>
    d.evaluate<boolean>(
      "document.querySelectorAll('section[aria-label=Scheduled] li').length === 1",
    ),
  );
  await d.capture("10-recordings-cancelled-960");

  // Larger text at 960: the root a quarter larger.
  await d.evaluate(
    "document.documentElement.style.fontSize = (parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.25) + 'px'",
  );
  await d.capture("10-recordings-960-larger");
  await d.click(
    "Edit, larger",
    "document.querySelector('section[aria-label=Scheduled] button[aria-label^=Edit]')",
  );
  await d.wait(() => d.exists("document.querySelector('[role=dialog] [role=group]')"));
  await d.capture("10-recordings-edit-960-larger");
  await d.key("Escape", 27);
  await d.click("Live TV, larger", named("header button", "Live TV"));
  await d.wait(() => d.exists(GRID));
  // Home takes the cursor, and the grid with it, back to the first channel: the 960 step left
  // the grid scrolled, which larger text can leave above the cursor's row.
  await d.key("Home", 36);
  await d.key("ArrowRight", 39);
  await d.wait(() => d.exists(DETAILS));
  await d.click(
    "Record, larger",
    `[...document.querySelectorAll('[role=grid] [role=region] button')].find(e => /^(Record|Scheduled)$/.test(e.textContent.trim()))`,
  );
  await d.wait(() => d.exists(PANEL));
  await d.wait(async () => (await text(d, PANEL)).includes(" on "));
  await d.capture("10-guide-960-larger");
  await d.key("Escape", 27);

  // Another language.
  await d.quit();
  await d.launch("de_DE");
  await size(d, 1280, 800);
  await d.click("Aufnahmen", "document.querySelectorAll('header button')[4]");
  await d.wait(() => d.evaluate<boolean>("document.querySelectorAll('section li').length >= 3"));
  await d.capture("lang-de-recordings");
  await d.click("Bearbeiten", "document.querySelector('section button[aria-label$=bearbeiten]')");
  await d.wait(() => d.exists("document.querySelector('[role=dialog] [role=group]')"));
  await d.wait(async () =>
    (await text(d, "document.querySelector('[role=dialog]')")).includes(" auf "),
  );
  await d.capture("lang-de-edit");
  await d.key("Escape", 27);
}
