import { router, usePathname } from "expo-router";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { Quality } from "@mrstreamer/contracts/library";
import {
  DEFAULT_SUBTITLE_TIMING,
  type SubtitleTiming,
} from "@mrstreamer/contracts/online-subtitles";
import { formatDecimal, formatLanguageName, formatNumber } from "@mrstreamer/core/i18n";
import { languageCode } from "@mrstreamer/core/ondemand/tracks";
import { lockAsync, OrientationLock, unlockAsync } from "expo-screen-orientation";
import { isPictureInPictureSupported, VideoAirPlayButton, VideoView } from "expo-video";
import { SymbolView } from "expo-symbols";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
} from "react";
import {
  AccessibilityInfo,
  ActionSheetIOS,
  AppState,
  Alert,
  Keyboard,
  Linking,
  PanResponder,
  Pressable,
  ScrollView,
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
import { browseTvs, tvAvailable, useTvSearch, type Tv } from "./cast.ts";
import { starChannel, useFavouriteKeys } from "./favourites.ts";
import { Glass, IconButton } from "./glass.tsx";
import { DownloadStatusButton } from "./download-status.tsx";
import { useDownloads } from "./downloads.ts";
import { guide } from "./guide.ts";
import { catchUpOf } from "./guide-screen.tsx";
import { dayLabel, localDay, programmeRange } from "./guide-ui.tsx";
import { openOnTabs, useTabs, type TabScreen } from "./header.tsx";
import { t as tvT } from "./i18n/cast.ts";
import { useLocale } from "./i18n/catalogue.ts";
import { t } from "./i18n/watch.ts";
import { NO_SHORTCUTS, useShortcuts, type Shortcut } from "./key-commands.ts";
import { startMediaControls } from "./media-controls.ts";
import type { Channel } from "./library.ts";
import { SPEEDS, useMediaPreferences, type SubtitleSize } from "./media-preferences.ts";
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
import {
  chooseSubtitle,
  findSubtitles,
  type FoundSubtitle,
  type SubtitleFailureReason,
} from "./online-subtitles.ts";
import {
  cancelUpNext,
  closeWatch,
  playbackSpeed,
  playbackState,
  request,
  onEndPictureInPicture,
  onProgressRefused,
  pictureInPicture,
  player,
  playingItem,
  playHere,
  playNext,
  playOnTv,
  playUpNext,
  type Playing,
  type TrackChoice,
  type UpNext,
  restoreFromPictureInPicture,
  retry,
  seekBy,
  seekTo,
  setAside,
  setSpeed,
  setTvVolume,
  showVersions,
  stop,
  togglePause,
  trackChoices,
  unsetAside,
  unshownSubtitles,
  usePlayback,
  usePlaybackClock,
  usePlaybackLength,
  usePlaybackSpeed,
  useTvVolume,
  useUpNext,
} from "./playback.ts";
import type { UnshownSubtitles } from "./title-formats.ts";
import { colors } from "./ui.tsx";
import { currentSource } from "./sources.ts";
import { store, useStore } from "./store.ts";
import { defined } from "@mrstreamer/core/defined";

type WatchKey = "pause" | "rewind" | "skip" | "close" | "dismiss";

/**
 * Watch's keyboard shortcuts while it shows, titled in the interface language: Space, ← and →
 * while a stream plays, Esc or ⌘. always (`still`). Made again only for a new language, which
 * installs them again with their new titles; their ids and keys stay.
 */
function shortcuts() {
  const streaming: readonly Shortcut<WatchKey>[] = [
    { id: "pause", input: " ", command: false, title: t("Play or Pause") },
    { id: "rewind", input: "leftArrow", command: false, title: t("Back 10 seconds") },
    { id: "skip", input: "rightArrow", command: false, title: t("Forward 10 seconds") },
    { id: "close", input: "escape", command: false, title: t("Close") },
    // Keyboards without Esc, as the iPad's Magic Keyboard, use ⌘. instead.
    { id: "dismiss", input: ".", command: true, title: t("Close") },
  ];

  const still = streaming.filter(
    (shortcut) => shortcut.id === "close" || shortcut.id === "dismiss",
  );

  return { streaming, still };
}

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

/**
 * Watch: the player full screen, over the tabs, with A3's controls: a close button, AirPlay,
 * Picture in Picture, Downloads and Settings at the top, and everything else in one large glass
 * panel, all showing and hiding together. Both a channel and a title add their sound and subtitle
 * tracks. A channel adds Quality, its star, which stars or unstars it and leaves what plays alone,
 * and Play from start while its catch-up keeps the programme on now.
 * A movie or an episode adds a scrubber, Speed and the next episode. It is the app's own layer
 * rather than a route, because the view that starts Picture in Picture has to stay while it plays:
 * Watch then hides, and the tabs and accessory take over. Closing it shows the screen under it, a
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
 *
 * Play on TV, in a build that can, is the TV button beside AirPlay: it opens Play on TV's sheet
 * (`TvSheet`). While a TV plays, the button is filled, Picture in Picture is off, and the picture's
 * place says which TV plays it (`OnTv`); once the TV stopped, Watch says so and offers it again.
 */
export function WatchLayer() {
  // Everything Watch shows draws again in a new language, in place: the player and its view stay.
  const locale = useLocale();
  const keys = useMemo(shortcuts, [locale]);
  const { phase, watch, pip, external, tv } = usePlayback();
  const view = useRef<VideoView>(null);
  const [controls, setControls] = useState(true);
  // Play on TV's sheet, which closes with Watch.
  const [tvSheet, setTvSheet] = useState(false);
  const closeTvSheet = useCallback(() => setTvSheet(false), []);
  useEffect(() => {
    if (!watch) setTvSheet(false);
  }, [watch]);
  // A TV playing takes the picture: there is none here for Picture in Picture to take.
  const onTv = tv.kind === "on";
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

  const pictureCanTake =
    phase.kind === "playing" && !external && !onTv && isPictureInPictureSupported();

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

  // The system's Now Playing and remote commands follow the player for the app's life.
  useEffect(() => startMediaControls(), []);
  useEffect(() => {
    onEndPictureInPicture(() => void view.current?.stopPictureInPicture());

    return () => onEndPictureInPicture(null);
  }, []);
  // A refused save of how far a title got, told by the system's alert, which stays over whatever
  // shows: Watch closed by then, or nothing playing after Stop. Once until a save is kept again.
  useEffect(() => {
    onProgressRefused(() =>
      Alert.alert(t("Couldn't save progress"), t("Your latest position could not be saved.")),
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
  // The countdown to the next episode is in the panel, so the panel shows as it starts. Leaving
  // the app ends it, or the ask for which episode it counts to.
  const counting = useUpNext() !== null;
  useEffect(() => {
    if (!counting) return;

    if (AppState.currentState === "active") setControls(true);
    else cancelUpNext();
  }, [counting]);
  useEffect(() => {
    if (!watch) return;
    const left = AppState.addEventListener("change", (now) => now !== "active" && cancelUpNext());

    return () => left.remove();
  }, [watch]);

  const streaming = phase.kind === "loading" || phase.kind === "playing" || phase.kind === "paused";
  const sheetShown = useStore(sheet);
  useShortcuts(
    !watch || sheetShown ? NO_SHORTCUTS : streaming ? keys.streaming : keys.still,
    (id) => {
      if (id === "close" || id === "dismiss") void closeWatch();
      // Space only cancels a countdown, leaving the ended episode where it ended.
      else if (id === "pause" && counting) cancelUpNext();
      else if (id === "pause") togglePause();
      else seekBy(id === "rewind" ? -10 : 10);
    },
  );

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
          allowsPictureInPicture={!onTv}
          startsPictureInPictureAutomatically={!onTv}
          onPictureInPictureStart={() => pictureInPicture(true)}
          onPictureInPictureStop={() => pictureInPicture(false)}
          onPictureInPictureRestore={({ nativeEvent }) => restore(nativeEvent.request)}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {watch && phase.kind !== "idle" ? (
        <OnTv top={insets.top + 68} bottom={insets.bottom + (controls ? 12 + panel + 12 : 24)} />
      ) : null}
      {watch ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityLabel={t(controls ? "Hide controls" : "Show controls")}
          // Hiding the panel would hide the countdown in it too, so a tap ends that first.
          onPress={() => {
            if (controls) cancelUpNext();
            setControls((shown) => !shown);
          }}
        />
      ) : null}
      {watch && streaming && item && !item.live && !onTv ? (
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
          onTv={() => setTvSheet(true)}
        />
      ) : null}
      {watch && tvSheet && phase.kind !== "idle" ? <TvSheet onClose={closeTvSheet} /> : null}
    </View>
  );
}

/** Orientation changes, made in the order asked so a quick close and reopen can't swap them. */
let turning = Promise.resolve();

function turn(change: () => Promise<void>) {
  turning = turning.then(change).catch(() => undefined);
}

/**
 * Watch's controls: the top buttons and the panel with what plays, the transport, Quality and the
 * star for a channel, the clock or scrubber, and the text-button row (Audio, Subtitles, Speed for
 * a movie or an episode, and the rest, `TextButtons`). Once a TV stopped, the panel's Play plays
 * here again and its row offers the TV again.
 */
function Controls({
  onPictureInPicture,
  screens,
  onScreen,
  onPanel,
  onTv,
}: {
  onPictureInPicture: () => void;
  /** Opens Play on TV's sheet. */
  onTv: () => void;
  /** The screens Watch can open from here. */
  screens: readonly TabScreen[];
  onScreen: (screen: TabScreen) => void;
  /** The panel's height, as it lays out. */
  onPanel: (height: number) => void;
}) {
  const { phase, tv } = usePlayback();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  if (phase.kind === "idle") return null;
  const wide = width >= 600;
  const edge = { left: insets.left + 16, right: insets.right + 16 };
  const streaming = phase.kind !== "failed";
  // The TV button stays while a TV is chosen or just stopped, so it can be left or chosen again.
  const tvButton = tvAvailable() && (streaming || tv.kind !== "off");
  const stopped = phase.kind === "failed" && tv.kind === "ended" ? tv.tv : null;

  return (
    <>
      <Glass style={[styles.circle, { top: insets.top + 12, left: edge.left }]}>
        <IconButton symbol="xmark" label={t("Close")} onPress={closeWatch} testID="watch-close" />
      </Glass>
      {streaming || tvButton || screens.length > 0 ? (
        <Glass style={[styles.capsule, { top: insets.top + 12, right: edge.right }]}>
          {/* The TV route has no item here for AirPlay to take: Disconnect and play here first. */}
          {streaming && tv.kind !== "on" ? (
            <VideoAirPlayButton
              style={styles.airplay}
              tint={colors.text}
              activeTint={colors.text}
              accessibilityLabel="AirPlay"
            />
          ) : null}
          {tvButton ? (
            <IconButton
              symbol={tv.kind === "on" ? "tv.fill" : "tv"}
              label={
                tv.kind === "on"
                  ? tvT("Playing on {tv}", { tv: tv.tv.name })
                  : tv.kind === "connecting"
                    ? tvT("Connecting to {tv}", { tv: tv.tv.name })
                    : tvT("Play on TV")
              }
              onPress={onTv}
              testID="watch-tv"
            />
          ) : null}
          {streaming && tv.kind !== "on" && isPictureInPictureSupported() ? (
            <IconButton
              symbol="pip.enter"
              label={t("Picture in Picture")}
              onPress={onPictureInPicture}
              testID="watch-pip"
            />
          ) : null}
          {screens.includes("downloads") ? (
            <DownloadStatusButton onPress={() => onScreen("downloads")} testID="watch-downloads" />
          ) : null}
          {screens.includes("settings") ? (
            <IconButton
              symbol="gearshape"
              label={t("Settings")}
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
                  ? t("Connecting")
                  : tv.kind === "on"
                    ? `${placeOf(phase.item)} · ${tvT("On {tv}", { tv: tv.tv.name })}`
                    : placeOf(phase.item)}
            </Text>
          </View>
          <View style={styles.buttons}>
            {stopped ? (
              <IconButton
                symbol="play.fill"
                label={tvT("Play here")}
                onPress={retry}
                size={32}
                testID="watch-play-here"
              />
            ) : phase.kind === "failed" ? (
              <>
                <IconButton
                  symbol="arrow.clockwise"
                  label={t("Try again")}
                  onPress={retry}
                  size={26}
                  testID="watch-retry"
                />
                {phase.item.versions ? (
                  <IconButton
                    symbol="square.stack"
                    label={t("Other versions")}
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
                  label={t("Back 10 seconds")}
                  onPress={() => seekBy(-10)}
                  size={24}
                />
                <IconButton
                  symbol={phase.kind === "paused" ? "play.fill" : "pause.fill"}
                  label={t(phase.kind === "paused" ? "Play" : "Pause")}
                  onPress={togglePause}
                  size={32}
                  testID="watch-pause"
                />
                <IconButton
                  symbol="goforward.10"
                  label={t("Forward 10 seconds")}
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
              label={t("Stop")}
              onPress={stop}
              size={22}
              testID="watch-stop"
            />
          </View>
        </View>
        {streaming ? phase.item.live ? <Clock /> : <Scrubber /> : null}
        {streaming ? <TextButtons item={phase.item} /> : null}
        {stopped ? (
          <View style={styles.textButtons}>
            <TextControl
              label={tvT("Play on {tv}", { tv: stopped.name })}
              onPress={() => playOn(stopped)}
              testID="watch-play-on-tv"
            />
          </View>
        ) : null}
      </Glass>
    </>
  );
}

/** Plays on `tv`, with the system's alert when it can't be reached. */
function playOn(tv: Tv) {
  void playOnTv(tv).then((message) => {
    if (message) Alert.alert(message);
  });
}

/**
 * The picture's place while a TV plays it: the TV's name, and that it plays while the app is
 * open. Once the TV stopped, that it did and why. Between the top buttons and the panel.
 */
function OnTv({ top, bottom }: { top: number; bottom: number }) {
  const { tv, phase } = usePlayback();

  const shown =
    tv.kind === "on" && phase.kind !== "failed"
      ? { title: tv.tv.name, line: tvT("Keep Mr. Streamer open while it plays.") }
      : tv.kind === "ended" && phase.kind === "failed"
        ? {
            title: tvT("TV stopped"),
            line:
              tv.why === "left"
                ? tvT("{tv} stops when you leave Mr. Streamer.", { tv: tv.tv.name })
                : tv.why === "stopped"
                  ? tvT("{tv} stopped playing it.", { tv: tv.tv.name })
                  : tvT("Check that {tv} is on and on the same Wi-Fi as this iPhone.", {
                      tv: tv.tv.name,
                    }),
          }
        : null;

  if (!shown) return null;

  return (
    <View pointerEvents="none" style={[styles.onTv, { top, bottom }]} testID="watch-on-tv">
      <SymbolView name="tv" size={44} tintColor={colors.text} weight="light" />
      <Text style={styles.onTvTitle}>{shown.title}</Text>
      <Text style={styles.onTvLine}>{shown.line}</Text>
    </View>
  );
}

type TvSheetKey = "tv-done" | "tv-dismiss";

/** The sheet's keys while it shows, as Watch's own: Esc, or ⌘. without one, closes it. */
function tvSheetShortcuts(): readonly Shortcut<TvSheetKey>[] {
  return [
    { id: "tv-done", input: "escape", command: false, title: tvT("Done") },
    { id: "tv-dismiss", input: ".", command: true, title: tvT("Done") },
  ];
}

/** How long the chooser looks with nothing found before it says it found no TVs. */
const QUIET_MS = 10_000;

/**
 * Play on TV's sheet, from Watch's bottom in a window under 600 points wide, as an iPhone's
 * portrait one, else a popover under the top buttons, as on an iPad. It looks for TVs while it
 * shows. With no TV playing it chooses one: the TVs found, while looking, none found, Local
 * Network off, or looking failed. With one playing it holds that TV's volume, Disconnect and play
 * here, and the other TVs to move to; a play the TV couldn't take says so first. A TV chosen here
 * closes it once it plays. Done, a tap outside, a swipe down, Esc and VoiceOver's escape close it,
 * and the keyboard is its own while it shows.
 */
function TvSheet({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const keys = useMemo(tvSheetShortcuts, [locale]);
  useShortcuts(keys, onClose);
  useEffect(() => {
    sheet.set(true);

    return () => sheet.set(false);
  }, []);
  // Look again stops looking and starts again.
  const [round, setRound] = useState(0);
  useEffect(() => browseTvs(), [round]);
  const search = useTvSearch();
  const { tv, phase } = usePlayback();
  const found = search.kind === "searching" ? search.tvs : [];
  const looking = search.kind !== "denied" && search.kind !== "failed" && found.length === 0;
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    setQuiet(false);

    if (!looking) return;
    const timer = setTimeout(() => setQuiet(true), QUIET_MS);

    return () => clearTimeout(timer);
  }, [looking, round]);
  const chosen = useRef<string | null>(null);
  useEffect(() => {
    if (tv.kind === "on" && tv.tv.id === chosen.current) onClose();
  }, [tv, onClose]);

  const choose = (to: Tv) => {
    chosen.current = to.id;
    playOn(to);
  };

  const again = () => setRound((count) => count + 1);

  const close = useRef(onClose);
  close.current = onClose;
  const [drag, setDrag] = useState(0);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, { dx, dy }) => dy > 8 && dy > Math.abs(dx),
      onPanResponderMove: (_, { dy }) => setDrag(Math.max(0, dy)),
      onPanResponderRelease: (_, { dy, vy }) => {
        setDrag(0);

        if (dy > 80 || vy > 1) close.current();
      },
      onPanResponderTerminate: () => setDrag(0),
    }),
  ).current;

  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const wide = width >= 600;
  const connected = tv.kind === "on" ? tv.tv : null;
  const others = connected ? found.filter((each) => each.id !== connected.id) : [];
  // The chooser keeps its height while it looks and lists, with the note at its foot.
  const listing = !connected && (looking ? !quiet : found.length > 0);

  const done = wide ? null : (
    <Pressable
      accessibilityRole="button"
      onPress={onClose}
      style={({ pressed }) => [styles.done, pressed && styles.pressed]}
      testID="watch-tv-done"
    >
      <Text style={styles.doneLabel}>{tvT("Done")}</Text>
    </Pressable>
  );

  const popover = insets.top + 88;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        style={[StyleSheet.absoluteFill, !wide && styles.dim]}
        onPress={onClose}
        accessible={false}
        importantForAccessibility="no"
      />
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        style={
          wide
            ? [
                styles.popover,
                {
                  top: popover,
                  right: insets.right + 16,
                  maxHeight: height - popover - insets.bottom - 16,
                },
              ]
            : [
                styles.tvSheet,
                listing && styles.tall,
                {
                  paddingBottom: insets.bottom,
                  maxHeight: height - insets.top - 24,
                  transform: [{ translateY: drag }],
                },
              ]
        }
        testID="watch-tv-sheet"
        {...(wide ? {} : pan.panHandlers)}
      >
        {wide ? null : <View style={styles.grabber} />}
        {connected ? (
          <View style={styles.sheetHeader}>
            <View style={styles.names}>
              <Text style={styles.sheetTitle} accessibilityRole="header">
                {connected.name}
              </Text>
              {phase.kind === "failed" || phase.kind === "idle" ? null : (
                <Text style={styles.sheetLine}>
                  {tvT("Playing {title}", { title: phase.item.title })}
                </Text>
              )}
            </View>
            {done}
          </View>
        ) : (
          <View style={[styles.sheetHeader, styles.chooserHeader]}>
            <Text style={[styles.sheetTitle, styles.names]} accessibilityRole="header">
              {tvT("Play on TV")}
            </Text>
            {done}
          </View>
        )}
        <ScrollView contentContainerStyle={styles.sheetBody}>
          {connected ? (
            <>
              {phase.kind === "failed" ? (
                <SheetMessage
                  title={phase.error}
                  text={tvT("It still plays on this iPhone and with AirPlay.")}
                />
              ) : null}
              <TvVolume />
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  playHere();
                  onClose();
                }}
                style={({ pressed }) => [styles.disconnect, pressed && styles.pressed]}
                testID="watch-tv-disconnect"
              >
                <Text style={styles.actionLabel}>{tvT("Disconnect and play here")}</Text>
              </Pressable>
              {others.length > 0 ? (
                <View style={styles.moveTo}>
                  <Text style={styles.moveLabel} accessibilityRole="header">
                    {tvT("Move to another TV")}
                  </Text>
                  <TvRows tvs={others} onChoose={choose} />
                </View>
              ) : null}
            </>
          ) : search.kind === "denied" ? (
            <SheetMessage
              title={tvT("Local Network is off for Mr. Streamer")}
              text={tvT("Turn it on in Settings to find TVs. AirPlay and this iPhone still play.")}
              action={{ label: tvT("Open Settings"), run: () => void Linking.openSettings() }}
            />
          ) : search.kind === "failed" ? (
            <SheetMessage
              title={tvT("Can't look for TVs")}
              text={tvT("Check that the TV is on and on the same Wi-Fi as this iPhone.")}
              action={{ label: tvT("Look again"), run: again }}
            />
          ) : found.length > 0 ? (
            <>
              <TvRows tvs={found} onChoose={choose} />
              <Text style={styles.stillLooking}>{tvT("Looking for more on this Wi-Fi")}</Text>
            </>
          ) : quiet ? (
            <SheetMessage
              title={tvT("No TVs found")}
              text={tvT("Check that the TV is on and on the same Wi-Fi as this iPhone.")}
              action={{ label: tvT("Look again"), run: again }}
            />
          ) : (
            <Text style={styles.looking} accessibilityLiveRegion="polite">
              {tvT("Looking for TVs on this Wi-Fi")}
            </Text>
          )}
          {listing ? (
            <>
              <View style={styles.spacer} />
              <View style={styles.note}>
                <Text style={styles.noteTitle}>
                  {tvT("Keep Mr. Streamer open while it plays on the TV.")}
                </Text>
                <Text style={styles.noteLine}>
                  {tvT("Leaving the app stops playback on the TV.")}
                </Text>
              </View>
            </>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

/** A state of the sheet in a few words, with what to do about it. */
function SheetMessage({ title, text, action }: { title: string; text: string; action?: Row }) {
  return (
    <View style={styles.message} accessibilityLiveRegion="polite">
      <Text style={styles.messageTitle}>{title}</Text>
      <Text style={styles.messageText}>{text}</Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={action.run}
          style={({ pressed }) => [styles.messageAction, pressed && styles.pressed]}
          testID="watch-tv-action"
        >
          <Text style={styles.actionLabel}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** TVs to choose, each by its name and model; the one connecting says so. */
function TvRows({ tvs, onChoose }: { tvs: readonly Tv[]; onChoose: (tv: Tv) => void }) {
  const { tv: route } = usePlayback();

  return tvs.map((each) => {
    const line =
      route.kind === "connecting" && route.tv.id === each.id ? tvT("Connecting") : each.model;

    return (
      <Pressable
        key={each.id}
        accessibilityRole="button"
        accessibilityLabel={line ? `${each.name}, ${line}` : each.name}
        onPress={() => onChoose(each)}
        style={({ pressed }) => [styles.tvRow, pressed && styles.pressed]}
        testID={`watch-tv-${each.id}`}
      >
        <View style={styles.tvMark}>
          <SymbolView name="tv" size={22} tintColor={colors.text} />
        </View>
        <View style={styles.tvLines}>
          <Text style={styles.tvName}>{each.name}</Text>
          {line ? <Text style={styles.sheetLine}>{line}</Text> : null}
        </View>
      </Pressable>
    );
  });
}

/**
 * The TV's own volume while it says it, on a line to drag or tap; the TV hears where the drag
 * ends. VoiceOver adjusts it a tenth at a time.
 */
function TvVolume() {
  const volume = useTvVolume();
  const [width, setWidth] = useState(1);
  const [dragged, setDragged] = useState<number | null>(null);
  const toLevel = (x: number) => Math.min(1, Math.max(0, x / width));
  const toLevelRef = useRef(toLevel);
  toLevelRef.current = toLevel;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => setDragged(toLevelRef.current(event.nativeEvent.locationX)),
      onPanResponderMove: (event) => setDragged(toLevelRef.current(event.nativeEvent.locationX)),
      onPanResponderRelease: (event) => {
        setTvVolume(toLevelRef.current(event.nativeEvent.locationX));
        setDragged(null);
      },
      onPanResponderTerminate: () => setDragged(null),
    }),
  ).current;

  if (!volume) return null;
  const level = dragged ?? (volume.muted ? 0 : volume.level);

  return (
    <View style={styles.volume}>
      <View style={styles.tvMark} accessibilityElementsHidden importantForAccessibility="no">
        <SymbolView
          name={level === 0 ? "speaker.slash.fill" : "speaker.wave.2.fill"}
          size={18}
          tintColor={colors.text}
        />
      </View>
      <View
        style={styles.scrub}
        onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width || 1)}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={tvT("TV volume")}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(level * 100) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event: AccessibilityActionEvent) =>
          setTvVolume(level + (event.nativeEvent.actionName === "increment" ? 0.1 : -0.1))
        }
        testID="watch-tv-volume"
        {...responder.panHandlers}
      >
        <View style={styles.rail}>
          <View style={[styles.filled, { width: `${level * 100}%` }]} />
        </View>
        <View style={[styles.knob, { left: level * width - 7 }]} />
      </View>
    </View>
  );
}

