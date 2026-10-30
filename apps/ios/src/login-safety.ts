// Whether text the app keeps on disk could give a subscription's login away. The saved copies of
// lists use it to keep artwork addresses that may carry the login out of their files, and to leave
// out what holds the password anywhere else. Pure: nothing here reads or writes a file.

/** The longest artwork address kept. */
export const URL_LENGTH = 2048;

/** How many layers of encoding, or addresses within addresses, are looked through. */
const LAYERS = 4;

/**
 * A subscription's login as `exposes` looks for it: an Xtream account's username and password,
 * or the user and secrets a playlist link names.
 */
export type Login = { readonly username: string; readonly passwords: readonly string[] };

/** A Source's login parts, `[username, ...passwords]`, as the checks here read them. */
export const loginFrom = ([username = "", ...passwords]: readonly string[]): Login => ({
  username,
  passwords: passwords.filter(Boolean),
});

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/**
 * `url` when the disk may keep it: an http(s) address of at most 2048 characters that doesn't
 * give the login away (`exposes`). Otherwise null.
 */
export function safeUrl(url: string | null, login: Login): string | null {
  if (url === null || url.length > URL_LENGTH) return null;
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  return exposes(url, login, LAYERS, parsed) ? null : url;
}

/**
 * Whether `text`, an address or a part of one, gives the login away: it is the username, or
 * holds the password, as written or decoded as percent or form encoding ("+" a space) spells it,
 * and so on for `layers` more decodings; an address within it, such as an image proxy's, counts
 * with its own login, path parts, fragment, and query names and values. Text that won't decode,
 * or still decodes or holds an address after the last layer, counts as giving it away.
 */
export function exposes(
  text: string,
  login: Login,
  layers = LAYERS,
  address = text.includes(":") ? URL.parse(text) : null,
): boolean {
  const { username, passwords } = login;
  if ((username !== "" && text === username) || passwords.some((each) => text.includes(each))) {
    return true;
  }
  const next = new Set([decoded(text), decoded(text.replaceAll("+", " "))]);
  next.delete(text);
  if (!address && next.size === 0) return false;
  if (layers === 0 || next.has(null)) return true;
  if (address && (address.username !== "" || address.password !== "")) return true;
  const parts = address
    ? [address.hash.slice(1), ...address.pathname.split("/"), ...[...address.searchParams].flat()]
    : [];
  return [...parts, ...next].some((part) => part !== null && exposes(part, login, layers - 1));
}

/**
 * Whether a text within `value`, a copied row, holds any of `passwords`, as written or decoded as
 * percent or form encoding ("+" a space) spells it, and so on for `LAYERS` more decodings. Text that
 * still decodes after the last counts as holding one. Artwork kept has none.
 */
export function holds(value: unknown, passwords: readonly string[]): boolean {
  if (typeof value === "string") return passwords.length > 0 && textHolds(value, passwords);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).some((each: unknown) => holds(each, passwords))
  );
}

function textHolds(text: string, passwords: readonly string[]): boolean {
  const forms = new Set([text]);
  for (let layer = [text], times = 0; ; times++) {
    if (layer.some((form) => passwords.some((each) => form.includes(each)))) return true;
    const next = new Set<string>();
    // Only text with an escape or a "+" reads otherwise decoded.
    for (const form of layer.filter((each) => /[%+]/.test(each))) {
      for (const read of [unescaped(form), unescaped(form.replaceAll("+", " "))])
        if (!forms.has(read)) next.add(read);
    }
    if (next.size === 0) return false;
    if (times === LAYERS) return true;
    for (const form of next) forms.add(form);
    layer = [...next];
  }
}

const utf8 = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });

/**
 * `text` with each run of percent escapes read as UTF-8, as prose holds them: bytes that are no
 * UTF-8 read as U+FFFD, and a "%" that escapes nothing stays, as in "100%".
 */
const unescaped = (text: string) =>
  text.replace(/(?:%[\da-f]{2})+/gi, (run) =>
    utf8.decode(Uint8Array.from(run.slice(1).split("%"), (hex) => Number.parseInt(hex, 16))),
  );
