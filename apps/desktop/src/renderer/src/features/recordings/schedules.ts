// Scheduled recordings as the window reads and words them. The main process keeps them, records
// them and says when any changes (`recordings.schedulesChanged`), so the list is read once and
// then follows those events, as recordings do. A guide programme finds its schedule by channel and
// start: one made of it, or a repeat that records its channel at its weekday and time.
import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  RECORDING_MAX_MS,
  type ConnectionHolder,
  type RecordingPadding,
  type RecordingPlan,
  type ScheduledRecording,
} from "@mrstreamer/contracts/recordings";
import type { IpcInput } from "@mrstreamer/contracts/ipc";
import { sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { formatDate, formatList, t, type PlainKey } from "@mrstreamer/core/i18n";
import { call } from "../../lib/ipc.ts";

export const schedulesQuery = () =>
  queryOptions({
    queryKey: ["schedules"],
    queryFn: () => call("recordings.schedules"),
    staleTime: Infinity,
  });

/** A plan as the window hands it to `recordings.plan` and `recordings.schedule`. */
export type PlanInput = IpcInput<"recordings.plan">["plan"];

/** What `recordings.plan` answers for a plan as it is edited; read again when schedules change. */
export const planQuery = (plan: PlanInput, id: string | undefined) =>
  queryOptions({
    queryKey: ["schedules", "plan", plan, id ?? null],
    queryFn: () => call("recordings.plan", { plan, ...(id ? { id } : {}) }),
  });

export function useSchedules() {
  return useQuery(schedulesQuery());
}

const MINUTE_MS = 60_000;
/** The most a recording's minutes and padding may add up to. */
const MAX_MINUTES = RECORDING_MAX_MS / MINUTE_MS;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6] as const;

/** Minutes after local midnight of `at`. */
function minuteOfDay(at: number): number {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * The schedule in `list` that records `channel`'s programme at `start`, if one does. A slot's
 * time is placed on `start`'s day as main places it, across daylight saving too.
 */
export function scheduleAt(
  list: readonly ScheduledRecording[] | undefined,
  channel: OwnedId,
  start: number,
): ScheduledRecording | undefined {
  const day = new Date(start);
  return list?.find(({ plan }) => {
    if (!sameOwned(plan.channel, channel)) return false;
    if (plan.kind === "programme") return plan.start === start;
    const at = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      Math.floor(plan.at / 60),
      plan.at % 60,
    );
    return plan.days.includes(day.getDay()) && at.getTime() === start;
  });
}

/** How often a schedule records. */
export type Repeat = "once" | "day" | "every";

/**
 * What a schedule is made from: a guide programme, or a schedule already made. `programme` is
 * what Once records, null for a repeat edited where no programme is at hand; `days` and `at` are
 * the local weekdays and minute a repeat on some days records at, for `minutes`, named `title`.
 */
export interface ScheduleBasis {
  readonly channel: OwnedId;
  readonly title: string;
  readonly programme: {
    readonly start: number;
    readonly stop: number;
    readonly title: string;
  } | null;
  readonly days: readonly number[];
  readonly at: number;
  readonly minutes: number;
}

export function basisOfProgramme(
  channel: OwnedId,
  programme: { readonly start: number; readonly stop: number; readonly title: string },
): ScheduleBasis {
  return {
    channel,
    title: programme.title,
    programme: { start: programme.start, stop: programme.stop, title: programme.title },
    days: [new Date(programme.start).getDay()],
    at: minuteOfDay(programme.start),
    minutes: Math.max(1, Math.round((programme.stop - programme.start) / MINUTE_MS)),
  };
}

/**
 * What `schedule` was made from, to change it. A repeat keeps its days, time, length and name;
 * edited from one of its programmes, `programme` is what Once would record instead. One every day
 * offers the programme's weekday, else today's.
 */
export function basisOfSchedule(
  { plan }: ScheduledRecording,
  programme?: { readonly start: number; readonly stop: number; readonly title: string },
): ScheduleBasis {
  if (plan.kind === "programme") return basisOfProgramme(plan.channel, plan);
  return {
    channel: plan.channel,
    title: plan.title,
    programme: programme
      ? { start: programme.start, stop: programme.stop, title: programme.title }
      : null,
    days:
      plan.days.length < EVERY_DAY.length
        ? plan.days
        : [(programme ? new Date(programme.start) : new Date()).getDay()],
    at: plan.at,
    minutes: plan.minutes,
  };
}

export function repeatOf(plan: RecordingPlan): Repeat {
  if (plan.kind === "programme") return "once";
  return plan.days.length === EVERY_DAY.length ? "every" : "day";
}

/** The plan that records `basis` as `repeat` asks, with `padding`. */
export function planOf(basis: ScheduleBasis, repeat: Repeat, padding: RecordingPadding): PlanInput {
  const { channel, title } = basis;
  if (repeat === "once" && basis.programme)
    return { kind: "programme", channel, ...basis.programme, padding };
  return {
    kind: "slot",
    channel,
    days: repeat === "every" ? [...EVERY_DAY] : [...basis.days],
    at: basis.at,
    // A programme longer than a recording may be records what it may.
    minutes: Math.min(basis.minutes, MAX_MINUTES),
    title,
    padding,
  };
}

/** Minutes of padding `plan` has room for, both sides together, within RECORDING_MAX_MS. */
export function paddingRoom(plan: PlanInput): number {
  const minutes = plan.kind === "slot" ? plan.minutes : (plan.stop - plan.start) / MINUTE_MS;
  return Math.max(0, Math.floor(MAX_MINUTES - minutes));
}

const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const satisfies readonly PlainKey[];
const EVERY_WEEKDAY = [
  "Every Sunday",
  "Every Monday",
  "Every Tuesday",
  "Every Wednesday",
  "Every Thursday",
  "Every Friday",
  "Every Saturday",
] as const satisfies readonly PlainKey[];

/** "Fridays", or "Mondays and Fridays", for the repeat to choose. */
export function weekdays(days: readonly number[]): string {
  return formatList(days.map((day) => t(WEEKDAYS[day] ?? "Sundays")));
}

/** "Once", "Every Friday" or "Every day", as a schedule's row says how often it records. */
export function repeatText(plan: RecordingPlan): string {
  if (plan.kind === "programme") return t("Once");
  if (plan.days.length === EVERY_DAY.length) return t("Every day");
  if (plan.days.length === 1) return t(EVERY_WEEKDAY[plan.days[0] ?? 0] ?? "Every Sunday");
  return weekdays(plan.days);
}

/** What holds a connection, in a few words, and until when: "until 22:17", else nothing. */
export function holderText(holder: ConnectionHolder): { what: string; until: string } {
  if (!("until" in holder))
    return {
      what: holder.kind === "watch" ? t("Playing in this window") : t("A download"),
      until: "",
    };
  const until = t("until {time}", { time: formatDate(holder.until, "time") });
  return holder.kind === "recording"
    ? { what: t("Recording {title}", { title: holder.title }), until }
    : { what: t("Scheduled {title}", { title: holder.title }), until };
}

/** Who holds every connection, in one line: "Weather Watch and playing in this window". */
export function holdersText(holders: readonly ConnectionHolder[]): string {
  return formatList(
    holders.map((holder) =>
      holder.kind === "recording" || holder.kind === "schedule"
        ? holder.title
        : holder.kind === "watch"
          ? t("playing in this window")
          : t("a download"),
    ),
  );
}