/**
 * The line under what plays: where a channel or title is listed, and for a programme from catch-up,
 * that it is one and when it aired, "Estuary Max · Catch-up · Today 09:00–10:00", never Live.
 */
function placeOf(item: Playing) {
  if (!item.past) return item.place;
  const day = dayLabel(localDay(item.past.start), Date.now());

  return `${item.place} · ${t("Catch-up")} · ${day} ${programmeRange(item.past)}`;
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
      label={t("Play from start")}
      accessibilityLabel={t("Play {programme} from start", { programme: programme.title })}
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
      label={t(favourite ? "Remove from Favourites" : "Add to Favourites")}
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
        title: t("Quality"),
        options: [
          ...choices.map((choice) => {
            // Automatic is the app's word; a variant's name is the provider's.
            const name =
              choice.variantId === null
                ? t("Automatic")
                : choice.quality
                  ? `${qualityNames[choice.quality]} · ${choice.name}`
                  : choice.name;

            return `${choice.saved ? "✓ " : ""}${name}${choice.playing ? ` · ${t("Playing")}` : ""}`;
          }),
          t("Cancel"),
        ],
        cancelButtonIndex: choices.length,
      },
      (index) => {
        const picked = choices[index];

        if (!picked || !stands()) return;

        if (!chooseChannelQuality(channel, item.place, picked.variantId)) {
          Alert.alert(
            t("Couldn't save media preference"),
            t("Your previous choice is still saved. Try again."),
          );
        }
      },
    );
  };

  return <TextControl label={t("Quality")} onPress={choose} testID="watch-quality" />;
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
      <Text style={styles.time}>{t("Live")}</Text>
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
        accessibilityLabel={t("Position")}
        accessibilityValue={{
          text: t("{position} of {length}", { position: clockOf(at), length: clockOf(length) }),
        }}
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
 * Audio and Subtitles, then Play from start for a live channel, or Speed and Next episode for a
 * movie or an episode: one row of text controls that wraps when it runs out of width. For a movie
 * or an episode, Subtitles also lists the subtitle downloaded for its version, with Find online
 * and, while that shows, Adjust timing. Every sheet that follows acts only while the play it was
 * opened for stands.
 * While an ended episode counts down to the next, the row is that countdown instead (`UpNextRow`).
 */
