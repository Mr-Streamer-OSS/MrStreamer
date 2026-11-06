// What a schedule records, as it is made or changed: how often (Once, the programme's weekday or
// a repeat's days, or every day), how many minutes early it starts and late it ends, within the
// room a recording has, and how its next time stands as main previews it (`recordings.plan`),
// saving nothing until Schedule. While every connection is held then, it names what holds it and
// offers Schedule anyway. One already saved can be cancelled from here too. The guide grid's
// programme details show it inline, Recordings' Edit in a popover.
//   A new one made from a guide programme can instead Follow the programme: a rule recording each
// airing of its title on the channels chosen, every match or new episodes only, which lists the
// airings main would record now (`recordings.previewRule`) and saves with Turn on rule. A rule is
// changed, or stopped, from Recordings in the same controls (`RulePanel`). A time a rule records
// opens to how it stands, with Cancel schedule letting that one airing go.
//   Its keys are its own: arrows move the repeat and step the padding, and nothing behind it
// moves. Escape closes it where `onEscape` is given; a popover closes itself.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Download } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  DEFAULT_PADDING,
  PADDING_MAX,
  type ConnectionHolder,
  type RecordingPadding,
  type RecordingRule,
  type RecordingRuleMatch,
  type RecordingRulePlan,
  type ScheduledRecording,
} from "@mrstreamer/contracts/recordings";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { useNow } from "../../lib/clock.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { dayTime } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import {
  holderText,
  isRuleOccurrence,
  paddingRoom,
  planOf,
  planQuery,
  repeatOf,
  rulePreviewQuery,
  rulesQuery,
  schedulesQuery,
  titleChannelsQuery,
  weekdays,
  type Repeat,
  type ScheduleBasis,
} from "./schedules.ts";
import { defined } from "@mrstreamer/core/defined";

type Props = {
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
};

export function SchedulePanel(props: Props) {
  return props.schedule && isRuleOccurrence(props.schedule) ? (
    <OccurrencePanel {...props} schedule={props.schedule} />
  ) : (
    <ScheduleControls {...props} />
  );
}

/** How often a schedule made here records, or Follow, a rule by the programme's title. */
type Choice = Repeat | "follow";

