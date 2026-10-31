import { router, usePathname } from "expo-router";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { Quality } from "@mrstreamer/contracts/library";
import {
  DEFAULT_SUBTITLE_TIMING,
  type SubtitleServiceFailure,
} from "@mrstreamer/contracts/online-subtitles";
import { formatLanguageName } from "@mrstreamer/core/i18n";
import { languageCode } from "@mrstreamer/core/ondemand/tracks";
import { lockAsync, OrientationLock, unlockAsync } from "expo-screen-orientation";
import { isPictureInPictureSupported, VideoAirPlayButton, VideoView } from "expo-video";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActionSheetIOS,
  Alert,
  Keyboard,
  PanResponder,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  channelQuality,
  chooseChannelQuality,
  currentCatalogue,
  playChannel,
  useCatalogue,
} from "./account.ts";
import { starChannel, useFavouriteKeys } from "./favourites.ts";
import { Glass, IconButton } from "./glass.tsx";
import { DownloadStatusButton } from "./download-status.tsx";
import { guide } from "./guide.ts";
import { catchUpOf } from "./guide-screen.tsx";
import { dayLabel, localDay, programmeRange } from "./guide-ui.tsx";
import { openOnTabs, useTabs, type TabScreen } from "./header.tsx";
import { NO_SHORTCUTS, useShortcuts, type Shortcut } from "./key-commands.ts";
import type { Channel } from "./library.ts";
import { useMediaPreferences, type SubtitleSize } from "./media-preferences.ts";
import {
  cuesAt,
  hideSubtitle,
  keptSubtitle,
  nextCueChange,
  retimeSubtitle,
  showKeptSubtitle,
  shownSubtitle,
  useShownSubtitle,
  type ShownSubtitle,
  type SubtitleTitle,
} from "./downloaded-subtitles.ts";
import { chooseSubtitle, findSubtitles, type FoundSubtitle } from "./online-subtitles.ts";
import {
  closeWatch,
  playbackState,
  request,
  onEndPictureInPicture,
  onProgressRefused,
  pictureInPicture,
  player,
  playingItem,
  playNext,
  type Playing,
  type TrackChoice,
  restoreFromPictureInPicture,
  retry,
  seekBy,
  seekTo,
  setAside,
  showVersions,
  stop,
  togglePause,
  trackChoices,
  unsetAside,
  unshownSubtitles,
  usePlayback,
  usePlaybackClock,
  usePlaybackLength,
} from "./playback.ts";
import type { UnshownSubtitles } from "./title-formats.ts";
import { colors } from "./ui.tsx";
import { currentSource } from "./sources.ts";
import { store, useStore } from "./store.ts";

/** Watch's keyboard shortcuts while it shows: Space, ← and → while a stream plays, Esc or ⌘. always. */
const STREAMING: readonly Shortcut<"pause" | "rewind" | "skip" | "close" | "dismiss">[] = [
  { id: "pause", input: " ", command: false, title: "Play or Pause" },
  { id: "rewind", input: "leftArrow", command: false, title: "Back 10 seconds" },
  { id: "skip", input: "rightArrow", command: false, title: "Forward 10 seconds" },
  { id: "close", input: "escape", command: false, title: "Close" },
  // Keyboards without Esc, as the iPad's Magic Keyboard, use ⌘. instead.
  { id: "dismiss", input: ".", command: true, title: "Close" },
];
/** Whether one of Watch's sheets is open: its keys are the sheet's then, Esc and arrows included. */
const sheet = store(false);

/** A system sheet over Watch, as ActionSheetIOS shows it, holding the keyboard while it shows. */
function showSheet(
  options: Parameters<typeof ActionSheetIOS.showActionSheetWithOptions>[0],
  chosen: (index: number) => void,
) {
  sheet.set(true);
  ActionSheetIOS.showActionSheetWithOptions(options, (index) => {
    sheet.set(false);
    chosen(index);
  });
}

const STILL = STREAMING.filter((shortcut) => shortcut.id === "close" || shortcut.id === "dismiss");

