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
  loaded: boolean;
}>({ rows: [], permission: null, error: null, loaded: false });

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
    reminders.set((s) => {
      const sameRows = JSON.stringify(s.rows) === JSON.stringify(rows);
      const error = permission.failed ? "update" : null;

      if (
        sameRows &&
        JSON.stringify(s.permission) === JSON.stringify(permission) &&
        s.loaded &&
        s.error === error
      )
        return s;

      return { rows: sameRows ? s.rows : rows, permission, loaded: true, error };
    });
  } catch {
    reminders.set((s) => ({ ...s, error: "read" }));
    throw new Error("read");
  }
}

export const refreshReminders = () =>
  serialized(async () => {
    let failure: "read" | "update" | null = null;

    try {
      await read();
      const state = sources.state.get();

      if (state.kind === "ready") {
        const rows = reminders.get().rows;
        const revision = guide.listingRevision.get();
        const snapshot = guide.getSnapshot();
        let patches = [];

        for (const row of rows) {
          const present = state.sources.some((s) => s.id === row.sourceId);
          let current;

          if (present && row.stop > Date.now()) {
            try {
              current = await guide.programmeAt(channelKey(row), row.start);
            } catch {
              // A failed lookup is unknown; other rows can still reconcile.
            }
          }

          if (sources.state.get() !== state) break;

          if (guide.listingRevision.get() !== revision || guide.getSnapshot() !== snapshot)
            current = undefined;
          patches.push(reconcile(row, current, present, Date.now()));
        }

        // A later lookup may invalidate an earlier result. Keep independent removal/expiry
        // patches, but retain prior guide status for the entire invalidated snapshot.
        if (guide.listingRevision.get() !== revision || guide.getSnapshot() !== snapshot)
          patches = rows.map((row) =>
            reconcile(
              row,
              undefined,
              state.sources.some((source) => source.id === row.sourceId),
              Date.now(),
            ),
          );

        if (sources.state.get() === state && patches.length)
          await nativeReminders().reconcile(JSON.stringify(patches));
      }
    } catch (cause) {
      failure = cause instanceof Error && cause.message === "read" ? "read" : "update";
    } finally {
      try {
        await nativeReminders().recover();
      } catch {
        failure ??= "update";
      }

      try {
        await read();
      } catch {
        failure = "read";
      }
    }

    if (failure) {
      reminders.set((s) => ({ ...s, error: failure }));
      throw new Error(failure);
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

  let guideStops: (() => void)[] = [];

  const watchGuide = () => {
    if (reminders.get().rows.length && !guideStops.length) {
      guideStops = [sources.state.subscribe(refresh), guide.listingRevision.subscribe(refresh)];
      void startGuide()
        .then(refresh)
        .catch(() => {
          reminders.set((s) => ({ ...s, error: "update" }));
        });
    } else if (!reminders.get().rows.length) {
      guideStops.forEach((stop) => stop());
      guideStops = [];
    }
  };

  const stops = [reminders.subscribe(watchGuide)];
  watchGuide();

  const app = AppState.addEventListener("change", (state) => {
    if (state === "active") refresh();
  });

  stops.push(
    () => app.remove(),
    () => guideStops.forEach((stop) => stop()),
  );
  const clock = setInterval(refresh, 60_000);
  refresh();

  return () => {
    stopped = true;
    stops.forEach((stop) => stop());
    clearInterval(clock);
  };
}