function ScheduleControls({
  basis,
  channelName,
  schedule,
  autoFocus = false,
  onEscape,
  onDone,
  className,
}: Props) {
  const client = useQueryClient();
  const now = useNow();

  const [repeat, setRepeat] = useState<Choice>(() => {
    const saved = schedule ? repeatOf(schedule.plan) : "once";

    return saved === "once" && !basis.programme ? "day" : saved;
  });

  const [padding, setPadding] = useState<RecordingPadding>(
    schedule?.plan.padding ?? DEFAULT_PADDING,
  );

  // A rule's airings each fit the room a recording has on their own; main leaves out any that
  // doesn't. Following, the schedule's plan is the programme's once, and nothing previews it.
  const following = repeat === "follow";
  const scheduled = following ? "once" : repeat;

  // Each side's padding takes what the other leaves of the room a recording has, the end's first.
  const room = following
    ? 2 * PADDING_MAX
    : paddingRoom(planOf(basis, scheduled, { before: 0, after: 0 }));

  const after = Math.min(padding.after, room);
  const fitted = { before: Math.min(padding.before, room - after), after };
  const plan = planOf(basis, scheduled, fitted);

  const preview = useQuery({
    ...planQuery(plan, schedule?.id),
    placeholderData: keepPreviousData,
    enabled: !following,
  });

  const save = useMutation({
    mutationFn: () =>
      call("recordings.schedule", { plan, ...defined({ id: schedule ? schedule.id : undefined }) }),
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

  const repeats: readonly { repeat: Choice; label: string }[] = [
    ...(basis.programme ? [{ repeat: "once" as const, label: t("Once") }] : []),
    { repeat: "day", label: weekdays(basis.days) },
    { repeat: "every", label: t("Every day") },
    // A rule is made from a programme's title; a saved schedule stays a schedule.
    ...(basis.programme && !schedule
      ? [{ repeat: "follow" as const, label: t("Follow programme") }]
      : []),
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
      aria-label={
        following
          ? t("Follow {title}", { title: basis.title })
          : t("Schedule {title}", { title: basis.title })
      }
      onKeyDown={(event) => guardKeys(event, onEscape)}
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
        <PaddingSteppers padding={fitted} room={room} onChange={setPadding} />
      </div>
      {following ? (
        <RuleFields
          title={basis.title}
          named={[{ owned: basis.channel, name: channelName }]}
          padding={fitted}
          onDone={onDone}
        />
      ) : (
        <>
          <div aria-live="polite" className="flex min-h-[2.125rem] max-w-[40rem] flex-col gap-1">
            {preview.data && (
              <Standing schedule={preview.data} channelName={channelName} now={now} />
            )}
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
              // The last plan's answer stands in while a changed one is read: not a label to save by.
              disabled={
                save.isPending ||
                cancel.isPending ||
                !preview.data ||
                preview.isPlaceholderData ||
                preview.isError
              }
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
        </>
      )}
    </div>
  );
}

/**
 * Keeps a panel's keys its own: Tab moves on, Enter and Space press its buttons, Escape runs
 * `onEscape` where given, and nothing else reaches what is behind it.
 */
function guardKeys(event: KeyboardEvent, onEscape?: () => void) {
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
}

/** Start and End padding, each taking what the other leaves of `room`; they wrap as one. */
function PaddingSteppers({
  padding,
  room,
  onChange,
}: {
  padding: RecordingPadding;
  room: number;
  onChange: (padding: RecordingPadding) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
      <Stepper
        label={t("Start")}
        value={padding.before}
        max={Math.min(PADDING_MAX, room - padding.after)}
        text={t("{minutes} min early", { minutes: padding.before })}
        onChange={(before) => onChange({ ...padding, before })}
      />
      <Stepper
        label={t("End")}
        value={padding.after}
        max={Math.min(PADDING_MAX, room - padding.before)}
        text={t("{minutes} min late", { minutes: padding.after })}
        onChange={(after) => onChange({ ...padding, after })}
      />
    </div>
  );
}

/**
 * Minutes of padding, 0 to `max`: a spin button the arrows step, by ten with Page Up and Down,
 * between − and + for the pointer.
 */
function Stepper({
  label,
  value,
  max,
  text,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  text: string;
  onChange: (value: number) => void;
}) {
  const set = (next: number) => onChange(Math.min(Math.max(next, 0), max));

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
    else if (event.key === "End") set(max);
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
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        onKeyDown={step}
        className="min-w-[5.5rem] flex-none rounded-md text-center whitespace-nowrap tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {text}
      </span>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        disabled={value >= max}
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
          day: repeatOf(plan) === "every" ? t("Every day") : weekdays(plan.days),
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
    case "retrying":
      return (
        <p>{`${span} ${
          status.why === "stream"
            ? t("The stream couldn't be opened.")
            : t("It couldn't be written to this computer.")
        }`}</p>
      );
    case "changed":
      return <p>{t("The guide lists {title} at that time now.", { title: status.title })}</p>;
    case "gone":
      return <p>{t("Its programme or channel is no longer listed.")}</p>;
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

/**
 * A saved rule's controls, as Recordings' Edit opens them: its padding, channels and what it
 * records, Save, and Stop following, which lets its airings to come go.
 */
export function RulePanel({ rule, onDone }: { rule: RecordingRule; onDone: () => void }) {
  const { plan } = rule;
  const [padding, setPadding] = useState(plan.padding);
  const names = useQuery(queries.channelsOf(plan.channels)).data;

  // Its channels are offered by name once the lists answer.
  if (!names) return null;

  return (
    <div
      role="group"
      aria-label={t("Follow {title}", { title: plan.title })}
      onKeyDown={(event) => guardKeys(event)}
      className="flex flex-col gap-2.5 text-[0.8125rem]"
    >
      <PaddingSteppers padding={padding} room={2 * PADDING_MAX} onChange={setPadding} />
      <RuleFields
        title={plan.title}
        named={names.map((channel) => ({ owned: channel, name: channel.title }))}
        chosen={plan.channels}
        mode={plan.mode ?? "every"}
        padding={padding}
        id={rule.id}
        onDone={onDone}
      />
    </div>
  );
}

/** A channel a rule can record on, with the name it shows. */
type NamedChannel = { readonly owned: OwnedId; readonly name: string };

type Mode = NonNullable<RecordingRulePlan["mode"]>;

/** Airings listed in the panel before the rest are counted. */
const SHOWN_MATCHES = 8;

/**
 * A rule's channels and what it records, the airings main would record now, and how it saves.
 * The channels offered are `named`, then those whose guide lists the title in their
 * subscriptions; `chosen` are on as it opens, else all of `named`. Every match is the default.
 * New episodes only needs the guide to mark an airing as a premiere with its episode number, so
 * it can't be chosen while no airing found is marked so. Saved, it is `id`'s rule changed.
 */
function RuleFields({
  title,
  named,
  chosen,
  mode: initialMode = "every",
  padding,
  id,
  onDone,
}: {
  title: string;
  named: readonly NamedChannel[];
  chosen?: readonly OwnedId[];
  mode?: Mode;
  padding: RecordingPadding;
  id?: string;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const now = useNow();
  const [from] = useState(() => Date.now());
  const [mode, setMode] = useState<Mode>(initialMode);
  const unmarkedId = useId();

  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set((chosen ?? named.map((each) => each.owned)).map(ownedKey)),
  );

  const subscriptions = [...new Set(named.map((each) => each.owned.subscriptionId))];
  const found = useQuery(titleChannelsQuery(title, subscriptions, from));

  const offered = [...named, ...(found.data ?? [])].filter(
    (each, at, all) =>
      all.findIndex((other) => ownedKey(other.owned) === ownedKey(each.owned)) === at,
  );

  const channels = offered.flatMap(({ owned }) =>
    selected.has(ownedKey(owned)) ? [{ subscriptionId: owned.subscriptionId, id: owned.id }] : [],
  );

  const plan: RecordingRulePlan = { title, channels, mode, padding };
  const preview = useQuery({ ...rulePreviewQuery(plan), placeholderData: keepPreviousData });
  const premieres = useQuery(rulePreviewQuery({ ...plan, mode: "new-only" })).data;

  // No airing found is marked as a new episode: there is nothing New episodes only could record.
  const unmarked =
    premieres !== undefined && premieres.matches.length === 0 && premieres.unproven > 0;

  const save = useMutation({
    mutationFn: () => call("recordings.saveRule", { plan, ...defined({ id }) }),
    onSuccess: (saved) => {
      client.setQueryData(
        rulesQuery().queryKey,
        (list) => list && [...list.filter((each) => each.id !== saved.id), saved],
      );
      onDone();
    },
  });

  const stop = useMutation({
    mutationFn: (rule: string) => call("recordings.cancelRule", { id: rule }),
    onSuccess: (_, rule) => {
      client.setQueryData(rulesQuery().queryKey, (list) =>
        list?.filter((each) => each.id !== rule),
      );
      onDone();
    },
  });

  const failure = save.error ?? stop.error ?? preview.error ?? found.error;
  const shown = channels.length > 0 ? preview.data : undefined;
  const modes: readonly Mode[] = ["every", "new-only"];

  return (
    <>
      <div className="flex flex-wrap gap-x-10 gap-y-3">
        <div className="flex min-w-0 flex-[1_1_28rem] flex-col">
          <Field label={t("Channels")}>
            <div className="flex flex-wrap gap-1.5 py-1">
              {offered.map(({ owned, name }) => {
                const key = ownedKey(owned);
                const on = selected.has(key);

                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      const next = new Set(selected);

                      if (on) next.delete(key);
                      else next.add(key);
                      setSelected(next);
                    }}
                    className={cn(
                      "flex h-7 items-center rounded-full px-3 text-xs whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on
                        ? "bg-foreground font-semibold text-black"
                        : "bg-white/8 font-medium text-muted-foreground hover:bg-white/12 hover:text-foreground",
                    )}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label={t("Record")}>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1">
              <div
                role="radiogroup"
                aria-label={t("Record")}
                className="flex items-center gap-1.5"
                onKeyDown={(event) => {
                  const by = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];

                  if (by === undefined || unmarked) return;
                  const next = modes[(modes.indexOf(mode) + by + modes.length) % modes.length];

                  if (!next) return;
                  setMode(next);
                  event.currentTarget
                    .querySelector<HTMLElement>(`[data-mode="${next}"]`)
                    ?.focus({ preventScroll: true });
                }}
              >
                {modes.map((each) => {
                  const on = each === mode;
                  // A rule saved as new episodes only stays choosable, to see why it records none.
                  const off = each === "new-only" && unmarked && !on;

                  return (
                    <button
                      key={each}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-describedby={off ? unmarkedId : undefined}
                      data-mode={each}
                      tabIndex={on ? 0 : -1}
                      disabled={off}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setMode(each)}
                      className={cn(
                        "flex h-7 items-center rounded-full px-3 text-xs whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        on
                          ? "bg-foreground font-semibold text-black"
                          : off
                            ? "border border-dashed border-white/16 font-medium text-muted-foreground/70"
                            : "font-medium text-muted-foreground hover:bg-white/8 hover:text-foreground",
                      )}
                    >
                      {each === "every" ? t("Every match") : t("New episodes only")}
                    </button>
                  );
                })}
              </div>
              {unmarked && (
                <span id={unmarkedId} className="text-xs whitespace-nowrap text-muted-foreground">
                  {t("The guide doesn't mark new episodes here.")}
                </span>
              )}
            </div>
          </Field>
        </div>
        {shown && shown.matches.length > 0 && <Matches matches={shown.matches} now={now} />}
      </div>
      <div aria-live="polite" className="flex min-h-[2.125rem] max-w-[40rem] flex-col gap-1">
        {failure ? (
          <p role="alert" className="text-destructive">
            {describeError(appError(failure))}
          </p>
        ) : channels.length === 0 ? (
          <p className="text-muted-foreground">{t("Choose at least one channel.")}</p>
        ) : (
          shown && (
            <>
              {shown.matches.length === 0 && (
                <p>
                  {t(
                    "Nothing in the guide matches now. The rule keeps looking as the guide changes.",
                  )}
                </p>
              )}
              {mode === "new-only" && shown.unproven > 0 && (
                <p>
                  {t("{count} airings left out: the guide doesn't show them as new episodes.", {
                    count: shown.unproven,
                  })}
                </p>
              )}
              {shown.limited && (
                <p>
                  {t(
                    "The guide lists more airings than one check reads. Later ones follow as these pass.",
                  )}
                </p>
              )}
              <p className="text-muted-foreground">
                {t("Records while Mr. Streamer is open and the computer is awake.")}
              </p>
            </>
          )
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="primary"
          size="sm"
          disabled={
            channels.length === 0 ||
            save.isPending ||
            stop.isPending ||
            !preview.data ||
            preview.isPlaceholderData ||
            preview.isError
          }
          onClick={() => save.mutate()}
        >
          {id ? t("Save") : t("Turn on rule")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t("Cancel")}
        </Button>
        {id && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={save.isPending || stop.isPending}
            onClick={() => stop.mutate(id)}
          >
            {t("Stop following")}
          </Button>
        )}
      </div>
    </>
  );
}

/** One of a rule's settings: its name in a lane of its own, then its controls. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[2.375rem] items-center">
      <span className="w-[6.875rem] flex-none text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * The airings a rule would record now, by when: day, time, channel, and On now for one already
 * under way, which records the rest. The first few are listed and the rest counted.
 */
function Matches({ matches, now }: { matches: readonly RecordingRuleMatch[]; now: number }) {
  const rest = matches.length - SHOWN_MATCHES;

  return (
    <section
      aria-label={t("Matches in the guide")}
      className="flex min-w-0 flex-[1_1_22rem] flex-col"
    >
      <h3 className="pb-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        {t("Matches in the guide")}
      </h3>
      <ul>
        {matches.slice(0, SHOWN_MATCHES).map(({ identity, plan, channelName }) => (
          <li
            key={identity}
            className="flex h-8 items-center border-b border-white/6 last:border-b-0"
          >
            <span className="w-24 flex-none whitespace-nowrap">
              {formatDate(plan.start, "weekdayDay")}
            </span>
            <span className="w-[10rem] flex-none whitespace-nowrap tabular-nums">
              {t("{start} to {end}", {
                start: formatDate(plan.start, "time"),
                end: formatDate(plan.stop, "time"),
              })}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{channelName}</span>
            {plan.start <= now && (
              <span className="flex-none text-xs text-muted-foreground">{t("On now")}</span>
            )}
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <p className="pt-1.5 text-xs text-muted-foreground">{t("{count} more", { count: rest })}</p>
      )}
    </section>
  );
}

/**
 * A time a rule records, from the guide's details: how it stands, that the rule sets its padding,
 * and Cancel schedule, which lets this one airing go and leaves the rule following the rest.
 */
function OccurrencePanel({
  schedule,
  channelName,
  autoFocus = false,
  onEscape,
  onDone,
  className,
}: Props & { schedule: ScheduledRecording }) {
  const client = useQueryClient();
  const now = useNow();
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (autoFocus) close.current?.focus({ preventScroll: true });
  }, []);

  const cancel = useMutation({
    mutationFn: () => call("recordings.cancel", { id: schedule.id }),
    onSuccess: () => {
      client.setQueryData(schedulesQuery().queryKey, (list) =>
        list?.filter((each) => each.id !== schedule.id),
      );
      onDone();
    },
  });

  return (
    <div
      role="group"
      aria-label={t("Schedule {title}", { title: schedule.plan.title })}
      onKeyDown={(event) => guardKeys(event, onEscape)}
      className={cn("flex scroll-mt-10 flex-col gap-2.5 text-[0.8125rem]", className)}
    >
      <div aria-live="polite" className="flex max-w-[40rem] flex-col gap-1">
        <Standing schedule={schedule} channelName={channelName} now={now} />
        {cancel.error ? (
          <p role="alert" className="text-destructive">
            {describeError(appError(cancel.error))}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {t("A rule following {title} records this. Its padding is the rule's.", {
              title: schedule.plan.title,
            })}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button ref={close} variant="secondary" size="sm" onClick={onDone}>
          {t("Close")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {t("Cancel schedule")}
        </Button>
      </div>
    </div>
  );
}
