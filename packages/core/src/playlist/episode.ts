// Read one whole episode token. Resolution strings, ranges and multiple episodes stay ambiguous.
export interface PlaylistEpisode {
  readonly series: string;
  readonly season: number;
  readonly episode: number;
}

export function playlistEpisode(name: string): PlaylistEpisode | null {
  const tokens = [
    ...name.matchAll(
      /(?<![\p{L}\p{N}])(?:S(\d{1,2})E(\d{1,3})|(\d{1,2})x(\d{2,3}))(?![\p{L}\p{N}])/giu,
    ),
  ];
  if (tokens.length !== 1) return null;
  const token = tokens[0]!;
  const after = name.slice(token.index + token[0].length);
  // S01E02-E03, 1x02-03, S01E02 & E03 and equivalent multi-episode labels.
  if (/^[\s._-]*(?:[&+,/-]\s*)?(?:E\d|\d{1,3}(?![\p{L}\p{N}]))/iu.test(after)) return null;
  // Trim from the end. An unanchored suffix regex retries a long internal separator run at
  // every position, blocking the playlist import even when that run isn't at the end.
  let end = token.index;
  while (end > 0 && /[\s._|:-]/u.test(name[end - 1]!)) end--;
  const series = name.slice(0, end).trim();
  const season = Number(token[1] ?? token[3]);
  const episode = Number(token[2] ?? token[4]);
  if (!series || episode < 1 || episode > 999 || season > 99) return null;
  return { series, season, episode };
}
