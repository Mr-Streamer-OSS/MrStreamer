// Watch: the picture fills the window, with what's on along the bottom. It opens over Home or the
// guide, which wait underneath unchanged. The channel list slides over the left to switch without
// leaving; Escape closes it, then leaves full screen, then goes back to the page underneath.
//   Up and Down switch channel, or move in the open list. Enter or Left opens the list; in it,
//   Enter plays, Left swaps to the lists and Right swaps back. Backspace returns to the previous
//   channel, digits jump to a number, F is full screen, M mutes, C turns subtitles on or off, G
//   and H move them earlier or later, I shows the details, S stars, Q opens the quality menu of a
//   channel with several streams, P shrinks the window into the mini player and back. While a
//   menu is open, keys are its own.
// In the mini player the picture fills the small window; opening the list puts the window back.
import { Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { hasModifier, isTyping } from "../../app/platform.ts";
import { miniPlayer, useMiniPlayer } from "../../app/mini-player.ts";
import { closeWatch, useUi, type ChannelList } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useKeyboardMode } from "../../lib/input-mode.ts";
import { useCategoryMap, useToggleFavourite } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { WINDOW_BAR } from "../../../../shared/window-bar.ts";
import { Picture } from "../../player/Picture.tsx";
import { player, usePlayer } from "../../player/player.ts";
import { useOpenGroups } from "../live/ListPicker.tsx";
import {
  adjacentChannel,
  groupOf,
  showList,
  useListChannels,
  useListEntries,
  type ListEntry,
} from "../live/lists.ts";
import { ChannelOverlay } from "./ChannelOverlay.tsx";
import { Flash } from "./Flash.tsx";
import { useFullscreen, useWake } from "./layout.ts";
import { MiniControls } from "./MiniPlayer.tsx";
import { NowPlayingBar } from "./NowPlaying.tsx";
import { numberEntry, NumberEntry } from "./NumberEntry.tsx";
import { nudgeSubtitles } from "./PlaybackMenu.tsx";
import { PlaybackState, problemTitle } from "./PlaybackState.tsx";
import type { TrackMenu } from "./TrackMenus.tsx";

/** Controls fade out after this long without input. */
const IDLE_MS = 3000;
const PAGE_ROWS = 10;
const NO_CHANNELS: readonly LiveChannel[] = [];

