import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

/**
 * A native select drawn as a compact field: the control radius, the row height and the app's
 * chevron, which styles.css draws for `data-slot="select"`. The list it opens and its keys stay
 * the system's, but its options are painted opaque: on Windows they would otherwise inherit the
 * field's translucent background and open a white list with near-white text.
 */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-8 max-w-full appearance-none truncate rounded-lg bg-white/6 pr-8 pl-3 text-sm text-foreground ring-1 ring-input outline-none transition-[box-shadow] focus:ring-2 focus:ring-ring disabled:opacity-60 *:bg-background *:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
