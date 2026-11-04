import { expect, it, vi } from "vitest";
import { fixture } from "./library-fixture.ts";
import { libraryModel } from "../src/library/model.ts";
import { intentRegistry } from "../src/library/intents.ts";
import { startEntries } from "../src/play-entry/entries.ts";
import { programmeEntry } from "../src/play-entry/programme.ts";
import { playerOwner } from "../src/player/player.ts";
import type { NativePlayer } from "../src/player/native.ts";

vi.mock("expo", () => ({
  requireNativeModule: () => {
    throw new Error("native unavailable");
  },
}));

async function setup() {
  const f = fixture();
  let available = true;

  const model = libraryModel({
    sources: () => (available ? [{ ...f.source, reader: f.source }] : []),
    language: () => "en",
  });

  await model.refresh();

  const native: NativePlayer = {
    admit: async () => true,
    pause: async () => true,
    resume: async () => true,
    seek: async () => true,
    setSpeed: async () => true,
    setQuality: async () => true,
    stop: async () => true,
    capabilities: () => ({ containers: [], decoders: {} }),
    addListener: () => ({ remove() {} }),
  };

  const player = playerOwner(native, async () => ({
    url: "https://fixture.invalid/file",
    headers: {},
    format: "progressive",
    mode: "title",
    startMs: 0,
  }));

  const intents = intentRegistry();
  const open = vi.fn();
  const refused = vi.fn();
  const listeners = new Set<() => void>();

  const progress = vi.fn(async () => [
    {
      title: {
        kind: "episode" as const,
        subscriptionId: "source",
        id: "first",
        seriesId: "10",
        season: 1,
        episode: 1,
      },
      position: 50,
      duration: 100,
      finished: false,
      at: 1,
      since: 1,
    },
  ]);

  const stop = startEntries({
    intents,
    player,
    library: () => model,
    open,
    refused,
    progress,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  });

  const title = model.made("series").list("all")[0]!;
  const version = title.versions[0]!;

  const intent = {
    kind: "title",
    media: "episode",
    sourceId: "source",
    id: "first",
    container: "mp4",
    title: "First",
  } as const;

  const media = {
    kind: "episode",
    episodeId: "first",
    sourceId: "source",
    titleKey: title.key,
    titleId: title.id,
    version,
  } as const;

  return {
    ...f,
    progress,
    model,
    player,
    intents,
    open,
    refused,
    stop,
    title,
    intent,
    media,
    restore() {
      available = true;

      for (const listener of listeners) listener();
    },
    remove() {
      available = false;

      for (const listener of listeners) listener();
    },
  };
}

it("admits an exact selected-version episode and exposes its real successor only for that lifetime", async () => {
  const f = await setup();

  try {
    expect(f.player.state.get().kind).toBe("idle");
    expect(f.open).not.toHaveBeenCalled();
    f.intents.state.get().play?.(f.intent, f.media);
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledWith({ ...f.intent, resumeAt: 45000 }));
    expect(f.player.media.state.get().next?.intent.id).toBe("second");
    f.player.media.playNext();
    expect(f.player.state.get()).toMatchObject({ intent: { id: "second", sourceId: "source" } });
    f.remove();
    expect(f.player.media.state.get().next).toBeNull();
  } finally {
    f.stop();
    await f.player.stop();
  }

  expect(f.intents.state.get().play).toBeUndefined();
});

it("refuses wrong files and failed details; cleanup drops pending entry work without navigation", async () => {
  const f = await setup();

  try {
    f.intents.state.get().play?.({ ...f.intent, container: "mkv" }, f.media);
    await vi.waitFor(() => expect(f.refused).toHaveBeenCalledTimes(1));
    f.failDetails(true);
    f.intents.state.get().play?.(f.intent, f.media);
    await vi.waitFor(() => expect(f.refused).toHaveBeenCalledTimes(2));
    f.failDetails(false);
    const pending = f.intents.state.get().play?.(f.intent, f.media);
    f.stop();
    await pending;
    expect(f.open).not.toHaveBeenCalled();
    expect(f.player.state.get().kind).toBe("idle");
  } finally {
    f.stop();
    await f.player.stop();
  }
});

