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
}));

vi.mock("../src/reminders/native.ts", () => ({ nativeReminders: () => port }));

vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 36 },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: "notifications" },
    request: port.request,
  },
}));

vi.mock("../src/bootstrap/sources.ts", async () => ({
  sources: { state: store({ kind: "ready", sources: [{ id: "p" }] }) },
}));

vi.mock("../src/guide/runtime.ts", () => ({ guide: { programmeAt: async () => undefined } }));

const { reminders, requestReminderAccess, saveReminder, cancelReminder, refreshReminders } =
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
  port.list.mockResolvedValue(JSON.stringify([saved]));
  port.permission.mockResolvedValue({ missing: "", canOpen: false });
  reminders.set({ rows: [saved], permission: null, error: null });
});

it("requests contextual notification access without saving after refusal", async () => {
  port.permission.mockResolvedValue({ missing: "exact", canOpen: true });
  expect(await requestReminderAccess()).toEqual({ missing: "exact", canOpen: true });
  expect(port.request).toHaveBeenCalledWith("notifications");
  expect(port.save).not.toHaveBeenCalled();
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
