import { describe, expect, it, vi } from "vitest";
import { store } from "../src/platform/store.ts";
import { subtitleModel } from "../src/subtitles/model.ts";
import type { PlayerState } from "../src/player/player.ts";
import {
  DEFAULT_SUBTITLE_TIMING,
  type SavedSubtitle,
} from "@mrstreamer/contracts/online-subtitles";

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

const saved: SavedSubtitle = {
  subtitle: {
    service: "subdl",
    language: "en",
    release: "Release",
    cues: [{ start: 5, end: 8, text: "Hello" }],
  },
  timing: DEFAULT_SUBTITLE_TIMING,
};

function setup() {
  const state = store<PlayerState>({ kind: "idle" });
  const text = vi.fn(async () => true);
  const player = { state, media: { text } };
  const setSidecar = vi.fn(async () => true);
  const setText = vi.fn(async () => true);
  const native = { setText, setSidecar, unpackSubtitle: async (bytes: Uint8Array) => bytes };
  const files = { read: vi.fn<() => SavedSubtitle | null>(() => saved), write: vi.fn(), remove: vi.fn() };

  const secrets = {
    read: vi.fn(async (): Promise<string | null> => null),
    write: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };

  const model = subtitleModel({
    player,
    native,
    files,
    secrets,
    title: async (intent) =>
      intent.kind === "title" ? { key: intent.id, query: { kind: "movie", tmdbId: 7 } } : null,
    languages: () => ["nl", "en"],
  });

  function play(id = "one") {
    state.set({
      kind: "playing",
      intent: {
        kind: "title",
        sourceId: "fixture",
        media: "movie",
        id,
        title: "Film",
        container: "mkv",
      },
      attempt: id,
      phase: "paused",
      positionMs: 9000,
      durationMs: 10000,
      bufferedMs: 9000,
      live: false,
      seekable: true,
      speed: 1,
      failure: null,
      tracks: [],
    });
  }

  return { model, state, files, secrets, setSidecar, play, text, setText };
}

describe("Android subtitles", () => {
  it("restores the subtitle kept for the exact version, and lists none for another", async () => {
    const s = setup();
    s.play();
    await vi.waitFor(() => expect(s.setSidecar).toHaveBeenCalledOnce());
    expect(s.files.read).toHaveBeenCalledWith("one");
    s.files.read.mockReturnValue(null);
    s.play("two");
    await vi.waitFor(() => expect(s.model.state.get().title?.key).toBe("two"));
    expect(s.model.state.get().saved).toBeNull();
  });
  it("keeps active text when the key or retained data is removed", async () => {
    const s = setup();
    s.play();
    await vi.waitFor(() => expect(s.setSidecar).toHaveBeenCalledOnce());
    expect(await s.model.removeKey()).toBe(true);
    expect(s.files.remove).not.toHaveBeenCalled();
    expect(await s.model.removeRetained()).toBe(true);
    expect(s.files.remove).toHaveBeenCalledWith("one");
    expect(s.text).not.toHaveBeenCalled();
    expect(s.setSidecar).toHaveBeenCalledOnce();
  });
  it("does not turn a failed read or write into saved data or a key presence", async () => {
    const s = setup();
    s.files.read.mockImplementation(() => {
      throw new Error("read");
    });
    s.play();
    await vi.waitFor(() => expect(s.model.state.get().error).toBe("read"));
    expect(await s.model.shift(1)).toBe(false);
    expect(s.files.write).not.toHaveBeenCalled();
    s.secrets.read.mockRejectedValue(new Error("withheld"));
    await s.model.readKey();
    expect(s.model.state.get()).toMatchObject({ keySaved: null, error: "keychain" });
    s.secrets.write.mockRejectedValue(new Error("refused"));
    expect(await s.model.saveKey("fixture")).toBe(false);
    expect(s.model.state.get().keySaved).toBeNull();
  });
  it("never applies a timing change it couldn't save", async () => {
    const s = setup();
    s.play();
    await vi.waitFor(() => expect(s.setSidecar).toHaveBeenCalledOnce());
    s.files.write.mockImplementation(() => {
      throw new Error("write");
    });
    s.setSidecar.mockClear();
    expect(await s.model.shift(1)).toBe(false);
    expect(s.setSidecar).not.toHaveBeenCalled();
  });
});

