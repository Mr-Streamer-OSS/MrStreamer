import * as React from "react";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { byIds, indexCatalogue, type IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// A film's details while the providers listing it change: a version picked from a provider that
// is removed meanwhile gives way to one still listed. The real screen runs with React DOM on a
// happy-dom window, as provider-form.test.ts does; React Native's views stand in as plain
// elements, the version menu answers as the test picks, and Play records the version it plays.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document, Event } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scenario = vi.hoisted(() => ({
  lists: { kind: "idle" } as { kind: "idle" } | { kind: "ready"; index: unknown },
  members: [] as Array<{ entry: { id: string }; label: string }>,
  /** The version menu last shown: its options, and what picking one does. */
  menu: null as { options: readonly string[]; pick: (index: number) => void } | null,
  played: [] as OwnedId[],
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string };
  const box = ({ children, testID }: Props) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    View: box,
    ScrollView: box,
    Text: ({ children }: Props) => createElement("span", null, children),
    Pressable: ({
      children,
      testID,
      disabled,
      onPress,
    }: Props & { disabled?: boolean; onPress: () => void }) =>
      createElement("button", { "data-testid": testID, disabled, onClick: onPress }, children),
    StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: {} },
    ActionSheetIOS: {
      showActionSheetWithOptions: (
        { options }: { options: readonly string[] },
        pick: (index: number) => void,
      ) => {
        scenario.menu = { options, pick };
      },
    },
  };
});
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: { text: "#FFFFFF", dim: "#8E8E93" },
    Message: ({ text }: { text: string }) => createElement("p", null, text),
  };
});
vi.mock("../src/titles-ui.tsx", () => ({
  Artwork: () => null,
  ProgressLine: () => null,
  Shelf: () => null,
  TextTabs: () => null,
}));
vi.mock("../src/account.ts", () => ({
  members: () => scenario.members,
  useRoster: () => ({ kind: "ready", members: scenario.members }),
}));
vi.mock("../src/resume.ts", () => ({
  openDetails: () => undefined,
  versionOf: (key: string) => {
    const at = key.indexOf(":");
    return { subscriptionId: key.slice(0, at), id: key.slice(at + 1) };
  },
}));
vi.mock("../src/titles.ts", () => ({
  useTitleLists: () => scenario.lists,
  useMetadataVersion: () => 0,
  titleOf: (index: IndexedCatalogue, kind: "movie" | "series", version: OwnedId) =>
    byIds(index, kind, [version])[0],
  // Details that never answer: the page shows its facts as loading.
  detailsOf: () => new Promise(() => undefined),
  collectionOf: () => ({ name: "", titles: [] }),
  episodesOf: async () => [],
}));
vi.mock("../src/play-title.ts", () => ({
  failureOf: () => undefined,
  useFailure: () => undefined,
  playMovie: (_title: unknown, version: OwnedId) => scenario.played.push(version),
  playEpisode: () => undefined,
}));
vi.mock("../src/viewing.ts", () => ({
  useViewing: () => null,
  progressOf: async () => [],
  markEpisode: async () => null,
  relist: async () => undefined,
  seriesViewing: async () => ({ progress: [], marks: [] }),
  undoMark: async () => undefined,
}));
vi.mock("../src/watchlist.ts", () => ({
  useWatchlist: () => [],
  savedEntry: () => undefined,
  saveTitle: () => undefined,
  removeTitle: () => undefined,
}));

const { DetailsScreen } = await import("../src/details-screen.tsx");

/** One film, which both providers list under the same id and TMDB id. */
const catalogue: OnDemandCatalogue = {
  movieCategories: [],
  seriesCategories: [],
  series: [],
  movies: [
    {
      id: "1",
      name: "Same movie (EN)",
      tmdbId: "100001",
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
const LABELS: Record<string, string> = { a: "Home", b: "Cabin" };

/** The providers saved now, each listing the film. */
function providers(...ids: string[]) {
  scenario.lists = {
    kind: "ready",
    index: indexCatalogue(
      ids.map((subscriptionId) => ({ subscriptionId, catalogue })),
      "en",
    ),
  };
  scenario.members = ids.map((id) => ({ entry: { id }, label: LABELS[id] ?? id }));
}

let unmount = () => {};
afterEach(() => {
  unmount();
  scenario.menu = null;
  scenario.played.length = 0;
});

function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    React.act(() =>
      root.render(React.createElement(DetailsScreen, { kind: "movie", version: "a:1" })),
    );
  render();
  unmount = () => React.act(() => root.unmount());
  const press = (testID: string) =>
    React.act(() =>
      container
        .querySelector(`[data-testid="${testID}"]`)!
        .dispatchEvent(new Event("click", { bubbles: true })),
    );
  return {
    /** The screen again, as a change of the lists draws it. */
    render,
    /** Plays, and answers whose version played. */
    play() {
      press("details-play");
      return scenario.played.at(-1)?.subscriptionId;
    },
    openVersions() {
      press("details-version");
      const menu = scenario.menu;
      if (!menu) throw new Error("No version menu");
      return (label: string) =>
        React.act(() => menu.pick(menu.options.findIndex((each) => each.startsWith(label))));
    },
  };
}

describe("a film's version", () => {
  it("plays from a provider still saved once the one picked is removed", () => {
    providers("a", "b");
    const page = mount();
    expect(page.play()).toBe("a");
    page.openVersions()("Cabin");
    expect(page.play()).toBe("b");

    providers("a");
    page.render();
    expect(page.play()).toBe("a");
    // Added again, it isn't picked again by itself.
    providers("a", "b");
    page.render();
    expect(page.play()).toBe("a");
  });

  it("ignores a pick from a menu shown before its provider was removed", () => {
    providers("a", "b");
    const page = mount();
    const pick = page.openVersions();
    providers("a");
    page.render();
    pick("Cabin");
    expect(page.play()).toBe("a");
  });
});
