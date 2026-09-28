import { House, Search, Settings, Tv } from "lucide-react";
import type { ComponentType } from "react";
import { Logo } from "../../components/Logo.tsx";
import { cn } from "../../lib/utils.ts";
import { keepFocus, usePointerIntent } from "./input.ts";

export type RailItem = "home" | "live" | "search" | "settings";

export const RAIL_ITEMS: readonly {
  id: RailItem;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { id: "home", label: "Home", icon: House },
  { id: "live", label: "Live TV", icon: Tv },
  { id: "search", label: "Search", icon: Search },
  { id: "settings", label: "Settings", icon: Settings },
];

/** The narrow navigation rail, the last guide layer. */
export function Rail({
  highlight,
  focused,
  onPointerHighlight,
  onActivate,
}: {
  highlight: number;
  focused: boolean;
  onPointerHighlight: (index: number) => void;
  onActivate: (item: RailItem) => void;
}) {
  const pointerMoved = usePointerIntent();
  return (
    <nav className="no-drag flex h-full w-[5.5rem] flex-col items-center gap-2 border-r border-border pt-16">
      <Logo className="mb-6 size-7" />
      {RAIL_ITEMS.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            onMouseMove={(event) => {
              if (pointerMoved(event)) onPointerHighlight(index);
            }}
            onMouseDown={keepFocus}
            onClick={() => onActivate(item.id)}
            className={cn(
              "flex w-[4.25rem] flex-col items-center gap-1 rounded-2xl py-2.5 text-[0.6875rem]",
              focused && index === highlight
                ? "bg-white/12 text-white"
                : item.id === "live"
                  ? "text-white"
                  : "text-muted-foreground",
            )}
          >
            <Icon className="size-5" />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
