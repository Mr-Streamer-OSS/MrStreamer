// Watch: the picture fills the window, with what's on along the bottom. It opens over Home or the
// guide, which wait underneath unchanged. The channel list slides over the left to switch without
// leaving; Escape closes it, then leaves full screen, then goes back to the page underneath.
//   Up and Down switch channel, or move in the open list. The wheel over the full picture
//   switches channel once per gesture while no menu, list or dialog owns input.
//   Enter or Left opens the list; in it,
//   Enter plays, Left swaps to the lists and Right swaps back. Backspace returns to the previous
//   channel, digits jump to a number, F is full screen, M mutes, C turns subtitles on or off, G
//   and H move them earlier or later, I shows the details, S stars, Q opens the quality menu of a
//   channel with several streams, P shrinks the window into the mini player and back, O opens the
//   chooser of where it plays, R tries a failed channel again. While a menu is open, keys are its
//   own. Tab reaches what a failed channel offers, and Enter there presses it; Enter or Space on
//   a message's cross closes the message.
// A local MPEG-TS channel keeps its recent history while it plays, shown on a timeline under the
// controls: Space or K pauses while the channel goes on arriving, J and L skip the seek step set in
// Settings (10 seconds unless changed), End
// goes live, and the slider seeks when let go. Other streams say they can't rewind.
// A picture that stands still for a few seconds while it should play says "Waiting for data" at
// the top right until it moves again or the channel reconnects.
// While a receiver on the network plays the channel, the controls stay: there is no picture to
// clear. Leaving Watch leaves the receiver playing; only Stop and Play here end it.
// In the mini player the picture fills the small window; opening the list puts the window back.
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { Pause, Play, RotateCcw, RotateCw, Square } from "lucide-react";
import { useEffect, useRef, useState, type WheelEvent } from "react";
import type { LiveTimeline } from "@mrstreamer/contracts/playback";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { sameOwned } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { blocksPlayerShortcut, resolveShortcut } from "../../app/shortcuts.ts";
import { currentPreferences, seekStep, useSeekStep } from "../../lib/preferences.ts";
import { miniPlayer, useMiniPlayer } from "../../app/mini-player.ts";
import { closeWatch, useUi, type ChannelList } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { SliderControl } from "../../components/ui/slider.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { clockTime } from "../../lib/format.ts";
import { useKeyboardMode } from "../../lib/input-mode.ts";
import { useCategoryMap, useToggleFavourite } from "../../lib/queries.ts";
import { clock } from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";
import { WINDOW_BAR } from "../../../../shared/window-bar.ts";
import { useLiveSession } from "../../player/media-session.ts";
import { outputs, useOutput } from "../../player/output.ts";
import { Picture } from "../../player/Picture.tsx";
import { LIVE_EDGE_MS, player, usePaneGroup, usePlayer } from "../../player/player.ts";
import {
  adjacentChannel,
  useListChannels,
  useListPicker,
  useShowList,
  type ListEntry,
} from "../live/lists.ts";
import { ChannelOverlay } from "./ChannelOverlay.tsx";
import { Flash, flash, flashNote, LiveSubtitleHint } from "./Flash.tsx";
import { useFullscreen, useWake } from "./layout.ts";
import { MINI_NEEDS_PICTURE, MiniControls } from "./MiniPlayer.tsx";
import { NowPlayingBar } from "./NowPlaying.tsx";
import { numberEntry, NumberEntry } from "./NumberEntry.tsx";
import { ConnectingNote, openChooser } from "./Output.tsx";
import { nudgeSubtitles } from "./SubtitleSettings.tsx";
import { PlaybackAnnouncement, PlaybackState, retryFailed } from "./PlaybackState.tsx";
import { failureTitle, reconnectingLine } from "./problems.ts";
import type { LiveMenu } from "./LiveMore.tsx";
import {
  isMultiviewMenu,
  Multiview,
  MultiviewBar,
  type MultiviewMenu,
  type TransportSlots,
} from "./multiview/Multiview.tsx";

