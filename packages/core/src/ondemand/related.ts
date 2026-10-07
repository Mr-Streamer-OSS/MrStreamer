import type { RelatedTitles, Title } from "@mrstreamer/contracts/ondemand";
import { sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";

interface RelatedSource {
  readonly opened: Title;
  readonly version: OwnedId;
  readonly titles: readonly Title[];
  /** Provider category ids are meaningful only within this version's subscription. */
  readonly categories: (version: OwnedId) => readonly string[];
}

const LIMIT = 12;
const COMMON_WORDS = new Set(["the", "and", "for", "with", "from", "movie", "film"]);
const languages = new Intl.DisplayNames(["en"], { type: "language" });

function words(name: string): Set<string> {
  return new Set(
    (name.toLocaleLowerCase("en").match(/\p{L}[\p{L}\p{N}]*/gu) ?? []).filter(
      (word) => word.length >= 3 && !COMMON_WORDS.has(word),
    ),
  );
}

/** Rank available titles without fetching metadata, libraries or playable files. */
export function relatedTitles(source: RelatedSource): RelatedTitles {
  const { opened, version } = source;
  const genres = new Set(opened.genres);
  const categories = new Set(source.categories(version));
  const nameWords = words(opened.title);
  const best: { title: Title; reason: string; score: number }[] = [];
  const seen = new Set<string>();
  for (let candidate of source.titles) {
    if (
      candidate.key === opened.key ||
      candidate.kind !== opened.kind ||
      candidate.adult ||
      seen.has(candidate.key) ||
      candidate.versions.some((each) => sameOwned(each, version))
    )
      continue;
    seen.add(candidate.key);
    const shared = candidate.genres.filter((genre) => genres.has(genre));
    let score = 0;
    let reason = "";
    if (shared.length > 0) {
      const sameLanguage = Boolean(
        opened.originalLanguage && opened.originalLanguage === candidate.originalLanguage,
      );
      score = 100 + shared.length * 2 + Number(sameLanguage);
      reason = shared.slice(0, 2).join(", ");
      if (sameLanguage && opened.originalLanguage) {
        reason += ` · ${languages.of(opened.originalLanguage) ?? opened.originalLanguage}`;
      }
    } else if (genres.size === 0 || candidate.genres.length === 0) {
      const own = candidate.versions.find((each) => each.subscriptionId === version.subscriptionId);
      if (!own) continue;
      if (source.categories(own).some((category) => categories.has(category))) {
        score = 20;
        reason = "Same category";
      } else {
        const sharedWords = [...words(candidate.title)].filter((word) => nameWords.has(word));
        if (sharedWords.length === 0) continue;
        score = Math.min(sharedWords.length, 10);
        reason = "Similar name";
      }
      // A fallback always opens the version whose provider supplied the matching facts.
      candidate = { ...candidate, ...own };
    }
    if (!score) continue;
    const at = best.findIndex((entry) => score > entry.score);
    best.splice(at < 0 ? best.length : at, 0, { title: candidate, reason, score });
    if (best.length > LIMIT) best.pop();
  }
  return {
    basis: best[0]?.reason ?? null,
    titles: best.map(({ title, reason }) => ({ title, reason })),
  };
}
