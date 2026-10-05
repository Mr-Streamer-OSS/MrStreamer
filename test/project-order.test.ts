import { describe, expect, it } from "vitest";
import {
  maintainProject,
  planOrder,
  type Card,
  type Draft,
  type Field,
  type Page,
  type Pins,
  type Value,
} from "../scripts/project-order.ts";

const ORDER = "order-field";
const RELEASE = "release-field";
const STATUS = "status-field";
const BLOCKED = "blocked-field";
const FIELDS: readonly Field[] = [
  { id: "title-field", name: "Title", dataType: "TITLE" },
  {
    id: STATUS,
    name: "Status",
    dataType: "SINGLE_SELECT",
    options: [
      { id: "backlog-option", name: "Backlog" },
      { id: "planned-option", name: "Planned" },
      { id: "done-option", name: "Done" },
    ],
  },
  { id: RELEASE, name: "Release", dataType: "TEXT" },
  {
    id: BLOCKED,
    name: "Blocked",
    dataType: "SINGLE_SELECT",
    options: [{ id: "blocked-option", name: "Blocked" }],
  },
  { id: ORDER, name: "Order", dataType: "NUMBER" },
];

/** A card that is Planned for 0.0.7, has no number and isn't blocked, unless told otherwise. */
function card(id: string, values: Partial<Omit<Card, "id">> = {}): Card {
  return {
    id,
    archived: false,
    title: id,
    status: "Planned",
    release: "0.0.7",
    order: null,
    blocked: null,
    ...values,
  };
}

/** A release's own card, as the project sets one up. */
function releaseCard(version: string, values: Partial<Omit<Card, "id">> = {}): Card {
  return card(`release-${version}`, {
    title: `Release ${version}`,
    release: version,
    blocked: "Blocked",
    ...values,
  });
}

/** 0.0.7 and 0.0.8 are out, so tests of the order see no new release card and no number for one. */
const RELEASED = [
  releaseCard("0.0.7", { status: "Done" }),
  releaseCard("0.0.8", { status: "Done" }),
];

/**
 * A project in memory. It answers `pageSize` cards a page, each page starting after the last card
 * of the one before as on GitHub, and keeps what is written to it. Tests change `held` and
 * `fields` to stand for edits on the board.
 */
function project(cards: readonly Card[], pageSize = 100) {
  const held = new Map(cards.map((each) => [each.id, each]));
  const drafts: Draft[] = [];
  const writes: ({ field: string; card: string; value: Value | null } | { draft: string })[] = [];
  /** What writing a field changes on a card. */
  const written = (field: string, value: Value | null): Partial<Card> => {
    const chosen = value && "singleSelectOptionId" in value ? value.singleSelectOptionId : null;
    const options = FIELDS.find((each) => each.id === field)?.options;
    const option = options?.find((each) => each.id === chosen)?.name ?? null;
    switch (field) {
      case ORDER:
        return { order: value && "number" in value ? value.number : null };
      case RELEASE:
        return { release: value && "text" in value ? value.text : null };
      case STATUS:
        return { status: option };
      case BLOCKED:
        return { blocked: option };
      default:
        throw new Error(`The project has no field ${field}.`);
    }
  };
  const self = {
    held,
    drafts,
    writes,
    fields: FIELDS,
    /** Runs before each write, with the number of writes made so far. */
    beforeWrite: (_made: number): void => {},
    /** The number of each card that has one. */
    numbers: () =>
      Object.fromEntries(
        [...held.values()].flatMap((each) => (each.order === null ? [] : [[each.id, each.order]])),
      ),
    async page(after: string | null): Promise<Page> {
      const all = [...held.values()];
      const start = after === null ? 0 : all.findIndex((each) => each.id === after) + 1;
      const listed = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      return {
        fields: self.fields,
        total: all.length,
        cards: listed,
        next: more ? (listed.at(-1)?.id ?? null) : null,
      };
    },
    async setField(field: string, id: string, value: Value | null): Promise<void> {
      self.beforeWrite(writes.length);
      const current = held.get(id);
      if (!current) throw new Error(`The project holds no card ${id}.`);
      writes.push({ field, card: id, value });
      held.set(id, { ...current, ...written(field, value) });
    },
    async addDraft(draft: Draft): Promise<string> {
      self.beforeWrite(writes.length);
      const id = `draft-${drafts.push(draft)}`;
      writes.push({ draft: draft.title });
      held.set(id, {
        id,
        archived: false,
        title: draft.title,
        status: null,
        release: null,
        order: null,
        blocked: null,
      });
      return id;
    },
  };
  return self;
}

