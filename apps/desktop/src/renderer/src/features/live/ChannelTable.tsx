// The guide's channel list: a row per channel with its number, logo and name, the qualities of a
// channel with several streams, what's on now with progress and time left, and what's next. The chevron opens the rest of the day under the row.
// Rows ask the guide for programmes only as they come into view.
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Listing, Programme } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { useNow } from "../../lib/clock.ts";
import { clockTime, progressOf, timeLeft } from "../../lib/format.ts";
import { qualitiesLine } from "../../lib/quality.ts";
import { queries } from "../../lib/queries.ts";
import { useRem } from "../../lib/use-rem.ts";
import { cn } from "../../lib/utils.ts";
import { useVisibleListings } from "./lists.ts";

const ROW_REM = 3.75;
/** Later programmes the schedule shows even when today has fewer left. */
const MIN_LATER = 6;

export function ChannelTable({
  channels,
  selected,
  scrollKey,
  playingId,
  expandedId,
  favourites,
  onWatch,
  onToggleSchedule,
  onToggleFavourite,
}: {
  channels: readonly LiveChannel[];
  /** The keyboard selection, or null while the pointer is in use. */
  selected: number | null;
  /** Changes when the list changes, to scroll the playing channel into view. */
  scrollKey: string;
  playingId: string | null;
  expandedId: string | null;
  favourites: ReadonlySet<string>;
  onWatch: (channel: LiveChannel) => void;
  onToggleSchedule: (channelId: string) => void;
  onToggleFavourite: (channelId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rem = useRem();
  const now = useNow();
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_REM * rem,
    getItemKey: (index) => channels[index]?.id ?? index,
    overscan: 8,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rem, virtualizer]);

  // A new list opens on the playing channel.
  useEffect(() => {
    const index = channels.findIndex((channel) => channel.id === playingId);
    virtualizer.scrollToIndex(Math.max(index, 0), { align: index > 0 ? "center" : "start" });
    // Only when the list changes, not when another channel starts.
  }, [scrollKey, channels.length > 0]);

  // Only the keyboard scrolls the list.
  useEffect(() => {
    if (selected !== null) virtualizer.scrollToIndex(selected, { align: "auto" });
  }, [selected, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const listings = useVisibleListings(
    channels,
    items.map((item) => item.index),
  );

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-8">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const channel = channels[item.index];
          if (!channel) return null;
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute inset-x-0"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <ChannelRow
                channel={channel}
                listing={listings.get(channel.id) ?? null}
                now={now}
                playing={channel.id === playingId}
                selected={item.index === selected}
                expanded={channel.id === expandedId}
                favourite={favourites.has(channel.id)}
                onWatch={() => onWatch(channel)}
                onToggleSchedule={() => onToggleSchedule(channel.id)}
                onToggleFavourite={() => onToggleFavourite(channel.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
  listing,
  now,
  playing,
  selected,
  expanded,
  favourite,
  onWatch,
  onToggleSchedule,
  onToggleFavourite,
}: {
  channel: LiveChannel;
  listing: Listing | null;
  now: number;
  playing: boolean;
  selected: boolean;
  expanded: boolean;
  favourite: boolean;
  onWatch: () => void;
  onToggleSchedule: () => void;
  onToggleFavourite: () => void;
}) {
  const current = listing?.now ?? null;
  const next = listing?.next ?? null;
  return (
    <div className="pb-1">
      <div
        role="button"
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onWatch}
        className={cn(
          "group flex h-[3.5rem] items-center gap-4 rounded-xl px-3 hover:bg-white/8",
          expanded && "rounded-b-none bg-white/8",
          playing && !expanded && "bg-white/5",
          selected && "ring-2 ring-white/70 ring-inset",
        )}
      >
        <span className="w-9 flex-none text-right text-xs text-muted-foreground tabular-nums">
          {channel.number ?? ""}
        </span>
        <ChannelLogo channel={channel} className="h-8 w-12" />
        <span className="flex w-[13rem] flex-none items-center gap-2" title={channel.name}>
          <span className={cn("truncate text-[0.9375rem]", playing && "font-semibold text-white")}>
            {channel.title}
          </span>
          {playing && <span className="size-1.5 flex-none rounded-full bg-white" />}
          <span className="flex-none text-xs text-muted-foreground">{qualitiesLine(channel)}</span>
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-4">
          {current && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.9375rem]">{current.title}</span>
                <Progress
                  value={progressOf(current, now)}
                  className="mt-1.5 w-[70%] max-w-[16rem]"
                />
              </span>
              <span className="flex-none text-xs text-muted-foreground">
                {timeLeft(current, now)}
              </span>
            </>
          )}
        </span>
        <span className="hidden w-[15rem] flex-none truncate text-sm text-muted-foreground xl:block">
          {next ? `${clockTime(next.start, now)} ${next.title}` : ""}
        </span>
        <span className="flex w-[4.5rem] flex-none items-center justify-end gap-1">
          <IconButton
            label={favourite ? "Remove from favourites" : "Add to favourites"}
            onClick={onToggleFavourite}
            className={cn(!favourite && !selected && "opacity-0 group-hover:opacity-100")}
          >
            <Star className={cn("size-4", favourite && "fill-current")} />
          </IconButton>
          {listing && (
            <IconButton
              label={expanded ? "Hide later programmes" : "Later programmes"}
              onClick={onToggleSchedule}
              className={cn(!expanded && !selected && "opacity-0 group-hover:opacity-100")}
            >
              <ChevronDown className={cn("size-4", expanded && "rotate-180")} />
            </IconButton>
          )}
        </span>
      </div>
      {expanded && <Schedule channelId={channel.id} now={now} onWatch={onWatch} />}
    </div>
  );
}

