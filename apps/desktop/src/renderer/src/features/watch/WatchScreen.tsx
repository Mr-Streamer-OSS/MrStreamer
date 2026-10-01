// Watch: the picture fills the window, with what's on along the bottom. It opens over Home or the
// guide, which wait underneath unchanged. The channel list slides over the left to switch without
// leaving; Escape closes it, then leaves full screen, then goes back to the page underneath.
//   Up and Down switch channel, or move in the open list. Enter or Left opens the list; in it,
//   Enter plays, Left swaps to the lists and Right swaps back. Backspace returns to the previous
//   channel, digits jump to a number, F is full screen, M mutes, C turns subtitles on or off, I
//   shows the details, S stars. While a sound or subtitle menu is open, keys are its own.
import { useEffect, useRef, useState } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { hasModifier, isTyping } from "../../app/platform.ts";
import { closeWatch, useUi, type ChannelList } from "../../app/ui-store.ts";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useKeyboardMode } from "../../lib/input-mode.ts";
import { useCategoryMap, useToggleFavourite } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
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
import { useFullscreen, useWake } from "./layout.ts";
import { NowPlayingBar } from "./NowPlaying.tsx";
import { numberEntry, NumberEntry } from "./NumberEntry.tsx";
import { PlaybackState } from "./PlaybackState.tsx";
import type { TrackMenu } from "./TrackMenus.tsx";

/** Controls fade out after this long without input. */
const IDLE_MS = 3000;
const PAGE_ROWS = 10;
const NO_CHANNELS: readonly LiveChannel[] = [];

export function WatchScreen() {
  const [awake, wake] = useWake(IDLE_MS);
  const [fullscreen, toggleFullscreen] = useFullscreen();
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

  // Watch plays sound; the page underneath goes back to a muted preview.
  useEffect(() => {
    player.setAudible(true);
    return () => player.setAudible(false);
  }, []);

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
      if (now.menu) {
        // The menu's own keys; Escape closes it.
        if (event.key === "Escape") {
          setMenu(null);
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
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
          toggleFullscreen();
          break;
        case "m":
          player.toggleMute();
          break;
        case "c":
          player.toggleSubtitles();
          break;
        case "i":
          wake();
          break;
        case "s":
        case "S":
          if (now.channel) toggleFavourite(now.channel.id);
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
      <Picture
        active
        fit="contain"
        className="absolute inset-0"
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
            "absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-300",
            controlsVisible || channelsOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <WindowBar overlay />
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
    </div>
  );
}