/** The ids of unfinished cards, in the order they are worked on. */
const ordered = (cards: readonly Card[], pins: Pins = {}) => planOrder(cards, pins).order;

describe("the order cards are worked in", () => {
  it("starts with the earliest release, and counts 0.0.10 after 0.0.9", () => {
    const cards = [
      card("tenth", { release: "0.0.10", order: 1 }),
      card("ninth", { release: "0.0.9", order: 2 }),
      card("seventh", { release: "0.0.7", order: 3 }),
    ];
    expect(ordered(cards)).toEqual(["seventh", "ninth", "tenth"]);
  });

  it("puts the owner's pins first in their release, then work in Development, then the rest", () => {
    const cards = [
      card("planned", { order: 1 }),
      card("tested", { status: "Tested", order: 2 }),
      card("underway", { status: "Development", order: 3 }),
      card("second-pin", { order: 4 }),
      card("first-pin", { order: 5 }),
    ];
    expect(ordered(cards, { "0.0.7": ["first-pin", "second-pin"] })).toEqual([
      "first-pin",
      "second-pin",
      "underway",
      "planned",
      "tested",
    ]);
  });

  it("counts a pin only in the release it is listed under", () => {
    const cards = [
      card("first", { release: "0.0.8", order: 1 }),
      card("moved", { release: "0.0.8", order: 2 }),
    ];
    expect(ordered(cards, { "0.0.7": ["moved"] })).toEqual(["first", "moved"]);
  });

  it("moves blocked cards behind all work that can go ahead, a blocked pin included", () => {
    const cards = [
      card("blocked-pin", { blocked: "Blocked", order: 1 }),
      card("blocked-later", { release: "0.0.8", blocked: "Blocked", order: 2 }),
      card("ready-later", { release: "0.0.8", order: 3 }),
      card("ready", { order: 4 }),
      card("idea", { status: "Backlog", release: "Unscheduled", order: 5 }),
    ];
    expect(ordered(cards, { "0.0.7": ["blocked-pin"] })).toEqual([
      "ready",
      "ready-later",
      "blocked-pin",
      "blocked-later",
      "idea",
    ]);
  });

  it("puts a release's own card last in its release, behind work with a higher number", () => {
    const cards = [
      releaseCard("0.0.7", { blocked: null, status: "Development", order: 1 }),
      card("planned", { order: 2 }),
      card("underway", { status: "Development", order: 3 }),
      card("next-release", { release: "0.0.8", order: 4 }),
    ];
    expect(ordered(cards)).toEqual(["underway", "planned", "release-0.0.7", "next-release"]);
  });

  it("puts the Backlog last, with or without the word Unscheduled", () => {
    const cards = [
      card("idea", { status: "Backlog", release: "Unscheduled", order: 1 }),
      card("new-idea", { status: "Backlog", release: null, order: 2 }),
      card("planned", { release: "0.0.9", order: 3 }),
    ];
    expect(ordered(cards)).toEqual(["planned", "idea", "new-idea"]);
  });

  it("keeps the number a card has within its group, then goes by id, numbered cards first", () => {
    const cards = [
      card("d"),
      card("c"),
      card("b", { order: 2 }),
      card("a", { order: 2 }),
      card("between", { order: 1.5 }),
      card("z", { order: 1 }),
    ];
    expect(ordered(cards)).toEqual(["z", "between", "a", "b", "c", "d"]);
  });

  it("numbers every unfinished stage without gaps and clears Done cards", async () => {
    const board = project([
      ...RELEASED,
      card("released", { status: "Done", release: "Launch", order: 1 }),
      card("implemented", { status: "Implemented", order: 2 }),
      card("tested", { status: "Tested", order: 4 }),
      card("idea", { status: "Backlog", release: "Unscheduled", order: 9 }),
    ]);
    await maintainProject(board, {}, { apply: true });
    expect(board.numbers()).toEqual({ implemented: 1, tested: 2, idea: 3 });
  });

  it("leaves archived cards as they are", async () => {
    const archived = card("archived", { archived: true, status: null, order: 1 });
    const board = project([...RELEASED, archived, card("open", { order: 2 })]);
    await maintainProject(board, {}, { apply: true });
    expect(board.held.get("archived")).toEqual(archived);
    expect(board.numbers()).toEqual({ archived: 1, open: 1 });
  });
});

