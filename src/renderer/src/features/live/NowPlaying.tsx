import {
  ChevronDown,
  ChevronUp,
  List,
  Maximize,
  Minimize,
  Play,
  Square,
  Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Category, LiveChannel } from "../../../../shared/library.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { channelLine, techLine } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { player, usePlayer } from "../../player/player.ts";
import { VolumeControl } from "./VolumeControl.tsx";

interface NowPlayingProps {
  channel: LiveChannel;
  categories: ReadonlyMap<string, Category>;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenGuide: () => void;
  onWatch: () => void;
  /** Switches to the channel above (-1) or below (1) in the current category. */
  onSwitch: (direction: -1 | 1) => void;
}

/** Channel details and playback controls along the bottom of the picture. Fades out when idle. */
export function NowPlayingBar({ visible, ...props }: NowPlayingProps & { visible: boolean }) {
  return (
    <div
      className={cn(
        "no-drag absolute inset-x-0 bottom-0 z-10 flex items-end gap-8 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-10 pt-32 pb-8 transition-opacity duration-300",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <Details {...props} />
      <Controls {...props} className="ml-auto" />
    </div>
  );
}

/** The same details and controls, standing in the bar beside the picture on wide windows. */
export function NowPlayingPanel({ width, ...props }: NowPlayingProps & { width: number }) {
  return (
    <aside
      className="no-drag absolute inset-y-0 right-0 z-10 flex flex-col justify-center gap-8 px-10"
      style={{ width }}
    >
      <Details {...props} large />
      <div className="flex flex-col items-start gap-4">
        <Controls {...props} volume={false} className="flex-wrap" />
        <VolumeControl />
      </div>
    </aside>
  );
}

function Details({ channel, categories, large = false }: NowPlayingProps & { large?: boolean }) {
  const playing = usePlayer(
    (state) => state.phase.kind === "playing" && state.channel?.id === channel.id,
  );
  const tech = useTechLine(playing);
  const extra = [...channel.tags, tech].filter(Boolean).join(" · ");
  return (
    <div className={cn("flex min-w-0 gap-5", large ? "flex-col items-start" : "items-center")}>
      <ChannelLogo channel={channel} className={large ? "h-16 w-24" : "h-12 w-18"} />
      <div className="min-w-0">
        <div className="truncate text-sm text-muted-foreground">
          {channelLine(channel, categories)}
          {playing && <span className="text-white"> · Live</span>}
        </div>
        <div
          className={cn(
            "truncate font-semibold tracking-tight",
            large ? "mt-1 text-4xl" : "text-3xl",
          )}
        >
          {channel.title}
        </div>
        {extra && <div className="mt-1.5 truncate text-xs text-muted-foreground">{extra}</div>}
      </div>
    </div>
  );
}

function Controls({
  fullscreen,
  onToggleFullscreen,
  onOpenGuide,
  onWatch,
  onSwitch,
  className,
  volume = true,
}: NowPlayingProps & { className?: string; volume?: boolean }) {
  const active = usePlayer((state) => state.phase.kind !== "idle" && state.phase.kind !== "failed");
  const previous = usePlayer((state) => state.previous);
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex items-center gap-1.5">
        <Tooltip label="Channel up">
          <Button variant="media" size="icon" aria-label="Channel up" onClick={() => onSwitch(-1)}>
            <ChevronUp />
          </Button>
        </Tooltip>
        <Tooltip label="Channel down">
          <Button variant="media" size="icon" aria-label="Channel down" onClick={() => onSwitch(1)}>
            <ChevronDown />
          </Button>
        </Tooltip>
        <Tooltip label={previous ? `Back to ${previous.title}` : "Previous channel"}>
          <Button
            variant="media"
            size="icon"
            aria-label="Previous channel"
            disabled={!previous}
            onClick={() => player.back()}
          >
            <Undo2 />
          </Button>
        </Tooltip>
      </div>
      <Tooltip label="Channels">
        <Button variant="media" size="icon" aria-label="Channels" onClick={onOpenGuide}>
          <List />
        </Button>
      </Tooltip>
      {active ? (
        <Tooltip label="Stop">
          <Button variant="media" size="icon" aria-label="Stop" onClick={() => player.stop()}>
            <Square className="size-3.5 fill-current" />
          </Button>
        </Tooltip>
      ) : (
        <Tooltip label="Watch">
          <Button variant="primary" size="icon" aria-label="Watch" onClick={onWatch}>
            <Play className="size-4 translate-x-px fill-current" />
          </Button>
        </Tooltip>
      )}
      {volume && <VolumeControl />}
      <Tooltip label={fullscreen ? "Exit full screen" : "Full screen"}>
        <Button variant="media" size="icon" aria-label="Full screen" onClick={onToggleFullscreen}>
          {fullscreen ? <Minimize /> : <Maximize />}
        </Button>
      </Tooltip>
    </div>
  );
}

/** Resolution, frame rate and audio of the playing stream, read once playback settles. */
function useTechLine(playing: boolean): string {
  const [line, setLine] = useState("");
  useEffect(() => {
    if (!playing) {
      setLine("");
      return;
    }
    const read = () => setLine(techLine(player.info()));
    read();
    const timer = setTimeout(read, 1500);
    return () => clearTimeout(timer);
  }, [playing]);
  return line;
}
