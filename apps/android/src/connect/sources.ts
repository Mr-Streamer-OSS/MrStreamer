import { type } from "arktype";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import { isAdultCategory } from "@mrstreamer/core/adult";
import { normalizeSteps } from "@mrstreamer/core/catalogue/normalize";
import type { LiveCatalogue, Provider } from "@mrstreamer/core/provider";
import { sha256Hex } from "@mrstreamer/core/sha256";
import {
  httpsUnavailable,
  parseLogin,
  xtreamProvider,
  type ParsedLogin,
} from "@mrstreamer/core/xtream";
import { signIns } from "@mrstreamer/mobile/accounts/sign-ins";
import type { Authority, Credentials } from "../platform/credentials.ts";
import { store, type Store } from "../platform/store.ts";
import { inTasks } from "../platform/tasks.ts";
import { playlistReader } from "./playlist.ts";

// The viewer's saved sources (Xtream logins and M3U links) and the channels each lists, all shown
// together. A source's authority lives only in the protected credentials; the registry file holds
// its id, kind and host, so nothing written to app storage, state or a failure carries a login.
//
// connect() checks a login with its provider before saving anything. restore() signs every saved
// source in again at launch, from the credentials alone, checking each login before listing its
// channels; a source whose authority can't be read stays listed as needing its login again, and an
// authority no listed source names (a damaged list, a connect cut short) is erased. remove() erases
// the source's authority, then stops its reads and forgets it; a refused erase keeps it listed so
// nothing claims a deletion that didn't happen. Which reader each source is signed in with, and
// whether a channel list's answer still counts, is kept as the iOS app keeps it
// (@mrstreamer/mobile/accounts/sign-ins): an answer for a login replaced, removed or read again
// since is dropped.

/** What a source answers for: checking its login and listing its channels. */
export interface CatalogueReader {
  authenticate(signal?: AbortSignal): Promise<unknown>;
  liveCatalogue(signal?: AbortSignal): Promise<LiveCatalogue>;
}

/** A signed-in Xtream source's movie and series reads; M3U playlists have none. */
export type OnDemandReader = Pick<Provider, "onDemandCatalogue" | "movieDetails" | "seriesDetails">;

/** A channel as the catalogue shows it, named as the desktop app names it. */
export interface ChannelRow {
  /** Unique across sources: the source's id, then the channel's. */
  readonly key: string;
  readonly sourceId: string;
  readonly title: string;
  readonly number: number | null;
  /** The name of its first category, as the provider wrote it. */
  readonly category: string | null;
}

export type Channels =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly rows: readonly ChannelRow[] }
  | { readonly kind: "failed"; readonly error: AppError };

export interface SavedSource {
  readonly id: string;
  readonly kind: Authority["kind"];
  /** The provider's host, as screens name it: "tv.example.net", with a port that isn't the default. */
  readonly label: string;
}

export interface ConnectedSource extends SavedSource {
  readonly channels: Channels;
}

export type Sources =
  | { readonly kind: "restoring" }
  | { readonly kind: "ready"; readonly sources: readonly ConnectedSource[] };

export type Connected =
  | { readonly kind: "connected"; readonly id: string }
  /** The signal aborted before anything was saved, while the provider checked or after. */
  | { readonly kind: "cancelled" }
  /**
   * The provider refused, or couldn't be reached. `http` is the same login over plain http,
   * offered only when the viewer typed no scheme and https itself was the problem.
   */
  | { readonly kind: "failed"; readonly error: AppError; readonly http: LoginInput | null };

export interface SourcesPlatform {
  readonly credentials: Credentials;
  readonly readJson: (name: string) => unknown;
  readonly writeJson: (name: string, value: unknown) => void;
  readonly fetch: typeof fetch;
  readonly userAgent: string;
}

const REGISTRY = "sources.json";

const Registry = type({
  version: "1",
  sources: type({ id: "string", kind: "'xtream' | 'm3u'", label: "string" }).array(),
});

/** "tv.example.net:8080" from "http://tv.example.net:8080/path": the port only when it isn't the default. */
const hostOf = (address: string) => URL.parse(address)?.host ?? address;

/** A source's id, the same for the same account however often it is connected. */
function idOf(authority: Authority): string {
  const identity =
    authority.kind === "xtream" ? `${authority.server}\n${authority.username}` : authority.link;

  return `${authority.kind}:${sha256Hex(identity).slice(0, 16)}`;
}

