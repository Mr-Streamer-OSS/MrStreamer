// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { AttrList, Level } from "hls.js";
import { createEngine, type Engine } from "../../src/renderer/src/player/engine.ts";
import { streams, type Rendition } from "./hls-stand-in.ts";
import { defined } from "@mrstreamer/core/defined";

const fixture = vi.hoisted(() => ({
  parsed: () => {},
  levels: [] as Level[],
  starts: [] as Level[],
  groups: new Map<string, readonly Rendition[]>(),
  unsupported: new Set<Level>(),
  /** Levels whose capability query hls.js couldn't make, and those it still waits on. */
  unknown: new Set<Level>(),
  slow: new Map<Level, Promise<void>>(),
  /** Each level the engine held loading at, -1 for its own pick. */
  held: [] as number[],
}));
vi.mock("hls.js", async (original) => {
  const real = await original<typeof import("hls.js")>();
  const { standIn } = await import("./hls-stand-in.ts");
  return {
    ...real,
    default: class extends standIn(real.default) {
      startLevel = -1;
      override levels = fixture.levels;
      set loadLevel(index: number) {
        fixture.held.push(index);
      }
      get firstAutoLevel() {
        return this.levels.length - 1;
      }
      override once(event: string, listener: (event: string, data: unknown) => void) {
        if (event === real.default.Events.MANIFEST_PARSED)
          fixture.parsed = () => listener(event, {});
        else super.once(event, listener);
      }
      async getMediaDecodingInfo(level: Level) {
        await fixture.slow.get(level);
        return {
          supported: !fixture.unsupported.has(level) && !fixture.unknown.has(level),
          decodingInfoResults: [],
          ...(fixture.unknown.has(level) && { error: new Error("decodingInfo failed") }),
        };
      }
      override startLoad() {
        super.startLoad();
        const level = this.levels[this.startLevel === -1 ? this.firstAutoLevel : this.startLevel]!;
        this.currentLevel = this.levels.indexOf(level);
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
  fixture.unknown.clear();
  fixture.slow.clear();
  fixture.held = [];
});
function level(
  bitrate: number,
  group?: string,
  videoCodec = "avc1.42e01e",
  url = "http://localhost/fixture.m3u8",
) {
  return new Level({
    bitrate,
    name: "fixture",
    url,
    attrs: new AttrList({ "FRAME-RATE": "25", ...defined({ AUDIO: group || undefined }) }),
    videoCodec,
    audioCodec: "mp4a.40.2",
  });
}
async function open() {
  engine = createEngine("hls", document.createElement("video"), "http://localhost/master.m3u8", {
    audio: null,
    audioLanguage: "es",
  });
  await vi.dynamicImportSettled();
  fixture.parsed();
  return engine;
}
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

it("keeps the initial audio group and the requested sound through ABR and a later choice", async () => {
  const low = level(128, "english-only");
  const high = level(512, "multilingual");
  fixture.levels = [low, high];
  fixture.groups.set("english-only", [{ name: "English", lang: "en" }]);
  fixture.groups.set("multilingual", [
    { name: "English", lang: "en" },
    { name: "Español", lang: "es" },
  ]);
  const playing = await open();
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

it("holds the quality a shared recording reads from the start, and picks again once it ends", async () => {
  const low = level(128, undefined, undefined, "http://localhost/low.m3u8");
  const high = level(512, undefined, undefined, "http://localhost/high.m3u8");
  fixture.levels = [low, high];
  engine = createEngine("hls", document.createElement("video"), "http://localhost/master.m3u8", {
    audio: null,
    audioLanguage: null,
  });
  engine.fix?.(high.uri);
  await vi.dynamicImportSettled();
  fixture.parsed();
  await settle();
  expect(fixture.starts).toEqual([high]);
  expect(fixture.held).toEqual([1]);
  engine.fix?.(null);
  engine.fix?.(low.uri);
  await settle();
  expect(fixture.held).toEqual([1, -1, 0]);
});

// The main process sends only the recording's variant while they share: another can't stand in.
it.each(["before", "after"])(
  "fails as unsupported, never holding a quality it can't decode, named %s its levels are listed",
  async (when) => {
    const high = level(512, undefined, "hvc1.2.4.L153.B0", "http://localhost/high.m3u8");
    const low = level(128, undefined, undefined, "http://localhost/low.m3u8");
    fixture.levels = [high, low];
    fixture.unsupported.add(high);
    engine = createEngine("hls", document.createElement("video"), "http://localhost/master.m3u8", {
      audio: null,
      audioLanguage: null,
    });
    let failure: unknown;
    engine.started.catch((error: unknown) => (failure = error));
    if (when === "before") engine.fix?.(high.uri);
    await vi.dynamicImportSettled();
    fixture.parsed();
    if (when === "after") engine.fix?.(high.uri);
    await settle();
    expect(failure).toMatchObject({ kind: "unsupported" });
    // Named later, it finds the stream already loading at its own pick.
    expect(fixture.starts).toEqual(when === "before" ? [] : [low]);
    expect(fixture.held).toEqual([]);
  },
);

it.each(["saved", "asked"])(
  "holds a quality hls.js couldn't tell it decodes (%s), as for an unsupported supplemental codec",
  async (answer) => {
    const low = level(128, undefined, undefined, "http://localhost/low.m3u8");
    const high = level(512, undefined, undefined, "http://localhost/high.m3u8");
    if (answer === "saved")
      high.supportedResult = {
        supported: false,
        configurations: [],
        decodingInfoResults: [],
        error: new Error("SUPPLEMENTAL-CODECS not supported"),
      };
    else fixture.unknown.add(high);
    fixture.levels = [low, high];
    engine = createEngine("hls", document.createElement("video"), "http://localhost/master.m3u8", {
      audio: null,
      audioLanguage: null,
    });
    engine.fix?.(high.uri);
    await vi.dynamicImportSettled();
    fixture.parsed();
    await settle();
    expect(fixture.starts).toEqual([high]);
    expect(fixture.held).toEqual([1]);
  },
);

it("holds the quality already playing when a recording joins, without asking again", async () => {
  const low = level(128, undefined, undefined, "http://localhost/low.m3u8");
  fixture.levels = [low, level(512, undefined, undefined, "http://localhost/high.m3u8")];
  const playing = await open();
  await settle();
  expect(fixture.starts).toEqual([low]);
  let failure: unknown;
  playing.onFailure((error) => (failure = error));
  // Asked now, it would say no: what plays is the answer.
  fixture.unsupported.add(low);
  playing.fix?.(low.uri);
  await settle();
  expect(failure).toBeUndefined();
  expect(fixture.held).toEqual([0]);
});

// hls.js lists one of two twins at different addresses: the main process sends the held one.
it("starts as it would alone when hls.js doesn't list the held quality", async () => {
  const low = level(128);
  fixture.levels = [low, level(512)];
  engine = createEngine("hls", document.createElement("video"), "http://localhost/master.m3u8", {
    audio: null,
    audioLanguage: "es",
  });
  let failure: unknown;
  engine.started.catch((error: unknown) => (failure = error));
  engine.fix?.("http://localhost/twin.m3u8");
  await vi.dynamicImportSettled();
  fixture.parsed();
  await settle();
  expect(failure).toBeUndefined();
  expect(fixture.starts).toEqual([low]);
});

it("still waits for capability checks when a hold comes and goes during startup", async () => {
  const low = level(128, undefined, undefined, "http://localhost/low.m3u8");
  const middle = level(256, undefined, undefined, "http://localhost/middle.m3u8");
  const high = level(512, undefined, undefined, "http://localhost/high.m3u8");
  fixture.levels = [low, middle, high];
  const check = Promise.withResolvers<NonNullable<Level["supportedResult"]>>();
  low.supportedPromise = check.promise;
  void check.promise.then((result) => {
    low.supportedResult = result;
    fixture.levels.splice(fixture.levels.indexOf(low), 1);
  });
  const playing = await open();
  playing.fix?.(high.uri);
  playing.fix?.(null);
  await settle();
  expect(fixture.starts).toEqual([]);
  check.resolve({ supported: false, decodingInfoResults: [], configurations: [] });
  await settle();
  expect(fixture.starts).toEqual([middle]);
});

it("starts as it would alone when a hold that stopped startup is given up before its check answers", async () => {
  const low = level(128, undefined, undefined, "http://localhost/low.m3u8");
  const high = level(512, undefined, undefined, "http://localhost/high.m3u8");
  fixture.levels = [low, high];
  const check = Promise.withResolvers<NonNullable<Level["supportedResult"]>>();
  low.supportedPromise = check.promise;
  void check.promise.then((result) => (low.supportedResult = result));
  fixture.slow.set(high, new Promise(() => {}));
  const playing = await open();
  playing.fix?.(high.uri);
  check.resolve({ supported: true, decodingInfoResults: [], configurations: [] });
  await settle();
  expect(fixture.starts).toEqual([]);
  playing.fix?.(null);
  await settle();
  expect(fixture.starts).toEqual([low]);
});

it("starts with the lowest bitrate when no audio group changes", async () => {
  const low = level(128);
  fixture.levels = [low, level(512)];
  await open();
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
    const playing = await open();
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
  await open();
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
    await open();
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
  await open();
  await settle();
  expect(fixture.starts).toEqual([high]);
});

it("preserves every merged audio group containing the requested language", async () => {
  const low = level(128, "english");
  const high = level(512, "english");
  high.addGroupId("audio", "spanish");
  fixture.levels = [low, high];
  fixture.groups.set("english", [{ name: "English", lang: "en" }]);
  fixture.groups.set("spanish", [{ name: "Español", lang: "es" }]);
  await open();
  expect(fixture.starts).toEqual([high]);
  expect(streams.latest().audioTrack).toBe(1);
});
