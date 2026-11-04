import { store } from "../platform/store.ts";
import type { Permission } from "./native.ts";
import type { Reminder } from "./rules.ts";

export const reminders = store<{
  rows: readonly Reminder[];
  permission: Permission | null;
  error: "read" | "update" | null;
  loaded: boolean;
}>({ rows: [], permission: null, error: null, loaded: false });
