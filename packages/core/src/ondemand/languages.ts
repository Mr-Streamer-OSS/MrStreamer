// The languages a viewer can pick for movies and series, and how well a version suits one. A
// provider lists each language version of a film on its own, marked in its name: "(NL)",
// "(MULTI)", "(GER)". Those marks are a convention, not a field, so a version without one counts
// as unknown rather than wrong. Where films are subtitled rather than dubbed, as in Dutch, a mark
// says nothing about the sound either: "(NL)" on an English film is English with Dutch subtitles.

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

/**
 * How well a version suits a language, from its name's marks: 3 when it is in that language, 2
 * when it carries several, 1 when nothing says what it sounds like, 0 when it is dubbed into
 * another language.
 */
export function suitability(tags: readonly string[], language: string): number {
  let multi = false;
  let other = false;
  for (const tag of tags) {
    const mark = tag.toUpperCase();
    // "NL AUDIO" and "DE-DUBBED" are their first word.
    const space = mark.search(WORD_END);
    const marked = LANGUAGE_MARKS.get(space < 0 ? mark : mark.slice(0, space));
    if (marked?.code === language) return 3;
    if (MULTI.has(mark)) multi = true;
    else if (marked && !marked.subtitled) other = true;
  }
  return multi ? 2 : other ? 0 : 1;
}