function TextButtons({ item }: { item: Playing }) {
  const upNext = useUpNext();
  // The TV plays the sound chosen before it started, no subtitles, at its own speed.
  const onTv = usePlayback().tv.kind === "on";
  // A copy's Next episode reads the downloads, so it shows again as its next copy comes or goes.
  useDownloads();
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

    // The same play still showing on Watch, though the controls may have hidden since.
    const plays = () =>
      asked.stands() &&
      playbackState.get().watch &&
      playingItem(playbackState.get().phase) === playing;

    const stands = () => menu.current === mine && plays();
    const unshown = of === "subtitles" ? unshownSubtitles() : null;
    const known = await trackChoices(of);

    if (!stands()) return;
    const choices = known ?? [];
    const none = choices.length === 0 || (choices.length === 1 && choices[0]?.kind === "off");
    const title = of === "subtitles" ? item.subtitles : undefined;

    const rows = title
      ? subtitleRows(title, choices, stands, plays)
      : choices.map((choice) => ({
          label: choice.selected ? `✓ ${choice.label}` : choice.label,
          run: () => void choice.choose(),
        }));

    const message = [
      known === null
        ? t("Not known yet. Try again in a moment.")
        : unshown && unshown.named.length > 0
          ? cantShow(unshown)
          : none
            ? t(
                item.live
                  ? "No choices on this channel."
                  : title
                    ? "No subtitles in this file."
                    : "No choices in this file.",
              )
            : null,
      title && keptSubtitle(title) ? t(IN_PLAYER_ONLY) : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    showSheet(
      {
        title: t(of === "audio" ? "Audio" : "Subtitles"),
        options: [...rows.map((row) => row.label), t("Cancel")],
        cancelButtonIndex: rows.length,
        ...defined({ message: message || undefined }),
      },
      (index) => {
        if (stands()) rows[index]?.run();
      },
    );
  };

  // Keyed by the episode, so each countdown moves VoiceOver and is announced once.
  if (upNext) return <UpNextRow key={upNext.place} {...upNext} />;

  return (
    <View style={styles.textButtons}>
      {onTv ? null : (
        <>
          <TextControl
            label={t("Audio")}
            onPress={() => void choose("audio")}
            testID="watch-audio"
          />
          <TextControl
            label={t("Subtitles")}
            onPress={() => void choose("subtitles")}
            testID="watch-subtitles"
          />
        </>
      )}
      {item.live ? (
        <StartOver item={item} />
      ) : (
        <>
          {item.past || onTv ? null : <TitleSpeed />}
          {item.next ? (
            <TextControl label={t("Next episode")} onPress={playNext} testID="watch-next" />
          ) : null}
        </>
      )}
    </View>
  );
}

