import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { databaseLayer } from "../src/main/platform/database.ts";
import { SavedSubtitles, savedSubtitlesLayer } from "../src/main/platform/saved-subtitles.ts";
import {
  OnlineSubtitles,
  SubtitleSessions,
  type SubtitleSession,
} from "../src/main/services/online-subtitles.ts";
import { SubtitleAccounts } from "../src/main/services/subtitle-accounts.ts";
import { promised, runtimeFor, tempDir, testSecrets } from "./support.ts";

const preferences = { enabled: true, languages: ["nl"], service: "both" as const };
const credentials = {
  subdl: { apiKey: "fixture-key" },
  opensubtitles: {
    apiKey: "fixture-open",
    username: "fixture-name",
    password: "fixture-password",
  },
};
const file = {
  account: "owner",
  kind: "movie" as const,
  id: "4k",
  sourceStamp: "source",
  listingKey: "listed-4k",
};
const srt = "1\n00:00:04,000 --> 00:00:06,000\nGood evening.\n";

async function setup(savedDir?: string) {
  const dir = savedDir ?? (await tempDir());
  let active = true;
  let sessionId = "playing-4k";
  let controller = new AbortController();
  const calls: string[] = [];
  let hold: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  let entered: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    const waiting = hold;
    if (waiting) {
      hold = null;
      entered?.resolve();
      await waiting.promise;
    }
    init?.signal?.throwIfAborted();
    if (url.startsWith("https://api.subdl.com"))
      return Response.json({
        status: true,
        results: [{ tmdb_id: 12, type: "movie" }],
        subtitles: [
          { language: "Dutch", release_name: "Cinema cut", url: "https://dl.subdl.com/cinema.srt" },
          { language: "Dutch", release_name: "Television cut", url: "https://dl.subdl.com/tv.srt" },
        ],
      });
    if (url.startsWith("https://api.opensubtitles.com"))
      return new Response("Rejected fixture", { status: 401 });
    if (url.startsWith("https://dl.subdl.com/")) return new Response(srt);
    throw new Error("Unexpected fixture request");
  };
  const layer = OnlineSubtitles.layer({ userAgent: "fixture", fetch: fetcher }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SubtitleAccounts.layer(dir, testSecrets),
        savedSubtitlesLayer.pipe(Layer.provide(databaseLayer(dir))),
        Layer.succeed(SubtitleSessions, {
          resolve: (id) =>
            Effect.sync((): SubtitleSession | null =>
              active && id === sessionId
                ? {
                    file,
                    signal: controller.signal,
                    query: { kind: "movie", tmdbId: 12, languages: [] },
                    standing: Effect.sync(() => active),
                  }
                : null,
            ),
        }),
      ),
    ),
  );
  const runtime = runtimeFor(layer);
  return {
    runtime,
    service: await promised(runtime, OnlineSubtitles),
    storage: await promised(runtime, SavedSubtitles),
    calls,
    stop() {
      active = false;
      controller.abort();
    },
    next() {
      controller.abort();
      controller = new AbortController();
      active = true;
      sessionId = "next-file";
    },
    hold() {
      hold = Promise.withResolvers<void>();
      entered = Promise.withResolvers<void>();
      return { entered: entered.promise, release: hold.resolve };
    },
  };
}

