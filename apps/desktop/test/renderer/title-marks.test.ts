// @vitest-environment happy-dom
// Marking a film, a season or a whole series watched or unwatched at once, from details and from
// History: the command names its scope, the line says how many changed with Undo, which sends
// back what the command made, a mark that wasn't stored offers Retry under the same id, an Undo
// the record refused says so, and History keeps online and local entries apart.
//
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import type { MovieDetails, SeriesDetails, Title } from "@mrstreamer/contracts/ondemand";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type { HistoryEntry, TitleProgress, Viewing } from "@mrstreamer/contracts/viewing";
import { HistoryPage } from "../../src/renderer/src/features/history/HistoryPage.tsx";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { syncViewing } from "../../src/renderer/src/lib/queries.ts";

/** Another saved subscription, whose versions are other files with their own record. */
const OTHER = "7d1e2c3b-4a59-4f6e-8a7b-9c0d1e2f3a4b";
const OTHER_SAVED: SubscriptionSummary = { ...SAVED, id: OTHER, name: "Holiday house" };

/** A film in two versions of this subscription and one of another. */
const film: Title = {
  kind: "movie",
  key: "movie:kite",
  subscriptionId: SUBSCRIPTION,
  id: "hd",
  name: "Kite Season (EN)",
  title: "Kite Season",
  originalTitle: null,
  originalLanguage: "en",
  tags: ["EN"],
  year: 2022,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "701",
  genres: [],
  versions: [
    { subscriptionId: SUBSCRIPTION, id: "hd", tags: ["EN"] },
    { subscriptionId: SUBSCRIPTION, id: "4k", tags: ["EN", "4K"] },
    { subscriptionId: OTHER, id: "kite", tags: ["EN"] },
  ],
};

const movieDetails: MovieDetails = {
  kind: "movie",
  title: film,
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: 5460,
  backdropUrl: null,
};

const halfway: TitleProgress = {
  title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "hd" },
  position: 2700,
  duration: 5460,
  finished: false,
  at: 100,
  since: 100,
};

const HARBOUR = { subscriptionId: SUBSCRIPTION, id: "harbour" };

const series: Title = {
  ...film,
  kind: "series",
  key: "series:harbour",
  id: "harbour",
  name: "Night Harbour",
  title: "Night Harbour",
  tmdbId: "900",
  versions: [{ subscriptionId: SUBSCRIPTION, id: "harbour", tags: [] }],
};

const seriesDetails: SeriesDetails = {
  kind: "series",
  title: series,
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [1, 2].map((number) => ({
    number,
    name: `Season ${number}`,
    posterUrl: null,
    episodes: [1, 2].map((episode) => ({
      subscriptionId: SUBSCRIPTION,
      id: `${number}-${episode}`,
      seriesId: "harbour",
      season: number,
      number: episode,
      title: `Part ${number}.${episode}`,
      plot: null,
      duration: 2700,
      stillUrl: null,
      airDate: null,
    })),
  })),
};

const viewing = (sequence: number): Viewing => ({
  favourites: [],
  recent: [],
  continueWatching: [],
  marked: [],
  sequence,
});

let unmount = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
});

const text = () => document.body.textContent ?? "";

const until = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(() => vi.advanceTimersByTimeAsync(10));
      check();
    },
    { timeout: 5000 },
  );

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);

const click = (label: string) => act(async () => button(label)?.click());

/** Renders `element` with the record kept current, as the app does. */
async function show(element: ReturnType<typeof createElement>): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["subscriptions"], [SAVED, OTHER_SAVED]);
  const stopSync = syncViewing(client);
  const view = queryView(client);
  await view.render(element);
  unmount = () => {
    stopSync();
    view.unmount();
  };
}

/** The film's details, halfway through its HD version, with no mark standing. */
async function filmSheet(marksReady = true): Promise<void> {
  ipc.always("ondemand.titles", [film]);
  ipc.always("viewing.progress", [halfway]);
  ipc.always("viewing.get", viewing(1));
  ipc.always("ondemand.details", movieDetails);

  if (marksReady) ipc.always("viewing.filmMarks", []);
  await show(
    createElement(DetailsView, {
      target: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "hd" },
    }),
  );

  if (marksReady) await until(() => expect(button("Mark watched")).toBeDefined());
}

