import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({
  dismissTo: vi.fn(),
  navigate: vi.fn(),
  initial: null as string | null,
  rows: [] as { sourceId: string; channelId: string; start: number; stop: number }[],
  listener: undefined as ((event: { json: string }) => void) | undefined,
  remove: vi.fn(),
}));

vi.mock("expo-router", () => ({ router: route, useRootNavigationState: () => ({ key: "root" }) }));

vi.mock("../src/reminders/native.ts", () => ({
  nativeReminders: () => ({
    list: async () => JSON.stringify(route.rows),
    takeTap: async () => {
      const tap = route.initial;
      route.initial = null;

      return tap;
    },
    addListener: (_event: string, listener: typeof route.listener) => {
      route.listener = listener;

      return { remove: route.remove };
    },
  }),
}));

const { useReminderRouting } = await import("../src/reminders/routing.ts");

it("opens cold and repeated warm taps over Live using the same programme identity", async () => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const REACT_DOM = "react-dom/client";

  const { createRoot } = (await import(REACT_DOM)) as {
    createRoot(container: ReturnType<typeof window.document.createElement>): {
      render(node: ReactNode): void;
      unmount(): void;
    };
  };

  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);

  const tap = JSON.stringify({
    sourceId: "source",
    channelId: "channel",
    start: 200,
    stop: Number.MAX_SAFE_INTEGER,
  });

  route.initial = tap;

  const Entry = ({ ready, empty = false }: { ready: boolean; empty?: boolean }) => {
    useReminderRouting(ready, empty);

    return null;
  };

  try {
    await act(async () => root.render(createElement(Entry, { ready: false })));
    expect(route.navigate).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(Entry, { ready: true })));
    expect(route.dismissTo).toHaveBeenLastCalledWith("/");
    expect(route.navigate).toHaveBeenLastCalledWith(
      "/guide/programme?source=source&channel=channel&start=200",
      { withAnchor: true },
    );

    const warm = JSON.stringify({
      sourceId: "warm",
      channelId: "other",
      start: 300,
      stop: Number.MAX_SAFE_INTEGER,
    });

    route.initial = warm;
    await act(async () => route.listener?.({ json: warm }));
    expect(route.navigate).toHaveBeenLastCalledWith(
      "/guide/programme?source=warm&channel=other&start=300",
      { withAnchor: true },
    );
    await act(async () => route.listener?.({ json: warm }));
    expect(route.navigate).toHaveBeenCalledTimes(2);
    expect(route.dismissTo).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    expect(route.remove).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
    await window.happyDOM.close();
  }
});

it.each([
  { name: "ended programme", stop: 300, empty: false, extended: false, opens: false },
  {
    name: "empty sources",
    stop: Number.MAX_SAFE_INTEGER,
    empty: true,
    extended: false,
    opens: false,
  },
  {
    name: "programme extended since posting",
    stop: 300,
    empty: false,
    extended: true,
    opens: true,
  },
])("handles a tap with $name", async ({ stop, empty, extended, opens }) => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const module = "react-dom/client";

  const { createRoot } = (await import(module)) as {
    createRoot(container: ReturnType<typeof window.document.createElement>): {
      render(node: ReactNode): void;
      unmount(): void;
    };
  };

  const root = createRoot(window.document.createElement("div"));
  const tap = { sourceId: "source", channelId: "channel", start: 200, stop };
  route.initial = JSON.stringify(tap);
  route.rows = extended ? [{ ...tap, stop: Number.MAX_SAFE_INTEGER }] : [];
  route.navigate.mockClear();

  const Entry = () => {
    useReminderRouting(true, empty);

    return null;
  };

  try {
    await act(async () => root.render(createElement(Entry)));
    expect(route.navigate).toHaveBeenCalledTimes(opens ? 1 : 0);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    await window.happyDOM.close();
  }
});
