// Which provider categories are for adults, by their names. Providers set `is_adult` on some
// titles and channels and not on others, so a category named for adults marks everything in it.
// Movies and series and live channels go by the same rule.
//
// The list is short on purpose: whole words that, in a category's name, only mean content for
// adults, in the languages of the panels seen so far. Ordinary mature-rated films aren't meant:
// "18+" counts, as panels name adult categories "ADULT 18+" and "+18", but rating words such as
// "MATURE" don't. "Adult Swim", a cartoon channel, isn't one either.
import type { ProviderCategory } from "./provider.ts";

const ADULT_WORDS = [
  "xxx",
  "porn",
  "porno",
  "18+",
  "+18",
  // English, French, Spanish and Portuguese, Italian, German, Dutch.
  "adult",
  "adults",
  "adulte",
  "adultes",
  "adulto",
  "adultos",
  "adulti",
  "erwachsene",
  "volwassenen",
];

/** One of the words, not inside another word or number. */
const ADULT = new RegExp(
  `(?<![\\p{L}\\p{N}+])(${ADULT_WORDS.map((word) => word.replaceAll("+", "\\+")).join("|")})(?![\\p{L}\\p{N}+])`,
  "iu",
);
/** Names that hold one of the words without meaning it. */
const NOT_ADULT = /adult\s+swim/giu;

/** Whether a provider category's name says it is for adults. */
export function isAdultCategory(name: string): boolean {
  return ADULT.test(name.replace(NOT_ADULT, ""));
}

/**
 * Whether a title or channel is for adults: marked so by the provider, or in a category named for
 * adults among `categories`.
 */
export function adultIn(
  categories: readonly ProviderCategory[],
): (item: { readonly adult?: boolean; readonly categoryIds: readonly string[] }) => boolean {
  const adult = new Set(
    categories.filter((category) => isAdultCategory(category.name)).map(({ id }) => id),
  );
  return (item) => item.adult === true || item.categoryIds.some((id) => adult.has(id));
}
