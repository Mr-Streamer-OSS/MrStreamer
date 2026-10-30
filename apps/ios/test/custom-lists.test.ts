import { createRoot, document, type Root } from "./dom.ts";
import * as React from "react";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveCatalogue, ProviderChannel } from "@mrstreamer/core/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, Member } from "../src/account.ts";
import { buildLibrary, type Channel } from "../src/library.ts";
import { native } from "./native-files.ts";

// Channel lists as the app keeps them (custom-lists.ts): over the real files, in the files
// stand-in (native-files.ts), with two fake providers whose stream ids collide, and the saved
// subscriptions and their channels as account.ts would hand them over. A launch imports the module
// again over the same files.

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  catalogue: { kind: "loading" } as Catalogue,
  /** Subscriptions removed with their history kept; null while the registry doesn't read. */
  retired: [] as string[] | null,
  /** How the registry's Demo stands. */
  demo: "absent" as string,
  /** Subscriptions the registry saves, which the roster may not show yet. */
  registered: [] as string[],
  /** What account.ts tells as its channels change, and as its roster does. */
  changed: new Set<() => void>(),
  rosterChanged: new Set<() => void>(),
  /** What iOS tells as the app comes to the front or goes. */
  appState: new Set<(state: string) => void>(),
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
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
  onRoster: (listener: () => void) => void scenario.rosterChanged.add(listener),
  onCatalogue: (listener: () => void) => void scenario.changed.add(listener),
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  members: () => scenario.members,
  useCatalogue: () => scenario.catalogue,
  currentCatalogue: () => scenario.catalogue,
}));
vi.mock("../src/subscriptions.ts", () => ({
  readRegistry: () =>
    scenario.retired && {
      demo: { kind: scenario.demo },
      registry: {
        subscriptions: scenario.registered.map((id) => ({ id })),
        retired: scenario.retired.map((id) => ({ id })),
      },
    },
}));

const channel = (id: string, name: string): ProviderChannel => ({
  id,
  name,
  number: null,
  logoUrl: null,
  categoryIds: ["1"],
  guideId: null,
  catchupDays: null,
});
const listing = (...channels: ProviderChannel[]): LiveCatalogue => ({
  categories: [{ id: "1", name: "NL | News" }],
  channels,
});
const NOS = channel("10", "NL | NOS Journaal HD");
const NOS_FHD = channel("14", "NL | NOS Journaal FHD");
const ZIGGO = channel("11", "NL | Ziggo Sport");
const RTL = channel("10", "NL | RTL Nieuws");

const member = (id: string, label: string, needsSecret = false): Member => ({
  entry: { id, kind: "xtream", server: "http://example.test", username: "fixture", name: null },
  label,
  account: null,
  needsSecret,
  live: { kind: "ready", value: listing(), from: "provider", fetchedAt: 0, took: 1 },
  titles: { kind: "idle" },
});

/** Home (a) lists `home`, Cabin (b) `cabin`, as Live shows them now. */
function shows(home: ProviderChannel[], cabin: ProviderChannel[] = [RTL]) {
  scenario.catalogue = {
    kind: "ready",
    library: buildLibrary([
      { subscriptionId: "a", label: "Home", catalogue: listing(...home) },
      { subscriptionId: "b", label: "Cabin", catalogue: listing(...cabin) },
    ]),
    failing: [],
  };
  for (const listener of scenario.changed) listener();
}
const live = (key: string): Channel => {
  const found = scenario.catalogue.kind === "ready" && scenario.catalogue.library.byKey.get(key);
  if (!found) throw new Error(`Live doesn't list ${key}`);
  return found;
};

type Lists = typeof import("../src/custom-lists.ts");
let lists: Lists;
/** The app as a launch starts it: the module read afresh over the same files. */
async function launch() {
  vi.resetModules();
  scenario.changed.clear();
  scenario.rosterChanged.clear();
  scenario.appState.clear();
  lists = await import("../src/custom-lists.ts");
  open();
}