it("lets a newer channel play or a source withdrawal win over late episode details", async () => {
  const f = await setup();

  try {
    const overtaken = f.intents.state.get().play?.(f.intent, f.media);
    f.player.play({ kind: "live", sourceId: "source", channelId: "7", title: "Channel" });
    await overtaken;
    const withdrawn = f.intents.state.get().play?.(f.intent, f.media);
    f.remove();
    await withdrawn;
    expect(f.open).not.toHaveBeenCalled();
    expect(f.refused).not.toHaveBeenCalled();
    expect(f.player.state.get()).toMatchObject({ intent: { kind: "live", channelId: "7" } });
  } finally {
    f.stop();
    await f.player.stop();
  }
});

it("keeps Live separate from exact programme windows and archive refusal reasons", () => {
  const now = 1793700100000;
  const identity = { sourceId: "source", channelId: "7" };
  const channel = { id: "7", catchupDays: 2 };

  const programme = {
    title: "Earlier",
    start: now - 3600000,
    stop: now - 1800000,
    description: null,
  };

  const entry = programmeEntry(identity, channel, "Channel", programme, now)!;
  expect(entry.live).toEqual({ kind: "live", ...identity, title: "Channel" });
  expect(entry.archive).toEqual({
    kind: "catch-up",
    ...identity,
    title: "Earlier",
    days: 2,
    window: { start: programme.start, end: programme.stop },
  });
  expect(
    programmeEntry(identity, { ...channel, id: "other" }, "Channel", programme, now),
  ).toBeNull();
  expect(
    programmeEntry(identity, { ...channel, catchupDays: null }, "Channel", programme, now),
  ).toMatchObject({ archive: null, reason: "none" });
  expect(programmeEntry(identity, channel, "Channel", programme, now + 3 * 86400000)).toMatchObject(
    { archive: null, reason: "outside" },
  );
  expect(
    programmeEntry(
      identity,
      channel,
      "Channel",
      { ...programme, start: now + 1000, stop: now + 2000 },
      now,
    ),
  ).toMatchObject({ archive: null, reason: "future" });
});

it("keeps known resume independent of unreadable history and offers explicit recovery for a manual Play", async () => {
  const f = await setup();

  try {
    f.progress.mockRejectedValue(new Error("disk"));
    await f.intents.state.get().play?.({ ...f.intent, resumeAt: 23000 }, f.media);
    expect(f.open).toHaveBeenCalledWith({ ...f.intent, resumeAt: 23000 });
    await vi.waitFor(() => expect(f.progress).toHaveBeenCalledTimes(1));
    expect(f.player.media.state.get().next).toBeNull();
    await f.intents.state.get().play?.(f.intent, f.media);
    expect(f.refused).toHaveBeenLastCalledWith(
      "history",
      expect.any(Function),
      expect.any(Function),
    );
    expect(f.open).toHaveBeenCalledTimes(1);
    f.refused.mock.calls.at(-1)![2]();
    await vi.waitFor(() => expect(f.open).toHaveBeenLastCalledWith({ ...f.intent, resumeAt: 0 }));
  } finally {
    f.stop();
    await f.player.stop();
  }
});

it("admits the selected movie and distinguishes missing media from failed provider details", async () => {
  const f = await setup();
  const title = f.model.made("movie").list("all")[0]!;
  const version = title.versions[0]!;

  const intent = {
    kind: "title",
    media: "movie",
    sourceId: "source",
    id: version.id,
    container: "mp4",
    title: title.title,
  } as const;

  const media = {
    kind: "movie",
    sourceId: "source",
    titleKey: title.key,
    titleId: title.id,
    version,
  } as const;

  try {
    await f.intents.state.get().play?.(intent, media);
    expect(f.open).toHaveBeenCalledWith({ ...intent, resumeAt: 0 });
    await f.intents.state.get().play?.({ ...intent, container: "mkv" }, media);
    expect(f.refused).toHaveBeenLastCalledWith("file", expect.any(Function), undefined);
    await f.intents.state.get().play?.(intent);
    expect(f.refused).toHaveBeenLastCalledWith("file", expect.any(Function), undefined);
    f.failDetails(true);
    await f.intents.state.get().play?.(f.intent, f.media);
    expect(f.refused).toHaveBeenLastCalledWith("details", expect.any(Function), undefined);
  } finally {
    f.stop();
    await f.player.stop();
  }
});

