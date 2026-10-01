// The languages a viewer can pick for movies and series, and how well a version suits one. A
// provider lists each language version of a film on its own, marked in its name: "(NL)",
// "(MULTI)", "(GER)". Those marks are a convention, not a field, so a version without one counts
// as unknown rather than wrong.

/** Languages to choose from: ISO 639-1 codes, their names, and the marks that stand for them. */
export const TITLE_LANGUAGES = [
  { code: "en", name: "English", marks: ["EN", "ENG", "ENGLISH", "UK", "US"] },
  { code: "nl", name: "Nederlands", marks: ["NL", "NLD", "DUTCH", "VLAAMS", "BE"] },
  { code: "de", name: "Deutsch", marks: ["DE", "GER", "GERMAN", "DEU", "DEUTSCH"] },
  { code: "fr", name: "Français", marks: ["FR", "FRE", "FRA", "FRENCH", "VF", "VFF"] },
  { code: "es", name: "Español", marks: ["ES", "ESP", "SPA", "SPANISH", "LATINO", "CAST"] },
  { code: "it", name: "Italiano", marks: ["IT", "ITA", "ITALIAN"] },
  { code: "pt", name: "Português", marks: ["PT", "POR", "BR", "PTBR"] },
  { code: "pl", name: "Polski", marks: ["PL", "POL", "POLISH"] },
  { code: "tr", name: "Türkçe", marks: ["TR", "TUR", "TURKISH"] },
] as const;

export type TitleLanguage = (typeof TITLE_LANGUAGES)[number]["code"];

/** English until the viewer picks another. */
export const DEFAULT_TITLE_LANGUAGE: TitleLanguage = "en";

/** Marks a version carries for every language at once. */
const MULTI = new Set(["MULTI", "MULTI AUDIO", "MULTISUB", "MULTI SUB", "VO"]);
const LANGUAGE_MARKS = new Map<string, string>(
  TITLE_LANGUAGES.flatMap(({ code, marks }) => marks.map((mark): [string, string] => [mark, code])),
);

/**
 * How well a version suits a language, from its name's marks: 3 when it is in that language, 2
 * when it carries several, 1 when nothing says, 0 when it is in another language.
 */
export function suitability(tags: readonly string[], language: string): number {
  let multi = false;
  let other = false;
  for (const tag of tags) {
    const mark = tag.toUpperCase();
    // "NL AUDIO" and "DE-DUBBED" are their first word.
    const code = LANGUAGE_MARKS.get(mark.split(/[\s-]/)[0] ?? mark);
    if (code === language) return 3;
    if (MULTI.has(mark)) multi = true;
    else if (code) other = true;
  }
  return multi ? 2 : other ? 0 : 1;
}
