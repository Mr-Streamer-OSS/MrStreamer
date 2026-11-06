// The question an explicit Quit asks while a recording's time goes on or downloads would run
// (`window.leaveAsked`): a small centered dialog over the dimmed window naming what records now
// and what it has so far, how many downloads stop and where, and the next schedule that won't
// record while the app is closed. It opens once both lists are read, so it asks the right question
// from the start. Quit ends the recordings, keeping what they captured, stops the downloads with
// their partial files kept for the next launch, and quits; the keep button, focused first, Escape
// or a click outside closes it and the app goes on. Closing the window never asks: both go on
// without it. Paused, failed and finished downloads never make Quit ask (main decides).
import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import type { DownloadList } from "@mrstreamer/contracts/downloads";
import { formatDate, formatPercent, t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { useNow } from "../../lib/clock.ts";
import { downloadsQuery } from "../../lib/downloads.ts";
import { comingTime } from "../../lib/format.ts";
import {
  confirmQuit,
  coverage,
  useLiveRecordings,
  useQuitAsked,
  useRecordings,
} from "./recordings.ts";
import { useSchedules } from "./schedules.ts";

/** The downloads Quit would stop, and how far the one transferring is when its size is known. */
type Running = { readonly count: number; readonly percent: number | null };

function runningOf({ items }: DownloadList): Running {
  let count = 0;
  let percent: number | null = null;

  for (const { status } of items) {
    if (status.kind !== "transferring" && status.kind !== "queued" && status.kind !== "waiting")
      continue;
    count++;

    // Floored, as in the window bar: never 100% before it is complete.
    if (status.kind === "transferring" && status.size)
      percent = Math.floor((status.received / status.size) * 100) / 100;
  }

  return { count, percent };
}

/** The question's words for what Quit would stop. */
const asking = {
  recording: {
    title: "Quit while recording?",
    keep: "Keep recording",
    closing: "Closing the window instead keeps recording.",
  },
  downloading: {
    title: "Quit while downloading?",
    keep: "Keep downloading",
    closing: "Closing the window instead keeps downloading.",
  },
  both: {
    title: "Quit while recording and downloading?",
    keep: "Keep going",
    closing: "Closing the window instead keeps both going.",
  },
} as const;

export function QuitDialog() {
  const asked = useQuitAsked((state) => state.asked);
  const recordings = useRecordings();
  const downloads = useQuery({ ...downloadsQuery(), select: runningOf });
  const keep = useRef<HTMLButtonElement>(null);
  const close = () => useQuitAsked.setState({ asked: false });
  const live = useLiveRecordings();
  const running = downloads.data ?? { count: 0, percent: null };

  const failed = recordings.isError || downloads.isError;
  const unknown = failed || (running.count === 0 && live.length === 0);

  const words = unknown
    ? ({
        title: "Quit?",
        keep: "Cancel",
        closing: null,
      } as const)
    : running.count === 0
      ? asking.recording
      : live.length === 0
        ? asking.downloading
        : asking.both;

  return (
    <Dialog.Root
      open={asked && !recordings.isPending && !downloads.isPending}
      onOpenChange={(next) => !next && close()}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-[#0000009e] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          initialFocus={keep}
          className="fixed top-[44%] left-1/2 z-[70] flex w-[380px] max-w-[calc(100vw-2rem)] -translate-1/2 flex-col rounded-[14px] bg-popover p-[18px] shadow-[0_24px_48px_#00000099] ring-1 ring-[#ffffff1f] outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
        >
          <Dialog.Title className="text-[15.75px] leading-[20px] font-semibold tracking-[-0.01em] text-white">
            {t(words.title)}
          </Dialog.Title>
          {failed ? (
            <Dialog.Description className="pt-2 text-sm text-white">
              {t("Couldn't read background work. Try again.")}
            </Dialog.Description>
          ) : (
            <QuitDetails running={running} closing={words.closing} />
          )}
          <div className="flex justify-end gap-[7px] pt-4">
            {failed ? (
              <Button
                size="sm"
                onClick={() => {
                  void recordings.refetch();
                  void downloads.refetch();
                }}
              >
                {t("Try again")}
              </Button>
            ) : null}
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void confirmQuit().catch(() => {})}
            >
              {t("Quit")}
            </Button>
            <Button ref={keep} variant="primary" size="sm" className="shadow-none" onClick={close}>
              {t(words.keep)}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * What Quit ends: the one recording until its stop and the minutes it has, or how many record;
 * how many downloads stop and where the one transferring is; then the next schedule that won't
 * record while the app is closed, and that closing the window instead keeps them going.
 */
function QuitDetails({
  running,
  closing,
}: {
  running: Running;
  closing: (typeof asking)[keyof typeof asking]["closing"] | null;
}) {
  const now = useNow();
  const live = useLiveRecordings();
  const schedules = useSchedules().data ?? [];
  const [last] = live;

  // Not one recording now, nor one held back that wouldn't record with the app open either.
  const next = schedules
    .flatMap((each) =>
      each.next && !["recording", "changed", "gone"].includes(each.status.kind)
        ? [{ title: each.plan.title, start: each.next.start }]
        : [],
    )
    .toSorted((a, b) => a.start - b.start)[0];

  return (
    <>
      {(last || running.count > 0) && (
        <Dialog.Description render={<div />} className="text-[12.25px] leading-[18px] text-white">
          {last && (
            <p className="pt-2">
              {live.length === 1
                ? t(
                    "{title} is recording until {time}. Quitting stops it now and keeps the {minutes} min recorded.",
                    {
                      title: last.title,
                      time: formatDate(last.stop, "time"),
                      minutes: coverage(last, now).captured,
                    },
                  )
                : t(
                    "{count} recordings go on until {time}. Quitting stops them now and keeps what they recorded.",
                    { count: live.length, time: formatDate(last.stop, "time") },
                  )}
            </p>
          )}
          {running.count > 0 && (
            <p className="pt-2">
              {running.percent === null
                ? t(
                    "{count} downloads stop now. They continue from there when Mr. Streamer opens again.",
                    { count: running.count },
                  )
                : t(
                    "{count} downloads stop, one at {percent}. They continue from there when Mr. Streamer opens again.",
                    { count: running.count, percent: formatPercent(running.percent) },
                  )}
            </p>
          )}
        </Dialog.Description>
      )}
      <p className="pt-2 text-[12.25px] leading-[18px] text-muted-foreground">
        {next &&
          `${t("{title}, {time}, won't record while Mr. Streamer is closed.", {
            title: next.title,
            time: comingTime(next.start, now),
          })} `}
        {closing && t(closing)}
      </p>
    </>
  );
}