describe("marking a film from its details", () => {
  it("resumes a newer replay despite a sibling version's older film mark", async () => {
    await filmSheet();
    ipc.always("viewing.filmMarks", [
      { movie: film.versions[1]!, watched: true, at: 200, revision: 7 },
    ]);
    await act(async () => ipc.emit("viewing.changed", viewing(2)));
    await until(() => expect(button("Mark unwatched")).toBeDefined());
    expect(button("Resume")).toBeUndefined();
    ipc.always("viewing.progress", [{ ...halfway, since: 300, at: 400 }]);
    await act(async () => ipc.emit("viewing.changed", viewing(2)));
    await until(() => expect(button("Resume")).toBeDefined());
    expect(button("Mark watched")).toBeDefined();
  });

  it("waits for held film marks, keeps failed reads retryable, and never resumes stale progress", async () => {
    const held = ipc.hold("viewing.filmMarks");
    await filmSheet(false);
    await until(() => expect(button("Play")?.disabled).toBe(true));
    expect(button("Resume")).toBeUndefined();
    await act(async () => held.reject({ kind: "unexpected", detail: "read failed" }));
    await until(() => expect(text()).toContain("Couldn't read what you watched."));
    expect(button("Play")?.disabled).toBe(true);
    expect(button("Resume")).toBeUndefined();
    ipc.always("viewing.filmMarks", [
      { movie: film.versions[1]!, watched: true, at: 200, revision: 7 },
    ]);
    await click("Try again");
    await until(() => expect(button("Mark unwatched")).toBeDefined());
    expect(button("Play")?.disabled).toBe(false);
    expect(button("Resume")).toBeUndefined();
  });

  it("marks the versions of its own subscription, says so with Undo, and Undo sends back what it made", async () => {
    await filmSheet();
    expect(button("Resume")).toBeDefined();

    const marked = ipc.hold("viewing.markTitles");
    await click("Mark watched");
    const [sent] = ipc.argsOf("viewing.markTitles");
    expect(sent).toEqual({
      commandId: expect.any(String),
      scope: {
        kind: "film",
        versions: [
          { subscriptionId: SUBSCRIPTION, id: "hd" },
          { subscriptionId: SUBSCRIPTION, id: "4k" },
        ],
      },
      watched: true,
    });

    const made = [
      { kind: "movie" as const, title: { subscriptionId: SUBSCRIPTION, id: "hd" }, revision: 7 },
      { kind: "movie" as const, title: { subscriptionId: SUBSCRIPTION, id: "4k" }, revision: 7 },
    ];

    ipc.always("viewing.filmMarks", [
      { movie: made[0]!.title, watched: true, at: 200, revision: 7 },
      { movie: made[1]!.title, watched: true, at: 200, revision: 7 },
    ]);
    await act(async () => marked.resolve({ changed: 2, made }));
    await until(() => expect(text()).toContain("Marked Kite Season watched"));
    // The mark stands over the play: the film starts from its beginning, and can be unmarked.
    expect(button("Resume")).toBeUndefined();
    expect(button("Mark unwatched")).toBeDefined();

    const undone = ipc.hold("viewing.undoMarks");
    await click("Undo");
    expect(ipc.argsOf("viewing.undoMarks")).toEqual([{ commandId: expect.any(String), made }]);
    expect(ipc.argsOf("viewing.undoMarks")[0]?.commandId).not.toBe(sent?.commandId);

    ipc.always("viewing.filmMarks", []);
    await act(async () => undone.resolve(null));
    await until(() => expect(text()).not.toContain("Marked Kite Season watched"));
    expect(button("Resume")).toBeDefined();
    expect(button("Undo")).toBeUndefined();
  });

  it("keeps the sheet as it was when the mark wasn't stored, and Retry sends it again under the same id", async () => {
    await filmSheet();
    const first = ipc.hold("viewing.markTitles");
    await click("Mark watched");
    await act(async () => first.reject({ kind: "unexpected", detail: "The record is busy." }));
    await until(() => expect(text()).toContain("Couldn't mark Kite Season watched."));
    expect(button("Resume")).toBeDefined();

    const again = ipc.hold("viewing.markTitles");
    await click("Retry");
    const [before, after] = ipc.argsOf("viewing.markTitles");
    expect(after?.commandId).toBe(before?.commandId);
    await act(async () => again.resolve({ changed: 0, made: [] }));
    // The retried command finds nothing to change, so it offers no Undo.
    await until(() => expect(text()).toContain("Kite Season was already watched."));
    expect(button("Undo")).toBeUndefined();
  });

  it("says an Undo the record refused can no longer be done, with nothing to try again", async () => {
    await filmSheet();
    const marked = ipc.hold("viewing.markTitles");
    await click("Mark watched");

    ipc.always("viewing.filmMarks", [
      { movie: { subscriptionId: SUBSCRIPTION, id: "hd" }, watched: true, at: 200, revision: 7 },
    ]);
    await act(async () =>
      marked.resolve({
        changed: 1,
        made: [{ kind: "movie", title: { subscriptionId: SUBSCRIPTION, id: "hd" }, revision: 7 }],
      }),
    );
    await until(() => expect(button("Undo")).toBeDefined());

    const undone = ipc.hold("viewing.undoMarks");
    await click("Undo");
    await act(async () => undone.reject({ kind: "mark-changed" }));
    await until(() => expect(text()).toContain("This can no longer be undone."));
    expect(button("Retry")).toBeUndefined();
    expect(button("Undo")).toBeUndefined();
  });
});

