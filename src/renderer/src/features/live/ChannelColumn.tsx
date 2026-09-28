import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { LiveChannel } from "../../../../shared/library.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { cn } from "../../lib/utils.ts";
import { keepFocus, usePointerIntent } from "./input.ts";

const ROW_REM = 3.75;

/** The channels of the selected category. One highlight follows the keyboard or the pointer. */
export function ChannelColumn({
  channels,
  heading,
  subheading,
  highlight,
  playingId,
  focused,
  rem,
  width,
  onPointerHighlight,
  onActivate,
  onOpenCategories,
  onClose,
}: {
  channels: readonly LiveChannel[];
  heading: string;
  /** The category's group, when it has one. */
  subheading: string | null;
  highlight: number;
  playingId: string | null;
  focused: boolean;
  rem: number;
  width: number | string;
  onPointerHighlight: (index: number) => void;
  onActivate: (channel: LiveChannel) => void;
  onOpenCategories: () => void;
  /** Shown as a close button when the guide covers the picture. */
  onClose?: (() => void) | undefined;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pointerMoved = usePointerIntent();
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_REM * rem,
    overscan: 12,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rem, virtualizer]);

  useEffect(() => {
    if (highlight >= 0) virtualizer.scrollToIndex(highlight, { align: "auto" });
  }, [highlight, virtualizer]);

  return (
    <section className="no-drag flex h-full flex-col pt-16" style={{ width }}>
      <header className="flex items-end gap-3 px-5 pb-4">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Categories"
          onClick={onOpenCategories}
          className="mb-0.5 -ml-1.5"
        >
          <ChevronLeft />
        </Button>
        <div className="min-w-0 flex-1">
          {subheading && <div className="truncate text-xs text-muted-foreground">{subheading}</div>}
          <h2 className="truncate text-xl font-semibold tracking-tight">{heading}</h2>
        </div>
        <span className="mb-1 text-xs text-muted-foreground tabular-nums">
          {channels.length.toLocaleString()}
        </span>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={onClose}
            className="mb-0.5"
          >
            <X />
          </Button>
        )}
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-6">
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const channel = channels[item.index];
            if (!channel) return null;
            const playing = channel.id === playingId;
            const highlighted = focused && item.index === highlight;
            return (
              <button
                key={channel.id}
                onMouseMove={(event) => {
                  if (pointerMoved(event)) onPointerHighlight(item.index);
                }}
                onMouseDown={keepFocus}
                onClick={() => onActivate(channel)}
                className={cn(
                  "absolute inset-x-0 flex items-center gap-3.5 rounded-2xl px-3 text-left",
                  highlighted ? "bg-white/12" : playing && "bg-white/6",
                )}
                style={{ top: item.start, height: item.size - 4 }}
              >
                <span className="w-9 flex-none text-right text-xs text-muted-foreground tabular-nums">
                  {channel.number ?? ""}
                </span>
                <ChannelLogo channel={channel} className="h-8 w-12" />
                <span className="min-w-0 flex-1" title={channel.name}>
                  <span
                    className={cn(
                      "block truncate text-[0.9375rem]",
                      playing ? "font-semibold text-white" : "text-foreground/90",
                    )}
                  >
                    {channel.title}
                  </span>
                  {channel.tags.length > 0 && (
                    <span className="block text-[0.6875rem] tracking-wide text-muted-foreground">
                      {channel.tags.join(" · ")}
                    </span>
                  )}
                </span>
                {playing && (
                  <span className="size-2 flex-none rounded-full bg-white" aria-label="Playing" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
