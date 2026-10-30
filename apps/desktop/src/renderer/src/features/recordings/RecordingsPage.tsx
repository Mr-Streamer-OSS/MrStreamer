// Recordings: what records now, then what was recorded, newest first. Each row says what it is,
// its channel and when, a bar of the minutes captured against those planned, how it ended and
// why, and its size; one that records has Stop, an ended one Play and, in its menu, Delete. A
// Stop or Delete that fails says so in place of the reason. Narrower windows put the size in the
// row's second line and the outcome under the bar.
import { Menu } from "@base-ui/react/menu";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Ellipsis, Play } from "lucide-react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Recording } from "@mrstreamer/contracts/recordings";
import { sameOwned } from "@mrstreamer/contracts/subscription";
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

export function RecordingsPage() {
  const list = useRecordings();
  const recordings = list.data ?? [];
  const now = recordings.filter((each) => each.status.kind === "recording");
  const recorded = recordings.filter((each) => each.status.kind !== "recording");
  // Logos, from the channels as the lists have them now; a channel gone leaves its slot empty.
  const channels = useQuery(queries.channelsOf(recordings.map((each) => each.channel))).data ?? [];
  const logoOf = (recording: Recording) =>
    channels.find((channel) => sameOwned(channel, recording.channel)) ?? null;
  return (
    <div className="flex h-full flex-col">
      <WindowBar className="bg-black" />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-2 pb-10 lg:px-10">
        <div className="flex items-baseline gap-3 pb-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Recordings")}</h1>
          {recordings.length > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatNumber(recordings.length)}
            </span>
          )}
        </div>
        {list.error ? (
          <div role="alert" className="flex items-center gap-3 pt-2 text-sm">
            <span className="text-destructive">{describeError(appError(list.error))}</span>
            <Button size="sm" onClick={() => void list.refetch()}>
              {t("Retry")}
            </Button>
          </div>
        ) : list.data && recordings.length === 0 ? (
          <p className="pt-2 text-[0.9375rem] text-muted-foreground">
            {t("Nothing recorded yet. Record a channel from Live TV.")}
          </p>
        ) : null}
        <Section label={t("Now")} items={now} logoOf={logoOf} first />
        <Section label={t("Recorded")} items={recorded} logoOf={logoOf} first={now.length === 0} />
        {recordings.length > 0 && (
          <p className="pt-4 text-[0.8125rem] text-muted-foreground">
            {t("Recordings stay until you delete them. Partial ones still play.")}
          </p>
        )}
      </div>
    </div>
  );
}

/** A titled list of recordings; nothing while it has none. */
function Section({
  label,
  items,
  logoOf,
  first,
}: {
  label: string;
  items: readonly Recording[];
  logoOf: (recording: Recording) => LiveChannel | null;
  first: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={label}>
      <h2
        className={cn("pb-0.5 text-[0.9375rem] font-semibold", first ? "pt-2.5" : "pt-4 lg:pt-5")}
      >
        {label}
      </h2>
      <ul>
        {items.map((each) => (
          <Row key={each.id} recording={each} channel={logoOf(each)} />
        ))}
      </ul>
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
  const missing = recording.status.kind === "missing";
  const { captured, planned } = coverage(recording, now);
  const minutes = t("{captured} of {planned} min", { captured, planned });
  const { word, reason } = outcome(recording, now);
  const action = useMutation({
    mutationFn: (kind: "stop" | "remove") =>
      call(kind === "stop" ? "recordings.stop" : "recordings.remove", { id: recording.id }),
  });
  const failure = action.error ? describeError(appError(action.error)) : null;
  const size = missing ? null : formatBytes(recording.bytes);
  const when = t("{start} to {end}", {
    start: dayTime(recording.start, now),
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
        <Coverage captured={captured} planned={planned} faint={missing} />
        <span className="hidden text-xs text-muted-foreground tabular-nums lg:block">
          {minutes}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs lg:hidden">
          {active && (
            <span aria-hidden className="size-1.5 flex-none rounded-full bg-destructive" />
          )}
          <span className="flex-none font-semibold text-foreground">{word}</span>
          <span className={cn("truncate", failure ? "text-destructive" : "text-muted-foreground")}>
            {failure ?? `${minutes}. ${reason}`}
          </span>
        </span>
      </div>
      <span className="hidden min-w-0 flex-1 items-center gap-2 text-[0.8125rem] lg:flex">
        {active && <span aria-hidden className="size-2 flex-none rounded-full bg-destructive" />}
        <span className="flex-none font-semibold text-foreground">{word}</span>
        <span className={cn("truncate", failure ? "text-destructive" : "text-muted-foreground")}>
          {failure ?? reason}
        </span>
      </span>
      <span className="hidden w-16 flex-none text-right text-xs text-muted-foreground tabular-nums lg:block">
        {size}
      </span>
      <div className="flex w-[4.5rem] flex-none justify-end gap-1.5 lg:w-[9.15rem]">
        {active ? (
          <Button size="sm" disabled={action.isPending} onClick={() => action.mutate("stop")}>
            {t("Stop")}
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

/** Minutes captured against those planned: a white line on a faint track. */
function Coverage({
  captured,
  planned,
  faint,
}: {
  captured: number;
  planned: number;
  faint: boolean;
}) {
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={planned}
      aria-valuenow={captured}
      className={cn("flex h-1 overflow-hidden rounded-[2px]", faint ? "bg-white/8" : "bg-white/15")}
    >
      <span className="h-full bg-foreground" style={{ width: `${(captured / planned) * 100}%` }} />
    </span>
  );
}
