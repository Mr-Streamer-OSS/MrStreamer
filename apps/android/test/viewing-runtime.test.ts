import { expect, it, vi } from "vitest";
import type { Json } from "@mrstreamer/contracts/json";
import type { LibraryModel } from "../src/library/model.ts";
import type { Settled } from "../src/player/player.ts";
import { fixture } from "./library-fixture.ts";

const scenario = vi.hoisted(() => ({
  model: undefined as LibraryModel | undefined,
  saved: null as Json,
  refused: false,
  listeners: new Set<(settled: Settled) => void>(),
}));

vi.mock("../src/bootstrap/sources.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return { sources: { state: store({ kind: "ready", sources: [{ id: "source" }] }) } };
});

vi.mock("../src/library/runtime.ts", () => ({ library: () => scenario.model! }));

vi.mock("../src/live/runtime.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return { lists: { state: store({ kind: "ready", lists: [] }) } };
});

vi.mock("../src/home/storage.ts", () => ({ readViewing: () => structuredClone(scenario.saved) }));

vi.mock("../src/platform/storage.ts", () => ({
  readJsonStrict: () => structuredClone(scenario.saved),
  writeJson: (_: string, value: Json) => {
    if (scenario.refused) throw new Error("refused");
    scenario.saved = structuredClone(value);
  },
}));

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    player: {
      state: store({ kind: "idle" }),
      previewState: store({ kind: "idle" }),
      onSettled(listener: (settled: Settled) => void) {
        scenario.listeners.add(listener);

        return () => scenario.listeners.delete(listener);
      },
    },
  };
});

import { startViewing, viewing, viewingFailure } from "../src/home/index.ts";
import { libraryViewing } from "../src/library/intents.ts";

it("registers Details for the app lifetime, saves settled progress and reconciles a refused save through retry", async () => {
  const f = fixture();
  await f.model.refresh();
  scenario.model = f.model;
  const stop = startViewing();

  try {
    await expect.poll(() => viewing.state.get().kind).toBe("ready");
    const title = f.model.made("movie").list("all", "title")[0]!;
    libraryViewing.state.get()!.play({
      kind: "movie",
      sourceId: "source",
      titleKey: title.key,
      titleId: title.id,
      version: title.versions[0]!,
    });

    const emit = (positionMs: number) => {
      for (const listener of scenario.listeners)
        listener({
          intent: {
            kind: "title",
            sourceId: "source",
            media: "movie",
            id: title.id,
            container: "mp4",
            title: title.title,
          },
          phase: "paused",
          positionMs,
          durationMs: 1800000,
        });
    };

    emit(300000);
    await expect.poll(() => viewing.state.get().viewing?.continueWatching[0]?.position).toBe(300);
    const saved = structuredClone(scenario.saved);
    scenario.refused = true;
    emit(600000);
    await expect.poll(() => viewingFailure.get()?.kind).toBe("progress");
    expect(viewing.state.get().viewing?.continueWatching[0]?.position).toBe(300);
    expect(scenario.saved).toEqual(saved);
    scenario.refused = false;
    viewingFailure.get()!.retry();
    await expect.poll(() => viewing.state.get().viewing?.continueWatching[0]?.position).toBe(600);
    expect(viewingFailure.get()).toBe(null);
  } finally {
    scenario.refused = false;
    stop();
    await viewing.dispose();
    scenario.saved = null;
    viewingFailure.set(null);
  }

  expect(libraryViewing.state.get()).toBeUndefined();
  expect(scenario.listeners.size).toBe(0);
});
