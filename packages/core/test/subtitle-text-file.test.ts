import { describe, expect, it } from "vitest";
import { subtitleTextFile } from "../src/subtitles/text-file.ts";

describe("downloaded text subtitles", () => {
  it("reads BOM/CRLF SubRip as original cue times and preserves punctuation and supported cue markup", () => {
    expect(
      subtitleTextFile(
        "\uFEFF1\r\n00:00:04,500 --> 00:00:06,750\r\n<i>Hello, world.</i>\r\nA second line.\r\n\r\n2\r\n00:01:01,000 --> 00:01:03,000\r\nGood evening.",
      ),
    ).toEqual([
      { start: 4.5, end: 6.75, text: "<i>Hello, world.</i>\nA second line." },
      { start: 61, end: 63, text: "Good evening." },
    ]);
  });

  it("reads WebVTT cue ids and settings without importing document styles", () => {
    expect(
      subtitleTextFile(
        "WEBVTT\n\nSTYLE\n::cue { color:red }\n\ncaption-1\n00:04.500 --> 00:06.750 align:start\nHello.",
      ),
    ).toEqual([{ start: 4.5, end: 6.75, text: "Hello." }]);
  });

  it.each([
    "",
    "[Script Info]\nTitle: An ASS file",
    "1\n00:00:05,000 --> 00:00:04,000\nBackwards",
    "WEBVTT\n\n00:00.000 --> 25:00:00.000\nBeyond a title",
  ])("refuses unsupported or invalid content", (text) => {
    expect(() => subtitleTextFile(text)).toThrow();
  });
});