/**
 * Watch: the player full screen, over the tabs, with A3's controls: a close button, AirPlay,
 * Picture in Picture, Downloads and Settings at the top, and everything else in one large glass
 * panel, all showing and hiding together. Both a channel and a title add their sound and subtitle
 * tracks. A channel adds Quality, its star, which stars or unstars it and leaves what plays alone,
 * and Play from start while its catch-up keeps the programme on now.
 * A movie or an episode adds a scrubber and the next episode. It is the app's own layer rather
 * than a route, because the view that starts Picture in Picture has to stay while it plays: Watch
 * then hides, and the tabs and accessory take over. Closing it shows the screen under it, a
 * title's details among them. A movie or an episode turns Watch to landscape while it shows in a
 * window under 700 points on its short side, as on a phone; the screens under it turn as the phone
 * does again once it closes. A larger window, as an iPad's, shows the picture as the window stands.
 *
 * Downloads and Settings open on the tab under Watch without stopping what plays: where Picture in
 * Picture can, it takes the picture over, as its own button does; otherwise Watch is set aside,
 * paused, until the accessory brings it back (`setAside`). A screen over the tabs, as Search,
 * closes first. With no provider saved there are no tabs and no accessory: Downloads is the
 * offline list, offered only while Picture in Picture can take the picture, and Settings isn't
 * offered. If the tabs go while Watch is set aside, as when the last provider is removed and a
 * downloaded copy waits there, Watch shows that copy again as it stands.
 *
 * A subtitle downloaded for the movie or episode playing shows over the picture (`Cues`), above
 * the panel while the controls show.
 */
