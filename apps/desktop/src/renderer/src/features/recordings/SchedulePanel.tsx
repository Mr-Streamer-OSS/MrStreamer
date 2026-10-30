// What a schedule records, as it is made or changed: how often (Once, the programme's weekday, or
// every day), how many minutes early it starts and late it ends, and how its next time stands as
// main previews it (`recordings.plan`), saving nothing until Schedule. While every connection is
// held then, it names what holds them and offers Schedule anyway. One already saved can be
// cancelled from here too. The guide grid's programme details show it inline, Recordings' Edit in
// a popover.
//   Its keys are its own: arrows move the repeat and step the padding, and nothing behind it
// moves. Escape closes it where `onEscape` is given; a popover closes itself.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Download } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  DEFAULT_PADDING,
  PADDING_MAX,
  type ConnectionHolder,
  type RecordingPadding,
  type ScheduledRecording,
} from "@mrstreamer/contracts/recordings";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { useNow } from "../../lib/clock.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { dayTime } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";
import { cn } from "../../lib/utils.ts";
import {
  holderText,
  planOf,
  planQuery,
  repeatOf,
  schedulesQuery,
  weekdays,
  type Repeat,
  type ScheduleBasis,
} from "./schedules.ts";

export function SchedulePanel({
  basis,
  channelName,
  schedule,
  autoFocus = false,
  onEscape,
  onDone,
  className,
}: {
  basis: ScheduleBasis;
  channelName: string;
  /** The schedule being changed; none for a new one. */
  schedule?: ScheduledRecording | undefined;
  /** Takes the focus as it opens, on the repeat chosen. */
  autoFocus?: boolean;
  onEscape?: () => void;
  /** Closes it: cancelled, saved or the schedule taken out. */
  onDone: () => void;
  className?: string;
}) {
  const client = useQueryClient();
  const now = useNow();
  const [repeat, setRepeat] = useState<Repeat>(() => {
    const saved = schedule ? repeatOf(schedule.plan) : "once";
    return saved === "once" && !basis.programme ? "day" : saved;
  });
  const [padding, setPadding] = useState<RecordingPadding>(
    schedule?.plan.padding ?? DEFAULT_PADDING,
  );
  const plan = planOf(basis, repeat, padding);
  const preview = useQuery({ ...planQuery(plan, schedule?.id), placeholderData: keepPreviousData });
  const save = useMutation({
    mutationFn: () =>
      call("recordings.schedule", { plan, ...(schedule ? { id: schedule.id } : {}) }),
    onSuccess: (saved) => {
      // The list says so as main tells, a moment later; the guide's mark shows now.
      client.setQueryData(
        schedulesQuery().queryKey,
        (list) => list && [...list.filter((each) => each.id !== saved.id), saved],
      );
      onDone();
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => call("recordings.cancel", { id }),
    onSuccess: (_, id) => {
      client.setQueryData(schedulesQuery().queryKey, (list) =>
        list?.filter((each) => each.id !== id),
      );
      onDone();
    },
  });

  const repeats: readonly { repeat: Repeat; label: string }[] = [
    ...(basis.programme ? [{ repeat: "once" as const, label: t("Once") }] : []),
    { repeat: "day", label: weekdays(basis.day) },
    { repeat: "every", label: t("Every day") },
  ];
  const panel = useRef<HTMLDivElement>(null);
  const chosen = useRef<HTMLButtonElement>(null);
  // Opened under a programme near the window's foot, it scrolls up into view whole.
  useEffect(() => {
    if (!autoFocus) return;
    chosen.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const status = preview.data?.status;
  const held = status?.kind === "conflict" || status?.kind === "waiting";
  const failure = save.error ?? cancel.error ?? preview.error;
  return (
    <div
      ref={panel}
      role="group"
      aria-label={t("Schedule {title}", { title: basis.title })}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "Escape" && onEscape) {
          event.preventDefault();
          event.stopPropagation();
          return onEscape();
        }
        const pressed =
          (event.key === "Enter" || event.key === " ") &&
          event.target instanceof Element &&
          event.target.closest("button");
        if (event.key !== "Escape" && event.key !== "Tab" && !pressed) event.preventDefault();
      }}
      // Scrolled into view, it clears the grid's sticky times.
      className={cn("flex scroll-mt-10 flex-col gap-2.5 text-[0.8125rem]", className)}
    >
      <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
        <div className="flex items-center gap-2.5">
          <span className="min-w-12 flex-none text-muted-foreground">{t("Repeat")}</span>
          <div
            role="radiogroup"
            aria-label={t("Repeat")}
            className="flex items-center gap-0.5"
            onKeyDown={(event) => {
              const by = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
              if (by === undefined) return;
              const index = repeats.findIndex((each) => each.repeat === repeat);
              const next = repeats[(index + by + repeats.length) % repeats.length];
              if (!next) return;
              setRepeat(next.repeat);
              event.currentTarget
                .querySelector<HTMLElement>(`[data-repeat="${next.repeat}"]`)
                ?.focus({ preventScroll: true });
            }}
          >
            {repeats.map((each) => {
              const on = each.repeat === repeat;
              return (
                <button
                  key={each.repeat}
                  ref={on ? chosen : undefined}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-repeat={each.repeat}
                  tabIndex={on ? 0 : -1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setRepeat(each.repeat)}
                  className={cn(
                    "flex h-[1.625rem] items-center rounded-full px-2.5 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on
                      ? "bg-foreground font-medium text-black"
                      : "text-muted-foreground hover:bg-white/8 hover:text-foreground",
                  )}
                >
                  {each.label}
                </button>
              );
            })}
          </div>
        </div>
        {/* The padding wraps under the repeat as one, in a narrow window. */}
        <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
          <Stepper
            label={t("Start")}
            value={padding.before}
            text={t("{minutes} min early", { minutes: padding.before })}
            onChange={(before) => setPadding({ ...padding, before })}
          />
          <Stepper
            label={t("End")}
            value={padding.after}
            text={t("{minutes} min late", { minutes: padding.after })}
            onChange={(after) => setPadding({ ...padding, after })}
          />
        </div>
      </div>
      <div aria-live="polite" className="flex min-h-[2.125rem] max-w-[40rem] flex-col gap-1">
        {preview.data && <Standing schedule={preview.data} channelName={channelName} now={now} />}
        {failure ? (
          <p role="alert" className="text-destructive">
            {describeError(appError(failure))}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {held
              ? t(
                  "Scheduled anyway, it starts as soon as one is free and records the rest until {time}. Nothing is stopped for it.",
                  { time: formatDate(preview.data?.next?.stop ?? now, "time") },
                )
              : t("Records while Mr. Streamer is open and the computer is awake.")}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="primary"
          size="sm"
          disabled={save.isPending || cancel.isPending || !preview.data || preview.isError}
          onClick={() => save.mutate()}
        >
          {held ? t("Schedule anyway") : schedule ? t("Save") : t("Schedule")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t("Cancel")}
        </Button>
        {schedule && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={save.isPending || cancel.isPending}
            onClick={() => cancel.mutate(schedule.id)}
          >
            {t("Cancel schedule")}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Minutes of padding, 0 to PADDING_MAX: a spin button the arrows step, by ten with Page Up and
 * Down, between − and + for the pointer.
 */
function Stepper({
  label,
  value,
  text,
  onChange,
}: {
  label: string;
  value: number;
  text: string;
  onChange: (value: number) => void;
}) {
  const set = (next: number) => onChange(Math.min(Math.max(next, 0), PADDING_MAX));
  const step = (event: KeyboardEvent) => {
    const by = {
      ArrowUp: 1,
      ArrowRight: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
      PageUp: 10,
      PageDown: -10,
    }[event.key];
    if (event.key === "Home") set(0);
    else if (event.key === "End") set(PADDING_MAX);
    else if (by !== undefined) set(value + by);
  };
  const round =
    "flex size-6 flex-none items-center justify-center rounded-full bg-white/10 text-[0.9375rem] leading-none hover:bg-white/16 disabled:opacity-40";
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        disabled={value <= 0}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => set(value - 1)}
        className={round}
      >
        −
      </button>
      <span
        role="spinbutton"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={PADDING_MAX}
        aria-valuenow={value}
        aria-valuetext={text}
        onKeyDown={step}
        className="w-[5.5rem] flex-none rounded-md text-center whitespace-nowrap tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {text}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        disabled={value >= PADDING_MAX}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => set(value + 1)}
        className={round}
      >
        +
      </button>
    </div>
  );
}

/** How the plan's next time stands, as main previews it. */
function Standing({
  schedule,
  channelName,
  now,
}: {
  schedule: ScheduledRecording;
  channelName: string;
  now: number;
}) {
  const { plan, next, status } = schedule;
  if (!next) return <p>{t("It has no time to come.")}</p>;
  // "Today 23:28" once, "Fridays 23:28" or "Every day 23:28" as it repeats.
  const when =
    plan.kind === "programme"
      ? dayTime(next.start, now)
      : t("{day} {time}", {
          day: repeatOf(plan) === "every" ? t("Every day") : weekdays(plan.days[0] ?? 0),
          time: formatDate(next.start, "time"),
        });
  const span = t("{when} to {end} on {channel}.", {
    when,
    end: formatDate(next.stop, "time"),
    channel: channelName,
  });
  switch (status.kind) {
    case "planned":
      return <p>{`${span} ${t("A connection is free then.")}`}</p>;
    case "recording":
      return <p>{`${span} ${t("Recording now.")}`}</p>;
    case "changed":
      return <p>{t("The guide lists {title} at that time now.", { title: status.title })}</p>;
    case "gone":
      return <p>{t("The guide no longer lists it.")}</p>;
    case "conflict":
    case "waiting":
      return (
        <>
          <p>{span}</p>
          <p className="font-semibold">
            {status.kind === "waiting"
              ? t("Every connection is in use now.")
              : t("Every connection is in use then.")}
          </p>
          <Holders holders={status.holders} />
        </>
      );
  }
}

/** What holds the connections, one to a line, with what it is and until when. */
function Holders({ holders }: { holders: readonly ConnectionHolder[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {holders.map((holder, at) => {
        const { what, until } = holderText(holder);
        return (
          <li key={at} className="flex items-center gap-2">
            <span aria-hidden className="flex w-3 flex-none justify-center">
              {holder.kind === "recording" ? (
                <span className="size-1.5 rounded-full bg-destructive" />
              ) : holder.kind === "schedule" ? (
                <span className="size-1.5 rounded-full ring-[1.5px] ring-destructive ring-inset" />
              ) : holder.kind === "watch" ? (
                <Play className="size-2.5 fill-current" />
              ) : (
                <Download className="size-3" />
              )}
            </span>
            <span className="w-[12.5rem] flex-none truncate">{what}</span>
            <span className="truncate text-muted-foreground">{until}</span>
          </li>
        );
      })}
    </ul>
  );
}
