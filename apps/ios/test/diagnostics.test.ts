import "./native-assets.ts";
import { createRoot, document, Event } from "./dom.ts";
import * as React from "react";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { formatDate } from "@mrstreamer/core/i18n";
import { byIds, indexCatalogue, type IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AboutStanding, MetadataStanding } from "../src/titles.ts";

// What the viewer sees and does to mend TMDB's part and share diagnostics: Settings' TMDB group
// and Diagnostics row, the Diagnostics preview and its Share, and the reason a title's details
// give for TMDB's part, with Try again. The real screens render with React DOM on a happy-dom
// window over React Native stand-ins. TMDB's standing and a title's details answer as the test
// says: metadata-recovery.test.ts drives the real owners that give them, and the real text.

vi.stubGlobal("__DEV__", false);

const scenario = vi.hoisted(() => ({
  standing: { kind: "no-key" } as MetadataStanding,
  /** What the TMDB owner was asked to do, in order. */
  asked: [] as string[],
  /** The TMDB key's save fails, as when the Keychain refuses it. */
  saveFails: false,
  diagnostics: "",
  /** The system's share sheet: each payload it was handed. */
  shared: [] as unknown[],
  /** The options a screen set on its top bar, newest last. */
  options: [] as Record<string, unknown>[],
  pushed: [] as string[],
  tab: "(home)" as string,
  sheet: null as { options: readonly string[]; pick: (index: number) => void } | null,
  prompt: null as readonly { text: string; onPress?: (typed?: string) => void }[] | null,
  alerts: [] as string[],
  lists: { kind: "idle" } as { kind: "idle" } | { kind: "ready"; index: unknown },
  /** Each read of the film's details, answered in turn; the last answers every later read. */
  details: [] as ((show: (details: unknown) => void) => Promise<unknown>)[],
  /** The providers saved: Settings' tests leave them out, the film's details list one. */
  members: [] as { entry: { id: string }; label: string }[],
  reads: 0,
  /** The metadata version, which a TMDB key change bumps, and who is told when it does. */
  metadata: { version: 0, told: new Set<() => void>() },
}));

vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { options }: { options: readonly string[] },
      pick: (index: number) => void,
    ) => {
      scenario.sheet = { options, pick };
    },
  },
  Alert: {
    alert: (title: string) => scenario.alerts.push(title),
    prompt: (_title: string, _message: string, buttons: NonNullable<typeof scenario.prompt>) => {
      scenario.prompt = buttons;
    },
  },
  Share: {
    share: async (content: unknown) => {
      scenario.shared.push(content);
      return { action: "sharedAction" };
    },
  },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.2.0" } } }));
