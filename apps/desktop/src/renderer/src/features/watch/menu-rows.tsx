// Shared controls for the player's settings menus.
import type { KeyboardEvent, ReactNode } from "react";
import { t, type PlainKey } from "@mrstreamer/core/i18n";
import { cn } from "../../lib/utils.ts";

/** A menu choice's value, visible word and accessible name. */
export interface Segment<V extends string> {
  readonly value: V;
  readonly short: PlainKey;
  readonly label: PlainKey;
}

/** A small action written as words, beside the value it acts on. */
export function TextButton({
  disabled = false,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      data-item
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="rounded px-1 text-[0.8125rem] underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** A round − or + beside a value; `disabled` at the end of its range. */
export function Step({
  label,
  item = true,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  item?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      data-item={item ? "" : undefined}
      aria-label={label}
      aria-disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className="size-7 rounded-full bg-white/10 outline-none enabled:hover:bg-white/16 focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * A setting with a few values side by side. Only the chosen one is an item, so Up and Down go from
 * row to row, and Left and Right pick within it.
 */
export function Segments<V extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly Segment<V>[];
  value: V;
  onPick: (value: V) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const radios = [...event.currentTarget.children];
    const at = radios.findIndex((radio) => radio === event.target);
    const sibling = radios[at + (event.key === "ArrowLeft" ? -1 : 1)];

    if (sibling instanceof HTMLElement) {
      sibling.click();
      sibling.focus();
    }

    event.preventDefault();
  };

  return (
    <div className="flex items-center gap-3 py-1">
      <span className="flex-1">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex gap-1" onKeyDown={onKeyDown}>
        {options.map((option) => (
          <button
            key={option.value}
            role="radio"
            aria-checked={option.value === value}
            aria-label={t(option.label)}
            data-item={option.value === value ? "" : undefined}
            // Tab stops on the chosen one too: the others are Left and Right from it.
            tabIndex={option.value === value ? 0 : -1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(option.value)}
            className={cn(
              "min-w-8 rounded-full px-2.5 py-1 text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-ring",
              option.value === value
                ? "bg-white text-black"
                : "text-foreground/80 hover:bg-white/8",
            )}
          >
            {t(option.short)}
          </button>
        ))}
      </div>
    </div>
  );
}