/** "0.5×", "1×", "1.25×": a speed as the controls show it, written as numbers are in the language. */
const speedLabel = (rate: number) => `${formatNumber(speedNumber(rate))}×`;

/** A reported rate to two decimals at most, as 1.5 rather than 1.5000000596. */
const speedNumber = (rate: number) => Number(rate.toFixed(2));

/**
 * Speed for a movie or an episode: "Speed", or "Speed 1.5×" while the player reports another
 * speed than 1×, since a saved speed carries over to every title. Its sheet ticks the speed the
 * player reports, never the one asked for, and picks act only while the same play stands.
 */
function TitleSpeed() {
  const rate = usePlaybackSpeed();
  const menu = useRef(0);
  useEffect(
    () => () => {
      menu.current++;
    },
    [],
  );

  const choose = () => {
    const mine = ++menu.current;
    const asked = request();
    const playing = playingItem(playbackState.get().phase);

    const stands = () =>
      menu.current === mine &&
      asked.stands() &&
      playbackState.get().watch &&
      playingItem(playbackState.get().phase) === playing;

    if (!playing || !stands()) return;
    const now = playbackSpeed.get();

    const message =
      now === null
        ? t("Current speed not known yet.")
        : SPEEDS.some((speed) => speed === now)
          ? null
          : t("Playing at {speed}.", { speed: speedLabel(now) });

    showSheet(
      {
        title: t("Speed"),
        options: [
          ...SPEEDS.map((speed) => `${speed === now ? "✓ " : ""}${speedLabel(speed)}`),
          t("Cancel"),
        ],
        cancelButtonIndex: SPEEDS.length,
        ...defined({ message: message || undefined }),
      },
      (index) => {
        const picked = SPEEDS[index];

        if (picked === undefined || !stands()) return;

        if (!setSpeed(picked)) {
          Alert.alert(
            t("Couldn't save media preference"),
            t("Your previous choice is still saved. Try again."),
          );
        }
      },
    );
  };

  const other = rate !== null && rate !== 1 ? rate : null;

  return (
    <TextControl
      label={other === null ? t("Speed") : t("Speed {speed}", { speed: speedLabel(other) })}
      accessibilityLabel={
        other === null ? t("Speed") : t("Speed, {speed} times", { speed: speedNumber(other) })
      }
      onPress={choose}
      testID="watch-speed"
    />
  );
}

