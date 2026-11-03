// Record, in Live TV's now strip: a popover that records the channel from now, to when its
// programme ends (two minutes after the guide's time, as guides run late), for an hour or two, or
// until a time of day it is given (today's, or tomorrow's once that passed, within
// RECORDING_MAX_MS), and says how many of its subscription's connections are in use, or that it
// shares the one playing that channel here. When every one is held, it says so, and where only
// playing here holds them, offers to stop that and record.
// While the channel records, the button reads Recording and opens a popover that stops that
// recording in place, so what plays here plays on, or opens Recordings. While what plays here
// shares that recording's stream, and so holds one quality, it says so.
import { Popover } from "@base-ui/react/popover";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import {
  RECORDING_MAX_MS,
  type Recording,
  type RecordingConnections,
} from "@mrstreamer/contracts/recordings";
import { ownedId, sameOwned } from "@mrstreamer/contracts/subscription";
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
import { player, usePlayer } from "../../player/player.ts";
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
 * `at`, a time input's "21:30", empty, more than RECORDING_MAX_MS ahead or skipped by the clocks.
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
      const stop = atTime(now, at);

      return typeof stop === "number" ? stop : null;
    }
  }
}

/**
 * The time `at`, a time input's "21:30", next comes after `now`: today's, or tomorrow's once that
 * passed. "skipped" where the clocks go forward past it then, null for none or one more than
 * RECORDING_MAX_MS ahead.
 */
function atTime(now: number, at: string): number | "skipped" | null {
  const [hours, minutes] = at.split(":").map(Number);

  if (hours === undefined || minutes === undefined || Number.isNaN(hours + minutes)) return null;
  const stop = new Date(now);
  stop.setHours(hours, minutes, 0, 0);
  // Where the clocks go back, by an hour or half of one, a time they repeat comes again by as
  // much after the first.
  const back = new Date(stop.getTime() + HOUR_MS).getTimezoneOffset() - stop.getTimezoneOffset();
  const again = new Date(stop.getTime() + back * 60_000);

  if (
    stop.getTime() <= now &&
    back > 0 &&
    again.getHours() === hours &&
    again.getMinutes() === minutes
  )
    stop.setTime(again.getTime());

  if (stop.getTime() <= now) {
    stop.setDate(stop.getDate() + 1);
    stop.setHours(hours, minutes, 0, 0);
  }

  // A time the clocks go forward past isn't there: setHours moves it on by the change.
  if (stop.getHours() !== hours || stop.getMinutes() !== minutes) return "skipped";

  return stop.getTime() <= now + RECORDING_MAX_MS ? stop.getTime() : null;
}

