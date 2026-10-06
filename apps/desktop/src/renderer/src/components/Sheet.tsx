import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/**
 * A sheet over the page it was opened from, which stays in view behind it: a title's details, or
 * what was kept of a saved one. It rises from the foot of the window to under the top bar, or
 * only as far as its content needs when `short`. Its content names it with a `Dialog.Title`.
 * Escape, Close and a click outside call `onClose`.
 */
export function Sheet({
  onClose,
  short = false,
  children,
}: {
  onClose: () => void;
  short?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-20 bg-black/65 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed inset-x-[max(1.5rem,calc((100vw-68rem)/2))] bottom-[var(--receiver-bar,0px)] z-20 overflow-y-auto overscroll-contain rounded-t-3xl bg-[#0b0b0c] shadow-2xl ring-1 ring-white/10 outline-none transition-[opacity,translate] duration-200 data-ending-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:translate-y-4 data-starting-style:opacity-0",
            short ? "max-h-[calc(100%-3.75rem-var(--receiver-bar,0px))]" : "top-[3.75rem]",
          )}
        >
          {children}
          {/* After the content, so focus starts on its main action rather than on Close. */}
          <Dialog.Close
            aria-label="Close"
            className="absolute top-4 right-4 z-10 grid size-9 place-items-center rounded-full bg-black/60 text-white ring-1 ring-white/20 hover:bg-black/80"
          >
            <X className="size-4" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
