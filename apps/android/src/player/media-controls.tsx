import { t as castT } from "../cast/copy.ts";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { formatNumber } from "@mrstreamer/core/i18n";
import { languageName } from "@mrstreamer/core/ondemand/tracks";
import { Alert, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../live/catalogue.ts";
import { SheetRow, SheetTitle, TextButton } from "../live/chrome.tsx";
import { t as liveT } from "../live/copy.ts";
import { same } from "../live/model.ts";
import { lists } from "../live/runtime.ts";
import { FAVOURITES } from "../live/store.ts";
import { useStore } from "../platform/store.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import type { IconName } from "../ui/icon-button.tsx";
import { Sheet } from "../ui/sheet.tsx";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import { DIM, PlayerDialog } from "./dialog.tsx";
import { player } from "./instance.ts";
import type { MediaState } from "./media.ts";
import type { Track } from "./native.ts";
import type { Playing } from "./player.ts";
import { SIDECAR_TRACK } from "../subtitles/model.ts";
import {
  DownloadedRows,
  isSubtitleSheet,
  SubtitleSheetContent,
  subtitleSheetTitle,
  type SubtitleSheet,
} from "../subtitles/sheets.tsx";

// Watch's media controls, as Paper A's "Android media controls" page has them: the row of text
// controls under the seek bar, the countdown to the next episode in its place, the Audio,
// Subtitles, Speed and Quality sheets, and the dialogs for a refused change or a failed save.
// Every tick follows what the player reports (`player.state`), never the tap.

export type MediaSheet = "audio" | "text" | "speed" | "quality" | SubtitleSheet;

const TITLES = { audio: "Audio", text: "Subtitles", speed: "Speed", quality: "Quality" } as const;

/** What TalkBack calls the open sheet's scrim. */
const sheetTitle = (open: MediaSheet | null) =>
  isSubtitleSheet(open) ? subtitleSheetTitle(open) : t(TITLES[open ?? "audio"]);

/**
 * The row under the seek bar. Titles: Audio, Subtitles, Speed and, when the caller's resolver
 * gives one, Next episode. Live: Audio, Subtitles, Automatic where it has variants to choose from,
 * and the star. While an ended episode counts down to the next, the countdown takes its place.
 */
export function MediaRow({
  now,
  media,
  onOpen,
}: {
  now: Playing;
  media: MediaState;
  onOpen: (sheet: MediaSheet) => void;
}) {
  useLocale();

  if (media.next && media.remaining !== null)
    return <Countdown label={media.next.label} remaining={media.remaining} />;

  const quality = now.live && playable(now.tracks, "video").length >= 2;

  return (
    <View style={{ minHeight: 48, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
      <TextControl icon="music-note" label={t("Audio")} onPress={() => onOpen("audio")} />
      <TextControl icon="subtitles" label={t("Subtitles")} onPress={() => onOpen("text")} />
      {now.live ? null : (
        <TextControl
          icon="speed"
          label={now.speed === 1 ? t("Speed") : t("Speed {speed}×", { speed: times(now.speed) })}
          onPress={() => onOpen("speed")}
        />
      )}
      <View style={{ flexGrow: 1 }} />
      {quality ? (
        <TextControl
          icon="hd"
          label={
            media.automatic ? t("Automatic") : variantName(selected(now, "video")) || t("Quality")
          }
          onPress={() => onOpen("quality")}
        />
      ) : null}
      {media.next ? (
        <TextControl
          icon="skip-next"
          label={t("Next episode")}
          onPress={() => player.media.playNext()}
        />
      ) : null}
      {now.intent.kind === "live" ? <Star intent={now.intent} /> : null}
    </View>
  );
}

/** One of the row's controls: a 20dp icon and its 14sp label in a 48dp target. */
function TextControl({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        minHeight: 48,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <MaterialIcons
        importantForAccessibility="no-hide-descendants"
        name={icon}
        size={20}
        color={colors.text}
      />
      <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "500" }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Live's star for the channel that plays, as its row in Live has it. */
export function Star({ intent }: { intent: Extract<Playing["intent"], { kind: "live" }> }) {
  const saved = useStore(lists.state);
  const { focused, handlers } = useKeyboardFocus();

  if (saved.kind !== "ready") return null;
  const entry = { sourceId: intent.sourceId, channelId: intent.channelId, title: intent.title };

  const starred = !!saved.lists
    .find((list) => list.id === FAVOURITES)
    ?.entries.some((each) => same(each, entry));

  const star = () => {
    try {
      lists.member(FAVOURITES, entry, !starred);
    } catch {
      Alert.alert(
        liveT("{name} wasn't changed", { name: intent.title }),
        liveT("Couldn't save {name}", { name: intent.title }),
      );
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={liveT(starred ? "Remove from Favourites" : "Add to Favourites")}
      onPress={star}
      {...handlers}
      android_ripple={{ color: colors.ripple, borderless: true, radius: 24 }}
      style={{
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <MaterialIcons
        importantForAccessibility="no-hide-descendants"
        name={starred ? "star" : "star-border"}
        size={24}
        color={colors.text}
      />
    </Pressable>
  );
}

/** "S1 E4 · High Water  Plays in 8", Cancel and Play next. */
function Countdown({ label, remaining }: { label: string; remaining: number }) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <View
      style={{
        minHeight: 48,
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        paddingLeft: 12,
      }}
    >
      <View
        accessible
        style={{ flexGrow: 1, flexShrink: 1, flexDirection: "row", flexWrap: "wrap", gap: 12 }}
      >
        <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "500" }}>
          {label}
        </Text>
        <Text style={{ color: DIM, fontSize: 14, lineHeight: 18, fontVariant: ["tabular-nums"] }}>
          {t("Plays in {seconds}", { seconds: remaining })}
        </Text>
      </View>
      <TextButton label={t("Cancel")} onPress={() => player.media.cancelNext()} />
      <Pressable
        accessibilityRole="button"
        onPress={() => player.media.playNext()}
        {...handlers}
        android_ripple={{ color: colors.ripple }}
        style={{
          minHeight: 48,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: 16,
          paddingRight: 20,
          borderRadius: 12,
          // White already: focus shows as a step darker.
          backgroundColor: focused ? DIM : colors.text,
        }}
      >
        <MaterialIcons
          importantForAccessibility="no-hide-descendants"
          name="play-arrow"
          size={22}
          color={colors.background}
        />
        <Text style={{ color: colors.background, fontSize: 15, lineHeight: 18, fontWeight: "700" }}>
          {t("Play next")}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The open sheet: its rows with the format in a right lane, a tick on what the player reports,
 * and one grey line for the tracks this phone can't decode. Choosing a row closes it; a refusal
 * comes back as `MediaDialog`. Subtitles' Find online and Adjust timing `onOpen` their own sheets
 * in its place.
 */
export function MediaSheets({
  open,
  now,
  media,
  onOpen,
  onClose,
}: {
  open: MediaSheet | null;
  now: Playing | null;
  media: MediaState;
  onOpen: (sheet: MediaSheet) => void;
  onClose: () => void;
}) {
  useLocale();
  const title = sheetTitle(open);

  const choose = (run: () => Promise<boolean>) => () => {
    onClose();
    void run();
  };

  return (
    <Sheet visible={open !== null && now !== null} label={title} onClose={onClose} fit>
      {isSubtitleSheet(open) ? (
        now && player.subtitles ? (
          <SubtitleSheetContent
            open={open}
            now={now}
            model={player.subtitles}
            onOpen={onOpen}
            onClose={onClose}
          />
        ) : null
      ) : (
        <>
          <SheetTitle>{title}</SheetTitle>
          {now && open ? (
            <Rows open={open} now={now} media={media} choose={choose} onOpen={onOpen} />
          ) : null}
        </>
      )}
      <Foot />
    </Sheet>
  );
}

function Rows({
  open,
  now,
  media,
  choose,
  onOpen,
}: {
  open: Exclude<MediaSheet, SubtitleSheet>;
  now: Playing;
  media: MediaState;
  choose: (run: () => Promise<boolean>) => () => void;
  onOpen: (sheet: SubtitleSheet) => void;
}) {
  if (open === "speed")
    return (
      <>
        {player.media.speeds.map((speed) => (
          <SheetRow
            key={speed}
            role="radio"
            icon={now.speed === speed ? "check" : undefined}
            selected={now.speed === speed}
            label={`${times(speed)}×`}
            onPress={choose(() => player.media.speed(speed))}
          />
        ))}
      </>
    );

  // The downloaded subtitle, Find online and Adjust timing, under the file's own.
  const downloaded =
    open === "text" && player.subtitles ? (
      <DownloadedRows model={player.subtitles} choose={choose} onOpen={onOpen} />
    ) : null;

  if (!media.tracksKnown)
    return (
      <>
        <Note>{t("Not known yet. Try again in a moment.")}</Note>
        {downloaded}
      </>
    );

  const type = open === "quality" ? "video" : open;
  // The downloaded subtitle is a track the player reports too; it has its own row below.
  const all = now.tracks.filter((track) => track.type === type && track.id !== SIDECAR_TRACK);
  const supported = all.filter((track) => track.supported);
  const unplayable = all.filter((track) => !track.supported);

  const name = (track: Track) =>
    (type === "video" ? variantName(track) : null) ?? trackName(track, all.indexOf(track) + 1);

  const empty = now.live
    ? t("No choices on this channel.")
    : type === "text"
      ? t("No subtitles in this file.")
      : t("No choices in this file.");

  const sidecar = now.tracks.some((track) => track.id === SIDECAR_TRACK);

  if (!supported.length && !unplayable.length && !(type === "text" && sidecar))
    return (
      <>
        <Note>{empty}</Note>
        {downloaded}
      </>
    );

  const playing = selected(now, type);

  return (
    <>
      {type === "text" ? (
        <SheetRow
          role="radio"
          icon={playing ? undefined : "check"}
          selected={!playing}
          label={t("Off")}
          onPress={choose(() => player.subtitles?.select(null) ?? player.media.text(null))}
        />
      ) : null}
      {type === "video" ? (
        <SheetRow
          role="radio"
          icon={media.automatic ? "check" : undefined}
          selected={media.automatic}
          label={t("Automatic")}
          onPress={choose(() => player.media.quality(null))}
        />
      ) : null}
      {supported.map((track) => {
        const ticked = track.selected && (type !== "video" || !media.automatic);

        return (
          <SheetRow
            key={track.id}
            role="radio"
            icon={ticked ? "check" : undefined}
            selected={ticked}
            label={name(track)}
            trailing={
              type === "video"
                ? media.automatic && track.selected
                  ? t("Playing")
                  : undefined
                : (format(track) ?? undefined)
            }
            onPress={choose(() =>
              type === "audio"
                ? player.media.audio(track.id)
                : type === "text"
                  ? (player.subtitles?.select(track.id) ?? player.media.text(track.id))
                  : player.media.quality(track.id),
            )}
          />
        );
      })}
      {unplayable.length ? (
        <View
          style={{
            minHeight: 48,
            justifyContent: "center",
            paddingLeft: 64,
            paddingRight: 24,
            paddingVertical: 8,
          }}
        >
          <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
            {t(type === "text" ? "Can't show here: {tracks}." : "Can't play here: {tracks}.", {
              tracks: unplayable
                .map((track) => {
                  const kind = format(track);

                  return kind ? `${name(track)} (${kind})` : name(track);
                })
                .join(", "),
            })}
          </Text>
        </View>
      ) : null}
      {downloaded}
    </>
  );
}

/** The system's navigation bar under the sheet's last row, from the sheet's own window. */
function Foot() {
  return <View style={{ height: useSafeAreaInsets().bottom }} />;
}

/** A sheet's grey line where it has no rows to show. */
function Note({ children }: { children: string }) {
  return (
    <View style={{ paddingTop: 4, paddingBottom: 16, paddingHorizontal: 24 }}>
      <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

const REFUSED = "This phone refused the change. Try again.";

const DIALOGS = {
  audio: ["Couldn't change audio", REFUSED],
  text: ["Couldn't show subtitles", REFUSED],
  speed: ["Couldn't change speed", REFUSED],
  quality: ["Couldn't change quality", REFUSED],
  save: ["Couldn't save media preference", "Your previous choice is still saved. Try again."],
  read: ["Couldn't read media preferences", "Your saved choices weren't changed. Try again."],
} as const;

/**
 * A refused change or a failed save or read, with OK. The tick stays where the player reports it;
 * a save that failed is kept and tried again with the next choice, or when a sheet next opens.
 */
export function MediaDialog({ error }: { error: MediaState["error"] }) {
  useLocale();
  const dismiss = () => player.media.dismissError();

  if (!error) return null;

  if (error === "output")
    return (
      <PlayerDialog
        title={castT("Can't change playback on the TV")}
        body={castT("Play here before playing something else.")}
        closeLabel={t("OK")}
        onClose={dismiss}
        actions={<TextButton label={t("OK")} strong onPress={dismiss} />}
      />
    );
  const [title, body] = DIALOGS[error];

  return (
    <PlayerDialog
      title={t(title)}
      body={t(body)}
      closeLabel={t("OK")}
      onClose={dismiss}
      actions={<TextButton label={t("OK")} strong onPress={dismiss} />}
    />
  );
}

/** The tracks of `type` this phone decodes. */
function playable(tracks: readonly Track[], type: Track["type"]) {
  return tracks.filter((track) => track.type === type && track.supported);
}

/** The track of `type` the player reports playing, if it plays one this phone decodes. */
function selected(now: Playing, type: Track["type"]) {
  return now.tracks.find((track) => track.type === type && track.selected && track.supported);
}

/** "1.25" for 1.25, "1,25" in Dutch. */
function times(speed: number) {
  return formatNumber(speed);
}

/**
 * A sound or subtitle track in its own language, with what its media calls it when that says
 * more: "English", "English · Commentary". "Track 3", by its `number` among its type's, when
 * it names neither.
 */
function trackName(track: Track, number: number): string {
  const name = languageName(track.language);
  const label = track.label?.trim();

  if (name && label && label.toLowerCase() !== name.toLowerCase()) return `${name} · ${label}`;

  return name ?? label ?? t("Track {number}", { number });
}

/** A Live variant: "Full HD · Estuary Max FHD", from its height and its provider's name. */
function variantName(track: Track | undefined): string | null {
  if (!track) return null;
  const height = track.height;

  const size =
    height === null
      ? null
      : height >= 2160
        ? "4K"
        : height >= 1080
          ? "Full HD"
          : height >= 720
            ? "HD"
            : "SD";

  return [size, track.label?.trim()].filter(Boolean).join(" · ") || null;
}

/** Media3's sample MIME types, in the names players show. */
const FORMATS: Readonly<Record<string, string>> = {
  "audio/mp4a-latm": "AAC",
  "audio/ac3": "AC-3",
  "audio/eac3": "E-AC-3",
  "audio/eac3-joc": "E-AC-3",
  "audio/ac4": "AC-4",
  "audio/true-hd": "TrueHD",
  "audio/vnd.dts": "DTS",
  "audio/vnd.dts.hd": "DTS-HD",
  "audio/mpeg": "MP3",
  "audio/mpeg-L2": "MP2",
  "audio/opus": "Opus",
  "audio/vorbis": "Vorbis",
  "audio/flac": "FLAC",
  "audio/alac": "ALAC",
  "audio/raw": "PCM",
  "application/x-subrip": "SubRip",
  "text/vtt": "WebVTT",
  "application/x-mp4-vtt": "WebVTT",
  "text/x-ssa": "SSA",
  "application/ttml+xml": "TTML",
  "application/pgs": "PGS",
  "application/vobsub": "DVD",
  "application/dvbsubs": "DVB",
  "application/cea-608": "CEA-608",
  "application/cea-708": "CEA-708",
  "video/avc": "H.264",
  "video/hevc": "HEVC",
  "video/av01": "AV1",
  "video/x-vnd.on2.vp9": "VP9",
  "video/mpeg2": "MPEG-2",
};

/** Sound by its channels. */
const LAYOUTS: Readonly<Record<number, string>> = { 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" };

/** "E-AC-3 5.1", "AAC stereo", "SubRip"; null when its format isn't one this names. */
function format(track: Track): string | null {
  const name = track.codec ? FORMATS[track.codec] : undefined;

  if (!name) return null;

  const layout = track.type === "audio" && track.channels ? LAYOUTS[track.channels] : undefined;

  return layout ? `${name} ${layout}` : name;
}
