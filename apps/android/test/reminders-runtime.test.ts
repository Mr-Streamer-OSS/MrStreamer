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
  subscribe: vi.fn(),
  listingSubscribe: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../src/reminders/native.ts", () => ({ nativeReminders: () => port }));

vi.mock("../src/guide/ui.tsx", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) =>
    h("button", { onClick: onPress }, label),
  guideColors: {},
  Icon: () => null,
  Press: ({ children, onPress }: { children: ReactNode; onPress: () => void }) =>
    h("button", { onClick: onPress }, children),
}));

vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  ScrollView: ({ children }: { children: ReactNode }) => h("div", {}, children),
  useWindowDimensions: () => ({ width: 400 }),
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
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
  startGuide: port.start,
  guide: {
    subscribe: port.subscribe,
    programmeAt: port.programmeAt,
    listingRevision: { get: port.revision, subscribe: port.listingSubscribe },
    getSnapshot: () => "stable",
  },
}));

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("../src/ui/focus.ts", () => ({
  useKeyboardFocus: () => ({ focused: false, handlers: {} }),
}));

vi.mock("../src/guide/guide-native.ts", () => ({ nativeGuide: () => ({}) }));

vi.mock("../src/guide/guide-sources.ts", () => ({ GUIDE_LIMIT: 10, MAPPING_MAX: 10 }));

vi.mock("expo-router", () => ({ router: {}, useLocalSearchParams: () => ({}) }));

vi.mock("../src/guide/schedule-screen.tsx", () => ({ ProgrammeDetails: () => null }));

vi.mock("../src/live/ui.tsx", () => ({ Badge: () => null }));

vi.mock("../src/navigation/screen.tsx", () => ({
  Screen: ({ children }: { children: ReactNode }) => h("main", {}, children),
}));

vi.mock("../src/ui/icon-button.tsx", () => ({
  IconButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    h("button", { onClick: onPress }, label),
}));

vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));

const { reminders, saveReminder, cancelReminder, refreshReminders, startReminders } =
  await import("../src/reminders/runtime.ts");

const saved: Reminder = {
  id: "one",
  sourceId: "p",
  channelId: "c",
  channelName: "Channel",
  start: 200,
  stop: Date.now() + 3600000,
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

it("applies known invalidations before an overdue reminder can post", async () => {
  port.programmeAt.mockResolvedValue(null);
  let invalidated = false;
  port.reconcile.mockImplementation(async () => {
    invalidated = true;
  });
  port.recover.mockImplementation(async () => {
    expect(invalidated).toBe(true);
  });
  await refreshReminders();
});

it("keeps partial reads separate from update failures and preserves whole-read labels", async () => {
  port.permission.mockResolvedValue({
    missing: "",
    canOpen: false,
    readFailed: true,
    failed: true,
  });
  await refreshReminders();
  expect(reminders.get()).toMatchObject({ error: "update", permission: { readFailed: true } });
  port.list.mockRejectedValue(new Error("disk"));
  port.recover.mockRejectedValue(new Error("post"));
  await expect(refreshReminders()).rejects.toThrow("read");
  expect(reminders.get().error).toBe("read");
});

it("starts and subscribes to guide listings only while reminders exist", async () => {
  const unsubscribe = vi.fn();
  port.listingSubscribe.mockReturnValue(unsubscribe);
  port.subscribe.mockReturnValue(vi.fn());
  port.start.mockResolvedValue(undefined);
  reminders.set({ rows: [], permission: null, error: null, loaded: true });
  port.list.mockResolvedValue("[]");
  const stop = startReminders();

  try {
    expect(port.start).not.toHaveBeenCalled();
    reminders.set((s) => ({ ...s, rows: [saved] }));
    expect(port.start).toHaveBeenCalledOnce();
    expect(port.listingSubscribe).toHaveBeenCalledOnce();
    expect(port.subscribe).not.toHaveBeenCalled();
    reminders.set((s) => ({ ...s, rows: [] }));
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally {
    stop();
    await refreshReminders();
  }
});

type Container = ReturnType<Window["document"]["createElement"]>;

/** Mount the public reminder surfaces against the same native boundary as runtime tests. */
async function surface(node: ReactNode, check: (container: Container) => Promise<void>) {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const module = "react-dom/client";

  const { createRoot } = (await import(module)) as {
    createRoot(container: Container): { render(node: ReactNode): void; unmount(): void };
  };

  const container = window.document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () => root.render(node));
    await check(container);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    await window.happyDOM.close();
  }
}