describe("a project that can't be ordered", () => {
  it.each([
    ["no Status", card("odd", { status: null })],
    ["a Status the rules don't know", card("odd", { status: "Review" })],
    ["a release on a Backlog card", card("odd", { status: "Backlog" })],
    ["no release on a Planned card", card("odd", { release: null })],
    ["Unscheduled in Development", card("odd", { status: "Development", release: "Unscheduled" })],
    ["a release that is no version", card("odd", { release: "Launch" })],
    ["a nightly build as its release", card("odd", { release: "0.0.7-nightly.20261002.14" })],
    ["a Blocked option the rules don't know", card("odd", { blocked: "Waiting" })],
  ])("is left alone when a card has %s", async (_, odd) => {
    const board = project([
      ...RELEASED,
      card("first", { order: 5 }),
      odd,
      card("finished", { status: "Done", order: 6 }),
    ]);
    await expect(maintainProject(board, {}, { apply: true })).rejects.toThrow(
      /^1 card can't be placed/,
    );
    expect(board.writes).toEqual([]);
  });

  it.each([
    ["has no Order field", FIELDS.filter((field) => field.name !== "Order")],
    [
      "keeps Order as text",
      FIELDS.map((field) => (field.name === "Order" ? { ...field, dataType: "TEXT" } : field)),
    ],
    ["has no Blocked field", FIELDS.filter((field) => field.name !== "Blocked")],
    [
      "has no Planned among its stages",
      FIELDS.map((field) => (field.name === "Status" ? { ...field, options: [] } : field)),
    ],
  ])("is left alone when it %s", async (_, fields) => {
    const board = project([...RELEASED, card("first", { order: 5 })]);
    board.fields = fields;
    await expect(maintainProject(board, {}, { apply: true })).rejects.toThrow(/field/);
    expect(board.writes).toEqual([]);
  });

  it("is left alone when a card leaves it between two pages", async () => {
    const board = project([card("a", { order: 4 }), card("b", { order: 5 }), card("c")], 2);
    const leaving = {
      ...board,
      async page(after: string | null) {
        const page = await board.page(after);
        board.held.delete("a");
        return page;
      },
    };
    await expect(maintainProject(leaving, {}, { apply: true })).rejects.toThrow(/changed while/);
    expect(board.writes).toEqual([]);
  });
});

