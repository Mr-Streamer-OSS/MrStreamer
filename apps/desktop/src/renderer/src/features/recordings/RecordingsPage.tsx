// Recordings: what records now, what is scheduled, by when it records next, then what was
// recorded, newest first. Each recording's row says what it is, its channel and when, a bar of the
// minutes captured against those planned, hatched where a schedule's start was missed, how it
// ended and why, and its size; one that records has Stop, an ended one Play and, in its menu,
// Delete. One a schedule missed has no file: it says why, and Remove. A schedule's row says how
// often it records, how its next time stands, and offers Edit, the schedule's controls in a
// popover, and Cancel schedule in its menu. An action that fails says so in place of the reason.
// Narrower windows put the size, or a schedule's repeat, in the row's second line and the outcome
// under the bar.
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { useMutation, useMutationState, useQuery } from "@tanstack/react-query";
import { Ellipsis, Play, Repeat2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Recording, ScheduledRecording } from "@mrstreamer/contracts/recordings";
import { sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { formatBytes, formatDate, formatNumber, t } from "@mrstreamer/core/i18n";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useNow } from "../../lib/clock.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { dayTime } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { coverage, outcome, playRecording, useRecordings } from "./recordings.ts";
import { SchedulePanel } from "./SchedulePanel.tsx";
import { basisOfSchedule, holdersText, repeatText, useSchedules } from "./schedules.ts";

export function RecordingsPage() {
  const list = useRecordings();
  const recordings = list.data ?? [];
  const schedules = useSchedules();
  const scheduled = schedules.data ?? [];
  const now = recordings.filter((each) => each.status.kind === "recording");
  const recorded = recordings.filter((each) => each.status.kind !== "recording");
  // Logos, from the channels as the lists have them now; a channel gone leaves its slot empty.
  const channels =
    useQuery(
      queries.channelsOf([
        ...recordings.map((each) => each.channel),
        ...scheduled.map((each) => each.plan.channel),
      ]),
    ).data ?? [];
  const logoOf = (owned: OwnedId) => channels.find((channel) => sameOwned(channel, owned)) ?? null;
  const count = recordings.length + scheduled.length;
  const error = list.error ?? schedules.error;
  return (
    <div className="flex h-full flex-col">
      <WindowBar className="bg-black" />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-2 pb-10 lg:px-10">
        <div className="flex items-baseline gap-3 pb-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Recordings")}</h1>
          {count > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatNumber(count)}
            </span>
          )}
        </div>
        {error ? (
          <div role="alert" className="flex items-center gap-3 pt-2 text-sm">
            <span className="text-destructive">{describeError(appError(error))}</span>
            <Button
              size="sm"
              onClick={() => {
                if (list.error) void list.refetch();
                if (schedules.error) void schedules.refetch();
              }}
            >
              {t("Retry")}
            </Button>
          </div>
        ) : list.data && schedules.data && count === 0 ? (
          <p className="pt-2 text-[0.9375rem] text-muted-foreground">
            {t("Nothing recorded yet. Record a channel from Live TV.")}
          </p>
        ) : null}
        <Section label={t("Now")} count={now.length} first>
          {now.map((each) => (
            <Row key={each.id} recording={each} channel={logoOf(each.channel)} />
          ))}
        </Section>
        <Section label={t("Scheduled")} count={scheduled.length} first={now.length === 0}>
          {scheduled.map((each) => (
            <ScheduleRow key={each.id} schedule={each} channel={logoOf(each.plan.channel)} />
          ))}
        </Section>
        <Section
          label={t("Recorded")}
          count={recorded.length}
          first={now.length === 0 && scheduled.length === 0}
        >
          {recorded.map((each) => (
            <Row key={each.id} recording={each} channel={logoOf(each.channel)} />
          ))}
        </Section>
        {recordings.length > 0 && (
          <p className="pt-4 text-[0.8125rem] text-muted-foreground">
            {t("Recordings stay until you delete them. Partial ones still play.")}
          </p>
        )}
      </div>
    </div>
  );
}

