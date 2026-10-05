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
import { MiniPlayerButton } from "./MiniPlayer.tsx";
import { OutputButton } from "./Output.tsx";
import { PlaybackMenu } from "./PlaybackMenu.tsx";
import { QualityMenu } from "./QualityMenu.tsx";
import { TrackMenus, type TrackMenu } from "./TrackMenus.tsx";
import { useNow } from "../../lib/clock.ts";
import { channelLine, clockTime, progressOf, techLine, timeLeft } from "../../lib/format.ts";
import { qualityName } from "../../lib/quality.ts";
import {
  queries,
  useChooseQuality,
  useFavouriteIds,
  useToggleFavourite,
} from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import type { StreamInfo } from "../../player/engine.ts";
import { useOutput } from "../../player/output.ts";
import { player, usePlayer } from "../../player/player.ts";
import { useChannelQuality } from "./quality.ts";
import { VolumeControl } from "./VolumeControl.tsx";

interface NowPlayingProps {
  channel: LiveChannel;
  /** The sound, subtitle or quality menu open over the controls. */
  menu: TrackMenu;
  onMenu: (menu: TrackMenu) => void;
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

/**
 * Programme first: its title, time left and what's next. The channel stands in without a guide.
 * Once it plays, the line says the provider's quality and what the decoder reports, and when
 * Automatic had to play another stream.
 */
function Details({ channel, categories }: NowPlayingProps) {
  const playing = usePlayer(
    (state) => state.phase.kind === "playing" && state.channel?.id === channel.id,
  );
  const listing = useQuery(queries.listings([channel.id])).data?.[channel.id];
  const now = useNow();
  const tech = techLine(useStreamInfo(playing));
  const quality = useChannelQuality(channel);
  const current = listing?.now ?? null;
  const next = listing?.next ?? null;
  const line = current
    ? [channel.title, `Until ${clockTime(current.stop, now)}`, timeLeft(current, now)]
    : [channelLine(channel, categories)];
  const fellBack = quality.fellBack;
  return (
    <div className="flex min-w-0 items-center gap-5">
      <ChannelLogo channel={channel} className="h-12 w-18" />
      <div className="min-w-0">
        <div className="truncate text-3xl font-semibold tracking-tight">
          {current?.title ?? channel.title}
        </div>
        <div className="mt-1 truncate text-sm text-foreground/85">
          {[...line, playing && quality.playing && qualityName(quality.playing), tech]
            .filter(Boolean)
            .join(" · ")}
          {fellBack && (
            <span className="text-white">
              {" · "}
              {qualityName(fellBack.from)} didn't start, playing {qualityName(fellBack.to)}
            </span>
          )}
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
  menu,
  onMenu,
}: NowPlayingProps) {
  const tracks = usePlayer((state) => state.tracks);
  const audioId = usePlayer((state) => state.audioId);
  const subtitle = usePlayer((state) => state.subtitle);
  const subtitleLoading = usePlayer((state) => state.subtitleLoading);
  const active = usePlayer((state) => state.phase.kind !== "idle" && state.phase.kind !== "failed");
  const previous = usePlayer((state) => state.previous);
  const playing = usePlayer(
    (state) => state.phase.kind === "playing" && state.channel?.id === channel.id,
  );
  const height = useStreamInfo(playing)?.height ?? null;
  const quality = useChannelQuality(channel);
  const chooseQuality = useChooseQuality();
  const favourite = useFavouriteIds().has(channel.id);
  const toggleFavourite = useToggleFavourite();
  // A receiver shows none of a channel's subtitles, and takes none of their settings.
  const remote = useOutput((state) => state.status.output.kind !== "local") && player.onReceiver();
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
      {tracks && (
        <TrackMenus
          audio={tracks.audio}
          audioId={audioId ?? tracks.playing}
          subtitles={tracks.subtitles}
          subtitle={remote ? null : subtitle}
          subtitleNote={subtitleLoading ? "Loading" : null}
          shows={remote ? [] : null}
          hereOnly="Live subtitles play on this computer only."
          open={menu}
          onOpenChange={onMenu}
          onAudio={(id) => player.setAudio(id)}
          onSubtitle={(track) => player.setSubtitle(track)}
        />
      )}
      {tracks && (
        <PlaybackMenu
          subtitles={tracks.subtitles}
          subtitle={subtitle}
          hereOnly={remote}
          open={menu === "playback"}
          onOpenChange={(next) => onMenu(next ? "playback" : null)}
        />
      )}
      {channel.variants.length > 1 && (
        <QualityMenu
          channel={channel}
          chosen={quality.chosen}
          automatic={quality.automatic}
          playing={quality.playing}
          height={height}
          open={menu === "quality"}
          onOpenChange={(open) => onMenu(open ? "quality" : null)}
          onChoose={(variantId) => chooseQuality(channel, variantId)}
        />
      )}
      <VolumeControl />
      <OutputButton
        open={menu === "output"}
        onOpenChange={(open) => onMenu(open ? "output" : null)}
      />
      <MiniPlayerButton />
      <Tooltip label={fullscreen ? "Exit full screen" : "Full screen"}>
        <Button variant="media" size="icon" aria-label="Full screen" onClick={onToggleFullscreen}>
          {fullscreen ? <Minimize /> : <Maximize />}
        </Button>
      </Tooltip>
    </div>
  );
}

/** Resolution, frame rate and audio of the playing stream, read once playback settles. */
function useStreamInfo(playing: boolean): StreamInfo | null {
  const [info, setInfo] = useState<StreamInfo | null>(null);
  useEffect(() => {
    if (!playing) {
      setInfo(null);
      return;
    }
    const read = () => setInfo(player.info());
    read();
    const timer = setTimeout(read, 1500);
    return () => clearTimeout(timer);
  }, [playing]);
  return info;
}
