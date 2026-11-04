import { Window } from "happy-dom";
import { act, createElement as h, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { store } from "../src/platform/store.ts";
import type { Reminder } from "../src/reminders/rules.ts";

const port = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  cancel: vi.fn(),
  permission: vi.fn(),
  reconcile: vi.fn(),
  request: vi.fn(),
  recover: vi.fn(),
  programmeAt: vi.fn(),
  revision: vi.fn(),
}));

vi.mock("../src/reminders/native.ts", () => ({ nativeReminders: () => port }));

vi.mock("../src/guide/ui.tsx", () => ({
  guideColors: {},
  Icon: () => null,
  Press: ({ children, onPress }: { children: ReactNode; onPress: () => void }) =>
    h("button", { onClick: onPress }, children),
}));

vi.mock("react-native", () => ({
  Text: ({ children }: { children: ReactNode }) => h("span", {}, children),
  View: ({ children }: { children: ReactNode }) => h("div", {}, children),
  Platform: { OS: "android", Version: 36 },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: "notifications" },
    request: port.request,
  },
}));

vi.mock("../src/bootstrap/sources.ts", async () => ({
  sources: { state: store({ kind: "ready", sources: [{ id: "p" }] }) },
}));

vi.mock("../src/guide/runtime.ts", () => ({
  guide: {
    programmeAt: port.programmeAt,
    listingRevision: { get: port.revision },
    getSnapshot: () => "stable",
  },
}));

const { reminders, saveReminder, cancelReminder, refreshReminders } =
  await import("../src/reminders/runtime.ts");

const saved: Reminder = {
  id: "one",
  sourceId: "p",
  channelId: "c",
  channelName: "Channel",
  start: 200,
  stop: Number.MAX_SAFE_INTEGER,
  title: "News",
  status: "scheduled",
  delivered: false,
  language: "en",
};

beforeEach(() => {
  vi.resetAllMocks();
  port.revision.mockReturnValue(1);
  port.list.mockResolvedValue(JSON.stringify([saved]));
  port.permission.mockResolvedValue({ missing: "", canOpen: false });
  reminders.set({ rows: [saved], permission: null, error: null, loaded: false });
});

it("shows access refusal from the action without saving", async () => {
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

  const { ReminderAction } = await import("../src/reminders/action.tsx");
  const container = window.document.createElement("div");
  const root = createRoot(container);
  port.permission.mockResolvedValue({ missing: "exact", canOpen: true });

  try {
    await act(async () =>
      root.render(
        h(ReminderAction, {
          identity: { sourceId: "p", channelId: "c" },
          programme: {
            description: null,
            title: "Future",
            start: Date.now() + 600000,
            stop: Date.now() + 1200000,
          },
          channelName: "Channel",
          inset: 16,
        }),
      ),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Android has Alarms & reminders off");
    expect(port.request).toHaveBeenCalledWith("notifications");
    expect(port.save).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    await window.happyDOM.close();
  }
});

it("retains visible reminders when cancellation or storage reads fail", async () => {
  port.cancel.mockRejectedValue(new Error("disk"));
  await expect(cancelReminder(saved.id)).rejects.toThrow("disk");
  expect(reminders.get().rows).toEqual([saved]);
  port.list.mockRejectedValue(new Error("disk"));
  await expect(refreshReminders()).rejects.toThrow("read");
  expect(reminders.get()).toMatchObject({ rows: [saved], error: "read" });
});

it("does not report a scheduling failure as a saved reminder", async () => {
  port.save.mockRejectedValue(new Error("schedule"));
  await expect(saveReminder({ ...saved, id: "new" })).rejects.toThrow("schedule");
  expect(reminders.get().rows).toEqual([saved]);
});

it("recovers from disk and reconciles other rows after a guide lookup rejects", async () => {
  const removed = { ...saved, id: "removed", sourceId: "gone" };
  const valid = { ...saved, id: "valid" };
  port.list.mockResolvedValue(JSON.stringify([saved, removed, valid]));
  port.programmeAt.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(saved);
  await refreshReminders();
  expect(port.recover).toHaveBeenCalledOnce();
  expect(JSON.parse(port.reconcile.mock.calls[0]![0])).toEqual([
    { id: "one", status: "scheduled" },
    { id: "removed", remove: true },
    { id: "valid", status: "scheduled", stop: saved.stop },
  ]);
});

it("keeps the same store snapshot when a foreground refresh changes nothing", async () => {
  await refreshReminders();
  const before = reminders.get();
  await refreshReminders();
  expect(reminders.get()).toBe(before);
});

it("keeps provider-removal patches when the guide snapshot changes mid-read", async () => {
  port.list.mockResolvedValue(
    JSON.stringify([saved, { ...saved, id: "valid" }, { ...saved, id: "gone", sourceId: "gone" }]),
  );
  port.programmeAt
    .mockResolvedValueOnce({ ...saved, title: "Replacement" })
    .mockImplementationOnce(async () => {
      port.revision.mockReturnValue(2);
      throw new Error("snapshot changed");
    });
  await refreshReminders();
  expect(port.recover).toHaveBeenCalledOnce();
  expect(JSON.parse(port.reconcile.mock.calls[0]![0])).toEqual([
    { id: "one", status: "scheduled" },
    { id: "valid", status: "scheduled" },
    { id: "gone", remove: true },
  ]);
});