/** The rest of the day. The programme on now plays; a later one shows its description. */
function Schedule({
  channelId,
  now,
  onWatch,
}: {
  channelId: string;
  now: number;
  onWatch: () => void;
}) {
  const schedule = useQuery(queries.schedule(channelId));
  const [open, setOpen] = useState<number | null>(null);
  // The rest of today, and at least the next few when the day is nearly over.
  const programmes = useMemo(() => {
    const midnight = new Date(now).setHours(24, 0, 0, 0);
    return (schedule.data ?? [])
      .filter((programme) => programme.stop > now)
      .filter((programme, index) => programme.start < midnight || index < MIN_LATER);
  }, [schedule.data, now]);
  return (
    <div className="rounded-b-xl bg-white/5 py-2 pr-4 pl-[17.5rem]">
      {programmes.map((programme) => (
        <ScheduleLine
          key={programme.start}
          programme={programme}
          now={now}
          open={open === programme.start}
          onClick={() =>
            programme.start <= now
              ? onWatch()
              : setOpen((current) => (current === programme.start ? null : programme.start))
          }
        />
      ))}
    </div>
  );
}

function ScheduleLine({
  programme,
  now,
  open,
  onClick,
}: {
  programme: Programme;
  now: number;
  open: boolean;
  onClick: () => void;
}) {
  const onNow = programme.start <= now;
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex w-full gap-4 rounded-lg px-2 py-1.5 text-left hover:bg-white/8"
    >
      <span className="w-[6.5rem] flex-none text-sm text-muted-foreground tabular-nums">
        {onNow ? timeLeft(programme, now) : clockTime(programme.start, now)}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm", onNow && "font-medium text-white")}>
          {programme.title}
        </span>
        {onNow && <Progress value={progressOf(programme, now)} className="mt-1 w-40" />}
        {(open || onNow) && programme.description && (
          <span className="mt-1 block text-[0.8125rem] leading-relaxed text-muted-foreground select-text">
            {programme.description}
          </span>
        )}
      </span>
    </button>
  );
}

function IconButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-white/10 hover:text-white",
        className,
      )}
    >
      {children}
    </button>
  );
}
