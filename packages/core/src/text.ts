/** Lowercase, accent-free, with punctuation collapsed to single spaces: "UK: Één HD" becomes "uk een hd". */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A search's words, folded as `normalize` folds text: " Één, HD" becomes "een" and "hd". */
export function searchWords(query: string): string[] {
  return normalize(query).split(" ").filter(Boolean);
}

/**
 * Where a search's `words` show in `text`, as [start, end) pairs in order and apart, for marking
 * what matched. Empty unless every word shows, as a match needs them all.
 */
export function matchRanges(
  text: string,
  words: readonly string[],
): readonly (readonly [start: number, end: number])[] {
  if (words.length === 0) return [];
  // The text folded a character at a time, with where in `text` each folded character came from.
  let folded = "";
  const sources: (readonly [number, number])[] = [];
  for (const { 0: character, index } of text.matchAll(/\P{M}\p{M}*/gu)) {
    // What isn't a letter or a digit folds to nothing: it parts words, as a space does.
    const piece = normalize(character) || " ";
    folded += piece;
    for (let unit = 0; unit < piece.length; unit++) sources.push([index, index + character.length]);
  }
  const found: [number, number][] = [];
  for (const word of words) {
    let at = folded.indexOf(word);
    if (at === -1) return [];
    for (; at !== -1; at = folded.indexOf(word, at + word.length)) {
      const start = sources[at]?.[0];
      const end = sources[at + word.length - 1]?.[1];
      if (start !== undefined && end !== undefined) found.push([start, end]);
    }
  }
  // Words that overlap or touch read as one mark.
  const ranges: [number, number][] = [];
  for (const [start, end] of found.toSorted((a, b) => a[0] - b[0])) {
    const last = ranges.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges;
}
