// Recordings as the window sees them: local copies Mr. Streamer captured from a live channel
// while it ran. The main process keeps each one's record and file; paths, addresses and logins
// stay there. Times are epoch milliseconds, as the guide's.
import { type } from "arktype";
import { lazy } from "./lazy.ts";
import type { OwnedId } from "./subscription.ts";

/** Why a recording ended before its stop time. */
export type RecordingCut =
  /** The viewer quit the app while it recorded, or it closed and never came back in time. */
  | "quit"
  /** The provider stopped sending, or the connection broke. */
  | "stream"
  /** Its file couldn't be written, as on a full disk. */
  | "disk";

/** Where a recording stands. */
export type RecordingStatus =
  /** Capturing now, until its stop time. */
  | { readonly kind: "recording" }
  /** Captured from when it started to its stop time. */
  | { readonly kind: "complete" }
  /** The viewer stopped it before its stop time; what was captured stays. */
  | { readonly kind: "stopped" }
  /**
   * It ended early for `cut`, or reached its stop time with `gaps`; what was captured stays and
   * plays, skipping what was missed.
   */
  | { readonly kind: "partial"; readonly cut: RecordingCut }
  /**
   * Its time goes on, but capture stopped for `why`: it records the rest once the app runs, the
   * computer is awake, a connection is free and there is room on the disk.
   */
  | { readonly kind: "paused"; readonly why: RecordingGapReason }
  /** Its file is no longer in the app's folder. */
  | { readonly kind: "missing" }
  /** A schedule's time passed with nothing captured, for `why`; it has no file. */
  | { readonly kind: "missed"; readonly why: ScheduleMiss };

/**
 * Why a schedule recorded late, or not at all:
 *   - `away`: Mr. Streamer wasn't running, or the computer was asleep.
 *   - `busy`: every connection the account allows was held.
 *   - `stream`: the channel's stream couldn't be opened or recorded.
 *   - `disk`: this computer couldn't keep it: its file or record couldn't be written.
 *   - `held`: the guide listed another programme or none at its start, or the lists no longer
 *     listed its channel as it was.
 *   - `unread`: its channel list or guide wasn't read yet.
 */
export type ScheduleMiss = "away" | "busy" | "stream" | "disk" | "held" | "unread";

/**
 * Why a recording missed part of its time:
 *   - `away`: Mr. Streamer wasn't running, or the computer was asleep.
 *   - `busy`: every connection the account allows was held.
 *   - `stream`: the channel's stream broke or couldn't be opened.
 *   - `disk`: its file couldn't be written.
 *   - `space`: the disk had less free than Keep free on disk, or recordings took the space they
 *     may have.
 */
export type RecordingGapReason = "away" | "busy" | "stream" | "disk" | "space";

/** Time a recording missed, from `from`; `to` is null while it still misses it. */
export interface RecordingGap {
  readonly from: number;
  readonly to: number | null;
  readonly why: RecordingGapReason;
}

export interface Recording {
  /** Names it for `recordings.stop`, `recordings.remove` and `playback.openCopy`. */
  readonly id: string;
  readonly channel: OwnedId;
  readonly channelName: string;
  /** The programme on air as it started, as the guide listed it, else the channel's name. */
  readonly title: string;
  /** When capture was asked to start; a missed one's padded start. */
  readonly start: number;
  /** When it was set to stop. */
  readonly stop: number;
  /**
   * For a scheduled recording or missed result: the schedule, its padded start, and why it
   * started late or was missed. `late` is null when capture started on time. `from` names the
   * schedule's time; `owed`, there when the schedule was saved after `from`, is when capture was
   * owed from instead. A missed result has `from === start`; otherwise the unrecorded span is from
   * `owed ?? from` to `start`.
   */
  readonly scheduled?: {
    readonly schedule: string;
    readonly from: number;
    readonly owed?: number;
    readonly late: ScheduleMiss | null;
  };
  /** When it actually ended; null while it records, and for one that was missed. */
  readonly ended: number | null;
  /** Bytes in its file. */
  readonly bytes: number;
  readonly status: RecordingStatus;
  /** Time it missed between its start and its end, in time order; none when it missed none. */
  readonly gaps?: readonly RecordingGap[];
  /**
   * How it ended couldn't be written down yet, as while its disk refuses writes: the app tries
   * again, and until then a restart would read it as cut short by the quit.
   */
  readonly unsaved?: boolean;
}

/** Where recordings go and the room they may take, as Settings shows and changes them. */
export interface RecordingLimits {
  /** Bytes a recording leaves free on its disk: below this it pauses. */
  readonly keepFree: number;
  /** Bytes recordings may take together; null for no limit. */
  readonly space: number | null;
}

/** Bytes kept free to begin with. */
export const DEFAULT_KEEP_FREE = 5 * 1024 ** 3;

/** The folder new recordings go to, how much they take, and the room left. */
export interface RecordingStorage extends RecordingLimits {
  /** The folder new recordings go to. Those made before a change stay where they are. */
  readonly folder: string;
  /** Bytes the recordings' files take. */
  readonly used: number;
  /** Bytes free on the folder's disk; null when the system can't say. */
  readonly free: number | null;
}

/** What holds one of a subscription's connections in this app now. */
export type ConnectionUse = "watch" | "download" | "recording";