export function WatchScreen() {
  const [awake, wake] = useWake(IDLE_MS);
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const mini = useMiniPlayer((state) => state.on);
  const list = useUi((state) => state.list);
  const channelsOpen = useUi((state) => state.channelsOpen);
  const channels = useListChannels(list).channels ?? NO_CHANNELS;
  const channel = usePlayer((state) => state.channel);
  const phase = usePlayer((state) => state.phase);
  const categories = useCategoryMap();
  const toggleFavourite = useToggleFavourite();
  const keyboard = useKeyboardMode();
  const { open, toggle } = useOpenGroups(groupOf(list, categories));
  const entries = useListEntries(open);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState(0);
  const [entry, setEntry] = useState(0);
  const [menu, setMenu] = useState<TrackMenu>(null);

  // Nothing to watch, as after switching accounts: back to the page.
  useEffect(() => {
    if (!channel) closeWatch();
  }, [channel]);

  const switchBy = (direction: number) => {
    const target = adjacentChannel(channels, channel?.id, direction);
    if (!target) return;
    player.zap(target);
    wake();
  };
  const openChannels = () => {
    // The list needs the full window.
    if (miniPlayer.on()) void miniPlayer.leave();
    setPicking(false);
    setSelected(
      Math.max(
        0,
        channels.findIndex((each) => each.id === channel?.id),
      ),
    );
    useUi.setState({ channelsOpen: true });
  };
  const closeChannels = () => useUi.setState({ channelsOpen: false });
  const choose = (picked: ChannelList) => {
    showList(picked);
    setPicking(false);
    setSelected(0);
  };
  const pick = (picked: ListEntry | undefined) => {
    if (picked?.kind === "group") toggle(picked.group);
    else if (picked) choose(picked.list);
  };

  // The key handler reads the latest render through a ref. Registering it again on every render
  // would drop keys: a state change from another keydown listener renders between listeners.
  const latest = useRef({
    picking,
    selected,
    entry,
    channels,
    entries,
    channelsOpen,
    channel,
    switchBy,
    openChannels,
    closeChannels,
    pick,
    toggleFullscreen,
    toggleFavourite,
    wake,
    menu,
  });
  latest.current = {
    picking,
    selected,
    entry,
    channels,
    entries,
    channelsOpen,
    channel,
    switchBy,
    openChannels,
    closeChannels,
    pick,
    toggleFullscreen,
    toggleFavourite,
    wake,
    menu,
  };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (event.defaultPrevented || isTyping(event) || hasModifier(event) || event.isComposing)
        return;
      if (ui.searchOpen || ui.settings || ui.updateDialog || !ui.watching) return;
      const now = latest.current;
      // The menu's own keys: Escape closes it, and focus goes back to its button.
      if (now.menu) return;
      const {
        switchBy,
        openChannels,
        closeChannels,
        pick,
        toggleFullscreen,
        toggleFavourite,
        wake,
      } = now;
      const step = (value: number, delta: number, length: number) =>
        Math.min(Math.max(value + delta, 0), Math.max(length - 1, 0));
      if (/^[0-9]$/.test(event.key)) {
        numberEntry.type(event.key);
        event.preventDefault();
        return;
      }
      switch (event.key) {
        case "Escape":
          if (numberEntry.active()) numberEntry.cancel();
          else if (now.channelsOpen) closeChannels();
          else if (document.fullscreenElement) void document.exitFullscreen();
          else if (miniPlayer.on()) void miniPlayer.leave();
          else closeWatch();
          break;
        case "ArrowUp":
        case "ArrowDown":
        case "PageUp":
        case "PageDown": {
          const direction = event.key === "ArrowDown" || event.key === "PageDown" ? 1 : -1;
          const distance = event.key.startsWith("Page") ? PAGE_ROWS : 1;
          if (!now.channelsOpen) switchBy(direction);
          else if (now.picking) setEntry(step(now.entry, direction * distance, now.entries.length));
          else setSelected(step(now.selected, direction * distance, now.channels.length));
          break;
        }
        case "Home":
        case "End": {
          if (!now.channelsOpen) return;
          const last = event.key === "End";
          if (now.picking) setEntry(last ? Math.max(now.entries.length - 1, 0) : 0);
          else setSelected(last ? Math.max(now.channels.length - 1, 0) : 0);
          break;
        }
        case "Enter": {
          if (event.repeat || numberEntry.commit()) break;
          if (!now.channelsOpen) openChannels();
          else if (now.picking) pick(now.entries[now.entry]);
          else {
            const target = now.channels[now.selected];
            if (target) player.play(target);
          }
          break;
        }
        case "ArrowLeft":
          if (!now.channelsOpen) openChannels();
          else if (!now.picking) setPicking(true);
          break;
        case "ArrowRight":
          if (now.channelsOpen && now.picking) setPicking(false);
          else if (now.channelsOpen) closeChannels();
          else wake();
          break;
        case "Backspace":
          if (event.repeat) break;
          if (numberEntry.active()) numberEntry.cancel();
          else if (now.channelsOpen && now.picking) setPicking(false);
          else player.back();
          break;
        case "f":
          if (miniPlayer.on()) void miniPlayer.leave(true);
          else toggleFullscreen();
          break;
        case "p":
        case "P":
          void miniPlayer.toggle();
          break;
        case "m":
          player.toggleMute();
          break;
        case "c":
          player.toggleSubtitles();
          break;
        case "g":
        case "G":
        case "h":
        case "H":
          nudgeSubtitles(player.state().subtitle, event.key.toLowerCase() === "g" ? -1 : 1);
          break;
        case "i":
          wake();
          break;
        case "s":
        case "S":
          if (now.channel) toggleFavourite(now.channel.id);
          break;
        case "q":
          if ((now.channel?.variants.length ?? 0) < 2) return;
          // The menu opens over the full window's controls.
          if (miniPlayer.on()) void miniPlayer.leave();
          wake();
          setMenu("quality");
          break;
        default:
          return;
      }
      event.preventDefault();
      // Handled here only: the layer underneath, shown again by this key, must not take it too.
      event.stopPropagation();
    }
    // Before tooltips and popovers see the key: a tooltip on screen would keep Escape to itself.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (!channel) return null;
  const controlsVisible = awake || phase.kind !== "playing" || menu !== null;
  if (mini) {
    const playing = phase.kind !== "idle" && phase.kind !== "failed";
    return (
      <div
        data-view="watch"
        data-mini=""
        data-controls={controlsVisible ? "" : undefined}
        onMouseMove={wake}
        className={cn(
          "fixed inset-0 z-30 overflow-hidden bg-black",
          !awake && phase.kind === "playing" && "cursor-none",
        )}
      >
        <Picture
          active
          fit="contain"
          className="absolute inset-0"
          onClick={wake}
          onDoubleClick={() => void miniPlayer.leave()}
        />
        <MiniControls
          visible={controlsVisible}
          status={
            phase.kind === "playing"
              ? null
              : phase.kind === "reconnecting"
                ? "Connection lost"
                : phase.kind === "failed"
                  ? problemTitle(phase.problem, channel)
                  : channel.title
          }
          onClose={closeWatch}
        >
          {playing ? (
            <Button variant="media" size="icon-sm" aria-label="Stop" onClick={() => player.stop()}>
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              variant="primary"
              size="icon-sm"
              aria-label="Watch"
              onClick={() => player.play(channel)}
            >
              <Play className="size-3.5 translate-x-px fill-current" />
            </Button>
          )}
        </MiniControls>
        <NumberEntry onChannel={(target) => player.play(target)} />
        <Flash />
      </div>
    );
  }
  return (
    <div
      data-view="watch"
      data-controls={controlsVisible && !channelsOpen ? "" : undefined}
      onMouseMove={wake}
      className={cn(
        "fixed inset-0 z-30 overflow-hidden bg-black",
        !awake && phase.kind === "playing" && !channelsOpen && "cursor-none",
      )}
    >
      {/* In a window the picture starts below the bar, so the bar never draws on it. */}
      <Picture
        active
        fit="contain"
        className="absolute inset-x-0 bottom-0"
        style={{ top: fullscreen ? 0 : WINDOW_BAR.height }}
        onClick={() => (channelsOpen ? closeChannels() : wake())}
        onDoubleClick={toggleFullscreen}
      />
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <PlaybackState
          channel={channel}
          onWatch={() => player.play(channel)}
          onNext={() => switchBy(1)}
        />
      </div>
      {!fullscreen && (
        <div
          className={cn(
            "absolute inset-x-0 top-0 z-30 transition-opacity duration-300",
            controlsVisible || channelsOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <WindowBar />
        </div>
      )}
      {channelsOpen && (
        <ChannelOverlay
          list={list}
          channels={channels}
          playingId={channel.id}
          picking={picking}
          selected={keyboard && !picking ? selected : null}
          entries={entries}
          entry={keyboard && picking ? entry : null}
          onPlay={(target) => player.play(target)}
          onPick={choose}
          onToggleGroup={toggle}
          onTogglePicking={() => setPicking((current) => !current)}
          onClose={closeChannels}
        />
      )}
      <NowPlayingBar
        visible={controlsVisible && !channelsOpen}
        channel={channel}
        categories={categories}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onOpenChannels={openChannels}
        onSwitch={switchBy}
        menu={menu}
        onMenu={setMenu}
      />
      <NumberEntry onChannel={(target) => player.play(target)} />
      <Flash />
    </div>
  );
}