it("keeps a pending tap when background playback becomes idle and clears title Next after Live", async () => {
  const f = await setup();

  try {
    f.player.play({ kind: "live", sourceId: "source", channelId: "7", title: "Channel" });
    const pending = f.intents.state.get().play?.(f.intent, f.media);
    f.player.state.set({ kind: "idle" });
    await pending;
    expect(f.open).toHaveBeenCalledWith({ ...f.intent, resumeAt: 45000 });
    expect(f.player.media.state.get().next?.intent.id).toBe("second");
    await f.intents.state
      .get()
      .play?.({ kind: "live", sourceId: "source", channelId: "7", title: "Channel" });
    f.player.play(f.intent);
    expect(f.player.media.state.get().next).toBeNull();
  } finally {
    f.stop();
    await f.player.stop();
  }
});

it("plays a known current resume immediately, then publishes saved Next progress", async () => {
  const f = await setup();
  let resolve!: (value: Awaited<ReturnType<typeof f.progress>>) => void;

  const history = new Promise<Awaited<ReturnType<typeof f.progress>>>((done) => {
    resolve = done;
  });

  f.progress.mockReturnValue(history);

  try {
    await f.intents.state.get().play?.({ ...f.intent, resumeAt: 23000 }, f.media);
    expect(f.open).toHaveBeenCalledWith({ ...f.intent, resumeAt: 23000 });
    expect(f.player.media.state.get().next).toBeNull();
    resolve([
      {
        title: {
          kind: "episode",
          subscriptionId: "source",
          id: "second",
          seriesId: "10",
          season: 2,
          episode: 1,
        },
        position: 80,
        duration: 100,
        finished: false,
        at: 1,
        since: 1,
      },
    ]);
    await vi.waitFor(() => expect(f.player.media.state.get().next?.intent.resumeAt).toBe(75000));
    f.player.media.playNext();
    expect(f.player.state.get()).toMatchObject({ intent: { id: "second", resumeAt: 75000 } });
  } finally {
    f.stop();
    await f.player.stop();
  }
});

it.each(["source", "cleanup", "newer"] as const)(
  "discards late Next history after %s withdrawal",
  async (withdrawal) => {
    const f = await setup();
    let resolve!: (value: Awaited<ReturnType<typeof f.progress>>) => void;
    f.progress.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );

    let stopReplacement: (() => void) | undefined;

    try {
      await f.intents.state.get().play?.({ ...f.intent, resumeAt: 23000 }, f.media);
      await vi.waitFor(() => expect(f.progress).toHaveBeenCalled());

      if (withdrawal === "source") {
        f.remove();
        f.restore();
      } else if (withdrawal === "cleanup") {
        f.stop();
        stopReplacement = startEntries({
          intents: f.intents,
          player: f.player,
          library: () => f.model,
          open: f.open,
          refused: f.refused,
          progress: async () => [],
          subscribe: () => () => {},
        });
        await f.intents.state.get().play?.(f.intent, f.media);
        expect(f.player.media.state.get().next?.intent.id).toBe("second");
      } else f.player.play({ kind: "live", sourceId: "source", channelId: "7", title: "Channel" });
      resolve([]);
      await Promise.resolve();
      await Promise.resolve();
      // Returning through a separate player action cannot resurrect withdrawn history.
      f.player.play(f.intent);

      if (withdrawal === "cleanup")
        expect(f.player.media.state.get().next?.intent.id).toBe("second");
      else expect(f.player.media.state.get().next).toBeNull();
    } finally {
      stopReplacement?.();
      f.stop();
      await f.player.stop();
    }
  },
);