function savedOf(authority: Authority): SavedSource {
  return {
    id: idOf(authority),
    kind: authority.kind,
    label: hostOf(authority.kind === "xtream" ? authority.server : authority.link),
  };
}

const failureOf = (cause: unknown): AppError =>
  cause instanceof AppFailure
    ? cause.error
    : { kind: "unexpected", detail: cause instanceof Error ? cause.message : String(cause) };

/**
 * Channels to show, worked out a few slices per task so taps and Back go on (null once `wanted`
 * fails). Adults' are left out until a setting can show them: those the provider marks, and those
 * in a category named for adults, as the iOS app reads them (apps/ios/src/library.ts).
 */
async function rowsOf(
  sourceId: string,
  catalogue: LiveCatalogue,
  wanted: () => boolean,
): Promise<readonly ChannelRow[] | null> {
  const adultCategories = new Set(
    catalogue.categories.filter((each) => isAdultCategory(each.name)).map((each) => each.id),
  );

  const adult = new Set(
    catalogue.channels
      .filter((each) => each.adult || each.categoryIds.some((id) => adultCategories.has(id)))
      .map((each) => each.id),
  );

  const normalized = await inTasks(normalizeSteps(catalogue), wanted);

  if (!normalized) return null;
  const { categories, streams } = normalized;
  const names = new Map(categories.map((category) => [category.id, category.name]));

  return streams
    .filter((stream) => !adult.has(stream.id))
    .map((stream) => ({
      key: `${sourceId}:${stream.id}`,
      sourceId,
      title: stream.title,
      number: stream.number,
      category: names.get(stream.categoryIds[0] ?? "") ?? null,
    }));
}

export interface SourcesOwner {
  readonly state: Store<Sources>;
  /** On-demand reads bound to the current sign-in; obsolete answers reject without publishing. */
  onDemand(id: string): OnDemandReader | null;
  /** Reads the saved sources and signs each in again. Call once, at launch. */
  restore(): Promise<void>;
  /** Checks `input` with its provider, then saves it and lists its channels. */
  connect(input: LoginInput, signal?: AbortSignal): Promise<Connected>;
  /** Checks a source's login and lists its channels again. */
  retry(id: string): void;
  /** Erases the source's authority, then stops its reads and forgets it. Throws when refused. */
  remove(id: string): Promise<void>;
}

