import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { LiveChannel } from "../../../../shared/library.ts";
import { useUi } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { queries, useCategoryMap } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { player } from "../../player/player.ts";
import { keepFocus, usePointerIntent } from "../live/input.ts";

/** Searches channel names across every category. Opens with ⌘K or Ctrl K. */
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

function Palette() {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 120);
  const results = useQuery(queries.search(debounced));
  const status = useQuery(queries.libraryStatus());
  const categories = useCategoryMap();
  const [active, setActive] = useState(0);
  const pointerMoved = usePointerIntent();
  const items = debounced.trim() ? (results.data ?? []) : [];

  useEffect(() => setActive(0), [debounced]);

  // Keep the highlighted result in view while moving through the list with the keyboard.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (channel: LiveChannel | undefined) => {
    if (!channel) return;
    useUi.setState({ searchOpen: false, settings: null, view: "live" });
    player.play(channel);
  };

  function onKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown") setActive((index) => Math.min(index + 1, items.length - 1));
    else if (event.key === "ArrowUp") setActive((index) => Math.max(index - 1, 0));
    else if (event.key === "Enter") choose(items[active]);
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
          placeholder={`Search ${status.data?.channelCount.toLocaleString() ?? ""} channels`}
          spellCheck={false}
          className="h-16 flex-1 bg-transparent text-lg text-foreground outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      {items.length > 0 && (
        <div ref={list} className="max-h-[26rem] overflow-y-auto overscroll-contain p-2">
          {items.map((channel, index) => {
            const category = categories.get(channel.categoryIds[0] ?? "");
            return (
              <button
                key={channel.id}
                data-index={index}
                onMouseMove={(event) => {
                  if (pointerMoved(event)) setActive(index);
                }}
                onMouseDown={keepFocus}
                onClick={() => choose(channel)}
                className={cn(
                  "flex w-full items-center gap-3.5 rounded-2xl px-3 py-2.5 text-left",
                  index === active && "bg-white/10",
                )}
              >
                <ChannelLogo channel={channel} className="h-8 w-12" />
                <span className="min-w-0 flex-1" title={channel.name}>
                  <span className="block truncate text-[0.9375rem] text-foreground">
                    {channel.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[channel.number, category?.group, category?.title, ...channel.tags]
                      .filter((part) => part != null)
                      .join(" · ")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {debounced.trim() && (
        <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          {items.length === 200 ? "Top 200 matches" : `${items.length} matches`}
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
