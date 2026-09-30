import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type { MouseEvent } from "react";
import { cn } from "../../lib/utils.ts";

const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-default items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium outline-none transition-[background-color,color,box-shadow,scale] duration-150 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[1.15em]",
  {
    defaultVariants: { size: "default", variant: "secondary" },
    variants: {
      variant: {
        /** The one main action in a group. */
        primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        secondary: "bg-white/10 text-foreground hover:bg-white/16",
        ghost: "text-muted-foreground hover:bg-white/8 hover:text-foreground",
        /** Controls drawn over the picture: dark enough to read on any frame, no blur. */
        media: "bg-black/55 text-white ring-1 ring-white/15 hover:bg-black/75 hover:ring-white/25",
        destructive: "text-destructive ring-1 ring-destructive/40 hover:bg-destructive/10",
      },
      size: {
        sm: "h-8 px-3.5 text-[0.8125rem]",
        default: "h-10 px-5 text-sm",
        lg: "h-12 px-6 text-base",
        "icon-sm": "size-8",
        icon: "size-10",
        "icon-lg": "size-12 text-lg",
      },
    },
  },
);

export type ButtonProps = useRender.ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

/** A rounded button. Pass `render` to draw it as another element. */
export function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const defaultProps = {
    className: cn(buttonVariants({ variant, size }), className),
    type: render ? undefined : ("button" as const),
    "data-slot": "button",
    // A click must not move keyboard focus onto the button: the arrow keys and Enter drive the
    // player, and a focused button would swallow them. Tab still reaches every button.
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
  };
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(defaultProps, props),
  });
}
