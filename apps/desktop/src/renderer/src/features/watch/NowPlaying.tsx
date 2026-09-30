import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  List,
  Maximize,
  Minimize,
  Play,
  Square,
  Star,
  Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { useNow } from "../../lib/clock.ts";
import { channelLine, clockTime, progressOf, techLine, timeLeft } from "../../lib/format.ts";
import { queries, useFavouriteIds, useToggleFavourite } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { player, usePlayer } from "../../player/player.ts";
import { VolumeControl } from "./VolumeControl.tsx";

interface NowPlayingProps {
  channel: LiveChannel;
  categories: ReadonlyMap<string, Category>;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenChannels: () => void;
  /** Switches to the channel above (-1) or below (1) in the current list. */
  onSwitch: (direction: -1 | 1) => void;
}

/** What's on and the playback controls along the bottom of the picture. Fades out when idle. */
export function NowPlayingBar({ visible, ...props }: NowPlayingProps & { visible: boolean }) {
  return (
    <div
      className={cn(
        "no-drag absolute inset-x-0 bottom-0 z-10 flex items-end gap-8 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-10 pt-32 pb-8 transition-opacity duration-300",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <Details {...props} />
      <Controls {...props} />
    </div>
  );
}

/** Programme first: its title, time left and what's next. The channel stands in without a guide. */
function Details({ channel, categories }: NowPlayingProps) {
  const playing = usePlayer(
    (state) => state.phase.kind === "playing" && state.channel?.id === channel.id,
  );
  const listing = useQuery(queries.listings([channel.id])).data?.[channel.id];
  const now = useNow();
  const tech = useTechLine(playing);
  const current = listing?.now ?? null;
  const next = listing?.next ?? null;
  const line = current
    ? [channel.title, `Until ${clockTime(current.stop, now)}`, timeLeft(current, now)]
    : [channelLine(channel, categories), ...channel.tags];
  return (
    <div className="flex min-w-0 items-center gap-5">
      <ChannelLogo channel={channel} className="h-12 w-18" />
      <div className="min-w-0">
        <div className="truncate text-3xl font-semibold tracking-tight">
          {current?.title ?? channel.title}
        </div>
        <div className="mt-1 truncate text-sm text-foreground/85">
          {[...line, tech].filter(Boolean).join(" · ")}
        </div>
        {current && <Progress value={progressOf(current, now)} className="mt-2 w-64" />}
        {next && (
          <div className="mt-1.5 truncate text-sm text-muted-foreground">
            {clockTime(next.start, now)} {next.title}
          </div>
        )}
      </div>
    </div>
  );
}

function Controls({
  channel,
  fullscreen,
  onToggleFullscreen,
  onOpenChannels,
  onSwitch,
}: NowPlayingProps) {
  const active = usePlayer((state) => state.phase.kind !== "idle" && state.phase.kind !== "failed");
  const previous = usePlayer((state) => state.previous);
  const favourite = useFavouriteIds().has(channel.id);
  const toggleFavourite = useToggleFavourite();
  return (
    <div className="ml-auto flex flex-none items-center gap-3">
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
        <Button variant="media" size="icon" aria-label="Channels" onClick={onOpenChannels}>
          <List />
        </Button>
      </Tooltip>
      <Tooltip label={favourite ? "Remove from favourites" : "Add to favourites"}>
        <Button
          variant="media"
          size="icon"
          aria-label={favourite ? "Remove from favourites" : "Add to favourites"}
          aria-pressed={favourite}
          onClick={() => toggleFavourite(channel.id)}
        >
          <Star className={cn(favourite && "fill-current")} />
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
          <Button
            variant="primary"
            size="icon"
            aria-label="Watch"
            onClick={() => player.play(channel)}
          >
            <Play className="size-4 translate-x-px fill-current" />
          </Button>
        </Tooltip>
      )}
      <VolumeControl />
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
