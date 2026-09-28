import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

/** A keyboard key hint, like ⌘K. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-md bg-white/8 px-1.5 font-sans text-[0.6875rem] font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
