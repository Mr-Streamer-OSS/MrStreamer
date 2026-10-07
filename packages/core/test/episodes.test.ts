// How a series' episodes stand, where the series goes on and which episode the player plays next,
// from what one subscription recorded of it: plays of its files, and episodes marked by hand.
import type { Title } from "@mrstreamer/contracts/ondemand";
import type { EpisodeMark } from "@mrstreamer/contracts/viewing";
import { describe, expect, it } from "vitest";
import { continuation, episodeStates, finishes, nextUnwatched } from "../src/viewing/episodes.ts";
import { seriesIdentity } from "../src/viewing/marks.ts";
import { accepted } from "../src/viewing/titles.ts";

const listed = (season: number, number: number) => ({ id: `s${season}e${number}`, season, number });

/** Two seasons of three episodes, and two specials, which the provider lists last. */
const series = {
  seasons: [
    { number: 1, episodes: [listed(1, 1), listed(1, 2), listed(1, 3)] },
    { number: 2, episodes: [listed(2, 1), listed(2, 2), listed(2, 3)] },
    { number: 0, episodes: [listed(0, 1), listed(0, 2)] },
  ],
};

/** A play of an episode's file, saved at `at`, in a play that began at `since`. */
function play(
  season: number,
  number: number,
  at: number,
  { position = 2700, since = at, file = `s${season}e${number}` } = {},
) {
  return {
    title: { kind: "episode" as const, id: file, seriesId: "nl", season, episode: number },
    position,
    duration: 2700,
    finished: position >= 2650,
    at,
    since,
  };
}

/** A mark made at `at`. Later ones have a higher revision, as the record numbers them. */
const mark = (season: number, episode: number, watched: boolean, at: number): EpisodeMark => ({
  season,
  episode,
  watched,
  at,
  revision: at,
});

/** Where the series goes on, in few words: the episode, where it resumes, and whether it replays. */
function goesOn(plays: ReturnType<typeof play>[], marks: EpisodeMark[] = []) {
  const found = continuation(series, plays, marks);
  return (
    found && {
      episode: found.episode.id,
      resume: found.resume?.position ?? null,
      replay: found.replay,
    }
  );
}

describe("how an episode stands", () => {
  it("is watched once marked, without a play or a length to go by", () => {
    const stateOf = episodeStates([], [mark(1, 2, true, 10)]);

    expect(stateOf(listed(1, 2))).toEqual({ kind: "watched" });
    expect(stateOf(listed(1, 1))).toEqual({ kind: "unwatched" });
  });

  it("loses its resume point once marked unwatched, and its check once it was finished", () => {
    const halfway = play(1, 1, 5, { position: 900 });
    const stateOf = episodeStates(
      [halfway, play(1, 2, 6)],
      [mark(1, 1, false, 10), mark(1, 2, false, 11)],
    );

    expect(stateOf(listed(1, 1))).toEqual({ kind: "unwatched" });
    expect(stateOf(listed(1, 2))).toEqual({ kind: "unwatched" });
  });

  it("keeps its mark against a play that began before it, however late that play saves", () => {
    // Playing since 5, marked unwatched at 10, and the play saves on, into its credits.
    const going = [play(1, 1, 60, { position: 1200, since: 5 }), play(1, 1, 90, { since: 5 })];

    expect(episodeStates(going, [mark(1, 1, false, 10)])(listed(1, 1))).toEqual({
      kind: "unwatched",
    });
  });

  it("goes by a play that began after its mark", () => {
    const again = play(1, 1, 30, { position: 900, since: 20 });

    expect(episodeStates([again], [mark(1, 1, true, 10)])(listed(1, 1))).toEqual({
      kind: "partial",
      progress: again,
    });
  });

  it("counts another version's file, and a file the provider put in its place, by its numbers", () => {
    const other = play(1, 2, 5, { file: "english-file" });
    const stateOf = episodeStates([other], [mark(1, 3, true, 10)]);

    expect(stateOf(listed(1, 2))).toEqual({ kind: "watched" });
    // The episode under a file id the mark never saw.
    const replaced = { ...listed(1, 3), id: "replaced" };
    expect(stateOf(replaced)).toEqual({ kind: "watched" });
  });
});