/**
 * The countdown to the next episode in the text-button row: "S1 E3 · Name  Plays in 8", then
 * Cancel and Play next. VoiceOver moves to Play next and hears the episode and the count once;
 * the count changing is never spoken, and Play next reads the seconds left when focused. Its
 * order is meant to be the next line, Play next, Cancel, though Cancel shows first (unproven on a
 * device, where VoiceOver may follow the screen's order instead). At large text the row
 * wraps as the text buttons do: the next line, then Cancel and Play next under it, and at the
 * largest those two stack as well, Play next first.
 */
function UpNextRow({ place, seconds }: UpNext) {
  const playButton = useRef<ComponentRef<typeof Pressable>>(null);
  const from = useRef(seconds).current;
  const spokenPlace = place.replaceAll(" · ", ", ");
  useEffect(() => {
    if (playButton.current) AccessibilityInfo.sendAccessibilityEvent(playButton.current, "focus");
    // Said after the focus moves, so it is heard in place of Play next's own line.
    AccessibilityInfo.announceForAccessibility(
      t("Next episode, {place}, plays in {count} seconds.", { place: spokenPlace, count: from }),
    );
  }, [spokenPlace, from]);

  return (
    <View style={[styles.textButtons, styles.upNext]} testID="watch-up-next">
      <View
        style={styles.nextLine}
        accessible
        accessibilityLabel={t("Next episode, {place}", { place: spokenPlace })}
      >
        <Text style={styles.nextPlace}>{place}</Text>
        <Text style={styles.nextCount}>{t("Plays in {seconds}", { seconds })}</Text>
      </View>
      {/* Reversed, so VoiceOver can reach Play next before the Cancel shown first. */}
      <View style={styles.nextActions}>
        <Pressable
          ref={playButton}
          accessibilityRole="button"
          accessibilityLabel={t("Play next")}
          accessibilityValue={{ text: t("in {count} seconds", { count: seconds }) }}
          onPress={playUpNext}
          style={({ pressed }) => [styles.playNext, pressed && styles.pressed]}
          testID="watch-play-next"
        >
          <View style={styles.playCircle}>
            <View style={styles.playTriangle} />
          </View>
          <Text style={styles.playNextLabel}>{t("Play next")}</Text>
        </Pressable>
        <TextControl label={t("Cancel")} onPress={cancelUpNext} testID="watch-up-next-cancel" />
      </View>
    </View>
  );
}

