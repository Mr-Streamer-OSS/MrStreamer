// What the watchlist goes by, as plain functions: which saved entry and which title in the lists
// are the same movie or series, and which of the saved subscriptions' records are one entry. The
// catalogue worker uses them to find an entry's title, and the record to find a title's entry.
//
// A title is known by TMDB's id while the lists gather its versions by it, so another language or
// quality, a new name or a new order changes nothing. A title TMDB doesn't name is known by the
// provider's id of its row, in the subscription that lists it, and by nothing else: names and
// years never make two titles one. An entry that has a TMDB id is never taken for a title without
// that id, whatever the provider's id says: providers give the id of a row they dropped to
// another film.
//
// Each account keeps its own record of a title it saved, by its provider's ids. A film two
// subscriptions list under one TMDB id is one title in the lists, and what both saved of it is
// one entry: the same proof joins the records that joins the versions. A record without that
// proof stays an entry of its own, whatever another subscription saved under the same id or name.
import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { kindOf, type IndexedCatalogue } from "./catalogue.ts";

/**
 * What one subscription's lists say of a title that the watchlist goes by, and keeps for when
 * they say no more.
 */
export interface TitleFacts {
  readonly kind: TitleKind;
  /** TMDB's id of it, as the lists give it, or null. */
  readonly tmdbId: string | null;
  /**
   * The provider's ids of the versions that subscription lists, the one shown first in front.
   * None when it lists none of a title another subscription does.
   */
  readonly versionIds: readonly string[];
  /** The name it shows. */
  readonly name: string;
  readonly year: number | null;
  /** For adults: a row that stands on its own, which never joins others by its TMDB id. */
  readonly adult: boolean;
}

/** A saved title as an account's record keeps it, by the provider's own ids. */
export interface SavedTitle extends TitleFacts {
  /** Made up when it was saved, and its own from then on. */
  readonly id: string;
  /**
   * Epoch milliseconds. A record a subscription gets of a title that is saved already takes the
   * time of that entry.
   */
  readonly savedAt: number;
  /**
   * Its place among every account's records in the order they were written: higher for one
   * written later. It says which of two with the same time was saved first.
   */
  readonly sequence: number;
}

/** A saved title with the subscription whose account keeps it: with `id`, an `OwnedId`. */
export interface SavedMember extends SavedTitle {
  readonly subscriptionId: string;
}

type Identity = Pick<TitleFacts, "kind" | "tmdbId" | "versionIds" | "adult">;

/** A title as the subscription `subscriptionId` lists it: its own versions, and no other's. */
export function factsOf(title: Title, subscriptionId: string): TitleFacts {
  return {
    kind: title.kind,
    tmdbId: title.tmdbId,
    versionIds: title.versions.flatMap((version) =>
      version.subscriptionId === subscriptionId ? [version.id] : [],
    ),
    name: title.title,
    year: title.year,
    adult: title.adult,
  };
}

/** Whether the lists gather a title's versions by its TMDB id: it has one, and isn't for adults. */
function gathered(title: Pick<TitleFacts, "tmdbId" | "adult">): boolean {
  return Boolean(title.tmdbId) && !title.adult;
}

/**
 * Whether a saved title and a title in the lists of the same subscription are the same movie or
 * series.
 *
 * A saved title with a TMDB id is the title with that id and no other. One with another id is
 * another title, and one without an id is not surely it, though it has a provider's id the saved
 * title holds. Where the lists gather both by the id, the id is enough, whichever versions the
 * provider lists now. A row for adults stands on its own, so there the saved title has to hold
 * the row's id as well.
 *
 * A saved title without a TMDB id is the title that has one of its versions.
 */
export function sameTitle(saved: Identity, title: Identity): boolean {
  if (saved.kind !== title.kind) return false;
  if (saved.tmdbId && saved.tmdbId !== title.tmdbId) return false;
  if (gathered(saved) && gathered(title)) return true;
  return saved.versionIds.some((id) => title.versionIds.includes(id));
}

/**
 * Whether what two accounts saved is one entry: the same movie or series by the TMDB id the
 * lists gather versions by. Nothing else says so across subscriptions, whose providers number
 * alike: not their ids, and not a name.
 */
export function sameEntry(a: Identity, b: Identity): boolean {
  return a.kind === b.kind && gathered(a) && gathered(b) && a.tmdbId === b.tmdbId;
}

/**
 * The saved titles of the subscriptions as the entries they make, each with what its
 * subscriptions saved of it, the one saved first in front: that one names the entry and gives it
 * the time it was saved.
 */
export function entriesOf(members: readonly SavedMember[]): SavedMember[][] {
  const entries = Map.groupBy(members, (member) =>
    gathered(member)
      ? `${member.kind}:tmdb:${member.tmdbId}`
      : `${member.kind}:${ownedKey(member)}`,
  );
  return [...entries.values()].map((entry) => entry.toSorted(savedFirst));
}

/**
 * Orders saved titles by when they were saved, and by which was written first where two have the
 * same time. So the record an entry was saved with stays in front of one it got later, and the
 * entry keeps its id.
 */
export function savedFirst(
  a: Pick<SavedTitle, "savedAt" | "sequence">,
  b: Pick<SavedTitle, "savedAt" | "sequence">,
): number {
  return a.savedAt - b.savedAt || a.sequence - b.sequence;
}

/**
 * The title a saved one is in the lists now, or null when they hold none that is surely it: the
 * one its TMDB id gathers, whichever subscription lists it and in whatever versions, else the
 * first of its versions that its own subscription still lists as it.
 */
export function titleOf(catalogue: IndexedCatalogue, saved: SavedMember): Title | null {
  const { byId, byTmdbId } = kindOf(catalogue, saved.kind);
  const known = saved.tmdbId && !saved.adult ? byTmdbId().get(saved.tmdbId) : undefined;
  if (known) return known;
  const { subscriptionId } = saved;
  for (const id of saved.versionIds) {
    const title = byId.get(ownedKey({ subscriptionId, id }));
    if (title && sameTitle(saved, factsOf(title, subscriptionId))) return title;
  }
  return null;
}

/**
 * What becomes of `matches`, the titles an account saved that are the title its subscription's
 * lists now describe as `facts`, or null without any. The one saved first stays, with its id and
 * the time it was saved, and takes the title as it is now: its name, year and versions, whether
 * it is for adults, and its TMDB id, which a saved title gains once the lists have one for it and
 * never loses. The others, the same title saved when nothing showed it yet, go.
 */
export function settled(
  matches: readonly SavedTitle[],
  facts: TitleFacts,
): { readonly kept: SavedTitle; readonly dropped: readonly string[] } | null {
  const [first, ...rest] = matches.toSorted(savedFirst);
  if (!first) return null;
  return {
    kept: {
      ...facts,
      id: first.id,
      savedAt: first.savedAt,
      sequence: first.sequence,
      // A title the lists don't gather keeps every version it was saved with: the provider may
      // list any of them again.
      versionIds: gathered(facts)
        ? facts.versionIds
        : [...new Set(matches.flatMap((entry) => entry.versionIds))],
    },
    dropped: rest.map((entry) => entry.id),
  };
}