describe("where a series goes on", () => {
  it("starts at the first numbered episode, and resumes the one played last", () => {
    expect(goesOn([])).toEqual({ episode: "s1e1", resume: null, replay: false });
    expect(goesOn([play(1, 1, 1), play(1, 2, 2, { position: 600 })])).toEqual({
      episode: "s1e2",
      resume: 600,
      replay: false,
    });
  });

  it("offers the next episode that isn't watched after one marked watched, from its beginning", () => {
    // Episode 3 was watched before, and the first of season 2 stopped partway.
    const plays = [play(1, 3, 1), play(2, 1, 2, { position: 600 }), play(1, 1, 3)];

    expect(goesOn(plays, [mark(1, 2, true, 10)])).toEqual({
      episode: "s2e1",
      resume: null,
      replay: false,
    });
  });

  it("offers an episode marked unwatched from its beginning, though it was played partway", () => {
    expect(goesOn([play(1, 2, 5, { position: 900 })], [mark(1, 2, false, 10)])).toEqual({
      episode: "s1e2",
      resume: null,
      replay: false,
    });
  });

  it("stays where a mark put it while a play from before the mark saves on", () => {
    // Watching 2x1 since 5, the viewer marks 1x1 unwatched; the play saves at 60.
    const going = [play(2, 1, 60, { position: 1200, since: 5 })];

    expect(goesOn(going, [mark(1, 1, false, 10)])).toMatchObject({ episode: "s1e1" });
    // The same episode started again afterwards is what the viewer did last.
    expect(
      goesOn([...going, play(2, 1, 80, { position: 300, since: 70 })], [mark(1, 1, false, 10)]),
    ).toEqual({ episode: "s2e1", resume: 300, replay: false });
  });

  it("offers the first earlier episode that isn't watched once none is left after the mark", () => {
    const rest = [play(1, 1, 1), play(1, 3, 2), play(2, 1, 3), play(2, 2, 4)];

    expect(goesOn(rest, [mark(2, 3, true, 10)])).toEqual({
      episode: "s1e2",
      resume: null,
      replay: false,
    });
  });

  it("offers the first episode again once every numbered one is watched, specials or not", () => {
    const all = series.seasons
      .filter((season) => season.number > 0)
      .flatMap((season) => season.episodes)
      .map((episode, at) => mark(episode.season, episode.number, true, at + 1));

    expect(goesOn([], all)).toEqual({ episode: "s1e1", resume: null, replay: true });
  });

  it("keeps specials apart: a special leads to specials, and never ends the numbered seasons", () => {
    const halfway = play(1, 2, 5, { position: 900 });

    expect(goesOn([halfway], [mark(0, 1, true, 10)])).toEqual({
      episode: "s0e2",
      resume: null,
      replay: false,
    });
    // With the specials watched, the numbered seasons go on where the viewer was in them.
    expect(goesOn([halfway], [mark(0, 1, true, 10), mark(0, 2, true, 11)])).toEqual({
      episode: "s1e2",
      resume: 900,
      replay: false,
    });
    // And the last numbered episode leads to an earlier one, never into the specials.
    expect(goesOn([play(1, 1, 1)], [mark(2, 3, true, 10)])).toMatchObject({ episode: "s1e2" });
  });

  it("has nowhere to go in a series without episodes", () => {
    expect(continuation({ seasons: [] }, [], [])).toBeNull();
  });
});

describe("the episode the player plays next", () => {
  const next = (
    season: number,
    episode: number,
    plays = [play(1, 3, 1)],
    marks = [mark(2, 1, true, 10)],
  ) => nextUnwatched(series, { season, episode }, plays, marks)?.id ?? null;

  it("passes over watched episodes, played or marked, into the next season", () => {
    expect(next(1, 2)).toBe("s2e2");
    expect(next(1, 1)).toBe("s1e2");
  });

  it("never goes back to an earlier episode, nor from a season's end into specials", () => {
    expect(next(2, 3)).toBeNull();
    expect(next(2, 2, [], [mark(2, 3, true, 10)])).toBeNull();
    expect(next(0, 1)).toBe("s0e2");
    expect(next(0, 2)).toBeNull();
  });

  it("finds the open episode by its numbers, and knows none after one the series doesn't list", () => {
    expect(nextUnwatched(series, { id: "other-file", season: 1, episode: 3 }, [], [])?.id).toBe(
      "s2e1",
    );
    expect(nextUnwatched(series, { season: 4, episode: 1 }, [], [])).toBeUndefined();
  });
});