vi.mock("expo-router", () => ({
  router: { push: (href: string) => scenario.pushed.push(href) },
  useNavigation: () => ({
    setOptions: (options: Record<string, unknown>) => scenario.options.push(options),
  }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("../src/header.tsx", () => ({
  useTabs: () => ({ tab: scenario.tab, above: 0 }),
  tabHref: (tab: string, screen: string) => `${tab === "(home)" ? "" : `/${tab}`}/${screen}`,
  openOnTabs: () => undefined,
}));
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: { text: "#FFFFFF", dim: "#A1A1A6", line: "#2C2C2E" },
    ChannelLogo: () => null,
    TextButton: ({ label, onPress, testID }: { label: string; onPress(): void; testID?: string }) =>
      createElement("button", { "data-testid": testID, onClick: onPress }, label),
    Message: ({ text }: { text: string }) => createElement("p", null, text),
  };
});
vi.mock("../src/titles.ts", async () => ({
  useMetadataStanding: () => scenario.standing,
  useTitleTimings: () => null,
  saveTmdbKey: async (key: string) => {
    scenario.asked.push(`save ${key}`);
    if (scenario.saveFails) throw new Error("Keychain refused");
  },
  removeTmdbKey: async () => {
    scenario.asked.push("remove");
  },
  retryMetadata: () => scenario.asked.push("retry"),
  useTitleLists: () => scenario.lists,
  useMetadataVersion: (await import("react")).useSyncExternalStore.bind(
    null,
    (tell: () => void) => {
      scenario.metadata.told.add(tell);
      return () => scenario.metadata.told.delete(tell);
    },
    () => scenario.metadata.version,
  ),
  titleOf: (index: IndexedCatalogue, kind: "movie" | "series", version: OwnedId) =>
    byIds(index, kind, [version])[0],
  useCollections: () => null,
  episodesOf: async () => [],
  detailsOf: (_title: unknown, show: (details: unknown) => void) => {
    const read = scenario.details[Math.min(scenario.reads++, scenario.details.length - 1)];
    return read ? read(show) : new Promise(() => undefined);
  },
}));
vi.mock("../src/diagnostics.ts", () => ({ diagnosticsText: () => scenario.diagnostics }));
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  members: () => scenario.members,
  retryTitles: () => undefined,
}));
vi.mock("../src/telemetry/index.ts", () => ({
  useStatistics: () => ({ enabled: false, transport: "production" }),
  setStatistics: async () => undefined,
  noteAction: () => undefined,
}));
vi.mock("../src/online-subtitles.ts", () => ({
  useSubtitleKey: () => false,
  saveSubtitleKey: async () => undefined,
  removeSubtitleKey: async () => undefined,
}));
vi.mock("../src/downloads-screen.tsx", () => ({ DownloadsLink: () => null }));
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
// The details screen's other owners, quiet: this file reads only its About part.
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("../src/loading.tsx", () => ({
  Docked: ({ children }: { children?: React.ReactNode }) => children,
  Placeholders: ({ children }: { children?: React.ReactNode }) => children,
  Shape: () => null,
  PlaceholderLines: () => null,
  loadingStatus: (what: string) => ({ text: `Loading ${what}.` }),
}));
vi.mock("../src/titles-ui.tsx", () => ({
  Artwork: () => null,
  ProgressLine: () => null,
  Shelf: () => null,
  TextTabs: () => null,
}));
vi.mock("../src/resume.ts", () => ({
  openDetails: () => undefined,
  versionOf: (key: string) => {
    const at = key.indexOf(":");
    return { subscriptionId: key.slice(0, at), id: key.slice(at + 1) };
  },
}));
vi.mock("../src/play-title.ts", () => ({
  failureOf: () => undefined,
  useFailure: () => undefined,
  resumeMovie: () => undefined,
  resumeEpisode: () => undefined,
  resumeSeries: () => undefined,
}));
vi.mock("../src/playback.ts", () => ({ request: () => ({ stands: () => true }) }));
vi.mock("../src/viewing.ts", () => ({
  useViewing: () => null,
  progressOf: async () => [],
  seriesViewing: async () => ({ progress: [], marks: [] }),
  markEpisode: async () => null,
  relist: async () => undefined,
  undoMark: async () => undefined,
}));
vi.mock("../src/downloads.ts", () => ({
  useDownloadOf: () => undefined,
  useDownloads: () => 0,
  downloadOf: () => undefined,
}));
vi.mock("../src/watchlist.ts", () => ({
  useWatchlist: () => [],
  savedEntry: () => undefined,
  saveTitle: () => undefined,
  removeTitle: () => undefined,
}));

const { default: Settings } = await import("../src/app/(tabs)/(home)/settings.tsx");
const { default: Diagnostics } = await import("../src/app/(tabs)/(home)/diagnostics.tsx");
const { DetailsScreen } = await import("../src/details-screen.tsx");

let container: ReturnType<typeof document.createElement>;
let unmount = () => {};
function render(element: React.ReactElement) {
  container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(element));
  unmount = () => React.act(() => root.unmount());
}
const find = (testID: string) => container.querySelector(`[data-testid="${testID}"]`);
function press(testID: string) {
  const found = find(testID);
  if (!found) throw new Error(`No ${testID}: ${container.textContent}`);
  React.act(() => found.dispatchEvent(new Event("click", { bubbles: true })));
}
const text = (testID: string) => find(testID)?.textContent ?? null;
/** Until promises the screen waits for have answered. */
async function settled() {
  for (let at = 0; at < 5; at++) await React.act(async () => await Promise.resolve());
}

