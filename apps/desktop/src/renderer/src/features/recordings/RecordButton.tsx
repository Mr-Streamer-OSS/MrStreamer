// Record, in Live TV's now strip: a popover that records the channel from now, to when its
// programme ends (two minutes after the guide's time, as guides run late), or for an hour or two,
// and says how many of its subscription's connections are in use. When every one is held, it says
// so, and where only playing here holds them, offers to stop that and record. While the channel
// records, the button reads Recording and opens Recordings.
import { Popover } from "@base-ui/react/popover";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useRef, useState } from "react";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { RECORDING_MAX_MS, type RecordingConnections } from "@mrstreamer/contracts/recordings";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { formatDate, t, type PlainKey } from "@mrstreamer/core/i18n";
import { openView } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { menuSurface } from "../../components/ui/menu.ts";
import { useNow } from "../../lib/clock.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { cn } from "../../lib/utils.ts";
import { player } from "../../player/player.ts";
import { useRecordingOf } from "./recordings.ts";

/** How long after the guide's end "When it ends" records. */
const LATE_MS = 2 * 60_000;
const HOUR_MS = 60 * 60_000;

type StopChoice = "end" | "1h" | "2h";

const CHOICES = [
  { choice: "end", label: "When it ends" },
  { choice: "1h", label: "In 1 hour" },
  { choice: "2h", label: "In 2 hours" },
] as const satisfies readonly { readonly choice: StopChoice; readonly label: PlainKey }[];

/** When `choice` stops a recording started at `now`, or null where it can't: no programme on. */
function stopOf(choice: StopChoice, programme: Programme | null, now: number): number | null {
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
  }
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
  if (recording) {
    return (
      <Button variant="secondary" onClick={() => openView("recordings")}>
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
            <RecordPanel channel={channel} programme={programme} onDone={() => setOpen(false)} />
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
  onDone,
}: {
  channel: LiveChannel;
  programme: Programme | null;
  onDone: () => void;
}) {
  const now = useNow();
  const [choice, setChoice] = useState<StopChoice>(
    stopOf("end", programme, now) !== null ? "end" : "1h",
  );
  const [busy, setBusy] = useState<RecordingConnections | null>(null);
  const offered = CHOICES.flatMap((each) =>
    stopOf(each.choice, programme, now) === null ? [] : [each.choice],
  );
  const connections = useQuery({
    queryKey: ["recordings", "connections", channel.subscriptionId],
    queryFn: () => call("recordings.connections", { subscriptionId: channel.subscriptionId }),
  });
  const start = useMutation({
    mutationFn: (stopPlaying: boolean) => {
      // Times are taken as it starts: the popover may have stood open a while.
      const at = Date.now();
      const stop = stopOf(choice, programme, at) ?? at + HOUR_MS;
      if (stopPlaying) player.stop();
      return call("recordings.start", { channel: ownedId(channel), stop, stopPlaying });
    },
    onSuccess: (answer) => {
      if (answer.kind === "started") return onDone();
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
          const stop = stopOf(each.choice, programme, now);
          if (stop === null) return null;
          const chosen = each.choice === choice;
          return (
            <button
              key={each.choice}
              type="button"
              role="radio"
              data-choice={each.choice}
              aria-checked={chosen}
              tabIndex={chosen ? 0 : -1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setChoice(each.choice)}
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
                {formatDate(stop, "time")}
              </span>
            </button>
          );
        })}
      </div>
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
        {start.isError && (
          <p role="alert" className="text-destructive">
            {describeError(appError(start.error))}
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
          disabled={start.isPending}
          onClick={() => start.mutate(onlyWatch)}
        >
          {dot}
          {onlyWatch ? t("Stop playing and record") : t("Start recording")}
        </Button>
      </div>
    </>
  );
}
