import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const catalogue = vi.fn();
  const setPart = vi.fn();
  const foreground = { callback: (_state: string) => {} };
  const source = { id: "xtream:fixture", channels: { kind: "ready", rows: [] } };

  return { catalogue, setPart, foreground, source };
});

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_name: string, callback: (state: string) => void) => {
      fixture.foreground.callback = callback;
    },
  },
}));

vi.mock("../src/bootstrap/sources.ts", () => ({
  sources: {
    state: {
      get: () => ({ kind: "ready", sources: [fixture.source] }),
      subscribe: () => () => {},
    },
  },
}));

vi.mock("../src/platform/credentials.ts", () => ({
  nativeCredentials: () => ({ read: async () => ({ kind: "xtream", username: "", password: "" }) }),
}));

vi.mock("../src/platform/tasks.ts", () => ({
  inTasks: async () => ({ subscriptionId: "xtream:fixture" }),
}));

vi.mock("@mrstreamer/core/xtream", () => ({
  xtreamProvider: () => ({ liveCatalogue: fixture.catalogue }),
}));

vi.mock("../src/guide/guide-sources.ts", () => ({
  guides: { load: () => ({ ids: [], kept: [] }), restore: async () => {} },
}));

vi.mock("../src/guide/guide.ts", () => ({
  origins: new Map(),
  guide: {
    restore: async () => {},
    attach: async () => {},
    setPart: fixture.setPart,
    foreground: () => {},
    background: () => {},
  },
}));

vi.mock("../src/connect/playlist.ts", () => ({ playlistReader: vi.fn() }));

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

import { startGuide } from "../src/guide/runtime.ts";

it("retries a failed guide catalogue read on foreground with the same source identity", async () => {
  fixture.catalogue.mockRejectedValueOnce(new Error("network")).mockResolvedValue({});
  await startGuide();
  await vi.waitFor(() => expect(fixture.catalogue).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(fixture.setPart).not.toHaveBeenCalled());
  fixture.foreground.callback("active");
  await vi.waitFor(() =>
    expect(fixture.setPart).toHaveBeenCalledWith({ subscriptionId: "xtream:fixture" }),
  );
  expect(fixture.catalogue).toHaveBeenCalledTimes(2);
});
