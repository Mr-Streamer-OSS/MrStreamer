import { createRoot, document, type Root } from "./dom.ts";
import * as React from "react";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /** What the owner tells the app's modules as its listings change, ended at each launch. */
  revisionStops: [] as (() => void)[],
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
  Animated: {
    View: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    Value: class {
      setValue() {}
    },
    timing: () => ({ start: () => undefined }),
  },
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
  // One owner across launches, as the guide's own files outlive the app's modules. Each launch's
  // modules hear its listings; the last launch's hear no more.
  const heard = (owner: ReturnType<typeof createGuide>) => ({
    ...owner,
    listingRevision: {
      get: owner.listingRevision.get,
      subscribe: (listener: () => void) => {
        const stop = owner.listingRevision.subscribe(listener);
        scenario.revisionStops.push(stop);
        return stop;
      },
    },
  });
  if (scenario.owner) return { ...actual, guide: heard(scenario.owner) };
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
  return { ...actual, guide: heard(scenario.owner) };
});

/** iOS's notification centre, as the native module shows it to the app. */
const ios = {
  permission: "undetermined" as Permission,
  /** What the viewer answers iOS's prompt with. */
  answer: "granted" as Permission,
  asked: 0,
  scheduled: new Map<string, Notice>(),
  /** Titles iOS refuses to schedule. */
  refuses: new Set<string>(),
  /** Shown already, as iOS keeps them in Notification Centre until taken down. */
  delivered: new Set<string>(),
  /** While set, iOS hasn't answered `scheduled` yet. */
  holding: null as Promise<void> | null,
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
  async scheduled() {
    await ios.holding;
    return [...ios.scheduled.values()];
  },
  async schedule(notices) {
    if (ios.permission !== "granted") return notices.map((each) => each.id);
    const refused = notices.filter((each) => ios.refuses.has(each.title));
    for (const notice of notices)
      if (!refused.includes(notice)) ios.scheduled.set(notice.id, notice);
    return refused.map((each) => each.id);
  },
  async cancel(ids) {
    for (const id of ids) {
      ios.scheduled.delete(id);
      ios.delivered.delete(id);
    }
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
  for (const stop of scenario.revisionStops.splice(0)) stop();
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
  ios.refuses.clear();
  ios.delivered.clear();
  ios.holding = null;
  files.sync = null;
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

  it("follows a guide the app replaces, with no other change", async () => {
    await reminders.setReminder(channel(), later);
    scenario.programmes = [on, { ...later, title: "Football" }];
    // New external guides or mappings: the guide tells before it withdraws what it handed out.
    scenario.owner!.configure(new Map(), new Map());
    await heard();
    expect(shown()).toEqual(["Football @ Channel 1: changed from Late film"]);
    expect(notices()).toEqual([]);
  });

  it("takes a notification down when the check that found it changed couldn't be written", async () => {
    await reminders.setReminder(channel(), later);
    scenario.programmes = [on, { ...later, title: "Football" }];
    files.sync = (operation) => {
      if (operation === "write") throw new Error("disk full");
    };
    shows();
    await settled();
    expect(notices()).toEqual([]);
  });

  it("keeps a cancelled reminder down while a check under way had read it", async () => {
    await reminders.setReminder(channel(), later);
    const [set] = remindersShown();
    let answer = () => {};
    ios.holding = new Promise((resolve) => (answer = resolve));
    const checking = reminders.checkReminders();
    await heard();
    const cancelled = reminders.cancelReminder(set!.id);
    ios.holding = null;
    answer();
    await Promise.all([checking, cancelled]);
    expect(notices()).toEqual([]);
  });

  it("keeps none scheduled while iOS doesn't allow them, and schedules again once it does", async () => {
    await reminders.setReminder(channel(), later);
    ios.permission = "denied";
    for (const listener of scenario.appState) listener("active");
    await settled();
    expect(notices()).toEqual([]);
    expect(shown()).toEqual(["Late film @ Channel 1: upcoming"]);

    ios.permission = "granted";
    for (const listener of scenario.appState) listener("active");
    await settled();
    expect(notices()).toEqual([`Late film at ${2 * HOUR}: Starting now on Channel 1`]);
  });

  it("takes down a provider's notifications, scheduled or shown, while iOS doesn't allow them too", async () => {
    await reminders.setReminder(channel(), later);
    const [set] = remindersShown();
    // It notified early, as a test can have it: iOS keeps it shown.
    ios.scheduled.delete(set!.id);
    ios.delivered.add(set!.id);
    ios.permission = "denied";
    scenario.members = [];
    for (const listener of scenario.rosterChanged) listener();
    await settled();
    expect(shown()).toEqual([]);
    expect(ios.delivered.size).toBe(0);
  });

  it("sets no more than the 64 iOS holds, and keeps none iOS refused", async () => {
    const programmes = Array.from({ length: 65 }, (_, at) => ({
      title: `Programme ${at}`,
      start: now + (at + 1) * HOUR,
      stop: now + (at + 2) * HOUR,
      description: null,
    }));
    scenario.programmes = [on, ...programmes];
    for (const programme of programmes.slice(0, 64))
      expect(await reminders.setReminder(channel(), programme)).toBe("set");
    expect(await reminders.setReminder(channel(), programmes[64]!)).toBe("full");
    expect(notices()).toHaveLength(64);

    const [first] = remindersShown();
    await reminders.cancelReminder(first!.id);
    ios.refuses.add("Programme 64");
    await expect(reminders.setReminder(channel(), programmes[64]!)).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "iOS didn't schedule the reminder." },
    });
    expect(remindersShown()).toHaveLength(63);
  });

  it("says which it can't notify for once a guide brings a 65th back", async () => {
    const programmes = Array.from({ length: 65 }, (_, at) => ({
      title: `Programme ${at}`,
      start: now + (at + 1) * HOUR,
      stop: now + (at + 2) * HOUR,
      description: null,
    }));
    scenario.programmes = [on, ...programmes];
    for (const programme of programmes.slice(0, 64))
      await reminders.setReminder(channel(), programme);
    // One changes, so another can be set, then the guide has the first back.
    scenario.programmes = [on, { ...programmes[0]!, title: "Football" }, ...programmes.slice(1)];
    shows();
    await settled();
    expect(await reminders.setReminder(channel(), programmes[64]!)).toBe("set");
    scenario.programmes = [on, ...programmes];
    shows();
    await settled();
    expect(notices()).toHaveLength(64);
    const rows = remindersShown();
    expect(rows.filter((row) => row.status.kind === "upcoming")).toHaveLength(64);
    expect(rows.find((row) => row.status.kind === "unscheduled")?.title).toBe("Programme 64");
  });

  it("keeps none iOS failed to schedule, or didn't allow", async () => {
    const schedule = module.schedule;
    module.schedule = async () => {
      throw new Error("native");
    };
    try {
      await expect(reminders.setReminder(channel(), later)).rejects.toMatchObject({
        error: { detail: "iOS didn't schedule the reminder." },
      });
    } finally {
      module.schedule = schedule;
    }
    expect(shown()).toEqual([]);

    // The prompt went without an answer, as when the app was sent away.
    ios.permission = "undetermined";
    ios.answer = "undetermined";
    expect(await reminders.setReminder(channel(), later)).toBe("denied");
    expect(shown()).toEqual([]);
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

  it("goes with its subscription", async () => {
    await reminders.setReminder(channel(), later);
    scenario.members = [];
    for (const listener of scenario.rosterChanged) listener();
    await settled();
    expect(shown()).toEqual([]);
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
    const screen = await details(later);
    expect(screen.text()).toContain("Late film");
    expect(screen.text()).toContain("A film");
    expect(scenario.played).toEqual([]);
    screen.close();
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

  it("saves nothing where iOS refuses, offers iOS Settings, and sets once allowed there", async () => {
    ios.answer = "denied";
    const screen = await details(later);
    await screen.press("guide-remind-me");
    expect(shown()).toEqual([]);
    expect(screen.text()).toContain("Notifications are off for Mr. Streamer");
    await screen.press("guide-open-settings");
    expect(scenario.settings).toBe(1);

    ios.permission = "granted";
    await screen.press("guide-remind-me");
    expect(shown()).toEqual(["Late film @ Channel 1: upcoming"]);
    expect(notices()).toEqual([`Late film at ${2 * HOUR}: Starting now on Channel 1`]);
    screen.close();
  });

  it("says a save failed while a later build's file stands, writing over nothing", async () => {
    const newer = JSON.stringify({ version: 2, reminders: [] });
    writeFileSync(file(), newer);
    await launch();
    const screen = await details(later);
    await screen.press("guide-remind-me");
    expect(screen.text()).toContain("Couldn't save. Try again.");
    expect(screen.has("guide-remind-me")).toBe(true);
    expect(shown()).toBe("foreign");
    expect(readFileSync(file(), "utf8")).toBe(newer);
    expect(notices()).toEqual([]);
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
    expect(screen.text()).toMatch(/^(Today|Tomorrow)CancelC1Late film/);
    expect(screen.text()).toContain(`Channel 1 · ${programmeRange(later)}`);
    expect(screen.text()).toContain("Changed to Football · won't notify");

    const [set] = remindersShown();
    await screen.press(`reminder-${set!.id}`);
    expect(scenario.pushed).toEqual([
      { pathname: "/live/programme", params: { channel: "a:1", start: String(later.start) } },
    ]);

    await screen.press(`reminder-${set!.id}-cancel`);
    expect(screen.text()).toContain("No reminders yet.");

    // A swipe to the left shows Cancel too.
    await reminders.setReminder(channel(), later);
    const [again] = remindersShown();
    await screen.press(`reminder-${again!.id}-swiped`);
    expect(screen.text()).toContain("No reminders yet.");
    expect(notices()).toEqual([]);
    screen.close();
  });

  it("moves with the clock while it shows", async () => {
    await reminders.setReminder(channel(), later);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const screen = await list();
      expect(screen.text()).not.toContain("On now");
      vi.setSystemTime(later.start + 1);
      React.act(() => void vi.advanceTimersByTime(60_000));
      expect(screen.text()).toContain("On now");
      screen.close();
    } finally {
      vi.useRealTimers();
    }
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

/** What the app hears settles: the guide's own tasks, and each check they started. */
async function heard() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function remindersShown() {
  shown();
  return drawn?.kind === "read" ? drawn.reminders : [];
}
