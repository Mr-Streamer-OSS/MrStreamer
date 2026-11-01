import { createRoot, document, window, type Root } from "./dom.ts";
import * as React from "react";
import type { LiveCatalogue, ProviderChannel } from "@mrstreamer/core/provider";
import { setLanguage } from "@mrstreamer/core/i18n";
import type { Locale } from "@mrstreamer/contracts/language";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Catalogue, Member } from "../src/account.ts";
import { buildLibrary } from "../src/library.ts";
import type { Phase } from "../src/playback.ts";
import type { SavedState } from "../src/storage.ts";

// Live in the interface language, as the viewer meets it: its tabs, rows, counts and status line
// in the language picked, while channel, category, country and provider names stay as the
// provider gives them, and a new language leaves the tab, the country and what shows where they
// were. The real screens run with React DOM on a happy-dom window, as live-browse.test.ts does.

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  catalogue: { kind: "loading" } as Catalogue,
  saved: {} as Partial<SavedState>,
  phase: { kind: "idle" } as Phase,
  sheet: null as { options: string[]; choose: (index: number) => void } | null,
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { options }: { options: string[] },
      choose: (index: number) => void,
    ) => {
      scenario.sheet = { options, choose };
    },
  },
}));
vi.mock("react-native-safe-area-context", async () => {
  const { createElement } = await import("react");
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      createElement("div", null, children),
  };
});
vi.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isGlassEffectAPIAvailable: () => false,
  isLiquidGlassAvailable: () => false,
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-router", () => ({
  router: { push: () => undefined, back: () => undefined },
  useIsFocused: () => true,
}));
vi.mock("../src/header.tsx", () => ({
  tabHref: (_tab: string, screen: string) => `/live/${screen}`,
}));
vi.mock("../src/account.ts", () => ({
  onCatalogue: () => () => {},
  currentRoster: () => ({ kind: "ready", members: scenario.members }),
  onRoster: () => () => {},
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  useCatalogue: () => scenario.catalogue,
  currentCatalogue: () => scenario.catalogue,
  playChannel: () => undefined,
  retry: () => undefined,
  retryChannels: () => undefined,
  reloadAllChannels: () => undefined,
}));
vi.mock("expo-video", () => ({ createVideoPlayer: () => ({}) }));
vi.mock("../src/playback.ts", async (original) => ({
  channelStatus: (await original<typeof import("../src/playback.ts")>()).channelStatus,
  usePlayback: () => ({ phase: scenario.phase, watch: false }),
}));
vi.mock("../src/storage.ts", () => ({
  useSavedState: () => scenario.saved,
  writeState: (change: (state: Partial<SavedState>) => Partial<SavedState>) => {
    scenario.saved = change(scenario.saved);
  },
}));

const { LiveHome } = await import("../src/live-screen.tsx");
const { DiscoverScreen } = await import("../src/live-discover.tsx");
const { libraryStatus } = await import("../src/loading.tsx");

const channel = (id: string, name: string, categoryIds: string[]): ProviderChannel => ({
  id,
  name,
  number: null,
  logoUrl: null,
  categoryIds,
  guideId: null,
  catchupDays: null,
});
const home: LiveCatalogue = {
  categories: [
    { id: "1", name: "NL | News" },
    { id: "2", name: "NL | Sport" },
    { id: "3", name: "BE | Sport" },
  ],
  channels: [
    channel("10", "NL | NOS Journaal HD", ["1"]),
    channel("11", "NL | Ziggo Sport", ["2"]),
    channel("12", "NL | ESPN", ["2"]),
    channel("13", "BE | Sporza", ["3"]),
  ],
};
const library = buildLibrary([{ subscriptionId: "a", label: "Home", catalogue: home }]);

const member = (id: string, label: string, live: Member["live"]): Member => ({
  entry: { id, kind: "xtream", server: "http://example.test", username: "fixture", name: null },
  label,
  account: null,
  needsSecret: false,
  live,
  titles: { kind: "idle" },
});
const listed: Member["live"] = {
  kind: "ready",
  value: home,
  from: "provider",
  fetchedAt: 0,
  took: 1,
};

let container: ReturnType<typeof document.createElement>;
let root: Root | null = null;
function open(node: React.ReactNode) {
  container = document.createElement("div");
  root = createRoot(container);
  React.act(() => root!.render(node));
}
const speak = (locale: Locale) => React.act(() => setLanguage({ locale, formats: locale }));
const find = (testID: string) => container.querySelector(`[data-testid="${testID}"]`);
const text = (testID?: string) => (testID ? find(testID) : container)?.textContent ?? "";
const labels = () =>
  [...container.querySelectorAll("[aria-label]")].map((each) => each.getAttribute("aria-label"));
