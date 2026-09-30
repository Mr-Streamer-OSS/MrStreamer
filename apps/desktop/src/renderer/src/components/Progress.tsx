import { cn } from "../lib/utils.ts";

/** How far a programme has run: a thin white line on a faint track. */
export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn("block h-[3px] overflow-hidden rounded-full bg-white/20", className)}>
      <span className="block h-full bg-white" style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  );
}
