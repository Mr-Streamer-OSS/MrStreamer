// Record, in Live TV's now strip: a popover that records the channel from now, to when its
// programme ends (two minutes after the guide's time, as guides run late), for an hour or two, or
// until a time of day it is given (today's, or tomorrow's once that passed, within
// RECORDING_MAX_MS), and says how many of its subscription's connections are in use. When every
// one is held, it says so, and where only playing here holds them, offers to stop that and record.
// While the channel records, the button reads Recording and opens Recordings.
import { Popover } from "@base-ui/react/popover";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { RECORDING_MAX_MS, type RecordingConnections } from "@mrstreamer/contracts/recordings";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { formatDate, t, type PlainKey } from "@mrstreamer/core/i18n";
import { openView } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { menuSurface } from "../../components/ui/menu.ts";
import { refreshNow, useNow } from "../../lib/clock.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { clockTime } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";
import { cn } from "../../lib/utils.ts";
import { player } from "../../player/player.ts";
import { useRecordingOf } from "./recordings.ts";

/** How long after the guide's end "When it ends" records. */
const LATE_MS = 2 * 60_000;
const HOUR_MS = 60 * 60_000;

type StopChoice = "end" | "1h" | "2h" | "at";

const CHOICES = [
  { choice: "end", label: "When it ends" },
  { choice: "1h", label: "In 1 hour" },
  { choice: "2h", label: "In 2 hours" },
  { choice: "at", label: "At a time…" },
] as const satisfies readonly { readonly choice: StopChoice; readonly label: PlainKey }[];

/**
 * When `choice` stops a recording started at `now`, or null where it can't: no programme on, or
 * `at`, a time input's "21:30", empty or more than RECORDING_MAX_MS ahead.
 */
function stopOf(
  choice: StopChoice,
  programme: Programme | null,
  now: number,
  at: string,
): number | null {
  switch (choice) {
    case "end": {
      if (!programme) return null;
      const stop = programme.stop + LATE_MS;
      return stop > now && stop <= now + RECORDING_MAX_MS ? stop : null;
    }
    case "1h":
      return now + HOUR_MS;
    case "2h":
      return now + 2 * HOUR_MS;
    case "at": {
      const [hours, minutes] = at.split(":").map(Number);
      if (hours === undefined || minutes === undefined || Number.isNaN(hours + minutes))
        return null;
      const stop = new Date(now);
      stop.setHours(hours, minutes, 0, 0);
      // In the hour the clocks repeat, the time typed comes again an hour after the first.
      const again = new Date(stop.getTime() + HOUR_MS);
      if (stop.getTime() <= now && again.getHours() === hours && again.getMinutes() === minutes)
        stop.setTime(again.getTime());
      if (stop.getTime() <= now) stop.setDate(stop.getDate() + 1);
      return stop.getTime() <= now + RECORDING_MAX_MS ? stop.getTime() : null;
    }
  }
}

/** "22:30" in this computer's time, as a time input takes it. */
function inputTime(at: number): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

const dot = <span aria-hidden className="size-2 flex-none rounded-full bg-destructive" />;