/** What a screen showing the lists draws: names, then each entry by key or by name and why. */
let drawn: string[] = [];
function Probe() {
  drawn = lists
    .useChannelLists()
    .map(
      (list) =>
        `${list.name}: ${list.entries
          .map((entry) =>
            entry.kind === "listed" ? entry.channel.key : `${entry.name} (${entry.why})`,
          )
          .join(", ")}${list.away ? ` +${list.away} away` : ""}`,
    );
  return null;
}
let root: Root | null = null;
function open() {
  if (root) React.act(() => root!.unmount());
  root = createRoot(document.createElement("div"));
  React.act(() => root!.render(React.createElement(Probe)));
}
/** What a screen showing the lists draws now. */
function shown() {
  React.act(() => root!.render(React.createElement(Probe)));
  return drawn;
}
const file = () => join(native.root, "documents", "custom-lists.json");
const only = () => lists.currentChannelLists()[0]!;

beforeEach(async () => {
  // The last test's module hears no more.
  scenario.changed.clear();
  scenario.rosterChanged.clear();
  scenario.appState.clear();
  rmSync(file(), { force: true });
  rmSync(`${file()}.next`, { force: true });
  native.sync = null;
  scenario.members = [member("a", "Home"), member("b", "Cabin")];
  scenario.retired = [];
  scenario.registered = [];
  scenario.demo = "absent";
  shows([NOS, NOS_FHD, ZIGGO]);
  await launch();
});
afterEach(() => {
  native.sync = null;
  if (root) React.act(() => root!.unmount());
  root = null;
});

