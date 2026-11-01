import { createRoot, document } from "./dom.ts";
import * as React from "react";
import type { Locale } from "@mrstreamer/contracts/language";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { byIds, indexCatalogue, type IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import { setLanguage } from "@mrstreamer/core/i18n";
import type { Title } from "@mrstreamer/contracts/ondemand";
import type { OnDemandCatalogue, ProviderDetails, ProviderTitle } from "@mrstreamer/core/provider";
import { afterEach, expect, it, vi } from "vitest";
import { browseFixture } from "./title-browse-fixture.ts";
import { browseCollection, DEFAULT_BROWSE } from "../src/title-browse.ts";

// The library in the interface language, as the viewer meets it: a collection's count, Sort &
// filter and a title's details read in the language picked, while title, provider and version
// names stay as given, and a new language leaves the sort chosen, the sheet open, the version
// picked and what Play plays where they were. The real screens run with React DOM on a happy-dom
// window, as details-screen.test.ts does, over the real collections (title-browse-fixture.ts).

const scenario = vi.hoisted(() => ({
  made: null as unknown,
  index: null as unknown,
  members: [] as Array<{ entry: { id: string }; label: string; needsSecret?: boolean }>,
  /** The system sheet last shown: its words, and what picking one does. */
  menu: null as {
    title: string | undefined;
    options: readonly string[];
    pick: (at: number) => void;
  } | null,
  played: [] as OwnedId[],
  /** The provider's answer for a title's details; unanswered when null. */
  provided: null as ProviderDetails | null,
}));
/** One answer per source, as the app's stores give: a new render alone makes nothing new. */
const stable = vi.hoisted(() => {
  const made = new Map<unknown, unknown>();
  return <T>(source: unknown, make: () => T): T => {
    if (!made.has(source)) made.set(source, make());
    return made.get(source) as T;
  };
});

vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { title, options }: { title?: string; options: string[] },
      pick: (at: number) => void,
    ) => {
      scenario.menu = { title, options, pick };
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
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: {},
    Message: ({ text }: { text: string }) => createElement("p", null, text),
  };
});
vi.mock("../src/loading.tsx", async () => {
  const { createElement, Fragment } = await import("react");
  const pass = ({ children }: { children?: React.ReactNode }) =>
    createElement(Fragment, null, children);
  return {
    Docked: pass,
    Placeholders: pass,
    Shape: () => null,
    PlaceholderLines: () => null,
    useDockInset: () => 0,
    libraryStatus: () => null,
    loadingStatus: () => null,
  };
});
vi.mock("../src/titles-ui.tsx", async () => {
  const { createElement, Fragment } = await import("react");
  return {
    Artwork: () => null,
    ProgressLine: () => null,
    Shelf: () => null,
    // Each tab a button named by its label, pressed when it is the one chosen.
    TextTabs: ({
      tabs,
      value,
      onChange,
    }: {
      tabs: readonly { value: string; label: string }[];
      value: string;
      onChange: (value: string) => void;
    }) =>
      createElement(
        Fragment,
        null,
        ...tabs.map((tab) =>
          createElement(
            "button",
            {
              key: tab.value,
              "aria-label": tab.label,
              "aria-pressed": String(tab.value === value),
              onClick: () => onChange(tab.value),
            },
            tab.label,
          ),
        ),
      ),
    PlaceholderGrid: () => null,
    PlaceholderShelf: () => null,
    CollectionTileView: () => null,
    // The grid's header, then each title's name in order.
    PosterGrid: ({ header, titles }: { header: React.ReactNode; titles: { title: string }[] }) =>
      createElement(
        Fragment,
        null,
        header,
        createElement("ol", { "data-testid": "grid" }, ...titles.map((each) => each.title)),
      ),
  };
});
vi.mock("../src/header.tsx", () => ({ tabHref: () => "/" }));
vi.mock("../src/tab-bar.ts", () => ({ useFixedTabBar: () => undefined }));
vi.mock("../src/account.ts", () => ({
  members: () => scenario.members,
  reloadTitles: () => undefined,
  retryTitles: () => undefined,
  useRoster: () => stable(scenario.members, () => ({ kind: "ready", members: scenario.members })),
}));
vi.mock("../src/resume.ts", () => ({
  detailsHref: () => "/",
  openDetails: () => undefined,
  resume: () => undefined,
  useContinueWatching: () => [],
  versionOf: (key: string) => {
    const at = key.indexOf(":");
    return { subscriptionId: key.slice(0, at), id: key.slice(at + 1) };
  },
}));
vi.mock("../src/titles.ts", () => ({
  useTitleLists: () => stable(scenario.index, () => ({ kind: "ready", index: scenario.index })),
  useCollections: (kind: string) => (kind === "movie" ? scenario.made : null),
  useMetadataVersion: () => 0,
  useFileFacts: () => 0,
  useHolding: () => undefined,
  filterFilesOf: () => new Map(),
  collectionSelection: () => () => true,
  tilesOf: () => [],
  titleOf: (index: IndexedCatalogue, kind: "movie" | "series", version: OwnedId) =>
    byIds(index, kind, [version])[0],
  // As the app reads them: core makes the details of the provider's answer at each read.
  detailsOf: async (title: Title) => {
    const { seriesDetails } = await import("@mrstreamer/core/ondemand/details");
    return scenario.provided
      ? seriesDetails(title, scenario.provided, null, "en")
      : new Promise(() => undefined);
  },
  episodesOf: async () => [],
}));
vi.mock("../src/viewing.ts", () => ({
  useViewing: () => null,
  progressOf: async () => [],
  markEpisode: async () => null,
  relist: async () => undefined,
  seriesViewing: async () => ({ progress: [], marks: [] }),
  undoMark: async () => undefined,
}));
vi.mock("../src/play-title.ts", () => ({
  failureOf: () => undefined,
  useFailure: () => undefined,
  resumeMovie: (_title: unknown, version: OwnedId) => scenario.played.push(version),
  resumeEpisode: () => undefined,
  resumeSeries: () => undefined,
}));
vi.mock("../src/playback.ts", () => ({ request: () => ({ stands: () => true }) }));
vi.mock("../src/storage.ts", () => ({
  useSavedState: () => ({}),
  pickedVersion: () => null,
  pickVersion: () => undefined,
}));
vi.mock("../src/watchlist.ts", () => ({
  useWatchlist: () => [],
  savedEntry: () => undefined,
  saveTitle: () => undefined,
  removeTitle: () => undefined,
}));
vi.mock("../src/downloads.ts", () => ({ useDownloadOf: () => undefined }));
vi.mock("../src/download-controls.tsx", () => ({
  DownloadButton: () => null,
  actionsOf: () => [],
  downloadAction: () => ({ name: "Download", label: "Download", destructive: false, run() {} }),
  showActions: () => undefined,
  stateWord: () => "",
}));
vi.mock("../src/series-download-row.tsx", () => ({ SeriesDownloadRow: () => null }));

