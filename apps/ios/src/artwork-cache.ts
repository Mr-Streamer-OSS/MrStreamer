import { Directory, DownloadTask, File, Paths } from "expo-file-system";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { exposes, URL_LENGTH } from "./login-safety.ts";
import { onSignedIn, signedIn, type Source } from "./sources.ts";

// Channel logos and title pictures on disk, so they show again after a relaunch and offline.
// React Native's Image only ever gets a file here: its own loader would fetch through iOS's shared
// URL cache, which keeps answers on disk under their address, login and all.
//
// Each picture is fetched by expo-file-system's DownloadTask on its foreground session, which
// keeps no URL cache, into a file of a fresh random name; one too big, cut short or answered with
// an error leaves no file. An address that carries no current login (login-safety.ts `exposes`)
// goes to Caches/artwork and into its index, `index.json`, written beside itself and then moved
// over itself, a moment after a change. One that carries a login goes to Caches/artwork-session,
// which the index never names and the first use after a launch empties, and its file goes as soon
// as that login is replaced or removed. An address of a login that went is never asked for again
// in this process, and a fetch of it that ends after is thrown away.
//
// The cache holds 160 MiB and 6,000 pictures, of at most 5 MiB each, the least recently shown
// going first; one unseen for 60 days goes at the next launch, and one shown after 30 days is
// fetched again while the old file shows. Four fetches run at once, one per address, each for at
// most 15 seconds; a picture no one shows any more before its fetch starts isn't fetched. A failed
// fetch, or a fetched file that won't draw, shows the fallback, and the address is asked for again
// after five minutes or a relaunch. A download's own file (`file://`) shows as it is.

const MAX_BYTES = 160 * 1024 * 1024;
const MAX_FILES = 6000;
const MAX_FILE = 5 * 1024 * 1024;
const DAY = 86_400_000;
const REFRESH_MS = 30 * DAY;
const UNUSED_MS = 60 * DAY;
const TRANSFERS = 4;
const TIMEOUT_MS = 15_000;
/** How long an address that failed isn't asked for again. */
const FAILED_MS = 5 * 60_000;
/** How long after a change the index is written. */
const SAVE_MS = 5_000;
/** How stale a kept picture's last showing may be before showing it again rewrites the index. */
const TOUCH_MS = 60 * 60_000;
/** How long after the first use files the index doesn't name are deleted, and how many a task. */
const SWEEP_MS = 10_000;
const SWEEP_SLICE = 32;
const VERSION = 1;
/** A picture's file name, as `fresh` makes them. */
const NAME = /^[a-z0-9]+-[a-z0-9]+$/;
const INDEX = "index.json";
const PENDING_INDEX = "index.json.next";

type Waiting =
  { readonly kind: "none" } | { readonly kind: "pending" } | { readonly kind: "failed" };
type Kept = { readonly kind: "shown"; readonly uri: string };
type ArtworkState = Waiting | Kept;

/**
 * What a picture shows: nothing to show, its fetch still to finish, its fallback, or its file,
 * with what the Image calls when the file won't draw.
 */
export type Picture = Waiting | (Kept & { readonly broke: () => void });

const NONE = { kind: "none" } as const;
const PENDING = { kind: "pending" } as const;
const FAILED = { kind: "failed" } as const;

interface Entry {
  /** Its file's name, in Caches/artwork, or Caches/artwork-session when `exposed` has any. */
  readonly name: string;
  readonly bytes: number;
  readonly fetchedAt: number;
  usedAt: number;
  /** The sources whose login its address carries; none for a picture the index keeps. */
  readonly exposed: readonly Source[];
  /** Fetched by this process: a file that won't draw fails the address rather than refetching. */
  readonly fresh: boolean;
  /** What shows, once its file was found whole in this process. */
  shown: Kept | null;
}

/** One address shown somewhere, while anything shows it. */
interface Slot {
  state: ArtworkState;
  readonly listeners: Set<() => void>;
  /** The sources whose login its address carries, worked out once it needs fetching. */
  exposed: readonly Source[] | null;
}

const kept = () => new Directory(Paths.cache, "artwork");
const session = () => new Directory(Paths.cache, "artwork-session");

