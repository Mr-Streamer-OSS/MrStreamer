import { describe, expect, it, vi } from "vitest";

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));

vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));

import { mapSections, timeLeft, type MapInput } from "../src/guide/present.ts";
import { statusLines } from "../src/guide/status.ts";

// What the guide screens show from the service's answers: Map channels' sections and search, an
// ongoing programme's time left, and a provider's guide row when it has no guide.

const input: MapInput = {
  channels: new Map([
    [
      "estuary",
      [
        { id: "1", key: "estuary:1", title: "Estuary Max" },
        { id: "2", key: "estuary:2", title: "Kade One" },
        { id: "3", key: "estuary:3", title: "Harbour HD" },
      ],
    ],
  ]),
  mappings: new Map([
    ["estuary:3", "harbour.hd"],
    ["estuary:1042", "kade1.uk"],
    ["unread:7", "nova.tv"],
  ]),
  providers: new Map([["estuary", "Estuary Media"]]),
  categories: new Map([["estuary:2", "United Kingdom"]]),
};

const rows = (query: string) =>
  mapSections(input, query).map(({ title, data }) => [
    title,
    data.map(({ title: name, line, mapped }) => [name, line, mapped]),
  ]);

describe("Android guide screens", () => {
  it("lists mapped channels first, those no longer listed included, then the rest", () => {
    expect(rows("")).toEqual([
      [
        "Mapped",
        [
          ["Harbour HD", null, "harbour.hd"],
          ["Channel 1042", "Estuary Media · No longer listed", "kade1.uk"],
          // Its catalogue isn't read yet: nothing says it isn't listed.
          ["Channel 7", null, "nova.tv"],
        ],
      ],
      [
        "Channels",
        [
          ["Estuary Max", null, null],
          ["Kade One", "United Kingdom", null],
        ],
      ],
    ]);
  });

  it("finds channels by name or mapped guide id and leaves empty sections out", () => {
    expect(rows("kade")).toEqual([
      ["Mapped", [["Channel 1042", "Estuary Media · No longer listed", "kade1.uk"]]],
      ["Channels", [["Kade One", "United Kingdom", null]]],
    ]);
    expect(rows("nothing")).toEqual([]);
  });

  it("says what is left of a programme only while it is on", () => {
    const start = Date.UTC(2026, 10, 3, 14);
    const programme = { start, stop: start + 90 * 60_000 };
    expect(timeLeft(programme, start + 62 * 60_000)).toBe("28 min left");
    expect(timeLeft(programme, start + 30 * 60_000)).toBe("1 h left");
    expect(timeLeft(programme, start + 10 * 60_000)).toBe("1 h 20 min left");
    expect(timeLeft(programme, start - 1)).toBeNull();
    expect(timeLeft(programme, programme.stop)).toBeNull();
  });

  it("shows a provider without a guide as unavailable, not waiting to download", () => {
    expect(
      statusLines({
        availability: "none",
        activity: "idle",
        fetchedAt: null,
        stale: true,
        error: null,
      }),
    ).toEqual([{ text: "Guide unavailable" }]);
  });
});