const { CollectionScreen } = await import("../src/titles-screen.tsx");
const { DetailsScreen } = await import("../src/details-screen.tsx");

let container: ReturnType<typeof document.createElement>;
let unmount = () => {};
function mount(element: React.ReactElement) {
  container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(element));
  unmount = () => React.act(() => root.unmount());
}
const speak = (locale: Locale) => React.act(() => setLanguage({ locale, formats: locale }));
const text = () => container.textContent ?? "";
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
};
const version = () =>
  [...container.querySelectorAll("button")].find(
    (each) => each.getAttribute("data-testid") === "details-version",
  );
const press = (label: string) => React.act(() => button(label).click());
const grid = () => container.querySelector('[data-testid="grid"]')?.textContent;

afterEach(() => {
  unmount();
  setLanguage({ locale: "en-US", formats: "en-US" });
  scenario.menu = null;
  scenario.played = [];
  scenario.provided = null;
});

it("counts and sorts a collection in the language, keeping the sort and the open sheet", () => {
  const { made, index } = browseFixture("movie");
  scenario.made = made;
  scenario.index = index;
  const total = browseCollection(made, "all", DEFAULT_BROWSE).total;
  speak("fr-FR");
  mount(React.createElement(CollectionScreen, { kind: "movie", id: "all" }));
  expect(text()).toContain(`${total} sur ${total} films`);
  press("Trier et filtrer");
  press("Titre");
  const byTitle = grid();
  expect(byTitle).toBe(
    browseCollection(made, "all", { sort: "title", filters: {} })
      .titles.map((each) => each.title)
      .join(""),
  );
  expect(button("Titre").getAttribute("aria-pressed")).toBe("true");

  speak("de-DE");
  // The sheet stays open on the sort chosen, now in German, over the same titles in that order.
  expect(button("Titel").getAttribute("aria-pressed")).toBe("true");
  expect(text()).toContain("Sortieren und filtern");
  expect(text()).toContain(`${total} von ${total} Filmen`);
  expect(text()).toContain(`${total} Filme zeigen`);
  expect(grid()).toBe(byTitle);
  expect(text()).not.toMatch(/Trier|Titre|films/);
});

