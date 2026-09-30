// Reads programmes from an XMLTV document as it arrives, without holding the whole document.
//
// Providers generate XMLTV with many tools, so the reader takes what they send: attributes in any
// order and either quote style, CDATA, character references, several titles (the first counts)
// and times with or without an offset. A programme it can't read is skipped, never the document.

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

const OPEN = "<programme";
const CLOSE = "</programme>";

/**
 * Feeds an XMLTV document through in chunks of any size. Each `push` returns the programmes that
 * chunk completed; a programme split across chunks comes out with the chunk that ends it.
 *
 * It searches the bytes and decodes one programme at a time, so the strings it returns hold only
 * their programme's text, not the chunk they arrived in.
 */
export function xmltvReader(): { push(chunk: Uint8Array): XmltvProgramme[] } {
  const decoder = new TextDecoder("utf-8");
  let buffer: Buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      buffer = buffer.length > 0 ? Buffer.concat([buffer, bytes]) : bytes;
      const found: XmltvProgramme[] = [];
      let from = 0;
      for (;;) {
        const open = buffer.indexOf(OPEN, from);
        if (open === -1) {
          // Keep a tail that could be the start of "<programme".
          from = Math.max(from, buffer.length - OPEN.length + 1);
          break;
        }
        const next = buffer[open + OPEN.length];
        if (next === undefined) {
          from = open;
          break;
        }
        if (next !== 0x3e && next !== 0x2f && next > 0x20) {
          // "<programmes>" or another element that only starts the same way.
          from = open + OPEN.length;
          continue;
        }
        const tagEnd = buffer.indexOf(">", open);
        if (tagEnd === -1) {
          from = open;
          break;
        }
        if (buffer[tagEnd - 1] === 0x2f) {
          // An empty <programme/> has no title.
          from = tagEnd + 1;
          continue;
        }
        const close = buffer.indexOf(CLOSE, tagEnd);
        if (close === -1) {
          from = open;
          break;
        }
        const entry = programme(
          decoder.decode(buffer.subarray(open + OPEN.length, tagEnd)),
          decoder.decode(buffer.subarray(tagEnd + 1, close)),
        );
        if (entry) found.push(entry);
        from = close + CLOSE.length;
      }
      buffer = buffer.subarray(Math.max(0, from));
      return found;
    },
  };
}

const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TITLE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/;
const DESCRIPTION = /<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc>/;

function programme(attributes: string, body: string): XmltvProgramme | null {
  const values = new Map<string, string>();
  for (const match of attributes.matchAll(ATTRIBUTE)) {
    values.set(match[1] ?? "", decode(match[2] ?? match[3] ?? ""));
  }
  const channel = values.get("channel")?.trim();
  const start = time(values.get("start"));
  const stop = time(values.get("stop"));
  const title = text(TITLE.exec(body)?.[1]);
  if (!channel || start === null || !title || (stop !== null && stop <= start)) return null;
  return { channel, start, stop, title, description: text(DESCRIPTION.exec(body)?.[1]) };
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

/** "20260930083000 +0200", with the seconds and the offset optional. No offset means UTC. */
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
