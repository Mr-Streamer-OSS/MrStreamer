import { mount } from "./guide-grid-fixture.ts";
import { act, createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { sources } from "../src/bootstrap/sources.ts";
import { libraryIntents } from "../src/library/intents.ts";
import { ProgrammeActions } from "../src/guide/actions-play.ts";

vi.mock("../src/platform/credentials.ts", () => ({
  nativeCredentials: () => ({
    read: async () => ({
      kind: "xtream",
      server: "https://fixture.invalid",
      username: "fixture",
      password: "fixture",
    }),
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows Live during archive loading and failure, retries archives, and retains them across unrelated source changes and reopening", async () => {
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let failed = true;

  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    await gate;
    expect(init?.cache).not.toBe("no-store");
    expect(new Headers(init?.headers).get("Cache-Control")).toBe("no-store");

    if (failed) throw new Error("offline");

    return Response.json(
      String(input).includes("get_live_streams")
        ? [{ stream_id: 7, name: "Channel", tv_archive: 1, tv_archive_duration: 2 }]
        : [],
    );
  });

  vi.stubGlobal("fetch", fetcher);
  const reader = {};
  const descriptor = Object.getOwnPropertyDescriptor(sources, "onDemand");
  Object.assign(sources, { onDemand: () => reader });
  const before = sources.state.get();

  const source = {
    id: "programme-source",
    kind: "xtream",
    label: "Fixture",
    channels: {
      kind: "ready",
      rows: [
        {
          key: "programme-source:7",
          sourceId: "programme-source",
          title: "Channel",
          number: null,
          category: null,
        },
      ],
    },
  } as const;

  sources.state.set({ kind: "ready", sources: [source] });
  const play = vi.fn();
  const stop = libraryIntents.register({ play });
  const now = Date.now();

  const props = {
    identity: { sourceId: source.id, channelId: "7" },
    programme: { title: "News", start: now - 3600000, stop: now - 1800000, description: null },
    channelName: "Channel",
    inset: 16,
  };

  const screen = await mount(h(ProgrammeActions, props));

  try {
    expect(play).not.toHaveBeenCalled();
    expect(screen.container.textContent).toContain("Watch live");
    await screen.click("Watch live");
    expect(play).toHaveBeenLastCalledWith({
      kind: "live",
      sourceId: source.id,
      channelId: "7",
      title: "Channel",
    });
    await act(async () => {
      release();
    });
    expect(screen.container.textContent).toContain("Couldn't check playback");
    expect(screen.container.textContent).toContain("Watch live");
    const failedCalls = fetcher.mock.calls.length;
    await screen.render(null);
    await screen.render(h(ProgrammeActions, props));
    await vi.waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(failedCalls));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(screen.container.textContent).toContain("Couldn't check playback");
    });
    failed = false;
    await screen.click("Try again");
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(screen.container.textContent).toContain("Catch-up");
    });
    await screen.click("Catch-up");
    expect(play).toHaveBeenLastCalledWith({
      kind: "catch-up",
      sourceId: source.id,
      channelId: "7",
      title: "News",
      days: 2,
      window: { start: props.programme.start, end: props.programme.stop },
    });
    const calls = fetcher.mock.calls.length;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3 * 86400000);
    play.mockClear();
    await screen.click("Catch-up");
    expect(play).not.toHaveBeenCalled();
    clock.mockRestore();
    await act(async () =>
      sources.state.set({ kind: "ready", sources: [source, { ...source, id: "other" }] }),
    );
    expect(screen.container.textContent).toContain("Catch-up");
    await screen.render(null);
    await screen.render(h(ProgrammeActions, props));
    expect(screen.container.textContent).toContain("Catch-up");
    expect(fetcher).toHaveBeenCalledTimes(calls);
    await screen.render(
      h(ProgrammeActions, {
        ...props,
        programme: { ...props.programme, start: now - 4 * 86400000 },
      }),
    );
    expect(screen.container.textContent).toContain("Outside the provider's archive");
    await act(async () => sources.state.set({ kind: "ready", sources: [] }));
    expect(screen.container.textContent).toContain("Channel unavailable");
    expect(screen.container.textContent).not.toContain("Watch live");
  } finally {
    await screen.close();
    stop();
    sources.state.set(before);

    if (descriptor) Object.defineProperty(sources, "onDemand", descriptor);
    else Reflect.deleteProperty(sources, "onDemand");
  }
});
