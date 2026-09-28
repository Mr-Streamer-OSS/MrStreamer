import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "../../lib/utils.ts";

/** A slim horizontal slider with a round thumb. Values run from 0 to 1. */
export function Slider({
  value,
  onValueChange,
  className,
  label,
}: {
  value: number;
  onValueChange: (value: number) => void;
  className?: string;
  label: string;
}) {
  return (
    <SliderPrimitive.Root
      value={value}
      min={0}
      max={1}
      step={0.01}
      onValueChange={(next) => onValueChange(Array.isArray(next) ? (next[0] ?? 0) : next)}
      // Hand focus back after a drag, so the arrow keys drive the player again, not the slider.
      onValueCommitted={() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }}
      className={cn("w-24", className)}
    >
      <SliderPrimitive.Control className="flex h-6 w-full touch-none items-center">
        <SliderPrimitive.Track className="h-1 w-full rounded-full bg-white/20">
          <SliderPrimitive.Indicator className="rounded-full bg-white" />
          <SliderPrimitive.Thumb
            aria-label={label}
            className="size-3.5 rounded-full bg-white shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
