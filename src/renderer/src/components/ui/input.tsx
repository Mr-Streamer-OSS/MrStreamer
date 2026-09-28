import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      spellCheck={false}
      className={cn(
        "h-12 w-full rounded-xl bg-white/6 px-4 text-base text-foreground ring-1 ring-input outline-none transition-[box-shadow,background-color] placeholder:text-muted-foreground/70 focus:bg-white/8 focus:ring-2 focus:ring-ring",
        className,
      )}
      {...props}
    />
  );
}
