import { lazy } from "@mrstreamer/contracts/lazy";
import type {
  LiveCatalogue,
  OnDemandCatalogue,
  ProviderCategory,
  ProviderChannel,
  ProviderTitle,
} from "@mrstreamer/core/provider";
import { type } from "arktype";
import { Directory, File, Paths } from "expo-file-system";

// Each subscription's last channel list and movie and series lists, as its provider gave them,
// kept in Caches/catalogues so a launch can show them before, or instead of, asking again.
// account.ts alone calls this module and decides when a copy shows, when one is saved and when
// one goes; this module only keeps the files. Caches is left out of backups, and iOS may empty
// it: a copy that is missing, unreadable or doubtful is simply not there, and the lists load as
// they would without one. Reading, saving and tidying never throw: a failure is a missing copy.
// Deleting a subscription's copies, which a new password waits on, answers whether they are gone,
// as a copy left behind would show again at the next launch. Nothing is logged.
//
// What is written is a copy of the fields the app reads, nothing else. An artwork address that
// could carry the login is written as none, while this session's lists keep it; a list with the
// password in any other text the provider sent isn't written at all. A read checks every row
// before anything shows.
// Each subscription's lists are read, written and deleted one operation at a time, per list, so a
// deletion waits for a write under way and a write never recreates what was deleted after it.
// A write goes to a file beside the copy, then takes its place; on iOS that move deletes the copy
// first, so an app stopped in between leaves only the new file, which a read takes once it checks.

/** One subscription's list, with when its provider gave it, epoch milliseconds. */
export type Saved =
  | { readonly kind: "live"; readonly catalogue: LiveCatalogue; readonly fetchedAt: number }
  | { readonly kind: "titles"; readonly catalogue: OnDemandCatalogue; readonly fetchedAt: number };
type SavedKind = Saved["kind"];

const VERSION = 1;
/** A file larger than this isn't read or kept. */
const FILE_BYTES = 64 * 1024 * 1024;
/** Rows a list may have: categories, channels, movies or series. */
const ROWS = 250_000;
/** What every file together may take; the oldest go first past it. */
const TOTAL_BYTES = 256 * 1024 * 1024;
/** A copy older than this, or from further ahead than the clock may drift, isn't shown. */
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_AHEAD = 10 * 60 * 1000;
/** The longest artwork address kept. */
const URL_LENGTH = 2048;