async function action(check: (container: Container) => Promise<void>) {
  const { ReminderAction } = await import("../src/reminders/action.tsx");
  await surface(
    h(ReminderAction, {
      identity: { sourceId: "p", channelId: "c" },
      programme: {
        title: "Future",
        description: null,
        start: Date.now() + 600000,
        stop: Date.now() + 1200000,
      },
      channelName: "Channel",
      inset: 16,
    }),
    check,
  );
}

it("action saves visibly then cancels on the second press", async () => {
  let rows: Reminder[] = [];
  port.list.mockImplementation(async () => JSON.stringify(rows));
  port.save.mockImplementation(async (json: string) => {
    rows = [JSON.parse(json)];
  });
  port.cancel.mockImplementation(async () => {
    rows = [];
  });
  reminders.set({ rows: [], permission: null, error: null, loaded: true });
  await action(async (container) => {
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Reminder set");
    expect(rows).toHaveLength(1);
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("Remind me");
    expect(rows).toEqual([]);
  });
});

it("action shows a failed save without adding a reminder", async () => {
  reminders.set({ rows: [], permission: null, error: null, loaded: true });
  port.save.mockRejectedValue(new Error("disk"));
  await action(async (container) => {
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Couldn't save. Try again.");
    expect(container.textContent).not.toContain("Reminder set");
    expect(reminders.get().rows).toEqual([]);
  });
});

it.each(["notifications", "channel"])(
  "action names %s refusal without Allow when no setting resolves",
  async (missing) => {
    port.permission.mockResolvedValue({ missing, canOpen: false });
    await action(async (container) => {
      await act(async () => container.querySelector("button")!.click());
      expect(container.textContent).toContain("Android has notifications off");
      expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
        "Remind me",
      ]);
      expect(port.save).not.toHaveBeenCalled();
    });
  },
);

it("screen retains revoked reminders with Allow and reports a failed cancellation", async () => {
  const { RemindersScreen } = await import("../src/reminders/screen.tsx");
  port.permission.mockResolvedValue({ missing: "notifications", canOpen: true });
  await refreshReminders();
  port.cancel.mockRejectedValue(new Error("disk"));
  await surface(h(RemindersScreen), async (container) => {
    expect(container.textContent).toContain("News");
    expect(container.textContent).toContain("Notifications are off.");
    expect(container.textContent).toContain("Allow");

    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel reminder for News",
    )!;

    await act(async () => cancel.click());
    expect(container.textContent).toContain("Couldn't save. Try again.");
    expect(container.textContent).toContain("News");
    expect(reminders.get().rows).toEqual([saved]);
  });
});

it("screen reports a failed read instead of an empty list", async () => {
  const { RemindersScreen } = await import("../src/reminders/screen.tsx");
  reminders.set({ rows: [], loaded: true, permission: null, error: null });
  port.list.mockRejectedValue(new Error("disk"));
  await expect(refreshReminders()).rejects.toThrow("read");
  await surface(h(RemindersScreen), async (container) => {
    expect(container.textContent).toContain("Couldn't read reminders. Try again.");
    expect(container.textContent).not.toContain("No reminders yet.");
  });
});

it("withholds stale source patches during lookup and removes the provider next pass", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  const previous = sources.state.get();
  let release!: (value: null) => void;
  let entered!: () => void;

  const lookup = new Promise<void>((resolve) => {
    entered = resolve;
  });

  port.programmeAt.mockImplementationOnce(() => {
    entered();

    return new Promise<null>((resolve) => {
      release = resolve;
    });
  });

  try {
    const pending = refreshReminders();
    await lookup;
    sources.state.set({ kind: "ready", sources: [] });
    release(null);
    await pending;
    expect(port.reconcile).not.toHaveBeenCalled();
    await refreshReminders();
    expect(JSON.parse(port.reconcile.mock.calls[0]![0])).toEqual([{ id: "one", remove: true }]);
  } finally {
    sources.state.set(previous);
  }
});