it("keeps a chosen subtitle before asking native to show it and leaves a refused save retryable", async () => {
  const s = setup();
  s.play();
  await vi.waitFor(() => expect(s.model.state.get().title).not.toBeNull());
  s.secrets.read.mockResolvedValue("fixture");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL) =>
      input.searchParams.has("api_key")
        ? new Response(
            JSON.stringify({
              status: true,
              results: [{ tmdb_id: 7, type: "movie" }],
              subtitles: [{ language: "en", name: "release.srt", url: "/subtitle.zip" }],
            }),
          )
        : new Response("1\n00:00:05,000 --> 00:00:08,000\nHello\n"),
    ),
  );

  try {
    await s.model.find();
    const id = s.model.state.get().results[0]?.id;

    if (!id) throw new Error("No result");
    s.files.write.mockImplementationOnce(() => {
      throw new Error("write");
    });
    s.setSidecar.mockClear();
    await s.model.choose(id);
    expect(s.model.state.get().error).toBe("not-saved");
    expect(s.setSidecar).not.toHaveBeenCalled();
    await s.model.retry();
    expect(s.files.write).toHaveBeenLastCalledWith(
      "one",
      expect.objectContaining({
        subtitle: expect.objectContaining({ cues: [{ start: 5, end: 8, text: "Hello" }] }),
      }),
    );
    expect(s.setSidecar).toHaveBeenCalledWith("one", expect.stringContaining("WEBVTT"), "en", 0, 1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("a late download cannot save or show text for a replacement play", async () => {
  const s = setup();
  s.play();
  await vi.waitFor(() => expect(s.model.state.get().title).not.toBeNull());
  s.secrets.read.mockResolvedValue("fixture");

  let finish: (value: Response) => void = () => {
    throw new Error("No download");
  };

  const downloading = new Promise<Response>((resolve) => {
    finish = resolve;
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL) =>
      input.searchParams.has("api_key")
        ? new Response(
            JSON.stringify({
              status: true,
              results: [{ tmdb_id: 7, type: "movie" }],
              subtitles: [{ language: "en", name: "release.srt", url: "/subtitle.zip" }],
            }),
          )
        : downloading,
    ),
  );

  try {
    await s.model.find();
    const id = s.model.state.get().results[0]?.id;

    if (!id) throw new Error("No result");
    const chosen = s.model.choose(id);
    s.files.read.mockReturnValue(null);
    s.play("two");
    finish(new Response("1\n00:00:05,000 --> 00:00:08,000\nHello\n"));
    await chosen;
    expect(s.files.write).not.toHaveBeenCalled();
    expect(s.setSidecar).toHaveBeenCalledTimes(1);
    expect(s.model.state.get().title?.key).toBe("two");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps both quick timing presses while native is applying", async () => {
  const s = setup();
  s.play();
  await vi.waitFor(() => expect(s.setSidecar).toHaveBeenCalledOnce());
  let release!: () => void;
  s.setSidecar.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }),
  );
  const first = s.model.shift(1);
  const second = s.model.shift(1);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  release();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(s.model.state.get().saved?.timing.offset).toBe(2);
});

it("reports a timing limit instead of silently ignoring it", async () => {
  const s = setup();
  s.files.read.mockReturnValue({ ...saved, timing: { offset: 600, speed: 1 } });
  s.play();
  await vi.waitFor(() => expect(s.setSidecar).toHaveBeenCalledOnce());
  expect(await s.model.shift(1)).toBe(false);
  expect(s.model.state.get().error).toBe("timing-limit");
});

it("keeps a refused Off mark retryable without bringing the sidecar back", async () => {
  const s = setup();
  s.play();
  await vi.waitFor(() => expect(s.setSidecar).toHaveBeenCalledOnce());
  s.files.write.mockImplementationOnce(() => {
    throw new Error("write");
  });
  expect(await s.model.select(null)).toBe(false);
  expect(s.model.state.get().error).toBe("selection-save");
  await s.model.retry();
  expect(s.model.state.get().saved?.shown).toBe(false);
  expect(s.setSidecar).toHaveBeenCalledOnce();
});

it("does not roll an old refused Off into the next title", async () => {
  const s = setup();
  s.play();
  await vi.waitFor(() => expect(s.setSidecar).toHaveBeenCalledOnce());
  let finish!: (ok: boolean) => void;
  s.text.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const off = s.model.select(null);
  s.files.read.mockReturnValue(null);
  s.play("two");
  await vi.waitFor(() => expect(s.model.state.get().title?.key).toBe("two"));
  finish(false);
  await off;
  expect(s.model.state.get().saved).toBeNull();
  expect(s.files.write.mock.calls.map((call) => call[0])).not.toContain("two");
});

it("leaves a refused text pick's error to media", async () => {
  const s = setup();
  s.play();
  await vi.waitFor(() => expect(s.setSidecar).toHaveBeenCalledOnce());
  s.text.mockResolvedValue(false);
  expect(await s.model.select(null)).toBe(false);
  expect(s.model.state.get().saved).toEqual(saved);
  expect(s.model.state.get().error).toBeNull();
});

it("reselects Downloaded without saving a global text preference", async () => {
  const s = setup();
  s.play();
  await vi.waitFor(() => expect(s.setSidecar).toHaveBeenCalledOnce());
  expect(await s.model.show()).toBe(true);
  expect(s.text).not.toHaveBeenCalled();
  expect(s.setText).toHaveBeenCalledWith("one", "mrstreamer-downloaded-subtitle");
});

it("keeps queued timing after Off without selecting the sidecar again", async () => {
  const s = setup();
  s.play();
  await vi.waitFor(() => expect(s.setSidecar).toHaveBeenCalledOnce());
  let finish!: (ok: boolean) => void;
  s.setSidecar.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = s.model.shift(1);
  const second = s.model.shift(1);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await s.model.select(null);
  finish(true);
  await first;
  await second;
  expect(s.model.state.get().saved).toMatchObject({ shown: false, timing: { offset: 2 } });
  expect(s.setSidecar).toHaveBeenCalledTimes(2);
});

it("shares the current restore while an old restore finishes", async () => {
  const s = setup();
  let finish!: (ok: boolean) => void;
  s.setSidecar.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  s.play();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  let next!: (ok: boolean) => void;
  s.setSidecar.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        next = resolve;
      }),
  );
  s.play("two");
  await vi.waitFor(() => expect(next).toBeTypeOf("function"));
  finish(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const retry = s.model.retry();
  expect(s.setSidecar).toHaveBeenCalledTimes(2);
  next(true);
  await retry;
});
