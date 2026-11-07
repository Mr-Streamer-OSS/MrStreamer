// Every playback error message closes with the cross at its top right: a channel's or a title's,
// played here or on a receiver, in the window, full screen or the mini player. Closing hides that
// message and nothing else. The failure stays what it is, and so does the way to try again: Watch
// or Play beside the picture, R for a channel and Space for a title. The next failure, as after
// trying again, says its own. A message is known by the failure its player set, so one that was
// closed stays closed while the view renders again, or opens again, and while the receivers listed
// change, as the players keep a lost receiver's failure through those (`outputChanged`). Enter and
// Space on the cross press it, as on any button: the views' keys leave both to it
// through the shared player shortcut guard, so closing never also opens the channel list or
// plays the title again.
import { X } from "lucide-react";
import { t } from "@mrstreamer/core/i18n";
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Button } from "../../components/ui/button.tsx";
import { cn } from "../../lib/utils.ts";
import type { OutputState } from "../../player/output.ts";
import type { PlayerState } from "../../player/player.ts";
import type { TitlePlayerState } from "../../player/title-player.ts";
import type { Note } from "./flash-state.ts";

/** What a closable message is about: a player's failure, a receiver's refusal or a standing note. */
export type Closable =
  | Extract<PlayerState["phase"], { kind: "failed" }>
  | Extract<TitlePlayerState["phase"], { kind: "failed" }>
  | NonNullable<OutputState["refused"]>
  | Note;

const closed = new WeakSet<Closable>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/** Whether the viewer closed the message about `failure`; false while there is none. */
export function useClosed(failure: Closable | null): boolean {
  return useSyncExternalStore(subscribe, () => failure !== null && closed.has(failure));
}

/**
 * The cross at the top right of the message about `failure`. Closed from the keyboard, focus moves
 * on to the view's way to try again (`data-retry`), so it isn't left on nothing. A click leaves
 * focus where it was, as every button's does.
 */
export function CloseMessage({ failure, className }: { failure: Closable; className?: string }) {
  return (
    <Button
      variant="media"
      size="icon-sm"
      aria-label={t("Close message")}
      data-close-message
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
