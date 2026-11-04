import { expect, it, vi } from "vitest";
import type { OnDemandReader } from "../src/connect/sources.ts";
import { fixture } from "./library-fixture.ts";
import { sources } from "../src/bootstrap/sources.ts";
import { library } from "../src/library/runtime.ts";
import { libraryIntents } from "../src/library/intents.ts";
import { startPlayEntries } from "../src/play-entry/runtime.ts";
import { player } from "../src/player/instance.ts";
import { xtreamProvider } from "@mrstreamer/core/xtream";

const ui = vi.hoisted(() => ({ push: vi.fn(), alert: vi.fn(), progress: vi.fn(async () => []) }));

vi.mock("expo-router", () => ({ router: { push: ui.push } }));

vi.mock("react-native", () => ({ Alert: { alert: ui.alert } }));

vi.mock("expo", () => ({
  requireNativeModule: () => {
    throw new Error("native unavailable");
  },
}));

vi.mock("../src/home/index.ts", () => ({
  viewing: { progress: ui.progress, state: { get: () => ({ kind: "ready" }) } },
}));

vi.mock("../src/bootstrap/sources.ts", async () => {
  const { store } = await import("../src/platform/store.ts");
  const readers = new Map<string, OnDemandReader>();

  return {
    sources: {
      state: store({ kind: "ready", sources: [] }),
      onDemand: (id: string) => readers.get(id),
      readers,
    },
  };
});

vi.mock("../src/player/instance.ts", async () => {
  const { playerOwner } = await import("../src/player/player.ts");

  return {
    player: playerOwner(
      {
        admit: async () => true,
        pause: async () => true,
        resume: async () => true,
        seek: async () => true,
        setSpeed: async () => true,
        setQuality: async () => true,
        stop: async () => true,
        capabilities: () => ({ containers: [], decoders: {} }),
        addListener: () => ({ remove() {} }),
      },
      async () => ({
        url: "https://fixture.invalid/file",
        headers: {},
        format: "progressive",
        mode: "title",
        startMs: 0,
      }),
    ),
  };
});

it("production subscription keeps pending Play and Next across catalogue churn, but withdraws a replaced reader", async () => {
  const f = fixture();

  const reader = xtreamProvider(
    { server: "https://fixture.invalid", username: "test", password: "test" },
    { fetch: f.fetchImpl, userAgent: "test" },
  );

  const control = sources as typeof sources & { readers: Map<string, typeof reader> };
  control.readers.set("source", reader);

  const source = {
    id: "source",
    kind: "xtream",
    label: "Fixture",
    channels: { kind: "ready", rows: [] },
  } as const;

  sources.state.set({ kind: "ready", sources: [source] });
  const model = library();
  await model.refresh();
  const title = model.made("series").list("all")[0]!;
  const version = title.versions[0]!;

  const media = {
    kind: "episode",
    sourceId: "source",
    episodeId: "first",
    titleKey: title.key,
    titleId: title.id,
    version,
  } as const;

  const intent = {
    kind: "title",
    media: "episode",
    sourceId: "source",
    id: "first",
    container: "mp4",
    title: "First",
  } as const;

  const stop = startPlayEntries();

  try {
    expect(ui.push).not.toHaveBeenCalled();
    const pending = libraryIntents.state.get().play?.(intent, media);
    sources.state.set({ kind: "ready", sources: [source, { ...source, id: "other" }] });
    await pending;
    expect(ui.push).toHaveBeenCalledTimes(1);
    expect(player.media.state.get().next?.intent.id).toBe("second");
    sources.state.set({ kind: "ready", sources: [{ ...source, channels: { kind: "loading" } }] });
    expect(player.media.state.get().next?.intent.id).toBe("second");
    ui.progress.mockRejectedValue(new Error("disk"));
    await libraryIntents.state.get().play?.({ ...intent, resumeAt: 12000 }, media);
    expect(player.state.get()).toMatchObject({ intent: { resumeAt: 12000 } });
    expect(ui.alert).not.toHaveBeenCalled();
    await libraryIntents.state.get().play?.(intent, media);
    expect(ui.alert).toHaveBeenLastCalledWith("Couldn't read viewing history", undefined, [
      { text: "Try again", onPress: expect.any(Function) },
      { text: "Play from beginning", onPress: expect.any(Function) },
    ]);
    control.readers.set(
      "source",
      xtreamProvider(
        { server: "https://fixture.invalid", username: "replacement", password: "fixture" },
        { fetch: f.fetchImpl, userAgent: "test" },
      ),
    );
    sources.state.set({ kind: "ready", sources: [source] });
    expect(player.media.state.get().next).toBeNull();
    control.readers.delete("source");
    sources.state.set({ kind: "ready", sources: [] });
    expect(player.media.state.get().next).toBeNull();
  } finally {
    stop();
    await player.stop();
  }
});
