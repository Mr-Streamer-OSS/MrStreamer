// Reads the channels and programmes of an XMLTV document as it arrives, without holding the whole
// document.
//
// Providers generate XMLTV with many tools, so the reader takes what they send: attributes in any
// order and either quote style, CDATA, character references, several titles (the first counts)
// and times with or without an offset. A programme it can't read is skipped, never the document.
//
// It also says whether the document is one: `<tv>` as its one outermost element, opened and
// closed again. For that it tells markup from text as XML does. What a comment or a CDATA section
// holds is text, also where it reads `</tv>` or `</programme>`, and `</tvirus>` ends another
// element.
//
// It reads the text and nothing else. A DOCTYPE is passed over and the only references it knows
// are the five XML defines and numbered characters, so a document can't make it fetch or read
// anything.
import { AppFailure } from "@mrstreamer/contracts/errors";

/** A programme as the document lists it. */
export interface XmltvProgramme {
  /** The guide channel id, which catalogues refer to as the channel's guide id. */
  readonly channel: string;
  /** Epoch milliseconds. */
  readonly start: number;
  /** Epoch milliseconds, or null when the document leaves it out. */
  readonly stop: number | null;
  readonly title: string;
  readonly description: string | null;
}

/** A channel as the document lists it. */
export interface XmltvChannel {
  /** The id its programmes name it by. */
  readonly id: string;
  /** Its first display name, or null when it has none. */
  readonly name: string | null;
}

/**
 * How a document stood once all of it was read: `whole`, from `<tv>` to `</tv>` with nothing
 * else around them; `incomplete`, when a `<tv>` it opened never closed; or `not-xmltv`, when it
 * never opened one, or has an element outside it.
 */
export type XmltvEnding = "whole" | "incomplete" | "not-xmltv";

const PROGRAMME = { open: Buffer.from("<programme"), close: Buffer.from("</programme>") };
const CHANNEL = { open: Buffer.from("<channel"), close: Buffer.from("</channel>") };
/** What holds text that is no markup, whatever it reads as: a comment and a CDATA section. */
const QUOTED = [
  { open: Buffer.from("<!--"), close: Buffer.from("-->") },
  { open: Buffer.from("<![CDATA["), close: Buffer.from("]]>") },
];
const ROOT = Buffer.from("<tv");
const ROOT_END = Buffer.from("</tv");
/** How a comment, a CDATA section and a DOCTYPE all begin. */
const DECLARATION = Buffer.from("<!");
const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;

/**
 * Feeds an XMLTV document through in chunks of any size. Each `push` hands `found` the channels
 * and programmes that chunk completed; one split across chunks comes with the chunk that ends
 * it. `end` says, after the last chunk, how the document stood.
 *
 * It searches the bytes and decodes one element at a time, so the strings it hands on hold only
 * their element's text, not the chunk they arrived in. An element longer than `maxElementBytes`
 * fails the document with `too-large`: nothing of it is read past that.
 */
