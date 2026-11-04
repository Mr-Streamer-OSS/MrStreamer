import { afterEach, expect, it, vi } from "vitest";
import { SUBTITLE_TEXT_LIMIT } from "@mrstreamer/core/subtitles/text-file";
import { subdlDownload } from "../src/subtitles/service.ts";

afterEach(() => vi.unstubAllGlobals());

const key = "fictional-private-key";
const address = `https://elsewhere.invalid/private?key=${key}`;
const text = "1\n00:00:00,000 --> 00:00:02,000\nHello\n";

const candidate = {
  url: "/file.zip",
  language: "en",
  release: "Fixture",
  format: "SubRip",
  hearingImpaired: false,
} as const;

it.each([
  ["off-host", "unsupported"],
  ["redirect", "unsupported"],
  ["oversized", "unsupported"],
  ["interrupted", "unavailable"],
  ["quota", "quota"],
] as const)("refuses %s privately and permits a later download", async (kind, reason) => {
  const fetch = vi.fn(async () => {
    if (kind === "redirect") {
      const response = new Response(text);
      Object.defineProperty(response, "url", { value: address });

      return response;
    }

    if (kind === "oversized") return new Response(new Uint8Array(SUBTITLE_TEXT_LIMIT + 1));

    if (kind === "interrupted") {
      const response = new Response(text);
      Object.defineProperty(response, "body", {
        value: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(new Error(address));
          },
        }),
      });

      return response;
    }

    if (kind === "quota") return new Response(address, { status: 429 });

    return new Response(text);
  });

  vi.stubGlobal("fetch", fetch);

  const download = (url: string) =>
    subdlDownload({ ...candidate, url }, new AbortController().signal, async (bytes) =>
      kind === "oversized" ? new TextEncoder().encode(text) : bytes,
    );

  const failure: unknown = await download(kind === "off-host" ? address : candidate.url).catch(
    (cause: unknown) => cause,
  );

  expect(failure).toMatchObject({ reason, message: `Subtitle service: ${reason}.` });
  expect(String(failure)).not.toContain(address);
  expect(String(failure)).not.toContain(key);
  fetch.mockImplementation(async () => new Response(text));
  expect((await download(candidate.url)).cues).toEqual([{ start: 0, end: 2, text: "Hello" }]);
});
