// The rules of a recording schedule, without files, clocks or providers: when it records, its
// padding included, and what holds connections then. The Recordings service keeps schedules and
// asks these.
//
// A programme schedule records once, at the epoch times the guide gave, so neither a time zone nor
// daylight saving moves it. A slot records at a time of day in this computer's time zone as it is
// on each of its days: a start the clocks skip falls as JavaScript's Date places it, an hour later;
// one they repeat is the first. Its length is in minutes of real time.
import type {
  ConnectionHolder,
  RecordingCapacity,
  RecordingPlan,
} from "@mrstreamer/contracts/recordings";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** One time a schedule records: its padded start and stop. `start` also names it. */
export interface Occurrence {
  readonly start: number;
  readonly stop: number;
}

/** The plan's occurrence on the local day `day` falls on, for a slot recording that weekday. */
function slotOn(plan: Extract<RecordingPlan, { kind: "slot" }>, day: Date): Occurrence | null {
  if (!plan.days.includes(day.getDay())) return null;

  const at = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Math.floor(plan.at / 60),
    plan.at % 60,
  ).getTime();

  return {
    start: at - plan.padding.before * MINUTE_MS,
    stop: at + (plan.minutes + plan.padding.after) * MINUTE_MS,
  };
}

/**
 * The plan's occurrences that end after `from` and start before `to`, in time order. A slot's
 * are found day by day, from the day before `from`, as its padding and length can carry one past
 * midnight.
 */
export function occurrences(plan: RecordingPlan, from: number, to: number): Occurrence[] {
  if (plan.kind === "programme") {
    const occurrence = {
      start: plan.start - plan.padding.before * MINUTE_MS,
      stop: plan.stop + plan.padding.after * MINUTE_MS,
    };

    return occurrence.stop > from && occurrence.start < to ? [occurrence] : [];
  }

  const found: Occurrence[] = [];
  const first = new Date(from - DAY_MS);

  // Noon steps from day to day: a day of 23 or 25 hours never skips or repeats one.
  for (
    let day = new Date(first.getFullYear(), first.getMonth(), first.getDate(), 12);
    day.getTime() - DAY_MS < to;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 12)
  ) {
    const occurrence = slotOn(plan, day);

    if (occurrence && occurrence.stop > from && occurrence.start < to) found.push(occurrence);
  }

  return found;
}

/**
 * The plan's first occurrence that hasn't ended at `now`: on now, or to come. A programme's is
 * whenever the guide lists it; a slot comes round within a week.
 */
export function nextOccurrence(plan: RecordingPlan, now: number): Occurrence | null {
  const to = plan.kind === "programme" ? Infinity : now + 8 * DAY_MS;

  return occurrences(plan, now, to)[0] ?? null;
}

/** Pending work is ordered only when a connection becomes free. Nothing already admitted moves. */
export interface PendingCapture extends Occurrence {
  readonly id: string;
  readonly channel: string;
  readonly title: string;
  readonly priority: number;
  readonly created: number;
}

export function comparePending(a: PendingCapture, b: PendingCapture): number {
  return (
    b.priority - a.priority ||
    a.start - b.start ||
    a.created - b.created ||
    a.id.localeCompare(b.id)
  );
}

/** Forecast bounded pending work at starts/releases, sharing a channel's connection. Watch and
 * downloads have no known end, so callers retain them through the forecast horizon. */
export function forecastCapacity(
  pending: readonly PendingCapture[],
  protectedUses: readonly {
    readonly channel: string;
    readonly until: number;
    readonly holder: ConnectionHolder;
  }[],
  limit: number,
  now: number,
): ReadonlyMap<string, RecordingCapacity> {
  const running = [...protectedUses];
  const waiting = new Set(pending);
  const result = new Map<string, RecordingCapacity>();
  const blockers = new Map<string, readonly ConnectionHolder[]>();

  const times = [
    ...new Set([
      now,
      ...pending.flatMap((each) => [Math.max(now, each.start), each.stop]),
      ...protectedUses.map((each) => each.until),
    ]),
  ]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  for (const time of times) {
    if (time < now) continue;

    for (let i = running.length - 1; i >= 0; i--)
      if (running[i]!.until <= time) running.splice(i, 1);

    for (const each of [...waiting]
      .filter((each) => each.start <= time && each.stop > time)
      .sort(comparePending)) {
      const channels = new Set(running.map((use) => use.channel));

      if (channels.has(each.channel) || channels.size < limit) {
        const start = Math.max(now, each.start);
        result.set(each.id, {
          kind: time > start ? "partial" : "available",
          start: time,
          holders: blockers.get(each.id) ?? [],
        });
        running.push({
          channel: each.channel,
          until: each.stop,
          holder: { kind: "schedule", title: each.title, until: each.stop },
        });
        waiting.delete(each);
      } else if (!blockers.has(each.id))
        blockers.set(
          each.id,
          running.map((use) => use.holder),
        );
    }
  }

  for (const each of waiting)
    result.set(each.id, { kind: "missed", start: null, holders: blockers.get(each.id) ?? [] });

  return result;
}