interface Row {
  readonly label: string;
  readonly run: () => void;
}

/**
 * Where a downloaded subtitle can be chosen or shown again: it is drawn over Watch's picture, and
 * the file's own are off meanwhile, so Picture in Picture and AirPlay show none.
 */
const IN_PLAYER_ONLY =
  "Downloaded subtitles show in this player only. While one is on, Picture in Picture and AirPlay show no subtitles.";

/**
 * The Subtitles sheet's rows for a movie or an episode: the file's own tracks and Off, the
 * subtitle downloaded for its version, checked while it shows, Find online, and Adjust timing
 * while one shows. While it shows, the file's own are off, so none of theirs is checked; a file
 * without Off of its own gets one that hides it. Find online acts while `plays`, the same play on
 * Watch, as its search can outlast the controls showing; the rest while `stands`.
 */
function subtitleRows(
  title: SubtitleTitle,
  choices: readonly TrackChoice[],
  stands: () => boolean,
  plays: () => boolean,
): readonly Row[] {
  const kept = keptSubtitle(title);
  const showing = shownSubtitle()?.title === title;

  return [
    ...(showing && !choices.some((choice) => choice.kind === "off")
      ? [{ label: t("Off"), run: () => hideSubtitle(title) }]
      : []),
    ...choices.map((choice) => ({
      label: choice.selected && !showing ? `✓ ${choice.label}` : choice.label,
      run: () => void choice.choose(),
    })),
    ...(kept
      ? [
          {
            label: `${showing ? "✓ " : ""}${spoken(kept.subtitle.language) || t("Subtitles")} · ${kept.subtitle.release || "SubDL"}`,
            run: () => {
              if (!showing && !showKeptSubtitle(title))
                Alert.alert(
                  t("Couldn't show subtitles"),
                  t("This iPhone refused the change. Try again."),
                );
            },
          },
        ]
      : []),
    { label: t("Find online"), run: () => void findOnline(title, plays) },
    ...(showing ? [{ label: t("Adjust timing"), run: () => adjustTiming(title, stands) }] : []),
  ];
}

