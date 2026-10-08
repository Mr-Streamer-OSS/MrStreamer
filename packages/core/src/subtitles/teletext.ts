// Teletext subtitles (ETS 300 706), as DVB carries them (EN 300 472): each PES packet holds data
// units of one teletext packet each, a page header or one of its rows. Subtitle pages show only
// their boxed text. Characters come from the Latin set with the page's national option, and
// enhancement packets (X/26) add the accented letters the national options lack.
import type { SubtitleChange } from "./screen.ts";

/** The 40-byte rows of a page, by row number; row 0 is the header. */
type Rows = Map<number, Uint8Array>;

interface Page {
  rows: Rows;
  /** Characters with a diacritic or from the supplementary set, by row and column. */
  readonly enhanced: Map<number, string>;
  national: number;
  subtitle: boolean;
  /** Whether a row or the header arrived since the page was last shown. */
  touched: boolean;
}

/**
 * Decodes teletext page `page`, 888 for page 88 of magazine 8, or the first subtitle page that
 * arrives when null. Feed it each PES packet's payload with its time; it answers with the text
 * the page shows from then on whenever that changes.
 */
export function teletextDecoder(page: number | null) {
  let wanted = page === null ? null : pageAddress(page);
  let current: Page | null = null;
  /** The page each magazine is sending now: rows that follow a header belong to it. */
  const sending = new Map<number, number>();
  let shown: string | null = null;

  /** The text on screen when it changed since it was last shown. */
  function show(at: number): SubtitleChange | null {
    if (!current?.touched) return null;
    current.touched = false;
    const lines = pageText(current);
    const text = lines.join("\n");
    if (text === shown) return null;
    shown = text;
    return { at, until: null, screen: { kind: "text", lines } };
  }

  return {
    push(payload: Uint8Array, at: number): SubtitleChange | null {
      for (const data of teletextPackets(payload)) packet(data);
      return show(at);
    },
  };

  function packet(data: Uint8Array): void {
    const address = unham(data[0]!) | (unham(data[1]!) << 4);
    if (address < 0) return;
    const magazine = address & 0x07 || 8;
    const row = address >> 3;
    const body = data.subarray(2);
    if (row === 0) {
      header(magazine, body);
      return;
    }
    if (current === null || sending.get(magazine) !== wanted) return;
    if (row <= 24) {
      current.rows.set(row, body.slice());
      current.touched = true;
    } else if (row === 26) enhance(current, body);
  }

  function header(magazine: number, body: Uint8Array): void {
    const units = unham(body[0]!);
    const tens = unham(body[1]!);
    const control = [3, 5, 6, 7].map((index) => unham(body[index]!));
    if (units < 0 || tens < 0 || control.some((bits) => bits < 0)) return;
    const address = magazine * 0x100 + (tens << 4) + units;
    const [c4, c5c6, , c11to14] = control as [number, number, number, number];
    const subtitle = (c5c6 & 0x08) !== 0;
    // Time filling headers (page FF) end the page before without starting one.
    if (tens === 0x0f && units === 0x0f) {
      sending.delete(magazine);
      return;
    }
    if (wanted === null && subtitle) wanted = address;
    sending.set(magazine, address);
    if (address !== wanted) return;
    const national = (c11to14 >> 1) & 0x07;
    if (!current || (c4 & 0x08) !== 0) {
      // Erase page: the rows that follow replace all of it.
      current = { rows: new Map(), enhanced: new Map(), national, subtitle, touched: true };
    } else {
      current.national = national;
      current.subtitle = subtitle;
      current.touched = true;
    }
  }
}

/**
 * Whether a PES payload holds page `page`'s header with the erase flag, after which the page is
 * only what follows: a decoder that begins there shows what one that read the whole stream shows.
 */
export function teletextErases(payload: Uint8Array, page: number): boolean {
  const wanted = pageAddress(page);
  for (const data of teletextPackets(payload)) {
    const address = unham(data[0]!) | (unham(data[1]!) << 4);
    const [units, tens, erase] = [unham(data[2]!), unham(data[3]!), unham(data[5]!)];
    if (
      address >= 0 &&
      address >> 3 === 0 &&
      units >= 0 &&
      tens >= 0 &&
      erase >= 0 &&
      (address & 0x07 || 8) * 0x100 + (tens << 4) + units === wanted &&
      (erase & 0x08) !== 0
    )
      return true;
  }
  return false;
}

/**
 * A declared subtitle page is present once its valid header arrives, even while blank.
 * Page FF is time filling, never proof. This reads addresses only, without decoding text.
 */
