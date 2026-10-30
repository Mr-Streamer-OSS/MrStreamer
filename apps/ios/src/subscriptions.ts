import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { PlaylistMapping } from "@mrstreamer/contracts/playlist";
import { sha256Hex } from "@mrstreamer/core/sha256";
import { DEMO_ID } from "./demo.ts";
import { readJson, writeJson } from "./files.ts";
import type { SavedState } from "./storage.ts";

// The saved subscriptions, in the order they were added, in subscriptions.json in Documents.
// account.ts alone reads and writes it, one change at a time. Passwords stay in the Keychain under
// each subscription's id; the file holds no secret.
//
// Private beta 2 (0.1.0) kept its one subscription in state.json. The first launch since then
// makes this file from it, keeping its id, so its Keychain item, viewing record, watchlist and
// recent channels go on matching without being rewritten. state.json keeps that subscription as
// it was, for an older build to show, until it is removed.
//
// M3U playlists are kept apart in the file, under `playlists` and `retiredPlaylists`, which
// builds before them carry unchanged as fields they don't know: in `subscriptions` an older build
// couldn't read the file, and would start a new one. Each keeps its place among all of them
// (`position`), and an entry this build can't read, as a later one may write, goes back as it
// was. Their link is the Keychain item: the file holds its origin to show and a fingerprint
// (`playlistKey`) to know it again by.

const Xtream = lazy(() =>
  type({ id: "string", kind: "'xtream'", server: "string", username: "string" }),
);

const Playlist = lazy(() =>
  type({
    id: "string",
    kind: "'m3u'",
    /** The link's origin, to show and to say failures by. */
    server: "string",
    key: "string",
  }),
);

const Account = lazy(() => Xtream().or(Playlist()));

const Registry = lazy(() =>
  type({
    version: "1",
    /** In the order they were added: lists show their content in this order. */
    subscriptions: Xtream()
      .and({ name: "string | null" })
      .or(Playlist().and({ name: "string | null", "mapping?": PlaylistMapping() }))
      .array(),
    /**
     * Accounts removed with their history kept, the latest first. Adding one again takes its id
     * back, so its favourites, watchlist, history and progress return.
     */
    retired: Account().array(),
    /**
     * Ids whose Keychain item an add or a removal was writing or removing when the app last
     * stopped. Launch removes the item of any that isn't saved; nothing else in the Keychain is
     * touched.
     */
    pendingSecrets: "string[]",
    /**
     * Ids removed with their history whose history isn't all deleted yet: launch deletes it again
     * until it is. No subscription is given one of these ids meanwhile.
     */
    erasing: ["string[]", "=", () => []],
  }),
);

export type Registry = Infer<typeof Registry>;
export type SubscriptionEntry = Registry["subscriptions"][number];
export type PlaylistEntry = Extract<SubscriptionEntry, { kind: "m3u" }>;
type RetiredAccount = Registry["retired"][number];

/** How the file keeps a playlist: with where it stood among all the saved or retired ones. */
const SavedPlaylist = lazy(() =>
  Playlist().and({ name: "string | null", "mapping?": PlaylistMapping(), position: "number" }),
);
const RetiredPlaylist = lazy(() => Playlist().and({ position: "number" }));

const FILE = "subscriptions.json";
/** Removed accounts remembered for their history; older ones are forgotten. */
export const RETIRED_LIMIT = 16;

export const EMPTY_REGISTRY: Registry = {
  version: 1,
  subscriptions: [],
  retired: [],
  pendingSecrets: [],
  erasing: [],
};

export type DemoMarker =
  | { readonly kind: "absent" | "active" | "erasing" }
  | { readonly kind: "unreadable"; readonly raw: unknown };

export interface RegistryFile {
  readonly registry: Registry;
  readonly demo: DemoMarker;
  readonly opaque: Readonly<Record<string, unknown>>;
}

const DemoValue = lazy(() => type({ version: "1", state: "'active' | 'erasing'" }));

/** A bad demo field never invalidates the unchanged personal envelope. */
export function readRegistry(): RegistryFile | null {
  const read = readJson(FILE);
  if (!read || typeof read !== "object" || Array.isArray(read)) return null;
  const {
    version,
    subscriptions,
    retired,
    pendingSecrets,
    erasing,
    playlists,
    retiredPlaylists,
    ...extra
  } = read as Record<string, unknown>;
  const saved = readable(playlists, SavedPlaylist());
  const gone = readable(retiredPlaylists, RetiredPlaylist());
  const parsed = Registry()({
    version,
    subscriptions: withPlaylists(subscriptions, saved.read),
    retired: withPlaylists(retired, gone.read),
    pendingSecrets,
    ...(erasing === undefined ? {} : { erasing }),
  });
  if (parsed instanceof type.errors) return null;
  const { demo, ...rest } = extra;
  // Kept for the next write, which puts them back beside this build's own.
  const opaque = { ...rest, ...fields({ playlists: saved.unread, retiredPlaylists: gone.unread }) };
  const marker = DemoValue()(demo);
  return {
    registry: parsed,
    opaque,
    demo: !Object.hasOwn(extra, "demo")
      ? { kind: "absent" }
      : marker instanceof type.errors
        ? { kind: "unreadable", raw: demo }
        : { kind: marker.state },
  };
}

