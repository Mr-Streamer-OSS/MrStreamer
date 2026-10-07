// How the episodes of a series stand, and where the series goes on: one set of rules for the
// details, Continue watching and the player's next episode, so they never disagree. They are plain
// functions of what one subscription recorded of the series: how far its files got, and the
// episodes the viewer marked by hand.
//
// An episode is known by its season and number, so another version's file, or a file the provider
// put in an episode's place, counts for it. A mark stands against a play begun before it, also
// while that play goes on, and gives way to a play begun after it.
import type { RawTitleRef } from "@mrstreamer/contracts/ondemand";
import type { EpisodeMark } from "@mrstreamer/contracts/viewing";

/** How far a file got, by the provider's ids or with its subscription: both read alike here. */
interface Played {
  readonly title: RawTitleRef;
  readonly position: number;
  readonly finished: boolean;
  readonly at: number;
  readonly since: number;
}

/** An episode as a series lists it: by its numbers, and by its file where that is known. */
interface Listed {
  readonly id?: string;
  readonly season: number;
  readonly number: number;
}

/** The seasons a series version lists, in its order: specials, season 0, wherever they stand. */
interface Listing<E extends Listed> {
  readonly seasons: readonly { readonly number: number; readonly episodes: readonly E[] }[];
}

/** An episode by its numbers, and by its file when that is known. */
interface Numbered {
  readonly id?: string;
  readonly season: number;
  readonly episode: number;
}

export type EpisodeState<P> =
  | { readonly kind: "unwatched" }
  /** Played partway: it resumes from `progress`. */
  | { readonly kind: "partial"; readonly progress: P }
  | { readonly kind: "watched" };

/** Where a series goes on. */
export interface Continuation<E, P> {
  readonly episode: E;
  /** How far it got, when it goes on from there. Without it, it plays from its beginning. */
  readonly resume: P | undefined;
  /** Every numbered episode is watched, and `episode` is the first of them, to watch again. */
  readonly replay: boolean;
}

const numbers = (season: number, episode: number) => `${season}:${episode}`;

/** The later of two, by `time`. */
function latest<A>(items: readonly A[], time: (item: A) => number): A | undefined {
  let found: A | undefined;
  for (const item of items) if (!found || time(item) > time(found)) found = item;
  return found;
}

/** What a subscription recorded of a series, by episode. */
function recorded<P extends Played>(progress: readonly P[], marks: readonly EpisodeMark[]) {
  const plays = new Map<string, P[]>();
  for (const entry of progress) {
    if (entry.title.kind !== "episode") continue;
    const key = numbers(entry.title.season, entry.title.episode);
    const list = plays.get(key);
    if (list) list.push(entry);
    else plays.set(key, [entry]);
  }
  const marked = new Map(marks.map((mark) => [numbers(mark.season, mark.episode), mark]));
  /** The play that says how an episode stands: its latest, of those begun after its mark. */
  const playOf = (season: number, episode: number): P | undefined => {
    const mark = marked.get(numbers(season, episode));
    const counted = (plays.get(numbers(season, episode)) ?? []).filter(
      (entry) => !mark || entry.since > mark.at,
    );
    return latest(counted, (entry) => entry.at);
  };
  const stateOf = (season: number, episode: number): EpisodeState<P> => {
    const play = playOf(season, episode);
    if (play) {
      if (play.finished) return { kind: "watched" };
      return play.position > 0 ? { kind: "partial", progress: play } : { kind: "unwatched" };
    }
    return marked.get(numbers(season, episode))?.watched
      ? { kind: "watched" }
      : { kind: "unwatched" };
  };
  /**
   * What the viewer did last among the episodes `within` holds: the latest mark there, or the
   * latest play of one of them begun after it.
   */
  const lastIn = (within: (season: number) => boolean): Numbered | undefined => {
    const mark = latest(
      marks.filter((each) => within(each.season)),
      (each) => each.revision,
    );
    const play = latest(
      progress.filter(
        ({ title, since }) =>
          title.kind === "episode" && within(title.season) && (!mark || since > mark.at),
      ),
      (entry) => entry.at,
    );
    if (play?.title.kind === "episode") return play.title;
    return mark;
  };
  return { stateOf, lastIn };
}

/** How each episode of a series stands, by its season and number. */
export function episodeStates<P extends Played>(
  progress: readonly P[],
  marks: readonly EpisodeMark[],
): (episode: { readonly season: number; readonly number: number }) => EpisodeState<P> {
  const { stateOf } = recorded(progress, marks);
  return ({ season, number }) => stateOf(season, number);
}

