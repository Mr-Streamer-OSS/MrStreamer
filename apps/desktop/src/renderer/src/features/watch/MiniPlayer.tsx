// What Watch and a playing title draw around the picture while the window is the mini player
// (app/mini-player.ts): the top of the picture moves the window, a word says what's wrong when
// nothing plays, and a row of small controls fades in along the bottom, ending with the way back
// to the full window and Close, which leaves the view.
import { Maximize2, PictureInPicture2, X } from "lucide-react";
import type { ReactNode } from "react";
import { miniPlayer, useMiniPlayer } from "../../app/mini-player.ts";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/utils.ts";

export function MiniControls({
  visible,
  status,
  onClose,
  children,
}: {
  visible: boolean;
  /** Why there's no picture, as a few words; null while it plays. */
  status: string | null;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {/* The top of the picture moves the window, as a title bar would. */}
      <div className="drag absolute inset-x-0 top-0 z-10 h-1/3" />
      {status && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center px-6 text-center text-base font-semibold text-balance [text-shadow:0_1px_4px_rgb(0_0_0/90%)]">
          {status}
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

/** The button beside full screen that shrinks the window; none where windows can't stay on top. */
export function MiniPlayerButton() {
  const available = useMiniPlayer((state) => state.available);
  if (!available) return null;
  return (
    <Tooltip label="Mini player">
      <Button
        variant="media"
        size="icon"
        aria-label="Mini player"
        onClick={() => void miniPlayer.enter()}
      >
        <PictureInPicture2 />
      </Button>
    </Tooltip>
  );
}
