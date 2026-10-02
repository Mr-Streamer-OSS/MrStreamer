// The sliders button beside Sound and CC: one menu for speed, subtitle timing and the subtitles'
// look, each on a page of its own. Speed is for movies and episodes; timing for text subtitles,
// teletext and captions; the look for any subtitles, those drawn as pictures (PGS, DVD, DVB)
// taking only size and position. The player keeps all three, so they hold after a seek or another
// track, and changing them never turns subtitles on or picks another track.
//   Up and Down move, Enter or Right opens a page and Left or Backspace goes back. On the look's
//   rows, Left and Right pick. Escape closes the menu.
import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import type { SubtitleLook } from "@mrstreamer/contracts/preferences";
import { call } from "../../lib/ipc.ts";
import { cn } from "../../lib/utils.ts";
import { player } from "../../player/player.ts";
import {
  setSubtitleDelay,
  setSubtitleLook,
  subtitleDelay,
  TIMING_STEP_S,
  useSubtitleSettings,
} from "../../player/subtitles.ts";
import { SPEEDS, titlePlayer, type Speed } from "../../player/title-player.ts";
import { flash } from "./Flash.tsx";
import { Choice, Menu } from "./TrackMenus.tsx";

type Page = "speed" | "timing" | "look";

const SIZES = [
  { value: "small", short: "S", label: "Small" },
  { value: "medium", short: "M", label: "Medium" },
  { value: "large", short: "L", label: "Large" },
] as const;
const BACKGROUNDS = [
  { value: "box", short: "Box", label: "Box" },
  { value: "shadow", short: "Shadow", label: "Shadow" },
] as const;
const POSITIONS = [
  { value: "low", short: "Low", label: "Low" },
  { value: "high", short: "Higher", label: "Higher" },
] as const;

/** Subtitles drawn as text, which take timing and every look setting. */
const isText = (track: SubtitleTrack) => track.format !== "picture";

/** G and H: text subtitles a tenth of a second earlier or later. Pictures and Off have no timing. */
export function nudgeSubtitles(subtitle: SubtitleTrack | null, direction: -1 | 1): void {
  if (!subtitle || !isText(subtitle)) return;
  setSubtitleDelay(player.element, subtitleDelay() + direction * TIMING_STEP_S);
  const delay = subtitleDelay();
  flash(
    delay === 0
      ? "Subtitles on time"
      : `Subtitles ${Math.abs(delay).toFixed(1)} s ${delay > 0 ? "later" : "earlier"}`,
  );
}

/** < and >: a movie or episode one speed slower or faster. */
export function stepSpeed(direction: -1 | 1): void {
  flash(`Speed ${speedLabel(titlePlayer.stepSpeed(direction))}`);
}