/**
 * Searches SubDL for what plays and offers its results, each by language, Hearing impaired when
 * it is, and release; the one picked is downloaded, kept for the version and shown. Its sheet and
 * alerts show while `plays`.
 */
async function findOnline(title: SubtitleTitle, plays: () => boolean) {
  const found = await findSubtitles(title);

  if (!found || !plays()) return;

  if (found.kind === "failed") return serviceFailed(found.reason);
  const { results } = found;

  if (results.length === 0) {
    return Alert.alert(t("No subtitles found"), t("SubDL has none for this in your languages."));
  }

  showSheet(
    {
      title: t("Online subtitles"),
      message: t(IN_PLAYER_ONLY),
      options: [...results.map(resultName), t("Cancel")],
      cancelButtonIndex: results.length,
    },
    (index) => {
      const picked = results[index];

      if (!picked || !plays()) return;
      void chooseSubtitle(title, picked.id).then((chosen) => {
        if (chosen?.kind === "failed" && plays()) serviceFailed(chosen.reason);
      });
    },
  );
}

/** "English · Hearing impaired · Movie.2024.1080p.WEB". */
const resultName = ({ language, hearingImpaired, release }: FoundSubtitle) =>
  [
    spoken(language) || t("Unknown language"),
    ...(hearingImpaired ? [t("Hearing impaired")] : []),
    release,
  ]
    .filter(Boolean)
    .join(" · ");

/** Steps the downloaded subtitle earlier or later by, in seconds. */
const STEPS = [-1, -0.1, 0.1, 1] as const;

/** "1 s earlier", "0,1 s later": a step as Adjust timing offers it. */
const stepLabel = (by: number) =>
  t(by < 0 ? "{seconds} s earlier" : "{seconds} s later", { seconds: Math.abs(by) });

const FPS = [
  { fps: 24000 / 1001, name: "23.976" },
  { fps: 24, name: "24" },
  { fps: 25, name: "25" },
] as const;

/**
 * A subtitle timed for one frame rate over a video at another, "25 → 23.976 fps": its clock runs
 * at subtitle fps over video fps.
 */
const FRAME_RATES = FPS.flatMap((from) =>
  FPS.flatMap((to) =>
    to !== from
      ? [
          {
            label: `${from.name} → ${to.name} fps`,
            speed: from.fps / to.fps,
          },
        ]
      : [],
  ),
);

/**
 * Moves the downloaded subtitle showing over what plays a step earlier or later, converts its
 * frame rate, or puts it back with Reset, opening again after each change until Done.
 */
function adjustTiming(title: SubtitleTitle, stands: () => boolean) {
  const showing = shownSubtitle();

  if (showing?.title !== title || !stands()) return;
  const { timing } = showing;
  const retime = (next: SubtitleTiming) => retimed(title, next) && adjustTiming(title, stands);

  const changed =
    timing.offset !== DEFAULT_SUBTITLE_TIMING.offset ||
    timing.speed !== DEFAULT_SUBTITLE_TIMING.speed;

  const rows: readonly Row[] = [
    ...STEPS.map((by) => ({
      label: stepLabel(by),
      // In tenths, so steps add up without float drift.
      run: () => retime({ ...timing, offset: Math.round((timing.offset + by) * 10) / 10 }),
    })),
    { label: t("Frame rate"), run: () => frameRate(title, stands) },
    ...(changed ? [{ label: t("Reset"), run: () => retime(DEFAULT_SUBTITLE_TIMING) }] : []),
  ];

  const seconds = formatDecimal(Math.abs(timing.offset), 1);
  const rate = FRAME_RATES.find(({ speed }) => speed === timing.speed);

  const message = [
    ...(timing.offset === 0
      ? []
      : [
          t(timing.offset > 0 ? "Shown {seconds} s later" : "Shown {seconds} s earlier", {
            seconds,
          }),
        ]),
    ...(rate ? [t("Frame rate {rate}", { rate: rate.label })] : []),
  ].join(" · ");

  showSheet(
    {
      title: t("Adjust timing"),
      message: message || t("Original timing"),
      options: [...rows.map((row) => row.label), t("Done")],
      cancelButtonIndex: rows.length,
    },
    (index) => {
      if (stands()) rows[index]?.run();
    },
  );
}

/**
 * Adjust timing's frame rate: Original or a conversion, the current one checked. Picking one or
 * Cancel goes back to Adjust timing.
 */
