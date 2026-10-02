// HLS through the loopback proxy. The player only ever sees the proxy: each playlist it loads has
// its addresses, variants, segments, keys and the rest, replaced by proxy addresses that stand for
// them, so a login or token in them stays in the main process and every request carries the
// headers the channel asks for.

/**
 * Segment addresses a session keeps for the player to ask for, at most this many: the oldest go
 * first. Broadcasters' playlists can list two hours of segments, 3,600 in each of the sound's and
 * the picture's.
 */
const KEPT = 10_000;
/** Playlists a multivariant playlist names, kept for the whole session, at most this many. */
const PINNED = 500;

/**
 * The upstream addresses a session's playlists named, by the id that stands for each in a proxy
 * address. The same address keeps its id while it is kept. The variants and renditions of a
 * multivariant playlist stay for the session, so the player can switch to one hours later; of the
 * rest, the oldest go first, as segments scroll out of the live window. A playlist reloaded every
 * few seconds names thousands of addresses it named before, so finding one costs one lookup.
 */
export function hlsAddresses(kept = KEPT) {
  const ids = new Map<string, string>();
  const addresses = new Map<string, string>();
  const pinned = new Set<string>();
  let next = 0;

  return {
    /** The id that stands for `address`, new or kept; `pin` keeps it for the session. */
    idOf(address: string, pin = false): string {
      const known = ids.get(address);
      const id = known ?? (next++).toString(36);
      if (pin && pinned.size < PINNED) pinned.add(id);
      if (known !== undefined) return known;
      ids.set(address, id);
      addresses.set(id, address);
      for (const [oldest, oldId] of ids) {
        if (ids.size - pinned.size <= kept) break;
        if (pinned.has(oldId)) continue;
        ids.delete(oldest);
        addresses.delete(oldId);
      }
      return id;
    },
    /** The address `id` stands for, or undefined once it went. */
    addressOf: (id: string): string | undefined => addresses.get(id),
  };
}

/** Whether a playlist is multivariant: it names variants or renditions, other playlists. */
export function isMultivariant(playlist: string): boolean {
  return /^#EXT-X-(STREAM-INF|MEDIA|I-FRAME-STREAM-INF):/m.test(playlist);
}

/** How many first bytes of a response `startsPlaylist` needs, unless the response is shorter. */
export const PLAYLIST_START = 64;

/** Whether a response's first bytes start a playlist: "#EXTM3U", after any byte order mark. */
export function startsPlaylist(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes.subarray(0, PLAYLIST_START)).trimStart();
  return text.startsWith("#EXTM3U");
}

/**
 * `playlist` with every address in it, relative to `base` or not, replaced by what `proxied`
 * gives for it: the lines that name a variant or a segment, and the URI attributes of tags such
 * as #EXT-X-KEY, #EXT-X-MAP and #EXT-X-MEDIA. Addresses other than http(s), such as a key's
 * `data:` URI, stay as they are.
 */
export function rewritePlaylist(
  playlist: string,
  base: string,
  proxied: (address: string) => string,
): string {
  const replace = (address: string) => {
    const absolute = URL.parse(address.trim(), base);
    return absolute && (absolute.protocol === "http:" || absolute.protocol === "https:")
      ? proxied(absolute.href)
      : address;
  };
  return playlist
    .split(/\r\n|\r|\n/)
    .map((line) => {
      if (line.startsWith("#")) {
        return line.replace(
          /URI="([^"]*)"/g,
          (_match, address: string) => `URI="${replace(address)}"`,
        );
      }
      return line.trim() ? replace(line) : line;
    })
    .join("\n");
}