export function WatchLayer() {
  const { phase, watch, pip, external } = usePlayback();
  const view = useRef<VideoView>(null);
  const [controls, setControls] = useState(true);
  // The panel's height, which the cues sit above while the controls show.
  const [panel, setPanel] = useState(0);
  const insets = useSafeAreaInsets();
  const tabs = useTabs();
  const tab = tabs?.tab ?? null;
  const pathname = usePathname();
  // The press waiting for Picture in Picture to take over, with its fallback's timer. Picture in
  // Picture starting, Watch closing or showing again, the stream failing (its view goes, and Try
  // again plays the same item anew), another item, another tab or none, and Watch going each
  // retire it, so a fallback acts only for the press, stream and tabs it was for.
  const waiting = useRef<{ timer?: ReturnType<typeof setTimeout> } | null>(null);
  const retire = () => {
    clearTimeout(waiting.current?.timer);
    waiting.current = null;
  };
  const item = phase.kind === "idle" ? null : phase.item;
  const failed = phase.kind === "failed";
  useEffect(() => retire, [watch, pip, item, failed, tab]);
  useEffect(() => {
    if (!tab) unsetAside();
  }, [tab]);
  const pictureCanTake = phase.kind === "playing" && !external && isPictureInPictureSupported();
  const screens: readonly TabScreen[] = tab
    ? ["downloads", "settings"]
    : pictureCanTake
      ? ["downloads"]
      : [];
  const openScreen = (screen: TabScreen) => {
    retire();
    if (tabs) openOnTabs(tabs, screen);
    // Offline Downloads is usually the screen Watch opened over: then it only has to show.
    else if (pathname !== "/offline") router.push("/offline");
    const shown = view.current;
    if (!pictureCanTake || !shown) {
      if (tabs) setAside();
      return;
    }
    // Picture in Picture reports starting, which closes Watch over the screen just opened. If it
    // refuses, or doesn't start within a second, Watch is set aside instead of staying over it;
    // with no tabs to come back from, Watch stays as it was.
    const mine: { timer?: ReturnType<typeof setTimeout> } = {};
    waiting.current = mine;
    const unless = () => {
      if (waiting.current !== mine) return;
      waiting.current = null;
      if (tabs) setAside();
    };
    void shown.startPictureInPicture().then(() => {
      if (waiting.current === mine) mine.timer = setTimeout(unless, 1000);
    }, unless);
  };

  useEffect(() => {
    onEndPictureInPicture(() => void view.current?.stopPictureInPicture());
    return () => onEndPictureInPicture(null);
  }, []);
  // A refused save of how far a title got, told by the system's alert, which stays over whatever
  // shows: Watch closed by then, or nothing playing after Stop. Once until a save is kept again.
  useEffect(() => {
    onProgressRefused(() =>
      Alert.alert("Couldn't save progress", "Your latest position could not be saved."),
    );
    return () => onProgressRefused(null);
  }, []);
  // A return from Picture in Picture, answered once Watch has committed what it returns to: AVKit
  // then brings the picture back into a view on screen. The answer goes to the view that asked,
  // with the number its request carried, so a late answer can't complete a newer request.
  // Anything else playing by then, or Watch closed, answers no. If the view goes first, the
  // native view answers no as it goes.
  const [restoring, setRestoring] = useState<{
    readonly from: VideoView;
    readonly request: number;
    readonly item: Playing;
  } | null>(null);
  useEffect(() => {
    if (!restoring) return;
    setRestoring(null);
    const { from, request, item } = restoring;
    void from.finishPictureInPictureRestore(request, watch && playingItem(phase) === item);
  }, [restoring, watch, phase]);
  const restore = (request: number) => {
    const from = view.current;
    if (!from) return;
    const item = restoreFromPictureInPicture();
    if (item === null) void from.finishPictureInPictureRestore(request, false);
    else setRestoring({ from, request, item });
  };
  const frame = useWindowDimensions();
  const small = Math.min(frame.width, frame.height) < 700;
  const landscape = watch && phase.kind !== "idle" && !phase.item.live && small;
  useEffect(() => {
    if (!landscape) return;
    turn(() => lockAsync(OrientationLock.LANDSCAPE));
    // Closing gives the screens back the app's own rotation: iOS turns them as the phone is held.
    return () => turn(unlockAsync);
  }, [landscape]);
  useEffect(() => {
    if (!watch) return;
    setControls(true);
    // A search field left focused under Watch would keep its keyboard over the picture.
    Keyboard.dismiss();
  }, [watch]);

  const streaming = phase.kind === "loading" || phase.kind === "playing" || phase.kind === "paused";
  const sheetShown = useStore(sheet);
  useShortcuts(!watch || sheetShown ? NO_SHORTCUTS : streaming ? STREAMING : STILL, (id) => {
    if (id === "close" || id === "dismiss") void closeWatch();
    else if (id === "pause") togglePause();
    else seekBy(id === "rewind" ? -10 : 10);
  });

  if (!watch && !pip) return null;
  return (
    <View
      style={[StyleSheet.absoluteFill, watch ? styles.layer : styles.hidden]}
      pointerEvents={watch ? "auto" : "none"}
      // Watch lies over the tabs rather than replacing them, so VoiceOver is kept to it.
      accessibilityViewIsModal={watch}
      accessibilityElementsHidden={!watch}
      importantForAccessibility={watch ? "auto" : "no-hide-descendants"}
      testID="watch"
    >
      <StatusBar hidden={watch} />
      {streaming ? (
        <VideoView
          ref={view}
          player={player()}
          nativeControls={false}
          contentFit="contain"
          allowsPictureInPicture
          startsPictureInPictureAutomatically
          onPictureInPictureStart={() => pictureInPicture(true)}
          onPictureInPictureStop={() => pictureInPicture(false)}
          onPictureInPictureRestore={({ nativeEvent }) => restore(nativeEvent.request)}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {watch ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityLabel={controls ? "Hide controls" : "Show controls"}
          onPress={() => setControls((shown) => !shown)}
        />
      ) : null}
      {watch && streaming && item && !item.live ? (
        <Cues
          item={item}
          // Over the panel and its bottom margin, with a gap.
          bottom={insets.bottom + (controls ? 12 + panel + 12 : 24)}
        />
      ) : null}
      {watch && controls ? (
        <Controls
          onPictureInPicture={() => void view.current?.startPictureInPicture()}
          screens={screens}
          onScreen={openScreen}
          onPanel={setPanel}
        />
      ) : null}
    </View>
  );
}

/** Orientation changes, made in the order asked so a quick close and reopen can't swap them. */
let turning = Promise.resolve();
function turn(change: () => Promise<void>) {
  turning = turning.then(change).catch(() => undefined);
}

function Controls({
  onPictureInPicture,
  screens,
  onScreen,
  onPanel,
}: {
  onPictureInPicture: () => void;
  /** The screens Watch can open from here. */
  screens: readonly TabScreen[];
  onScreen: (screen: TabScreen) => void;
  /** The panel's height, as it lays out. */
  onPanel: (height: number) => void;
}) {
  const { phase } = usePlayback();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  if (phase.kind === "idle") return null;
  const wide = width >= 600;
  const edge = { left: insets.left + 16, right: insets.right + 16 };
  const streaming = phase.kind !== "failed";
  return (
    <>
      <Glass style={[styles.circle, { top: insets.top + 12, left: edge.left }]}>
        <IconButton symbol="xmark" label="Close" onPress={closeWatch} testID="watch-close" />
      </Glass>
      {streaming || screens.length > 0 ? (
        <Glass style={[styles.capsule, { top: insets.top + 12, right: edge.right }]}>
          {streaming ? (
            <>
              <VideoAirPlayButton
                style={styles.airplay}
                tint={colors.text}
                activeTint={colors.text}
                accessibilityLabel="AirPlay"
              />
              {isPictureInPictureSupported() ? (
                <IconButton
                  symbol="pip.enter"
                  label="Picture in Picture"
                  onPress={onPictureInPicture}
                  testID="watch-pip"
                />
              ) : null}
            </>
          ) : null}
          {screens.includes("downloads") ? (
            <DownloadStatusButton onPress={() => onScreen("downloads")} testID="watch-downloads" />
          ) : null}
          {screens.includes("settings") ? (
            <IconButton
              symbol="gearshape"
              label="Settings"
              onPress={() => onScreen("settings")}
              testID="watch-settings"
            />
          ) : null}
        </Glass>
      ) : null}
      <Glass style={[styles.panel, { bottom: insets.bottom + 12, ...edge }]}>
        <View
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          onLayout={(event: LayoutChangeEvent) => onPanel(event.nativeEvent.layout.height)}
        />
        <View style={[styles.top, !wide && styles.stacked]}>
          <View style={styles.names}>
            <Text style={styles.title} numberOfLines={1}>
              {phase.item.title}
            </Text>
            <Text style={styles.place} numberOfLines={2} testID="watch-status">
              {phase.kind === "failed"
                ? phase.error
                : phase.kind === "loading"
                  ? "Connecting"
                  : placeOf(phase.item)}
            </Text>
          </View>
          <View style={styles.buttons}>
            {phase.kind === "failed" ? (
              <>
                <IconButton
                  symbol="arrow.clockwise"
                  label="Try again"
                  onPress={retry}
                  size={26}
                  testID="watch-retry"
                />
                {phase.item.versions ? (
                  <IconButton
                    symbol="square.stack"
                    label="Other versions"
                    onPress={() => {
                      closeWatch();
                      showVersions();
                    }}
                    size={22}
                    testID="watch-versions"
                  />
                ) : null}
              </>
            ) : (
              <>
                <IconButton
                  symbol="gobackward.10"
                  label="Back 10 seconds"
                  onPress={() => seekBy(-10)}
                  size={24}
                />
                <IconButton
                  symbol={phase.kind === "paused" ? "play.fill" : "pause.fill"}
                  label={phase.kind === "paused" ? "Play" : "Pause"}
                  onPress={togglePause}
                  size={32}
                  testID="watch-pause"
                />
                <IconButton
                  symbol="goforward.10"
                  label="Forward 10 seconds"
                  onPress={() => seekBy(10)}
                  size={24}
                />
              </>
            )}
            {phase.item.live ? (
              <>
                <LiveQuality item={phase.item} />
                <Star item={phase.item} />
              </>
            ) : null}
            <IconButton
              symbol="stop.fill"
              label="Stop"
              onPress={stop}
              size={22}
              testID="watch-stop"
            />
          </View>
        </View>
        {streaming ? phase.item.live ? <Clock /> : <Scrubber /> : null}
        {streaming ? <TextButtons item={phase.item} /> : null}
      </Glass>
    </>
  );
}

/**
 * The line under what plays: where a channel or title is listed, and for a programme from catch-up,
 * that it is one and when it aired, "Estuary Max · Catch-up · Today 09:00–10:00", never Live.
 */
function placeOf(item: Playing) {
  if (!item.past) return item.place;
  const day = dayLabel(localDay(item.past.start), Date.now());
  return `${item.place} · Catch-up · ${day} ${programmeRange(item.past)}`;
}

/**
 * Play from start, while a live channel plays whose catch-up keeps the programme on now: it plays
 * that programme from its start, as the Programme screen's does, in its place.
 */
function StartOver({ item }: { item: Playing }) {
  const catalogue = useCatalogue();
  const channel = catalogue.kind === "ready" ? catalogue.library.byKey.get(item.id) : undefined;
  const programme = useOnNow(channel);
  if (!channel || !programme || catchUpOf(channel, programme, Date.now()).kind !== "on")
    return null;
  return (
    <TextControl
      label="Play from start"
      accessibilityLabel={`Play ${programme.title} from start`}
      onPress={() => playChannel(channel, channel.title, { watch: true, programme })}
      testID="watch-from-start"
    />
  );
}

/**
 * The programme on now on `channel`, by its guide: read as the guide changes and again as that
 * programme ends, at least hourly. Null until read, or with nothing on.
 */
function useOnNow(channel: Channel | undefined) {
  const snapshot = useSyncExternalStore(guide.subscribe, guide.getSnapshot);
  const awake = useSyncExternalStore(guide.awake.subscribe, guide.awake.get);
  const [ended, setEnded] = useState(0);
  const revision = useSyncExternalStore(guide.listingRevision.subscribe, guide.listingRevision.get);
  const [read, setRead] = useState<{
    channel: Channel;
    revision: number;
    programme: Programme | null;
  } | null>(null);
  useEffect(() => {
    if (!channel || !awake) return;
    const controller = new AbortController();
    guide.listings([channel.key], { signal: controller.signal }).then(
      (listings) => {
        if (!controller.signal.aborted)
          setRead({ channel, revision, programme: listings.get(channel.key)?.now ?? null });
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [channel, snapshot, ended, revision, awake]);
  const programme =
    awake && read && read.channel === channel && read.revision === revision ? read.programme : null;
  useEffect(() => {
    if (!programme) return;
    const timer = setTimeout(
      () => setEnded((count) => count + 1),
      Math.min(programme.stop - Date.now(), 3_600_000),
    );
    return () => clearTimeout(timer);
  }, [programme]);
  return programme;
}

/**
 * The star of the channel playing, while Live shows it: stars or unstars it, whichever provider
 * it is from, and nothing else.
 */
function Star({ item }: { item: Playing }) {
  const catalogue = useCatalogue();
  const favourites = useFavouriteKeys();
  const channel = catalogue.kind === "ready" ? catalogue.library.byKey.get(item.id) : undefined;
  if (!channel) return null;
  const favourite = favourites.has(channel.key);
  return (
    <IconButton
      symbol={favourite ? "star.fill" : "star"}
      label={favourite ? "Remove from Favourites" : "Add to Favourites"}
      onPress={() => starChannel(channel, !favourite)}
      size={22}
      testID="watch-favourite"
    />
  );
}

const qualityNames: Readonly<Record<Quality, string>> = {
  uhd: "4K",
  fhd: "Full HD",
  hd: "HD",
  sd: "SD",
};

/** Quality stays available while connecting or failed, so Automatic can reset a broken pick. */
function LiveQuality({ item }: { item: Playing }) {
  const catalogue = useCatalogue();
  const menu = useRef(0);
  useEffect(
    () => () => {
      menu.current++;
    },
    [item],
  );
  const channel = catalogue.kind === "ready" ? catalogue.library.byKey.get(item.id) : undefined;
  const choose = () => {
    if (!channel) return;
    const mine = ++menu.current;
    const asked = request();
    const source = currentSource(channel.subscriptionId);
    const stands = () => {
      const { phase, watch } = playbackState.get();
      const latest = currentCatalogue();
      return (
        menu.current === mine &&
        asked.stands() &&
        watch &&
        phase.kind !== "idle" &&
        phase.item === item &&
        currentSource(channel.subscriptionId) === source &&
        latest.kind === "ready" &&
        latest.library.byKey.get(item.id) === channel
      );
    };
    if (!stands()) return;
    const choices = channelQuality(channel);
    showSheet(
      {
        title: "Quality",
        options: [
          ...choices.map((choice) => {
            const name = choice.quality
              ? `${qualityNames[choice.quality]} · ${choice.name}`
              : choice.name;
            return `${choice.saved ? "✓ " : ""}${name}${choice.playing ? " · Playing" : ""}`;
          }),
          "Cancel",
        ],
        cancelButtonIndex: choices.length,
      },
      (index) => {
        const picked = choices[index];
        if (!picked || !stands()) return;
        if (!chooseChannelQuality(channel, item.place, picked.variantId)) {
          Alert.alert(
            "Couldn't save media preference",
            "Your previous choice is still saved. Try again.",
          );
        }
      },
    );
  };
  return <TextControl label="Quality" onPress={choose} testID="watch-quality" />;
}

/** How long the stream has played, and that it is live. Only this redraws every second. */
function Clock() {
  const seconds = Math.floor(usePlaybackClock());
  const minutes = Math.floor(seconds / 60);
  return (
    <View style={styles.clock}>
      <Text style={styles.time} testID="watch-time">
        {`${minutes}:${String(seconds % 60).padStart(2, "0")}`}
      </Text>
      <View style={styles.spacer} />
      <Text style={styles.time}>Live</Text>
    </View>
  );
}

/** "1:02:13" or "24:51". */
function clockOf(seconds: number): string {
  // Before a title loaded, the player can report no time at all.
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/**
 * Where a title is and how much is left, on a line to drag or tap. VoiceOver adjusts it ten
 * seconds at a time. Only this redraws every second.
 */
function Scrubber() {
  const position = usePlaybackClock();
  const length = usePlaybackLength();
  const [width, setWidth] = useState(1);
  const [dragged, setDragged] = useState<number | null>(null);
  const at = dragged ?? (Number.isFinite(position) ? position : 0);
  const fraction = length > 0 ? Math.min(1, Math.max(0, at / length)) : 0;
  const toTime = (x: number) => (Math.min(width, Math.max(0, x)) / width) * length;
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => setDragged(toTimeRef.current(event.nativeEvent.locationX)),
      onPanResponderMove: (event) => setDragged(toTimeRef.current(event.nativeEvent.locationX)),
      onPanResponderRelease: (event) => {
        seekTo(toTimeRef.current(event.nativeEvent.locationX));
        setDragged(null);
      },
      onPanResponderTerminate: () => setDragged(null),
    }),
  ).current;
  const toTimeRef = useRef(toTime);
  toTimeRef.current = toTime;
  return (
    <View style={styles.clock}>
      <Text style={styles.time} testID="watch-time">
        {clockOf(at)}
      </Text>
      <View
        style={styles.scrub}
        onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width || 1)}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Position"
        accessibilityValue={{ text: `${clockOf(at)} of ${clockOf(length)}` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event: AccessibilityActionEvent) =>
          seekBy(event.nativeEvent.actionName === "increment" ? 10 : -10)
        }
        testID="watch-scrubber"
        {...responder.panHandlers}
      >
        <View style={styles.rail}>
          <View style={[styles.filled, { width: `${fraction * 100}%` }]} />
        </View>
        <View style={[styles.knob, { left: fraction * width - 7 }]} />
      </View>
      <Text style={styles.time} testID="watch-left">
        {length > 0 ? `-${clockOf(length - at)}` : ""}
      </Text>
    </View>
  );
}

