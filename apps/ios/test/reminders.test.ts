import { createRoot, document, type Root } from "./dom.ts";
import * as React from "react";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Programme } from "@mrstreamer/contracts/guide";
import { finish } from "@mrstreamer/core/steps";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, Member } from "../src/account.ts";
import type { Query, Result } from "../src/guide-native.ts";
import type { createGuide } from "../src/guide.ts";
import { programmeRange } from "../src/guide-ui.tsx";
import { combine, partSteps, type Channel } from "../src/library.ts";
import type { Notice, Permission, RemindersNative } from "../src/reminders.ts";
import { native as files } from "./native-files.ts";

// Programme reminders as the app keeps them (reminders.ts): over the real files stand-in, the real
// guide owner on the Linux guide fixture, and iOS's notification centre as `ios` below, which
// schedules, takes down and hands back a tap as the native module does. A launch imports the
// module again over the same files and the same notification centre.

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  catalogue: { kind: "loading" } as Catalogue,
  owner: null as ReturnType<typeof createGuide> | null,
  /** The programmes guide id `trusted-1` lists. */
  programmes: [] as Programme[],
  rosterChanged: new Set<() => void>(),
  catalogueChanged: new Set<() => void>(),
  appState: new Set<(state: string) => void>(),
  pushed: [] as unknown[],
  played: [] as unknown[],
  params: {} as Record<string, string>,
  /** How often iOS Settings was opened, and the alerts shown. */
  settings: 0,
  alerts: [] as string[],
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-router", () => ({
  router: { push: (href: unknown) => scenario.pushed.push(href) },
  useIsFocused: () => true,
  useLocalSearchParams: () => scenario.params,
}));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  Linking: { openURL: async () => undefined, openSettings: async () => void scenario.settings++ },
  Alert: { alert: (title: string) => void scenario.alerts.push(title) },
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      scenario.appState.add(listener);
      return { remove: () => void scenario.appState.delete(listener) };
    },
  },
}));
vi.mock("../src/account.ts", () => ({
  currentRoster: () => ({ kind: "ready", members: scenario.members }),
  onRoster: (listener: () => void) => {
    scenario.rosterChanged.add(listener);
    return () => void scenario.rosterChanged.delete(listener);
  },
  currentCatalogue: () => scenario.catalogue,
  onCatalogue: (listener: () => void) => {
    scenario.catalogueChanged.add(listener);
    return () => void scenario.catalogueChanged.delete(listener);
  },
  useCatalogue: () => scenario.catalogue,
  playChannel: (channel: Channel, _place: string, options: object) =>
    scenario.played.push({ play: channel.key, ...options }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("../src/artwork-cache.ts", () => ({ useArtwork: () => null }));
vi.mock("../src/header.tsx", () => ({ tabHref: (_tab: string, name: string) => `/live/${name}` }));
vi.mock("../src/playback.ts", () => ({
  usePlayback: () => ({ phase: { kind: "idle" }, watch: false }),
}));
vi.mock("../src/guide.ts", async (original) => {
  const actual = await original<typeof import("../src/guide.ts")>();
  // One owner across launches, as the guide's own files outlive the app's modules.
  if (scenario.owner) return { ...actual, guide: scenario.owner };
  const { guideFixture } = await import("./native-guide.ts");
  const fixture = guideFixture();
  fixture.native.query = async (_lease, _generation, _job, ids, at, mode, _from, _until, after) => {
    const listed = ids.includes("trusted-1") && scenario.programmes.some((p) => p.stop > at);
    const rows = mode === "detail" ? scenario.programmes.filter((p) => p.start === after) : [];
    return {
      kind: "ok",
      value: { guideId: listed ? "trusted-1" : null, rows, more: false },
    } satisfies Result<Query>;
  };
  fixture.control.activations.set("a", {
    lease: "lease-a",
    generation: { id: "db-a", fetchedAt: Date.now(), until: Date.now() + 7 * 86400_000 },
  });
  scenario.owner = actual.createGuide(() => fixture.native);
  return { ...actual, guide: scenario.owner };
});

/** iOS's notification centre, as the native module shows it to the app. */
const ios = {
  permission: "undetermined" as Permission,
  /** What the viewer answers iOS's prompt with. */
  answer: "granted" as Permission,
  asked: 0,
  scheduled: new Map<string, Notice>(),
  opened: null as { channel: string; at: number } | null,
  listeners: new Set<() => void>(),
};
const module: RemindersNative = {
  permission: async () => ios.permission,
  async ask() {
    ios.asked++;
    if (ios.permission === "undetermined") ios.permission = ios.answer;
    return ios.permission;
  },
  scheduled: async () => [...ios.scheduled.values()],
  async schedule(notices) {
    if (ios.permission !== "granted") return notices.map((each) => each.id);
    for (const notice of notices) ios.scheduled.set(notice.id, notice);
    return [];
  },
  async cancel(ids) {
    for (const id of ids) ios.scheduled.delete(id);
  },
  takeOpened() {
    const opened = ios.opened;
    ios.opened = null;
    return opened;
  },
  addListener(_event, listener) {
    ios.listeners.add(listener);
    return { remove: () => void ios.listeners.delete(listener) };
  },
};
const host: { expo?: { modules?: Record<string, unknown> } } = globalThis;
host.expo ??= {};
host.expo.modules ??= {};
host.expo.modules["ProgrammeReminders"] = module;

const member = (id: string): Member => ({
  entry: { id, kind: "xtream", server: "http://example.test", username: "fixture", name: null },
  label: id,
  account: null,
  needsSecret: false,
  live: { kind: "idle" },
  titles: { kind: "idle" },
});
/** Subscription `a`'s channels: `a:1` on guide id `trusted-1` and `a:2` without a guide. */
function lists(channels = ["1", "2"]) {
  return finish(
    partSteps({
      subscriptionId: "a",
      catalogue: {
        categories: [{ id: "news", name: "NL|News" }],
        channels: channels.map((id) => ({
          id,
          name: `Channel ${id}`,
          categoryIds: ["news"],
          guideId: id === "1" ? "trusted-1" : null,
          logoUrl: null,
          adult: false,
          number: null,
          catchupDays: null,
        })),
      },
    }),
  );
}
/** Live lists `channels` of `a`, and the guide reads them; everyone listening hears it. */
function shows(channels?: string[]) {
  const part = lists(channels);
  scenario.owner!.setPart(part);
  scenario.catalogue = { kind: "ready", failing: [], library: combine([{ label: "a", part }]) };
  for (const listener of scenario.catalogueChanged) listener();
}
const channel = (key = "a:1"): Channel => {
  const found = scenario.catalogue.kind === "ready" && scenario.catalogue.library.byKey.get(key);
  if (!found) throw new Error(`Live doesn't list ${key}`);
  return found;
};

const HOUR = 3600_000;
const now = Date.now();
const on: Programme = {
  title: "News",
  start: now - HOUR / 2,
  stop: now + HOUR / 2,
  description: null,
};
const later: Programme = {
  title: "Late film",
  start: now + 2 * HOUR,
  stop: now + 4 * HOUR,
  description: "A film",
};

type Reminders = typeof import("../src/reminders.ts");
let reminders: Reminders;
/** The app as a launch starts it: the module read afresh over the same files and iOS. */
async function launch() {
  scenario.rosterChanged.clear();
  scenario.catalogueChanged.clear();
  scenario.appState.clear();
  ios.listeners.clear();
  vi.resetModules();
  reminders = await import("../src/reminders.ts");
  reminders.startReminders();
  await settled();
}
/** Every check asked for has run. */
async function settled() {
  await reminders.checkReminders();
  await reminders.checkReminders();
}

let drawn: ReturnType<Reminders["useReminders"]> | null = null;
function Probe() {
  drawn = reminders.useReminders();
  return null;
}
let root: Root | null = null;
/** The reminders a screen shows now, as `title @ channel: status`. */
function shown() {
  root ??= createRoot(document.createElement("div"));
  React.act(() => root!.render(React.createElement(Probe)));
  if (drawn?.kind !== "read") return drawn?.kind;
  return drawn.reminders.map(
    (each) =>
      `${each.title} @ ${each.channelName}: ${each.status.kind === "changed" ? `changed from ${each.status.was}` : each.status.kind}`,
  );
}
const file = () => join(files.root, "documents", "reminders.json");
const notices = () =>
  [...ios.scheduled.values()].map((each) => `${each.title} at ${each.at - now}: ${each.body}`);

beforeEach(async () => {
  rmSync(file(), { force: true });
  rmSync(`${file()}.next`, { force: true });
  Object.assign(ios, { permission: "undetermined", answer: "granted", asked: 0, opened: null });
  ios.scheduled.clear();
  scenario.members = [member("a")];
  scenario.programmes = [on, later];
  scenario.pushed = [];
  scenario.played = [];
  scenario.params = {};
  scenario.settings = 0;
  scenario.alerts = [];
  await launch();
  await scenario.owner!.restore(["a"]);
  scenario.owner!.foreground();
  shows();
  await settled();
});
afterEach(() => {
  if (root) React.act(() => root!.unmount());
  root = null;
});

describe("programme reminders", () => {
  it("asks iOS once and notifies at the programme's start, for the programme set", async () => {
    await reminders.setReminder(channel(), later);
    expect(ios.asked).toBe(1);
    expect(notices()).toEqual([`Late film at ${2 * HOUR}: Starting now on Channel 1`]);
    expect(shown()).toEqual(["Late film @ Channel 1: upcoming"]);

    // Set again: the same reminder, and iOS isn't asked again.
    await reminders.setReminder(channel(), later);
    expect(ios.asked).toBe(1);
    expect(shown()).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  it("refuses a programme that has started, changing nothing", async () => {
    await expect(reminders.setReminder(channel(), on)).rejects.toMatchObject({
      error: { kind: "reminder", reason: "started" },
    });
    expect(shown()).toEqual([]);
    expect(ios.asked).toBe(0);
  });

  it("saves nothing while iOS doesn't let the app notify, and schedules again once it does", async () => {
    ios.answer = "denied";
    expect(await reminders.setReminder(channel(), later)).toBe("denied");
    expect(shown()).toEqual([]);
    expect(currentPermission()).toBe("denied");

    // Allowed in iOS Settings, then set.
    ios.permission = "granted";
    expect(await reminders.setReminder(channel(), later)).toBe("set");
    expect(notices()).toEqual([`Late film at ${2 * HOUR}: Starting now on Channel 1`]);

    // Turned off again in iOS Settings: back in the app, the screens say so.
    ios.permission = "denied";
    for (const listener of scenario.appState) listener("active");
    await settled();
    expect(currentPermission()).toBe("denied");
    expect(shown()).toEqual(["Late film @ Channel 1: upcoming"]);
  });

  it("is kept after a relaunch, notifying once", async () => {
    await reminders.setReminder(channel(), later);
    await launch();
    expect(shown()).toEqual(["Late film @ Channel 1: upcoming"]);
    expect(notices()).toEqual([`Late film at ${2 * HOUR}: Starting now on Channel 1`]);
  });

  it("never notifies for another programme the guide lists at its start", async () => {
    await reminders.setReminder(channel(), later);

    scenario.programmes = [on, { ...later, title: "Football" }];
    shows();
    await settled();
    expect(shown()).toEqual(["Football @ Channel 1: changed from Late film"]);
    expect(notices()).toEqual([]);

    scenario.programmes = [on];
    shows();
    await settled();
    expect(shown()).toEqual(["Football @ Channel 1: gone"]);
    expect(notices()).toEqual([]);

    // The programme set is back at its start.
    scenario.programmes = [on, later];
    shows();
    await settled();
    expect(shown()).toEqual(["Late film @ Channel 1: upcoming"]);
    expect(notices()).toEqual([`Late film at ${2 * HOUR}: Starting now on Channel 1`]);
  });

  it("keeps a reminder while its guide can't be read, and drops one its provider stopped listing", async () => {
    await reminders.setReminder(channel(), later);

    // The guide has nothing for the channel now: nothing is known, so nothing changes.
    scenario.programmes = [];
    shows();
    await settled();
    expect(shown()).toEqual(["Late film @ Channel 1: upcoming"]);
    expect(notices()).toHaveLength(1);

    scenario.programmes = [on, later];
    shows(["2"]);
    await settled();
    expect(shown()).toEqual(["Late film @ Channel 1: gone"]);
    expect(notices()).toEqual([]);
  });

  it("goes with its subscription, and when cancelled", async () => {
    await reminders.setReminder(channel(), later);
    const [set] = remindersShown();
    await reminders.cancelReminder(set!.id);
    expect(shown()).toEqual([]);
    expect(notices()).toEqual([]);

    await reminders.setReminder(channel(), later);
    scenario.members = [];
    for (const listener of scenario.rosterChanged) listener();
    await settled();
    expect(shown()).toEqual([]);
    expect(notices()).toEqual([]);
  });

  it("shows none and changes nothing while the file can't be read", async () => {
    writeFileSync(file(), JSON.stringify({ version: 2, reminders: [] }));
    await launch();
    expect(shown()).toBe("foreign");
    await expect(reminders.setReminder(channel(), later)).rejects.toMatchObject({
      error: { kind: "reminder", reason: "newer" },
    });
    expect(notices()).toEqual([]);
  });

  it("opens a tapped notification's programme on Live, playing nothing", async () => {
    await reminders.setReminder(channel(), later);
    ios.opened = { channel: "a:1", at: later.start };
    for (const listener of ios.listeners) listener();
    expect(scenario.pushed).toEqual([
      { pathname: "/live/programme", params: { channel: "a:1", start: String(later.start) } },
    ]);

    // The tap that launched the app is held until the screens mount.
    ios.opened = { channel: "a:1", at: later.start };
    scenario.pushed = [];
    await launch();
    expect(scenario.pushed).toHaveLength(1);

    // Its details read the programme by its start: no token outlives a launch.
    scenario.params = { channel: "a:1", start: String(later.start) };
    const { ProgrammeScreen } = await import("../src/guide-screen.tsx");
    const container = document.createElement("div");
    const screen = createRoot(container);
    await React.act(async () =>
      screen.render(React.createElement(ProgrammeScreen, { origin: "live" })),
    );
    await React.act(async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain("Late film");
    expect(container.textContent).toContain("A film");
    expect(scenario.played).toEqual([]);
    React.act(() => screen.unmount());
  });
});

/** A screen drawn as the viewer sees it, with what it says and its buttons. */
async function draw(element: React.ReactElement) {
  const container = document.createElement("div");
  const at = createRoot(container);
  await React.act(async () => at.render(element));
  await idle();
  return {
    text: () => container.textContent ?? "",
    has: (testID: string) => container.querySelector(`[data-testid="${testID}"]`) !== null,
    label: (label: string) => container.querySelector(`[aria-label="${label}"]`) !== null,
    async press(testID: string) {
      const button = [...container.querySelectorAll("button")].find(
        (each) => each.getAttribute("data-testid") === testID,
      );
      if (!button) throw new Error(`No ${testID} on screen: ${container.textContent}`);
      await React.act(async () => button.click());
      await settled();
      await idle();
    },
    close: () => React.act(() => at.unmount()),
  };
}
/** Every promise the screen started has settled, and React drew what they changed. */
async function idle() {
  await React.act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}
/** Programme details for `programme` of channel `a:1`, as a notification or the list opens them. */
async function details(programme: Programme) {
  scenario.params = { channel: "a:1", start: String(programme.start) };
  const { ProgrammeScreen } = await import("../src/guide-screen.tsx");
  return draw(React.createElement(ProgrammeScreen, { origin: "live" }));
}
async function list() {
  const { RemindersScreen } = await import("../src/reminders-screen.tsx");
  return draw(React.createElement(RemindersScreen));
}

describe("programme details", () => {
  it("sets a reminder beside Watch live, marks the time, and cancels it", async () => {
    const screen = await details(later);
    expect(screen.has("guide-watch-live")).toBe(true);
    await screen.press("guide-remind-me");
    expect(ios.asked).toBe(1);
    expect(shown()).toEqual(["Late film @ Channel 1: upcoming"]);
    expect(screen.label(`${programmeRange(later)}, Reminder set`)).toBe(true);
    expect(screen.has("guide-remind-me")).toBe(false);

    await screen.press("guide-cancel-reminder");
    expect(shown()).toEqual([]);
    expect(notices()).toEqual([]);
    expect(screen.label(`${programmeRange(later)}, Reminder set`)).toBe(false);
    expect(screen.has("guide-remind-me")).toBe(true);
    screen.close();
  });

  it("offers no reminder once the programme has started", async () => {
    scenario.programmes = [on, later];
    const screen = await details(on);
    expect(screen.text()).toContain("News");
    expect(screen.has("guide-watch-live")).toBe(true);
    expect(screen.has("guide-remind-me")).toBe(false);
    screen.close();
  });

  it("saves nothing where iOS refuses, and offers iOS Settings", async () => {
    ios.answer = "denied";
    const screen = await details(later);
    await screen.press("guide-remind-me");
    expect(shown()).toEqual([]);
    expect(screen.text()).toContain("Notifications are off for Mr. Streamer");
    expect(screen.has("guide-remind-me")).toBe(true);
    await screen.press("guide-open-settings");
    expect(scenario.settings).toBe(1);
    screen.close();
  });

  it("says a save failed, keeping Remind me", async () => {
    writeFileSync(file(), JSON.stringify({ version: 2, reminders: [] }));
    await launch();
    const screen = await details(later);
    await screen.press("guide-remind-me");
    expect(screen.text()).toContain("Couldn't save. Try again.");
    expect(screen.has("guide-remind-me")).toBe(true);
    screen.close();
  });
});

describe("the reminders list", () => {
  it("lists each by day, says what is off, opens and cancels", async () => {
    const film = await list();
    expect(film.text()).toContain("No reminders yet.");
    film.close();

    await reminders.setReminder(channel(), later);
    scenario.programmes = [on, { ...later, title: "Football" }];
    shows();
    await settled();
    const screen = await list();
    expect(screen.text()).toMatch(/^(Today|Tomorrow)C1Late film/);
    expect(screen.text()).toContain(`Channel 1 · ${programmeRange(later)}`);
    expect(screen.text()).toContain("Changed to Football · won't notify");

    const [set] = remindersShown();
    await screen.press(`reminder-${set!.id}`);
    expect(scenario.pushed).toEqual([
      { pathname: "/live/programme", params: { channel: "a:1", start: String(later.start) } },
    ]);

    await screen.press(`reminder-${set!.id}-cancel`);
    expect(screen.text()).toContain("No reminders yet.");
    screen.close();
  });

  it("leads with a notice once iOS stops letting the app notify", async () => {
    await reminders.setReminder(channel(), later);
    ios.permission = "denied";
    for (const listener of scenario.appState) listener("active");
    await settled();
    const screen = await list();
    expect(screen.text()).toMatch(/^Notifications are off\..*Open iOS Settings/);
    expect(screen.text()).toContain("Late film");
    screen.close();
  });
});

function remindersShown() {
  shown();
  return drawn?.kind === "read" ? drawn.reminders : [];
}
function currentPermission() {
  let seen: Permission | null = null;
  function Read() {
    seen = reminders.usePermission();
    return null;
  }
  const at = createRoot(document.createElement("div"));
  React.act(() => at.render(React.createElement(Read)));
  React.act(() => at.unmount());
  return seen;
}