/** Controls fade out after this long without input. */
const IDLE_MS = 3000;
const PAGE_ROWS = 10;

/** How often the retained window and cursor are read again. */
const TIMELINE_MS = 1000;

// One zap per wheel gesture, with small trackpad movements accumulated first.
const WHEEL_THRESHOLD = 80;
const WHEEL_PAUSE_MS = 250;
const WHEEL_COOLDOWN_MS = 700;
const NO_CHANNELS: readonly LiveChannel[] = [];

export function WatchScreen() {
  const [awake, wake] = useWake(IDLE_MS);
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const mini = useMiniPlayer((state) => state.on);
  const account = useUi((state) => state.account);
  const list = useUi((state) => state.list);
  const channelsOpen = useUi((state) => state.channelsOpen);
  const channels = useListChannels(list).channels ?? NO_CHANNELS;
  const channel = usePlayer((state) => state.channel);
  const phase = usePlayer((state) => state.phase);
  const toggleFavourite = useToggleFavourite();
  const showList = useShowList();
  const keyboard = useKeyboardMode();
  const categories = useCategoryMap();
  const picker = useListPicker(list);
  const { entries, entry, setEntry, openGroup: toggle } = picker;
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState(0);
  const [menu, setMenu] = useState<LiveMenu | MultiviewMenu>(null);
  const keyboardMenu = useRef(false);

  // A receiver on the network has playback, or had it until its connection broke.
  const remote = useOutput(
    (state) => state.status.output.kind === "receiver" || state.status.output.kind === "lost",
  );

  const waiting = usePlayer((state) => state.waiting && state.phase.kind === "playing");
  // Several panes replace the single picture; the selected one is `channel`.
  const grouped = usePaneGroup((state) => state.panes.length > 0);
  useLiveSession(channel);

  // Menus belong to this channel and the full controls, never to another channel or mini view,
  // nor across entering or leaving the multiview.
  useEffect(() => {
    setMenu(null);
  }, [channel?.subscriptionId, channel?.id, grouped]);
  useEffect(() => {
    if (mini || channelsOpen) setMenu(null);
  }, [mini, channelsOpen]);

  // A standing note, with nothing that moves: the picture itself says when it is over.
  useEffect(() => {
    flashNote(waiting ? t("Waiting for data") : null);

    return () => flashNote(null);
  }, [waiting]);

  // The mini player is a small picture, and a receiver leaves none here.
  useEffect(() => {
    if (remote && miniPlayer.on()) void miniPlayer.leave();
  }, [remote]);

  // Nothing to watch, as after switching accounts: back to the page.
  useEffect(() => {
    if (!channel) closeWatch();
  }, [channel]);

  const switchBy = (direction: number) => {
    const target = adjacentChannel(channels, channel, direction);

    if (!target) return;
    player.zap(target);
    wake();
  };

  const wheel = useRef({ total: 0, at: -Infinity, switchedAt: -Infinity, zapped: false });

  const onPictureWheel = (event: WheelEvent<HTMLDivElement>) => {
    const ui = useUi.getState();
    const focused = document.activeElement;

    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !ui.watching ||
      ui.searchOpen ||
      ui.settings ||
      ui.updateDialog ||
      channelsOpen ||
      menu ||
      document.querySelector('[role="dialog"], [role="alertdialog"]') ||
      focused?.matches('input, textarea, [contenteditable="true"]')
    ) {
      wheel.current.total = 0;

      return;
    }

    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const now = performance.now();
    const gesture = wheel.current;

    if (now - gesture.at > WHEEL_PAUSE_MS) {
      gesture.total = 0;
      gesture.zapped = false;
    }

    gesture.at = now;

    if (gesture.zapped || now - gesture.switchedAt < WHEEL_COOLDOWN_MS) return;

    const delta =
      event.deltaY *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? event.currentTarget.clientHeight : 1);

    if (Math.sign(delta) !== Math.sign(gesture.total)) gesture.total = 0;
    gesture.total += delta;

    if (Math.abs(gesture.total) < WHEEL_THRESHOLD) return;
    gesture.zapped = true;
    gesture.switchedAt = now;
    switchBy(gesture.total > 0 ? 1 : -1);
  };

  const openChannels = () => {
    // The list needs the full window.
    if (miniPlayer.on()) void miniPlayer.leave();
    setPicking(false);
    setSelected(
      Math.max(
        0,
        channels.findIndex((each) => sameOwned(each, channel)),
      ),
    );
    useUi.setState({ channelsOpen: true });
  };

  const closeChannels = () => useUi.setState({ channelsOpen: false });

  const openQuality = (byKeyboard = false) => {
    keyboardMenu.current = byKeyboard;

    // The menu opens over the full window's controls.
    if (miniPlayer.on()) void miniPlayer.leave();
    wake();
    setMenu("quality");
  };

  const choose = (picked: ChannelList) => {
    showList(picked);
    setPicking(false);
    setSelected(0);
  };

  const pick = (picked: ListEntry | undefined) => {
    if (picked?.kind === "group") toggle(picked.group);
    else if (picked?.kind === "list") choose(picked.list);
  };

  // The key handler reads the latest render through a ref. Registering it again on every render
  // would drop keys: a state change from another keydown listener renders between listeners.
  const latest = useRef({
    picker,
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
    openQuality,
    pick,
    toggleFullscreen,
    toggleFavourite,
    wake,
    menu,
  });

  latest.current = {
    picker,
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
    openQuality,
    pick,
    toggleFullscreen,
    toggleFavourite,
    wake,
    menu,
  };
  useEffect(() => {
    // Ends with this view, or with the account it shows, and with it an O that still waits for
    // the window and the system's list asked for from here.
    const view = new AbortController();
    outputs.viewShown(view.signal);

    /** Whether the playing stream has a retained timeline, or says why not. */
    function rewinds(): boolean {
      if (player.state().timeline) return true;

      if (player.onReceiver()) flash(t("Rewind plays here only"));
      else if (player.state().phase.kind === "playing") flash(t("This stream can't rewind"));

      return false;
    }

    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();

      if (blocksPlayerShortcut(event)) return;

      if (ui.searchOpen || ui.settings || ui.updateDialog || !ui.watching) return;
      const now = latest.current;

      // The menu's own keys: Escape closes it, and focus goes back to its button.
      if (now.menu) return;

      const {
        switchBy,
        openChannels,
        closeChannels,
        openQuality,
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

      const command = resolveShortcut(event, "live", currentPreferences()?.keyboardShortcuts);

      switch (command ?? event.key) {
        case "pause":
          if (!rewinds()) break;
          wake();
          player.togglePause();
          break;
        case "seekBack":
        case "seekForward":
          if (!rewinds()) break;
          wake();
          void player.skip((command === "seekBack" ? -1000 : 1000) * seekStep());
          break;
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
          if (!now.channelsOpen) {
            if (event.key === "Home" || !rewinds()) return;
            wake();
            void player.goLive();
            break;
          }

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
          else now.picker.back();
          break;
        case "ArrowRight":
          if (now.channelsOpen && now.picking) setPicking(false);
          else if (now.channelsOpen) closeChannels();
          else wake();
          break;
        case "Backspace":
          if (event.repeat) break;

          if (numberEntry.active()) numberEntry.cancel();
          else if (now.channelsOpen && now.picking) {
            if (!now.picker.back()) setPicking(false);
          } else player.back();
          break;
        case "fullscreen":
          if (miniPlayer.on()) void miniPlayer.leave(true);
          else toggleFullscreen();
          break;
        case "miniPlayer":
          if (player.onReceiver()) flash(t(MINI_NEEDS_PICTURE));
          else void miniPlayer.toggle();
          break;
        case "output":
          wake();
          void openChooser(() => {
            keyboardMenu.current = true;
            setMenu("output");
          }, view.signal);
          break;
        case "mute":
          if (!player.toggleMute()) flash(t("TV remote sets volume"));
          break;
        case "subtitles":
          if (player.onReceiver()) flash(t("Live subtitles play here only"));
          else player.toggleSubtitles();
          break;
        case "subtitlesEarlier":
        case "subtitlesLater":
          if (player.onReceiver()) flash(t("Subtitle timing plays here only"));
          else nudgeSubtitles(player.state().subtitle, command === "subtitlesEarlier" ? -1 : 1);
          break;
        case "info":
          wake();
          break;
        case "favourite":
          if (now.channel) toggleFavourite(now.channel);
          break;
        case "quality":
          if ((now.channel?.variants.length ?? 0) < 2) return;
          openQuality(true);
          break;
        case "retry":
          // Only a failed channel that Retry can help: nothing while it plays or reconnects.
          if (!retryFailed()) return;
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

    return () => {
      view.abort();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [account]);

  if (!channel) return null;
  // The multiview's bar and transport stay: they sit beside the panes, not over a picture.
  const controlsVisible = awake || phase.kind !== "playing" || menu !== null || remote || grouped;

  if (mini) {
    const playing = phase.kind !== "idle" && phase.kind !== "failed";

    return (
      <div
        data-view="watch"
        tabIndex={-1}
        data-mini=""
        data-controls={controlsVisible ? "" : undefined}
        onMouseMove={wake}
        className={cn(
          "fixed inset-0 z-30 overflow-hidden bg-black outline-none",
          !awake && phase.kind === "playing" && "cursor-none",
        )}
      >
        <Picture
          active
          adjusted
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
                ? reconnectingLine(phase)
                : phase.kind === "failed"
                  ? failureTitle(phase, channel)
                  : channel.title
          }
          failure={phase.kind === "failed" ? phase : null}
          onClose={closeWatch}
        >
          {playing ? (
            <Button
              variant="media"
              size="icon-sm"
              aria-label={t("Stop")}
              onClick={() => player.stop()}
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              data-retry
              variant="primary"
              size="icon-sm"
              aria-label={t("Watch")}
              onClick={() => player.play(channel)}
            >
              <Play className="size-3.5 translate-x-px fill-current" />
            </Button>
          )}
        </MiniControls>
        <NumberEntry onChannel={(target) => player.play(target)} />
        <LiveSubtitleHint />
        <Flash />
        <PlaybackAnnouncement channel={channel} />
      </div>
    );
  }

  return (
    <div
      data-view="watch"
      tabIndex={-1}
      data-controls={controlsVisible && !channelsOpen ? "" : undefined}
      onMouseMove={wake}
      className={cn(
        "fixed inset-0 z-30 overflow-hidden bg-black outline-none",
        !controlsVisible && !channelsOpen && "cursor-none",
      )}
    >
      {/* In a window the picture starts below the bar, so the bar never draws on it. */}
      {grouped ? (
        <Multiview
          channels={channels}
          timeline={(transport) => (
            <LiveTimelineBar
              visible
              transport={transport}
              className="mt-0 bg-none px-6 pt-0.5 pb-4.5"
            />
          )}
          menu={menu}
          onMenu={setMenu}
          style={{ top: fullscreen ? 0 : WINDOW_BAR.height }}
        />
      ) : (
        <>
          <Picture
            active
            adjusted
            fit="contain"
            className="absolute inset-x-0 bottom-0"
            style={{ top: fullscreen ? 0 : WINDOW_BAR.height }}
            onClick={() => (channelsOpen ? closeChannels() : wake())}
            onDoubleClick={toggleFullscreen}
            onWheel={onPictureWheel}
          />
          <div
            data-playback-state=""
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
          >
            <PlaybackState
              channel={channel}
              onWatch={() => player.play(channel)}
              onNext={() => switchBy(1)}
              onQuality={() => openQuality()}
              onChannels={openChannels}
            />
          </div>
        </>
      )}
      {!fullscreen && (
        <div
          className={cn(
            "absolute inset-x-0 top-0 z-30 transition-opacity duration-300",
            controlsVisible || channelsOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <WindowBar>
            {grouped && (
              <MultiviewBar menu={isMultiviewMenu(menu) ? menu : null} onMenu={setMenu} />
            )}
          </WindowBar>
        </div>
      )}
      {channelsOpen && (
        <ChannelOverlay
          list={list}
          channels={channels}
          playing={channel}
          picking={picking}
          selected={keyboard && !picking ? selected : null}
          picker={picker}
          entry={keyboard && picking ? entry : null}
          onPlay={(target) => player.play(target)}
          onPick={choose}
          onTogglePicking={() => setPicking((current) => !current)}
          onClose={closeChannels}
        />
      )}
      {/* The timeline lifts the bar above it, and is gone where the stream can't rewind. */}
      {!grouped && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
          <div className="relative">
            <NowPlayingBar
              visible={controlsVisible && !channelsOpen}
              channel={channel}
              categories={categories}
              fullscreen={fullscreen}
              onToggleFullscreen={toggleFullscreen}
              onOpenChannels={openChannels}
              onSwitch={switchBy}
              menu={isMultiviewMenu(menu) ? null : menu}
              keyboardMenu={keyboardMenu.current}
              onMenu={setMenu}
            />
          </div>
          <LiveTimelineBar visible={controlsVisible && !channelsOpen} />
        </div>
      )}
      <NumberEntry onChannel={(target) => player.play(target)} />
      <LiveSubtitleHint />
      <Flash />
      <ConnectingNote />
      <PlaybackAnnouncement channel={channel} />
    </div>
  );
}

/**
 * The retained window of a local MPEG-TS view, read again every second while it shows. The
 * multiview places it under its panes with `className` and fills its `transport` slots.
 */
function LiveTimelineBar({
  visible,
  className,
  transport,
}: {
  visible: boolean;
  className?: string;
  transport?: TransportSlots;
}) {
  const timeline = usePlayer((state) => state.timeline);

  return (
    timeline && (
      <RetainedTimeline
        timeline={timeline}
        visible={visible}
        className={className}
        transport={transport}
      />
    )
  );
}

/**
 * Pause, skips by the seek step, the slider over what is kept, how far behind live and Go live.
 * The slider seeks when let go; its own keys move the seek step, or a minute with Page Up and Down.
 * A read that fails keeps the last window shown. With `transport`, as in the multiview, the
 * slider has a row of its own above the buttons, and the selected pane's label says how far
 * behind live it is between the skips and what is kept.
 */
function RetainedTimeline({
  timeline,
  visible,
  className,
  transport,
}: {
  timeline: LiveTimeline;
  visible: boolean;
  className?: string | undefined;
  transport?: TransportSlots | undefined;
}) {
  const paused = usePlayer((state) => state.paused);
  const step = useSeekStep();
  const [dragging, setDragging] = useState<number | null>(null);
  useEffect(() => {
    const timer = setInterval(() => void player.refreshTimeline().catch(() => {}), TIMELINE_MS);

    return () => clearInterval(timer);
  }, []);

  const { start, end } = timeline;
  const cursor = Math.min(end, Math.max(start, dragging ?? timeline.cursor));
  const live = !paused && dragging === null && end - cursor < LIVE_EDGE_MS;

  const behind = (at: number) =>
    end - at < LIVE_EDGE_MS
      ? t("Live")
      : t("{time} behind live", { time: clock((end - at) / 1000) });

  const seek = (at: number) =>
    void (end - at < LIVE_EDGE_MS ? player.goLive() : player.seekLive(at));

  const single = (value: number | readonly number[]) =>
    Array.isArray(value) ? (value[0] ?? cursor) : value;

  const pauseLabel = paused ? t("Play") : t("Pause");

  const buttons = (
    <>
      <Tooltip label={pauseLabel}>
        <Button
          variant="primary"
          size="icon"
          className="size-9"
          aria-label={pauseLabel}
          onClick={() => player.togglePause()}
        >
          {paused ? (
            <Play className="size-4 translate-x-px fill-current" />
          ) : (
            <Pause className="size-4 fill-current" />
          )}
        </Button>
      </Tooltip>
      {(
        [
          [t("Back {seconds} seconds", { seconds: step }), -step * 1000, RotateCcw],
          [t("Forward {seconds} seconds", { seconds: step }), step * 1000, RotateCw],
        ] as const
      ).map(([label, by, Icon]) => (
        <Tooltip key={by} label={label}>
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-foreground"
            aria-label={label}
            onClick={() => void player.skip(by)}
          >
            <Icon className="size-5" />
          </Button>
        </Tooltip>
      ))}
    </>
  );

  const range = (
    <>
      <span
        className={cn(
          "min-w-10 flex-none text-xs whitespace-nowrap text-muted-foreground tabular-nums",
          !transport && "ml-2.5",
        )}
      >
        {clockTime(start, end)}
      </span>
      <SliderPrimitive.Root
        value={cursor}
        min={start}
        max={Math.max(end, start + 1)}
        step={step * 1000}
        largeStep={60_000}
        onValueChange={(next) => setDragging(single(next))}
        onValueCommitted={(next) => {
          seek(single(next));
          setDragging(null);
        }}
        className={cn("min-w-24 flex-1", !transport && "mx-1.5")}
      >
        <SliderControl className="flex h-6 w-full touch-none items-center">
          <SliderPrimitive.Track className="relative h-1 w-full rounded-[2px] bg-white/28">
            <SliderPrimitive.Indicator className="rounded-[2px] bg-foreground" />
            <SliderPrimitive.Thumb
              aria-label={t("Position")}
              getAriaValueText={(_, value) => behind(value)}
              className="size-3.5 rounded-full bg-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </SliderPrimitive.Track>
        </SliderControl>
      </SliderPrimitive.Root>
      <span className="min-w-10 flex-none text-right text-xs font-semibold whitespace-nowrap tabular-nums">
        {clockTime(end, end)}
      </span>
    </>
  );

  const kept = (
    <span
      className={cn(
        "flex-none text-xs whitespace-nowrap text-muted-foreground tabular-nums max-[720px]:hidden",
        transport ? "mr-2.5" : "ml-3",
      )}
    >
      {t("{time} kept", { time: clock((end - start) / 1000) })}
    </span>
  );

  const goLive = (
    <Button
      size="sm"
      className={cn(!transport && "ml-1.5")}
      disabled={live}
      onClick={() => void player.goLive()}
    >
      {t("Go live")}
    </Button>
  );

  return (
    <div
      role="group"
      aria-label={t("Live rewind")}
      data-live-timeline=""
      className={cn(
        "no-drag relative z-20 -mt-5 bg-[linear-gradient(to_bottom,transparent,rgb(0_0_0/0.9)_0.5rem)] px-10 pt-2 pb-6 transition-opacity duration-300 max-[720px]:mt-0 max-[720px]:px-4 max-[720px]:pb-4",
        visible ? "pointer-events-auto opacity-100" : "opacity-0",
        className,
      )}
    >
      {paused && timeline.expired && (
        <p role="status" className="mb-2 text-[0.8125rem] font-medium">
          {t("Paused moment expired. Play resumes from {time}.", {
            time: clockTime(start, end),
          })}
        </p>
      )}
      {transport ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-3">{range}</div>
          <div className="flex items-center gap-1.5">
            {buttons}
            <div className="min-w-0 pl-2.5">{transport.label}</div>
            <span className="flex-1" />
            {kept}
            {goLive}
            {transport.actions}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          {buttons}
          {range}
          <span className="ml-3 min-w-28 flex-none text-right text-[0.8125rem] font-medium whitespace-nowrap tabular-nums">
            {behind(cursor)}
          </span>
          {kept}
          {goLive}
        </div>
      )}
    </div>
  );
}
