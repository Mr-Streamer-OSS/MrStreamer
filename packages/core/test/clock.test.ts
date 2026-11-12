// A time the viewer types to go to reads as the scrubber writes it, and anything else is refused.
import { clock, parseClock } from "@mrstreamer/core/viewing/continue";
import { expect, it } from "vitest";

it.each([
  ["1:02:13", 3733],
  ["24:51", 1491],
  ["0:05", 5],
  ["45", 45],
  [" 3:00 ", 180],
  ["120:00", 7200],
])("reads %j as %i seconds", (text, seconds) => {
  expect(parseClock(text)).toBe(seconds);
});

it.each(["", "1:2", "1:60", "1:00:60", "1:5:00", "-5", "1.5", "a:00", "1::00", "1:00:00:00"])(
  "refuses %j",
  (text) => {
    expect(parseClock(text)).toBeNull();
  },
);

it("reads back what the scrubber writes", () => {
  for (const seconds of [0, 59, 3599, 3600, 7322]) expect(parseClock(clock(seconds))).toBe(seconds);
});

it.each(["9".repeat(400), "9007199254740992", "150119987579017:00", "2501999792984:00:00"])(
  "refuses a time outside safe integer seconds: %j",
  (text) => {
    expect(parseClock(text)).toBeNull();
  },
);
