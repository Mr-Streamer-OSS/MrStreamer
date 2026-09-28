import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils.ts";
import { keepFocus, usePointerIntent } from "./input.ts";

export type CategoryRow =
  | { readonly kind: "all"; readonly count: number }
  | {
      readonly kind: "group";
      readonly group: string;
      readonly count: number;
      readonly open: boolean;
    }
  | {
      readonly kind: "category";
      readonly id: string;
      readonly title: string;
      readonly count: number;
      /** Listed under an open group rather than on its own. */
      readonly nested: boolean;
    };

/** Categories, grouped ones under their country or region. Opening a group lists them underneath. */
export function CategoryColumn({
  rows,
  selectedId,
  highlight,
  focused,
  onPointerHighlight,
  onActivate,
  onOpenMenu,
}: {
  rows: readonly CategoryRow[];
  /** Selected category, or null for all channels. */
  selectedId: string | null;
  highlight: number;
  focused: boolean;
  onPointerHighlight: (index: number) => void;
  onActivate: (row: CategoryRow) => void;
  onOpenMenu: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const pointerMoved = usePointerIntent();
  useEffect(() => {
    list.current?.querySelector(`[data-row="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  return (
    <section className="no-drag flex h-full w-[17rem] flex-col pt-12">
      <header className="flex items-center gap-3 px-5 pb-4">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Menu"
          onClick={onOpenMenu}
          className="-ml-1.5"
        >
          <ChevronLeft />
        </Button>
        <h2 className="text-xl font-semibold tracking-tight">Categories</h2>
      </header>
      <div
        ref={list}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-3 pb-6"
      >
        {rows.map((row, index) => {
          const highlighted = focused && index === highlight;
          const selected =
            (row.kind === "all" && selectedId === null) ||
            (row.kind === "category" && row.id === selectedId);
          return (
            <button
              key={
                row.kind === "category" ? row.id : row.kind === "group" ? `g:${row.group}` : "all"
              }
              data-row={index}
              onMouseMove={(event) => {
                if (pointerMoved(event)) onPointerHighlight(index);
              }}
              onMouseDown={keepFocus}
              onClick={() => onActivate(row)}
              className={cn(
                "flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm",
                row.kind === "category" && row.nested && "pl-6",
                highlighted ? "bg-white/12" : selected && "bg-white/6",
                row.kind === "category" && row.nested
                  ? selected
                    ? "text-white"
                    : "text-foreground/75"
                  : "font-medium text-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {row.kind === "all" ? "All channels" : row.kind === "group" ? row.group : row.title}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {row.count.toLocaleString()}
              </span>
              {row.kind === "group" && (
                <ChevronRight
                  className={cn("size-3.5 text-muted-foreground", row.open && "rotate-90")}
                />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
