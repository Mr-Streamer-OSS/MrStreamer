import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({
  dismissTo: vi.fn(),
  navigate: vi.fn(),
  initial: null as string | null,
  listener: undefined as ((event: { json: string }) => void) | undefined,
  remove: vi.fn(),
}));

vi.mock("expo-router", () => ({ router: route, useRootNavigationState: () => ({ key: "root" }) }));

vi.mock("../src/reminders/native.ts", () => ({
  nativeReminders: () => ({
    takeTap: async () => route.initial,
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
  const tap = JSON.stringify({ sourceId: "source", channelId: "channel", start: 200 });
  route.initial = tap;

  const Entry = ({ ready }: { ready: boolean }) => {
    useReminderRouting(ready);

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
    await act(async () => route.listener?.({ json: tap }));
    expect(route.navigate).toHaveBeenCalledTimes(2);
    expect(route.dismissTo).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    expect(route.remove).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
    await window.happyDOM.close();
  }
});