export function xmltvReader(
  found: {
    programme(entry: XmltvProgramme): void;
    channel(entry: XmltvChannel): void;
  },
  maxElementBytes: number,
): {
  push(chunk: Uint8Array): void;
  end(): XmltvEnding;
} {
  const decoder = new TextDecoder("utf-8");
  let buffer: Buffer = Buffer.alloc(0);
  /** How many `<tv>` are open, and whether one ever was. */
  let depth = 0;
  let opened = false;
  /** Whether an element stood outside the document's `<tv>`: before it, after it, or without it. */
  let outside = false;
  /** What ends the comment or CDATA section being passed over, while one is. */
  let passing: Buffer | null = null;

  const elements = [
    {
      ...PROGRAMME,
      read(attributes: string, body: string | null) {
        const entry = body === null ? null : programmeOf(attributes, body);
        if (entry) found.programme(entry);
      },
    },
    {
      ...CHANNEL,
      read(attributes: string, body: string | null) {
        const entry = channelOf(attributes, body);
        if (entry) found.channel(entry);
      },
    },
  ];

  /** Whether the bytes at `at` are `tag`; null while too few of them have arrived to tell. */
  const startsWith = (at: number, tag: Buffer): boolean | null => {
    const have = Math.min(tag.length, buffer.length - at);
    if (buffer.compare(tag, 0, have, at, at + have) !== 0) return false;
    return have === tag.length ? true : null;
  };
  /**
   * Whether an element named by `open` starts at `at`: its name ends there, so `<programmes>` is
   * not a `<programme>`. Null while its next byte hasn't arrived.
   */
  const opens = (at: number, open: Buffer): boolean | null => {
    const named = startsWith(at, open);
    if (named !== true) return named;
    const next = buffer[at + open.length];
    if (next === undefined) return null;
    return next === GT || next === SLASH || next <= 0x20;
  };
  /**
   * Where the `</tv>` at `at` ends, with nothing but space before its `>`; false when anything
   * else stands there, as `</tvirus>` does. Null while the rest of it hasn't arrived.
   */
  const rootEnd = (at: number): number | false | null => {
    const named = startsWith(at, ROOT_END);
    if (named !== true) return named;
    let end = at + ROOT_END.length;
    while ((buffer[end] ?? GT) <= 0x20) end++;
    const last = buffer[end];
    if (last === undefined) return null;
    return last === GT && end + 1;
  };

  /**
   * Where `close` ends the element whose text begins at `from`: at its first that isn't text in a
   * comment or a CDATA section. -1 while it hasn't arrived.
   */
  const closeOf = (from: number, close: Buffer): number => {
    for (;;) {
      const closeAt = buffer.indexOf(close, from);
      if (closeAt === -1) return -1;
      const declared = buffer.subarray(from, closeAt).indexOf(DECLARATION);
      if (declared === -1) return closeAt;
      const at = from + declared;
      const quoted = QUOTED.find(({ open }) => startsWith(at, open));
      if (!quoted) {
        from = at + DECLARATION.length;
        continue;
      }
      const end = buffer.indexOf(quoted.close, at + quoted.open.length);
      if (end === -1) return -1;
      from = end + quoted.close.length;
    }
  };

  /**
   * Reads the element that starts at `at`, and answers where the text after it begins; null
   * while it is still arriving.
   */
  const element = (at: number, { open, close, read }: (typeof elements)[number]): number | null => {
    const tagEnd = buffer.indexOf(GT, at);
    if (tagEnd === -1) return null;
    // An empty element, <programme/>, has nothing in it.
    const empty = buffer[tagEnd - 1] === SLASH;
    const closeAt = empty ? tagEnd : closeOf(tagEnd + 1, close);
    if (closeAt === -1) return null;
    const end = empty ? tagEnd + 1 : closeAt + close.length;
    if (end - at > maxElementBytes) throw tooLarge();
    read(
      decoder.decode(buffer.subarray(at + open.length, empty ? tagEnd - 1 : tagEnd)),
      empty ? null : decoder.decode(buffer.subarray(tagEnd + 1, closeAt)),
    );
    return end;
  };

  /**
   * Takes in what the `<` at `at` begins, and answers where to read on from; null while too
   * little of it has arrived to tell what it is.
   */
  const take = (at: number): number | null => {
    for (const kind of elements) {
      const here = opens(at, kind.open);
      if (here === null) return null;
      if (!here) continue;
      if (depth === 0) outside = true;
      return element(at, kind);
    }
    for (const { open, close } of QUOTED) {
      const here = startsWith(at, open);
      if (here === null) return null;
      if (!here) continue;
      passing = close;
      return at + open.length;
    }
    const begins = opens(at, ROOT);
    if (begins === null) return null;
    if (begins) {
      const tagEnd = buffer.indexOf(GT, at);
      if (tagEnd === -1) return null;
      // A document has one: a second, once the first closed, stands outside it.
      if (opened && depth === 0) outside = true;
      opened = true;
      // <tv/> is a document with nothing in it.
      if (buffer[tagEnd - 1] !== SLASH) depth++;
      return tagEnd + 1;
    }
    const ends = rootEnd(at);
    if (ends === null) return null;
    if (ends && depth > 0) {
      depth--;
      return ends;
    }
    // Any other tag. Outside `<tv>` only a declaration may stand, as <?xml ?> and <!DOCTYPE>.
    const next = buffer[at + 1];
    if (depth === 0 && next !== BANG && next !== QUESTION) outside = true;
    return at + 1;
  };

  return {
    push(chunk) {
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      buffer = buffer.length > 0 ? Buffer.concat([buffer, bytes]) : bytes;
      let from = 0;
      for (;;) {
        if (passing) {
          const end = buffer.indexOf(passing, from);
          if (end === -1) {
            // Its end may have begun: that much stays for the next chunk.
            from = Math.max(from, buffer.length - passing.length + 1);
            break;
          }
          from = end + passing.length;
          passing = null;
        }
        const at = buffer.indexOf(LT, from);
        const next = at === -1 ? null : take(at);
        // The rest of it comes with a later chunk.
        if (next === null) {
          from = at === -1 ? buffer.length : at;
          break;
        }
        from = next;
      }
      buffer = buffer.subarray(from);
      // What waits for its end, an element or a tag, is no longer than an element may be.
      if (buffer.length > maxElementBytes) throw tooLarge();
    },
    end: () => (!opened || outside ? "not-xmltv" : depth > 0 ? "incomplete" : "whole"),
  };
}

