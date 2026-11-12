// What `pnpm verify:desktop journey <module>` hands a journey module, and the selectors it uses.
// The selectors return DOM expressions for the Driver's `click`, `exists` and `evaluate`.
import type { Driver } from "./language.ts";
import type { FakeProvider } from "../../../../apps/desktop/test/fake-provider.ts";
import type { FakeTmdb } from "../../../../apps/desktop/test/fake-tmdb.ts";
import { isCallable } from "../../../../packages/contracts/src/callable.ts";
import { pathToFileURL } from "node:url";

/**
 * An element's name as a viewer meets it: its aria-label, else its words outside aria-hidden
 * parts (as the initials beside a cast member's name), spaced and trimmed. String.raw keeps the
 * regex's backslashes; a plain template string would drop them.
 */
const NAME = String.raw`(e => {
  const label = e.getAttribute("aria-label");
  const words = n => n.nodeType === 3 ? n.data
    : n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true" ? [...n.childNodes].map(words).join(" ")
    : "";
  return (label ?? words(e)).replace(/\s+/g, " ").trim();
})`;

/**
 * The first `selector` match inside `within` whose name (see NAME) is `name`, or starts with it
 * up to a word's end: "Alan Actor" finds "Alan Actor The Lead", never "Alan Actors".
 */
export const named = (selector: string, name: string, within = "document") =>
  String.raw`[...((${within})?.querySelectorAll(${JSON.stringify(selector)}) ?? [])].find(e => {
    const n = ${NAME}(e), name = ${JSON.stringify(name)};
    return n === name || (n.startsWith(name) && !/[\p{L}\p{N}]/u.test(n[name.length]));
  })`;

/**
 * The first grid poster whose provider name contains `words`. A poster shows TMDB's name
 * ("Original 100000", `tmdbName` in apps/desktop/test/fake-tmdb.ts); the provider's stays in its
 * title. Linked titles' posters have no title: find those by their shown name with `named`.
 */
export const poster = (words: string) =>
  `[...document.querySelectorAll('button[title]')].find(b => b.title.includes(${JSON.stringify(words)}))`;

/** The element with the keyboard, as `button "Alan Actor The Lead"`, or "page". */
export const focused = `(() => {
  const e = document.activeElement;
  if (!e || e === document.body) return "page";
  const name = ${NAME}(e).slice(0, 60);
  return e.tagName.toLowerCase() + (name ? ' "' + name + '"' : "");
})()`;

/** The sheet or dialog on top, for `named`'s `within`, so a page control beneath never matches. */
export const dialog = "[...document.querySelectorAll('[role=dialog]')].at(-1)";

/** The fixtures a journey can count requests on, with the selectors above. */
export type JourneyKit = {
  readonly provider: FakeProvider;
  readonly tmdb: FakeTmdb;
  readonly named: typeof named;
  readonly poster: typeof poster;
  readonly dialog: typeof dialog;
  readonly focused: typeof focused;
};

/**
 * A journey module's default export. It starts logged in on the fake provider, with fake TMDB, and
 * imports nothing at runtime (type imports only), so it resolves no package from where it lives.
 */
export type Journey = (d: Driver, kit: JourneyKit) => Promise<void>;

/** Loads and validates a journey before the runner builds or launches the app. */
export async function loadJourney(path: string) {
  const loaded: { default?: unknown } = await import(pathToFileURL(path).href);

  if (!isCallable(loaded.default))
    throw new Error(`Journey ${path} has no default export function.`);
  // Runtime validation checks callability; the module author supplies the Journey contract.
  const journey = loaded.default as Journey;

  return async (d: Driver, fixtures: Pick<JourneyKit, "provider" | "tmdb">) => {
    d.observed["journey"] = path;
    await journey(d, { ...fixtures, named, poster, dialog, focused });
  };
}