describe("a series watched to its end", () => {
  /** Every numbered episode but the last, watched. */
  const rest = series.seasons
    .filter((season) => season.number > 0)
    .flatMap((season) => season.episodes)
    .slice(0, -1)
    .map((episode, at) => play(episode.season, episode.number, at + 1));
  const last = { id: "s2e3", season: 2, episode: 3, since: 50 };

  it("is finished by the play that watches the last episode left, and by no other", () => {
    expect(finishes(series, last, rest, [])).toBe(true);
    // An earlier episode still to watch keeps it going, whichever one plays to its end.
    expect(finishes(series, last, rest.slice(1), [])).toBe(false);
    expect(finishes(series, { season: 1, episode: 1, since: 50 }, rest.slice(1), [])).toBe(false);
  });

  it("goes by a mark made since the play began: of the episode that played, or of another", () => {
    expect(finishes(series, last, rest, [mark(2, 3, false, 60)])).toBe(false);
    expect(finishes(series, last, rest, [mark(1, 2, false, 60)])).toBe(false);
    // One from before the play gives way to it.
    expect(finishes(series, last, rest, [mark(2, 3, false, 40)])).toBe(true);
    expect(finishes(series, last, rest.slice(1), [mark(1, 1, true, 60)])).toBe(true);
  });

  it("is never finished by a special, nor kept going by one", () => {
    expect(finishes(series, { season: 0, episode: 2, since: 50 }, [], [])).toBe(false);
    expect(finishes(series, last, rest, [mark(0, 1, false, 40)])).toBe(true);
  });
});

describe("which checkpoints count", () => {
  /** A checkpoint saved at 100, from a play that began at `since`. */
  const from = (since: number) => ({ since, at: 100 });
  /** The row of a play that began at `since`, saved last at 50. */
  const holds = (since: number) => ({ since, at: 50 });

  it("is every one of the play a title's row holds, and of a play begun later", () => {
    expect(accepted(undefined, from(10), null)).toBe(true);
    expect(accepted(holds(10), from(10), null)).toBe(true);
    expect(accepted(holds(10), from(20), null)).toBe(true);
  });

  it("is none of a play older than the one the row holds, nor of one begun before its episode was marked", () => {
    expect(accepted(holds(20), from(10), null)).toBe(false);
    expect(accepted(holds(10), from(10), 15)).toBe(false);
    expect(accepted(undefined, from(15), 15)).toBe(false);
    expect(accepted(holds(10), from(16), 15)).toBe(true);
  });

  it("is one that seems older only because the clock was set back since the row was saved", () => {
    expect(accepted({ since: 500, at: 600 }, from(90), null)).toBe(true);
  });
});

describe("what a series' marks are kept under", () => {
  const version = (subscriptionId: string, id: string) => ({ subscriptionId, id, tags: [] });
  const title = (changes: Partial<Title>): Title => ({
    kind: "series",
    key: "series:tmdb:90000",
    subscriptionId: "a",
    id: "nl",
    name: "Harbour Lights (NL)",
    title: "Harbour Lights",
    originalTitle: null,
    originalLanguage: null,
    tags: [],
    year: null,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: "90000",
    genres: [],
    versions: [version("a", "nl"), version("a", "en"), version("b", "nl")],
    ...changes,
  });
  const named = { subscriptionId: "a", id: "en" };

  it("is its TMDB id, with every version its own subscription lists and no other's", () => {
    expect(seriesIdentity(named, title({}))).toEqual({
      key: "tmdb:90000",
      // And each version's own id, which held its marks before the lists had a TMDB id for it.
      keys: ["tmdb:90000", "id:nl", "id:en"],
      versions: ["nl", "en"],
    });
  });

  it("is the provider's id of the version alone without a TMDB id, for adults, or off the lists", () => {
    const alone = { key: "id:en", keys: ["id:en"], versions: ["en"] };

    expect(seriesIdentity(named, title({ tmdbId: null }))).toEqual(alone);
    expect(seriesIdentity(named, title({ adult: true }))).toEqual(alone);
    expect(seriesIdentity(named, undefined)).toEqual(alone);
    // A title that doesn't hold the version says nothing of it, whatever it is called.
    expect(seriesIdentity(named, title({ versions: [version("a", "nl")] }))).toEqual(alone);
  });
});