function tooLarge(): AppFailure {
  return new AppFailure({ kind: "guide", failure: { kind: "too-large", limit: "element" } });
}

const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TITLE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/;
const DESCRIPTION = /<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc>/;
const DISPLAY_NAME = /<display-name(?:\s[^>]*)?>([\s\S]*?)<\/display-name>/;

function attributesOf(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    values.set(match[1] ?? "", decode(match[2] ?? match[3] ?? ""));
  }
  return values;
}

function programmeOf(attributes: string, body: string): XmltvProgramme | null {
  const values = attributesOf(attributes);
  const channel = values.get("channel")?.trim();
  const start = time(values.get("start"));
  const stop = time(values.get("stop"));
  const title = text(TITLE.exec(body)?.[1]);
  if (!channel || start === null || !title || (stop !== null && stop <= start)) return null;
  return { channel, start, stop, title, description: text(DESCRIPTION.exec(body)?.[1]) };
}

function channelOf(attributes: string, body: string | null): XmltvChannel | null {
  const id = attributesOf(attributes).get("id")?.trim();
  if (!id) return null;
  return { id, name: body === null ? null : text(DISPLAY_NAME.exec(body)?.[1]) };
}

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

/** Element text: CDATA as written, everything else with references decoded and tags dropped. */
function text(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let result = "";
  let last = 0;
  for (const match of raw.matchAll(CDATA)) {
    result += decode(raw.slice(last, match.index).replace(/<[^>]*>/g, "")) + (match[1] ?? "");
    last = match.index + match[0].length;
  }
  result += decode(raw.slice(last).replace(/<[^>]*>/g, ""));
  return result.replace(/\s+/g, " ").trim() || null;
}

const REFERENCE = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi;
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(value: string): string {
  return value.replace(REFERENCE, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    const code = decimal ? Number(decimal) : Number.parseInt(hex ?? "", 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * "20260930083000 +0200", with the seconds and the offset optional. The offset says how far the
 * written time is ahead of UTC, so each time stands on its own: a guide that changes from +0200
 * to +0100 as summer time ends reads right on both sides. No offset means UTC.
 */
const TIME = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?/;

function time(value: string | undefined): number | null {
  const match = value ? TIME.exec(value) : null;
  if (!match) return null;
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match;
  const parts = [year, month, day, hour, minute, second ?? "0"].map(Number);
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = parts;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const offset = sign
    ? (sign === "-" ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes))
    : 0;
  return Date.UTC(y, mo - 1, d, h, mi, s) - offset * 60_000;
}