let phase: "idle" | "loading" | "ready" = "idle";
/** Every picture on disk by its address, least recently shown first. */
const entries = new Map<string, Entry>();
let total = 0;
const slots = new Map<string, Slot>();
/** Addresses to fetch, in the order asked. */
const queue = new Set<string>();
/** Addresses being fetched, with the file each goes to. */
const running = new Map<string, string>();
/** When each address last failed. */
const failures = new Map<string, number>();
/** Addresses of logins replaced or removed: none is asked for again in this process. */
const retired = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = Promise.resolve();
let made = 0;

/** A file name no picture had: the time, a counter and a few random letters. */
const fresh = () =>
  `${Date.now().toString(36)}-${(made++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const fileOf = ({ name, exposed }: Entry) =>
  new File(exposed.length > 0 ? session() : kept(), name);

/** Whether the cache may ask for `url`: a plain http(s) address of at most 2048 characters. */
function fetchable(url: string): boolean {
  if (url.length > URL_LENGTH) return false;
  const parsed = URL.parse(url);
  return (
    parsed !== null &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/** The signed-in sources whose login `url` gives away. */
const exposersOf = (url: string): readonly Source[] =>
  signedIn().filter(({ login: [username = "", password = ""] }) =>
    exposes(url, { username, password }),
  );

function failedLately(url: string): boolean {
  const at = failures.get(url);
  if (at === undefined) return false;
  if (Date.now() - at < FAILED_MS) return true;
  failures.delete(url);
  return false;
}

function fail(url: string) {
  failures.set(url, Date.now());
  // Oldest first: past a few thousand, the oldest are asked for again sooner.
  for (const old of failures.keys()) {
    if (failures.size <= MAX_FILES) break;
    failures.delete(old);
  }
}

/** Deletes a file, or leaves it to the sweep or the session folder's emptying when it won't go. */
function discard(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {
    // Left for later.
  }
}

/** The entry of `url` whose file is whole, checked once a process; a missing one is forgotten. */
function usable(url: string): Entry | undefined {
  const entry = entries.get(url);
  if (!entry || entry.shown) return entry;
  const file = fileOf(entry);
  if (file.exists && file.size === entry.bytes) {
    entry.shown = { kind: "shown", uri: file.uri };
    return entry;
  }
  forget(url, entry);
  return undefined;
}

/** What `url` shows, with nothing fetched or changed but a missing file forgotten. */
function judge(url: string): ArtworkState {
  if (retired.has(url) || !fetchable(url)) return FAILED;
  const shown = phase === "ready" ? usable(url)?.shown : null;
  if (shown) return shown;
  return failedLately(url) ? FAILED : PENDING;
}

function update(slot: Slot, state: ArtworkState) {
  if (slot.state === state) return;
  slot.state = state;
  for (const listener of slot.listeners) listener();
}

function forget(url: string, entry: Entry) {
  entries.delete(url);
  total -= entry.bytes;
  discard(fileOf(entry));
  if (entry.exposed.length === 0) save();
}

/** Moves the entry last in line; the index learns of it with the next write, or within an hour. */
function touch(url: string, entry: Entry) {
  const now = Date.now();
  if (entry.exposed.length === 0 && now - entry.usedAt > TOUCH_MS) save();
  entry.usedAt = now;
  entries.delete(url);
  entries.set(url, entry);
}

/** Least recently shown first, past the budget, leaving what shows now. */
function evict() {
  for (const [url, entry] of entries) {
    if (total <= MAX_BYTES && entries.size <= MAX_FILES) return;
    if (!slots.has(url)) forget(url, entry);
  }
}

/** Shows what `url` has now, and queues its fetch when it has nothing, or a picture to refresh. */
function want(url: string, slot: Slot) {
  update(slot, judge(url));
  if (phase !== "ready" || slot.state === FAILED || running.has(url)) return;
  const entry = entries.get(url);
  if (entry && (entry.exposed.length > 0 || Date.now() - entry.fetchedAt < REFRESH_MS)) return;
  if (entry && failedLately(url)) return;
  slot.exposed ??= exposersOf(url);
  queue.add(url);
  pump();
}

function pump() {
  for (const url of queue) {
    if (running.size >= TRANSFERS) return;
    queue.delete(url);
    const slot = slots.get(url);
    if (slot?.exposed && !running.has(url)) void fetchArt(url, slot.exposed);
  }
}

/** The file's size once it is whole; throws when it failed, timed out or grew past 5 MiB. */
async function download(url: string, file: File): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const task = new DownloadTask(url, file, {
    sessionType: "foreground",
    signal: controller.signal,
    onProgress: ({ bytesWritten, totalBytes }) => {
      if (bytesWritten > MAX_FILE || totalBytes > MAX_FILE) controller.abort();
    },
  });
  try {
    const done = await task.downloadAsync();
    const bytes = done?.size ?? 0;
    if (bytes < 1 || bytes > MAX_FILE) throw new Error("Not a picture the cache keeps");
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchArt(url: string, exposed: readonly Source[]) {
  const folder = exposed.length > 0 ? session() : kept();
  const file = new File(folder, fresh());
  running.set(url, file.name);
  let bytes: number | null = null;
  try {
    folder.create({ intermediates: true, idempotent: true });
    bytes = await download(url, file);
  } catch {
    // Failed: nothing kept.
  }
  running.delete(url);
  settle(url, exposed, file, bytes);
  pump();
}

/**
 * Keeps a finished fetch, unless the login its address carried went meanwhile, or its address
 * now carries one it was fetched without.
 */
function settle(url: string, exposed: readonly Source[], file: File, bytes: number | null) {
  const current = signedIn();
  const gone = retired.has(url) || exposed.some((source) => !current.includes(source));
  if (gone || bytes === null || (exposed.length === 0 && exposersOf(url).length > 0)) {
    discard(file);
    if (gone && exposed.length > 0) retired.add(url);
    else if (bytes === null) fail(url);
    const slot = slots.get(url);
    if (slot) {
      slot.exposed = null;
      want(url, slot);
    }
    return;
  }
  const previous = entries.get(url);
  if (previous) forget(url, previous);
  const now = Date.now();
  entries.set(url, {
    name: file.name,
    bytes,
    fetchedAt: now,
    usedAt: now,
    exposed,
    fresh: true,
    shown: { kind: "shown", uri: file.uri },
  });
  total += bytes;
  failures.delete(url);
  evict();
  if (exposed.length === 0) save();
  const slot = slots.get(url);
  if (slot) update(slot, judge(url));
}

/** Writes the index a moment after a change, one write at a time. */
function save() {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saving = saving.then(write);
  }, SAVE_MS);
}

async function write() {
  const rows: Row[] = [];
  for (const [url, { name, bytes, fetchedAt, usedAt, exposed }] of entries) {
    if (exposed.length === 0) rows.push([url, name, bytes, fetchedAt, usedAt]);
  }
  try {
    kept().create({ intermediates: true, idempotent: true });
    const pending = new File(kept(), PENDING_INDEX);
    pending.create({ overwrite: true });
    await pending.write(JSON.stringify({ version: VERSION, entries: rows }));
    await pending.move(new File(kept(), INDEX), { overwrite: true });
  } catch {
    // The next change writes it again; a launch without it starts over.
  }
}

type Row = readonly [url: string, name: string, bytes: number, fetchedAt: number, usedAt: number];

const isRow = (row: unknown): row is Row =>
  Array.isArray(row) &&
  row.length === 5 &&
  typeof row[0] === "string" &&
  row[0].length <= URL_LENGTH &&
  /^https?:\/\//.test(row[0]) &&
  typeof row[1] === "string" &&
  NAME.test(row[1]) &&
  Number.isInteger(row[2]) &&
  row[2] > 0 &&
  row[2] <= MAX_FILE &&
  Number.isFinite(row[3]) &&
  Number.isFinite(row[4]);

/** The index's rows that check out, least recently shown first; none when it won't read. */
async function readIndex(): Promise<readonly Row[]> {
  for (const name of [INDEX, PENDING_INDEX]) {
    try {
      const file = new File(kept(), name);
      if (!file.exists) continue;
      const value: unknown = JSON.parse(await file.text());
      if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === VERSION &&
        "entries" in value &&
        Array.isArray(value.entries)
      ) {
        return value.entries.filter(isRow);
      }
    } catch {
      // Unreadable: try the other, then start again.
    }
  }
  return [];
}

async function load() {
  const rows = await readIndex();
  const now = Date.now();
  for (const [url, name, bytes, fetchedAt, usedAt] of rows) {
    // Unseen too long: left out, and its file to the sweep.
    if (now - usedAt > UNUSED_MS) continue;
    const previous = entries.get(url);
    if (previous) total -= previous.bytes;
    entries.delete(url);
    entries.set(url, { name, bytes, fetchedAt, usedAt, exposed: [], fresh: false, shown: null });
    total += bytes;
  }
  if (rows.length !== entries.size) save();
  evict();
}

/** Deletes files of Caches/artwork the index doesn't name, a few a task. */
function sweep() {
  let names: string[];
  try {
    names = kept().exists
      ? kept()
          .list()
          .map((each) => each.name)
      : [];
  } catch {
    return;
  }
  const known = new Set([INDEX, PENDING_INDEX, ...running.values()]);
  for (const entry of entries.values()) known.add(entry.name);
  const stale = names.filter((name) => !known.has(name));
  const step = () => {
    for (const name of stale.splice(0, SWEEP_SLICE)) discard(new File(kept(), name));
    if (stale.length > 0) setTimeout(step, 0);
  };
  step();
}

/** A login replaced or removed: its pictures go now, and its addresses aren't asked for again. */
function retire() {
  const current = signedIn();
  const went = (exposed: readonly Source[] | null) =>
    exposed?.some((source) => !current.includes(source)) ?? false;
  for (const [url, entry] of entries) {
    if (!went(entry.exposed)) continue;
    retired.add(url);
    forget(url, entry);
  }
  for (const [url, slot] of slots) {
    if (went(slot.exposed)) {
      retired.add(url);
      queue.delete(url);
    }
    if (retired.has(url)) update(slot, FAILED);
  }
}

/** Once a process: empties the session folder, reads the index, and starts what waited for it. */
function start() {
  if (phase !== "idle") return;
  phase = "loading";
  try {
    const folder = session();
    if (folder.exists) folder.delete();
  } catch {
    // Left for the next launch.
  }
  onSignedIn(retire);
  const ready = () => {
    phase = "ready";
    for (const [url, slot] of slots) want(url, slot);
    setTimeout(sweep, SWEEP_MS);
  };
  void load().then(ready, ready);
}

function watch(url: string, listener: () => void): () => void {
  start();
  let slot = slots.get(url);
  if (!slot) {
    slot = { state: judge(url), listeners: new Set(), exposed: null };
    slots.set(url, slot);
  }
  const own = slot;
  own.listeners.add(listener);
  const entry = phase === "ready" ? entries.get(url) : undefined;
  if (entry) touch(url, entry);
  want(url, own);
  return () => {
    own.listeners.delete(listener);
    if (own.listeners.size > 0 || slots.get(url) !== own) return;
    slots.delete(url);
    queue.delete(url);
  };
}

const stateOf = (url: string): ArtworkState => slots.get(url)?.state ?? judge(url);

/** The file of `url`, `uri`, won't draw: it goes, and the address is fetched again or fails. */
function wontDraw(url: string, uri: string) {
  const entry = entries.get(url);
  if (!entry || entry.shown?.uri !== uri) return;
  forget(url, entry);
  if (entry.fresh) fail(url);
  const slot = slots.get(url);
  if (slot) want(url, slot);
}

/**
 * The picture at `url` as a file to show: from the cache, once fetched, or as it is for a
 * download's own `file://`. Null shows nothing.
 */
export function useArtwork(url: string | null): Picture {
  const remote = url !== null && !url.startsWith("file://") ? url : null;
  const subscribe = useCallback(
    (listener: () => void) => (remote === null ? () => undefined : watch(remote, listener)),
    [remote],
  );
  const state = useSyncExternalStore(subscribe, () => (remote === null ? NONE : stateOf(remote)));
  // The file that wouldn't draw here: a download's own stays failed, the cache's is replaced.
  const [broken, setBroken] = useState<string | null>(null);
  return useMemo((): Picture => {
    const picture = (uri: string): Picture =>
      uri === broken
        ? FAILED
        : {
            kind: "shown",
            uri,
            broke: () => {
              setBroken(uri);
              if (remote !== null) wontDraw(remote, uri);
            },
          };
    if (remote === null) return url === null ? NONE : picture(url);
    return state.kind === "shown" ? picture(state.uri) : state;
  }, [url, remote, state, broken]);
}