/**
 * Audio and Subtitles, then Play from start for a live channel or Next episode for a title: one
 * row of text controls that wraps when it runs out of width. For a movie or an episode, Subtitles
 * also lists the subtitle downloaded for its version, with Find online and, while that shows,
 * Adjust timing. Every sheet that follows acts only while the play it was opened for stands.
 */
function TextButtons({ item }: { item: Playing }) {
  const menu = useRef(0);
  useEffect(
    () => () => {
      menu.current++;
    },
    [],
  );
  const choose = async (of: "audio" | "subtitles") => {
    const mine = ++menu.current;
    const asked = request();
    const playing = playingItem(playbackState.get().phase);
    const stands = () =>
      menu.current === mine &&
      asked.stands() &&
      playbackState.get().watch &&
      playingItem(playbackState.get().phase) === playing;
    const unshown = of === "subtitles" ? unshownSubtitles() : null;
    const known = await trackChoices(of);
    if (!stands()) return;
    const choices = known ?? [];
    const none = choices.length === 0 || (choices.length === 1 && choices[0]?.kind === "off");
    const title = of === "subtitles" ? item.subtitles : undefined;
    const rows = title
      ? subtitleRows(title, choices, stands)
      : choices.map((choice) => ({
          label: choice.selected ? `✓ ${choice.label}` : choice.label,
          run: () => void choice.choose(),
        }));
    showSheet(
      {
        title: of === "audio" ? "Audio" : "Subtitles",
        options: [...rows.map((row) => row.label), "Cancel"],
        cancelButtonIndex: rows.length,
        ...(known === null
          ? { message: "Not known yet. Try again in a moment." }
          : unshown && unshown.named.length > 0
            ? { message: cantShow(unshown) }
            : none
              ? { message: item.live ? "No choices on this channel." : "No choices in this file." }
              : {}),
      },
      (index) => {
        if (stands()) rows[index]?.run();
      },
    );
  };
  return (
    <View style={styles.textButtons}>
      <TextControl label="Audio" onPress={() => void choose("audio")} testID="watch-audio" />
      <TextControl
        label="Subtitles"
        onPress={() => void choose("subtitles")}
        testID="watch-subtitles"
      />
      {item.live ? (
        <StartOver item={item} />
      ) : item.next ? (
        <TextControl label="Next episode" onPress={playNext} testID="watch-next" />
      ) : null}
    </View>
  );
}

