// The languages a viewer can pick for movies and series, and how well a version suits one. A
// provider lists each language version of a film on its own, marked in its name: "(NL)",
// "(MULTI)", "(GER)". Those marks are a convention, not a field, so a version without one counts
// as unknown rather than wrong. Where films are subtitled rather than dubbed, as in Dutch, a mark
// says the sound is the film's own: "(NL)" on an English film is English with Dutch subtitles,
// unless it says otherwise, as "(NL AUDIO)".

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

/** Marks a version carries for every language at once. */
const MULTI = new Set(["MULTI", "MULTI AUDIO", "MULTISUB", "MULTI SUB", "VO"]);
const LANGUAGE_MARKS = new Map<string, (typeof TITLE_LANGUAGES)[number]>(
  TITLE_LANGUAGES.flatMap((language) => language.marks.map((mark) => [mark, language] as const)),
);

/** Words after a mark that say the sound was replaced: "NL AUDIO", "NL DUBBED". */
const DUBBED = /\b(AUDIO|DUB|DUBBED)\b/;

/**
 * How well a version suits a language, from its name's marks:
 * - 4 in that language
 * - 3 in several
 * - 2 marked for a language that subtitles, so likely with its own sound, as "(NL)"
 * - 1 when nothing says what it sounds like
 * - 0 dubbed into another language
 */
export function suitability(tags: readonly string[], language: string): number {
  let multi = false;
  let subtitled = false;
  let dubbed = false;
  for (const tag of tags) {
    const mark = tag.toUpperCase();
    // "NL AUDIO" and "DE-DUBBED" are their first word.
    const space = mark.search(WORD_END);
    const marked = LANGUAGE_MARKS.get(space < 0 ? mark : mark.slice(0, space));
    if (marked?.code === language) return 4;
    if (MULTI.has(mark)) multi = true;
    else if (marked?.subtitled && !(space >= 0 && DUBBED.test(mark.slice(space)))) subtitled = true;
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