const folder = () => new Directory(Paths.cache, "catalogues");
/** A file name per id: letters, digits and "-" as they are, every other UTF-16 unit as "_" and hex. */
const nameOf = (id: string, kind: SavedKind) =>
  `${id.replace(/[^A-Za-z0-9-]/g, (unit) => `_${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)}.${kind}.json`;
const fileOf = (id: string, kind: SavedKind) => new File(folder(), nameOf(id, kind));
const pendingOf = (id: string, kind: SavedKind) => new File(folder(), `${nameOf(id, kind)}.next`);

const Url = lazy(() => type(`string <= ${URL_LENGTH}`).or("null"));
const Category = lazy(() => type({ "+": "reject", id: "string", name: "string" }));
const Channel = lazy(() =>
  type({
    "+": "reject",
    id: "string",
    name: "string",
    number: "number | null",
    logoUrl: Url(),
    categoryIds: "string[]",
    guideId: "string | null",
    "adult?": "boolean",
    catchupDays: "number | null",
  }),
);
const Title = lazy(() =>
  type({
    "+": "reject",
    id: "string",
    name: "string",
    posterUrl: Url(),
    backdropUrl: Url(),
    rating: "number | null",
    addedAt: "number | null",
    releaseDate: "string | null",
    categoryIds: "string[]",
    adult: "boolean",
    container: "string | null",
    "tmdbId?": "string | null",
    "metadata?": "'lazy'",
    "episodeFiles?": "string[]",
  }),
);
const Head = {
  "+": "reject",
  version: `${VERSION}`,
  subscriptionId: "string",
  fetchedAt: "number",
} as const;
const Envelopes = lazy(() => ({
  live: type({
    ...Head,
    kind: "'live'",
    catalogue: type({
      "+": "reject",
      categories: Category().array().atMostLength(ROWS),
      channels: Channel().array().atMostLength(ROWS),
    }),
  }),
  titles: type({
    ...Head,
    kind: "'titles'",
    catalogue: type({
      "+": "reject",
      movieCategories: Category().array().atMostLength(ROWS),
      movies: Title().array().atMostLength(ROWS),
      seriesCategories: Category().array().atMostLength(ROWS),
      series: Title().array().atMostLength(ROWS),
    }),
  }),
}));

/** The last operation on each list's files, settled or not, by file name. */
const queues = new Map<string, Promise<unknown>>();

/** Runs `operation` once the list's earlier ones have finished; answers `fallback` when it fails. */
function queued<A>(id: string, kind: SavedKind, fallback: A, operation: () => Promise<A>) {
  const name = nameOf(id, kind);
  const run = (queues.get(name) ?? Promise.resolve()).then(operation).catch(() => fallback);
  queues.set(name, run);
  return run;
}

/** Deletes the file if it is there, whatever stops it. */
function discard(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {
    // Left for the next launch's tidying.
  }
}

/** The file's list if it reads whole and checks out as `id`'s `kind`; otherwise deletes it. */
async function load(file: File, id: string, kind: SavedKind): Promise<Saved | null> {
  if (!file.exists) return null;
  try {
    if (file.size > FILE_BYTES) throw new RangeError("Too large");
    const parsed = Envelopes()[kind](JSON.parse(await file.text()));
    if (parsed instanceof type.errors || parsed.subscriptionId !== id) throw new TypeError();
    const age = Date.now() - parsed.fetchedAt;
    if (age > MAX_AGE || age < -MAX_AHEAD) throw new RangeError("Out of date");
    return parsed.kind === "live"
      ? { kind: "live", catalogue: parsed.catalogue, fetchedAt: parsed.fetchedAt }
      : { kind: "titles", catalogue: parsed.catalogue, fetchedAt: parsed.fetchedAt };
  } catch {
    discard(file);
    return null;
  }
}

/**
 * `id`'s saved `kind`, or null when there is none that checks out. A write left halfway takes the
 * copy's place while `stands` holds, as the app was stopped before it could; every other file of
 * the list that doesn't check out is deleted.
 */
export function readList(id: string, kind: SavedKind, stands: () => boolean) {
  return queued(id, kind, null, async () => {
    const pending = pendingOf(id, kind);
    const kept = await load(fileOf(id, kind), id, kind);
    if (kept) {
      discard(pending);
      return kept;
    }
    const left = await load(pending, id, kind);
    if (!left || !stands()) {
      discard(pending);
      return null;
    }
    await pending.move(fileOf(id, kind), { overwrite: true });
    if (stands()) return left;
    discard(fileOf(id, kind));
    return null;
  });
}

/**
 * Saves `saved` as `id`'s copy of its list, while `stands` holds: checked before the write, while
 * it waits on the disk, and once the copy is in place, which goes again when it no longer holds.
 * `login` is what signs the subscription in, kept out of the copy. Never rejects.
 */
export function writeList(
  id: string,
  saved: Saved,
  login: readonly string[],
  stands: () => boolean,
): Promise<void> {
  const { kind } = saved;
  return queued(id, kind, undefined, async () => {
    if (!stands()) return;
    const text = textOf(id, saved, login);
    if (text === null) return;
    folder().create({ intermediates: true, idempotent: true });
    const pending = pendingOf(id, kind);
    try {
      pending.create({ overwrite: true });
      await pending.write(text);
      if (!stands() || pending.size > FILE_BYTES) return discard(pending);
      await pending.move(fileOf(id, kind), { overwrite: true });
    } catch {
      return discard(pendingOf(id, kind));
    }
    if (!stands()) return discard(fileOf(id, kind));
    shed(nameOf(id, kind));
  });
}

/**
 * Deletes `id`'s copies once whatever reads or writes them has finished. Answers whether none is
 * left of either list, the copy or a write left halfway: false when the disk refuses a deletion.
 * Never rejects.
 */
export async function dropLists(id: string): Promise<boolean> {
  const gone = await Promise.all(
    (["live", "titles"] as const).map((kind) =>
      queued(id, kind, false, async () => {
        const files = [fileOf(id, kind), pendingOf(id, kind)];
        for (const file of files) if (file.exists) file.delete();
        return files.every((file) => !file.exists);
      }),
    ),
  );
  return gone.every(Boolean);
}

/**
 * At launch, before any list is read: deletes every file but the copies of `ids`, the saved
 * subscriptions, and keeps them all within the folder's budget.
 */
export function pruneLists(ids: readonly string[]): void {
  try {
    const at = folder();
    if (!at.exists) return;
    const kept = new Set(
      ids.flatMap((id) =>
        (["live", "titles"] as const).flatMap((kind) => [
          nameOf(id, kind),
          `${nameOf(id, kind)}.next`,
        ]),
      ),
    );
    for (const entry of at.list()) {
      if (!kept.has(entry.name)) entry.delete();
    }
    shed(null);
  } catch {
    // Tried again at the next launch.
  }
}

/**
 * While the files take more than the budget, deletes copies, the movie and series lists before
 * the channel lists, each the least recently written first, but never `keep`.
 */
function shed(keep: string | null) {
  const files = folder()
    .list()
    .filter((entry) => entry instanceof File);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= TOTAL_BYTES) return;
  const order = (file: File) => (file.name.endsWith(".titles.json") ? 0 : 1);
  const copies = files
    .filter((file) => file.name.endsWith(".json") && file.name !== keep)
    .toSorted(
      (a, b) => order(a) - order(b) || (a.modificationTime ?? 0) - (b.modificationTime ?? 0),
    );
  for (const file of copies) {
    if (total <= TOTAL_BYTES) return;
    total -= file.size;
    discard(file);
  }
}

/**
 * The file's text for `saved`: its rows with the fields the app reads, artwork addresses that may
 * carry the login as none. Null when any other text of the rows holds the password, as nothing
 * then says what else of the login a row carries; their numbers and field names aren't text.
 */
function textOf(id: string, saved: Saved, login: readonly string[]): string | null {
  const [username = "", password = ""] = login;
  const art = (url: string | null) => safeUrl(url, username, password);
  const catalogue =
    saved.kind === "live" ? liveCopy(saved.catalogue, art) : titlesCopy(saved.catalogue, art);
  if (password !== "" && holds(catalogue, password)) return null;
  return JSON.stringify({
    version: VERSION,
    subscriptionId: id,
    fetchedAt: saved.fetchedAt,
    kind: saved.kind,
    catalogue,
  });
}

/** Whether a text within `value`, a copy's rows, holds `password`. Artwork kept has none. */
function holds(value: unknown, password: string): boolean {
  if (typeof value === "string") return value.includes(password);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).some((each: unknown) => holds(each, password))
  );
}

type Art = (url: string | null) => string | null;

const categoryCopy = ({ id, name }: ProviderCategory) => ({ id, name }) satisfies ProviderCategory;

const liveCopy = (catalogue: LiveCatalogue, art: Art) =>
  ({
    categories: catalogue.categories.map(categoryCopy),
    channels: catalogue.channels.map(
      (channel) =>
        ({
          id: channel.id,
          name: channel.name,
          number: channel.number,
          logoUrl: art(channel.logoUrl),
          categoryIds: [...channel.categoryIds],
          guideId: channel.guideId,
          ...(channel.adult === undefined ? {} : { adult: channel.adult }),
          catchupDays: channel.catchupDays,
        }) satisfies ProviderChannel,
    ),
  }) satisfies LiveCatalogue;

const titleCopy = (title: ProviderTitle, art: Art) =>
  ({
    id: title.id,
    name: title.name,
    posterUrl: art(title.posterUrl),
    backdropUrl: art(title.backdropUrl),
    rating: title.rating,
    addedAt: title.addedAt,
    releaseDate: title.releaseDate,
    categoryIds: [...title.categoryIds],
    adult: title.adult,
    container: title.container,
    ...(title.tmdbId === undefined ? {} : { tmdbId: title.tmdbId }),
    ...(title.metadata === undefined ? {} : { metadata: title.metadata }),
    ...(title.episodeFiles === undefined ? {} : { episodeFiles: [...title.episodeFiles] }),
  }) satisfies ProviderTitle;

const titlesCopy = (catalogue: OnDemandCatalogue, art: Art) =>
  ({
    movieCategories: catalogue.movieCategories.map(categoryCopy),
    movies: catalogue.movies.map((title) => titleCopy(title, art)),
    seriesCategories: catalogue.seriesCategories.map(categoryCopy),
    series: catalogue.series.map((title) => titleCopy(title, art)),
  }) satisfies OnDemandCatalogue;

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/**
 * `url` when the disk may keep it: an http(s) address of at most 2048 characters, with no login
 * before its host, no path part, query name or query value that is the username, and the password
 * nowhere in it: not as written, decoded whole, nor within any decoded path part, fragment, or
 * query name or value, which decode "+" as a space. Otherwise null.
 */
function safeUrl(url: string | null, username: string, password: string): string | null {
  if (url === null || url.length > URL_LENGTH) return null;
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const parts = [
    url,
    decoded(url),
    decoded(parsed.hash),
    ...parsed.pathname.split("/").map(decoded),
    ...[...parsed.searchParams].flat(),
  ];
  const named = (part: string | null) =>
    part === null ||
    (username !== "" && part === username) ||
    (password !== "" && part.includes(password));
  return parts.some(named) ? null : url;
}