export function teletextPagePresent(payload: Uint8Array, page: number | null): boolean {
  for (const data of teletextPackets(payload)) {
    const address = unham(data[0]!) | (unham(data[1]!) << 4);
    const units = unham(data[2]!);
    const tens = unham(data[3]!);
    const control = [5, 7, 8, 9].map((index) => unham(data[index]!));
    if (
      address < 0 ||
      address >> 3 !== 0 ||
      units < 0 ||
      tens < 0 ||
      control.some((bits) => bits < 0)
    )
      continue;
    if (units === 15 && tens === 15) continue;
    const received = (address & 0x07 || 8) * 0x100 + (tens << 4) + units;
    if (page === null ? (control[1]! & 0x08) !== 0 : received === pageAddress(page)) return true;
  }
  return false;
}

/** Complete EBU teletext packets, with the transmitted bit order corrected. */
function* teletextPackets(payload: Uint8Array): Generator<Uint8Array> {
  if (payload.length < 1 || payload[0]! < 0x10 || payload[0]! > 0x1f) return;
  for (let offset = 1; offset + 2 <= payload.length;) {
    const id = payload[offset]!;
    const length = payload[offset + 1]!;
    if ((id === 0x02 || id === 0x03) && length === 0x2c && offset + 2 + length <= payload.length) {
      yield payload.subarray(offset + 4, offset + 46).map(reverse);
    }
    offset += 2 + length;
  }
}

/** Page 888 as its address: magazine 8, page 0x88. */
function pageAddress(page: number): number {
  const magazine = Math.floor(page / 100);
  const number = page % 100;
  return (magazine === 0 ? 8 : magazine) * 0x100 + Math.floor(number / 10) * 0x10 + (number % 10);
}

/**
 * The lines a page shows. A subtitle page shows only boxed text, between Start Box and End Box;
 * a page with no box at all shows everything. A double-height row covers the row below it.
 */
function pageText(page: Page): string[] {
  const rows = [...page.rows.keys()].filter((row) => row > 0 && row < 25).sort((a, b) => a - b);
  const read = (boxedOnly: boolean) => {
    const lines: string[] = [];
    let covered = -1;
    for (const row of rows) {
      if (row === covered) continue;
      const cells = page.rows.get(row)!;
      let boxed = false;
      let text = "";
      for (let column = 0; column < 40; column++) {
        const byte = cells[column]!;
        const code = oddParity(byte) ? byte & 0x7f : 0x20;
        // Spacing attributes show as spaces; Start Box and End Box act from the next cell.
        if (code < 0x20) {
          if (boxedOnly ? boxed : true) text += " ";
          if (code === 0x0b) boxed = true;
          if (code === 0x0a) boxed = false;
          if (code === 0x0d) covered = row + 1;
          continue;
        }
        if (boxedOnly && !boxed) continue;
        text += page.enhanced.get(row * 40 + column) ?? character(code, page.national);
      }
      const line = text.replace(/\s+/g, " ").trim();
      if (line) lines.push(line);
    }
    return lines;
  };
  const boxed = read(true);
  return boxed.length > 0 || !page.subtitle ? boxed : read(false);
}

/** National option subsets of the Latin set (ETS 300 706, table 36), by C12 + 2 C13 + 4 C14. */
// prettier-ignore
const NATIONAL: readonly (readonly string[])[] = [
  ["£", "$", "@", "←", "½", "→", "↑", "#", "—", "¼", "‖", "¾", "÷"], // English
  ["é", "ï", "à", "ë", "ê", "ù", "î", "#", "è", "â", "ô", "û", "ç"], // French
  ["#", "¤", "É", "Ä", "Ö", "Å", "Ü", "_", "é", "ä", "ö", "å", "ü"], // Swedish, Finnish, Hungarian
  ["#", "ů", "č", "ť", "ž", "ý", "í", "ř", "é", "á", "ě", "ú", "š"], // Czech, Slovak
  ["#", "$", "§", "Ä", "Ö", "Ü", "^", "_", "°", "ä", "ö", "ü", "ß"], // German
  ["ç", "$", "¡", "á", "é", "í", "ó", "ú", "¿", "ü", "ñ", "è", "à"], // Portuguese, Spanish
  ["£", "$", "é", "°", "ç", "→", "↑", "#", "ù", "à", "ò", "è", "ì"], // Italian
  ["#", "$", "@", "[", "\\", "]", "^", "_", "`", "{", "|", "}", "~"], // none
];
/** Where in the set the national characters go. */
const NATIONAL_CODES = [
  0x23, 0x24, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x7b, 0x7c, 0x7d, 0x7e,
];

function character(code: number, national: number): string {
  const position = NATIONAL_CODES.indexOf(code);
  if (position >= 0) return NATIONAL[national]?.[position] ?? String.fromCharCode(code);
  return code === 0x7f ? "■" : String.fromCharCode(code);
}

/** Combining marks for the G2 diacritics, 1 to 15. */
const DIACRITICS = ["", "̀", "́", "̂", "̃", "̄", "̆", "̇", "̈", "̣", "̊", "̧", "̲", "̋", "̨", "̌"];

