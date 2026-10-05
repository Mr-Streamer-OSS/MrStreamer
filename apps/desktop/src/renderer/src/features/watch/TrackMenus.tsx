// The sound and subtitle controls of Watch and a playing title: two buttons beside the volume.
// Sound lists the stream's sound tracks. CC shows at a glance whether subtitles are on, and lists
// Off and every subtitle track; C turns the last choice on and off.
import { Popover } from "@base-ui/react/popover";
import { AudioLines, Captions } from "lucide-react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { AudioTrack, SubtitleFormat, SubtitleTrack } from "@mrstreamer/contracts/playback";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/utils.ts";

/** Which menu is open over the controls, so Escape closes it before anything else. */
export type TrackMenu = "sound" | "subtitles" | "playback" | "quality" | "output" | null;

export function TrackMenus({
  audio,
  audioId,
  subtitles,
  subtitle,
  subtitleNote = null,
  shows = null,
  hereOnly = null,
  open,
  onOpenChange,
  onAudio,
  onSubtitle,
}: {
  audio: readonly AudioTrack[];
  /** The sound track playing; null when the stream's own plays. */
  audioId: number | null;
  subtitles: readonly SubtitleTrack[];
  subtitle: SubtitleTrack | null;
  /** What to say beside the chosen subtitle track, such as that it is still loading. */
  subtitleNote?: string | null;
  /**
   * While a receiver on the network plays: the kinds of subtitles it shows. The others stay
   * listed, marked as playing here only. Null while it plays here, which shows them all.
   */
  shows?: readonly SubtitleFormat[] | null;
  /** Why some subtitles play here only, said at the foot of their menu. */
  hereOnly?: string | null;
  open: TrackMenu;
  onOpenChange: (open: TrackMenu) => void;
  onAudio: (id: number) => void;
  onSubtitle: (track: SubtitleTrack | null) => void;
}) {
  const playing = audioId ?? audio.find((track) => track.default)?.id ?? audio[0]?.id;
  return (
    <>
      {audio.length > 1 && (
        <Menu
          label="Sound"
          open={open === "sound"}
          onOpenChange={(next) => onOpenChange(next ? "sound" : null)}
          trigger={<AudioLines />}
        >
          {audio.map((track) => (
            <Choice
              key={track.id}
              chosen={track.id === playing}
              onChoose={() => {
                onAudio(track.id);
                onOpenChange(null);
              }}
            >
              {track.label}
            </Choice>
          ))}
        </Menu>
      )}
      {subtitles.length > 0 && (
        <Menu
          label={subtitle ? "Subtitles on" : "Subtitles"}
          on={subtitle !== null}
          open={open === "subtitles"}
          onOpenChange={(next) => onOpenChange(next ? "subtitles" : null)}
          trigger={<Captions />}
        >
          <Choice
            chosen={subtitle === null}
            onChoose={() => {
              onSubtitle(null);
              onOpenChange(null);
            }}
          >
            Off
          </Choice>
          {subtitles.map((track) => {
            const chosen = track.id === subtitle?.id && track.page === subtitle.page;
            const elsewhere = shows !== null && !shows.includes(track.format);
            return (
              <Choice
                key={`${track.id}:${track.page}`}
                chosen={chosen}
                disabled={elsewhere}
                note={elsewhere ? "Here only" : chosen ? subtitleNote : null}
                onChoose={() => {
                  onSubtitle(track);
                  onOpenChange(null);
                }}
              >
                {track.label}
              </Choice>
            );
          })}
          {shows !== null && subtitles.some((track) => !shows.includes(track.format)) && (
            <MenuNote>{hereOnly}</MenuNote>
          )}
        </Menu>
      )}
    </>
  );
}

/**
 * A menu over the player's controls, opened by a button. While it's open a click elsewhere only
 * closes it, so the same click can't also pause, skip or change channel. Opened by the keyboard,
 * it starts on the item chosen, by the pointer on none; Up and Down move between items
 * (`data-item`), Home and End to the first and last.
 */
export function Menu({
  label,
  on = false,
  text = false,
  open,
  onOpenChange,
  trigger,
  children,
}: {
  label: string;
  on?: boolean;
  /** The button holds words rather than an icon. */
  text?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal>
      <Tooltip label={label}>
        <Popover.Trigger
          render={
            <Button
              variant={on ? "primary" : "media"}
              size={text ? "default" : "icon"}
              aria-label={label}
              aria-pressed={on}
              className={cn(text && "px-3.5 font-semibold")}
            />
          }
        >
          {trigger}
        </Popover.Trigger>
      </Tooltip>
      {/* Over Watch, so the backdrop that takes clicks outside the menu covers the controls too. */}
      <Popover.Portal className="relative z-[60]">
        <Popover.Positioner side="top" align="end" sideOffset={10} className="z-[60]">
          {/* Focus goes back to the button only for the keyboard: a pointer pick would open
              its tooltip, which stays after the controls hide. */}
          <Popover.Popup
            ref={popup}
            aria-label={label}
            initialFocus={(openType) =>
              (openType === "keyboard" && popup.current && chosenItem(popup.current)) ||
              popup.current
            }
            finalFocus={(closeType) => closeType === "keyboard"}
            onKeyDown={(event) => {
              if (!event.defaultPrevented) moveFocus(event);
            }}
            className="max-h-[60vh] w-[18rem] overflow-y-auto rounded-2xl bg-popover p-2 text-[0.9375rem] shadow-2xl ring-1 ring-white/12 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The item a menu opens on: the one chosen, else the first. */
function chosenItem(popup: HTMLElement): HTMLElement | null {
  return (
    popup.querySelector<HTMLElement>("[data-item][aria-pressed=true]") ??
    popup.querySelector<HTMLElement>("[data-item]")
  );
}

/** Up, Down, Home and End move focus between a menu's items, round from the last to the first. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>("[data-item]:not(:disabled)"),
  ];
  const at = items.findIndex((item) => item === document.activeElement);
  const target =
    event.key === "ArrowDown"
      ? (items[at + 1] ?? items[0])
      : event.key === "ArrowUp"
        ? (items[at - 1] ?? items.at(-1))
        : event.key === "Home"
          ? items[0]
          : event.key === "End"
            ? items.at(-1)
            : undefined;
  if (!target) return;
  event.preventDefault();
  target.focus();
}

/** A line of small text at the foot of a menu, saying what its rows can't. */
export function MenuNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="px-2 pt-1.5 pb-1 text-[0.8125rem] leading-snug text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * One of a menu's choices, marked when chosen, with a word at its end when there is one to say.
 * A `disabled` one stays listed, dimmed, and can't be chosen.
 */
export function Choice({
  chosen,
  disabled = false,
  note = null,
  onChoose,
  children,
}: {
  chosen: boolean;
  disabled?: boolean;
  note?: string | null;
  onChoose: () => void;
  children: ReactNode;
}) {
  return (
    <button
      data-item
      aria-pressed={chosen}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:bg-white/10 disabled:opacity-40",
        chosen ? "text-white" : "text-foreground/80 enabled:hover:bg-white/6",
      )}
    >
      <span className={cn("size-1.5 flex-none rounded-full", chosen && "bg-white")} />
      <span className="min-w-0">{children}</span>
      {note && (
        <span className="ml-auto flex-none text-[0.8125rem] text-muted-foreground">{note}</span>
      )}
    </button>
  );
}
