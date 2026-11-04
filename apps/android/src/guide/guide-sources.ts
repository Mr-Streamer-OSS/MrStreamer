import type { Json } from "@mrstreamer/contracts/json";
import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import type { GuideRequest } from "@mrstreamer/core/provider";
import { sha256Hex } from "@mrstreamer/core/sha256";
import Constants from "expo-constants";
import { File as DiskFile, Paths } from "expo-file-system";
import { guide, type GuideOrigin } from "./guide.ts";
import { playlistSecrets, playlistUncertain, sealedLinks, type SecretStore } from "./secrets.ts";
import { writeJson } from "../platform/storage.ts";
import { store, useStore } from "../platform/store.ts";

// XMLTV guides added in Settings > Guides, apart from every provider's own, and channels mapped
// by hand to a guide id. Each guide is an owner of the native guide store (guide.ts) under its
// own id, so it downloads, publishes and keeps its last good guide as a provider's does. Its link
// can hold a key, so the Keystore holds it under the guide's id; guides.json in Documents holds
// what to show (the link's origin and a name) and a fingerprint to know the link again by.
// runtime.ts restores them at launch and erases a removed subscription's mappings with its
// history.

const Link = lazy(() =>
  type({
    /** `xmltv-…`: the native store and the Keystore name it by. */
    id: "string",
    origin: "string",
    name: "string | null",
    key: "string",
  }),
);

const File = lazy(() =>
  type({
    version: "1",
    /** In the order channels read them, after their own provider's guide. */
    guides: Link().array(),
    /** Guide ids by `Channel.key`. */
    mappings: "Record<string, string>",
    /** Ids whose Keystore item an add or removal was changing: launch removes those not saved. */
    pendingSecrets: "string[]",
  }),
);

type GuidesFile = Infer<typeof File>;

/** An external guide as Settings shows it: nothing of its link but the origin. */
export interface GuideLink extends Omit<GuidesFile["guides"][number], "key"> {
  /** The Keystore didn't give its link back: its saved guide still shows, and nothing refreshes. */
  readonly locked: boolean;
}

/** Why an external guide wasn't added or a channel wasn't mapped. */
export type GuideRefusal =
  /** What was typed isn't an http(s) address. */
  | "address"
  /** That link is added already. */
  | "duplicate"
  /** The name holds an address ("://"), as a link pasted there: names aren't kept as secrets. */
  | "name"
  /** `GUIDE_LIMIT` guides are added already. */
  | "limit"
  /** A guide id longer than the native store reads, `MAPPING_MAX` bytes. */
  | "long"
  /** The Keystore or the file refused the change: nothing changed. */
  | "saving";

/** Each guide a channel without one is looked for in costs a native read: a handful at most. */
export const GUIDE_LIMIT = 8;

/** The longest guide id the native store reads (GuideIndex.kt). */
export const MAPPING_MAX = 512;
const FILE_NAME = "guides.json";

/** Every external guide's id starts with it, and no subscription's does. */
const PREFIX = "xmltv-";
const EMPTY: GuidesFile = { version: 1, guides: [], mappings: {}, pendingSecrets: [] };

/** What an external guide's download names the app as. */
const USER_AGENT = `MrStreamer/${Constants.expoConfig?.version ?? "0.0.0"} (Android)`;

/**
 * The file's JSON, or null when there is none. Unlike storage.ts `readJson`, text that isn't JSON
 * throws: a damaged registry must not read as an empty one and be written over.
 */
function readStrictly(name: string): Json {
  const file = new DiskFile(Paths.document, name);

  return file.exists ? JSON.parse(file.textSync()) : null;
}