interface Row {
  readonly label: string;
  readonly run: () => void;
}

/**
 * The Subtitles sheet's rows for a movie or an episode: the file's own tracks and Off, the
 * subtitle downloaded for its version, checked while it shows, Find online, and Adjust timing
 * while one shows. While it shows, the file's own are off, so none of theirs is checked; a file
 * without Off of its own gets one that hides it.
 */
function subtitleRows(
  title: SubtitleTitle,
  choices: readonly TrackChoice[],
  stands: () => boolean,
): readonly Row[] {
  const kept = keptSubtitle(title);
  const showing = shownSubtitle()?.title === title;
  return [
    ...(showing && !choices.some((choice) => choice.kind === "off")
      ? [{ label: "Off", run: () => hideSubtitle(title) }]
      : []),
    ...choices.map((choice) => ({
      label: choice.selected && !showing ? `✓ ${choice.label}` : choice.label,
      run: () => void choice.choose(),
    })),
    ...(kept
      ? [
          {
            label: `${showing ? "✓ " : ""}${spoken(kept.subtitle.language) || "Subtitles"} · ${kept.subtitle.release || "SubDL"}`,
            run: () => {
              if (!showing && !showKeptSubtitle(title))
                Alert.alert(
                  "Couldn't show subtitles",
                  "This iPhone refused the change. Try again.",
                );
            },
          },
        ]
      : []),
    { label: "Find online", run: () => void findOnline(title, stands) },
    ...(showing ? [{ label: "Adjust timing", run: () => adjustTiming(title, stands) }] : []),
  ];
}

