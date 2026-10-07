import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Search, Star } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ProgrammeMatch } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Title } from "@mrstreamer/contracts/ondemand";
import {
  automaticSearchCopy,
  groupLiveSearch,
  type LiveSearchGroup,
} from "@mrstreamer/core/catalogue/search";
import { ownedId, ownedKey } from "@mrstreamer/contracts/subscription";
import { openDetails, useUi } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { useNow } from "../../lib/clock.ts";
import { clockTime, timeLeft } from "../../lib/format.ts";
import {
  queries,
  useCategoryMap,
  useSourceOf,
  useFavouriteKeys,
  useSubscriptions,
  useSubscriptionNames,
  useToggleFavourite,
} from "../../lib/queries.ts";
import { useDebounced } from "../../lib/use-debounced.ts";
import { searchQualities } from "../live/search-rows.ts";
import { cn } from "../../lib/utils.ts";
import { titlePlayer } from "../../player/title-player.ts";
import { watchChannel } from "../live/GuidePage.tsx";

/**
 * Searches channel names across every category, then movies and series, then programmes on now
 * and later today. Opens with ⌘K or Ctrl K, on what Movies or Series searched for, if anything.
 */
export function SearchPalette() {
  const open = useUi((state) => state.searchOpen);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => useUi.setState({ searchOpen: next })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/70 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-[12vh] left-1/2 z-50 w-[40rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-3xl bg-black text-white shadow-2xl ring-1 ring-white/10 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <Palette />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A search result: a channel, a movie or series, or a programme on the channel that shows it. */
type Result =
  | {
      readonly kind: "channel";
      readonly channel: LiveChannel;
      readonly group: LiveSearchGroup;
      readonly copy: boolean;
      readonly key: string;
      readonly match: ProgrammeMatch | null;
    }
  | { readonly kind: "title"; readonly title: Title };

/** Channel results listed before the rest. */
const CHANNEL_RESULTS = 20;
/** Movies, and then series, listed after the channels. */
const TITLE_RESULTS = 6;

function Palette() {
  const resultsId = useId();
  // Mounted each time it opens.
  const [query, setQuery] = useState(() => useUi.getState().searchFrom);
  const debounced = useDebounced(query, 120);
  const channels = useQuery(queries.search(debounced));
  const programmes = useQuery(queries.programmes(debounced));
  const programmeChannels = useMemo(
    () => (programmes.data ?? []).map((match) => match.channel),
    [programmes.data],
  );
  const programmeCopies = useQuery(queries.searchWithProgrammes(debounced, programmeChannels));
  const titles = useQuery(queries.titleSearch(debounced));
  const categories = useCategoryMap();
  // Results come from every subscription: one says whose it is where another reads the same.
  const sourceOf = useSourceOf();
  const now = useNow();
  const favourites = useFavouriteKeys();
  const subscriptions = useSubscriptions();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const matches = useMemo(
    () => new Map((programmes.data ?? []).map((match) => [ownedKey(match.channel), match])),
    [programmes.data],
  );
  const groups = useMemo(() => {
    const named = groupLiveSearch(channels.data ?? []).slice(0, CHANNEL_RESULTS);
    const matches = [
      ...named.flatMap((group) => group.copies),
      ...(programmeCopies.data ?? []),
      ...(programmes.data ?? []).map((match) => match.channel),
    ];
    return groupLiveSearch(matches);
  }, [channels.data, programmeCopies.data, programmes.data]);
  const [active, setActive] = useState(0);
  const results = useMemo((): Result[] => {
    if (!debounced.trim()) return [];
    return [
      ...groups.flatMap((group): Result[] => {
        const match =
          group.copies.map((channel) => matches.get(ownedKey(channel))).find(Boolean) ?? null;
        const channel = match?.channel ?? group.copies[0]!;
        return [
          { kind: "channel", group, channel, copy: false, key: group.key, match },
          ...(expanded.has(group.key) && group.copies.length > 1
            ? group.copies.map((channel): Result => ({
                kind: "channel",
                group,
                channel,
                copy: true,
                key: `${group.key}/copy/${ownedKey(channel)}`,
                match: matches.get(ownedKey(channel)) ?? null,
              }))
            : []),
        ];
      }),
      ...[
        ...(titles.data?.movies ?? []).slice(0, TITLE_RESULTS),
        ...(titles.data?.series ?? []).slice(0, TITLE_RESULTS),
      ].map((title): Result => ({ kind: "title", title })),
    ];
  }, [debounced, groups, expanded, matches, titles.data]);

  useEffect(() => {
    setActive(0);
    setExpanded(new Set());
  }, [debounced]);

  // Keep the highlighted result in view while moving through the list with the keyboard.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /** Group rows use Automatic; expanded copies keep their real subscription and quality choices. */
  const choose = (index: number) => {
    const result = results[index];
    if (!result) return;
    if (result.kind === "channel")
      watchChannel(
        result.copy ? result.channel : automaticSearchCopy(result.group, favourites, subscriptions),
      );
    else if (result.kind === "title") {
      // Details show over the page, so a title playing gives way first, saving how far it got.
      if (useUi.getState().playingTitle) {
        titlePlayer.close();
        useUi.setState({ playingTitle: false });
      }
      openDetails({ kind: result.title.kind, ...ownedId(result.title) });
    }
  };

  function onKey(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    if (event.key === "Enter" && event.target instanceof HTMLButtonElement) return;
    if (event.key === "ArrowDown") setActive((index) => Math.min(index + 1, results.length - 1));
    else if (event.key === "ArrowUp") setActive((index) => Math.max(index - 1, 0));
    else if (event.key === "Enter") choose(active);
    else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const result = results[active];
      if (result?.kind !== "channel" || result.group.copies.length < 2) return;
      if (event.key === "ArrowRight" && !result.copy)
        setExpanded((current) => new Set(current).add(result.group.key));
      else if (event.key === "ArrowLeft" && expanded.has(result.group.key)) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(result.group.key);
          return next;
        });
        setActive(
          results.findIndex((row) => row.kind === "channel" && row.key === result.group.key),
        );
        list.current
          ?.querySelector<HTMLElement>(
            `[data-group-row="${results.findIndex((row) => row.kind === "channel" && row.key === result.group.key)}"]`,
          )
          ?.focus();
      } else return;
    } else return;
    event.preventDefault();
  }

  return (
    <div onKeyDown={onKey}>
      <div className="flex items-center gap-3 border-b border-border px-5">
        <Search className="size-5 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-label="Search channels, movies, series and programmes"
          aria-haspopup="tree"
          aria-expanded={results.length > 0}
          aria-controls={results.length > 0 ? resultsId : undefined}
          aria-activedescendant={results[active] ? `${resultsId}-${active}` : undefined}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search channels, movies, series and programmes"
          spellCheck={false}
          className="h-16 flex-1 bg-transparent text-lg text-foreground outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      {debounced.trim() && groups.length > 0 && (
        <div role="status" className="px-5 py-2 text-xs">
          {groups.length} channels · {groups.reduce((sum, group) => sum + group.streams, 0)} streams
        </div>
      )}
      {results.length > 0 && (
        <div
          ref={list}
          id={resultsId}
          role="tree"
          aria-label="Search results"
          className="max-h-[28rem] overflow-y-auto overscroll-contain p-2"
        >
          {results.map((result, index) => {
            if (result.kind === "title") {
              const { title } = result;
              return (
                <button
                  key={title.key}
                  id={`${resultsId}-${index}`}
                  role="treeitem"
                  aria-level={1}
                  aria-selected={index === active}
                  data-index={index}
                  onFocus={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                  className={cn(
                    "flex w-full items-center gap-3.5 rounded-2xl px-3 py-2 text-left hover:bg-white/6",
                    index === active && "bg-white/10 hover:bg-white/10",
                  )}
                >
                  <span className="block h-12 w-8 flex-none overflow-hidden rounded-md">
                    <Artwork
                      url={title.posterUrl}
                      name={title.title}
                      size="thumb"
                      className="text-[0.5rem]"
                    />
                  </span>
                  <span className="min-w-0 flex-1" title={title.name}>
                    <span className="block truncate text-[0.9375rem] text-foreground">
                      {title.title}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[
                        title.kind === "movie" ? "Movie" : "Series",
                        title.year,
                        ...title.tags,
                        sourceOf(title),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              );
            }
            const { channel, group, copy, match } = result;
            const [categoryId] = channel.categoryIds;
            const category = categoryId
              ? categories.get(ownedKey({ subscriptionId: channel.subscriptionId, id: categoryId }))
              : undefined;
            return (
              <LiveResultRow
                id={`${resultsId}-${index}`}
                key={result.key}
                channel={channel}
                group={group}
                copy={copy}
                match={match}
                now={now}
                index={index}
                active={active === index}
                expanded={expanded.has(group.key)}
                category={
                  category ? [category.group, category.title].filter(Boolean).join(" · ") : ""
                }
                onWatch={() => choose(index)}
                onSelect={() => setActive(index)}
                onToggle={() => {
                  setActive(index);
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  });
                }}
              />
            );
          })}
        </div>
      )}
      {debounced.trim() && results.length === 0 && !channels.isPending && (
        <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          No matches
        </div>
      )}
    </div>
  );
}