describe("lists", () => {
  it("are made, renamed and deleted, in the order made, and stay so after a relaunch", async () => {
    const news = lists.createList("  News ");
    lists.createList("Sport", live("a:11"));
    lists.renameList(news, "Nieuws");
    await launch();
    expect(shown()).toEqual(["Nieuws: ", "Sport: a:11"]);
    lists.deleteList(news);
    await launch();
    expect(shown()).toEqual(["Sport: a:11"]);
  });

  it("refuse a name another list has, apart from case and accents, and an empty one", () => {
    lists.createList("Séries");
    expect(() => lists.createList("series")).toThrow(
      expect.objectContaining({ error: { kind: "list-name-taken" } }),
    );
    expect(() => lists.createList("   ")).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ kind: "invalid-input" }) }),
    );
    expect(lists.currentChannelLists().map((list) => list.name)).toEqual(["Séries"]);
  });

  it("change nothing, on screen or on disk, when the folder refuses a write", async () => {
    const news = lists.createList("News", live("a:10"));
    native.sync = (operation) => {
      if (operation === "write") throw new Error("The disk is full.");
    };
    expect(() => lists.setMember(news, live("b:10"), true)).toThrow("The disk is full.");
    expect(() => lists.renameList(news, "Nieuws")).toThrow("The disk is full.");
    expect(shown()).toEqual(["News: a:10"]);
    native.sync = null;
    await launch();
    expect(shown()).toEqual(["News: a:10"]);
  });

  it("don't come back at a relaunch from a first write cut short, when putting it back fails too", async () => {
    // The move fails, then so does writing the lists before back.
    let moved = false;
    native.sync = (operation) => {
      if (operation === "move") {
        moved = true;
        throw new Error("The disk went away.");
      }
      if (operation === "write" && moved) throw new Error("The disk is full.");
    };
    expect(() => lists.createList("News", live("a:10"))).toThrow("The disk went away.");
    native.sync = null;
    await launch();
    expect(shown()).toEqual([]);
  });

  it("don't come back at a relaunch from a first write cut short", async () => {
    let refused = false;
    native.sync = (operation) => {
      if (operation === "move" && !refused) {
        refused = true;
        throw new Error("The disk went away.");
      }
    };
    expect(() => lists.createList("News", live("a:10"))).toThrow("The disk went away.");
    native.sync = null;
    await launch();
    expect(shown()).toEqual([]);
  });

  it("show none of a file a later version wrote, and write nothing over it", async () => {
    const later = JSON.stringify({ version: 2, lists: [{ id: "x", name: "Later" }] });
    writeFileSync(file(), later);
    await launch();
    expect(shown()).toEqual([]);
    expect(() => lists.createList("News")).toThrow(
      expect.objectContaining({
        error: expect.objectContaining({ detail: expect.stringMatching(/cannot read/) }),
      }),
    );
    expect(readFileSync(file(), "utf8")).toBe(later);
  });

  it.each([
    {
      once: "the app comes to the front",
      reads: () => {
        for (const listener of scenario.appState) listener("active");
      },
      then: ["News: a:10"],
    },
    { once: "the channels change", reads: () => shows([NOS, ZIGGO]), then: ["News: a:10"] },
    {
      once: "a change is made",
      reads: () => void lists.createList("Sport"),
      then: ["News: a:10", "Sport: "],
    },
  ])(
    "show none of a file that doesn't read, write nothing over it, and show it once $once",
    async ({ reads, then }) => {
      lists.createList("News", live("a:10"));
      const before = readFileSync(file(), "utf8");
      native.sync = (operation) => {
        if (operation === "text") throw new Error("The disk went away.");
      };
      await launch();
      expect(shown()).toEqual([]);
      expect(() => lists.createList("Sport")).toThrow(
        expect.objectContaining({
          error: expect.objectContaining({ detail: expect.stringMatching(/couldn't be read/) }),
        }),
      );
      shows([NOS, ZIGGO]);
      expect(readFileSync(file(), "utf8")).toBe(before);
      native.sync = null;
      // The open screen, drawn again only as it is told.
      React.act(reads);
      expect(drawn).toEqual(then);
    },
  );

  it("take none from a write left halfway while the file itself doesn't read, and none from text that isn't JSON", async () => {
    lists.createList("News", live("a:10"));
    const before = readFileSync(file(), "utf8");
    writeFileSync(`${file()}.next`, JSON.stringify({ version: 1, lists: [] }));
    native.sync = (operation, path) => {
      if (operation === "text" && !path.endsWith(".next")) throw new Error("The disk went away.");
    };
    await launch();
    expect(shown()).toEqual([]);
    expect(() => lists.createList("Sport")).toThrow(
      expect.objectContaining({
        error: expect.objectContaining({ detail: expect.stringMatching(/couldn't be read/) }),
      }),
    );
    expect(readFileSync(file(), "utf8")).toBe(before);
    native.sync = null;
    rmSync(`${file()}.next`);
    writeFileSync(file(), "{");
    await launch();
    expect(shown()).toEqual([]);
    lists.createList("Sport");
    expect(shown()).toEqual(["Sport: "]);
  });
});

describe("a list's channels", () => {
  it("are each provider's own, once each, at the end in the order added", () => {
    const news = lists.createList("News");
    lists.setMember(news, live("b:10"), true);
    lists.setMember(news, live("a:10"), true);
    // Its other quality is the same channel.
    lists.setMember(news, live("a:14"), true);
    expect(shown()).toEqual(["News: b:10, a:10"]);
    lists.setMember(news, live("b:10"), false);
    expect(shown()).toEqual(["News: a:10"]);
  });

  it("follow a channel its provider lists under another of its streams, after a relaunch too", async () => {
    const news = lists.createList("News", live("a:10"));
    // Home drops the HD stream: the channel is the FHD one's now, as Live lists it, and the list
    // follows at that change of the channels alone.
    shows([NOS_FHD, ZIGGO]);
    expect(readFileSync(file(), "utf8")).toContain('"streams":["14"');
    expect(shown()).toEqual(["News: a:14"]);
    await launch();
    expect(shown()).toEqual(["News: a:14"]);
    // A new stream 10 at Home is another channel, and the list keeps the one it holds.
    shows([channel("10", "NL | Ziggo Sport 2"), NOS_FHD, ZIGGO]);
    expect(shown()).toEqual(["News: a:14"]);
    lists.setMember(news, live("a:14"), false);
    expect(shown()).toEqual(["News: "]);
  });

  it("name one their provider no longer lists, or that waits on a password, and play none of it", () => {
    lists.createList("News", live("a:10"));
    lists.setMember(only().id, live("b:10"), true);
    // Cabin's stream 10 is still Cabin's: Home's channel never turns into it.
    shows([ZIGGO]);
    expect(shown()).toEqual(["News: NOS Journaal (not-listed), b:10"]);
    scenario.members = [member("a", "Home"), member("b", "Cabin", true)];
    shows([ZIGGO]);
    expect(shown()).toEqual(["News: NOS Journaal (not-listed), RTL Nieuws (needs-secret)"]);
    const gone = only().entries[0]!;
    lists.removeMember(only().id, gone.member);
    expect(shown()).toEqual(["News: RTL Nieuws (needs-secret)"]);
  });

  it("refuse a channel its provider no longer lists, or that went with its provider", () => {
    const news = lists.createList("News");
    const nos = live("a:10");
    shows([ZIGGO]);
    expect(() => lists.setMember(news, nos, true)).toThrow(
      expect.objectContaining({ error: { kind: "channel-not-found", channelId: "10" } }),
    );
    scenario.members = [member("b", "Cabin")];
    expect(() => lists.setMember(news, nos, true)).toThrow(
      expect.objectContaining({ error: { kind: "no-subscription" } }),
    );
    expect(shown()).toEqual(["News: "]);
  });

  it("of a provider removed with its history come back with it, and go with its history", async () => {
    const news = lists.createList("News", live("a:10"));
    lists.setMember(news, live("b:10"), true);
    scenario.members = [member("b", "Cabin")];
    scenario.retired = ["a"];
    shows([NOS]);
    expect(shown()).toEqual(["News: b:10 +1 away"]);
    scenario.members = [member("a", "Home"), member("b", "Cabin")];
    shows([NOS]);
    expect(shown()).toEqual(["News: a:10, b:10"]);
    // Removed again, with its history deleted this time.
    scenario.members = [member("b", "Cabin")];
    scenario.retired = [];
    shows([NOS]);
    expect(shown()).toEqual(["News: b:10"]);
    expect(readFileSync(file(), "utf8")).not.toContain("NOS");
    scenario.members = [member("a", "Home"), member("b", "Cabin")];
    await launch();
    expect(shown()).toEqual(["News: b:10"]);
  });

  it("of a provider removed with its history go while no screen shows the lists", () => {
    lists.createList("News", live("a:10"));
    React.act(() => root!.unmount());
    root = null;
    // The roster changes alone, as a removal tells it before the channels.
    scenario.members = [member("b", "Cabin")];
    for (const listener of scenario.rosterChanged) listener();
    expect(readFileSync(file(), "utf8")).not.toContain("NOS");
  });

  it("of a provider saved again before the roster shows it stay", () => {
    lists.createList("News", live("a:10"));
    scenario.members = [member("b", "Cabin")];
    scenario.registered = ["a", "b"];
    shows([NOS]);
    expect(readFileSync(file(), "utf8")).toContain("NOS");
  });

  it("count as held where their provider needs its password, so the sheet can take them out", () => {
    const news = lists.createList("News", live("a:10"));
    const nos = live("a:10");
    scenario.members = [member("a", "Home", true), member("b", "Cabin")];
    shows([NOS, NOS_FHD]);
    expect(lists.listsHolding(nos)).toEqual(new Set([news]));
    lists.setMember(news, nos, false);
    expect(shown()).toEqual(["News: "]);
  });

  it("of the Demo stay while the registry's Demo doesn't read, and go once it says erasing", () => {
    scenario.members = [member("demo", "Demo"), member("b", "Cabin")];
    scenario.catalogue = {
      kind: "ready",
      library: buildLibrary([{ subscriptionId: "demo", label: "Demo", catalogue: listing(NOS) }]),
      failing: [],
    };
    lists.createList("News", live("demo:10"));
    scenario.members = [member("b", "Cabin")];
    scenario.demo = "unreadable";
    shows([NOS]);
    expect(readFileSync(file(), "utf8")).toContain("NOS");
    scenario.demo = "erasing";
    shows([NOS]);
    expect(readFileSync(file(), "utf8")).not.toContain("NOS");
  });

  it("of a provider removed while the registry doesn't read stay", () => {
    lists.createList("News", live("a:10"));
    scenario.members = [member("b", "Cabin")];
    scenario.retired = null;
    shows([NOS]);
    expect(shown()).toEqual(["News:  +1 away"]);
    expect(readFileSync(file(), "utf8")).toContain("NOS");
  });

  it("the provider joined since go together when the one shown is taken out", () => {
    const apart = channel("14", "NL | NPO 1");
    shows([NOS, apart]);
    const news = lists.createList("News", live("a:10"));
    lists.setMember(news, live("a:14"), true);
    lists.createList("Mix", live("a:10"));
    lists.setMember(only().id, live("a:14"), true);
    // Stream 14 is NOS's other quality now: one channel, shown once in each list.
    shows([NOS, NOS_FHD]);
    expect(shown()).toEqual(["News: a:10", "Mix: a:10"]);
    lists.removeMember(news, only().entries[0]!.member);
    const mix = lists.currentChannelLists()[1]!;
    lists.arrangeList(mix, [], [mix.entries[0]!.member]);
    shows([NOS, apart]);
    expect(shown()).toEqual(["News: ", "Mix: "]);
  });
});

describe("arranging a list", () => {
  /** A list holding Home's NOS, Ziggo and Cabin's RTL, in that order. */
  function three() {
    const id = lists.createList("Mix", live("a:10"));
    lists.setMember(id, live("a:11"), true);
    lists.setMember(id, live("b:10"), true);
    return id;
  }
  const memberOf = (key: string) =>
    only().entries.find((entry) => entry.kind === "listed" && entry.channel.key === key)!.member;

  it("saves the order and takes out the channels removed with it, kept after a relaunch", async () => {
    three();
    const removed = memberOf("a:11");
    lists.arrangeList(only(), ["b:10", "a:10"].map(memberOf), [removed]);
    await launch();
    expect(shown()).toEqual(["Mix: b:10, a:10"]);
  });

  it("moves a channel that doesn't open as it showed", () => {
    three();
    shows([NOS, NOS_FHD], [RTL]);
    expect(shown()).toEqual(["Mix: a:10, Ziggo Sport (not-listed), b:10"]);
    const ziggo = only().entries[1]!.member;
    expect(() => lists.arrangeList(only(), ["b:10", "a:10"].map(memberOf))).toThrow(
      expect.objectContaining({ error: { kind: "list-changed" } }),
    );
    lists.arrangeList(only(), [ziggo, ...["b:10", "a:10"].map(memberOf)]);
    expect(shown()).toEqual(["Mix: Ziggo Sport (not-listed), b:10, a:10"]);
  });

  it("takes out one of two the provider joined while it needs its password, and nothing else", () => {
    const apart = channel("14", "NL | NPO 1");
    shows([NOS, apart]);
    const id = lists.createList("Mix", live("a:10"));
    lists.setMember(id, live("a:14"), true);
    lists.setMember(id, live("b:10"), true);
    scenario.members = [member("a", "Home", true), member("b", "Cabin")];
    shows([NOS, NOS_FHD]);
    expect(shown()).toEqual([
      "Mix: NOS Journaal (needs-secret), NOS Journaal (needs-secret), b:10",
    ]);
    const [first, second, rtl] = only().entries.map((entry) => entry.member);
    lists.arrangeList(only(), [second!, rtl!], [first!]);
    expect(shown()).toEqual(["Mix: NOS Journaal (needs-secret), b:10"]);
  });

  it("moves a twin the list hides with the channel it shows as", async () => {
    const apart = channel("14", "NL | NPO 1");
    shows([NOS, apart, ZIGGO]);
    const id = lists.createList("Mix", live("a:10"));
    lists.setMember(id, live("a:14"), true);
    lists.setMember(id, live("a:11"), true);
    lists.setMember(id, live("b:10"), true);
    shows([NOS, NOS_FHD, ZIGGO]);
    expect(shown()).toEqual(["Mix: a:10, a:11, b:10"]);
    lists.arrangeList(only(), ["a:11", "b:10", "a:10"].map(memberOf));
    await launch();
    expect(shown()).toEqual(["Mix: a:11, b:10, a:10"]);
    // Split again, the twin is still beside it.
    shows([NOS, apart, ZIGGO]);
    expect(shown()).toEqual(["Mix: a:11, b:10, a:10, a:14"]);
  });

  it("refuses a second save from the same edit, though only channels that don't open moved", () => {
    three();
    shows([NOS, NOS_FHD], [RTL]);
    const before = only();
    const ziggo = before.entries[1]!.member;
    lists.arrangeList(before, [ziggo, memberOf("a:10"), memberOf("b:10")]);
    expect(() => lists.arrangeList(before, [memberOf("a:10"), memberOf("b:10"), ziggo])).toThrow(
      expect.objectContaining({ error: { kind: "list-changed" } }),
    );
    expect(shown()).toEqual(["Mix: Ziggo Sport (not-listed), a:10, b:10"]);
  });

  it("refuses an order made before the list or its channels changed, moving nothing", () => {
    const id = three();
    const before = only();
    const order = ["b:10", "a:11", "a:10"].map(memberOf);
    lists.setMember(id, live("a:11"), false);
    lists.setMember(id, live("a:11"), true);
    expect(() => lists.arrangeList(before, order)).toThrow(
      expect.objectContaining({ error: { kind: "list-changed" } }),
    );
    const now = only();
    shows([NOS, NOS_FHD, ZIGGO], []);
    expect(() => lists.arrangeList(now, ["a:11", "a:10"].map(memberOf))).toThrow(
      expect.objectContaining({ error: { kind: "list-changed" } }),
    );
    expect(shown()).toEqual(["Mix: a:10, RTL Nieuws (not-listed), a:11"]);
  });
});