export function PlaybackMenu({
  speed,
  subtitles,
  subtitle,
  open,
  onOpenChange,
}: {
  /** A title's speed and how to change it; live channels play at their own and leave it out. */
  speed?: { readonly value: Speed; readonly onChange: (speed: Speed) => void };
  subtitles: readonly SubtitleTrack[];
  /** The subtitles on screen, or null while they're off. */
  subtitle: SubtitleTrack | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const pages = [
    speed !== undefined && ("speed" as const),
    subtitle && isText(subtitle) && ("timing" as const),
    subtitles.length > 0 && ("look" as const),
  ].filter((page) => page !== false && page !== null);
  if (pages.length === 0) return null;
  return (
    <Menu label="Playback" open={open} onOpenChange={onOpenChange} trigger={<SlidersHorizontal />}>
      <Pages
        pages={pages}
        speed={speed?.value ?? null}
        onSpeed={(next) => {
          speed?.onChange(next);
          onOpenChange(false);
        }}
        // The text settings count while text shows, or could: picture subtitles have their own.
        text={subtitle ? isText(subtitle) : subtitles.some(isText)}
      />
    </Menu>
  );
}

/** The menu's first page and the one opened from it. Mounted each time the menu opens. */
function Pages({
  pages,
  speed,
  onSpeed,
  text,
}: {
  pages: readonly Page[];
  speed: Speed | null;
  onSpeed: (speed: Speed) => void;
  text: boolean;
}) {
  const [opened, setOpened] = useState<Page | null>(null);
  const page = opened && pages.includes(opened) ? opened : null;
  /** The page left last, whose row takes focus back on the first page. */
  const left = useRef<Page | null>(null);
  /**
   * Set while a page change waits to move focus: onto the new page's item for the keyboard, onto
   * the menu for the pointer, so the keys go on working without marking an item.
   */
  const moved = useRef<"keyboard" | "pointer" | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const delay = useSubtitleSettings((state) => state.delay);
  const look = useSubtitleSettings((state) => state.look);

  const go = (next: Page | null, by: "keyboard" | "pointer") => {
    left.current = page;
    moved.current = by;
    setOpened(next);
  };
  // A page opens on its chosen or first item, after Back; the first page on the row just left.
  useLayoutEffect(() => {
    const by = moved.current;
    moved.current = null;
    const root = body.current;
    if (by === "pointer") root?.focus();
    if (by !== "keyboard") return;
    const target =
      (page === null && left.current
        ? root?.querySelector<HTMLElement>(`[data-page="${left.current}"]`)
        : null) ??
      root?.querySelector<HTMLElement>("[data-item][aria-pressed=true]") ??
      root?.querySelector<HTMLElement>("[data-item]:not([data-back])");
    target?.focus();
  }, [page]);

  const pickLook = (next: SubtitleLook) => {
    setSubtitleLook(next);
    void call("preferences.update", { subtitleLook: next }).catch(() => {});
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const opens = target?.dataset["page"];
    if (target?.getAttribute("role") === "radio") {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const options = [...(target.parentElement?.children ?? [])];
        const sibling = options[options.indexOf(target) + (event.key === "ArrowLeft" ? -1 : 1)];
        if (sibling instanceof HTMLElement) {
          sibling.click();
          sibling.focus();
        }
        event.preventDefault();
        return;
      }
    }
    if ((event.key === "ArrowRight" || event.key === "Enter") && opens && !page) {
      go(pages.find((each) => each === opens) ?? null, "keyboard");
    } else if ((event.key === "ArrowLeft" || event.key === "Backspace") && page) {
      go(null, "keyboard");
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <div ref={body} tabIndex={-1} onKeyDown={onKeyDown} className="outline-none">
      {page === null ? (
        <>
          {pages.includes("speed") && speed !== null && (
            <Row
              page="speed"
              label="Speed"
              value={speedLabel(speed)}
              onOpen={(by) => go("speed", by)}
            />
          )}
          {pages.includes("timing") && (
            <Row
              page="timing"
              label="Subtitle timing"
              value={delayLabel(delay)}
              onOpen={(by) => go("timing", by)}
            />
          )}
          {pages.includes("look") && (
            <Row
              page="look"
              label="Subtitle look"
              value={lookLabel(look, text)}
              onOpen={(by) => go("look", by)}
            />
          )}
        </>
      ) : page === "speed" ? (
        <>
          <Back label="Speed" onBack={(by) => go(null, by)} />
          {SPEEDS.map((each) => (
            <Choice key={each} chosen={each === speed} onChoose={() => onSpeed(each)}>
              {speedLabel(each)}
            </Choice>
          ))}
        </>
      ) : page === "timing" ? (
        <>
          <Back label="Subtitle timing" value={delayLabel(delay)} onBack={(by) => go(null, by)} />
          <Item onClick={() => setSubtitleDelay(player.element, delay - TIMING_STEP_S)}>
            Earlier
          </Item>
          <Item onClick={() => setSubtitleDelay(player.element, delay + TIMING_STEP_S)}>Later</Item>
          <Item disabled={delay === 0} onClick={() => setSubtitleDelay(player.element, 0)}>
            Reset
          </Item>
        </>
      ) : (
        <>
          <Back label="Subtitle look" onBack={(by) => go(null, by)} />
          <Segments
            label="Size"
            options={SIZES}
            value={look.size}
            onPick={(size) => pickLook({ ...look, size })}
          />
          {text && (
            <Segments
              label="Background"
              options={BACKGROUNDS}
              value={look.background}
              onPick={(background) => pickLook({ ...look, background })}
            />
          )}
          <Segments
            label="Position"
            options={POSITIONS}
            value={look.position}
            onPick={(position) => pickLook({ ...look, position })}
          />
        </>
      )}
    </div>
  );
}

const itemClass =
  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-white/6 focus-visible:bg-white/10 disabled:opacity-40";

/** A row of the first page: what it sets and its value, opening its page. */
function Row({
  page,
  label,
  value,
  onOpen,
}: {
  page: Page;
  label: string;
  value: string;
  onOpen: (by: "keyboard" | "pointer") => void;
}) {
  return (
    <button
      data-item
      data-page={page}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => onOpen(inputOf(event))}
      className={cn(itemClass, "gap-3")}
    >
      <span className="flex-1">{label}</span>
      <span className="text-muted-foreground">{value}</span>
      <ChevronRight className="size-4 flex-none text-muted-foreground" />
    </button>
  );
}

/** A page's first item, which goes back to the first page. */
function Back({
  label,
  value,
  onBack,
}: {
  label: string;
  value?: string;
  onBack: (by: "keyboard" | "pointer") => void;
}) {
  return (
    <button
      data-item
      data-back
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => onBack(inputOf(event))}
      className={cn(itemClass, "mb-1 font-semibold")}
    >
      <ChevronLeft className="size-4 flex-none" />
      <span className="flex-1">{label}</span>
      {value && <span className="font-normal text-muted-foreground">{value}</span>}
    </button>
  );
}

function Item({
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
      className={cn(itemClass, "pl-7")}
    >
      {children}
    </button>
  );
}

/**
 * A setting with a few values side by side. Only the chosen one is an item, so Up and Down go from
 * row to row, and Left and Right pick within it.
 */
function Segments<V extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly { readonly value: V; readonly short: string; readonly label: string }[];
  value: V;
  onPick: (value: V) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-2 py-1">
      <span className="flex-1">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex gap-1">
        {options.map((option) => (
          <button
            key={option.value}
            role="radio"
            aria-checked={option.value === value}
            aria-label={option.label}
            data-item={option.value === value ? "" : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(option.value)}
            className={cn(
              "min-w-8 rounded-full px-2.5 py-1 text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-ring",
              option.value === value
                ? "bg-white text-black"
                : "text-foreground/80 hover:bg-white/8",
            )}
          >
            {option.short}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A click that Enter or Space made has no click count. */
function inputOf(event: MouseEvent): "keyboard" | "pointer" {
  return event.detail === 0 ? "keyboard" : "pointer";
}

function speedLabel(speed: number): string {
  return `${speed}×`;
}

/** "0.0 s", "+0.3 s" for later, "−0.2 s" for earlier. */
function delayLabel(delay: number): string {
  if (delay === 0) return "0.0 s";
  return `${delay > 0 ? "+" : "−"}${Math.abs(delay).toFixed(1)} s`;
}

/** "Medium, box", "Large, shadow, higher"; picture subtitles have no background. */
function lookLabel(look: SubtitleLook, text: boolean): string {
  const size = SIZES.find((each) => each.value === look.size)?.label ?? "";
  return [size, text && look.background, look.position === "high" && "higher"]
    .filter(Boolean)
    .join(", ");
}
