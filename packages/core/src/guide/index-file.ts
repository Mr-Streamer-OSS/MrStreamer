// A guide document's programmes on disk: one SQLite file per downloaded document, written once
// by `buildGuideIndex` and only read after that. The app builds it in a worker thread, from the
// document as it was saved, and the main process reads only what a view asks for: a screen of
// channels now and next, a channel's schedule, a page of a grid, the programmes a search finds.
// What stays in memory while a guide is in use is its channels, about 200 bytes each.
//
// Programmes are kept by guide channel and start (`programme`, its primary key), in time order
// and without overlaps, as `timeline` below lays them out. Titles are kept once each, folded for
// search, and the (title, start) index finds a search's programmes in time order without reading
// the others.
// Ended programmes stay for the guide's archive window, so catch-up and a grid can show the
// past; the next download of the same source brings along the past its document no longer
// lists, on the channels it still has, and drops what fell out of the window.
//
// A file is never changed once written: it is replaced by another. So it is read without locks,
// by as many connections as like, and a reader that pauses half way, as a search does to let
// other work in, finds it as it was.
import { rename, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { GuideFailure, Listing, Programme } from "@mrstreamer/contracts/guide";
import { normalize } from "../text.ts";
import { xmltvDocument } from "./document.ts";
import { GUIDE_LIMITS, type GuideLimits } from "./limits.ts";
import { xmltvReader, type XmltvProgramme } from "./xmltv.ts";

/** The layout of the files this release writes. A file of another is read as no guide. */
const VERSION = 1;
/** Programmes written per transaction while a document is read. */
const BATCH = 5_000;
/** How often the build says how far it got. */
const PROGRESS_MS = 200;
/** Titles the build remembers the key of; past that it asks the file. */
const TITLE_CACHE = 100_000;
/** A read on the main process lets other work in once it has run this long. */
const SLICE_MS = 8;
/** How far past `at` each stretch a search reads ends: six hours, a day, four days, then all. */
const STRETCHES = [6, 24, 96].map((hours) => hours * 60 * 60 * 1000);
/** Titles one read of a search looks up together. */
const TITLES_AT_ONCE = 1_000;

/** What `buildGuideIndex` reads and writes. Paths are absolute. */
export interface GuideBuild {
  /** The document as it was downloaded or kept: XMLTV, packed with gzip or not. */
  readonly document: string;
  /** Where the index goes. It is there, whole, once the build succeeds, and not before. */
  readonly target: string;
  /**
   * The index of the same source before this one, or null. The past it keeps that this document
   * no longer lists comes along, within the archive window.
   */
  readonly previous: string | null;
  /** Epoch milliseconds the document was downloaded at: what ends later is still to come. */
  readonly since: number;
  /** How long ended programmes are kept, in milliseconds. */
  readonly archive: number;
  /**
   * For a document from an address the viewer gave: it must be one whole `<tv>` from its
   * opening tag to its closing one, with a programme still to come. A provider's own guide is
   * taken as it is sent, as it always was.
   */
  readonly strict: boolean;
  readonly limits?: GuideLimits;
}

/** What a build wrote. */
export interface GuideIndexSummary {
  /** Channels the guide lists. */
  readonly channels: number;
  readonly programmes: number;
  /** When its last programme ends, or null without one. */
  readonly until: number | null;
}

/**
 * Indexes the document at `build.document` into `build.target`, telling `progress` how many
 * programmes it has read as it goes. Fails, writing nothing, when the document lists no
 * programmes, is past one of the limits, or, when strict, isn't a whole guide with something to
 * come. Takes as long as the document does to read: the app runs it in a worker thread.
 */
export async function buildGuideIndex(
  build: GuideBuild,
  progress: (programmes: number) => void,
): Promise<GuideIndexSummary> {
  const { since, strict, limits = GUIDE_LIMITS } = build;
  const cutoff = since - build.archive;
  const part = `${build.target}.part`;
  await rm(part, { force: true });
  const db = new DatabaseSync(part);
  try {
    db.exec(`
      pragma journal_mode = off;
      pragma synchronous = off;
      pragma main.locking_mode = exclusive;
      pragma cache_size = -16000;
      create table channel (
        key integer primary key,
        id text not null unique,
        name text not null,
        folded text not null,
        position integer not null default 0,
        until integer
      );
      create table title (key integer primary key, text text not null unique, folded text not null);
      create table programme (
        channel integer not null,
        start integer not null,
        stop integer,
        title integer not null,
        description text,
        primary key (channel, start)
      ) without rowid;
      create table meta (programmes integer not null, until integer, longest integer);
    `);
    const channels = new Map<string, { key: number; name: string | null }>();
    const listed = (id: string, name: string | null) => {
      const known = channels.get(id);
      if (known) {
        // A name given later, or again, stands; programmes alone name a channel by its id.
        if (name !== null) known.name = name;
        return known.key;
      }
      if (channels.size === limits.channels)
        throw failure({ kind: "too-large", limit: "channels" });
      const entry = { key: channels.size + 1, name };
      channels.set(id, entry);
      return entry.key;
    };

    const insertTitle = db.prepare("insert into title (text, folded) values (?, ?)");
    const findTitle = db.prepare("select key from title where text = ?");
    const titles = new Map<string, number>();
    const titleKey = (text: string) => {
      const cached = titles.get(text);
      if (cached !== undefined) return cached;
      const found = findTitle.get(text)?.["key"];
      const key =
        typeof found === "number"
          ? found
          : Number(insertTitle.run(text, normalize(text)).lastInsertRowid);
      if (titles.size === TITLE_CACHE) titles.clear();
      titles.set(text, key);
      return key;
    };
    // Duplicates of a start time count once: the first the document lists.
    const insertProgramme = db.prepare("insert or ignore into programme values (?, ?, ?, ?, ?)");
    let batch: XmltvProgramme[] = [];
    let read = 0;
    let told = performance.now();
    const flush = () => {
      db.exec("begin");
      for (const entry of batch) {
        insertProgramme.run(
          listed(entry.channel, null),
          entry.start,
          entry.stop,
          titleKey(entry.title),
          entry.description,
        );
      }
      db.exec("commit");
      batch = [];
      if (performance.now() - told >= PROGRESS_MS) {
        told = performance.now();
        progress(read);
      }
    };
    const reader = xmltvReader(
      {
        channel: ({ id, name }) => void listed(id, name),
        programme(entry) {
          read++;
          if (entry.stop !== null && entry.stop <= cutoff) return;
          // Counted as it comes, so a guide past the limit stops here rather than at its end.
          listed(entry.channel, null);
          batch.push(entry);
          if (batch.length === BATCH) flush();
        },
      },
      limits.elementBytes,
    );
    const file = createReadStream(build.document, { highWaterMark: 64 * 1024 });
    for await (const chunk of xmltvDocument(file, limits.bytes)) reader.push(chunk);
    flush();
    progress(read);
    const ending = reader.end();
    if (strict && ending !== "whole") throw failure({ kind: ending });
    if (read === 0) throw failure({ kind: "empty" });

    timeline(db, cutoff);
    if (strict) {
      const last = db.prepare("select max(stop) as until from programme").get()?.["until"];
      if (typeof last !== "number" || last <= since) throw failure({ kind: "ended" });
    }
    const insertChannel = db.prepare(
      "insert into channel (key, id, name, folded) values (?, ?, ?, ?)",
    );
    db.exec("begin");
    for (const [id, { key, name }] of channels) {
      const shown = name ?? id;
      insertChannel.run(key, id, shown, `${normalize(shown)}\n${id.toLowerCase()}`);
    }
    db.exec("commit");
    if (build.previous) carry(db, build.previous, cutoff);
    finish(db);
    const summary = db.prepare("select programmes, until from meta").get();
    const result: GuideIndexSummary = {
      channels: Number(db.prepare("select count(*) as n from channel").get()?.["n"] ?? 0),
      programmes: Number(summary?.["programmes"] ?? 0),
      until: typeof summary?.["until"] === "number" ? summary["until"] : null,
    };
    db.close();
    await rename(part, build.target);
    return result;
  } catch (cause) {
    if (db.isOpen) db.close();
    await rm(part, { force: true });
    throw cause;
  }
}

/**
 * Lays each channel's programmes out in time order, without overlaps: a programme without an
 * end runs until the next one starts, one that starts before the previous one ends cuts it
 * short, and one without an end and nothing after it is dropped. Then drops what ended before
 * `cutoff`.
 */
function timeline(db: DatabaseSync, cutoff: number) {
  db.exec("begin");
  db.prepare(
    `
    update programme set stop = later.next
    from (
      select channel, start, lead(start) over (partition by channel order by start) as next
      from programme
    ) as later
    where programme.channel = later.channel and programme.start = later.start
      and later.next is not null and (programme.stop is null or programme.stop > later.next)
  `,
  ).run();
  db.prepare("delete from programme where stop is null or stop <= ?").run(cutoff);
  db.exec("commit");
}

/**
 * Brings along what the index before, at `previous`, keeps of the past that the new document no
 * longer lists: on each channel the document has programmes for, what starts before its first
 * one there, cut short where that one begins. A channel the document no longer has programmes
 * for goes, past and all: the guide no longer vouches for it. An index of another layout brings
 * nothing.
 */
function carry(db: DatabaseSync, previous: string, cutoff: number) {
  db.prepare("attach database ? as old").run(previous);
  try {
    if (db.prepare("pragma old.user_version").get()?.["user_version"] !== VERSION) return;
    db.exec(`
      begin;
      create temp table opening as
        select channel.key, channel.id, min(programme.start) as start
        from main.programme join main.channel on channel.key = programme.channel
        group by programme.channel;
    `);
    db.prepare(
      `
      insert or ignore into title (text, folded)
      select text, folded from old.title
      where key in (select distinct title from old.programme where stop > ?)
    `,
    ).run(cutoff);
    db.prepare(
      `
      insert or ignore into programme (channel, start, stop, title, description)
      select opening.key, programme.start, min(programme.stop, opening.start), title.key,
        programme.description
      from temp.opening as opening
      join old.channel as was on was.id = opening.id
      join old.programme as programme on programme.channel = was.key
      join old.title as named on named.key = programme.title
      join title on title.text = named.text
      where programme.stop > ? and programme.start < opening.start
    `,
    ).run(cutoff);
    db.exec("drop table temp.opening; commit;");
  } finally {
    db.exec("detach database old");
  }
}

/** Notes when each channel's last programme ends, orders the channels by name and indexes titles. */
function finish(db: DatabaseSync) {
  db.exec(`
    begin;
    update channel set until = (select max(stop) from programme where programme.channel = channel.key);
    commit;
  `);
  // By name, whatever its case and accents, then by id, as JavaScript compares the folded text.
  const order = db
    .prepare("select key, folded from channel")
    .all()
    .map((row) => ({ key: Number(row["key"]), folded: String(row["folded"]) }))
    .sort((a, b) => (a.folded < b.folded ? -1 : a.folded > b.folded ? 1 : 0));
  const place = db.prepare("update channel set position = ? where key = ?");
  db.exec("begin");
  for (const [position, { key }] of order.entries()) place.run(position, key);
  db.exec(`
    commit;
    create index programme_title on programme (title, start);
    insert into meta select count(*), max(stop), max(stop - start) from programme;
    pragma user_version = ${VERSION};
  `);
}

function failure(failure: GuideFailure): AppFailure {
  return new AppFailure({ kind: "guide", failure });
}

/** A channel as an index lists it. */
export interface IndexedChannel {
  /** What the file names it by. */
  readonly key: number;
  /** The id programmes name it by, exactly as the guide writes it. */
  readonly id: string;
  /** The name the guide gives it, or its id where it names none. */
  readonly name: string;
  /** Its name folded, then its id in lower case on a line of its own: what search compares. */
  readonly folded: string;
  /** When its last programme ends, or null when the guide has none for it. */
  readonly until: number | null;
}

/** A programme a search found, with where it is kept, before it is read whole. */
export interface FoundProgramme {
  readonly channel: number;
  readonly start: number;
  readonly stop: number;
  readonly title: string;
}

/** An index opened to read. */
export interface GuideIndex {
  /** Every channel the guide lists, by its id, in name order. */
  readonly channels: ReadonlyMap<string, IndexedChannel>;
  /** The channel the file names by `key`. */
  channel(key: number): IndexedChannel | undefined;
  readonly programmes: number;
  /** When its last programme ends, or null without one. */
  readonly until: number | null;
  /** What `channel` shows at `at` and next, or null when it shows nothing from then on. */
  listing(channel: IndexedChannel, at: number): Listing | null;
  /** The programme on `channel` at `at`, if any, and every one after it. */
  schedule(channel: IndexedChannel, at: number): readonly Programme[];
  /** The programmes on `channel` that overlap [from, to), in time order. */
  range(channel: IndexedChannel, from: number, to: number): readonly Programme[];
  /** The programme `found` names, whole. */
  programme(found: FoundProgramme): Programme | null;
  /**
   * The programmes whose title has each of `words`, that haven't ended at `at` and start before
   * `before()`, handed to `visit` in no particular order. `before` is asked again between
   * stretches of time, so a search that has found enough reads no further. Lets other work in
   * now and then: it holds the process a few milliseconds at a time, however much it finds.
   */
  matching(
    words: readonly string[],
    at: number,
    before: () => number,
    visit: (found: FoundProgramme) => void,
  ): Promise<void>;
  /** Closes the file once the reads under way are done, so it can go. */
  release(): Promise<void>;
}

/**
 * Opens the index at `path` to read, or answers null when it isn't one this release can read.
 * Reads its channels a slice at a time.
 */
export async function openGuideIndex(path: string): Promise<GuideIndex | null> {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
  try {
    if (db.prepare("pragma user_version").get()?.["user_version"] !== VERSION) {
      db.close();
      return null;
    }
    const meta = db.prepare("select programmes, until, longest from meta").get();
    const channels = new Map<string, IndexedChannel>();
    const byKey: IndexedChannel[] = [];
    const slice = slicer();
    for (const row of db
      .prepare("select key, id, name, folded, until from channel order by position")
      .iterate()) {
      const channel: IndexedChannel = {
        key: Number(row["key"]),
        id: String(row["id"]),
        name: String(row["name"]),
        folded: String(row["folded"]),
        until: typeof row["until"] === "number" ? row["until"] : null,
      };
      channels.set(channel.id, channel);
      byKey[channel.key] = channel;
      if (slice.due()) await slice.rest();
    }
    return reader(db, {
      channels,
      byKey,
      programmes: Number(meta?.["programmes"] ?? 0),
      until: typeof meta?.["until"] === "number" ? meta["until"] : null,
      longest: Number(meta?.["longest"] ?? 0),
    });
  } catch {
    db.close();
    return null;
  }
}

function reader(
  db: DatabaseSync,
  read: {
    channels: Map<string, IndexedChannel>;
    byKey: readonly IndexedChannel[];
    programmes: number;
    until: number | null;
    /** How long the longest programme runs: one on at a time began no longer ago than that. */
    longest: number;
  },
): GuideIndex {
  // From the programme on at `at`, if any: the last to start by then, which may have ended.
  const from = `
    select programme.start, programme.stop, title.text as title, programme.description
    from programme join title on title.key = programme.title
    where programme.channel = :channel
      and programme.start >= ifnull(
        (select max(start) from programme where channel = :channel and start <= :at),
        -9007199254740991
      )`;
  const listing = db.prepare(`${from} order by programme.start limit 3`);
  const schedule = db.prepare(`${from} order by programme.start`);
  const range = db.prepare(`${from} and programme.start < :to order by programme.start`);
  const one = db.prepare(`
    select programme.start, programme.stop, title.text as title, programme.description
    from programme join title on title.key = programme.title
    where programme.channel = ? and programme.start = ?`);
  /** Reads under way, and whether the file closes once they are done. */
  let active = 0;
  let closing: PromiseWithResolvers<void> | null = null;
  const closed = () => {
    if (active > 0 || !closing) return;
    if (db.isOpen) db.close();
    closing.resolve();
  };
  const unended = (rows: Record<string, unknown>[], at: number) =>
    rows.map(programmeOf).filter((programme) => programme.stop > at);
  return {
    channels: read.channels,
    channel: (key) => read.byKey[key],
    programmes: read.programmes,
    until: read.until,
    listing(channel, at) {
      const [first, second = null] = unended(listing.all({ channel: channel.key, at }), at);
      if (!first) return null;
      return first.start <= at ? { now: first, next: second } : { now: null, next: first };
    },
    schedule: (channel, at) => unended(schedule.all({ channel: channel.key, at }), at),
    range: (channel, at, to) => unended(range.all({ channel: channel.key, at, to }), at),
    programme(found) {
      const row = one.get(found.channel, found.start);
      return row ? programmeOf(row) : null;
    },
    async matching(words, at, before, visit) {
      if (words.length === 0 || closing) return;
      active++;
      try {
        const slice = slicer();
        const titles: number[] = [];
        const which = db.prepare(
          `select key from title where ${words.map(() => "instr(folded, ?) > 0").join(" and ")}`,
        );
        for (const row of which.iterate(...words)) {
          titles.push(Number(row["key"]));
          if (slice.due()) await slice.rest();
        }
        // Read in stretches of time, from what can still be on at `at`: a search that found
        // enough in the first reads no later one. Each read takes a slice of the titles, so none
        // holds the process long, however many titles match.
        const rows = db.prepare(`
          select programme.channel, programme.start, programme.stop, title.text as title
          from programme join title on title.key = programme.title
          where programme.title in (select value from json_each(?))
            and programme.start >= ? and programme.start < ?`);
        // A search bounded from the start reads its one stretch.
        const ahead = Number.isFinite(before()) ? [] : STRETCHES.map((each) => at + each);
        const edges = [at - read.longest + 1, ...ahead];
        for (const [step, from] of edges.entries()) {
          const to = Math.min(edges[step + 1] ?? Number.MAX_SAFE_INTEGER, before());
          if (from >= to) break;
          for (let first = 0; first < titles.length; first += TITLES_AT_ONCE) {
            const some = JSON.stringify(titles.slice(first, first + TITLES_AT_ONCE));
            for (const row of rows.iterate(some, from, to)) {
              const found = {
                channel: Number(row["channel"]),
                start: Number(row["start"]),
                stop: Number(row["stop"]),
                title: String(row["title"]),
              };
              if (found.stop > at) visit(found);
              if (slice.due()) await slice.rest();
            }
            if (slice.due()) await slice.rest();
          }
        }
      } finally {
        active--;
        closed();
      }
    },
    release() {
      closing ??= Promise.withResolvers();
      closed();
      return closing.promise;
    },
  };
}

function programmeOf(row: Record<string, unknown>): Programme {
  return {
    start: Number(row["start"]),
    stop: Number(row["stop"]),
    title: String(row["title"]),
    description: typeof row["description"] === "string" ? row["description"] : null,
  };
}

/** Tells a long read on the main process when to let other work in. */
function slicer() {
  let began = performance.now();
  let count = 0;
  return {
    due: () => (++count & 127) === 0 && performance.now() - began >= SLICE_MS,
    rest: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      began = performance.now();
    },
  };
}