function frameRate(title: SubtitleTitle, stands: () => boolean) {
  const showing = shownSubtitle();

  if (showing?.title !== title || !stands()) return;
  const { timing } = showing;
  const choices = [{ label: t("Original"), speed: DEFAULT_SUBTITLE_TIMING.speed }, ...FRAME_RATES];
  showSheet(
    {
      title: t("Frame rate"),
      message: t("Subtitle fps → video fps"),
      options: [
        ...choices.map(({ label, speed }) => `${speed === timing.speed ? "✓ " : ""}${label}`),
        t("Cancel"),
      ],
      cancelButtonIndex: choices.length,
    },
    (index) => {
      const picked = choices[index];

      if (!stands()) return;

      if (
        picked &&
        picked.speed !== timing.speed &&
        !retimed(title, { ...timing, speed: picked.speed })
      )
        return;
      adjustTiming(title, stands);
    },
  );
}

/** Retimes the subtitle showing, or tells the viewer it kept the previous timing. */
function retimed(title: SubtitleTitle, timing: SubtitleTiming): boolean {
  if (retimeSubtitle(title, timing)) return true;
  Alert.alert(t("Couldn't change timing"), t("The previous timing is kept."));

  return false;
}

const failures = {
  "not-configured": ["SubDL key needed", "Add your SubDL API key in Settings > Subtitles."],
  credentials: ["SubDL refused the key", "Check your SubDL API key in Settings > Subtitles."],
  quota: ["SubDL limit reached", "Your SubDL key has no requests left for now. Try again later."],
  unavailable: ["SubDL isn't available", "Check your connection and try again."],
  unsupported: ["Can't use this subtitle", "It isn't text the app can read. Try another."],
  keychain: ["Couldn't read your SubDL key", "This iPhone didn't give it. Try again."],
  "not-saved": ["Couldn't keep this subtitle", "This iPhone refused to save it. Try again."],
} as const satisfies Record<SubtitleFailureReason | "not-saved", readonly [string, string]>;

const serviceFailed = (reason: SubtitleFailureReason | "not-saved") => {
  const [title, message] = failures[reason];
  Alert.alert(t(title), t(message));
};

/**
 * The downloaded subtitle showing over the movie or episode playing, drawn over the picture at
 * the viewer's text size, which Dynamic Type scales. Nothing for another play's.
 */
function Cues({ item, bottom }: { item: Playing; bottom: number }) {
  const shown = useShownSubtitle();

  if (!shown || shown.title !== item.subtitles) return null;

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
    const details = [format ?? t("unknown format"), ...(forced ? [t("forced")] : [])].join(", ");

    return `${spoken(language) ?? t("Unknown language")} (${details})`;
  });

  return more > 0
    ? t("Can't show here: {tracks} and {more} more.", { tracks: tracks.join(", "), more })
    : t("Can't show here: {tracks}.", { tracks: tracks.join(", ") });
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
  upNext: { alignItems: "center" },
  nextLine: {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: 12,
  },
  nextPlace: { flexShrink: 1, color: colors.text, fontSize: 15, fontWeight: "600" },
  nextCount: { color: colors.text, fontSize: 15, fontVariant: ["tabular-nums"] },
  // Wraps too, so Cancel and Play next stay inside a narrow panel at the largest text.
  nextActions: {
    flexShrink: 1,
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 18,
  },
  playNext: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10 },
  playCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  // Play's triangle, 12 by 14, drawn by its borders.
  playTriangle: {
    borderLeftWidth: 12,
    borderLeftColor: "#000000",
    borderTopWidth: 7,
    borderTopColor: "transparent",
    borderBottomWidth: 7,
    borderBottomColor: "transparent",
  },
  playNextLabel: { color: colors.text, fontSize: 15, fontWeight: "700" },
  pressed: { opacity: 0.5 },
  spacer: { flex: 1 },
  onTv: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 32,
  },
  onTvTitle: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.28,
    textAlign: "center",
  },
  onTvLine: { color: colors.dim, fontSize: 15, textAlign: "center" },
  dim: { backgroundColor: "#00000099" },
  tvSheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.fill,
    borderTopLeftRadius: 38,
    borderTopRightRadius: 38,
    paddingTop: 6,
  },
  tall: { minHeight: 440 },
  popover: {
    position: "absolute",
    width: 360,
    backgroundColor: colors.fill,
    borderRadius: 20,
    paddingTop: 6,
    paddingBottom: 10,
    shadowColor: "#000000",
    shadowOpacity: 0.6,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#5A5A5E",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  chooserHeader: { paddingBottom: 6 },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  sheetLine: { color: colors.dim, fontSize: 13, marginTop: 2 },
  done: { minHeight: 44, justifyContent: "center" },
  doneLabel: { color: colors.text, fontSize: 17, fontWeight: "600" },
  sheetBody: { flexGrow: 1 },
  looking: { color: colors.text, fontSize: 15, paddingHorizontal: 16, paddingTop: 18 },
  stillLooking: {
    color: colors.dim,
    fontSize: 13,
    paddingLeft: 60,
    paddingRight: 16,
    paddingTop: 12,
  },
  note: { gap: 4, paddingHorizontal: 16, paddingTop: 12 },
  noteTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  noteLine: { color: colors.dim, fontSize: 13 },
  message: { gap: 4, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 16 },
  messageTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  messageText: { color: colors.dim, fontSize: 15 },
  messageAction: { minHeight: 44, justifyContent: "center", paddingTop: 4 },
  actionLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  tvRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16 },
  tvMark: { width: 32, height: 44, alignItems: "center", justifyContent: "center" },
  tvLines: {
    flex: 1,
    minWidth: 0,
    minHeight: 60,
    justifyContent: "center",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  tvName: { color: colors.text, fontSize: 17 },
  volume: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  disconnect: { minHeight: 44, justifyContent: "center", paddingLeft: 60, paddingRight: 16 },
  moveTo: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 14 },
  moveLabel: { color: colors.dim, fontSize: 13, paddingHorizontal: 16, paddingBottom: 2 },
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
