import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ProgrammeMatch } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { openDetails, useUi } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { useNow } from "../../lib/clock.ts";
import { clockTime, timeLeft } from "../../lib/format.ts";
import { queries, useCategoryMap } from "../../lib/queries.ts";
import { useDebounced } from "../../lib/use-debounced.ts";
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
        <Dialog.Popup className="fixed top-[12vh] left-1/2 z-50 w-[40rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-3xl bg-popover shadow-2xl ring-1 ring-white/10 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <Palette />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A search result: a channel, a movie or series, or a programme on the channel that shows it. */
type Result =
  | { readonly kind: "channel"; readonly channel: LiveChannel }
  | { readonly kind: "title"; readonly title: Title }
  | { readonly kind: "programme"; readonly match: ProgrammeMatch };

/** Channel results listed before the rest. */
const CHANNEL_RESULTS = 20;
/** Movies, and then series, listed after the channels. */
const TITLE_RESULTS = 6;

function Palette() {
  // Mounted each time it opens.
  const [query, setQuery] = useState(() => useUi.getState().searchFrom);
  const debounced = useDebounced(query, 120);
  const channels = useQuery(queries.search(debounced));
  const programmes = useQuery(queries.programmes(debounced));
  const titles = useQuery(queries.titleSearch(debounced));
  const categories = useCategoryMap();
  const now = useNow();
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const results = useMemo((): Result[] => {
    if (!debounced.trim()) return [];
    return [
      ...(channels.data ?? [])
        .slice(0, CHANNEL_RESULTS)
        .map((channel): Result => ({ kind: "channel", channel })),
      ...[
        ...(titles.data?.movies ?? []).slice(0, TITLE_RESULTS),
        ...(titles.data?.series ?? []).slice(0, TITLE_RESULTS),
      ].map((title): Result => ({ kind: "title", title })),
      ...(programmes.data ?? []).map((match): Result => ({ kind: "programme", match })),
    ];
  }, [debounced, channels.data, titles.data, programmes.data]);

  useEffect(() => {
    setActive(0);
    setOpen(null);
  }, [debounced]);

  // Keep the highlighted result in view while moving through the list with the keyboard.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /** Plays a channel, or a programme on now; a later programme shows its description instead. */
  const choose = (index: number) => {
    const result = results[index];
    if (!result) return;
    if (result.kind === "channel") watchChannel(result.channel);
    else if (result.kind === "title") {
      // Details show over the page, so a title playing gives way first, saving how far it got.
      if (useUi.getState().playingTitle) {
        titlePlayer.close();
        useUi.setState({ playingTitle: false });
      }
      openDetails({ kind: result.title.kind, id: result.title.id });
    } else if (result.match.programme.start <= Date.now()) watchChannel(result.match.channel);
    else setOpen((current) => (current === index ? null : index));
  };

  function onKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown") setActive((index) => Math.min(index + 1, results.length - 1));
    else if (event.key === "ArrowUp") setActive((index) => Math.max(index - 1, 0));
    else if (event.key === "Enter") choose(active);
    else return;
    event.preventDefault();
  }

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-5">
        <Search className="size-5 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKey}
          placeholder="Search channels, movies, series and programmes"
          spellCheck={false}
          className="h-16 flex-1 bg-transparent text-lg text-foreground outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      {results.length > 0 && (
        <div ref={list} className="max-h-[28rem] overflow-y-auto overscroll-contain p-2">
          {results.map((result, index) => {
            if (result.kind === "title") {
              const { title } = result;
              return (
                <button
                  key={`${title.kind}:${title.id}`}
                  data-index={index}
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
                      {[title.kind === "movie" ? "Movie" : "Series", title.year, ...title.tags]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              );
            }
            const channel = result.kind === "channel" ? result.channel : result.match.channel;
            const programme = result.kind === "programme" ? result.match.programme : null;
            const category = categories.get(channel.categoryIds[0] ?? "");
            const detail = programme
              ? programme.start <= now
                ? `On now · ${channel.title} · ${timeLeft(programme, now)}`
                : `${clockTime(programme.start, now)} · ${channel.title}`
              : [channel.number, category?.group, category?.title, ...channel.tags]
                  .filter((part) => part != null)
                  .join(" · ");
            return (
              <button
                key={programme ? `${channel.id}:${programme.start}` : channel.id}
                data-index={index}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
                className={cn(
                  "flex w-full items-center gap-3.5 rounded-2xl px-3 py-2.5 text-left hover:bg-white/6",
                  index === active && "bg-white/10 hover:bg-white/10",
                )}
              >
                <ChannelLogo channel={channel} className="h-8 w-12 self-start" />
                <span className="min-w-0 flex-1" title={programme ? undefined : channel.name}>
                  <span className="block truncate text-[0.9375rem] text-foreground">
                    {programme?.title ?? channel.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{detail}</span>
                  {programme && open === index && programme.description && (
                    <span className="mt-1.5 block text-[0.8125rem] leading-relaxed text-muted-foreground">
                      {programme.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {debounced.trim() && results.length === 0 && !channels.isPending && (
        <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          No matches
        </div>
      )}
    </>
  );
}