/**
 * A subscription's provider connections as a recording would see them: how many the account
 * allows, as its provider last said (one when it never said), and what of this app holds them now.
 * Other devices on the same account aren't seen.
 */
export interface RecordingConnections {
  readonly limit: number;
  readonly uses: readonly ConnectionUse[];
}

/** What asking to record answered: started, or every connection is held by what `connections` lists. */
export type RecordingStart =
  | { readonly kind: "started"; readonly recording: Recording }
  | { readonly kind: "busy"; readonly connections: RecordingConnections };

/** The longest a recording may be set to run, from when it starts. */
export const RECORDING_MAX_MS = 12 * 60 * 60 * 1000;

/** Minutes a schedule records before its programme or slot starts, and after it ends. */
export interface RecordingPadding {
  readonly before: number;
  readonly after: number;
}

/** Padding a new schedule starts with, as guides run early and late. */
export const DEFAULT_PADDING: RecordingPadding = { before: 2, after: 5 };

/** The most padding each side takes, in minutes. */
export const PADDING_MAX = 60;

/** What a schedule records. Its title only names it: nothing is matched by title. */
export type RecordingPlan =
  /**
   * One programme: the one the guide lists on `channel` at `start`. Its end follows the guide.
   * Another programme listed at that start, or none, holds it until the viewer changes it.
   */
  | {
      readonly kind: "programme";
      readonly channel: OwnedId;
      readonly start: number;
      readonly stop: number;
      readonly title: string;
      readonly padding: RecordingPadding;
    }
  /**
   * A channel at a time of day, each of `days` (0 Sunday to 6 Saturday), whatever is on, in this
   * computer's time zone as it is each day. `at` is minutes after midnight, `minutes` how long.
   * A start the clocks skip, as they go forward, falls an hour later; one they repeat, as they go
   * back, is the first.
   */
  | {
      readonly kind: "slot";
      readonly channel: OwnedId;
      readonly days: readonly number[];
      readonly at: number;
      readonly minutes: number;
      readonly title: string;
      readonly padding: RecordingPadding;
    };

/**
 * A `RecordingPlan` the window may send and schedules.json may hold: padding within
 * `PADDING_MAX`, a slot on distinct weekdays at a minute of the day, and a padded time within
 * `RECORDING_MAX_MS`.
 */
export const RecordingPlanSchema = lazy(() => {
  const padding = type({
    before: `0 <= number.integer <= ${PADDING_MAX}`,
    after: `0 <= number.integer <= ${PADDING_MAX}`,
  });
  const common = {
    channel: { subscriptionId: "string > 0", id: "string" },
    title: "string",
    padding,
  } as const;
  return type({
    kind: "'programme'",
    ...common,
    start: "number.integer",
    stop: "number.integer",
  })
    .or({
      kind: "'slot'",
      ...common,
      days: type("0 <= number.integer <= 6").array().atLeastLength(1).atMostLength(7),
      at: "0 <= number.integer < 1440",
      minutes: "number.integer >= 1",
    })
    .narrow((plan) => {
      const minutes = plan.kind === "slot" ? plan.minutes : (plan.stop - plan.start) / 60_000;
      return (
        minutes > 0 &&
        (minutes + plan.padding.before + plan.padding.after) * 60_000 <= RECORDING_MAX_MS &&
        (plan.kind === "programme" || new Set(plan.days).size === plan.days.length)
      );
    });
});

/** What holds one of a subscription's connections at some time. */
export type ConnectionHolder =
  /** A recording that records then, until `until`. */
  | { readonly kind: "recording"; readonly title: string; readonly until: number }
  /** Another schedule that records then, until `until`. */
  | { readonly kind: "schedule"; readonly title: string; readonly until: number }
  /** Watching here, or a download, now. */
  | { readonly kind: "watch" | "download" };

/**
 * Where a schedule's next time stands:
 *   - `planned`: a connection is free then, as far as this app knows.
 *   - `conflict`: what `holders` lists holds every connection then; it records once one is free.
 *   - `waiting`: its time has come and every connection is held; it records once one is free,
 *     the rest of its time.
 *   - `retrying`: its time has come and its last start failed for `why`; it asks again about once
 *     a minute, the rest of its time.
 *   - `recording`: it records now, as `recording`.
 *   - `changed`: the guide lists `title` at its programme's start instead; it won't record that.
 *   - `gone`: the guide lists no programme at its start, or the lists no longer list its channel.
 */
export type ScheduleStatus =
  | { readonly kind: "planned" }
  | { readonly kind: "conflict"; readonly holders: readonly ConnectionHolder[] }
  | { readonly kind: "waiting"; readonly holders: readonly ConnectionHolder[] }
  | { readonly kind: "retrying"; readonly why: "stream" | "disk" }
  | { readonly kind: "recording"; readonly recording: string }
  | { readonly kind: "changed"; readonly title: string }
  | { readonly kind: "gone" };

/** A schedule as the window sees it. */
export interface ScheduledRecording {
  /**
   * Names it for `recordings.schedule` to change and `recordings.cancel`; empty in a preview of a
   * new one.
   */
  readonly id: string;
  readonly plan: RecordingPlan;
  readonly channelName: string;
  /**
   * When it records next, its padding included: now, or the first time to come. Null when it has
   * none, as a programme that ended.
   */
  readonly next: { readonly start: number; readonly stop: number } | null;
  readonly status: ScheduleStatus;
}
