// The rules of a recording schedule, without files, clocks or providers: when it records, its
// padding included, and what holds connections then. The Recordings service keeps schedules and
// asks these.
//
// A programme schedule records once, at the epoch times the guide gave, so neither a time zone nor
// daylight saving moves it. A slot records at a time of day in this computer's time zone as it is
// on each of its days: a start the clocks skip falls as JavaScript's Date places it, an hour later;
// one they repeat is the first. Its length is in minutes of real time.
import type { ConnectionHolder, RecordingPlan } from "@mrstreamer/contracts/recordings";

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

/** The plan's first occurrence that hasn't ended at `now`: on now, or to come. */
export function nextOccurrence(plan: RecordingPlan, now: number): Occurrence | null {
  return occurrences(plan, now, now + 8 * DAY_MS)[0] ?? null;
}

/** Something that holds a connection over a time, as a conflict counts it. */
export interface Holding {
  readonly holder: Extract<ConnectionHolder, { readonly until: number }>;
  readonly start: number;
  /** Comes before one of the same start: it takes the connection first. */
  readonly first: boolean;
}

/**
 * What holds every connection at some time of `occurrence`, of `holdings` that start before it
 * and take the connection first; empty while one is free throughout, as far as they tell.
 */
export function conflictOf(
  occurrence: Occurrence,
  holdings: readonly Holding[],
  limit: number,
): readonly ConnectionHolder[] {
  const before = holdings.filter(
    (each) =>
      each.holder.until > occurrence.start &&
      each.start < occurrence.stop &&
      (each.start < occurrence.start || (each.start === occurrence.start && each.first)),
  );
  // Those holding at its start, or starting later within it: where most overlap at once is where
  // it would wait.
  const moments = [occurrence.start, ...before.map((each) => each.start)].filter(
    (at) => at >= occurrence.start && at < occurrence.stop,
  );
  let most: Holding[] = [];
  for (const at of moments) {
    const holding = before.filter((each) => each.start <= at && each.holder.until > at);
    if (holding.length > most.length) most = holding;
  }
  return most.length >= limit ? most.map((each) => each.holder) : [];
}