/**
 * Searches SubDL for what plays and offers its results, each by language, HI for the hearing
 * impaired, and release; the one picked is downloaded, kept for the version and shown.
 */
async function findOnline(title: SubtitleTitle, stands: () => boolean) {
  const found = await findSubtitles(title);
  if (!found || !stands()) return;
  if (found.kind === "failed") return serviceFailed(found.reason);
  const { results } = found;
  if (results.length === 0) {
    return Alert.alert("No subtitles found", "SubDL has none for this in your languages.");
  }
  showSheet(
    {
      title: "Online subtitles",
      options: [...results.map(resultName), "Cancel"],
      cancelButtonIndex: results.length,
    },
    (index) => {
      const picked = results[index];
      if (!picked || !stands()) return;
      void chooseSubtitle(title, picked.id).then((chosen) => {
        if (chosen?.kind === "failed" && stands()) serviceFailed(chosen.reason);
      });
    },
  );
}

/** "English · HI · Movie.2024.1080p.WEB". */
const resultName = ({ language, hearingImpaired, release }: FoundSubtitle) =>
  [spoken(language) || "Unknown language", ...(hearingImpaired ? ["HI"] : []), release]
    .filter(Boolean)
    .join(" · ");

/** Steps the downloaded subtitle earlier or later by, in seconds. */
const STEPS = [
  { by: -1, label: "1 s earlier" },
  { by: -0.1, label: "0.1 s earlier" },
  { by: 0.1, label: "0.1 s later" },
  { by: 1, label: "1 s later" },
] as const;

