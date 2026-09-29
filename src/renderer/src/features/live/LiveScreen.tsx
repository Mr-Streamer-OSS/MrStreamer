// Live TV as a TV: the picture fills the window and everything else is layered over it or, on
// wide windows, stands in the bars beside it. Every action has a control for the mouse; the
// keyboard and trackpad gestures are shortcuts for the same actions.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type CSSProperties } from "react";
import type { LiveChannel } from "../../../../shared/library.ts";
import { isTyping } from "../../app/platform.ts";
import { toDepth, useUi } from "../../app/ui-store.ts";
import { CatalogueNotice, catalogueState } from "../../components/CatalogueNotice.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { queries, useCategoryMap } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { player, usePlayer } from "../../player/player.ts";
import { Guide } from "./Guide.tsx";
import { adjacentChannel, useSwipe } from "./input.ts";
import { useFullscreen, useStageLayout, useWake } from "./layout.ts";
import { NowPlayingBar, NowPlayingPanel } from "./NowPlaying.tsx";
import { NumberEntry } from "./NumberEntry.tsx";
import { PlaybackState } from "./PlaybackState.tsx";

/** Controls fade out after this long without input. */
const IDLE_MS = 3000;
const NO_CHANNELS: readonly LiveChannel[] = [];

export function LiveScreen() {
  const root = useRef<HTMLDivElement>(null);
  const layout = useStageLayout(root);
  const [awake, wake] = useWake(IDLE_MS);
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const depth = useUi((state) => state.guideDepth);
  const categoryId = useUi((state) => state.categoryId);
  const categories = useQuery(queries.categories());
  const status = useQuery(queries.libraryStatus());
  const channels = useQuery({ ...queries.channels(categoryId), enabled: categories.isSuccess });
  const categoryMap = useCategoryMap();
  const selected = usePlayer((state) => state.channel);
  const phase = usePlayer((state) => state.phase);
  const lastChannel = useLastChannel();
  const shown = selected ?? lastChannel;
  const list = channels.data ?? NO_CHANNELS;

  // A remembered category can disappear after a refresh or a new login.
  useEffect(() => {
    if (
      categories.data &&
      categoryId !== null &&
      !categories.data.some((entry) => entry.id === categoryId)
    ) {
      useUi.setState({ categoryId: null });
    }
  }, [categories.data, categoryId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (isTyping(event) || event.repeat || ui.searchOpen || ui.settingsOpen) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "f") toggleFullscreen();
      else if (event.key === "m") player.toggleMute();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen]);

  const base = layout.pinned ? 1 : 0;
  const guideOverPicture = depth > base;
  const watch = () => {
    if (shown) player.play(shown);
  };
  const switchBy = (direction: number) => {
    const target = adjacentChannel(list, shown?.id, direction);
    if (!target) return;
    player.zap(target);
    wake();
  };
  // Opening the guide with the mouse shows categories and channels together: one click less than
  // stepping through the layers with the keyboard.
  const openGuide = () => useUi.setState({ guideDepth: toDepth(Math.max(depth, 2)) });
  const closeGuide = () => {
    if (depth > base) useUi.setState({ guideDepth: toDepth(base) });
  };

  // A click on the picture opens the guide (or closes it), a double click toggles full screen.
  const clickTimer = useRef(0);
  const onPictureClick = () => {
    window.clearTimeout(clickTimer.current);
    if (depth > base) closeGuide();
    else clickTimer.current = window.setTimeout(openGuide, 220);
  };
  const onPictureDoubleClick = () => {
    window.clearTimeout(clickTimer.current);
    toggleFullscreen();
  };
  // Two-finger swipes anywhere outside the guide: vertical switches channel, horizontal opens or
  // closes guide layers. The guide keeps its own wheel events for scrolling.
  const onSwipe = useSwipe({
    horizontal: (direction) =>
      useUi.setState({ guideDepth: toDepth(Math.max(depth, base) - direction) }),
    vertical: switchBy,
  });

  const stage: CSSProperties = layout.pinned
    ? { left: layout.side, width: layout.videoWidth }
    : { left: 0, right: 0 };
  const notice = catalogueState({
    data: categories.data,
    error: categories.error ?? channels.error,
  });
  const controlsVisible = awake || phase.kind !== "playing";
  const nowPlaying = {
    categories: categoryMap,
    fullscreen,
    onToggleFullscreen: toggleFullscreen,
    onOpenGuide: openGuide,
    onWatch: watch,
    onSwitch: switchBy,
  };

  return (
    <div
      ref={root}
      onMouseMove={wake}
      onWheel={onSwipe}
      className={cn(
        "relative h-full overflow-hidden bg-black",
        !awake && phase.kind === "playing" && !guideOverPicture && "cursor-none",
      )}
    >
      <video
        ref={player.attach}
        playsInline
        onClick={onPictureClick}
        onDoubleClick={onPictureDoubleClick}
        className="absolute inset-y-0 h-full object-contain"
        style={stage}
      />

      <div
        className="pointer-events-none absolute inset-y-0 z-10 flex items-center justify-center"
        style={stage}
      >
        {notice ? (
          <CatalogueNotice state={notice} />
        ) : layout.pinned || depth === 0 ? (
          <PlaybackState
            channel={shown}
            onWatch={watch}
            onNext={() => switchBy(1)}
            onOpenGuide={openGuide}
          />
        ) : null}
      </div>

      {categories.data && (
        <Guide
          pinned={layout.pinned}
          side={layout.side}
          rem={layout.rem}
          channels={list}
          categories={categories.data}
          totalChannels={status.data?.channelCount ?? 0}
          onWatch={watch}
          onInfo={wake}
          onClose={closeGuide}
        />
      )}

      {/* Home, Live TV, search and settings along the top, shown with the other controls. */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-30 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-300",
          controlsVisible || guideOverPicture ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <WindowBar overlay />
      </div>

      {shown &&
        (layout.pinned ? (
          <NowPlayingPanel width={layout.side} channel={shown} {...nowPlaying} />
        ) : (
          depth === 0 && <NowPlayingBar visible={controlsVisible} channel={shown} {...nowPlaying} />
        ))}

      <NumberEntry />
    </div>
  );
}

/** The last watched channel, so Live TV opens on it without starting a stream. */
function useLastChannel(): LiveChannel | null {
  const { data: preferences } = useQuery(queries.preferences());
  const channelId = preferences?.lastChannelId ?? null;
  const { data } = useQuery({ ...queries.channel(channelId ?? ""), enabled: channelId !== null });
  return data ?? null;
}
