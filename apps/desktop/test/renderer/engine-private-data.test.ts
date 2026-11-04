// @vitest-environment happy-dom
import "./support.ts";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createEngine } from "../../src/renderer/src/player/engine.ts";

const source = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("mpegts.js", () => ({
  default: {
    getFeatureList: () => ({ mseLivePlayback: true }),
    Events: { PES_PRIVATE_DATA_ARRIVED: "private-data" },
    createPlayer: source.create,
  },
}));

it("delivers subtitle packets using numeric pts first, then numeric nearest_pts", async () => {
  const player = Object.assign(new EventEmitter(), {
    attachMediaElement: vi.fn(),
    load: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    unload: vi.fn(),
    detachMediaElement: vi.fn(),
    destroy: vi.fn(),
  });

  source.create.mockReturnValue(player);

  const engine = createEngine("mpegts", document.createElement("video"), "http://localhost/live", {
    audio: null,
    audioLanguage: null,
  });

  const receive = vi.fn();
  engine.onPrivateData(receive);

  try {
    await vi.dynamicImportSettled();
    const data = new Uint8Array([1, 2]);
    player.emit("private-data", { pid: 44, data, pts: 2000, nearest_pts: "N/A" });
    player.emit("private-data", { pid: 44, data, pts: "N/A", nearest_pts: 3000 });
    player.emit("private-data", { pid: 44, data, pts: 4000, nearest_pts: 5000 });
    player.emit("private-data", { pid: 44, data, pts: "N/A", nearest_pts: null });
    expect(receive.mock.calls).toEqual([
      [44, data, 2],
      [44, data, 3],
      [44, data, 4],
    ]);
  } finally {
    engine.destroy();
    await expect(engine.started).rejects.toMatchObject({ detail: "Stopped." });
  }
});