/** `named` among `episodes`: by its file, else by its numbers. */
function listedAs<E extends Listed>(episodes: readonly E[], named: Numbered): E | undefined {
  return (
    (named.id === undefined ? undefined : episodes.find((each) => each.id === named.id)) ??
    episodes.find((each) => each.season === named.season && each.number === named.episode)
  );
}

/**
 * Where a series goes on, or null when it lists no episode.
 *
 * It follows what the viewer did last. An episode played partway resumes. One marked unwatched
 * plays from its beginning. After one watched, played or marked, comes the next episode that isn't
 * watched, from its beginning, and once none is left after it, the first one before it that isn't.
 * With every numbered episode watched, the first is offered to watch again.
 *
 * Specials, season 0, stand apart: one played or marked leads to other specials, and once those
 * are watched the numbered seasons go on from what the viewer did last in them. Watching the
 * numbered seasons to their end never leads into specials.
 */
export function continuation<E extends Listed, P extends Played>(
  series: Listing<E>,
  progress: readonly P[],
  marks: readonly EpisodeMark[],
): Continuation<E, P> | null {
  const numbered = series.seasons
    .filter(({ number }) => number > 0)
    .flatMap((each) => each.episodes);
  const specials = series.seasons
    .filter(({ number }) => number === 0)
    .flatMap((each) => each.episodes);
  // A series of specials alone goes through them as others go through their seasons.
  const main = numbered.length > 0 ? numbered : specials;
  const [first] = main;
  if (!first) return null;
  const { stateOf, lastIn } = recorded(progress, marks);
  const watched = (episode: E) => stateOf(episode.season, episode.number).kind === "watched";
  /** Where `group` goes on from the episode the viewer was last at in it. */
  const onward = (group: readonly E[], last: Numbered | undefined): Continuation<E, P> | null => {
    const at = last && listedAs(group, last);
    if (at && !watched(at)) {
      const state = stateOf(at.season, at.number);
      return {
        episode: at,
        resume: state.kind === "partial" ? state.progress : undefined,
        replay: false,
      };
    }
    const place = at ? group.indexOf(at) : -1;
    const next =
      group.slice(place + 1).find((each) => !watched(each)) ??
      group.slice(0, Math.max(place, 0)).find((each) => !watched(each));
    return next ? { episode: next, resume: undefined, replay: false } : null;
  };
  const last = lastIn(() => true);
  // A special the series lists no more leads nowhere among them.
  const inSpecials = main === numbered && last?.season === 0 && !!listedAs(specials, last);
  return (
    (inSpecials ? onward(specials, last) : null) ??
    onward(main, inSpecials ? lastIn((season) => season > 0) : last) ?? {
      episode: first,
      resume: undefined,
      replay: true,
    }
  );
}

/**
 * Whether a series has no episode left to go on with once a play of `current`, begun at `since`,
 * watched it to its end: every numbered episode is watched, that one among them. An episode
 * marked by hand since the play began stands as its mark says, the one that played too. A series
 * with an earlier episode still to watch isn't finished, and neither are the numbered seasons by
 * a special.
 */
export function finishes<E extends Listed, P extends Played>(
  series: Listing<E>,
  current: Numbered & { readonly since: number },
  progress: readonly P[],
  marks: readonly EpisodeMark[],
): boolean {
  const { id = "", season, episode, since } = current;
  const watched: Played = {
    title: { kind: "episode", id, seriesId: "", season, episode },
    position: 0,
    finished: true,
    at: Infinity,
    since,
  };
  return continuation<E, Played>(series, [...progress, watched], marks)?.replay === true;
}

/**
 * The episode the player goes on to after `current`: the next one that isn't watched, in the
 * series' order, into the next season after a season's last. Null when none is left after it: it
 * never goes back to an earlier episode, and specials, season 0, only lead to other specials.
 * `current` is found by its file, else by its numbers. Undefined when the series doesn't list it.
 */
export function nextUnwatched<E extends Listed, P extends Played>(
  series: Listing<E>,
  current: Numbered,
  progress: readonly P[],
  marks: readonly EpisodeMark[],
): E | null | undefined {
  const group = series.seasons
    .filter(({ number }) => (number === 0) === (current.season === 0))
    .flatMap((each) => each.episodes);
  const at = listedAs(group, current);
  if (!at) return undefined;
  const { stateOf } = recorded(progress, marks);
  return (
    group
      .slice(group.indexOf(at) + 1)
      .find((each) => stateOf(each.season, each.number).kind !== "watched") ?? null
  );
}