/**
 * Packet X/26: triplets that place characters with a diacritic, or from the supplementary set,
 * at a row and column. Only these are read; colours and graphics aren't shown.
 */
function enhance(page: Page, body: Uint8Array): void {
  let row = 0;
  for (let index = 1; index + 3 <= 40; index += 3) {
    const triplet = unham24(body[index]!, body[index + 1]!, body[index + 2]!);
    if (triplet < 0) continue;
    const address = triplet & 0x3f;
    const mode = (triplet >> 6) & 0x1f;
    const data = triplet >> 11;
    if (address >= 40) {
      // Set active position, or the termination marker.
      if (mode === 0x04) row = address === 40 ? 24 : address - 40;
      if (mode === 0x1f) break;
      continue;
    }
    if (mode === 0x0f && data >= 0x20) {
      page.enhanced.set(row * 40 + address, supplementary(data));
    } else if (mode >= 0x10 && data >= 0x20) {
      const base = data === 0x2a ? "@" : String.fromCharCode(data);
      page.enhanced.set(row * 40 + address, (base + DIACRITICS[mode & 0x0f]).normalize("NFC"));
    }
  }
}

/** The supplementary (G2 Latin) characters most used in text; others show as themselves. */
function supplementary(code: number): string {
  const set: Readonly<Record<number, string>> = {
    0x21: "¡",
    0x22: "¢",
    0x23: "£",
    0x24: "$",
    0x25: "¥",
    0x26: "#",
    0x27: "§",
    0x28: "¤",
    0x29: "‘",
    0x2a: "“",
    0x2b: "«",
    0x30: "°",
    0x31: "±",
    0x32: "²",
    0x33: "³",
    0x34: "×",
    0x35: "µ",
    0x36: "¶",
    0x37: "·",
    0x38: "÷",
    0x39: "’",
    0x3a: "”",
    0x3b: "»",
    0x3c: "¼",
    0x3d: "½",
    0x3e: "¾",
    0x3f: "¿",
    0x50: "―",
    0x51: "¹",
    0x52: "®",
    0x53: "©",
    0x54: "™",
    0x55: "♪",
    0x56: "₠",
    0x57: "‰",
    0x58: "α",
    0x5c: "⅛",
    0x5d: "⅜",
    0x5e: "⅝",
    0x5f: "⅞",
    0x60: "Ω",
    0x61: "Æ",
    0x62: "Đ",
    0x63: "ª",
    0x64: "Ħ",
    0x66: "Ĳ",
    0x67: "Ŀ",
    0x68: "Ł",
    0x69: "Ø",
    0x6a: "Œ",
    0x6b: "º",
    0x6c: "Þ",
    0x6d: "Ŧ",
    0x6e: "Ŋ",
    0x6f: "ŉ",
    0x70: "ĸ",
    0x71: "æ",
    0x72: "đ",
    0x73: "ð",
    0x74: "ħ",
    0x75: "ı",
    0x76: "ĳ",
    0x77: "ŀ",
    0x78: "ł",
    0x79: "ø",
    0x7a: "œ",
    0x7b: "ß",
    0x7c: "þ",
    0x7d: "ŧ",
    0x7e: "ŋ",
  };
  return set[code] ?? String.fromCharCode(code);
}

/** Hamming 8/4 code words, by the value they carry. */
const HAMMING = [
  0x15, 0x02, 0x49, 0x5e, 0x64, 0x73, 0x38, 0x2f, 0xd0, 0xc7, 0x8c, 0x9b, 0xa1, 0xb6, 0xfd, 0xea,
];
/** Each byte's value, corrected when one bit is wrong; -1 when two are. */
const UNHAM = Array.from({ length: 256 }, (_, byte) => {
  for (let value = 0; value < 16; value++) {
    if (bitCount(byte ^ HAMMING[value]!) <= 1) return value;
  }
  return -1;
});

function unham(byte: number): number {
  return UNHAM[byte]!;
}

/** The 18 data bits of a Hamming 24/18 triplet, least significant first; -1 when it fails parity. */
function unham24(a: number, b: number, c: number): number {
  const bits = a | (b << 8) | (c << 16);
  if (bitCount(bits) % 2 === 0) return -1;
  return (
    ((bits >> 2) & 0x01) | ((bits >> 3) & 0x0e) | ((bits >> 4) & 0x7f0) | ((bits >> 5) & 0x3f800)
  );
}

function oddParity(byte: number): boolean {
  return bitCount(byte) % 2 === 1;
}

function bitCount(value: number): number {
  let count = 0;
  for (let rest = value; rest; rest &= rest - 1) count++;
  return count;
}

/** DVB sends each teletext byte with its bits in the opposite order. */
function reverse(byte: number): number {
  let out = 0;
  for (let bit = 0; bit < 8; bit++) out |= ((byte >> bit) & 1) << (7 - bit);
  return out;
}