beforeEach(() => {
  scenario.asked.length = 0;
  scenario.saveFails = false;
  scenario.shared.length = 0;
  scenario.options.length = 0;
  scenario.pushed.length = 0;
  scenario.tab = "(home)";
  scenario.sheet = null;
  scenario.prompt = null;
  scenario.alerts.length = 0;
  scenario.details = [];
  scenario.reads = 0;
  scenario.members = [];
});
afterEach(() => unmount());

describe("Settings' TMDB group", () => {
  it("offers to add a key when there is none, and saves what the viewer types", async () => {
    scenario.standing = { kind: "no-key" };
    render(React.createElement(Settings));
    expect(text("settings-tmdb-key")).toContain("Add");
    expect(text("settings-tmdb-status")).toBe("StatusNo key, provider facts only");
    // TMDB's facts saved before stay without a key, and so does its notice in About.
    expect(container.textContent).toContain("This application uses TMDB");
    expect(find("settings-tmdb-titles")).toBeNull();
    expect(find("settings-tmdb-retry")).toBeNull();

    press("settings-tmdb-key");
    React.act(() => scenario.prompt?.find(({ text }) => text === "Save")?.onPress?.(" my-key "));
    await settled();
    expect(scenario.asked).toEqual(["save  my-key "]);
    expect(scenario.alerts).toEqual([]);

    // The Keychain refusing it says so.
    scenario.saveFails = true;
    press("settings-tmdb-key");
    React.act(() => scenario.prompt?.find(({ text }) => text === "Save")?.onPress?.("other"));
    await settled();
    expect(scenario.alerts).toEqual(["Couldn't save the key"]);
  });

  it("says TMDB isn't answering with the titles it gave, and Try again asks again", () => {
    scenario.standing = { kind: "unavailable", key: "yours", known: 1204, wanted: 1318 };
    render(React.createElement(Settings));
    expect(text("settings-tmdb-key")).toContain("Saved");
    expect(text("settings-tmdb-status")).toBe("StatusNot answering");
    expect(text("settings-tmdb-titles")).toBe("Titles1,204 of 1,318");
    press("settings-tmdb-retry");
    expect(scenario.asked).toEqual(["retry"]);
  });

  it("removes the viewer's key from its sheet, for this build's key again", async () => {
    scenario.standing = { kind: "answered", key: "yours", known: 1318, wanted: 1318 };
    render(React.createElement(Settings));
    expect(text("settings-tmdb-status")).toBe("Status1,318 titles");
    expect(find("settings-tmdb-titles")).toBeNull();
    press("settings-tmdb-key");
    const sheet = scenario.sheet;
    expect(sheet?.options).toEqual(["Replace", "Remove", "Cancel"]);
    React.act(() => sheet?.pick(1));
    await settled();
    expect(scenario.asked).toEqual(["remove"]);
  });

  it("names a refused key and the titles saved before, with no Try again until it changes", () => {
    scenario.standing = { kind: "refused", key: "app", known: 312, wanted: 1318 };
    render(React.createElement(Settings));
    expect(text("settings-tmdb-key")).toContain("This build's");
    expect(text("settings-tmdb-status")).toBe("StatusRefused the key");
    expect(text("settings-tmdb-titles")).toBe("Titles312 of 1,318 saved");
    expect(find("settings-tmdb-retry")).toBeNull();
    // A key typed now replaces this build's.
    press("settings-tmdb-key");
    expect(scenario.prompt?.map(({ text }) => text)).toEqual(["Cancel", "Save"]);
  });
});

describe("Diagnostics", () => {
  it("opens from Privacy on the tab Settings is on", () => {
    scenario.standing = { kind: "no-key" };
    render(React.createElement(Settings));
    press("settings-diagnostics");
    unmount();
    scenario.tab = "films";
    render(React.createElement(Settings));
    press("settings-diagnostics");
    expect(scenario.pushed).toEqual(["/diagnostics", "/films/diagnostics"]);
  });

  it("shows the text as it was when opened, and Share hands over exactly that text alone", async () => {
    const shown = "Mr. Streamer 0.2.0 (21) · iOS 26.1\nProviders: 1\n  indented line\n";
    scenario.diagnostics = shown;
    render(React.createElement(Diagnostics));
    expect(container.textContent).toContain(shown);
    // What changes after it opened isn't shared unseen.
    scenario.diagnostics = "Providers: 2";
    const options = scenario.options.at(-1) as {
      title: string;
      unstable_headerRightItems: () => { label: string; onPress: () => void }[];
    };
    expect(options.title).toBe("Diagnostics");
    const items = options.unstable_headerRightItems();
    expect(items.map(({ label }) => label)).toEqual(["Share"]);
    items[0]?.onPress();
    await settled();
    expect(scenario.shared).toEqual([{ message: shown }]);
  });
});

