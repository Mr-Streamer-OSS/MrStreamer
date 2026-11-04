import { AppState, PermissionsAndroid, Platform } from "react-native";
import { guide, startGuide } from "../guide/runtime.ts";
import { sources } from "../bootstrap/sources.ts";
import { channelKey } from "../guide/routes.ts";
import { store } from "../platform/store.ts";
import { nativeReminders, type Permission } from "./native.ts";
import { reconcile, type Reminder } from "./rules.ts";

export const reminders = store<{
  rows: readonly Reminder[];
  permission: Permission | null;
  error: "read" | "update" | null;
}>({ rows: [], permission: null, error: null });

let queue = Promise.resolve();

/** Serialize native mutations with guide reconciliation; stale reads cannot undo a cancellation. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.then(
    () => {},
    () => {},
  );

  return result;
}

async function read() {
  try {
    const rows: Reminder[] = JSON.parse(await nativeReminders().list());
    const permission = await nativeReminders().permission();
    reminders.set({ rows, permission, error: permission.failed ? "update" : null });
  } catch {
    reminders.set((s) => ({ ...s, error: "read" }));
    throw new Error("read");
  }
}

export const refreshReminders = () =>
  serialized(async () => {
    await read();
    const state = sources.state.get();

    if (state.kind !== "ready") return;

    try {
      const rows = reminders.get().rows;
      const revision = guide.listingRevision.get();
      const snapshot = guide.getSnapshot();
      const patches = [];

      for (const row of rows) {
        const present = state.sources.some((s) => s.id === row.sourceId);

        const current =
          present && row.stop > Date.now()
            ? await guide.programmeAt(channelKey(row), row.start)
            : undefined;

        patches.push(reconcile(row, current, present, Date.now()));
      }

      // Provider/catalogue changes during a read invalidate this reconciliation.
      if (
        sources.state.get() !== state ||
        guide.listingRevision.get() !== revision ||
        guide.getSnapshot() !== snapshot
      )
        return;
      await nativeReminders().reconcile(JSON.stringify(patches));
      await read();
    } catch {
      reminders.set((s) => ({ ...s, error: "update" }));
      throw new Error("update");
    }
  });

export const cancelReminder = (id: string) =>
  serialized(async () => {
    await nativeReminders().cancel(id);
    reminders.set((s) => ({ ...s, rows: s.rows.filter((row) => row.id !== id) }));
    await read().catch(() => {});
  });

export const saveReminder = (row: Reminder) =>
  serialized(async () => {
    await nativeReminders().save(JSON.stringify(row));
    reminders.set((s) => ({ ...s, rows: [...s.rows.filter((saved) => saved.id !== row.id), row] }));
    await read().catch(() => {});
  });

export async function requestReminderAccess() {
  if (Platform.OS === "android" && Number(Platform.Version) >= 33)
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  const permission = await nativeReminders().permission();
  reminders.set((s) => ({ ...s, permission }));

  return permission;
}

export function startReminders() {
  let stopped = false;
  let requested = false;
  let dirty = false;

  const refresh = () => {
    if (stopped) return;

    if (requested) {
      dirty = true;

      return;
    }

    requested = true;
    void refreshReminders()
      .catch(() => {})
      .finally(() => {
        requested = false;

        if (dirty) {
          dirty = false;
          refresh();
        }
      });
  };

  const stops = [
    sources.state.subscribe(refresh),
    guide.listingRevision.subscribe(refresh),
    guide.subscribe(refresh),
  ];

  const app = AppState.addEventListener("change", (state) => {
    if (state === "active") refresh();
  });

  stops.push(() => app.remove());
  void startGuide()
    .then(refresh)
    .catch(() => {
      reminders.set((s) => ({ ...s, error: "update" }));
    });
  const clock = setInterval(refresh, 60_000);
  refresh();

  return () => {
    stopped = true;
    stops.forEach((stop) => stop());
    clearInterval(clock);
  };
}