describe("marking a season or a whole series from its details", () => {
  async function seriesSheet(): Promise<void> {
    ipc.always("ondemand.titles", [series]);
    ipc.always("viewing.progress", []);
    ipc.always("viewing.get", viewing(1));
    ipc.always("ondemand.details", seriesDetails);
    ipc.always("viewing.episodes", { progress: [], marks: [], undoable: null });
    await show(createElement(DetailsView, { target: { kind: "series", ...HARBOUR } }));
    await until(() => expect(button("Mark season watched")).toBeDefined());
  }

  it("names the season shown, counts the episodes it changed and goes once another mark is made", async () => {
    await seriesSheet();
    const marked = ipc.hold("viewing.markTitles");
    await click("Mark season watched");
    expect(ipc.argsOf("viewing.markTitles")[0]?.scope).toEqual({
      kind: "season",
      series: HARBOUR,
      season: 1,
    });

    ipc.always("viewing.episodes", {
      progress: [],
      marks: [1, 2].map((episode) => ({ season: 1, episode, watched: true, at: 20, revision: 20 })),
      undoable: 20,
    });
    await act(async () =>
      marked.resolve({ changed: 2, made: [{ kind: "series", title: HARBOUR, revision: 20 }] }),
    );
    await until(() => expect(text()).toContain("Marked 2 episodes of Season 1 watched"));
    expect(button("Mark season unwatched")).toBeDefined();

    // A later mark of the series, from anywhere: Undo would be refused, so the line goes.
    ipc.always("viewing.episodes", {
      progress: [],
      marks: [{ season: 1, episode: 1, watched: true, at: 30, revision: 30 }],
      undoable: 30,
    });
    await act(async () => ipc.emit("viewing.changed", { sequence: 2 }));
    await until(() => expect(text()).not.toContain("Marked 2 episodes of Season 1 watched"));
  });

  it("marks every episode of the series in the version shown, and says when they already stood so", async () => {
    await seriesSheet();
    ipc.always("viewing.markTitles", { changed: 0, made: [] });
    await click("Mark series watched");
    expect(ipc.argsOf("viewing.markTitles")[0]?.scope).toEqual({ kind: "series", series: HARBOUR });
    await until(() => expect(text()).toContain("Night Harbour was already watched."));
    expect(button("Undo")).toBeUndefined();
  });
});

