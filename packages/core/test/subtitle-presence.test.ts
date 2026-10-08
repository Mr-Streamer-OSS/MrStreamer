import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { teletextPagePresent } from "../src/subtitles/teletext.ts";
import { dvbPagePresent } from "../src/subtitles/dvb.ts";
import { pesReader } from "../src/subtitles/transport.ts";
const reader = pesReader();
const fixture = readFileSync(
  join(import.meta.dirname, "../../../apps/desktop/test/fixtures/h264-subtitles.mpegts"),
);
const packets = [...reader.push(fixture), ...reader.end()];
it("recognizes the fixture's declared teletext page, but rejects filler, other pages and truncated headers", () => {
  const page = packets.find((packet) => packet.pid === 0x300)!.payload;
  expect(teletextPagePresent(page, 888)).toBe(true);
  expect(teletextPagePresent(page, 887)).toBe(false);
  expect(teletextPagePresent(page, null)).toBe(true);
  const filler = page.slice();
  filler[7] = 0x57;
  filler[8] = 0x57;
  expect(teletextPagePresent(filler, 888)).toBe(false);
  expect(teletextPagePresent(filler, null)).toBe(false);
  expect(teletextPagePresent(page.subarray(0, 30), 888)).toBe(false);
});
it("recognizes meaningful DVB page data and rejects clear pages, wrong pages and incomplete segments", () => {
  const pages = packets.filter((packet) => packet.pid === 0x103).map((packet) => packet.payload);
  expect(pages.some((page) => dvbPagePresent(page, 1))).toBe(true);
  expect(pages.some((page) => dvbPagePresent(page, 2))).toBe(false);
  expect(
    dvbPagePresent(
      new Uint8Array([0x20, 0, 0x0f, 0x10, 0, 1, 0, 2, 1, 0, 0x0f, 0x80, 0, 1, 0, 0]),
      1,
    ),
  ).toBe(false);
  expect(dvbPagePresent(new Uint8Array([0x20, 0, 0x0f, 0x10, 0, 1, 0, 8, 1, 0]), 1)).toBe(false);
});