/** A titled list of rows; nothing while it has none. */
function Section({
  label,
  count,
  first,
  children,
}: {
  label: string;
  count: number;
  first: boolean;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section aria-label={label}>
      <h2
        className={cn("pb-0.5 text-[0.9375rem] font-semibold", first ? "pt-2.5" : "pt-4 lg:pt-5")}
      >
        {label}
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

/**
 * One recording. Wide windows lay it out in columns: logo, title, the bar with its minutes, the
 * outcome, size and actions. Narrow ones fold the size into the second line and the outcome, with
 * its minutes, under the bar.
 */
function Row({ recording, channel }: { recording: Recording; channel: LiveChannel | null }) {
  const now = useNow();
  const active = recording.status.kind === "recording";
  // Missed by a schedule: no file, so nothing plays and there is no size.
  const missed = recording.status.kind === "missed";
  const missing = recording.status.kind === "missing" || missed;
  const { captured, planned, missed: late } = coverage(recording, now);
  const minutes = t("{captured} of {planned} min", { captured, planned });
  const { word, reason } = outcome(recording, now);
  // Kept by the recording, not the row: a Stop moves it from Now to Recorded, into a new row, before
  // a failure to write that down answers.
  const mutationKey = ["recordings", "action", recording.id];
  const action = useMutation({
    mutationKey,
    mutationFn: (kind: "stop" | "remove") =>
      call(kind === "stop" ? "recordings.stop" : "recordings.remove", { id: recording.id }),
  });
  const last = useMutationState({ filters: { mutationKey }, select: (each) => each.state }).at(-1);
  const failure = last?.status === "error" ? describeError(appError(last.error)) : null;
  const size = missing ? null : formatBytes(recording.bytes);
  const when = t("{start} to {end}", {
    start: dayTime(recording.scheduled?.from ?? recording.start, now),
    end: formatDate(recording.stop, "time"),
  });
  return (
    <li className="flex h-[3.875rem] items-center gap-3.5 border-b border-border lg:h-[3.75rem] lg:gap-4">
      <span className="flex h-8 w-12 flex-none lg:w-[3.3rem]">
        {channel && <ChannelLogo channel={channel} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 lg:w-80 lg:flex-none">
        <span
          className={cn(
            "truncate text-[0.9375rem] font-medium",
            missing && "text-muted-foreground",
          )}
        >
          {recording.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {[recording.channelName, when].join(" · ")}
          {size && <span className="lg:hidden"> · {size}</span>}
        </span>
      </div>
      <div className="flex w-[23.5rem] flex-none flex-col gap-1.5 lg:w-[10.75rem]">
        <Coverage captured={captured} planned={planned} missed={late} faint={missing} />
        <span className="hidden text-xs text-muted-foreground tabular-nums lg:block">
          {minutes}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs lg:hidden">
          {active && (
            <span aria-hidden className="size-1.5 flex-none rounded-full bg-destructive" />
          )}
          <span className="flex-none font-semibold text-foreground">{word}</span>
          <span
            title={failure ?? undefined}
            className={cn("truncate", failure ? "text-destructive" : "text-muted-foreground")}
          >
            {failure ?? `${minutes}. ${reason}`}
          </span>
        </span>
      </div>
      <span className="hidden min-w-0 flex-1 items-center gap-2 text-[0.8125rem] lg:flex">
        {active && <span aria-hidden className="size-2 flex-none rounded-full bg-destructive" />}
        <span className="flex-none font-semibold text-foreground">{word}</span>
        <span
          title={failure ?? undefined}
          className={cn("truncate", failure ? "text-destructive" : "text-muted-foreground")}
        >
          {failure ?? reason}
        </span>
      </span>
      <span className="hidden w-16 flex-none text-right text-xs text-muted-foreground tabular-nums lg:block">
        {size}
      </span>
      <div className="flex w-[5.75rem] flex-none justify-end gap-1.5 lg:w-[9.15rem]">
        {active ? (
          <Button
            size="sm"
            aria-label={t("Stop recording {title}", { title: recording.title })}
            disabled={action.isPending}
            onClick={() => action.mutate("stop")}
          >
            {t("Stop")}
          </Button>
        ) : missed ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("Remove {title}", { title: recording.title })}
            disabled={action.isPending}
            onClick={() => action.mutate("remove")}
          >
            {t("Remove")}
          </Button>
        ) : (
          <>
            {!missing && (
              <Button
                size="icon-sm"
                aria-label={t("Play {title}", { title: recording.title })}
                onClick={() => playRecording(recording)}
              >
                <Play className="size-3 fill-current" />
              </Button>
            )}
            <Menu.Root>
              <Menu.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("More for {title}", { title: recording.title })}
                    disabled={action.isPending}
                  />
                }
              >
                <Ellipsis className="size-4" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-[60]">
                  <Menu.Popup className={cn(menuSurface, "text-[0.875rem] text-white")}>
                    <Menu.Item
                      closeOnClick
                      onClick={() => action.mutate("remove")}
                      className={cn(menuItem, "px-2 py-2")}
                    >
                      {t("Delete")}
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * Minutes captured against those planned: a white line on a faint track, after a hatched stretch
 * for the minutes `missed` at the start.
 */
function Coverage({
  captured,
  planned,
  missed,
  faint,
}: {
  captured: number;
  planned: number;
  missed: number;
  faint: boolean;
}) {
  return (
    <span
      role="meter"
      aria-label={t("{captured} of {planned} min", { captured, planned })}
      aria-valuemin={0}
      aria-valuemax={planned}
      aria-valuenow={captured}
      className={cn("flex h-1 overflow-hidden rounded-[2px]", faint ? "bg-white/8" : "bg-white/15")}
    >
      {missed > 0 && (
        <span
          className="h-full bg-[repeating-linear-gradient(135deg,rgb(255_255_255/55%)_0_1px,transparent_1px_4px)]"
          style={{ width: `${(missed / planned) * 100}%` }}
        />
      )}
      <span className="h-full bg-foreground" style={{ width: `${(captured / planned) * 100}%` }} />
    </span>
  );
}

/**
 * One schedule, in the recordings' lanes: logo, title with its channel and padded times, how often
 * it records where the bar is, how its next time stands, and Edit with its menu.
 */
function ScheduleRow({
  schedule,
  channel,
}: {
  schedule: ScheduledRecording;
  channel: LiveChannel | null;
}) {
  const now = useNow();
  const { plan, next, status } = schedule;
  const [editing, setEditing] = useState(false);
  const cancel = useMutation({
    mutationKey: ["schedules", "cancel", schedule.id],
    mutationFn: () => call("recordings.cancel", { id: schedule.id }),
  });
  const failure = cancel.error ? describeError(appError(cancel.error)) : null;
  const padded = plan.padding.before > 0 || plan.padding.after > 0;
  const times =
    next &&
    t(padded ? "{start} to {end}, with padding" : "{start} to {end}", {
      start: formatDate(next.start, "time"),
      end: formatDate(next.stop, "time"),
    });
  const repeat = repeatText(plan);
  const { word, reason } = standing(schedule, now);
  const recording = status.kind === "recording";
  const line = (
    <>
      <span
        aria-hidden
        className={cn(
          "size-1.5 flex-none rounded-full lg:size-2",
          recording ? "bg-destructive" : "ring-[1.5px] ring-destructive ring-inset",
        )}
      />
      {word && <span className="flex-none font-semibold text-foreground">{word}</span>}
      <span
        title={failure ?? reason}
        className={cn("truncate", failure ? "text-destructive" : "text-muted-foreground")}
      >
        {failure ?? reason}
      </span>
    </>
  );
  return (
    <li className="flex h-[3.875rem] items-center gap-3.5 border-b border-border lg:h-[3.75rem] lg:gap-4">
      <span className="flex h-8 w-12 flex-none lg:w-[3.3rem]">
        {channel && <ChannelLogo channel={channel} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 lg:w-80 lg:flex-none">
        <span className="truncate text-[0.9375rem] font-medium">{plan.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {schedule.channelName}
          <span className="lg:hidden"> · {repeat}</span>
          {times && ` · ${times}`}
        </span>
      </div>
      <div className="flex w-[23.5rem] flex-none flex-col gap-1.5 lg:w-[10.75rem]">
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex">
          {plan.kind === "slot" && <Repeat2 aria-hidden className="size-3.5 flex-none" />}
          {repeat}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs lg:hidden">{line}</span>
      </div>
      <span className="hidden min-w-0 flex-1 items-center gap-2 text-[0.8125rem] lg:flex">
        {line}
      </span>
      <span className="hidden w-16 flex-none lg:block" />
      <div className="flex w-[5.75rem] flex-none justify-end gap-1.5 lg:w-[9.15rem]">
        <Popover.Root open={editing} onOpenChange={setEditing}>
          <Popover.Trigger
            render={
              <Button
                size="sm"
                aria-label={t("Edit {title}", { title: plan.title })}
                className="px-3 data-popup-open:bg-white/16 data-popup-open:ring-2 data-popup-open:ring-ring data-popup-open:ring-inset"
              >
                {t("Edit")}
              </Button>
            }
          />
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
              <Popover.Popup
                aria-label={t("Schedule {title}", { title: plan.title })}
                className={cn(
                  menuSurface,
                  "flex w-[42rem] max-w-[calc(100vw-2rem)] flex-col gap-3.5 p-4 transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h2 className="truncate text-[0.9375rem] font-semibold">{plan.title}</h2>
                  <p className="truncate text-[0.8125rem] text-muted-foreground">
                    {schedule.channelName}
                  </p>
                </div>
                <SchedulePanel
                  basis={basisOfSchedule(schedule)}
                  channelName={schedule.channelName}
                  schedule={schedule}
                  onDone={() => setEditing(false)}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("More for {title}", { title: plan.title })}
                disabled={cancel.isPending}
              />
            }
          >
            <Ellipsis className="size-4" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-[60]">
              <Menu.Popup className={cn(menuSurface, "text-[0.875rem] text-white")}>
                <Menu.Item
                  closeOnClick
                  onClick={() => cancel.mutate()}
                  className={cn(menuItem, "px-2 py-2")}
                >
                  {t("Cancel schedule")}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </li>
  );
}

/** How a schedule's next time stands: when, or a word for what it does then, and why. */
function standing(
  { next, status }: ScheduledRecording,
  now: number,
): { word: string; reason: string } {
  if (!next) return { word: "", reason: t("It has no time to come.") };
  const when = dayTime(next.start, now);
  switch (status.kind) {
    case "planned":
      return { word: when, reason: t("A connection is free then.") };
    case "conflict":
      return {
        word: when,
        reason: t("Every connection is in use then, by {holders}.", {
          holders: holdersText(status.holders),
        }),
      };
    case "waiting":
      return {
        word: t("Waiting"),
        reason: t("Every connection is in use, by {holders}.", {
          holders: holdersText(status.holders),
        }),
      };
    case "recording":
      return {
        word: t("Recording"),
        reason: t("until {time}", { time: formatDate(next.stop, "time") }),
      };
    case "changed":
      return {
        word: when,
        reason: t("The guide lists {title} at that time now.", { title: status.title }),
      };
    case "gone":
      return { word: when, reason: t("The guide no longer lists it.") };
  }
}