describe("History", () => {
  const copy: Download = {
    id: "d1",
    title: { kind: "episode", id: "e1", seriesId: "harbour", season: 1, episode: 2 },
    subscription: { id: SUBSCRIPTION, name: "Home IPTV" },
    name: "Night Harbour",
    episodeName: "The Long Shore",
    year: 2024,
    duration: 2700,
    originalLanguage: "en",
    posterUrl: null,
    wideUrl: null,
    size: 1,
    status: { kind: "complete" },
    progress: { position: 1380, duration: 2700 },
    series: null,
  };

  const downloads: DownloadList = { items: [copy], series: {}, bytes: 1, free: 1, ended: 0 };

  const entries: readonly HistoryEntry[] = [
    {
      kind: "series",
      series: HARBOUR,
      progress: null,
      mark: { season: 2, episode: 2, watched: true, at: 300, revision: 9 },
      at: 300,
    },
    {
      kind: "movie",
      movie: { subscriptionId: SUBSCRIPTION, id: "hd" },
      progress: halfway,
      mark: null,
      at: 100,
    },
    // Of another subscription: the same film's other file, its own entry, never its progress.
    {
      kind: "movie",
      movie: { subscriptionId: OTHER, id: "kite" },
      progress: null,
      mark: { movie: { subscriptionId: OTHER, id: "kite" }, watched: true, at: 90, revision: 4 },
      at: 90,
    },
    // The lists no longer have it.
    {
      kind: "movie",
      movie: { subscriptionId: SUBSCRIPTION, id: "gone" },
      progress: null,
      mark: null,
      at: 80,
    },
  ];

  async function history(): Promise<void> {
    ipc.always("viewing.history", entries);
    ipc.always("viewing.get", viewing(1));
    ipc.answer("ondemand.titles", ({ kind }) => (kind === "movie" ? [film] : [series]));
    ipc.always("recordings.resume", { owner: { id: "default", revision: 1 }, items: [] });
    ipc.always("downloads.list", downloads);
    await show(createElement(HistoryPage, { onBack: () => {} }));
    await until(() => expect(text()).toContain("Night Harbour"));
  }

  it("lists each version the lists still have in its own subscription, apart from what played on this computer", async () => {
    await history();
    const online = document.querySelector('[aria-labelledby="history-online"]')?.textContent ?? "";
    const local = document.querySelector('[aria-labelledby="history-local"]')?.textContent ?? "";

    expect(online).toContain("S2 E2 marked watched");
    expect(online).toContain("Kite Season");
    expect(online).toContain("46 min left");
    expect(online).toContain("Holiday house · marked watched");
    expect(online.match(/Kite Season/g)).toHaveLength(2);
    expect(online).not.toContain("The Long Shore");
    // A download keeps its own place, and no time it was played.
    expect(local).toContain("S1 E2 The Long Shore · 22 min left");
  });

  it("marks only the exact film version in a History row", async () => {
    await history();
    ipc.always("viewing.markTitles", { changed: 0, made: [] });
    const dots = document.querySelector<HTMLElement>('[aria-label="More for Kite Season"]');
    await act(async () => dots?.click());
    await until(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((each) => each.textContent === "Mark watched")
        ?.click(),
    );
    expect(ipc.argsOf("viewing.markTitles")[0]?.scope).toEqual({
      kind: "film",
      versions: [{ subscriptionId: SUBSCRIPTION, id: "hd" }],
    });
  });

  it("drops History series Undo when a later play makes it ineligible", async () => {
    await history();

    const updated = entries.map((entry) =>
      entry.kind === "series"
        ? { ...entry, undoable: 10, mark: { ...entry.mark!, revision: 10 } }
        : entry,
    );

    ipc.always("viewing.history", updated);
    ipc.always("viewing.markTitles", {
      changed: 3,
      made: [{ kind: "series", title: HARBOUR, revision: 10 }],
    });
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="More for Night Harbour"]')?.click(),
    );
    await until(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((each) => each.textContent === "Mark series unwatched")
        ?.click(),
    );
    await until(() => expect(button("Undo")).toBeDefined());
    ipc.always(
      "viewing.history",
      updated.map((entry) => (entry.kind === "series" ? { ...entry, undoable: null } : entry)),
    );
    await act(async () => ipc.emit("viewing.changed", viewing(3)));
    await until(() => expect(button("Undo")).toBeUndefined());
  });

  it("marks a whole series from its entry and a film in its own subscription", async () => {
    await history();
    ipc.always("viewing.markTitles", { changed: 0, made: [] });

    const openMenu = async (name: string, index = 0) => {
      const dots = [...document.querySelectorAll<HTMLElement>(`[aria-label="More for ${name}"]`)];
      await act(async () => dots[index]?.click());
      await until(() =>
        expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0),
      );
    };

    const pick = (item: string) =>
      act(async () =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
          .find((each) => each.textContent === item)
          ?.click(),
      );

    await openMenu("Night Harbour");
    await pick("Mark series unwatched");
    expect(ipc.argsOf("viewing.markTitles")[0]?.scope).toEqual({ kind: "series", series: HARBOUR });
    await until(() => expect(text()).toContain("Night Harbour was already unwatched."));

    // The other subscription's entry marks only its own file.
    await openMenu("Kite Season", 1);
    await pick("Mark unwatched");
    expect(ipc.argsOf("viewing.markTitles")[1]?.scope).toEqual({
      kind: "film",
      versions: [{ subscriptionId: OTHER, id: "kite" }],
    });
  });
});
