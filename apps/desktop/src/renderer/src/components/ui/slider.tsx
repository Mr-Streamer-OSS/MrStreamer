import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { useRef, type FocusEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

/** Blurs the thumb of `control` when it has focus, and nothing outside it. */
function blurThumb(control: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && control.contains(active)) active.blur();
}

/**
 * A slider's control, which hands focus back after a pointer press so the player's keys work
 * again once the pointer lets go. Base UI focuses the thumb a frame after the press, which can be
 * after a quick click has ended. So the thumb is blurred at the release or, when the release came
 * first, as that focus arrives. Focus the keyboard gave the thumb stays, and so does focus that
 * went elsewhere during the press.
 *
 * A finger sends a touch event after each pointer event, and Base UI answers both: the touch one
 * moves the slider and focuses the thumb at once, the pointer one would focus it again a frame
 * later, unseen here when the thumb has focus by then. So a finger's press is left to Base UI's
 * touch handling alone, and its focus is there when the finger lifts.
 *
 * The press is this control's own: it is forgotten when the control goes, as is the focus Base UI
 * still owed it.
 */
export function SliderControl({ className, children }: { className: string; children: ReactNode }) {
  // "down" while pressed and the thumb's focus is still to come, "focused" once the thumb has
  // had it, "owed" once let go before it came.
  const press = useRef<"down" | "focused" | "owed" | null>(null);
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (press.current === "focused") {
      blurThumb(event.currentTarget);
      press.current = null;
    } else if (press.current === "down") press.current = "owed";
  };
  return (
    <SliderPrimitive.Control
      className={className}
      onPointerDown={(event) => {
        // The presses Base UI takes: the left button, and nothing a child refused.
        if (event.button !== 0 || event.defaultPrevented) return;
        // A thumb that has focus already is sent none.
        press.current = event.currentTarget.contains(document.activeElement) ? "focused" : "down";
        if (event.pointerType === "touch") event.preventBaseUIHandler();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      // On the control, where the thumb's focus arrives once Base UI's own handler has run.
      onFocus={(event: FocusEvent<HTMLDivElement>) => {
        if (press.current === "down") press.current = "focused";
        else if (press.current === "owed") {
          press.current = null;
          blurThumb(event.currentTarget);
        }
      }}
    >
      {children}
    </SliderPrimitive.Control>
  );
}

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
      className={cn("w-24", className)}
    >
      <SliderControl className="flex h-6 w-full touch-none items-center">
        <SliderPrimitive.Track className="h-1 w-full rounded-full bg-white/20">
          <SliderPrimitive.Indicator className="rounded-full bg-white" />
          <SliderPrimitive.Thumb
            aria-label={label}
            className="size-3.5 rounded-full bg-white shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </SliderPrimitive.Track>
      </SliderControl>
    </SliderPrimitive.Root>
  );
}
