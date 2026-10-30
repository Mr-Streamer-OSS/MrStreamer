import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import type { GuideRequest } from "@mrstreamer/core/provider";
import { sha256Hex } from "@mrstreamer/core/sha256";
import Constants from "expo-constants";
import { readJson, writeJson } from "./files.ts";
import { guide, type GuideOrigin } from "./guide.ts";
import { playlistSecrets, playlistUncertain } from "./playlist.ts";
import { keychainSecrets, type SecretStore } from "./secrets.ts";
import { store, useStore } from "./store.ts";

// XMLTV guides added in Settings > Guides, apart from every provider's own, and channels mapped
// by hand to a guide id. Each guide is an owner of the native guide store (guide.ts) under its
// own id, so it downloads, publishes and keeps its last good guide as a provider's does. Its link
// can hold a key, so the Keychain holds it under the guide's id; guides.json in Documents holds
// what to show (the link's origin and a name) and a fingerprint to know the link again by.
// account.ts restores them at launch and erases a removed subscription's mappings with its
// history.

const Link = lazy(() =>
  type({
    /** `xmltv-…`: the native store and the Keychain name it by. */
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
    /** Ids whose Keychain item an add or removal was changing: launch removes those not saved. */
    pendingSecrets: "string[]",
  }),
);

type GuidesFile = Infer<typeof File>;
/** An external guide as Settings shows it: nothing of its link but the origin. */
export interface GuideLink extends Omit<GuidesFile["guides"][number], "key"> {
  /** The Keychain didn't give its link back: its saved guide still shows, and nothing refreshes. */
  readonly locked: boolean;
}

/** Why an external guide wasn't added or a channel wasn't mapped. */
export type GuideRefusal =
  /** What was typed isn't an http(s) address. */
  | "address"
  /** That link is added already. */
  | "duplicate"
  /** `GUIDE_LIMIT` guides are added already. */
  | "limit"
  /** A guide id longer than the native store reads, `MAPPING_MAX` bytes. */
  | "long"
  /** The Keychain or the file refused the change: nothing changed. */
  | "saving";

/** Each guide a channel without one is looked for in costs a native read: a handful at most. */
export const GUIDE_LIMIT = 8;
/** The longest guide id the native store reads (GuideIndex.swift). */
export const MAPPING_MAX = 512;
const FILE_NAME = "guides.json";
const EMPTY: GuidesFile = { version: 1, guides: [], mappings: {}, pendingSecrets: [] };
/** As account.ts's providers send. */
const USER_AGENT = `MrStreamer/${Constants.expoConfig?.version ?? "0.0.0"} (iOS)`;

/** Builds the owner; the app has one (`guides` below), tests their own. */
export function createGuides(
  secrets: SecretStore = keychainSecrets,
  owner: Pick<typeof guide, "configure" | "attach" | "forget" | "refresh"> = guide,
  read: () => unknown = () => readJson(FILE_NAME),
  write: (value: GuidesFile) => void = (value) => writeJson(FILE_NAME, value),
  now: () => number = Date.now,
) {
  let saved = EMPTY;
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
      // What no saved programme may hold, as a playlist link's (account.ts `loginFor`).
      login: [...playlistSecrets(link), link],
      uncertain: playlistUncertain(link),
    };
  };
  const newId = () => {
    const taken = new Set([...saved.guides.map(({ id }) => id), ...saved.pendingSecrets]);
    const base = `xmltv-${now().toString(36)}`;
    let id = base;
    for (let next = 2; taken.has(id); next++) id = `${base}-${next}`;
    return id;
  };
  /** Adds `link` where `at` stands, else last, and downloads it; replaces nothing. */
  const added = async (
    link: string,
    name: string | null,
    at = saved.guides.length,
  ): Promise<GuideRefusal | null> => {
    const url = URL.parse(link.trim());
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return "address";
    const key = sha256Hex(url.href);
    if (saved.guides.some((each) => each.key === key)) return "duplicate";
    const id = newId();
    try {
      commit({ ...saved, pendingSecrets: [...saved.pendingSecrets, id] });
      await secrets.write(id, url.href);
      commit({
        ...saved,
        guides: saved.guides.toSpliced(at, 0, { id, origin: url.origin, name, key }),
        pendingSecrets: saved.pendingSecrets.filter((each) => each !== id),
      });
    } catch {
      return "saving";
    }
    origins.set(id, originFor(url.href));
    publish();
    void owner.attach(id);
    return null;
  };
  /** Removes `id`'s link from the Keychain, then from the pending ones; the next launch retries. */
  const dropSecret = (id: string) =>
    secrets
      .remove(id)
      .then(() =>
        commit({ ...saved, pendingSecrets: saved.pendingSecrets.filter((each) => each !== id) }),
      )
      .catch(() => undefined);
  /**
   * Takes `id` out of the file and the owner, whose work on it is cancelled and closed before its
   * guide is erased, then its link out of the Keychain. A guide or link the disk or Keychain
   * keeps goes at the next launch.
   */
  const removed = async (id: string) => {
    if (!saved.guides.some((each) => each.id === id)) return;
    commit({
      ...saved,
      guides: saved.guides.filter((each) => each.id !== id),
      pendingSecrets: [...saved.pendingSecrets, id],
    });
    origins.delete(id);
    publish();
    await owner.forget(id);
    await dropSecret(id);
  };
  return {
    useLinks: () => useStore(shown),
    links: shown.get,
    useMappings: () => useStore(mapped),
    mappings: mapped.get,
    /**
     * At launch, before the native guide store restores: the saved guides' ids, which it keeps.
     * A file that doesn't read as one starts again empty.
     */
    load(): readonly string[] {
      const parsed = File()(read());
      saved = parsed instanceof type.errors ? EMPTY : parsed;
      origins.clear();
      publish();
      return saved.guides.map(({ id }) => id);
    },
    /** After the native store restored: removes links left pending, and signs each guide in. */
    restore: () =>
      serially(async () => {
        for (const id of saved.pendingSecrets)
          if (!saved.guides.some((each) => each.id === id)) await dropSecret(id);
        for (const { id } of saved.guides) {
          const link = await secrets.read(id).catch(() => null);
          if (link) origins.set(id, originFor(link));
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
        return added(link, name.trim() || null);
      }),
    /**
     * Gives guide `id` a new link: a new guide in its place, with its name, and `id` removed as
     * `remove` does, so nothing of the old link's guide or work stays.
     */
    replace: (id: string, link: string) =>
      serially(async (): Promise<GuideRefusal | null> => {
        const at = saved.guides.findIndex((each) => each.id === id);
        if (at === -1) return null;
        const refused = await added(link, saved.guides[at]!.name, at);
        if (!refused) await removed(id);
        return refused;
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
        const prefix = `${subscriptionId}:`;
        const kept = Object.entries(saved.mappings).filter(([key]) => !key.startsWith(prefix));
        if (kept.length === Object.keys(saved.mappings).length) return;
        commit({ ...saved, mappings: Object.fromEntries(kept) });
        publish();
      }),
  };
}

export const guides = createGuides();
