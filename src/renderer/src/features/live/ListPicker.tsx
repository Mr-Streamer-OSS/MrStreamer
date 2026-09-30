// Favourites, recently watched, all channels, then countries and their categories. The guide keeps
// it beside the channels; Watch's channel list swaps to it from its title.
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sameList, type ChannelList } from "../../app/ui-store.ts";
import { cn } from "../../lib/utils.ts";
import type { ListEntry } from "./lists.ts";

/** Which countries are open. The selected list's country starts open. */
export function useOpenGroups(selectedGroup: string | null) {
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(selectedGroup ? [selectedGroup] : []),
  );
  const toggle = (group: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  return { open, toggle };
}

export function ListPicker({
  entries,
  selected,
  highlight,
  onPick,
  onToggle,
  className,
}: {
  entries: readonly ListEntry[];
  selected: ChannelList;
  /** The keyboard selection, or null while the pointer is in use or the keys are elsewhere. */
  highlight: number | null;
  onPick: (list: ChannelList) => void;
  onToggle: (group: string) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Only the keyboard scrolls the picker.
  useEffect(() => {
    if (highlight === null) return;
    box.current?.querySelector(`[data-entry="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  return (
    <div ref={box} className={cn("overflow-y-auto overscroll-contain", className)}>
      {entries.map((entry, index) => {
        const current = entry.kind === "list" && sameList(entry.list, selected);
        return (
          <button
            key={entry.kind === "group" ? `g:${entry.group}` : listKey(entry.list)}
            data-entry={index}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => (entry.kind === "group" ? onToggle(entry.group) : onPick(entry.list))}
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-white/8",
              entry.kind === "list" && entry.nested && "pl-6",
              current && "bg-white/10 text-white",
              highlight === index && "ring-2 ring-white/70 ring-inset",
              entry.kind === "list" && entry.nested && !current
                ? "text-foreground/75"
                : "font-medium",
              index === 3 && "mt-3",
            )}
          >
            <span className="min-w-0 flex-1 truncate">
              {entry.kind === "group" ? entry.group : entry.title}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {entry.count.toLocaleString()}
            </span>
            {entry.kind === "group" && (
              <ChevronRight
                className={cn("size-3.5 text-muted-foreground", entry.open && "rotate-90")}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A stable key for a list. */
export function listKey(list: ChannelList): string {
  return list.kind === "category" ? `c:${list.id}` : list.kind;
}
