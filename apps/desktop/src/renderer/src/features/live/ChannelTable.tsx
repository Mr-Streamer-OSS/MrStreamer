// The guide's channel list: a row per channel with its number, logo and name, the qualities of a
// channel with several streams, what's on now with progress and time left, and what's next. The chevron opens the rest of the day under the row.
// Rows ask the guide for programmes only as they come into view.
//   A search shows the same rows for the channels it found, with what matched underlined: the
// name, the programme on now, or a later one, which then stands where what's next does, in white
// and at every width. The rest of the day opens on that programme.
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Listing, ListingMatch, Programme } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { matchRanges } from "@mrstreamer/core/text";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { useNow } from "../../lib/clock.ts";
import { clockTime, endOfDay, progressOf, timeLeft } from "../../lib/format.ts";
import { qualitiesLine } from "../../lib/quality.ts";
import { queries } from "../../lib/queries.ts";
import { useRem } from "../../lib/use-rem.ts";
import { cn } from "../../lib/utils.ts";
import { useVisibleListings } from "./lists.ts";

const ROW_REM = 3.75;
/** Later programmes the schedule shows even when today has fewer left. */
const MIN_LATER = 6;
const NONE: readonly string[] = [];

/**
 * One list's channels, or what a search found of them. Give each its own, by key: the list
 * before, its scroll position and what the virtualiser measured of it, would move this one when
 * a row opens.
 */
export function ChannelTable({
  channels,
  selected,
  playingId,
  expandedId,
  favourites,
  words,
  matches,
  onWatch,
  onToggleSchedule,
  onToggleFavourite,
}: {
  channels: readonly LiveChannel[];
  /** The keyboard selection, or null while the pointer is in use. */
  selected: number | null;
  playingId: string | null;
  expandedId: string | null;
  favourites: ReadonlySet<string>;
  /** The words of the search the channels were found by; none without one. */
  words: readonly string[];
  /** What that search found in each channel's programmes, by channel id. */
  matches: Readonly<Record<string, ListingMatch>>;
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

  // The list opens on the playing channel.
  useEffect(() => {
    const index = channels.findIndex((channel) => channel.id === playingId);
    virtualizer.scrollToIndex(Math.max(index, 0), { align: index > 0 ? "center" : "start" });
    // Only once its channels are in, not when another channel starts.
  }, [channels.length > 0]);

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
                words={words}
                match={matches[channel.id] ?? null}
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
  words,
  match,
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
  words: readonly string[];
  match: ListingMatch | null;
  onWatch: () => void;
  onToggleSchedule: () => void;
  onToggleFavourite: () => void;
}) {
  const searching = words.length > 0;
  const current = listing?.now ?? null;
  const next = listing?.next ?? null;
  // A match that began since it was found is the programme on now.
  const later = match?.later && match.later.start > now ? match.later : null;
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
            <Marked text={channel.title} words={words} />
          </span>
          {playing && <span className="size-1.5 flex-none rounded-full bg-white" />}
          <span className="flex-none text-xs text-muted-foreground">{qualitiesLine(channel)}</span>
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-4">
          {current && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.9375rem]">
                  {match?.now ? <Marked text={current.title} words={words} /> : current.title}
                </span>
                <Progress
                  value={progressOf(current, now)}
                  className="mt-1.5 w-[70%] max-w-[16rem]"
                />
              </span>
              {/* A search keeps the column after this one at every width, which takes its room. */}
              <span
                className={cn(
                  "flex-none text-xs text-muted-foreground",
                  searching && "hidden xl:block",
                )}
              >
                {timeLeft(current, now)}
              </span>
            </>
          )}
        </span>
        <span
          className={cn(
            "flex-none truncate text-sm",
            searching ? "w-[11rem] xl:w-[15rem]" : "hidden w-[15rem] xl:block",
            later ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {later ? (
            <>
              {clockTime(later.start, now)} <Marked text={later.title} words={words} />
            </>
          ) : next ? (
            `${clockTime(next.start, now)} ${next.title}`
          ) : (
            ""
          )}
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
      {expanded && (
        <Schedule channelId={channel.id} now={now} words={words} match={match} onWatch={onWatch} />
      )}
    </div>
  );
}

/** `text` with what a search's `words` matched in it underlined. */
function Marked({ text, words }: { text: string; words: readonly string[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of matchRanges(text, words)) {
    parts.push(
      text.slice(at, start),
      <mark
        key={start}
        className="bg-transparent text-white underline decoration-white/60 underline-offset-[0.2em]"
      >
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  return [...parts, text.slice(at)];
}

/**
 * The rest of the day. The programme on now plays; a later one shows its description. It opens
 * on the later programme a search found, with its description, and marks what the search found.
 */
function Schedule({
  channelId,
  now,
  words,
  match,
  onWatch,
}: {
  channelId: string;
  now: number;
  words: readonly string[];
  match: ListingMatch | null;
  onWatch: () => void;
}) {
  const schedule = useQuery(queries.schedule(channelId));
  const found = match?.later?.start ?? null;
  const [open, setOpen] = useState(found);
  // The rest of today, and at least the next few when the day is nearly over.
  const programmes = useMemo(() => {
    const midnight = endOfDay(now);
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
          found={programme.start === found}
          words={(programme.start <= now ? match?.now : programme.start === found) ? words : NONE}
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
  found,
  words,
  onClick,
}: {
  programme: Programme;
  now: number;
  open: boolean;
  /** The later programme a search found, which the day opens on. */
  found: boolean;
  /** The search's words when this programme matched them; none otherwise. */
  words: readonly string[];
  onClick: () => void;
}) {
  const onNow = programme.start <= now;
  const line = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (found) line.current?.scrollIntoView({ block: "nearest" });
  }, [found]);
  return (
    <button
      ref={line}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex w-full gap-4 rounded-lg px-2 py-1.5 text-left hover:bg-white/8",
        found && "bg-white/6",
      )}
    >
      <span className="w-[6.5rem] flex-none text-sm text-muted-foreground tabular-nums">
        {onNow ? timeLeft(programme, now) : clockTime(programme.start, now)}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm", onNow && "font-medium text-white")}>
          <Marked text={programme.title} words={words} />
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
