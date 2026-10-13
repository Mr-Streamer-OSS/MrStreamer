import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { guideAddress } from "../src/guide/address.ts";
import { xmltvDocument } from "../src/guide/document.ts";
import {
  buildGuideIndex,
  openGuideIndex,
  type GuideBuild,
  type GuideIndex,
} from "../src/guide/index-file.ts";
import { GUIDE_LIMITS } from "../src/guide/limits.ts";
import { mappedChannels, type CatalogueChannels } from "../src/guide/programmes.ts";
import { xmltvReader, type XmltvChannel, type XmltvProgramme } from "../src/guide/xmltv.ts";

/** Noon on a day in October 2026, in UTC. */
const NOON = Date.UTC(2026, 9, 2, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** `bytes` as a sender splits them: in pieces of `size`. */
async function* pieces(bytes: Uint8Array | string, size = 64 * 1024): AsyncGenerator<Uint8Array> {
  const all = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  for (let at = 0; at < all.length; at += size) yield all.subarray(at, at + size);
}

/** `document` as a sender splits it, all at once: in pieces of `size`. */
function* slices(document: string, size: number): Generator<Uint8Array> {
  const all = Buffer.from(document);
  for (let at = 0; at < all.length; at += size) yield all.subarray(at, at + size);
}

async function text(document: AsyncIterable<Uint8Array>): Promise<string> {
  const read: Uint8Array[] = [];
  for await (const piece of document) read.push(piece);
  return Buffer.concat(read).toString("utf8");
}

/** Why a guide was refused. */
async function refusal(work: Promise<unknown>): Promise<unknown> {
  const cause = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  return cause instanceof AppFailure && cause.error.kind === "guide" ? cause.error.failure : cause;
}

const programme = (channel: string, start: string, stop: string | null, title: string) =>
  `<programme start="${start}"${stop ? ` stop="${stop}"` : ""} channel="${channel}"><title>${title}</title></programme>`;

/** A time as XMLTV writes it in UTC: "20261002130000 +0000". */
const stamp = (time: number) =>
  `${new Date(time).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;

/** A programme on `channel` from one o'clock, UTC, for an hour: still to come at NOON. */
const later = (channel: string, title = "Later") =>
  programme(channel, "20261002130000 +0000", "20261002140000 +0000", title);

const tv = (...elements: string[]) => `<?xml version="1.0"?><tv>${elements.join("")}</tv>`;

describe("an XMLTV document as it arrives", () => {
  const document = tv(later("one.test"));

  it("is unpacked when it is gzip by its first bytes, however they are split, and read as it is otherwise", async () => {
    const packed = gzipSync(document);

    expect(await text(xmltvDocument(pieces(packed, 1), GUIDE_LIMITS.bytes))).toBe(document);
    expect(await text(xmltvDocument(pieces(packed), GUIDE_LIMITS.bytes))).toBe(document);
    // A guide named .xml.gz that the connection already unpacked is XML by now.
    expect(await text(xmltvDocument(pieces(document, 1), GUIDE_LIMITS.bytes))).toBe(document);
    // Packed as several members, as some tools write one.
    const members = Buffer.concat([gzipSync(document.slice(0, 20)), gzipSync(document.slice(20))]);
    expect(await text(xmltvDocument(pieces(members, 7), GUIDE_LIMITS.bytes))).toBe(document);
    expect(await text(xmltvDocument(pieces(""), GUIDE_LIMITS.bytes))).toBe("");
  });

  it("fails a gzip that stops early or is damaged, and never as a guide that just ends", async () => {
    const packed = gzipSync(tv(...Array.from({ length: 400 }, (_, at) => later(`c${at}.test`))));
    const cut = packed.subarray(0, packed.length - 12);
    const damaged = Buffer.concat([
      packed.subarray(0, 40),
      Buffer.alloc(24, 7),
      packed.subarray(64),
    ]);

    expect(await refusal(text(xmltvDocument(pieces(cut, 900), GUIDE_LIMITS.bytes)))).toEqual({
      kind: "incomplete",
    });
    expect(await refusal(text(xmltvDocument(pieces(damaged), GUIDE_LIMITS.bytes)))).toEqual({
      kind: "incomplete",
    });
  });

  it("stops at the size it may unpack to, packed small or not, and hands on nothing past it", async () => {
    const limit = 256 * 1024;
    // A megabyte that packs into about a kilobyte.
    const bomb = gzipSync(Buffer.alloc(1024 * 1024, "a"));
    expect(bomb.length).toBeLessThan(4096);
    let handed = 0;
    const counted = async (document: AsyncIterable<Uint8Array>) => {
      for await (const piece of document) handed += piece.byteLength;
    };

    expect(await refusal(counted(xmltvDocument(pieces(bomb), limit)))).toEqual({
      kind: "too-large",
      limit: "bytes",
    });
    expect(handed).toBeLessThanOrEqual(limit);
    expect(await refusal(text(xmltvDocument(pieces("a".repeat(limit + 1)), limit)))).toEqual({
      kind: "too-large",
      limit: "bytes",
    });
    expect(await text(xmltvDocument(pieces("a".repeat(limit)), limit))).toHaveLength(limit);
  });
});

describe("reading XMLTV as it arrives", () => {
  /** How a document ends and how many programmes it lists, read in pieces of `size`. */
  const read = (document: string, size: number) => {
    let programmes = 0;
    const reader = xmltvReader({ programme: () => programmes++, channel: () => {} }, 1024 * 1024);
    for (const piece of slices(document, size)) reader.push(piece);
    return { ending: reader.end(), programmes };
  };

  it("keeps text and the last used attribute when elements are split anywhere", () => {
    for (const [raw, shown] of [
      ["  News\t from\n abroad  ", "News from abroad"],
      ["  News <b>from</b> &amp; <![CDATA[<abroad>]]>  ", "News from & <abroad>"],
    ] as const) {
      const found: XmltvProgramme[] = [];
      const channels: XmltvChannel[] = [];
      const reader = xmltvReader(
        { programme: (entry) => found.push(entry), channel: (entry) => channels.push(entry) },
        1024 * 1024,
      );
      const document = tv(
        '<channel ignored="unused" id="wrong" id="one&amp;only"><display-name>One</display-name></channel>',
        `<programme stop='20261002140000 +0000' ignored='unused' channel='wrong' start='20261002130000 +0000' channel='one&amp;only'><title>${raw}</title><desc>${raw}</desc></programme>`,
      );
      for (const piece of slices(document, 7)) reader.push(piece);

      expect(channels).toEqual([{ id: "one&only", name: "One" }]);
      expect(found).toEqual([
        {
          channel: "one&only",
          start: NOON + HOUR,
          stop: NOON + 2 * HOUR,
          title: shown,
          description: shown,
        },
      ]);
    }
  });

  describe("as one whole <tv> and nothing that only reads like one", () => {
    const one = later("one.test");
    /** A programme whose description is `text`, as a CDATA section holds it. */
    const described = (text: string) =>
      later("two.test").replace("</programme>", `<desc><![CDATA[${text}]]></desc></programme>`);

    it.each<[what: string, document: string, ending: string, programmes: number]>([
      ["no opening tag", `${one}</tv>`, "not-xmltv", 1],
      ["an opening tag only in a comment", `<!-- <tv> -->${one}</tv>`, "not-xmltv", 1],
      ["another element that starts alike", `<tvirus>${one}</tv>`, "not-xmltv", 1],
      ["a guide inside a page", `<html><tv>${one}</tv></html>`, "not-xmltv", 1],
      ["a programme before it", `${one}<tv>${one}</tv>`, "not-xmltv", 2],
      ["a programme after it", `<tv>${one}</tv>${one}`, "not-xmltv", 2],
      ["a second document after it", `<tv>${one}</tv><tv>${one}</tv>`, "not-xmltv", 2],
      ["a closing tag cut short", `<tv>${one}</tv`, "incomplete", 1],
      ["another element's closing tag", `<tv>${one}</tvirus>`, "incomplete", 1],
      ["a closing tag with more in it", `<tv>${one}</tv x="1">`, "incomplete", 1],
      ["a closing tag only in a comment", `<tv>${one}<!-- </tv> -->`, "incomplete", 1],
      ["a closing tag only in CDATA", `<tv>${one}<![CDATA[</tv>]]>`, "incomplete", 1],
      [
        "cut in a description that reads like the end",
        `<tv>${one}${described("</programme></tv>").slice(0, -"]]></desc></programme>".length)}`,
        "incomplete",
        1,
      ],
      ["a second <tv> that never closes", `<tv><tv>${one}</tv>`, "incomplete", 1],
      ["an empty element for a document", '<?xml version="1.0"?><tv/>', "whole", 0],
      [
        "comments and descriptions that read like the end, before the end",
        `<tv>${one}<!-- </tv> -->${described("</programme></tv>")}</tv>`,
        "whole",
        2,
      ],
      [
        "space in the closing tag and a comment after it",
        `<tv>${one}</tv\n>\n<!-- </tv> -->`,
        "whole",
        1,
      ],
      [
        "a declaration and a DOCTYPE before it",
        `<?xml version="1.0"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv date="2026">${one}</tv>`,
        "whole",
        1,
      ],
    ])("%s", (_what, document, ending, programmes) => {
      // However the sender splits it: a byte at a time, mid-tag, or all at once.
      for (const size of [1, 7, 64 * 1024]) {
        expect(read(document, size)).toEqual({ ending, programmes });
      }
    });
  });
});

describe("indexing a guide", () => {
  /** Indexes `document` as of NOON, as an own guide unless `strict`, and opens what it wrote. */
  const index = async (document: string | Uint8Array, build: Partial<GuideBuild> = {}) => {
    const dir = await mkdtemp(join(tmpdir(), "mr-streamer-guide-index-"));
    const target = join(dir, `${Math.random()}.sqlite`);
    await writeFile(join(dir, "document"), document);
    const told: number[] = [];
    const summary = await buildGuideIndex(
      {
        document: join(dir, "document"),
        target,
        previous: null,
        since: NOON,
        archive: DAY,
        strict: false,
        ...build,
      },
      (programmes) => told.push(programmes),
    );
    const guide = await openGuideIndex(target);
    if (!guide) throw new Error("The index can't be opened.");
    opened.push(guide);
    return { guide, summary, told, target };
  };
  const opened: GuideIndex[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((guide) => guide.release()));
  });

  /** Every programme of a guide channel the index keeps, as [title, start, stop]. */
  const of = (guide: GuideIndex, id: string) => {
    const channel = guide.channels.get(id);
    return channel
      ? guide
          .range(channel, 0, Number.MAX_SAFE_INTEGER)
          .map(({ title, start, stop }) => [title, start, stop])
      : undefined;
  };

  it("lists every channel the guide names with its name, and by its id where it names none, by name", async () => {
    const { guide } = await index(
      tv(
        '<channel id="one.test"><display-name lang="en">One &amp; Only</display-name><display-name>1</display-name><icon src="http://x/1.png"/></channel>',
        "<channel id='quiet.test'><display-name><![CDATA[Quiet <TV>]]></display-name></channel>",
        '<channel id="bare.test"/>',
        later("one.test"),
        later("unnamed.test"),
        // A name given after the programmes, as some guides write their channels last.
        later("late.test"),
        '<channel id="late.test"><display-name>Late</display-name></channel>',
      ),
    );

    expect([...guide.channels.values()].map(({ id, name, until }) => [id, name, until])).toEqual([
      ["bare.test", "bare.test", null],
      ["late.test", "Late", NOON + 2 * HOUR],
      ["one.test", "One & Only", NOON + 2 * HOUR],
      ["quiet.test", "Quiet <TV>", null],
      ["unnamed.test", "unnamed.test", NOON + 2 * HOUR],
    ]);
    expect(guide.until).toBe(NOON + 2 * HOUR);
  });

  it("reads each time by its own offset, UTC without one, across midnight and a change of clocks", async () => {
    const { guide } = await index(
      tv(
        // The same instant written four ways.
        programme("offset.test", "20261002230000 +0200", "20261003000000 +0200", "Plus two"),
        programme("colon.test", "20261002210000 +00:00", "20261002220000 +00:00", "Colon"),
        programme("none.test", "20261002210000", "20261002220000", "No offset"),
        programme("minus.test", "20261002163000 -0430", "20261002173000 -0430", "Minus"),
        // Past midnight where it is broadcast, still the day before in UTC.
        programme(
          "midnight.test",
          "20261003003000 +0200",
          "20261003013000 +0200",
          "After midnight",
        ),
        // The hour Europe has twice as summer time ends: 02:30 at +0200, then 02:30 at +0100.
        programme("clocks.test", "20261025023000 +0200", "20261025030000 +0200", "Before"),
        programme("clocks.test", "20261025023000 +0100", "20261025030000 +0100", "After"),
      ),
    );
    const nine = Date.UTC(2026, 9, 2, 21);

    expect(of(guide, "offset.test")).toEqual([["Plus two", nine, nine + HOUR]]);
    expect(of(guide, "colon.test")).toEqual([["Colon", nine, nine + HOUR]]);
    expect(of(guide, "none.test")).toEqual([["No offset", nine, nine + HOUR]]);
    expect(of(guide, "minus.test")).toEqual([["Minus", nine, nine + HOUR]]);
    expect(of(guide, "midnight.test")).toEqual([
      ["After midnight", Date.UTC(2026, 9, 2, 22, 30), Date.UTC(2026, 9, 2, 23, 30)],
    ]);
    expect(of(guide, "clocks.test")).toEqual([
      ["Before", Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1)],
      ["After", Date.UTC(2026, 9, 25, 1, 30), Date.UTC(2026, 9, 25, 2)],
    ]);
  });

  it("lays each channel out in time order without overlaps, whatever order the guide lists it in", async () => {
    const { guide } = await index(
      tv(
        programme("one.test", stamp(NOON + 3 * HOUR), stamp(NOON + 4 * HOUR), "Third"),
        // Without an end: it runs until the next one starts.
        programme("one.test", stamp(NOON + HOUR), null, "First"),
        // Runs into the next one, which cuts it short.
        programme("one.test", stamp(NOON + 2 * HOUR), stamp(NOON + 5 * HOUR), "Second"),
        // The same start again counts once: the first one listed.
        programme("one.test", stamp(NOON + 2 * HOUR), stamp(NOON + 3 * HOUR), "Again"),
        // The last without an end has nothing to end it, and is left out.
        programme("one.test", stamp(NOON + 6 * HOUR), null, "Open"),
      ),
    );

    expect(of(guide, "one.test")).toEqual([
      ["First", NOON + HOUR, NOON + 2 * HOUR],
      ["Second", NOON + 2 * HOUR, NOON + 3 * HOUR],
      ["Third", NOON + 3 * HOUR, NOON + 4 * HOUR],
    ]);
  });

  it("answers now and next, a schedule and a stretch of time from the programmes on then", async () => {
    const { guide } = await index(
      tv(
        programme("one.test", stamp(NOON - 2 * HOUR), stamp(NOON - HOUR), "Morning"),
        programme("one.test", stamp(NOON - HOUR), stamp(NOON + HOUR), "Lunch"),
        programme("one.test", stamp(NOON + HOUR), stamp(NOON + 2 * HOUR), "Afternoon"),
        // A gap, then the evening.
        programme("one.test", stamp(NOON + 3 * HOUR), stamp(NOON + 4 * HOUR), "Evening"),
      ),
    );
    const channel = guide.channels.get("one.test");
    if (!channel) throw new Error("No channel.");
    const titles = (programmes: readonly { title: string }[]) =>
      programmes.map((each) => each.title);

    expect(guide.listing(channel, NOON)).toMatchObject({
      now: { title: "Lunch" },
      next: { title: "Afternoon" },
    });
    expect(guide.listing(channel, NOON + 2.5 * HOUR)).toMatchObject({
      now: null,
      next: { title: "Evening" },
    });
    expect(guide.listing(channel, NOON + 4 * HOUR)).toBeNull();
    expect(titles(guide.schedule(channel, NOON))).toEqual(["Lunch", "Afternoon", "Evening"]);
    // The past it keeps, from the programme on at the start of the stretch.
    expect(titles(guide.range(channel, NOON - 1.5 * HOUR, NOON + HOUR))).toEqual([
      "Morning",
      "Lunch",
    ]);
    expect(titles(guide.range(channel, NOON + 2 * HOUR, NOON + 3 * HOUR))).toEqual([]);
  });

  it("keeps ended programmes for the archive window, and drops what ended before it", async () => {
    const { guide } = await index(
      tv(
        programme("one.test", stamp(NOON - DAY - 2 * HOUR), stamp(NOON - DAY - HOUR), "Too old"),
        programme("one.test", stamp(NOON - DAY + HOUR), stamp(NOON - DAY + 2 * HOUR), "Yesterday"),
        later("one.test"),
        // Programmes alone name a channel: one with nothing in the window isn't listed.
        programme("old.test", stamp(NOON - 2 * DAY), stamp(NOON - 2 * DAY + HOUR), "Gone"),
      ),
    );

    expect(of(guide, "one.test")).toEqual([
      ["Yesterday", NOON - DAY + HOUR, NOON - DAY + 2 * HOUR],
      ["Later", NOON + HOUR, NOON + 2 * HOUR],
    ]);
    expect(guide.channels.has("old.test")).toBe(false);
  });

  it("brings along the past the next download of the same source no longer lists, for the channels it still has", async () => {
    const before = await index(
      tv(
        programme("one.test", stamp(NOON - 3 * HOUR), stamp(NOON - 2 * HOUR), "Earlier"),
        programme("one.test", stamp(NOON - 2 * HOUR), stamp(NOON), "Before noon"),
        programme("gone.test", stamp(NOON - 2 * HOUR), stamp(NOON - HOUR), "Gone"),
      ),
    );
    // Six hours on, the source lists from an hour ago only, and no longer lists one channel.
    const { guide } = await index(
      tv(
        programme("one.test", stamp(NOON - HOUR), stamp(NOON + 7 * HOUR), "Long"),
        programme("one.test", stamp(NOON + 7 * HOUR), stamp(NOON + 8 * HOUR), "Evening"),
      ),
      { previous: before.target, since: NOON + 6 * HOUR },
    );

    expect(of(guide, "one.test")).toEqual([
      ["Earlier", NOON - 3 * HOUR, NOON - 2 * HOUR],
      // Cut short where the new document's first programme there begins.
      ["Before noon", NOON - 2 * HOUR, NOON - HOUR],
      ["Long", NOON - HOUR, NOON + 7 * HOUR],
      ["Evening", NOON + 7 * HOUR, NOON + 8 * HOUR],
    ]);
    expect(guide.channels.has("gone.test")).toBe(false);
  });

  it("finds programmes whose title has every word, as far as it is asked to look", async () => {
    const { guide } = await index(
      tv(
        programme("one.test", stamp(NOON - HOUR), stamp(NOON + HOUR), "Évening News"),
        programme("one.test", stamp(NOON + HOUR), stamp(NOON + 2 * HOUR), "Sport"),
        programme("two.test", stamp(NOON + 2 * DAY), stamp(NOON + 2 * DAY + HOUR), "Late news"),
        programme("two.test", stamp(NOON - 3 * HOUR), stamp(NOON - 2 * HOUR), "Old news"),
        // On since long before the others: a day's rolling coverage.
        programme("three.test", stamp(NOON - 20 * HOUR), stamp(NOON + 4 * HOUR), "Rolling news"),
      ),
    );
    const found = async (words: string[], before = Number.POSITIVE_INFINITY) => {
      const titles: string[] = [];
      await guide.matching(
        words,
        NOON,
        () => before,
        (programme) => titles.push(programme.title),
      );
      return titles.sort();
    };

    expect(await found(["news"])).toEqual(["Late news", "Rolling news", "Évening News"]);
    expect(await found(["evening", "news"])).toEqual(["Évening News"]);
    expect(await found(["news"], NOON + DAY)).toEqual(["Rolling news", "Évening News"]);
    expect(await found(["weather"])).toEqual([]);
  });

  it("refuses an address's answer that isn't a whole XMLTV guide with something still to come", async () => {
    const strict = (document: string) => refusal(index(document, { strict: true }));
    const whole = tv(later("one.test"));

    expect(await strict("<!doctype html><html><body>Sign in</body></html>")).toEqual({
      kind: "not-xmltv",
    });
    expect(await strict('{"error":"no such guide"}')).toEqual({ kind: "not-xmltv" });
    expect(await strict(whole.slice(0, -30))).toEqual({ kind: "incomplete" });
    expect(await strict(whole.slice(0, -"</tv>".length))).toEqual({ kind: "incomplete" });
    expect(await strict(tv())).toEqual({ kind: "empty" });
    expect(await strict(tv('<channel id="one.test"/>'))).toEqual({ kind: "empty" });
    // Ended, though within the archive window.
    expect(
      await strict(
        tv(programme("one.test", "20261002090000 +0000", "20261002100000 +0000", "Past")),
      ),
    ).toEqual({ kind: "ended" });
    expect((await index(`${whole}\n<!-- generated -->\n`, { strict: true })).guide.until).toBe(
      NOON + 2 * HOUR,
    );
  });

  it("takes an own guide as its provider sends it, packed, cut short or ended, and refuses only one without programmes", async () => {
    const whole = tv(later("one.test"));

    expect((await index(gzipSync(whole))).guide.until).toBe(NOON + 2 * HOUR);
    expect((await index(whole.slice(0, -"</tv>".length))).guide.until).toBe(NOON + 2 * HOUR);
    // Without a `<tv>` around its programmes, too.
    expect((await index(`${later("one.test")}</tvirus>`)).guide.until).toBe(NOON + 2 * HOUR);
    const ended = await index(
      tv(programme("one.test", "20261002090000 +0000", "20261002100000 +0000", "Past")),
    );
    expect(ended.guide.until).toBe(NOON - 2 * HOUR);
    expect(await refusal(index(tv()))).toEqual({ kind: "empty" });
  });

  it("refuses a guide past a limit whole, writing nothing, and reads one at it, however many programmes it has", async () => {
    const limits = { ...GUIDE_LIMITS, elementBytes: 2048, channels: 3 };
    const channels = (count: number) =>
      Array.from({ length: count }, (_, at) => `<channel id="c${at}.test"/>`);
    /** Half-hour programmes from one o'clock on, an hour apart: all still to come. */
    const programmes = (count: number, channel = () => "c0.test") =>
      Array.from({ length: count }, (_, at) => {
        const start = NOON + (at + 1) * HOUR;
        return programme(channel(), stamp(start), stamp(start + HOUR / 2), `Programme ${at}`);
      });

    const many = await index(tv(...channels(3), ...programmes(5_000)), { limits });
    expect(many.summary).toMatchObject({ channels: 3, programmes: 5_000 });
    // It says how far it got as it reads.
    expect(many.told.at(-1)).toBe(5_000);
    expect(await refusal(index(tv(...channels(4), ...programmes(1)), { limits }))).toEqual({
      kind: "too-large",
      limit: "channels",
    });
    // Channels the guide never names count too: programmes alone list them.
    let named = 0;
    expect(
      await refusal(index(tv(...programmes(4, () => `p${named++}.test`)), { limits })),
    ).toEqual({ kind: "too-large", limit: "channels" });

    const long = (bytes: number) => {
      const element = programme("c0.test", "20261002130000 +0000", "20261002140000 +0000", "");
      return element.replace("<title>", `<title>${"t".repeat(bytes - Buffer.byteLength(element))}`);
    };
    expect((await index(tv(long(2048)), { limits })).guide.until).toBe(NOON + 2 * HOUR);
    expect(await refusal(index(tv(long(2049)), { limits }))).toEqual({
      kind: "too-large",
      limit: "element",
    });
    expect(
      await refusal(
        index(gzipSync(tv(later("one.test"), "x".repeat(4096))), {
          limits: { ...limits, bytes: 1024 },
        }),
      ),
    ).toEqual({ kind: "too-large", limit: "bytes" });
  });

  it("leaves nothing where it was to write when it fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mr-streamer-guide-index-"));
    await writeFile(join(dir, "document"), tv());
    const target = join(dir, "index.sqlite");
    const build = { document: join(dir, "document"), target, previous: null, since: NOON };

    expect(
      await refusal(buildGuideIndex({ ...build, archive: DAY, strict: false }, () => {})),
    ).toEqual({ kind: "empty" });
    expect(await readdir(dir)).toEqual(["document"]);
  });
});

describe("mappings over a catalogue's guide ids", () => {
  const channel = (id: string, title: string): LiveChannel => ({
    subscriptionId: "s",
    id,
    name: title,
    title,
    tags: [],
    number: null,
    logoUrl: null,
    categoryIds: [],
    variants: [{ id, name: title, tags: [], quality: null }],
    catchupDays: null,
  });
  const [one, two, three] = [channel("1", "One"), channel("2", "Two"), channel("3", "Three")];
  // One and Two name the guide channel "a" themselves; Three names none, and is also found by
  // its second stream's id, "30". "8" is a channel the lists hide for now.
  const byId = new Map([
    ["1", one],
    ["2", two],
    ["3", three],
    ["30", three],
  ]);
  const catalogue: CatalogueChannels = {
    all: [one, two, three],
    searchNames: ["one", "two", "three"],
    channel: (id) => byId.get(id),
    listed: (id) => byId.has(id) || id === "8",
    guideIdsOf: (id) => (byId.get(id) === three ? [] : byId.has(id) ? ["a"] : []),
    channelsOf: (guideId) => (guideId === "a" ? [one, two] : []),
  };

  it("gives a mapped channel its guide channel alone, and each guide channel the channels that show it, in the lists' order", () => {
    const mapped = mappedChannels(catalogue, {
      "2": { guideId: "b", name: "Two" },
      // Made under another of its streams' ids: still this channel's.
      "30": { guideId: "a", name: "Three" },
      "9": { guideId: "b", name: "Gone" },
      "8": { guideId: "b", name: "Hidden" },
    });

    expect(["1", "2", "3", "30"].map((id) => mapped.guideIdsOf(id))).toEqual([
      ["a"],
      ["b"],
      ["a"],
      ["a"],
    ]);
    // Two left "a" for "b"; Three joined it, after One as the lists have them.
    expect(mapped.channelsOf("a")).toEqual([one, three]);
    expect(mapped.channelsOf("b")).toEqual([two]);
    expect([...mapped.mapped]).toEqual([
      ["2", "b"],
      ["3", "a"],
    ]);
    // Only the one the provider no longer lists is left over; a hidden one is neither.
    expect([...mapped.unlisted]).toEqual([["9", { guideId: "b", name: "Gone" }]]);
  });

  it("changes nothing without mappings", () => {
    const plain = mappedChannels(catalogue, {});

    expect(plain.channelsOf("a")).toEqual([one, two]);
    expect(plain.guideIdsOf("2")).toEqual(["a"]);
    expect(plain.mapped.size + plain.unlisted.size).toBe(0);
  });
});

describe("a guide's address", () => {
  it("is an http or https address, made whole, that names its origin and tells itself apart", () => {
    const address = guideAddress("  HTTPS://Guide.Example.org/xmltv.gz?key=s3cret#top ");

    expect(address).toEqual({
      href: "https://guide.example.org/xmltv.gz?key=s3cret",
      origin: "https://guide.example.org",
      identity: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    // The same address typed another way is the same guide; another key is another.
    expect(guideAddress("guide.example.org/xmltv.gz?key=s3cret")?.identity).toBe(address?.identity);
    expect(guideAddress("https://guide.example.org/xmltv.gz?key=other")?.identity).not.toBe(
      address?.identity,
    );
    expect(guideAddress("http://guide.example.org:8080/x")?.origin).toBe(
      "http://guide.example.org:8080",
    );
    expect(address?.identity).not.toContain("s3cret");
  });

  it("is nothing else", () => {
    for (const typed of [
      "",
      "   ",
      "ftp://guide.example.org/xmltv.xml",
      "file:///etc/passwd",
      "https://user:pass@guide.example.org/xmltv.xml",
      "https://",
      "not an address",
    ]) {
      expect(guideAddress(typed), typed).toBeNull();
    }
  });
});
