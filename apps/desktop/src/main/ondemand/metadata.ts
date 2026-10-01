// TMDB's metadata for the catalogue, in the catalogue worker: fetched in the background, newest
// titles first, kept in metadata.json.gz and refreshed before TMDB's six months run out. Without
// a key, or with one TMDB refuses, the catalogue works as before, without genres or services.
import { type } from "arktype";
import {
  TmdbError,
  type StreamingService,
  type TitleMetadata,
  type Tmdb,
  type TmdbKind,
} from "@mrstreamer/core/metadata/tmdb";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";

/** Fetched again after this long: inside TMDB's limit of six months. */
const KEEP_MS = 150 * 24 * 60 * 60_000;
/** Which titles each streaming service carries changes often; fetched again after a week. */
const SERVICES_KEEP_MS = 7 * 24 * 60 * 60_000;
/** Requests in flight at once, and at most this many a second: TMDB allows about 50. */
const PARALLEL = 6;
const PER_SECOND = 30;
/** How often the store is written while fetching. */
const SAVE_EVERY_MS = 30_000;
/** Streaming services followed per region and kind, most prominent first. */
const SERVICES = 12;
/** Pages read per service and kind, 20 titles each: its most popular 5,000. */
const SERVICE_PAGES = 250;

const Entry = type({
  at: "number",
  "missing?": "true",
  "genres?": "number[]",
  "language?": "string | null",
  "popularity?": "number",
  "rating?": "number",
  "votes?": "number",
  "collection?": type({ id: "number", name: "string" }).or("null"),
  "backdrop?": "string | null",
});
const ServiceList = type({ id: "number", name: "string", priority: "number", ids: "string[]" });
const MetadataFile = type({
  version: "1",
  entries: type({ "[string]": Entry }),
  "services?": type({
    region: "string",
    at: "number",
    movie: ServiceList.array(),
    tv: ServiceList.array(),
  }).or("null"),
});
type MetadataFile = typeof MetadataFile.infer;

/** A title the catalogue lists, as the store needs it. */
export interface Wanted {
  readonly kind: TmdbKind;
  readonly tmdbId: string;
  /** Newer titles are fetched first. */
  readonly addedAt: number;
}

/** A streaming service and the TMDB ids of what it streams in the region. */
export interface ServiceTitles extends StreamingService {
  readonly ids: ReadonlySet<string>;
}

export interface MetadataStatus {
  /** Titles with metadata, and titles the catalogue lists with a TMDB id. */
  readonly known: number;
  readonly wanted: number;
  /** TMDB refused the key: nothing more is fetched until it changes. */
  readonly refused: boolean;
}

export interface MetadataDeps {
  readonly path: string;
  /** Null without a key: the store answers from disk and fetches nothing. */
  readonly client: Tmdb | null;
  /** ISO 3166-1 country for streaming services: "NL". */
  readonly region: string;
  /** Called when more metadata arrived, at most every few seconds. */
  readonly onChange: () => void;
  readonly now?: () => number;
}