/**
 * Moves the downloaded subtitle showing over what plays a step earlier or later, or back with
 * Reset, opening again after each step until Done.
 */
function adjustTiming(title: SubtitleTitle, stands: () => boolean) {
  const showing = shownSubtitle();
  if (showing?.title !== title || !stands()) return;
  const { timing } = showing;
  const changed =
    timing.offset !== DEFAULT_SUBTITLE_TIMING.offset ||
    timing.speed !== DEFAULT_SUBTITLE_TIMING.speed;
  const steps = [
    ...STEPS.map(({ by, label }) => ({
      label,
      // In tenths, so steps add up without float drift.
      timing: { ...timing, offset: Math.round((timing.offset + by) * 10) / 10 },
    })),
    ...(changed ? [{ label: "Reset", timing: DEFAULT_SUBTITLE_TIMING }] : []),
  ];
  const offset = Math.abs(timing.offset).toFixed(1);
  showSheet(
    {
      title: "Adjust timing",
      message:
        timing.offset === 0
          ? "Original timing"
          : `Shown ${offset} s ${timing.offset > 0 ? "later" : "earlier"}`,
      options: [...steps.map((step) => step.label), "Done"],
      cancelButtonIndex: steps.length,
    },
    (index) => {
      const step = steps[index];
      if (!step || !stands()) return;
      if (!retimeSubtitle(title, step.timing)) {
        return Alert.alert("Couldn't change timing", "The previous timing is kept.");
      }
      adjustTiming(title, stands);
    },
  );
}

const failures: Readonly<
  Record<SubtitleServiceFailure | "not-saved", readonly [title: string, message: string]>
> = {
  "not-configured": ["SubDL key needed", "Add your SubDL API key in Settings > Subtitles."],
  credentials: ["SubDL refused the key", "Check your SubDL API key in Settings > Subtitles."],
  quota: ["SubDL limit reached", "Your SubDL key has no requests left for now. Try again later."],
  unavailable: ["SubDL isn't available", "Check your connection and try again."],
  unsupported: ["Can't use this subtitle", "It isn't text the app can read. Try another."],
  "not-saved": ["Couldn't keep this subtitle", "This iPhone refused to save it. Try again."],
};

const serviceFailed = (reason: SubtitleServiceFailure | "not-saved") =>
  Alert.alert(...failures[reason]);

/**
 * The downloaded subtitle showing over the movie or episode playing, drawn over the picture at
 * the viewer's text size, which Dynamic Type scales. Nothing for another play's.
 */