it("shows a title's details in the language, keeping the version picked for Play", () => {
  const movie: ProviderTitle = {
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
  };
  const catalogue: OnDemandCatalogue = {
    movieCategories: [],
    seriesCategories: [],
    series: [],
    movies: [movie],
  };
  scenario.members = [
    { entry: { id: "a" }, label: "Home" },
    { entry: { id: "b" }, label: "Cabin" },
  ];
  scenario.index = indexCatalogue(
    ["a", "b"].map((subscriptionId) => ({ subscriptionId, catalogue })),
    "en",
  );
  speak("es-ES");
  mount(React.createElement(DetailsScreen, { kind: "movie", version: "a:1" }));
  expect(button("Reproducir")).toBeTruthy();
  expect(button("Guardar")).toBeTruthy();
  React.act(() => version()!.click());
  expect(scenario.menu?.title).toBe("Versión");
  expect(scenario.menu?.options[0]).toBe("Automática");
  expect(scenario.menu?.options.at(-1)).toBe("Cancelar");
  // The second provider's version, named by its provider as given.
  const cabin = scenario.menu!.options.findIndex((option) => option.startsWith("Cabin"));
  React.act(() => scenario.menu!.pick(cabin));
  expect(version()?.getAttribute("aria-label")).toContain("Audio English");

  speak("nl-NL");
  expect(text()).toContain("Same movie");
  expect(button("Bewaren")).toBeTruthy();
  expect(version()?.getAttribute("aria-label")).toMatch(/^Versie, Cabin/);
  // Core's name for the version's sound follows the language too.
  expect(version()?.getAttribute("aria-label")).toContain("Geluid English");
  press("Afspelen");
  expect(scenario.played).toEqual([{ subscriptionId: "b", id: "1" }]);
});

it("names the app's own season headings in a new language, keeping the provider's and the season chosen", async () => {
  const series: ProviderTitle = {
    id: "2",
    name: "Same series",
    container: null,
    categoryIds: [],
    posterUrl: null,
    backdropUrl: null,
    releaseDate: null,
    rating: null,
    addedAt: 1,
    adult: false,
  };
  scenario.members = [{ entry: { id: "a" }, label: "Home" }];
  scenario.index = indexCatalogue(
    [
      {
        subscriptionId: "a",
        catalogue: { movieCategories: [], seriesCategories: [], movies: [], series: [series] },
      },
    ],
    "en",
  );
  const episode = (id: string, season: number) => ({
    id,
    season,
    number: 1,
    name: `Episode ${id}`,
    plot: null,
    duration: null,
    stillUrl: null,
    airDate: null,
    addedAt: null,
    container: "mkv",
  });
  // The provider names season 1 itself; season 2 and the specials it leaves to the app.
  scenario.provided = {
    originalName: null,
    plot: null,
    genres: [],
    cast: [],
    directors: [],
    releaseDate: null,
    duration: null,
    posterUrl: null,
    backdropUrl: null,
    seasons: [{ number: 1, name: "Seizoen 1", posterUrl: null }],
    episodes: [episode("101", 1), episode("201", 2), episode("901", 0)],
    container: null,
  };
  speak("fr-FR");
  mount(React.createElement(DetailsScreen, { kind: "series", version: "a:2" }));
  await React.act(async () => await new Promise((done) => setTimeout(done, 0)));
  press("Saison 2");
  expect(button("Saison 2").getAttribute("aria-pressed")).toBe("true");
  expect(button("Épisodes spéciaux")).toBeTruthy();

  speak("de-DE");
  await React.act(async () => await new Promise((done) => setTimeout(done, 0)));
  expect(button("Staffel 2").getAttribute("aria-pressed")).toBe("true");
  expect(button("Specials")).toBeTruthy();
  expect(button("Seizoen 1")).toBeTruthy();
  expect(text()).not.toMatch(/Saison|spéciaux/);
});
