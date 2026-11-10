import { Popover } from "@base-ui/react/popover";
import type { ComponentProps, KeyboardEvent, ReactElement, ReactNode } from "react";
import { menuSurface } from "../../../components/ui/menu.ts";
import { cn } from "../../../lib/utils.ts";
import { moveFocus } from "../TrackMenus.tsx";

type Positioner = ComponentProps<typeof Popover.Positioner>;

type Popup = ComponentProps<typeof Popover.Popup>;

/**
 * The multiview's menus and popovers, in the one menu look and arrow navigation of Watch's other
 * menus (`moveFocus` over `data-item` rows). `render` is the trigger button, `trigger` its content.
 * Escape and a click outside close it; focus goes back to the trigger.
 */
export function Pop({
  label,
  open,
  onOpenChange,
  render,
  trigger,
  side,
  align = "end",
  initialFocus,
  onKeyDown,
  className,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  render: ReactElement;
  trigger: ReactNode;
  side: Positioner["side"];
  align?: Positioner["align"];
  initialFocus?: Popup["initialFocus"];
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal>
      <Popover.Trigger render={render}>{trigger}</Popover.Trigger>
      <Popover.Portal className="relative z-[60]">
        <Popover.Positioner side={side} align={align} sideOffset={8} className="z-[60]">
          <Popover.Popup
            aria-label={label}
            initialFocus={initialFocus}
            onKeyDown={(event) => {
              onKeyDown?.(event);

              if (!event.defaultPrevented) moveFocus(event);
            }}
            className={cn(
              menuSurface,
              "text-[0.9375rem] transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
              className,
            )}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
