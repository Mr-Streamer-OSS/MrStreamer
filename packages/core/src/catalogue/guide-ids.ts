// Which guide ids to believe. Providers reuse one guide id for unrelated channels: one panel files
// nine Flemish channels, from Dobbit to Ment 55, under PlayCrime.be, so all of them would show
// Play Crime's programmes. The guide's own channel names don't help, because panels copy them
// from their stream list. What remains is the id itself and the channels that share it:
//   - A channel keeps its guide id when its name matches the id: "VRT 1" and VRT1.be, "DAZN Event
//     1" and DAZN1.de.
//   - Otherwise only when every channel sharing the id is the same channel under another name or
//     quality: "NPO 1" and "NPO1", "National Geographic" under NatGeo.nl.
import { normalize } from "../text.ts";

/** The guide id of each channel that can keep one, by channel id. */
export function trustedGuideIds(
  claims: readonly {
    readonly channel: { readonly id: string; readonly title: string };
    readonly guideId: string;
  }[],
): Map<string, string> {
  const namesByGuideId = new Map<string, string[][]>();
  for (const { channel, guideId } of claims) {
    const names = namesByGuideId.get(guideId);
    if (names) names.push(words(channel.title));
    else namesByGuideId.set(guideId, [words(channel.title)]);
  }
  const trusted = new Map<string, string>();
  for (const { channel, guideId } of claims) {
    const name = words(channel.title);
    const sharing = namesByGuideId.get(guideId) ?? [];
    if (alike(name, idWords(guideId)) || sharing.every((other) => alike(other, name))) {
      trusted.set(channel.id, guideId);
    }
  }
  return trusted;
}

function words(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean);
}

/**
 * "SkySportBundesliga1.de" reads as "sky sport bundesliga 1" and "BBCFirst" as "bbc first": the
 * country suffix goes, and words split at case changes and around numbers.
 */
function idWords(guideId: string): string[] {
  const base = guideId.replace(/\.[a-z]{2,3}$/i, "").replaceAll("+", " plus ");
  const split = base.replace(
    /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu,
    " ",
  );
  return words(split);
}

/** Joined names shorter than this only match word for word: "tv1" is not part of "tv100". */
const MIN_JOINED = 4;

/**
 * Whether two names can be the same channel: one runs into the other with spaces ignored ("npo 1"
 * and "npo1"), or the shorter's words start the longer's words in order ("nat geo wild" and
 * "national geographic wild", "sky bundesliga 1" and "wow tv sky sport bundesliga 1"). Numbers
 * must agree, so "ziggo sport 2" and "ziggo sport 3" differ.
 */
function alike(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const joinedShort = short.join("");
  const joinedLong = long.join("");
  if (Math.min(joinedShort.length, joinedLong.length) >= MIN_JOINED) {
    if (joinedLong.includes(joinedShort) || joinedShort.includes(joinedLong)) return true;
  }
  let at = 0;
  for (const word of short) {
    while (at < long.length && !begins(long[at] ?? "", word)) at++;
    if (at === long.length) return false;
    at++;
  }
  return true;
}

/** Numbers match whole; other words may be the start of a longer word, from two letters. */
function begins(word: string, start: string): boolean {
  if (word === start) return true;
  return !/^\d+$/.test(start) && start.length >= 2 && word.startsWith(start);
}
