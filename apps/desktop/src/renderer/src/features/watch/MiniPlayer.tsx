// What Watch and a playing title draw around the picture while the window is the mini player
// (app/mini-player.ts): the top of the picture moves the window, a word says what's wrong when
// nothing plays, and a row of small controls fades in along the bottom, ending with the way back
// to the full window and Close, which leaves the view. A failure's word closes with the cross at
// the window's top right, as its message does in the full window.
import { Maximize2, PictureInPicture2, X } from "lucide-react";
import type { ReactNode } from "react";
import { miniPlayer, useMiniPlayer } from "../../app/mini-player.ts";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import { outputs, useOutput } from "../../player/output.ts";
import { CloseMessage, useClosed } from "./CloseMessage.tsx";
import { flash } from "./Flash.tsx";

export function MiniControls({
  visible,
  status,
  failure = null,
  onClose,
  children,
}: {
  visible: boolean;
  /** Why there's no picture, as a few words; null while it plays. */
  status: string | null;
  /** The failure `status` says, whose word the viewer can close. */
  failure?: object | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const closed = useClosed(failure);
  return (
    <>
      {/* The top of the picture moves the window, as a title bar would. */}
      <div className="drag absolute inset-x-0 top-0 z-10 h-1/3" />
      {status && !closed && (
        <div
          data-playback-state=""
          className="pointer-events-none absolute inset-0 z-10 grid place-items-center px-6 text-center text-base font-semibold text-balance [text-shadow:0_1px_4px_rgb(0_0_0/90%)]"
        >
          {status}
          {failure && <CloseMessage failure={failure} className="no-drag top-2 right-2" />}
        </div>
      )}
      <div
        className={cn(
          "no-drag absolute inset-x-0 bottom-0 z-20 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-transparent px-3 pt-10 pb-3 transition-opacity duration-300",
          visible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {children}
        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip label="Leave mini player">
            <Button
              variant="media"
              size="icon-sm"
              aria-label="Leave mini player"
              onClick={() => void miniPlayer.leave()}
            >
              <Maximize2 />
            </Button>
          </Tooltip>
          <Tooltip label="Close">
            <Button variant="media" size="icon-sm" aria-label="Close" onClick={onClose}>
              <X />
            </Button>
          </Tooltip>
        </div>
      </div>
    </>
  );
}

/** What the mini player says while a receiver plays: it is a small picture, and there is none. */
export const MINI_NEEDS_PICTURE = "Mini player needs the picture here";

/**
 * Shrinks the window from Live TV's More menu or a title's bar; absent without stay-on-top support.
 * While a receiver on the network plays it stays, dimmed, and says why it does nothing.
 */
export function MiniPlayerButton({
  inMenu = false,
  onDone,
}: {
  inMenu?: boolean;
  onDone?: () => void;
}) {
  const available = useMiniPlayer((state) => state.available);
  const remote = useOutput((state) => state.status.output.kind !== "local");
  if (!available) return null;
  const elsewhere = remote && outputs.receiver() !== null;
  const enter = () => {
    if (elsewhere) flash(MINI_NEEDS_PICTURE);
    else {
      onDone?.();
      void miniPlayer.enter();
    }
  };
  if (inMenu) {
    return (
      <button
        data-item
        aria-label="Mini player"
        aria-disabled={elsewhere}
        aria-description={elsewhere ? MINI_NEEDS_PICTURE : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-white/6 focus-visible:bg-white/10",
          elsewhere && "opacity-45",
        )}
        onMouseDown={(event) => event.preventDefault()}
        onClick={enter}
      >
        <span className="flex-1">Mini player</span>
        <span aria-hidden className="text-[0.8125rem] text-muted-foreground">
          P
        </span>
      </button>
    );
  }
  return (
    <Tooltip label={elsewhere ? MINI_NEEDS_PICTURE : "Mini player"}>
      <Button
        variant="media"
        size="icon"
        aria-label="Mini player"
        aria-disabled={elsewhere}
        className={cn(elsewhere && "opacity-45")}
        onClick={enter}
      >
        <PictureInPicture2 />
      </Button>
    </Tooltip>
  );
}
