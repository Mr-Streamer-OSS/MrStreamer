// Playing a movie or an episode: the picture fills the window, with the title, a scrubber and the
// controls along the bottom, fading when idle. Sound and CC open the file's tracks, and the sliders
// its speed and the subtitles' timing and look; a series offers its next episode, only when asked.
// Back returns to where the title was opened.
//   Space or K pauses, Left and Right skip 10 seconds, Up and Down change the volume, F is full
//   screen, M mutes, C turns subtitles on or off, N plays the next episode, G and H move subtitles
//   earlier or later, < and > play slower or faster. While a menu is open, keys are its own:
//   Escape closes it, then leaves full screen, then goes back.
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { useQuery } from "@tanstack/react-query";
import { Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, SkipForward } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Episode, SeriesDetails } from "@mrstreamer/contracts/ondemand";
import { hasModifier, isTyping } from "../../app/platform.ts";
import { useUi } from "../../app/ui-store.ts";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { describeError } from "../../lib/errors.ts";
import { queries } from "../../lib/queries.ts";
import { clock, episodeLabel, episodeNow, nextEpisode, playTitle } from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";
import { WINDOW_BAR } from "../../../../shared/window-bar.ts";
import { Picture } from "../../player/Picture.tsx";
import { player, type PlaybackProblem } from "../../player/player.ts";
import { titlePlayer, useTitlePlayer } from "../../player/title-player.ts";
import { Flash } from "../watch/Flash.tsx";
import { useFullscreen, useWake } from "../watch/layout.ts";
import { nudgeSubtitles, PlaybackMenu, stepSpeed } from "../watch/PlaybackMenu.tsx";
import { TrackMenus, type TrackMenu } from "../watch/TrackMenus.tsx";
import { VolumeControl } from "../watch/VolumeControl.tsx";

/** Controls fade out after this long without input. */
const IDLE_MS = 3000;
const SKIP_S = 10;

/** Leaves the title, saving how far it got, back to its details or the page. */
function leave(): void {
  titlePlayer.close();
  useUi.setState({ playingTitle: false });
}