/** The entries of `list` that `schema` reads, and those it doesn't, as they are. */
function readable<A>(list: unknown, schema: (value: unknown) => A | type.errors) {
  const read: A[] = [];
  const unread: unknown[] = [];
  for (const each of Array.isArray(list) ? list : []) {
    const parsed = schema(each);
    if (parsed instanceof type.errors) unread.push(each);
    else read.push(parsed);
  }
  return { read, unread };
}

/** `accounts` as the file lists them, each playlist back where it stood among them. */
function withPlaylists(
  accounts: unknown,
  playlists: readonly { readonly position: number }[],
): unknown {
  if (!Array.isArray(accounts)) return accounts;
  const all: unknown[] = [...accounts];
  for (const { position, ...entry } of playlists.toSorted((a, b) => a.position - b.position))
    all.splice(position, 0, entry);
  return all;
}

/** Each playlist of `accounts` with its place among them. */
const placed = <A extends { readonly kind: string }>(accounts: readonly A[]) =>
  accounts.flatMap((entry, position) => (entry.kind === "m3u" ? [{ ...entry, position }] : []));

const listed = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** Replaces the file, carrying every unknown top-level field unchanged. */
export function writeRegistry({ registry, demo, opaque }: RegistryFile): void {
  const { subscriptions, retired } = registry;
  writeJson(FILE, {
    ...opaque,
    ...registry,
    subscriptions: subscriptions.filter((entry) => entry.kind === "xtream"),
    retired: retired.filter((entry) => entry.kind === "xtream"),
    ...fields({
      playlists: [...placed(subscriptions), ...listed(opaque["playlists"])],
      retiredPlaylists: [...placed(retired), ...listed(opaque["retiredPlaylists"])],
    }),
    ...(demo.kind === "absent"
      ? {}
      : {
          demo: demo.kind === "unreadable" ? demo.raw : { version: 1, state: demo.kind },
        }),
  });
}

/** The lists that hold something: a file without playlists is as builds before them wrote it. */
const fields = (lists: Record<string, readonly unknown[]>) =>
  Object.fromEntries(Object.entries(lists).filter(([, list]) => list.length > 0));

/** A personal account with the reserved id always keeps its ordinary restore and erase paths. */
export const demoConflict = (registry: Registry): boolean =>
  [...registry.subscriptions, ...registry.retired].some((entry) => entry.id === DEMO_ID) ||
  registry.erasing.includes(DEMO_ID) ||
  registry.pendingSecrets.includes(DEMO_ID);

type Identity =
  | Pick<Extract<RetiredAccount, { kind: "xtream" }>, "kind" | "server" | "username">
  | Pick<Extract<RetiredAccount, { kind: "m3u" }>, "kind" | "key">;

/**
 * One account per server and username, or per playlist link: adding it again updates the one
 * saved. A playlist given a new link stays the account it was.
 */
export function sameAccount(a: Identity, b: Identity): boolean {
  return a.kind === "xtream"
    ? b.kind === "xtream" && a.server === b.server && a.username === b.username
    : b.kind === "m3u" && a.key === b.key;
}

/** What tells a playlist link from others without the link, as the desktop app's key does. */
export const playlistKey = (link: string): string => `m3u:${sha256Hex(link).slice(0, 16)}`;

/** The registry beta 2's state.json describes: its one subscription, under its own id. */
export function migrated(state: SavedState): Registry {
  const { subscription } = state;
  return subscription
    ? {
        ...EMPTY_REGISTRY,
        subscriptions: [{ ...subscription, kind: "xtream", name: null }],
      }
    : EMPTY_REGISTRY;
}

/** The registry without `entry`, its account kept in `retired` unless its history goes too. */
export function withoutSubscription(
  registry: Registry,
  entry: SubscriptionEntry,
  keepHistory: boolean,
): Registry {
  const account: RetiredAccount =
    entry.kind === "xtream"
      ? { id: entry.id, kind: entry.kind, server: entry.server, username: entry.username }
      : { id: entry.id, kind: entry.kind, server: entry.server, key: entry.key };
  const others = registry.retired.filter(
    (each) => each.id !== entry.id && !sameAccount(each, entry),
  );
  return {
    ...registry,
    subscriptions: registry.subscriptions.filter((each) => each.id !== entry.id),
    retired: keepHistory ? [account, ...others].slice(0, RETIRED_LIMIT) : others,
    pendingSecrets: withPending(registry.pendingSecrets, entry.id),
    erasing: keepHistory ? registry.erasing : withPending(registry.erasing, entry.id),
  };
}

export const withPending = (pending: readonly string[], id: string): string[] => [
  ...pending.filter((each) => each !== id),
  id,
];

export const withoutPending = (pending: readonly string[], id: string): string[] =>
  pending.filter((each) => each !== id);

/**
 * A new subscription id: no colon (`ownedKey`), and none saved, retired or with a history still
 * being deleted has it.
 */
export function newSubscriptionId(
  registry: Registry,
  now: number,
  kind: SubscriptionEntry["kind"] = "xtream",
): string {
  const taken = new Set([
    ...[...registry.subscriptions, ...registry.retired].map((each) => each.id),
    ...registry.erasing,
  ]);
  const base = `${kind}-${now.toString(36)}`;
  let id = base;
  for (let next = 2; taken.has(id); next++) id = `${base}-${next}`;
  return id;
}
