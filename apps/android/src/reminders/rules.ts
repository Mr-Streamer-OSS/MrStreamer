import type { Programme } from "@mrstreamer/contracts/guide";
import type { ChannelIdentity } from "../guide/routes.ts";

export interface Reminder extends ChannelIdentity {
  readonly id: string;
  readonly channelName: string;
  readonly title: string;
  readonly start: number;
  readonly stop: number;
  readonly status: "scheduled" | "changed" | "missing";
  readonly changedTitle?: string;
  readonly delivered: boolean;
  readonly language: string;
}

export const reminderId = (channel: ChannelIdentity, start: number) =>
  JSON.stringify([channel.sourceId, channel.channelId, start]);

/** Undefined means the guide could not answer, rather than an empty programme. */
export function reconcile(
  saved: Reminder,
  current: Pick<Programme, "title" | "start" | "stop"> | null | undefined,
  providerPresent: boolean,
  now: number,
) {
  if (!providerPresent || saved.stop <= now) return { id: saved.id, remove: true };

  if (current === undefined)
    return saved.changedTitle
      ? { id: saved.id, status: saved.status, changedTitle: saved.changedTitle }
      : { id: saved.id, status: saved.status };

  if (current === null) return { id: saved.id, status: "missing" };

  if (current.title !== saved.title || current.start !== saved.start || current.stop !== saved.stop)
    return { id: saved.id, status: "changed", changedTitle: current.title };

  return { id: saved.id, status: "scheduled" };
}

export const rowStatus = (saved: Reminder, now: number) =>
  saved.status !== "scheduled" ? saved.status : saved.start <= now ? "on-now" : "scheduled";

/** Dates are local calendar days, including daylight-saving boundaries. */
export function groups(rows: readonly Reminder[]) {
  const days = new Map<number, Reminder[]>();

  for (const row of [...rows].sort((a, b) => a.start - b.start)) {
    const date = new Date(row.start);
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const values = days.get(day) ?? [];
    values.push(row);
    days.set(day, values);
  }

  return [...days].map(([day, rows]) => ({ day, rows }));
}
