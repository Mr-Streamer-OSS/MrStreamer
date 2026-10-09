import type { RelatedTitles, Title } from "@mrstreamer/contracts/ondemand";
import { sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { ProviderTitle } from "../provider.ts";
import { TITLE_LANGUAGES } from "./languages.ts";
import { formatLanguageName, t } from "../i18n.ts";
import { titleName } from "./names.ts";

/** Facts of one exact provider row; name words may be computed on first use. */
export interface RelatedProviderFacts {
  readonly words: ReadonlySet<string>;
  readonly categoryIds: readonly string[];
}

export interface RelatedSource {
  readonly opened: Title;
  readonly version: OwnedId;
  readonly titles: readonly Title[];
  /** Fallback names and category ids belong to the opened version's provider. */
  readonly provider: (version: OwnedId) => RelatedProviderFacts | null;
}

const LIMIT = 12;
const COMMON_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "movie",
  "film",
  "een",
  "het",
  "van",
  "les",
  "des",
  "une",
  "du",
  "aux",
  "avec",
  "pour",
  "der",
  "die",
  "das",
  "den",
  "dem",
  "ein",
  "eine",
  "einer",
  "einem",
  "einen",
  "eines",
  "und",
  "von",
  "mit",
  "los",
  "las",
  "del",
  "una",
  "unos",
  "unas",
  "con",
  "por",
  "para",
  "part",
  "one",
  "two",
  "vol",
  "chapter",
  ...TITLE_LANGUAGES.flatMap(({ marks }) => marks.map((mark) => mark.toLowerCase())),
]);

function words(name: string): Set<string> {
  return new Set(
    (name.toLocaleLowerCase("en").match(/\p{L}[\p{L}\p{N}]*/gu) ?? []).filter(
      (word) => word.length >= 3 && !COMMON_WORDS.has(word),
    ),
  );
}

/** Retain this map with its immutable provider list; names are needed only for fallback. */
export function relatedProviderFacts(
  rows: readonly ProviderTitle[],
  normalizedNames?: ReadonlyMap<string, string>,
): ReadonlyMap<string, RelatedProviderFacts> {
  const facts = new Map<string, RelatedProviderFacts>();
  for (const row of rows) {
    if (facts.has(row.id)) continue;
    let nameWords: ReadonlySet<string> | undefined;
    facts.set(row.id, {
      categoryIds: row.categoryIds,
      get words() {
        return (nameWords ??= words(
          normalizedNames?.get(row.id) ?? titleName(row.name, row.releaseDate).title,
        ));
      },
    });
  }
  return facts;
}

/** Rank available titles without fetching metadata, libraries or playable files. */
export function relatedTitles(source: RelatedSource): RelatedTitles {
  const { opened, version } = source;
  const genres = new Set(opened.genres);
  const original = source.provider(version);
  const categories = new Set(original?.categoryIds ?? []);
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
    let selected: Title["versions"][number] | undefined;
    if (shared.length > 0) {
      const sameLanguage = Boolean(
        opened.originalLanguage && opened.originalLanguage === candidate.originalLanguage,
      );
      score = 100 + shared.length * 2 + Number(sameLanguage);
      reason = shared.slice(0, 2).join(", ");
      if (sameLanguage && opened.originalLanguage) {
        reason += ` · ${formatLanguageName(opened.originalLanguage) ?? opened.originalLanguage}`;
      }
    } else if (genres.size === 0 || candidate.genres.length === 0) {
      if (!original) continue;
      const ownVersions = candidate.versions.filter(
        (each) => each.subscriptionId === version.subscriptionId,
      );
      selected = ownVersions.find((each) =>
        source.provider(each)?.categoryIds.some((category) => categories.has(category)),
      );
      if (selected) {
        score = 20;
        reason = t("Same category");
      } else {
        // A name scores at most ten and cannot displace a full row of stronger matches.
        if (best.length === LIMIT && best[LIMIT - 1]!.score >= 10) continue;
        for (const own of ownVersions) {
          const facts = source.provider(own);
          if (!facts) continue;
          let sharedWords = 0;
          let informative = false;
          for (const word of facts.words) {
            if (!original.words.has(word)) continue;
            sharedWords++;
            if (word.length >= 5) informative = true;
          }
          const wordScore = Math.min(sharedWords, 10);
          if ((!informative && sharedWords < 2) || wordScore <= score) continue;
          score = wordScore;
          selected = own;
        }
        reason = t("Similar name");
      }
      if (!selected) continue;
    }
    if (!score || (best.length === LIMIT && score <= best[LIMIT - 1]!.score)) continue;
    if (selected) {
      // A fallback always opens the version whose provider supplied the matching facts.
      candidate = {
        ...candidate,
        subscriptionId: selected.subscriptionId,
        id: selected.id,
        tags: selected.tags,
      };
    }
    const at = best.findIndex((entry) => score > entry.score);
    best.splice(at < 0 ? best.length : at, 0, { title: candidate, reason, score });
    if (best.length > LIMIT) best.pop();
  }
  return {
    basis: best[0]?.reason ?? null,
    titles: best.map(({ title, reason }) => ({ title, reason })),
  };
}