describe("online subtitles of the playing exact file", () => {
  it("makes no startup or settings requests, refuses disabled search, then shows partial results with opaque ids", async () => {
    const { service, calls } = await setup();
    expect((await service.settings()).enabled).toBe(false);
    await service.configure({ ...preferences, enabled: false }, credentials);
    await expect(service.search("playing-4k")).rejects.toMatchObject({
      error: { detail: "Online subtitle search is off." },
    });
    expect(calls).toEqual([]);
    await service.configure(preferences);
    const found = await service.search("playing-4k");
    expect(found.results.map((row) => row.release)).toEqual(["Cinema cut", "Television cut"]);
    expect(found.failures).toEqual([{ service: "opensubtitles", reason: "credentials" }]);
    expect(JSON.stringify(found)).not.toMatch(/https|fixture-key|fixture-password/);
    expect(calls.every((url) => !url.startsWith("https://dl.subdl.com"))).toBe(true);
    expect(new URL(calls[0]!).searchParams.get("tmdb_id")).toBe("12");
    await expect(service.choose("other-session", found.results[0]!.id)).rejects.toBeDefined();
  });

  it("keeps distinct corrections per cached result and restores the selected exact file after restart", async () => {
    const dir = await tempDir();
    const first = await setup(dir);
    await first.service.configure({ ...preferences, service: "subdl" }, credentials);
    const found = await first.service.search("playing-4k");
    const [cinema, tv] = found.results;
    await first.service.choose("playing-4k", cinema!.id);
    await first.service.timing("playing-4k", { offset: -50, speed: 24 / 25 });
    expect((await first.service.choose("playing-4k", tv!.id)).saved.timing).toEqual({
      offset: 0,
      speed: 1,
    });
    const current = await first.service.saved("playing-4k");
    const televisionSelection = current!.selection;
    await first.service.timing("playing-4k", { offset: 7, speed: 25 / 24 }, televisionSelection);

    expect((await first.service.choose("playing-4k", cinema!.id)).saved.timing).toEqual({
      offset: -50,
      speed: 24 / 25,
    });
    expect(first.calls.filter((url) => url.startsWith("https://dl.subdl.com/")).length).toBe(2);
    await first.runtime.dispose();
    const second = await setup(dir);
    expect((await second.service.saved("playing-4k"))?.timing).toEqual({
      offset: -50,
      speed: 24 / 25,
    });
    expect(second.calls).toEqual([]);
    const again = await second.service.search("playing-4k");
    await second.service.choose("playing-4k", again.results[1]!.id);
    expect((await second.service.saved("playing-4k"))?.timing).toEqual({
      offset: 7,
      speed: 25 / 24,
    });
    expect(second.calls.some((url) => url.startsWith("https://dl.subdl.com/"))).toBe(false);
    expect(await second.storage.read({ ...file, id: "hd" })).toBeNull();
  });

  it.each(["stop", "disable", "cancel"] as const)(
    "drops a held search after %s and cannot download its old result",
    async (action) => {
      const state = await setup();
      await state.service.configure({ ...preferences, service: "subdl" }, credentials);
      const held = state.hold();
      const pending = state.service.search("playing-4k");
      const rejected = expect(pending).rejects.toBeDefined();
      await held.entered;
      if (action === "stop") state.stop();
      else if (action === "disable")
        await state.service.configure({ ...preferences, enabled: false });
      else await state.service.cancel("playing-4k");
      held.release();
      await rejected;
      expect(state.calls.filter((url) => url.startsWith("https://dl.subdl.com/")).length).toBe(0);
      expect(await state.storage.read(file)).toBeNull();
    },
  );

  it("a later chosen result cancels the held download without replacing the saved current result", async () => {
    const state = await setup();
    await state.service.configure({ ...preferences, service: "subdl" }, credentials);
    const found = await state.service.search("playing-4k");
    const held = state.hold();
    const first = state.service.choose("playing-4k", found.results[0]!.id);
    const rejected = expect(first).rejects.toBeDefined();
    await held.entered;
    await state.service.choose("playing-4k", found.results[1]!.id);
    held.release();
    await rejected;
    expect((await state.service.saved("playing-4k"))?.subtitle?.release).toBe("Television cut");
    await state.service.forget("playing-4k");
    expect(await state.service.saved("playing-4k")).toBeNull();
  });
});

it("refuses a delayed correction for a result replaced by another choice", async () => {
  const app = await setup();
  await app.service.configure(preferences, credentials);
  const found = await app.service.search("playing-4k");
  const first = await app.service.choose("playing-4k", found.results[0]!.id);
  const second = await app.service.choose("playing-4k", found.results[1]!.id);
  expect(first.saved.selection).not.toBe(second.saved.selection);
  await expect(
    app.service.timing("playing-4k", { offset: 300, speed: 25 / 24 }, first.saved.selection),
  ).rejects.toBeDefined();
  expect((await app.service.saved("playing-4k"))?.timing).toEqual({ offset: 0, speed: 1 });
  await app.runtime.dispose();
});
