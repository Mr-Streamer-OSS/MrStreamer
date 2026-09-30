// Reads a large JSON list one row at a time, so a list of tens of megabytes never stalls the
// process that reads it. Providers send lists as an array of objects, `[{...}, {...}]`, or as an
// object keyed by index, `{"0": {...}, "1": {...}}`; both give the same rows. Each row is parsed
// on its own, and reading pauses for the event loop every few milliseconds of work.

/** How long reading may hold the event loop before it lets other work run. */
const SLICE_MS = 8;

/**
 * The objects of a top-level JSON array or object, in order, as `chunks` arrive. Values that are
 * not objects are skipped, and `null` gives no rows. Throws `SyntaxError` when the text isn't an
 * array or object, such as an error page, when it ends before the list closes, or when a row is not
 * valid JSON.
 */
export async function* jsonRows(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  /** Text of a row that started in an earlier chunk. */
  let partial = "";
  /** Inside an object at the second level: a row. */
  let inRow = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  /** The top-level array or object has opened. */
  let opened = false;
  let sliceStart = performance.now();

  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    let rowStart = inRow ? 0 : -1;
    const rows: string[] = [];
    for (let index = 0; index < text.length; index++) {
      const char = text.charCodeAt(index);
      if (inString) {
        if (escaped) escaped = false;
        else if (char === BACKSLASH) escaped = true;
        else if (char === QUOTE) inString = false;
      } else if (!opened && !isSpace(char)) {
        // Some panels send `null` for an empty list, as the live lists allow.
        if (text.startsWith("null", index)) {
          opened = true;
          index += 3;
          continue;
        }
        if (char !== OPEN_BRACE && char !== OPEN_BRACKET) {
          throw new SyntaxError("The answer isn't a JSON list.");
        }
        opened = true;
        depth++;
      } else if (char === QUOTE) {
        inString = true;
      } else if (char === OPEN_BRACE || char === OPEN_BRACKET) {
        depth++;
        if (depth === 2 && char === OPEN_BRACE) {
          inRow = true;
          rowStart = index;
        }
      } else if (char === CLOSE_BRACE || char === CLOSE_BRACKET) {
        if (depth === 2 && inRow) {
          rows.push(partial + text.slice(rowStart, index + 1));
          partial = "";
          inRow = false;
          rowStart = -1;
        }
        depth--;
      }
    }
    if (inRow) partial += text.slice(rowStart);
    for (const row of rows) {
      yield JSON.parse(row);
      if (performance.now() - sliceStart > SLICE_MS) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
  }
  if (!opened || depth > 0) throw new SyntaxError("The list ended before it was complete.");
}

/** JSON whitespace, and the byte order mark some servers put first. */
function isSpace(char: number): boolean {
  return char === 0x20 || char === 0x0a || char === 0x0d || char === 0x09 || char === 0xfeff;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