/** "22:30" in this computer's time, as a time input takes it. */
function inputTime(at: number): string {
  const date = new Date(at);

  return [date.getHours(), date.getMinutes()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

const dot = <span aria-hidden className="size-2 flex-none rounded-full bg-destructive" />;

const popupClass = cn(
  menuSurface,
  "flex w-[22.25rem] max-w-[calc(100vw-2rem)] flex-col transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
);

const triggerClass =
  "data-popup-open:bg-white/16 data-popup-open:ring-2 data-popup-open:ring-ring data-popup-open:ring-inset";

/**
 * A popup's keys are its own: Live TV's list behind it neither moves nor plays. A focused button
 * keeps its Enter and Space, a field its keys, and Escape and Tab do what they do in a popup.
 */
function ownKeys(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  // The page leaves a field's keys alone.
  if (event.target instanceof HTMLInputElement) return;

  const pressed =
    (event.key === "Enter" || event.key === " ") &&
    event.target instanceof Element &&
    event.target.closest("button");

  if (event.key !== "Escape" && event.key !== "Tab" && !pressed) event.preventDefault();
}

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

  // Stopped from Recording's popover: the keys go to Record, which takes its place again.
  const stopped = useRef(false);

  const recordButton = useCallback((button: HTMLButtonElement | null) => {
    if (button && stopped.current) button.focus();
    stopped.current = false;
  }, []);

  if (recording) {
    return (
      <RecordingPopover
        recording={recording}
        triggerRef={recordingButton}
        onStopping={(stopping) => (stopped.current = stopping)}
      />
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button ref={recordButton} variant="secondary" className={triggerClass}>
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
            onKeyDown={ownKeys}
            className={popupClass}
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

/**
 * Recording, while the channel records: its popover names the recording and when it stops, says
 * while what plays here keeps one quality to share its stream, and stops it here, which leaves
 * what plays of the channel playing, or opens Recordings, which stops that. Escape gives the keys
 * back to Recording.
 */
function RecordingPopover({
  recording,
  triggerRef,
  onStopping,
}: {
  recording: Recording;
  triggerRef: (button: HTMLButtonElement | null) => void;
  /** Whether a stop is under way, or done; false once it failed. */
  onStopping: (stopping: boolean) => void;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  const triggerButton = useCallback(
    (button: HTMLButtonElement | null) => {
      trigger.current = button;
      triggerRef(button);
    },
    [triggerRef],
  );

  const now = useNow();

  // Watch plays this channel's stream with the recording, so it holds one quality meanwhile.
  const fixed = usePlayer(
    (state) => state.fixed && state.channel !== null && sameOwned(state.channel, recording.channel),
  );

  const stop = useMutation({
    mutationFn: () => {
      onStopping(true);

      return call("recordings.stop", { id: recording.id });
    },
    onError: () => onStopping(false),
  });

  return (
    // A stop still under way stays so as it opens again: it isn't asked twice.
    <Popover.Root
      onOpenChange={(open) => open && !stop.isPending && !stop.isSuccess && stop.reset()}
    >
      <Popover.Trigger
        render={
          <Button ref={triggerButton} variant="secondary" className={triggerClass}>
            {dot}
            {t("Recording")}
          </Button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
          <Popover.Popup
            ref={popup}
            tabIndex={-1}
            // As Record's, the popup takes the keys as it opens; Tab reaches its buttons.
            initialFocus={popup}
            // Stopped from here, Recording gives way to Record, which takes the keys: the popup
            // leaves them be rather than give them back to where they were before it opened, as
            // Settings when a click opened it without taking them. Escape still gives them back.
            finalFocus={() => !(stop.isPending || stop.isSuccess) || !!trigger.current?.isConnected}
            aria-label={t("Recording")}
            onKeyDown={ownKeys}
            className={popupClass}
          >
            <div className="flex flex-col gap-1 px-2 pt-2 pb-2.5">
              <h2 className="truncate text-[0.9375rem] font-semibold">{recording.title}</h2>
              <p className="truncate text-[0.8125rem] text-muted-foreground">
                {t("{channel} · to {time}", {
                  channel: recording.channelName,
                  // Past midnight, as Record's own times say: "Tomorrow 03:00".
                  time: clockTime(recording.stop, now),
                })}
              </p>
              {fixed && (
                <p className="text-[0.8125rem] text-muted-foreground">
                  {t("Quality stays fixed while this records.")}
                </p>
              )}
            </div>
            {stop.isError && (
              <p role="alert" className="px-2 pb-3 text-[0.8125rem] text-destructive">
                {describeError(appError(stop.error))}
              </p>
            )}
            <div className="flex justify-end gap-2 pl-2">
              <Button variant="ghost" size="sm" onClick={() => openView("recordings")}>
                {t("Recordings")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                // Stopped, it stays so until Recording gives way to Record.
                disabled={stop.isPending || stop.isSuccess}
                onClick={() => stop.mutate()}
              >
                {t("Stop recording")}
              </Button>
            </div>
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
    queryKey: ["recordings", "connections", channel.subscriptionId, channel.id],
    queryFn: () =>
      call("recordings.connections", {
        subscriptionId: channel.subscriptionId,
        channel: ownedId(channel),
      }),
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
  // Recording reads what plays of this channel here: no connection more, nothing to stop.
  const shares = busy === null && connections.data?.shares === true;
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
        {shares ? (
          <p>{t("Shares the connection playing here.")}</p>
        ) : (
          shown && (
            <p>
              {t("Uses 1 connection. {used} of {limit} in use now.", {
                used: shown.uses.length,
                limit: shown.limit,
              })}
            </p>
          )
        )}
        {choice === "end" && (
          <p className="text-muted-foreground">{t("Ends 2 min after the guide time.")}</p>
        )}
        {choice === "at" && stop === null && (
          <p className="text-muted-foreground">
            {atTime(now, at) === "skipped"
              ? t("The clocks skip that time.")
              : t("Pick a time within 12 hours.")}
          </p>
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
