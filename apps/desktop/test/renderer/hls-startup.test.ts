// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { AttrList, Level } from "hls.js";
import { createEngine, type Engine } from "../../src/renderer/src/player/engine.ts";
import { streams, type Rendition } from "./hls-stand-in.ts";

const fixture = vi.hoisted(() => ({
  parsed: () => {},
  levels: [] as Level[],
  starts: [] as Level[],
  groups: new Map<string, readonly Rendition[]>(),
  unsupported: new Set<Level>(),
}));
vi.mock("hls.js", async (original) => {
  const real = await original<typeof import("hls.js")>();
  const { standIn } = await import("./hls-stand-in.ts");
  return {
    ...real,
    default: class extends standIn(real.default) {
      startLevel = -1;
      override levels = fixture.levels;
      get firstAutoLevel() {
        return this.levels.length - 1;
      }
      override once(event: string, listener: (event: string, data: unknown) => void) {
        if (event === real.default.Events.MANIFEST_PARSED)
          fixture.parsed = () => listener(event, {});
        else super.once(event, listener);
      }
      getMediaDecodingInfo(level: Level) {
        return Promise.resolve({
          supported: !fixture.unsupported.has(level),
          decodingInfoResults: [],
        });
      }
      override startLoad() {
        super.startLoad();
        const level = this.levels[this.startLevel === -1 ? this.firstAutoLevel : this.startLevel]!;
        fixture.starts.push(level);
        this.variant({
          audio: (level.audioGroups ?? []).flatMap(
            (group) => fixture.groups.get(group ?? "") ?? [],
          ),
        });
      }
    },
  };
});

let engine: Engine | undefined;
afterEach(() => {
  engine?.destroy();
  fixture.starts = [];
  fixture.groups.clear();
  fixture.unsupported.clear();
});
function level(bitrate: number, group?: string, videoCodec = "avc1.42e01e") {
  return new Level({
    bitrate,
    name: "fixture",
    url: "http://localhost/fixture.m3u8",
    attrs: new AttrList({ "FRAME-RATE": "25", ...(group ? { AUDIO: group } : {}) }),
    videoCodec,
    audioCodec: "mp4a.40.2",
  });
}
function open() {
  engine = createEngine("hls", document.createElement("video"), "http://localhost/master.m3u8", {
    audio: null,
    audioLanguage: "es",
  });
  fixture.parsed();
  return engine;
}
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

it("keeps the initial audio group and the requested sound through ABR and a later choice", () => {
  const low = level(128, "english-only");
  const high = level(512, "multilingual");
  fixture.levels = [low, high];
  fixture.groups.set("english-only", [{ name: "English", lang: "en" }]);
  fixture.groups.set("multilingual", [
    { name: "English", lang: "en" },
    { name: "Español", lang: "es" },
  ]);
  const playing = open();
  expect(fixture.starts).toEqual([high]);
  expect(streams.latest().audioTrack).toBe(1);
  let audioId: number | undefined;
  playing.tracks!.onChange((tracks) => {
    audioId = tracks.audio.find((track) => track.language === "en")?.id;
  });
  streams.latest().variant({ audio: (fixture.groups.get("multilingual") ?? []).toReversed() });
  playing.tracks!.setAudio(audioId!);
  streams.latest().variant({ audio: fixture.groups.get("multilingual") ?? [] });
  expect(streams.latest().audioTrack).toBe(0);
});

it("starts with the lowest bitrate when no audio group changes", async () => {
  const low = level(128);
  fixture.levels = [low, level(512)];
  open();
  await settle();
  expect(fixture.starts).toEqual([low]);
});

it.each([false, true])(
  "waits for capability removal and cannot restart after Stop (%s)",
  async (stop) => {
    const low = level(128);
    const middle = level(256);
    fixture.levels = [low, middle, level(512)];
    const check = Promise.withResolvers<NonNullable<Level["supportedResult"]>>();
    low.supportedPromise = check.promise;
    // hls.js registers this handler before its firstAutoLevel getter returns the pending check.
    void check.promise.then((result) => {
      low.supportedResult = result;
      fixture.levels.splice(fixture.levels.indexOf(low), 1);
    });
    const playing = open();
    expect(fixture.starts).toEqual([]);
    if (stop) playing.destroy();
    check.resolve({ supported: false, decodingInfoResults: [], configurations: [] });
    await settle();
    expect(fixture.starts).toEqual(stop ? [] : [middle]);
  },
);

it("leaves startup to hls.js when a capability query rejects", async () => {
  const low = level(128);
  const high = level(512);
  fixture.levels = [low, high];
  const check = Promise.withResolvers<NonNullable<Level["supportedResult"]>>();
  low.supportedPromise = check.promise;
  open();
  check.reject(new Error("Capability service unavailable"));
  await settle();
  expect(fixture.starts).toEqual([high]);
});

it("uses default startup when capability service stays pending", async () => {
  vi.useFakeTimers();
  try {
    const low = level(128);
    const high = level(512);
    fixture.levels = [low, high];
    low.supportedPromise = new Promise(() => {});
    open();
    expect(fixture.starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.starts).toEqual([high]);
  } finally {
    engine?.destroy();
    vi.useRealTimers();
  }
});

// Only the initial higher level has been visited by ABR; the lower profile is unqueried.
it("validates an unvisited lower decoder profile before overriding startup", async () => {
  const low = level(128, undefined, "hvc1.2.4.L93.B0");
  const high = level(512, undefined, "hvc1.1.6.L93.B0");
  fixture.levels = [low, high];
  fixture.unsupported.add(low);
  open();
  await settle();
  expect(fixture.starts).toEqual([high]);
});

it("preserves every merged audio group containing the requested language", () => {
  const low = level(128, "english");
  const high = level(512, "english");
  high.addGroupId("audio", "spanish");
  fixture.levels = [low, high];
  fixture.groups.set("english", [{ name: "English", lang: "en" }]);
  fixture.groups.set("spanish", [{ name: "Español", lang: "es" }]);
  open();
  expect(fixture.starts).toEqual([high]);
  expect(streams.latest().audioTrack).toBe(1);
});
