// Real main runtime, provider catalogue, ffprobe and proxy establish the saved subtitle owner.
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { OnlineSubtitles } from "../src/main/services/online-subtitles.ts";
import { collect, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";
const hasTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

describe.skipIf(!hasTools)("saved subtitles of the actual playback session", () => {
  it("restores the exact file without a service request, keeps Off for it, and says which session's file was replaced", async () => {
    const provider = await fakeProvider({ titles: 1, maxConnections: 2, slotReleaseMs: 0 });
    const request = fetch;
    let serviceRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "api.subdl.com") {
        serviceRequests++;
        return Response.json({
          status: true,
          results: [{ tmdb_id: Number(url.searchParams.get("tmdb_id")), type: "movie" }],
          subtitles: [
            {
              language: "English",
              release_name: "Cinema cut",
              url: "https://dl.subdl.com/fixture.srt",
            },
          ],
        });
      }
      if (url.hostname === "dl.subdl.com") {
        serviceRequests++;
        return new Response("1\n00:00:01,000 --> 00:00:03,000\nWelcome.\n");
      }
      return request(input, init);
    });
    const runtime = runtimeFor(
      mainLayer({ ...testConfig(await tempDir()), ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
    );
    try {
      const subscriptions = await promised(runtime, Subscriptions);
      const titles = await promised(runtime, OnDemand);
      const playback = await promised(runtime, Playback);
      const subtitles = await promised(runtime, OnlineSubtitles);
      const saved = await subscriptions.add({
        server: provider.url,
        username: "demo",
        password: "demo",
      });
      await titles.refresh(saved.id);
      const movie = provider.titles.movies.find((title) =>
        title.name.startsWith("TEST | Long subtitles"),
      )!;
      const ref = { kind: "movie" as const, subscriptionId: saved.id, id: String(movie.id) };
      const open = async () => {
        const file = await titles.file(ref);
        return playback.openTitle(ref, file.url, ["h264", "aac"], file);
      };
      const first = await open();
      expect(await subtitles.saved(first.sessionId)).toBeNull();
      expect(serviceRequests).toBe(0);
      await subtitles.configure(
        { enabled: true, service: "subdl", languages: ["en"] },
        { subdl: { apiKey: "fixture-key" } },
      );
      expect(serviceRequests).toBe(0);
      const found = await subtitles.search(first.sessionId);
      const chosen = await subtitles.choose(first.sessionId, found.results[0]!.id);
      expect(chosen.saved.subtitle?.release).toBe("Cinema cut");
      await subtitles.timing(first.sessionId, { offset: -2, speed: 25 / 24 });
      expect(serviceRequests).toBe(2);
      await subtitles.hide(first.sessionId);
      await playback.close(first.sessionId);
      await expect(subtitles.saved(first.sessionId)).rejects.toBeDefined();
      const second = await open();
      expect(await subtitles.saved(second.sessionId)).toMatchObject({
        shown: false,
        timing: { offset: -2, speed: 25 / 24 },
        subtitle: { release: "Cinema cut" },
      });
      await subtitles.show(second.sessionId, chosen.saved.selection);
      expect(await subtitles.saved(second.sessionId)).not.toHaveProperty("shown");
      expect(serviceRequests).toBe(2);
      const replaced = await collect(runtime, playback.fileReplaced);
      const before = await request(`${second.url}?start=0`);
      await before.arrayBuffer();
      expect(replaced).toEqual([]);
      provider.replaceMovieFile(movie.id, "title-mpeg4-mp3.avi");
      const answer = await request(`${second.url}?start=0`);
      expect(answer.ok).toBe(true);
      await answer.arrayBuffer();
      await vi.waitFor(() => expect(replaced).toEqual([second.sessionId]));
      await expect(subtitles.saved(second.sessionId)).rejects.toBeDefined();
      await expect(subtitles.show(second.sessionId, chosen.saved.selection)).rejects.toBeDefined();
      await subtitles.hide(second.sessionId);
      await playback.close(second.sessionId);
      const replacement = await open();
      expect(await subtitles.saved(replacement.sessionId)).toBeNull();
      expect(serviceRequests).toBe(2);
    } finally {
      await runtime.dispose();
      vi.restoreAllMocks();
    }
  }, 30_000);
});