/** One film, listed by provider a with a TMDB id. */
const catalogue: OnDemandCatalogue = {
  movieCategories: [],
  seriesCategories: [],
  series: [],
  movies: [
    {
      id: "1",
      name: "Arrival",
      tmdbId: "329865",
      container: "mp4",
      categoryIds: [],
      posterUrl: null,
      backdropUrl: null,
      releaseDate: null,
      rating: null,
      addedAt: 1,
      adult: false,
    },
  ],
};
/** The film's facts as details answer them, with where TMDB's part stands. */
const facts = (about: AboutStanding) => ({
  kind: "movie",
  plot: "A linguist is recruited.",
  directors: [],
  cast: [],
  genres: [],
  duration: null,
  backdropUrl: null,
  about,
});

describe("a title's details", () => {
  beforeEach(() => {
    scenario.lists = {
      kind: "ready",
      index: indexCatalogue([{ subscriptionId: "a", catalogue }], "en"),
    };
    scenario.members = [{ entry: { id: "a" }, label: "Home" }];
  });
  const open = async () => {
    render(React.createElement(DetailsScreen, { kind: "movie", version: "a:1" }));
    await settled();
  };

  it("say why TMDB's part is missing, with no Try again where asking again can't help", async () => {
    const reasons: [AboutStanding, string][] = [
      [
        { kind: "no-key", savedAt: null },
        "Provider details only. This build has no TMDB key. Add yours in Settings.",
      ],
      [
        { kind: "refused", savedAt: null },
        "Provider details only. TMDB refused the key in Settings.",
      ],
      [{ kind: "missing" }, "Provider details only. TMDB doesn't know this title."],
      [{ kind: "unlinked" }, "Provider details only."],
    ];
    for (const [about, reason] of reasons) {
      scenario.details = [async () => facts(about)];
      scenario.reads = 0;
      await open();
      expect(container.textContent).toContain(reason);
      expect(find("details-about-retry")).toBeNull();
      unmount();
    }
    scenario.details = [async () => facts({ kind: "tmdb" })];
    scenario.reads = 0;
    await open();
    expect(container.textContent).not.toContain("Provider details only");
    expect(container.textContent).not.toContain("TMDB");
  });

  it("read again once the TMDB key changes, as from Settings", async () => {
    scenario.details = [
      async () => facts({ kind: "refused", savedAt: null }),
      async () => facts({ kind: "no-key", savedAt: null }),
    ];
    await open();
    expect(container.textContent).toContain("TMDB refused the key in Settings.");
    React.act(() => {
      scenario.metadata.version++;
      for (const tell of scenario.metadata.told) tell();
    });
    await settled();
    expect(container.textContent).toContain("This build has no TMDB key.");
    expect(container.textContent).not.toContain("refused");
  });

  it("date TMDB's saved answer while it isn't answering, and Try again reads them anew", async () => {
    const savedAt = new Date(new Date().getFullYear(), 0, 12).getTime();
    const saved = `Saved TMDB facts from ${formatDate(savedAt, "day")}.`;
    let answer = () => {};
    scenario.details = [
      async () => facts({ kind: "unavailable", savedAt }),
      async (show) => {
        show(facts({ kind: "asking", savedAt }));
        await new Promise<void>((done) => (answer = done));
        return facts({ kind: "tmdb" });
      },
    ];
    await open();
    expect(container.textContent).toContain(`${saved} TMDB isn't answering.`);
    press("details-about-retry");
    await settled();
    // While TMDB is asked again, the saved answer stays dated.
    expect(container.textContent).toContain(`${saved} Asking TMDB again.`);
    expect(find("details-about-retry")).toBeNull();
    React.act(() => answer());
    await settled();
    expect(container.textContent).not.toContain("Saved TMDB facts");
    expect(find("details-about-retry")).toBeNull();
  });
});