export function metadataStore(deps: MetadataDeps) {
  const now = deps.now ?? Date.now;
  let file: MetadataFile = { version: 1, entries: {}, services: null };
  const loading = readJsonFile(deps.path, MetadataFile).then((found) => {
    if (found) file = found;
  });
  let wanted: readonly Wanted[] = [];
  let refused = false;
  let running: Promise<void> | null = null;
  let dirty = false;
  let lastSave = now();
  let lastChange = 0;

  const keyOf = (kind: TmdbKind, id: string) => `${kind}:${id}`;
  const fresh = (at: number, keep: number) => now() - at < keep;

  function changed(force = false): void {
    dirty = true;
    if (force || now() - lastChange > 3000) {
      lastChange = now();
      deps.onChange();
    }
  }

  async function save(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    lastSave = now();
    await writeJsonFile(deps.path, file).catch(() => {
      dirty = true;
    });
  }

  /** Runs `task` for each item, PARALLEL at a time, at most PER_SECOND starts a second. */
  async function paced<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    let slot = now();
    const lane = async () => {
      while (next < items.length && !refused) {
        const item = items[next++] as T;
        const wait = Math.max(0, slot - now());
        slot = Math.max(slot, now()) + 1000 / PER_SECOND;
        if (wait > 0) await new Promise((done) => setTimeout(done, wait));
        await task(item);
        if (now() - lastSave > SAVE_EVERY_MS) await save();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, lane));
  }

  /** Calls TMDB, waiting when it asks to; null when it can't answer now. */
  async function ask<A>(call: () => Promise<A>): Promise<A | "missing" | null> {
    for (let tries = 0; tries < 3; tries++) {
      try {
        return await call();
      } catch (cause) {
        if (!(cause instanceof TmdbError)) return null;
        const failure = cause.failure;
        if (failure.kind === "missing") return "missing";
        if (failure.kind === "refused") {
          refused = true;
          changed(true);
          return null;
        }
        if (failure.kind !== "busy") return null;
        await new Promise((done) => setTimeout(done, failure.retryAfter * 1000));
      }
    }
    return null;
  }

  async function fetchTitles(client: Tmdb): Promise<void> {
    const due = wanted
      .filter((title) => {
        const entry = file.entries[keyOf(title.kind, title.tmdbId)];
        return !entry || !fresh(entry.at, KEEP_MS);
      })
      .toSorted((a, b) => b.addedAt - a.addedAt);
    await paced(due, async (title) => {
      const found = await ask(() => client.details(title.kind, title.tmdbId));
      if (found === null) return;
      file.entries[keyOf(title.kind, title.tmdbId)] =
        found === "missing"
          ? { at: now(), missing: true }
          : { at: now(), ...found, genres: [...found.genres] };
      changed();
    });
  }

  async function fetchServices(client: Tmdb): Promise<void> {
    if (file.services?.region === deps.region && fresh(file.services.at, SERVICES_KEEP_MS)) {
      return;
    }
    const lists: Record<TmdbKind, (StreamingService & { ids: string[] })[]> = { movie: [], tv: [] };
    for (const kind of ["movie", "tv"] as const) {
      const services = await ask(() => client.services(kind, deps.region));
      if (!services || services === "missing") return;
      for (const service of services.slice(0, SERVICES)) {
        const ids: string[] = [];
        for (let page = 1, pages = 1; page <= Math.min(pages, SERVICE_PAGES); page++) {
          const found = await ask(() => client.onService(kind, service.id, deps.region, page));
          if (!found || found === "missing") return;
          ids.push(...found.ids);
          pages = found.pages;
          await new Promise((done) => setTimeout(done, 1000 / PER_SECOND));
        }
        lists[kind].push({ ...service, ids });
      }
    }
    file.services = { region: deps.region, at: now(), ...lists };
    changed(true);
  }

  async function run(client: Tmdb): Promise<void> {
    await loading;
    await fetchTitles(client);
    if (!refused) await fetchServices(client);
    await save();
    changed(true);
  }

  return {
    /** The titles the catalogue lists; fetches what is missing or old, in the background. */
    want(titles: readonly Wanted[]): void {
      wanted = titles;
      if (!deps.client || refused || running) return;
      running = run(deps.client).finally(() => {
        running = null;
      });
    },

    /** What TMDB knows about a title, from the store; null before it arrived. */
    get(kind: TmdbKind, tmdbId: string): TitleMetadata | null {
      const entry = file.entries[keyOf(kind, tmdbId)];
      if (!entry || entry.missing) return null;
      return {
        genres: entry.genres ?? [],
        language: entry.language ?? null,
        popularity: entry.popularity ?? 0,
        rating: entry.rating ?? 0,
        votes: entry.votes ?? 0,
        collection: entry.collection ?? null,
        backdrop: entry.backdrop ?? null,
      };
    },

    /** The streaming services of the region, each with what it streams. */
    services(kind: TmdbKind): readonly ServiceTitles[] {
      if (file.services?.region !== deps.region) return [];
      return file.services[kind].map(({ ids, ...service }) => ({ ...service, ids: new Set(ids) }));
    },

    status(): MetadataStatus {
      const known = wanted.filter((title) => {
        const entry = file.entries[keyOf(title.kind, title.tmdbId)];
        return entry && !entry.missing;
      }).length;
      return { known, wanted: wanted.length, refused };
    },

    /** Waits for the store to be read, and for the fetching in progress to finish. */
    async settled(): Promise<void> {
      await loading;
      await running;
    },

    /** Writes what changed, for stopping. */
    flush: () => save(),
  };
}
