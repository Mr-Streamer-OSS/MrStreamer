// The sound and subtitle controls of Watch and a playing title: two buttons beside the volume.
// Sound lists the stream's sound tracks. CC shows at a glance whether subtitles are on, and lists
// Off and every subtitle track; C turns the last choice on and off.
import { Popover } from "@base-ui/react/popover";
import { AudioLines, Captions } from "lucide-react";
import type { ReactNode } from "react";
import type { AudioTrack, SubtitleTrack } from "@mrstreamer/contracts/playback";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/utils.ts";

/** Which menu is open over the controls, so Escape closes it before anything else. */
export type TrackMenu = "sound" | "subtitles" | null;

export function TrackMenus({
  audio,
  audioId,
  subtitles,
  subtitle,
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
          {subtitles.map((track) => (
            <Choice
              key={`${track.id}:${track.page}`}
              chosen={track.id === subtitle?.id && track.page === subtitle.page}
              onChoose={() => {
                onSubtitle(track);
                onOpenChange(null);
              }}
            >
              {track.label}
            </Choice>
          ))}
        </Menu>
      )}
    </>
  );
}

function Menu({
  label,
  on = false,
  open,
  onOpenChange,
  trigger,
  children,
}: {
  label: string;
  on?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Tooltip label={label}>
        <Popover.Trigger
          render={
            <Button
              variant={on ? "primary" : "media"}
              size="icon"
              aria-label={label}
              aria-pressed={on}
            />
          }
        >
          {trigger}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={10} className="z-[60]">
          {/* Focus goes back to the button only for the keyboard: a pointer pick would open
              its tooltip, which stays after the controls hide. */}
          <Popover.Popup
            finalFocus={(closeType) => closeType === "keyboard"}
            className="max-h-[60vh] w-[18rem] overflow-y-auto rounded-2xl bg-popover p-2 text-[0.9375rem] shadow-2xl ring-1 ring-white/12 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Choice({
  chosen,
  onChoose,
  children,
}: {
  chosen: boolean;
  onChoose: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-pressed={chosen}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left",
        chosen ? "text-white" : "text-foreground/80 hover:bg-white/6",
      )}
    >
      <span className={cn("size-1.5 flex-none rounded-full", chosen && "bg-white")} />
      <span className="min-w-0">{children}</span>
    </button>
  );
}