describe("writing the order", () => {
  it("writes nothing in a preview, and says what would change", async () => {
    const board = project([
      ...RELEASED,
      card("first", { order: 3 }),
      card("finished", { status: "Done", order: 1 }),
    ]);
    const outcome = await maintainProject(board, {}, { apply: false });
    expect(outcome.written).toBe(false);
    expect(outcome.changes).toEqual([
      { card: "first", from: 3, to: 1 },
      { card: "finished", from: 1, to: null },
    ]);
    expect(board.writes).toEqual([]);
  });

  it("writes only the Order values that differ, and nothing on the next run", async () => {
    const board = project([
      ...RELEASED,
      card("first", { order: 1 }),
      card("finished", { status: "Done", order: 2 }),
      card("second", { order: 3 }),
    ]);
    expect((await maintainProject(board, {}, { apply: true })).written).toBe(true);
    expect(board.writes).toEqual([
      { field: ORDER, card: "second", value: { number: 2 } },
      { field: ORDER, card: "finished", value: null },
    ]);
    expect((await maintainProject(board, {}, { apply: true })).changes).toEqual([]);
    expect(board.writes).toHaveLength(2);
  });

  it("orders a project that takes several pages to read", async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `card-${String(index).padStart(3, "0")}`);
    // Numbered backwards, so the last card read is the first to work on.
    const board = project(
      [...RELEASED, ...ids.map((id, index) => card(id, { order: 1000 - index }))],
      100,
    );
    await maintainProject(board, {}, { apply: true });
    expect(board.numbers()).toEqual(
      Object.fromEntries(ids.toReversed().map((id, index) => [id, index + 1])),
    );
  });

  // The ids sort against the numbers, so two cards left on one number would swap places.
  const halfway = () => [
    ...RELEASED,
    card("z", { order: 1 }),
    card("y", { order: 2 }),
    card("x", { order: 3 }),
    // Work underway goes first, which moves the three above up a place.
    card("w", { status: "Development", order: 4 }),
    // A Done card leaves a gap, which moves the rest down.
    card("finished", { status: "Done", order: 5 }),
    card("v", { release: "0.0.8", order: 6 }),
    card("u", { release: "0.0.8", order: 7 }),
    card("t", { release: "0.0.8" }),
  ];

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "ends on the same order when a run stops after %i writes and the next one finishes",
    async (made) => {
      const board = project(halfway());
      board.beforeWrite = (count) => {
        if (count === made) throw new Error("GitHub is unreachable.");
      };
      await expect(maintainProject(board, {}, { apply: true })).rejects.toThrow("unreachable");
      board.beforeWrite = () => {};
      await maintainProject(board, {}, { apply: true });
      expect(board.numbers()).toEqual({ w: 1, z: 2, y: 3, x: 4, v: 5, u: 6, t: 7 });
    },
  );

  it("fails when the board is edited while it writes, instead of calling it ordered", async () => {
    const board = project([
      ...RELEASED,
      card("a", { order: 2 }),
      card("b", { order: 3 }),
      card("c", { order: 4 }),
    ]);
    board.beforeWrite = (count) => {
      // The owner moves the first card to the end, after the run has numbered it.
      if (count === 1) board.held.set("a", card("a", { order: 9 }));
    };
    await expect(maintainProject(board, {}, { apply: true })).rejects.toThrow(/edited while/);
  });
});

