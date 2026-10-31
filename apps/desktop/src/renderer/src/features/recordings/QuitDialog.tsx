// The question an explicit Quit asks while a recording's time goes on (`window.leaveAsked`): a
// small centered dialog over the dimmed window naming what records now and what it has so far,
// and the next schedule that won't record while the app is closed. Quit ends the recordings,
// keeping what they captured, and quits; Keep recording, Escape or a click outside closes it and
// the app goes on. Closing the window never asks: recordings go on without it.
import { Dialog } from "@base-ui/react/dialog";
import { useRef } from "react";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { useNow } from "../../lib/clock.ts";
import { comingTime } from "../../lib/format.ts";
import { confirmQuit, coverage, useLiveRecordings, useQuitAsked } from "./recordings.ts";
import { useSchedules } from "./schedules.ts";

export function QuitDialog() {
  const open = useQuitAsked((state) => state.asked);
  const keep = useRef<HTMLButtonElement>(null);
  const close = () => useQuitAsked.setState({ asked: false });
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-[#0000009e] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          initialFocus={keep}
          className="fixed top-[44%] left-1/2 z-[70] flex w-[380px] max-w-[calc(100vw-2rem)] -translate-1/2 flex-col rounded-[14px] bg-popover p-[18px] shadow-[0_24px_48px_#00000099] ring-1 ring-[#ffffff1f] outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
        >
          <Dialog.Title className="text-[15.75px] leading-[20px] font-semibold tracking-[-0.01em] text-white">
            {t("Quit while recording?")}
          </Dialog.Title>
          <QuitDetails />
          <div className="flex justify-end gap-[7px] pt-4">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void confirmQuit().catch(() => {})}
            >
              {t("Quit")}
            </Button>
            <Button ref={keep} variant="primary" size="sm" className="shadow-none" onClick={close}>
              {t("Keep recording")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * What Quit ends: the one recording until its stop and the minutes it has, or how many record; then
 * the next schedule that won't record while the app is closed, and that closing the window
 * instead keeps recording.
 */
function QuitDetails() {
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
      {last && (
        <Dialog.Description className="pt-2 text-[12.25px] leading-[18px] text-white">
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
        </Dialog.Description>
      )}
      <p className="pt-2 text-[12.25px] leading-[18px] text-muted-foreground">
        {next &&
          `${t("{title}, {time}, won't record while Mr. Streamer is closed.", {
            title: next.title,
            time: comingTime(next.start, now),
          })} `}
        {t("Closing the window instead keeps recording.")}
      </p>
    </>
  );
}