export function sourcesOwner(platform: SourcesPlatform): SourcesOwner {
  const state = store<Sources>({ kind: "restoring" });
  /** Settles once restore() listed the saved sources: a connection made before waits for it. */
  let restored!: () => void;
  const ready = new Promise<void>((resolve) => (restored = resolve));

  /** Each signed-in source's reader, and its channel reads. */
  const readers = signIns<CatalogueReader & Partial<OnDemandReader>>();

  const listed = () => {
    const now = state.get();

    return now.kind === "ready" ? now.sources : [];
  };

  function readerOf(authority: Authority): CatalogueReader & Partial<OnDemandReader> {
    const options = { userAgent: platform.userAgent, fetch: platform.fetch };

    return authority.kind === "xtream"
      ? xtreamProvider(authority, { ...options, inTasks })
      : playlistReader(authority.link, options);
  }

  function setChannels(id: string, channels: Channels) {
    state.set((now) =>
      now.kind === "ready"
        ? {
            kind: "ready",
            sources: now.sources.map((source) =>
              source.id === id ? { ...source, channels } : source,
            ),
          }
        : now,
    );
  }

  /**
   * Lists `id`'s channels, checking its login first unless connect() just did, and dropping the
   * answer of any read begun before.
   */
  function load(id: string, checked = false) {
    const read = readers.begin(id, "live");

    if (!read) return;
    const { login: reader, signal, stands } = read;
    setChannels(id, { kind: "loading" });
    (checked ? Promise.resolve() : reader.authenticate(signal))
      .then(() => reader.liveCatalogue(signal))
      .then((catalogue) => rowsOf(id, catalogue, stands))
      .then(
        (rows) => {
          if (rows && stands()) setChannels(id, { kind: "ready", rows });
        },
        (cause: unknown) => {
          if (stands()) setChannels(id, { kind: "failed", error: failureOf(cause) });
        },
      );
  }

  function writeRegistry(sources: readonly SavedSource[]) {
    platform.writeJson(REGISTRY, {
      version: 1,
      sources: sources.map(({ id, kind, label }) => ({ id, kind, label })),
    });
  }

  return {
    state,

    onDemand(id) {
      const login = readers.current(id);

      if (!login?.onDemandCatalogue || !login.movieDetails || !login.seriesDetails) return null;
      const catalogue = login.onDemandCatalogue.bind(login);
      const movie = login.movieDetails.bind(login);
      const series = login.seriesDetails.bind(login);

      async function read<T>(list: string, ask: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (readers.current(id) !== login) throw new Error("Source changed");
        const load = readers.begin(id, list);

        if (!load || load.login !== login) throw new Error("Source changed");
        const result = await ask(load.signal);

        if (!load.stands()) throw new Error("Source changed");

        return result;
      }

      return {
        onDemandCatalogue: () => read("on-demand", catalogue),
        movieDetails: (title) => read(`movie:${title}`, (signal) => movie(title, signal)),
        seriesDetails: (title) => read(`series:${title}`, (signal) => series(title, signal)),
      };
    },

    async restore() {
      const parsed = Registry(platform.readJson(REGISTRY) ?? { version: 1, sources: [] });
      const saved = parsed instanceof type.errors ? [] : parsed.sources;
      // Best effort: what this misses, the next launch erases.
      await platform.credentials.retain(saved.map((source) => source.id)).catch(() => {});

      const restoredSources = await Promise.all(
        saved.map(async (source): Promise<ConnectedSource> => {
          // A missing, unknown or unreadable authority all ask for the login again.
          const authority = await platform.credentials.read(source.id).catch(() => null);

          if (!authority)
            return {
              ...source,
              channels: {
                kind: "failed",
                error: { kind: "needs-secret", subscriptionId: source.id },
              },
            };
          readers.set(source.id, readerOf(authority));

          return { ...source, channels: { kind: "loading" } };
        }),
      );

      state.set({ kind: "ready", sources: restoredSources });
      restored();

      for (const source of restoredSources) load(source.id);
    },

    async connect(input, signal) {
      let parsed: ParsedLogin;

      try {
        parsed = parseLogin(input);
      } catch (cause) {
        return { kind: "failed", error: failureOf(cause), http: null };
      }

      const { account: authority, schemeless } = parsed;
      const reader = readerOf(authority);

      try {
        await reader.authenticate(signal);
      } catch (cause) {
        if (signal?.aborted) return { kind: "cancelled" };
        const error = failureOf(cause);

        const http =
          schemeless && httpsUnavailable(error)
            ? { ...input, server: `http://${input.server.trim()}` }
            : null;

        return { kind: "failed", error, http };
      }

      const saved = savedOf(authority);
      await ready;

      if (signal?.aborted) return { kind: "cancelled" };
      const known = listed().some((source) => source.id === saved.id);
      // What a cancel or a refused list puts back: the login this source had, or none. A new
      // login left behind no list names, and the next launch erases it.
      const previous = known ? await platform.credentials.read(saved.id).catch(() => null) : null;

      const undo = () =>
        (previous
          ? platform.credentials.write(saved.id, previous)
          : platform.credentials.remove(saved.id)
        ).catch(() => {});

      try {
        await platform.credentials.write(saved.id, authority);
      } catch (cause) {
        return { kind: "failed", error: failureOf(cause), http: null };
      }

      if (signal?.aborted) {
        await undo();

        return { kind: "cancelled" };
      }

      // Read after the write: a source removed meanwhile stays removed.
      const others = listed().filter((source) => source.id !== saved.id);

      try {
        writeRegistry([...others, saved]);
      } catch (cause) {
        await undo();

        return { kind: "failed", error: failureOf(cause), http: null };
      }

      readers.set(saved.id, reader);
      state.set({
        kind: "ready",
        sources: [...others, { ...saved, channels: { kind: "loading" } }],
      });
      load(saved.id, true);

      return { kind: "connected", id: saved.id };
    },

    retry: (id) => load(id),

    async remove(id) {
      await platform.credentials.remove(id);
      readers.drop(id);
      const others = listed().filter((source) => source.id !== id);

      try {
        writeRegistry(others);
      } catch (cause) {
        // Still listed, with nothing left to sign in with: Remove can be pressed again.
        setChannels(id, { kind: "failed", error: { kind: "needs-secret", subscriptionId: id } });
        throw cause;
      }

      state.set({ kind: "ready", sources: others });
    },
  };
}