function Cues({ item, bottom }: { item: Playing; bottom: number }) {
  const shown = useShownSubtitle();
  if (!shown || !item.subtitles || shown.title !== item.subtitles) return null;
  return <CueLines shown={shown} bottom={bottom} />;
}

const cueSizes: Readonly<Record<SubtitleSize, number>> = { small: 16, medium: 20, large: 26 };

function CueLines({ shown, bottom }: { shown: ShownSubtitle; bottom: number }) {
  const text = useCueText(shown);
  const { subtitleSize } = useMediaPreferences();
  if (!text) return null;
  const fontSize = cueSizes[subtitleSize];
  return (
    <View pointerEvents="none" style={[styles.cues, { bottom }]}>
      <Text
        style={[styles.cue, { fontSize, lineHeight: Math.round(fontSize * 1.25) }]}
        maxFontSizeMultiplier={2}
        testID="watch-cues"
      >
        {text}
      </Text>
    </View>
  );
}

/**
 * The lines to show now, from the player's time: read again as the playback clock moves, as a
 * seek does, and while it plays at the next cue's start or end. Nothing redraws between those.
 */
function useCueText(shown: ShownSubtitle): string {
  const clock = usePlaybackClock();
  const playing = usePlayback().phase.kind === "playing";
  const [text, setText] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = player().currentTime;
      setText(cuesAt(shown, now).map(plain).join("\n"));
      const next = nextCueChange(shown, now);
      if (!playing || next === null) return;
      const rate = player().playbackRate > 0 ? player().playbackRate : 1;
      timer = setTimeout(update, Math.max(20, ((next - now) / rate) * 1000));
    };
    update();
    return () => clearTimeout(timer);
  }, [shown, clock, playing]);
  return text;
}

const entities: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": "\u00A0",
};

/** A cue's text without its markup: tags such as <i>, and SSA overrides such as {\an8}. */
const plain = (text: string) =>
  text
    .replace(/<[^>]*>|\{\\[^}]*\}/g, "")
    .replace(/&(?:amp|lt|gt|nbsp);/g, (entity) => entities[entity] ?? entity)
    .trim();

/** A language's name in the app's language, like the rest of its copy; null when unknown. */
function spoken(code: string | null) {
  const canonical = languageCode(code);
  return (canonical && formatLanguageName(canonical)) || code;
}

/**
 * The Subtitles sheet's message for tracks the file has that Watch can't show, by language and
 * format, then how many more: "Can't show here: English (PGS), Dutch (DVD, forced) and 2 more."
 */
function cantShow({ named, more }: UnshownSubtitles) {
  const tracks = named.map(({ language, format, forced }) => {
    const details = [format ?? "unknown format", ...(forced ? ["forced"] : [])].join(", ");
    return `${spoken(language) ?? "Unknown language"} (${details})`;
  });
  return `Can't show here: ${tracks.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
}

function TextControl({
  label,
  accessibilityLabel,
  onPress,
  testID,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.textControl, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={styles.textControlLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  layer: { backgroundColor: "#000000" },
  // Under Picture in Picture the view stays, unseen and untouchable, so iOS can bring it back.
  hidden: { opacity: 0 },
  circle: { position: "absolute", borderRadius: 22 },
  capsule: { position: "absolute", flexDirection: "row", borderRadius: 22, paddingHorizontal: 2 },
  airplay: { width: 44, height: 44 },
  panel: { position: "absolute", borderRadius: 26, paddingHorizontal: 16, paddingVertical: 12 },
  top: { flexDirection: "row", alignItems: "center", gap: 12 },
  stacked: { flexDirection: "column", alignItems: "stretch" },
  names: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  place: { color: colors.text, fontSize: 13, marginTop: 2 },
  buttons: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  clock: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  time: { color: colors.text, fontSize: 13, fontVariant: ["tabular-nums"], minWidth: 44 },
  scrub: { flex: 1, height: 32, justifyContent: "center" },
  rail: { height: 4, borderRadius: 2, backgroundColor: "#FFFFFF40", overflow: "hidden" },
  filled: { height: 4, backgroundColor: "#FFFFFF" },
  knob: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#FFFFFF",
  },
  textButtons: { flexDirection: "row", flexWrap: "wrap", gap: 18, marginTop: 4 },
  textControl: { minHeight: 44, justifyContent: "center" },
  textControlLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  pressed: { opacity: 0.5 },
  spacer: { flex: 1 },
  cues: { position: "absolute", left: 24, right: 24, alignItems: "center" },
  cue: {
    color: colors.text,
    fontWeight: "600",
    textAlign: "center",
    backgroundColor: "#000000A6",
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
});
