// Every playback error message closes with the cross at its top right: a channel's or a title's,
// played here or on a receiver, in the window, full screen or the mini player. Closing hides that
// message and nothing else. The failure stays what it is, and so does the way to try again: Watch
// or Play beside the picture, R for a channel and Space for a title. The next failure, as after
// trying again, says its own. A message is known by the failure its player set, so one that was
// closed stays closed while the view renders again, or opens again.
import { X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Button } from "../../components/ui/button.tsx";
import { cn } from "../../lib/utils.ts";

const closed = new WeakSet<object>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the viewer closed the message about `failure`; false while there is none. */
export function useClosed(failure: object | null): boolean {
  return useSyncExternalStore(subscribe, () => failure !== null && closed.has(failure));
}

/**
 * The cross at the top right of the message about `failure`. Closed from the keyboard, focus moves
 * on to the view's way to try again (`data-retry`), so it isn't left on nothing. A click leaves
 * focus where it was, as every button's does.
 */
export function CloseMessage({ failure, className }: { failure: object; className?: string }) {
  return (
    <Button
      variant="media"
      size="icon-sm"
      aria-label="Close message"
      className={cn("pointer-events-auto absolute top-0 right-0", className)}
      onClick={(event) => {
        const focused = document.activeElement === event.currentTarget;
        const view = event.currentTarget.closest("[data-view]");
        closed.add(failure);
        // Drawn at once, so the way to try again is there to take focus.
        flushSync(() => {
          for (const listener of listeners) listener();
        });
        if (focused) view?.querySelector<HTMLElement>("[data-retry]")?.focus();
      }}
    >
      <X />
    </Button>
  );
}
