import { type } from "arktype";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import type { LiveCatalogue } from "@mrstreamer/core/provider";
import { sha256Hex } from "@mrstreamer/core/sha256";
import { httpsUnavailable, parseLogin, xtreamProvider } from "@mrstreamer/core/xtream";
import type { Authority, Credentials } from "../platform/credentials.ts";
import { store, type Store } from "../platform/store.ts";
import { playlistReader } from "./playlist.ts";

// The viewer's saved sources (Xtream logins and M3U links) and the channels each lists, all shown
// together. A source's authority lives only in the protected credentials; the registry file holds
// its id, kind and host, so nothing written to app storage, state or a failure carries a login.
//
// connect() checks a login with its provider before saving anything. restore() signs every saved
// source in again at launch, from the credentials alone, and a source whose authority can't be read
// stays listed as needing its login again. remove() stops the source's reads, erases its authority,
// then forgets it; a refused erase keeps it listed so nothing claims a deletion that didn't happen.

/** What a source answers for: checking its login and listing its channels. */
export interface CatalogueReader {
  authenticate(signal?: AbortSignal): Promise<unknown>;
  liveCatalogue(signal?: AbortSignal): Promise<LiveCatalogue>;
}

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
  /** The provider's host, as screens name it: "tv.example.net". */
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

/** "tv.example.net" from "http://tv.example.net:8080/path". */
const hostOf = (address: string) => URL.parse(address)?.hostname ?? address;

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

/** Channels to show, adults' left out until a setting can show them. */
function rowsOf(sourceId: string, catalogue: LiveCatalogue): readonly ChannelRow[] {
  const { categories, streams } = normalizeCatalogue(catalogue);
  const names = new Map(categories.map((category) => [category.id, category.name]));
  return streams
    .filter((stream) => !stream.adult)
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
  /** Reads the saved sources and signs each in again. Call once, at launch. */
  restore(): Promise<void>;
  /** Checks `input` with its provider, then saves it and lists its channels. */
  connect(input: LoginInput, signal?: AbortSignal): Promise<Connected>;
  /** Lists a source's channels again. */
  retry(id: string): void;
  /** Stops the source's reads, erases its authority, then forgets it. Throws when refused. */
  remove(id: string): Promise<void>;
}

export function sourcesOwner(platform: SourcesPlatform): SourcesOwner {
  const state = store<Sources>({ kind: "restoring" });
  /** Settles once restore() listed the saved sources: a connection made before waits for it. */
  let restored!: () => void;
  const ready = new Promise<void>((resolve) => (restored = resolve));
  /** Each signed-in source's reader, and the controller of the read under way. */
  const readers = new Map<string, CatalogueReader>();
  const reads = new Map<string, AbortController>();

  const listed = () => {
    const now = state.get();
    return now.kind === "ready" ? now.sources : [];
  };

  function readerOf(authority: Authority): CatalogueReader {
    const options = { userAgent: platform.userAgent, fetch: platform.fetch };
    return authority.kind === "xtream"
      ? xtreamProvider(authority, options)
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

  /** Lists `id`'s channels, dropping the answer of any read begun before. */
  function load(id: string) {
    const reader = readers.get(id);
    if (!reader) return;
    reads.get(id)?.abort();
    const controller = new AbortController();
    reads.set(id, controller);
    setChannels(id, { kind: "loading" });
    reader.liveCatalogue(controller.signal).then(
      (catalogue) => {
        if (reads.get(id) === controller)
          setChannels(id, { kind: "ready", rows: rowsOf(id, catalogue) });
      },
      (cause: unknown) => {
        if (reads.get(id) === controller)
          setChannels(id, { kind: "failed", error: failureOf(cause) });
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

    async restore() {
      const parsed = Registry(platform.readJson(REGISTRY) ?? { version: 1, sources: [] });
      const saved = parsed instanceof type.errors ? [] : parsed.sources;
      const restoredSources = await Promise.all(
        saved.map(async (source): Promise<ConnectedSource> => {
          try {
            const authority = await platform.credentials.read(source.id);
            if (authority) {
              readers.set(source.id, readerOf(authority));
              return { ...source, channels: { kind: "loading" } };
            }
            return {
              ...source,
              channels: {
                kind: "failed",
                error: { kind: "needs-secret", subscriptionId: source.id },
              },
            };
          } catch (cause) {
            return { ...source, channels: { kind: "failed", error: failureOf(cause) } };
          }
        }),
      );
      state.set({ kind: "ready", sources: restoredSources });
      restored();
      for (const source of restoredSources) load(source.id);
    },

    async connect(input, signal) {
      let authority: Authority;
      let schemeless: boolean;
      try {
        const parsed = parseLogin(input);
        authority = parsed.account;
        schemeless = parsed.schemeless;
      } catch (cause) {
        return { kind: "failed", error: failureOf(cause), http: null };
      }
      const reader = readerOf(authority);
      try {
        await reader.authenticate(signal);
      } catch (cause) {
        const error = failureOf(cause);
        const http =
          schemeless && httpsUnavailable(error)
            ? { ...input, server: `http://${input.server.trim()}` }
            : null;
        return { kind: "failed", error, http };
      }
      const saved = savedOf(authority);
      await ready;
      try {
        await platform.credentials.write(saved.id, authority);
        const others = listed().filter((source) => source.id !== saved.id);
        writeRegistry([...others, saved]);
        readers.set(saved.id, reader);
        state.set({
          kind: "ready",
          sources: [...others, { ...saved, channels: { kind: "loading" } }],
        });
      } catch (cause) {
        return { kind: "failed", error: failureOf(cause), http: null };
      }
      load(saved.id);
      return { kind: "connected", id: saved.id };
    },

    retry: load,

    async remove(id) {
      reads.get(id)?.abort();
      reads.delete(id);
      try {
        await platform.credentials.remove(id);
      } catch (cause) {
        load(id);
        throw cause;
      }
      readers.delete(id);
      const others = listed().filter((source) => source.id !== id);
      writeRegistry(others);
      state.set({ kind: "ready", sources: others });
    },
  };
}