export function RecordButton({
  channel,
  programme,
}: {
  channel: LiveChannel;
  /** On now, as the guide lists it; null without a guide. */
  programme: Programme | null;
}) {
  const recording = useRecordingOf(channel);
  const [open, setOpen] = useState(false);
  const popup = useRef<HTMLDivElement>(null);
  // Started from the popover: the keys go to Recording, which takes Record's place, whether the
  // list or the answer says so first.
  const started = useRef(false);
  const recordingButton = useCallback((button: HTMLButtonElement | null) => {
    if (button && started.current) button.focus();
    started.current = false;
  }, []);
  if (recording) {
    return (
      <Button ref={recordingButton} variant="secondary" onClick={() => openView("recordings")}>
        {dot}
        {t("Recording")}
      </Button>
    );
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button
            variant="secondary"
            className="data-popup-open:bg-white/16 data-popup-open:ring-2 data-popup-open:ring-ring data-popup-open:ring-inset"
          >
            <span aria-hidden className="size-2.5 flex-none rounded-full bg-destructive" />
            {t("Record")}
          </Button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
          <Popover.Popup
            ref={popup}
            tabIndex={-1}
            // The popup takes the keys as it opens; Tab reaches the stop choices from there.
            initialFocus={popup}
            aria-label={t("Record")}
            // Its keys are its own: Live TV's list behind it neither moves nor plays. A focused
            // button keeps its Enter and Space, and Escape and Tab do what they do in a popup.
            onKeyDown={(event) => {
              if (event.metaKey || event.ctrlKey || event.altKey) return;
              // The stop time's field keeps its keys; the page leaves a field's alone.
              if (event.target instanceof HTMLInputElement) return;
              const pressed =
                (event.key === "Enter" || event.key === " ") &&
                event.target instanceof Element &&
                event.target.closest("button");
              if (event.key !== "Escape" && event.key !== "Tab" && !pressed) event.preventDefault();
            }}
            className={cn(
              menuSurface,
              "flex w-[22.25rem] max-w-[calc(100vw-2rem)] flex-col transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            )}
          >
            <RecordPanel
              channel={channel}
              programme={programme}
              onStarting={(starting) => (started.current = starting)}
              onDone={() => setOpen(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The popover's contents, from its opening: a choice made in one doesn't carry to the next. */
function RecordPanel({
  channel,
  programme,
  onStarting,
  onDone,
}: {
  channel: LiveChannel;
  programme: Programme | null;
  /** Whether a start is under way, or started; false once it was busy or failed. */
  onStarting: (starting: boolean) => void;
  onDone: () => void;
}) {
  const now = useNow();
  const [choice, setChoice] = useState<StopChoice>(
    stopOf("end", programme, now, "") !== null ? "end" : "1h",
  );
  // The half hour after an hour from now, until one is typed.
  const [at, setAt] = useState(() => {
    const when = new Date(now + HOUR_MS);
    const past =
      when.getMinutes() % 30 !== 0 || when.getSeconds() > 0 || when.getMilliseconds() > 0;
    when.setMinutes(Math.floor(when.getMinutes() / 30) * 30 + (past ? 30 : 0), 0, 0);
    return inputTime(when.getTime());
  });
  const time = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<RecordingConnections | null>(null);
  // At a time is offered with any time typed; Start waits for one it can record to.
  const offered = CHOICES.flatMap((each) =>
    each.choice !== "at" && stopOf(each.choice, programme, now, at) === null ? [] : [each.choice],
  );
  const stop = stopOf(choice, programme, now, at);
  const connections = useQuery({
    queryKey: ["recordings", "connections", channel.subscriptionId],
    queryFn: () => call("recordings.connections", { subscriptionId: channel.subscriptionId }),
  });
  const start = useMutation({
    mutationFn: async (stopPlaying: boolean) => {
      // Times are taken as it starts: the popover may have stood open a while.
      const stop = stopOf(choice, programme, Date.now(), at);
      // Its time went since the last tick: the popover reads the clock again and says so.
      if (stop === null) {
        refreshNow();
        return null;
      }
      if (stopPlaying) player.stop();
      onStarting(true);
      return call("recordings.start", { channel: ownedId(channel), stop, stopPlaying });
    },
    onError: () => onStarting(false),
    onSuccess: (answer) => {
      if (answer === null) return;
      if (answer.kind === "started") return onDone();
      onStarting(false);
      setBusy(answer.connections);
      void connections.refetch();
    },
  });
  const shown = busy ?? connections.data ?? null;
  // Playing here is all that holds them: stopping it frees one.
  const onlyWatch = busy !== null && busy.uses.every((use) => use === "watch");
  return (
    <>
      <div className="flex flex-col gap-1 px-2 pt-2 pb-2.5">
        <h2 className="truncate text-[0.9375rem] font-semibold">
          {t("Record {title}", { title: programme?.title ?? channel.title })}
        </h2>
        <p className="truncate text-[0.8125rem] text-muted-foreground">
          {t("{channel} · from now, {time}", {
            channel: channel.title,
            time: formatDate(now, "time"),
          })}
        </p>
      </div>
      <div className="mb-1 h-px flex-none bg-white/12" />
      <div className="px-2 pt-1.5 pb-1 text-xs font-semibold text-muted-foreground">
        {t("Stop")}
      </div>
      <div
        role="radiogroup"
        aria-label={t("Stop")}
        className="flex flex-col"
        // The arrows move the choice, and the keys with it, as in any radio group.
        onKeyDown={(event) => {
          const by = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
          if (by === undefined) return;
          const index = offered.indexOf(choice);
          const next = offered[(index + by + offered.length) % offered.length] ?? choice;
          setChoice(next);
          event.currentTarget.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus();
        }}
      >
        {CHOICES.map((each) => {
          if (!offered.includes(each.choice)) return null;
          const stop = stopOf(each.choice, programme, now, at);
          const chosen = each.choice === choice;
          return (
            <button
              key={each.choice}
              type="button"
              role="radio"
              data-choice={each.choice}
              aria-checked={chosen}
              // With its choice gone, as "When it ends" after its programme, Tab finds the first.
              tabIndex={
                chosen || (!offered.includes(choice) && each.choice === offered[0]) ? 0 : -1
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                // The time field may hold the focus, and goes with At a time: the keys stay here.
                if (each.choice !== "at") {
                  event.currentTarget.focus();
                  return setChoice(each.choice);
                }
                // Picked, as by a click, it opens on its time to type.
                flushSync(() => setChoice("at"));
                time.current?.focus();
              }}
              className={cn(
                "flex h-8.5 flex-none items-center gap-2 rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                chosen ? "bg-white/10" : "hover:bg-white/6",
              )}
            >
              <span className="flex w-4 flex-none">
                {chosen && <Check className="size-[0.9375rem]" strokeWidth={2.5} />}
              </span>
              <span className="min-w-0 flex-1 text-sm">{t(each.label)}</span>
              <span className="text-[0.8125rem] text-muted-foreground tabular-nums">
                {stop !== null &&
                  (each.choice === "at" ? clockTime(stop, now) : formatDate(stop, "time"))}
              </span>
            </button>
          );
        })}
      </div>
      {choice === "at" && (
        <div className="flex items-center gap-2 py-1 pr-2 pl-8">
          <Input
            ref={time}
            type="time"
            compact
            required
            aria-label={t("Stop at")}
            value={at}
            onChange={(event) => setAt(event.target.value)}
            className="w-[7.5rem] tabular-nums [color-scheme:dark]"
          />
        </div>
      )}
      <div className="my-1 h-px flex-none bg-white/12" />
      <div className="flex flex-col gap-1.5 px-2 pt-1.5 pb-3 text-[0.8125rem]">
        {busy && (
          <p role="alert" className="font-semibold">
            {t("Every connection is in use.")}
          </p>
        )}
        {shown && (
          <p>
            {t("Uses 1 connection. {used} of {limit} in use now.", {
              used: shown.uses.length,
              limit: shown.limit,
            })}
          </p>
        )}
        {choice === "end" && (
          <p className="text-muted-foreground">{t("Ends 2 min after the guide time.")}</p>
        )}
        {choice === "at" && stop === null && (
          <p className="text-muted-foreground">{t("Pick a time within 12 hours.")}</p>
        )}
        {start.isError && (
          <p role="alert" className="text-destructive">
            {startFailure(appError(start.error))}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 pl-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t("Cancel")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="gap-1.5"
          // A programme that ended while it stood open takes "When it ends" with it.
          disabled={start.isPending || stop === null}
          onClick={() => start.mutate(onlyWatch)}
        >
          {dot}
          {onlyWatch ? t("Stop playing and record") : t("Start recording")}
        </Button>
      </div>
    </>
  );
}

/** Why recording didn't start, in words for a channel rather than playback's for a title. */
function startFailure(error: AppError): string {
  if (error.kind !== "stream") return describeError(error);
  const { failure } = error;
  switch (failure.kind) {
    case "refused":
      return t("The provider refused the stream. Another device may be using your connection.");
    case "unavailable":
      return t("The channel has no stream right now.");
    case "provider-error":
      return t("The provider answered with an error (HTTP {status}).", {
        status: String(failure.status),
      });
    case "network":
      return describeError(error);
    case "unsupported":
      return t("This channel's stream can't be recorded.");
  }
}
