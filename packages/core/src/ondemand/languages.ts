// The languages a viewer can pick for movies and series, and how well a version suits one. A
// provider lists each language version of a film on its own, marked in its name: "(NL)",
// "(MULTI)", "(GER)". Those marks are a convention, not a field, so a version without one counts
// as unknown rather than wrong. Where films are subtitled rather than dubbed, as in Dutch, a mark
// says the sound is the film's own: "(NL)" on an English film is English with Dutch subtitles,
// unless it says otherwise, as "(NL AUDIO)". A mark followed by "SUB" names the subtitles in any
// language: "(ENG SUB)" is the film's own sound with English subtitles.

import { languageName } from "./tracks.ts";

/**
 * Languages to choose from: ISO 639-1 codes, their names, the marks that stand for them, and
 * whether their versions keep the film's own sound, with subtitles.
 */
export const TITLE_LANGUAGES = [
  { code: "en", name: "English", marks: ["EN", "ENG", "ENGLISH", "UK", "US"], subtitled: false },
  {
    code: "nl",
    name: "Nederlands",
    marks: ["NL", "NLD", "DUTCH", "VLAAMS", "BE"],
    subtitled: true,
  },
  {
    code: "de",
    name: "Deutsch",
    marks: ["DE", "GER", "GERMAN", "DEU", "DEUTSCH"],
    subtitled: false,
  },
  {
    code: "fr",
    name: "Français",
    marks: ["FR", "FRE", "FRA", "FRENCH", "VF", "VFF"],
    subtitled: false,
  },
  {
    code: "es",
    name: "Español",
    marks: ["ES", "ESP", "SPA", "SPANISH", "LATINO", "CAST"],
    subtitled: false,
  },
  { code: "it", name: "Italiano", marks: ["IT", "ITA", "ITALIAN"], subtitled: false },
  { code: "pt", name: "Português", marks: ["PT", "POR", "BR", "PTBR"], subtitled: false },
  { code: "pl", name: "Polski", marks: ["PL", "POL", "POLISH"], subtitled: false },
  { code: "tr", name: "Türkçe", marks: ["TR", "TUR", "TURKISH"], subtitled: false },
] as const;

export type TitleLanguage = (typeof TITLE_LANGUAGES)[number]["code"];

/** English until the viewer picks another. */
export const DEFAULT_TITLE_LANGUAGE: TitleLanguage = "en";

const WORD_END = /[\s-]/;

/** Provider conventions used by existing catalogue suitability ranking. */
const MULTI = new Set(["MULTI", "MULTI AUDIO", "MULTISUB", "MULTI SUB", "VO"]);
/** Only these name marks hint at several audio languages in a filter. */
const MULTI_AUDIO = new Set(["MULTI", "MULTI AUDIO"]);
const LANGUAGE_MARKS = new Map<string, (typeof TITLE_LANGUAGES)[number]>(
  TITLE_LANGUAGES.flatMap((language) => language.marks.map((mark) => [mark, language] as const)),
);

/** Words after a mark that say the sound was replaced: "NL AUDIO", "NL DUBBED". */
const DUBBED = /\b(AUDIO|DUB|DUBBED)\b/;
/** Words after a mark that say it names the subtitles: "ENG SUB", "GER SUBS". */
const SUBTITLED = /\b(SUBS?|SUBBED|SUBTITLED)\b/;

/**
 * A mark's language, and whether it keeps the film's own sound with subtitles in that language:
 * `named` so, as "ENG SUB", or for a language that subtitles, unless the sound was replaced.
 */
function markOf(tag: string) {
  const mark = tag.toUpperCase();
  // "NL AUDIO" and "DE-DUBBED" are their first word.
  const space = mark.search(WORD_END);
  const language = LANGUAGE_MARKS.get(space < 0 ? mark : mark.slice(0, space));
  const rest = space < 0 ? "" : mark.slice(space);
  const named = SUBTITLED.test(rest);
  const subtitles = named || (language?.subtitled === true && !DUBBED.test(rest));
  return { mark, language, subtitles, named };
}

/** Name hints only. A Dutch mark can mean subtitles; it never proves Dutch audio. */
export function languageHints(tags: readonly string[]): readonly string[] {
  const hints = new Set<string>();
  for (const tag of tags) {
    const { mark, language } = markOf(tag);
    if (MULTI_AUDIO.has(mark)) hints.add("multi");
    else if (language) hints.add(language.code);
  }
  return hints.size ? [...hints] : ["unknown"];
}

/**
 * How well a version suits a language, from its name's marks:
 * - 4 in that language
 * - 3 in several
 * - 2 marked for a language that subtitles, so likely with its own sound, as "(NL)", or marked
 *   for subtitles, as "(ENG SUB)"
 * - 1 when nothing says what it sounds like
 * - 0 dubbed into another language
 */
export function suitability(tags: readonly string[], language: string): number {
  let multi = false;
  let subtitled = false;
  let dubbed = false;
  for (const tag of tags) {
    const { mark, language: marked, subtitles } = markOf(tag);
    if (marked?.code === language) return 4;
    if (MULTI.has(mark)) multi = true;
    else if (marked && subtitles) subtitled = true;
    else if (marked) dubbed = true;
  }
  return multi ? 3 : subtitled ? 2 : dubbed ? 0 : 1;
}

/**
 * Whether a version of this suitability suits a viewer of `language`, given the language TMDB
 * says the film was made in: in the language or several, or with its own sound, unless that is
 * known to be another language.
 */
export function suits(fit: number, madeIn: string | null | undefined, language: string): boolean {
  return fit >= 3 || (fit >= 1 && (!madeIn || madeIn === language));
}

/** Marks for every language at once, as a version's menu names them. */
const MULTI_NAMES: Readonly<Record<string, string>> = {
  MULTI: "Several languages",
  "MULTI AUDIO": "Several languages",
  MULTISUB: "Several subtitle languages",
  "MULTI SUB": "Several subtitle languages",
  VO: "Original sound",
};

/**
 * What each version sounds like, and what it subtitles, from its marks as the provider wrote them
 * and `madeIn`, the language TMDB says the title was made in: "English sound, Nederlands
 * subtitles · 1080p", "Deutsch sound", "Several languages · 4K". A mark for a language that
 * subtitles, as "(NL)", means the title's own sound with those subtitles, unless the title was
 * made in that language or the mark says the sound was replaced, as "(NL AUDIO)". A mark for
 * subtitles, as "(ENG SUB)", means the title's own sound with those subtitles. Without a mark,
 * "Standard". Versions that read the same are numbered, "Deutsch sound 2", so each can be told
 * apart.
 */
export function versionLabels(
  versions: readonly { readonly tags: readonly string[] }[],
  madeIn: string | null,
): string[] {
  const labels = versions.map(({ tags }) => {
    const parts = tags.map((tag) => {
      const { mark, language, subtitles, named } = markOf(tag);
      const multi = MULTI_NAMES[mark];
      if (multi) return multi;
      if (!language) return tag;
      if (subtitles && (named || madeIn !== language.code)) {
        const original = (madeIn && languageName(madeIn)) || "Original";
        return `${original} sound, ${language.name} subtitles`;
      }
      return `${language.name} sound`;
    });
    return parts.join(" · ") || "Standard";
  });
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label} ${count}`;
  });
}