export function TitleWatch() {
  const [awake, wake] = useWake(IDLE_MS);
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const now = useTitlePlayer((state) => state.now);
  const phase = useTitlePlayer((state) => state.phase);
  const [menu, setMenu] = useState<TrackMenu>(null);
  const next = useNextEpisode();
  const playNext = () => {
    if (next) playTitle(episodeNow(next.series, next.episode), 0);
  };

  // A title plays with sound, at the viewer's volume.
  useEffect(() => {
    player.setAudible(true);
    return () => player.setAudible(false);
  }, []);

  // Nothing open any more, as after a live channel took over: back to the page.
  useEffect(() => {
    if (!now) useUi.setState({ playingTitle: false });
  }, [now]);

  // The key handler reads the latest render through a ref; see WatchScreen.
  const latest = useRef({ menu, toggleFullscreen, wake, playNext });
  latest.current = { menu, toggleFullscreen, wake, playNext };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (event.defaultPrevented || isTyping(event) || hasModifier(event) || event.isComposing)
        return;
      if (ui.searchOpen || ui.settings || ui.updateDialog || !ui.playingTitle) return;
      const current = latest.current;
      current.wake();
      // The menu's own keys: Escape closes it, and focus goes back to its button.
      if (current.menu) return;
      switch (event.key) {
        case " ":
        case "k":
          titlePlayer.togglePause();
          break;
        case "ArrowLeft":
          titlePlayer.skip(-SKIP_S);
          break;
        case "ArrowRight":
          titlePlayer.skip(SKIP_S);
          break;
        case "ArrowUp":
        case "ArrowDown": {
          const { volume } = player.state();
          player.setVolume(volume + (event.key === "ArrowUp" ? 0.05 : -0.05));
          break;
        }
        case "f":
          current.toggleFullscreen();
          break;
        case "m":
          player.toggleMute();
          break;
        case "c":
          titlePlayer.toggleSubtitles();
          break;
        case "n":
          current.playNext();
          break;
        case "g":
        case "G":
        case "h":
        case "H":
          nudgeSubtitles(titlePlayer.state().subtitle, event.key.toLowerCase() === "g" ? -1 : 1);
          break;
        case "<":
        case ">":
          stepSpeed(event.key === "<" ? -1 : 1);
          break;
        case "Escape":
          if (document.fullscreenElement) void document.exitFullscreen();
          else leave();
          break;
        default:
          return;
      }
      event.preventDefault();
      // Handled here only: the layer underneath, shown again by this key, must not take it too.
      event.stopPropagation();
    }
    // Before tooltips and popovers see the key, which would otherwise keep Escape to themselves.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (!now) return null;
  const controlsVisible = awake || phase.kind !== "playing" || menu !== null;
  const ended = phase.kind === "ended";
  return (
    <div
      data-view="title"
      data-controls={controlsVisible ? "" : undefined}
      onMouseMove={wake}
      className={cn(
        "fixed inset-0 z-30 overflow-hidden bg-black",
        !controlsVisible && "cursor-none",
      )}
    >
      {/* In a window the picture starts below the bar, so the bar never draws on it. */}
      <Picture
        active
        fit="contain"
        className="absolute inset-x-0 bottom-0"
        style={{ top: fullscreen ? 0 : WINDOW_BAR.height }}
        onClick={() => titlePlayer.togglePause()}
        onDoubleClick={toggleFullscreen}
      />
      {!fullscreen && (
        <div
          className={cn(
            "absolute inset-x-0 top-0 z-30 transition-opacity duration-300",
            controlsVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <WindowBar onBack={leave} />
        </div>
      )}
      {ended && next ? (
        <NextUp next={next} onNext={playNext} />
      ) : (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <State next={next ? playNext : null} />
        </div>
      )}
      {!(ended && next) && (
        <div
          className={cn(
            "no-drag absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-10 pt-28 pb-7 transition-opacity duration-300",
            controlsVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <div className="mb-3 min-w-0">
            <div className="truncate text-2xl font-semibold tracking-tight">{now.name}</div>
            {now.detail && <div className="truncate text-sm text-foreground/85">{now.detail}</div>}
          </div>
          <Scrubber />
          <div className="mt-3 flex items-center gap-2">
            <Tooltip label="Back 10 seconds">
              <Button
                variant="media"
                size="icon"
                aria-label="Back 10 seconds"
                onClick={() => titlePlayer.skip(-SKIP_S)}
              >
                <RotateCcw />
              </Button>
            </Tooltip>
            <PlayPause />
            <Tooltip label="Forward 10 seconds">
              <Button
                variant="media"
                size="icon"
                aria-label="Forward 10 seconds"
                onClick={() => titlePlayer.skip(SKIP_S)}
              >
                <RotateCw />
              </Button>
            </Tooltip>
            <div className="ml-auto flex items-center gap-2">
              <Tracks menu={menu} onMenu={setMenu} />
              {next && (
                <Button variant="media" onClick={playNext}>
                  <SkipForward />
                  Next episode
                </Button>
              )}
              <VolumeControl />
              <Tooltip label={fullscreen ? "Exit full screen" : "Full screen"}>
                <Button
                  variant="media"
                  size="icon"
                  aria-label="Full screen"
                  onClick={toggleFullscreen}
                >
                  {fullscreen ? <Minimize /> : <Maximize />}
                </Button>
              </Tooltip>
            </div>
          </div>
        </div>
      )}
      <Flash />
    </div>
  );
}

/** The episode after the playing one, with its series; null for movies and last episodes. */
function useNextEpisode(): { series: SeriesDetails; episode: Episode } | null {
  const now = useTitlePlayer((state) => state.now);
  const title = now?.title;
  const series = useQuery({
    ...queries.details("series", title?.kind === "episode" ? title.seriesId : ""),
    enabled: title?.kind === "episode",
  });
  if (title?.kind !== "episode" || series.data?.kind !== "series") return null;
  const episode = nextEpisode(series.data, title);
  return episode ? { series: series.data, episode } : null;
}

function PlayPause() {
  const phase = useTitlePlayer((state) => state.phase);
  const paused = phase.kind !== "playing";
  const label = phase.kind === "ended" ? "Play again" : paused ? "Play" : "Pause";
  return (
    <Tooltip label={label}>
      <Button
        variant="primary"
        size="icon"
        aria-label={label}
        onClick={() => titlePlayer.togglePause()}
      >
        {paused ? (
          <Play className="size-4 translate-x-px fill-current" />
        ) : (
          <Pause className="fill-current" />
        )}
      </Button>
    </Tooltip>
  );
}

/** Where the title is, where it can go, and how long is left. Seeks when let go. */
function Scrubber() {
  const position = useTitlePlayer((state) => state.position);
  const duration = useTitlePlayer((state) => state.duration);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? position;
  if (!duration) {
    return <div className="text-sm text-muted-foreground">{clock(position)}</div>;
  }
  return (
    <div className="flex items-center gap-4 text-[0.8125rem] tabular-nums">
      <span className="w-14 text-right">{clock(shown)}</span>
      <SliderPrimitive.Root
        value={shown}
        min={0}
        max={duration}
        step={1}
        onValueChange={(next) => setDragging(Array.isArray(next) ? (next[0] ?? 0) : next)}
        onValueCommitted={(next) => {
          titlePlayer.seek(Array.isArray(next) ? (next[0] ?? 0) : next);
          setDragging(null);
          // Hand the keys back to the player.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        }}
        className="flex-1"
      >
        <SliderPrimitive.Control className="flex h-6 w-full touch-none items-center">
          <SliderPrimitive.Track className="h-1 w-full rounded-full bg-white/25">
            <SliderPrimitive.Indicator className="rounded-full bg-white" />
            <SliderPrimitive.Thumb
              aria-label="Position"
              className="size-3.5 rounded-full bg-white shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </SliderPrimitive.Track>
        </SliderPrimitive.Control>
      </SliderPrimitive.Root>
      <span className="w-16 text-muted-foreground">-{clock(duration - shown)}</span>
    </div>
  );
}

/** The file's sound and subtitle tracks, to choose from while playing. */
function Tracks({ menu, onMenu }: { menu: TrackMenu; onMenu: (menu: TrackMenu) => void }) {
  const audio = useTitlePlayer((state) => state.audio);
  const subtitles = useTitlePlayer((state) => state.subtitles);
  const audioId = useTitlePlayer((state) => state.audioId);
  const subtitle = useTitlePlayer((state) => state.subtitle);
  const speed = useTitlePlayer((state) => state.speed);
  return (
    <>
      <TrackMenus
        audio={audio}
        audioId={audioId}
        subtitles={subtitles}
        subtitle={subtitle}
        open={menu}
        onOpenChange={onMenu}
        onAudio={(id) => titlePlayer.setAudio(id)}
        onSubtitle={(track) => titlePlayer.setSubtitle(track)}
      />
      <PlaybackMenu
        speed={{ value: speed, onChange: (next) => titlePlayer.setSpeed(next) }}
        subtitles={subtitles}
        subtitle={subtitle}
        open={menu === "playback"}
        onOpenChange={(next) => onMenu(next ? "playback" : null)}
      />
    </>
  );
}

/** What the picture area says without a picture: starting, reconnecting, failed or finished. */
function State({ next }: { next: (() => void) | null }) {
  const phase = useTitlePlayer((state) => state.phase);
  const now = useTitlePlayer((state) => state.now);
  if (!now || phase.kind === "playing" || phase.kind === "paused") return null;
  let body: ReactNode = null;
  let actions: ReactNode = null;
  let title = now.name;
  switch (phase.kind) {
    case "opening":
    case "starting":
    case "idle":
      body = now.detail;
      break;
    case "reconnecting":
      title = "Connection lost";
      body = `Trying again, attempt ${phase.attempt} of ${phase.of}.`;
      break;
    case "ended":
      title = "Finished";
      body = now.detail;
      actions = (
        <>
          <Button variant="primary" onClick={() => titlePlayer.seek(0)}>
            <Play className="fill-current" />
            Play again
          </Button>
          <Button variant="secondary" onClick={leave}>
            Back
          </Button>
        </>
      );
      break;
    case "failed":
      title = problemTitle(phase.problem);
      body = problemBody(phase.problem);
      actions = (
        <>
          <Button variant="primary" onClick={() => titlePlayer.retry()}>
            <RotateCw />
            Retry
          </Button>
          {next && (
            <Button variant="secondary" onClick={next}>
              <SkipForward />
              Next episode
            </Button>
          )}
        </>
      );
      break;
  }
  return (
    <div className="pointer-events-auto flex max-w-[34rem] flex-col items-center px-8 text-center">
      <h2 className="text-3xl font-semibold tracking-tight text-balance">{title}</h2>
      {body && <p className="mt-3 text-[0.9375rem] text-muted-foreground">{body}</p>}
      {actions && <div className="mt-7 flex items-center gap-3">{actions}</div>}
    </div>
  );
}

function problemTitle(problem: PlaybackProblem): string {
  switch (problem.kind) {
    case "unavailable":
      return "Not available";
    case "refused":
      return "Refused by the provider";
    case "unsupported":
      return "Can't play this title";
    case "network":
      return "Couldn't reconnect";
    case "provider-error":
      return "Provider error";
    case "app":
      return "Can't open this title";
  }
}

function problemBody(problem: PlaybackProblem): string {
  switch (problem.kind) {
    case "unavailable":
      return "The provider has no file for this title right now.";
    case "refused":
      return "Another device may be using your connection.";
    case "unsupported":
      return problem.detail;
    case "network":
      return `The connection stopped and trying again didn't help. ${problem.detail}`;
    case "provider-error":
      return `The provider answered with HTTP ${problem.status}.`;
    case "app":
      return describeError(problem.error);
  }
}

/** The end of an episode: the next one, to play when the viewer says so. */
function NextUp({
  next,
  onNext,
}: {
  next: { series: SeriesDetails; episode: Episode };
  onNext: () => void;
}) {
  const now = useTitlePlayer((state) => state.now);
  const { episode } = next;
  return (
    <div className="absolute inset-0 z-10">
      <div className="absolute inset-0 opacity-35">
        <Artwork
          url={episode.stillUrl ?? next.series.backdropUrl}
          name={episode.title}
          size="full"
          plain
        />
      </div>
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/20" />
      <div className="absolute bottom-16 left-10 max-w-[44rem]">
        {now?.detail && (
          <div className="text-[0.9375rem] text-muted-foreground">
            Finished {now.detail.split(" · ")[0]}
          </div>
        )}
        <div className="mt-1 text-4xl font-semibold tracking-tight text-balance">
          Next: {episodeLabel(episode.season, episode.number)} · {episode.title}
        </div>
        {episode.duration && (
          <div className="mt-2 text-[0.9375rem] text-muted-foreground">
            {Math.round(episode.duration / 60)} min
          </div>
        )}
        <div className="mt-7 flex gap-3">
          <Button variant="primary" size="lg" onClick={onNext}>
            <Play className="fill-current" />
            Next episode
          </Button>
          <Button variant="secondary" size="lg" onClick={leave}>
            Episodes
          </Button>
        </div>
      </div>
    </div>
  );
}