function press(testID: string) {
  const button = find(testID) as { click(): void } | null;
  if (!button) throw new Error(`No ${testID} on screen`);
  React.act(() => button.click());
}
function type(query: string) {
  const field = find("discover-field") as unknown as {
    dispatchEvent(event: unknown): void;
  } | null;
  if (!field) throw new Error("No field on screen");
  React.act(() => {
    // React reads the new value through the field's own setter.
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      field,
      query,
    );
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  Object.assign(scenario, {
    members: [member("a", "Home", listed)],
    catalogue: { kind: "ready", library, failing: [] },
    saved: { recentChannels: [] },
    phase: { kind: "idle" },
    sheet: null,
  });
});
afterEach(() => {
  if (root) React.act(() => root!.unmount());
  root = null;
  setLanguage({ locale: "en-US", formats: "en-US" });
});

it("words Live in Dutch, leaving channel, category, country and provider names as they are", () => {
  speak("nl-NL");
  const item = { id: "a:10", subscriptionId: "a", title: "NOS Journaal", place: "", live: true };
  scenario.phase = { kind: "playing", item: { ...item, next: false, versions: false } };
  open(React.createElement(LiveHome));
  expect(["tab-for-you", "tab-categories", "tab-all", "tab-guide"].map(text)).toEqual([
    "Voor jou",
    "Categorieën",
    "Alle",
    "Gids",
  ]);
  expect(text("live-country")).toBe("Alle landen");
  expect(text("live-favourites")).toBe("Favorieten");
  expect(text("live-reminders")).toBe("Herinneringen");
  expect(text("live-discover")).toBe("Landen of categorieën zoeken");
  // The channel playing says so in Dutch; its name and place are the provider's.
  expect(text("channel-a:10")).toContain("NOS Journaal");
  expect(text("channel-a:10")).toContain("Speelt af");
  expect(text("channel-a:11")).toContain("Netherlands · Sport");
  expect(labels()).toContain("Land, Alle landen");

  press("live-country");
  expect(scenario.sheet?.options).toEqual(["✓ Alle landen", "Netherlands", "Belgium", "Annuleren"]);
});

it("keeps the tab, the country and the screen it shows when the language changes", () => {
  open(React.createElement(LiveHome));
  press("live-country");
  const sheet = scenario.sheet!;
  React.act(() => sheet.choose(sheet.options.indexOf("Netherlands")));
  press("tab-categories");
  const grid = find("live-categories");
  expect(text("tab-categories")).toBe("Categories");

  speak("fr-FR");
  expect(text("tab-categories")).toBe("Catégories");
  expect(text("live-country")).toBe("Netherlands");
  expect(labels()).toContain("Effacer Netherlands");
  // The same grid, not one drawn afresh: its scroll and the tiles in view stay.
  expect(find("live-categories")).toBe(grid);
  expect(text("live-categories")).toContain("Sport");
});

it("counts channels and says what it can't find in Spanish, quoting the search as typed", () => {
  speak("es-ES");
  open(React.createElement(DiscoverScreen));
  type("Sp");
  expect(text("discover-results")).toContain("Categorías · 2");
  // NL's Sport has two channels and BE's one, each counted in Spanish.
  expect(text("discover-results")).toContain("Netherlands · 2 canales");
  expect(text("discover-results")).toContain("Belgium · 1 canal");

  type("Kids");
  expect(text()).toContain("Ningún país ni categoría se llama «Kids».");
});

it("writes the status line in German, naming its providers as a German list", () => {
  speak("de-DE");
  const failed = {
    kind: "failed",
    error: { kind: "unexpected", detail: "offline" },
    since: 0,
  } as const;
  const status = (members: Member[]) =>
    libraryStatus(members, {
      channels: true,
      usableContent: false,
      retry: () => undefined,
      settings: () => undefined,
    });
  const loading = status([
    member("b", "Harbor", { kind: "idle" }),
    member("c", "Pier", { kind: "idle" }),
  ]);
  expect(loading?.text).toBe("Sender von Harbor und Pier werden geladen.");

  const stale = status([
    member("b", "Harbor", { ...failed, last: home }),
    member("c", "Pier", { ...failed, last: home }),
  ]);
  expect(stale?.text).toBe(
    "Sender von Harbor und Pier konnten nicht aktualisiert werden. Die letzten Listen werden angezeigt.",
  );
  expect(stale?.actions?.map((action) => action.label)).toEqual([
    "Erneut versuchen",
    "Einstellungen",
  ]);
});