describe("a release's own card", () => {
  /** Work is planned for 0.0.10, which has no card. */
  const unreleased = () => [...RELEASED, card("feature", { release: "0.0.10", order: 1 })];

  it("is proposed by a preview, behind the release's work, and not added", async () => {
    const board = project(unreleased());
    const outcome = await maintainProject(board, {}, { apply: false });
    expect(outcome.releases).toEqual([{ version: "0.0.10", card: null }]);
    expect(outcome.order).toEqual(["feature", "Release 0.0.10"]);
    expect(board.writes).toEqual([]);
  });

  it("is added once: Planned, Blocked, the owner's, with the checklist and a number", async () => {
    const board = project(unreleased());
    await maintainProject(board, {}, { apply: true });
    await maintainProject(board, {}, { apply: true });
    expect(board.drafts).toEqual([
      {
        title: "Release 0.0.10",
        body: expect.stringContaining("- [ ] "),
        assignees: ["MDQ6VXNlcjcxNDk4NDUy"],
      },
    ]);
    expect(board.held.get("draft-1")).toEqual({
      id: "draft-1",
      archived: false,
      title: "Release 0.0.10",
      status: "Planned",
      release: "0.0.10",
      blocked: "Blocked",
      order: 2,
    });
  });

  it("is not added for a release whose card is Done or archived, and those stay as they are", async () => {
    const done = releaseCard("0.0.10", { status: "Done", blocked: null });
    const archived = releaseCard("0.0.11", { archived: true, status: null, release: null });
    const board = project([
      ...RELEASED,
      done,
      archived,
      card("late-fix", { release: "0.0.10", order: 2 }),
      card("feature", { release: "0.0.11", order: 3 }),
    ]);
    await maintainProject(board, {}, { apply: true });
    expect(board.drafts).toEqual([]);
    expect(board.held.get(done.id)).toEqual(done);
    expect(board.held.get(archived.id)).toEqual(archived);
    expect(board.numbers()).toEqual({ "late-fix": 1, feature: 2 });
  });

  it("is added for the versions of unfinished work alone", async () => {
    const board = project([
      ...RELEASED,
      card("idea", { status: "Backlog", release: "Unscheduled" }),
      card("shipped", { status: "Done", release: "0.0.4" }),
      card("launched", { status: "Done", release: "Launch" }),
      card("superseded", { archived: true, release: "0.0.5" }),
      releaseCard("0.0.9"),
      card("feature", { release: "0.0.10" }),
    ]);
    await maintainProject(board, {}, { apply: true });
    expect(board.drafts.map((draft) => draft.title)).toEqual(["Release 0.0.10"]);
  });

  it("follows work to the release it moves to, and adds none for Unscheduled", async () => {
    const board = project(unreleased());
    await maintainProject(board, {}, { apply: true });
    board.held.set("feature", card("feature", { release: "0.0.11", order: 1 }));
    await maintainProject(board, {}, { apply: true });
    board.held.set("feature", card("feature", { status: "Backlog", release: "Unscheduled" }));
    await maintainProject(board, {}, { apply: true });
    expect(board.drafts.map((draft) => draft.title)).toEqual(["Release 0.0.10", "Release 0.0.11"]);
  });

  it.each([1, 2, 3])(
    "is finished by the next run when one stops after %i of its four writes, and not doubled",
    async (made) => {
      const board = project(unreleased());
      board.beforeWrite = (count) => {
        if (count === made) throw new Error("GitHub is unreachable.");
      };
      await expect(maintainProject(board, {}, { apply: true })).rejects.toThrow("unreachable");
      board.beforeWrite = () => {};
      await maintainProject(board, {}, { apply: true });
      expect(board.drafts).toHaveLength(1);
      expect(board.held.get("draft-1")).toMatchObject({
        status: "Planned",
        release: "0.0.10",
        blocked: "Blocked",
        order: 2,
      });
    },
  );

  it("gets its Release when made by hand without one, and keeps the rest as it was made", async () => {
    const byHand = card("by-hand", {
      title: "Release 0.0.10",
      status: "Development",
      release: null,
      order: 2,
    });
    const board = project([...unreleased(), byHand]);
    await maintainProject(board, {}, { apply: true });
    expect(board.drafts).toEqual([]);
    expect(board.held.get("by-hand")).toEqual({ ...byHand, release: "0.0.10" });
  });

  it("stops the run when it is planned for another release than its title names", async () => {
    const board = project([...unreleased(), releaseCard("0.0.10", { release: "0.0.9" })]);
    await expect(maintainProject(board, {}, { apply: true })).rejects.toThrow(
      "is titled Release 0.0.10, so its Release must be 0.0.10.",
    );
    expect(board.writes).toEqual([]);
  });

  it("is not added while a card's title can't be read", async () => {
    const board = project([...unreleased(), card("hidden", { title: null })]);
    await expect(maintainProject(board, {}, { apply: true })).rejects.toThrow(/can't be read/);
    expect(board.writes).toEqual([]);
  });
});
