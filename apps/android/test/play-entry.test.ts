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

  const stop = startEntries({
    intents,
    player,
    library: () => model,
    open,
    refused,
    progress: async () => [
      {
        title: {
          kind: "episode",
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
    ],
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
    model,
    player,
    intents,
    open,
    refused,
    stop,
    title,
    intent,
    media,
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

it("drops a selected episode when its source is withdrawn during the details read", async () => {
  const f = await setup();

  try {
    const pending = f.intents.state.get().play?.(f.intent, f.media);
    f.remove();
    await pending;
    expect(f.open).not.toHaveBeenCalled();
    expect(f.refused).not.toHaveBeenCalled();
    expect(f.player.state.get().kind).toBe("idle");
  } finally {
    f.stop();
    await f.player.stop();
  }
});

it("does not replace a newer channel play when episode details answer late", async () => {
  const f = await setup();

  try {
    const pending = f.intents.state.get().play?.(f.intent, f.media);
    f.player.play({ kind: "live", sourceId: "source", channelId: "7", title: "Channel" });
    await pending;
    expect(f.open).not.toHaveBeenCalled();
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