function LiveResultRow({
  id,
  channel,
  group,
  copy,
  match,
  now,
  index,
  active,
  expanded,
  category,
  onWatch,
  onSelect,
  onToggle,
}: {
  id: string;
  channel: LiveChannel;
  group: LiveSearchGroup;
  copy: boolean;
  match: ProgrammeMatch | null;
  now: number;
  index: number;
  active: boolean;
  expanded: boolean;
  category: string;
  onWatch: () => void;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const nameOf = useSubscriptionNames();
  const favourites = useFavouriteKeys();
  const toggleFavourite = useToggleFavourite();
  const grouped = !copy && group.copies.length > 1;
  const listing = useQuery({ ...queries.listings([channel]), enabled: copy });
  const programme = match?.programme;
  const guide = listing.data?.[ownedKey(channel)];
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={copy ? 2 : 1}
      aria-selected={active}
      aria-expanded={grouped ? expanded : undefined}
      onFocus={onSelect}
      data-index={index}
      className={cn("flex items-center hover:bg-white/6", copy && "ml-8", active && "bg-white/10")}
    >
      <button
        data-group-row={index}
        aria-label={[
          channel.title,
          copy ? nameOf(channel.subscriptionId) : null,
          copy ? channel.number : null,
          copy ? searchQualities([channel]) : null,
        ]
          .filter((part) => part != null && part !== "")
          .join(", ")}
        aria-expanded={grouped ? expanded : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onWatch}
        className="flex min-w-0 flex-1 items-center gap-3.5 px-3 py-2.5 text-left"
      >
        <ChannelLogo channel={channel} className="h-8 w-12 self-start" />
        <span className="min-w-0 flex-1" title={channel.name}>
          <span className="block truncate text-[0.9375rem] text-white">{channel.title}</span>
          <span className="block truncate text-xs">
            {grouped
              ? [
                  category,
                  `${new Set(group.copies.map((copy) => copy.subscriptionId)).size} subscriptions`,
                  `${group.streams} streams`,
                  searchQualities(group.copies),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : [nameOf(channel.subscriptionId), channel.number, searchQualities([channel])]
                  .filter((part) => part !== null && part !== "")
                  .join(" · ")}
          </span>
          {programme ? (
            <span className="block text-xs">
              {programme.start <= now ? "On now" : clockTime(programme.start, now)} ·{" "}
              {programme.title}
              {programme.start <= now ? ` · ${timeLeft(programme, now)}` : ""}
              {programme.description ? ` · ${programme.description}` : ""}
            </span>
          ) : copy && guide?.now ? (
            <span className="block truncate text-xs">
              {guide.now.title}
              {guide.next ? ` · Next ${guide.next.title}` : ""}
            </span>
          ) : null}
        </span>
      </button>
      {grouped ? (
        <button
          aria-label={expanded ? "Hide copies" : "Show copies"}
          aria-expanded={expanded}
          onClick={onToggle}
          className="p-3"
        >
          <ChevronDown className={cn("size-4", !expanded && "-rotate-90")} />
        </button>
      ) : (
        <button
          aria-label={
            favourites.has(ownedKey(channel)) ? "Remove from favourites" : "Add to favourites"
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
          onClick={() => toggleFavourite(channel)}
          className="p-3"
        >
          <Star className={cn("size-4", favourites.has(ownedKey(channel)) && "fill-current")} />
        </button>
      )}
    </div>
  );
}