/** Builds the owner; the app has one (`guides` below), tests their own. */
export function createGuides(
  secrets: SecretStore = sealedLinks,
  owner: Pick<typeof guide, "configure" | "attach" | "forget" | "refresh"> = guide,
  read: () => Json = () => readStrictly(FILE_NAME),
  write: (value: GuidesFile) => void = (value) => writeJson(FILE_NAME, value),
  now: () => number = Date.now,
) {
  let saved = EMPTY;
  /** False after a launch couldn't read the file there: nothing writes over it until the next. */
  let writable = true;
  const origins = new Map<string, GuideOrigin>();
  const shown = store<readonly GuideLink[]>([]);
  const mapped = store<ReadonlyMap<string, string>>(new Map());
  let revisions = 0;
  /** One change at a time, as each reads the file and writes it back. */
  let changing: Promise<unknown> = Promise.resolve();

  const serially = <A>(change: () => Promise<A>): Promise<A> => {
    const run = changing.then(change);
    changing = run.catch(() => undefined);

    return run;
  };

  const commit = (next: GuidesFile) => {
    if (!writable) throw new Error("The guides file couldn't be read.");
    write(next);
    saved = next;
  };

  /** Tells the guide owner and screens what is saved and signed in. */
  const publish = () => {
    shown.set(
      saved.guides.map(({ key: _key, ...link }) => ({ ...link, locked: !origins.has(link.id) })),
    );
    mapped.set(new Map(Object.entries(saved.mappings)));
    owner.configure(new Map(saved.guides.map(({ id }) => [id, origins.get(id)])), mapped.get());
  };

  const originFor = (link: string): GuideOrigin => {
    const request: GuideRequest = {
      kind: "request",
      url: link,
      headers: { "User-Agent": USER_AGENT },
    };

    return {
      revision: ++revisions,
      provider: {
        async liveGuideRequest(signal) {
          signal?.throwIfAborted();

          return request;
        },
      },
      // What no saved programme may hold, as runtime.ts gives a playlist source's.
      login: [...playlistSecrets(link), link],
      uncertain: playlistUncertain(link),
    };
  };

  const newId = () => {
    const taken = new Set([...saved.guides.map(({ id }) => id), ...saved.pendingSecrets]);
    const base = `${PREFIX}${now().toString(36)}`;
    let id = base;

    for (let next = 2; taken.has(id); next++) id = `${base}-${next}`;

    return id;
  };

  /** Removes `id`'s link from the Keystore, then from the pending ones; the next launch retries. */
  const dropSecret = (id: string) =>
    secrets
      .remove(id)
      .then(() =>
        commit({ ...saved, pendingSecrets: saved.pendingSecrets.filter((each) => each !== id) }),
      )
      .catch(() => undefined);

  /**
   * Cancels and closes the owner's work on `id`, already out of the file and the owner's guides,
   * before its guide is erased, then takes its link out of the Keystore. A guide or link the disk
   * or Keystore keeps goes at the next launch.
   */
  const retire = async (id: string) => {
    await owner.forget(id);
    await dropSecret(id);
  };

  /**
   * Adds `link` last, or in the place of guide `replacing`, which goes in the same write, and
   * downloads it.
   */
  const added = async (
    link: string,
    name: string | null,
    replacing?: string,
  ): Promise<GuideRefusal | null> => {
    if (link.length > 8192) return "address";

    if (name && name.length > 200) return "name";
    const url = URL.parse(link.trim());

    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return "address";
    const key = sha256Hex(url.href);

    if (saved.guides.some((each) => each.key === key && each.id !== replacing)) return "duplicate";
    const at = replacing ? saved.guides.findIndex((each) => each.id === replacing) : -1;
    const id = newId();

    try {
      commit({ ...saved, pendingSecrets: [...saved.pendingSecrets, id] });
      await secrets.write(id, url.href);
      const guide = { id, origin: url.origin, name, key };
      commit({
        ...saved,
        guides: at === -1 ? [...saved.guides, guide] : saved.guides.toSpliced(at, 1, guide),
        pendingSecrets: [
          ...saved.pendingSecrets.filter((each) => each !== id),
          ...(replacing ? [replacing] : []),
        ],
      });
    } catch {
      return "saving";
    }

    origins.set(id, originFor(url.href));

    if (replacing) origins.delete(replacing);
    publish();
    void owner.attach(id);

    if (replacing) await retire(replacing);

    return null;
  };

  /** Takes `id` out of the file and the owner, then retires it. */
  const removed = async (id: string): Promise<GuideRefusal | null> => {
    if (!saved.guides.some((each) => each.id === id)) return null;

    try {
      commit({
        ...saved,
        guides: saved.guides.filter((each) => each.id !== id),
        pendingSecrets: [...saved.pendingSecrets, id],
      });
    } catch {
      return "saving";
    }

    origins.delete(id);
    publish();
    await retire(id);

    return null;
  };

  return {
    useLinks: () => useStore(shown),
    links: shown.get,
    useMappings: () => useStore(mapped),
    mappings: mapped.get,
    /**
     * At launch, before the native guide store restores: the saved guides' ids, which it restores,
     * and the id prefixes it keeps unread (guide.ts `restore`). Without a file it starts empty,
     * and every external guide's saved programmes go. A file that can't be read now, isn't JSON or
     * doesn't match its schema shows none and is never written over: its guides' saved programmes
     * and links stay for a launch that reads it.
     */
    load(): { readonly ids: readonly string[]; readonly kept: readonly string[] } {
      let parsed: GuidesFile | type.errors | null = null;

      try {
        const contents = read();

        if (contents !== null) parsed = File()(contents);
        writable = !(parsed instanceof type.errors);
      } catch {
        writable = false;
      }

      saved = parsed === null || parsed instanceof type.errors ? EMPTY : parsed;
      origins.clear();
      publish();

      return { ids: saved.guides.map(({ id }) => id), kept: writable ? [] : [PREFIX] };
    },
    /** After the native store restored: removes links left pending, and signs each guide in. */
    restore: () =>
      serially(async () => {
        for (const id of saved.pendingSecrets)
          if (!saved.guides.some((each) => each.id === id)) await dropSecret(id);

        for (const { id, key } of saved.guides) {
          const link = await secrets.read(id).catch(() => null);

          if (link && sha256Hex(link) === key) origins.set(id, originFor(link));
        }

        publish();

        for (const id of origins.keys()) void owner.attach(id);
      }),
    /**
     * Adds an XMLTV guide by its link, named `name` or by its origin, and downloads it. Answers
     * why it wasn't added, or null.
     */
    add: (link: string, name = "") =>
      serially(async () => {
        if (saved.guides.length >= GUIDE_LIMIT) return "limit";

        if (name.includes("://")) return "name";

        return added(link, name.trim() || null);
      }),
    /**
     * Gives guide `id` a new link, its own one again included: a new guide in its place, with its
     * name, and `id` removed as `remove` does, so nothing of the old link's guide or work stays.
     */
    replace: (id: string, link: string) =>
      serially(async (): Promise<GuideRefusal | null> => {
        if (link.length > 8192) return "address";
        const old = saved.guides.find((each) => each.id === id);

        if (!old) return null;
        const url = URL.parse(link.trim());

        // A guide whose link the Keystore lost takes it back under its id, keeping its guide.
        if (url && sha256Hex(url.href) === old.key && !origins.has(id)) {
          try {
            await secrets.write(id, url.href);
          } catch {
            return "saving";
          }

          origins.set(id, originFor(url.href));
          publish();
          void owner.attach(id);

          return null;
        }

        return added(link, old.name, id);
      }),
    remove: (id: string) => serially(() => removed(id)),
    refresh: (id: string) => owner.refresh(id),
    /** Reads channel `key`'s programmes by `guideId` before its own, or by its own with null. */
    map: (key: string, guideId: string | null) =>
      serially(async (): Promise<GuideRefusal | null> => {
        const id = guideId?.trim() || null;

        if (id && new TextEncoder().encode(id).length > MAPPING_MAX) return "long";
        const { [key]: _old, ...others } = saved.mappings;

        try {
          commit({ ...saved, mappings: id ? { ...others, [key]: id } : others });
        } catch {
          return "saving";
        }

        publish();

        return null;
      }),
    /** Erases the mappings of subscription `id`'s channels, as its history goes. */
    erase: (subscriptionId: string) =>
      serially(async () => {
        // Mappings not read can't be known erased: the erasure stays pending.
        if (!writable) throw new Error("The guides file couldn't be read.");
        const prefix = `${subscriptionId}:`;
        const kept = Object.entries(saved.mappings).filter(([key]) => !key.startsWith(prefix));

        if (kept.length === Object.keys(saved.mappings).length) return;
        commit({ ...saved, mappings: Object.fromEntries(kept) });
        publish();
      }),
  };
}

export const guides = createGuides();
