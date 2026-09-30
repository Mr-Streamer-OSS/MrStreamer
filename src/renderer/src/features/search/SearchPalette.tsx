import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ProgrammeMatch } from "../../../../shared/guide.ts";
import type { LiveChannel } from "../../../../shared/library.ts";
import { useUi } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { useNow } from "../../lib/clock.ts";
import { clockTime, timeLeft } from "../../lib/format.ts";
import { queries, useCategoryMap } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { watchChannel } from "../live/GuidePage.tsx";

/**
 * Searches channel names across every category, then programmes on now and later today. Opens
 * with ⌘K or Ctrl K.
 */
export function SearchPalette() {
  const open = useUi((state) => state.searchOpen);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => useUi.setState({ searchOpen: next })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/70 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed top-[12vh] left-1/2 z-50 w-[40rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-3xl bg-popover shadow-2xl ring-1 ring-white/10 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <Dialog.Title className="sr-only">Search channels</Dialog.Title>
          <Palette />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A search result: a channel, or a programme on the channel that shows it. */
type Result =
  | { readonly kind: "channel"; readonly channel: LiveChannel }
  | { readonly kind: "programme"; readonly match: ProgrammeMatch };

/** Channel results listed before the programmes. */
const CHANNEL_RESULTS = 20;

function Palette() {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 120);
  const channels = useQuery(queries.search(debounced));
  const programmes = useQuery(queries.programmes(debounced));
  const status = useQuery(queries.libraryStatus());
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
      ...(programmes.data ?? []).map((match): Result => ({ kind: "programme", match })),
    ];
  }, [debounced, channels.data, programmes.data]);

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
    else if (result.match.programme.start <= Date.now()) watchChannel(result.match.channel);
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
          placeholder={`Search ${status.data?.channelCount.toLocaleString() ?? ""} channels and programmes`}
          spellCheck={false}
          className="h-16 flex-1 bg-transparent text-lg text-foreground outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      {results.length > 0 && (
        <div ref={list} className="max-h-[28rem] overflow-y-auto overscroll-contain p-2">
          {results.map((result, index) => {
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

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
