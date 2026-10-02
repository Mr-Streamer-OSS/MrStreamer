// Display names for movies, series and episodes. Providers write the language after the title,
// "Blow 2001 (NL)", sometimes a year or quality marker, and episodes repeat their series in front:
// "Race Across the World (NL) - S02E03 - Tbilisi". A bare year stays part of the title, because
// it often is one: "Wonder Woman 1984", "Blade Runner 2049".
import { recase } from "../catalogue/normalize.ts";

/** A trailing "(NL)", "(MULTI)", "(NL AUDIO)", "(DE-DUBBED)". */
const LANGUAGE = /\s*[([]\s*([A-Za-z]{2,5}(?:[\s-][A-Za-z]{2,7})?)\s*[)\]]\s*$/;
/** A trailing "(2023)", or "- 2023" after the title. */
const YEAR = /\s*(?:\(\s*((?:19|20)\d{2})\s*\)|\s[-–]\s((?:19|20)\d{2}))\s*$/;
/** Quality markers as whole words. */
const QUALITY = /(?<![\p{L}\p{N}])(4K|UHD|HDR|HEVC|H\.?265|\d{3,4}p)(?![\p{L}\p{N}])/giu;
/** "S02E03", "S2 E3", with what follows it. */
const EPISODE_NUMBER = /\bS(\d{1,3})\s?E(\d{1,4})\b\s*[-:–]?\s*/i;

export interface TitleName {
  readonly title: string;
  readonly tags: readonly string[];
  readonly year: number | null;
}

/** "Avatar: The Way of Water 4K (MULTI)" becomes "Avatar: The Way of Water", ["MULTI", "4K"]. */
export function titleName(raw: string, releaseDate: string | null = null): TitleName {
  let text = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  const tags: string[] = [];
  let year: number | null = null;
  for (let changed = true; changed;) {
    changed = false;
    const yearMatch = YEAR.exec(text);
    const found = yearMatch?.[1] ?? yearMatch?.[2];
    if (yearMatch && found && year === null && yearMatch.index > 0) {
      year = Number(found);
      text = text.slice(0, yearMatch.index);
      changed = true;
    }
    const language = LANGUAGE.exec(text);
    if (language?.[1] && language.index > 0) {
      tags.unshift(language[1].toUpperCase().replace(/\s+/, " "));
      text = text.slice(0, language.index);
      changed = true;
    }
  }
  text = text.replace(QUALITY, (tag: string) => {
    const normalized = tag
      .replace(/\./g, "")
      .toUpperCase()
      .replace(/(\d)P$/, "$1p");
    if (!tags.includes(normalized)) tags.push(normalized);
    return " ";
  });
  const title = text
    // Brackets the quality markers left empty, or with only "HD": "Hellboy [720p HD]".
    .replace(/[([]\s*(?:F?HD|SD)?\s*[)\]]/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s|:\-–]+|[\s|:\-–]+$/g, "")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(title)) return { title: raw.trim(), tags: [], year };
  return { title: recase(title), tags, year: year ?? yearOf(releaseDate) };
}

/** "S2 E3". Specials, season 0, are "Special 3". */
export function episodeLabel(season: number, episode: number): string {
  return season === 0 ? `Special ${episode}` : `S${season} E${episode}`;
}

/**
 * An episode's own name: what follows its numbers, "Tbilisi". When nothing does, or only the
 * series name, "Episode 3".
 */
export function episodeName(raw: string, number: number): string {
  const text = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  const match = EPISODE_NUMBER.exec(text);
  const rest = match ? text.slice(match.index + match[0].length).trim() : text;
  return rest && match ? recase(rest) : `Episode ${number}`;
}

function yearOf(date: string | null): number | null {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year >= 1880 && year <= 2200 ? year : null;
}
