// What a TV's player reads from the address it is sent, for the scripts that stand in for a TV.

/** A segment of a stream: where it starts, in seconds from the playlist's first, and how long. */
export interface TvSegment {
  readonly start: number;
  readonly length: number;
  readonly url: string;
}

/**
 * The segments of the stream at `address`, read from its playlists with `get`. A title's playlist
 * names its picture's; a channel's lists its segments itself.
 */
export async function segmentsOf(
  address: string,
  get: (url: string) => Promise<Buffer | null>,
): Promise<TvSegment[]> {
  const first = (await get(address))?.toString() ?? "";
  const named = first.split("\n").find((line) => line && !line.startsWith("#"));
  const list = first.includes("#EXTINF") || !named ? address : new URL(named.trim(), address).href;
  const text = list === address ? first : ((await get(list))?.toString() ?? "");
  let start = 0;
  let length = 0;
  const segments: TvSegment[] = [];
  for (const line of text.split("\n")) {
    const info = /^#EXTINF:([\d.]+)/.exec(line);
    if (info) length = Number(info[1]);
    else if (line && !line.startsWith("#")) {
      segments.push({ start, length, url: new URL(line.trim(), list).href });
      start += length;
    }
  }
  return segments;
}
