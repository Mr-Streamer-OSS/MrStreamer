import { Star } from "../player/media-controls.tsx";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { t as coreT } from "@mrstreamer/core/i18n";
import { languageName } from "@mrstreamer/core/ondemand/tracks";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Linking, Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocale } from "../live/catalogue.ts";
import { SheetTitle, TextButton } from "../live/chrome.tsx";
import { useStore } from "../platform/store.ts";
import { t as playerT } from "../player/copy.ts";
import { DIM, PlayerDialog } from "../player/dialog.tsx";
import { player } from "../player/instance.ts";
import type { OutputState } from "../player/output.ts";
import type { Playing } from "../player/player.ts";
import { SIDECAR_TRACK } from "../subtitles/model.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import { IconButton, type IconName } from "../ui/icon-button.tsx";
import { Sheet } from "../ui/sheet.tsx";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import { browseTvs, tvAvailable, useTvSearch, type Tv } from "./sender.ts";

// Play on TV on Watch, as Paper A's Android Cast page has it: the Cast button, the Play on TV
// chooser, the TV sheet with the TV's own volume, Disconnect and play here and the TVs to move
// to, Subtitles on the TV, the picture's place while the TV plays or once it stopped, and the
// dialogs for a refusal or a failed connection. Everything follows `player.cast.state`, which
// turns remote only once the TV reported PLAYING; until then the phone plays on.

/** Watch's TV sheets: the chooser or, with a TV playing, its sheet; and Subtitles on the TV. */
export type TvSheet = "tv" | "tv-text";

/** How long the chooser looks with nothing found before it says it found no TVs. */
const QUIET_MS = 10_000;

/** The output that plays, as the player's owner reports it. */
export const useOutput = () => useStore(player.cast.state);

/** Whether the TV holds playback: playing there, or stopped there until Play here. */
export const onTv = (output: OutputState) =>
  output.kind === "remote" || (output.kind === "stopped" && output.detached);

/**
 * Plays on `tv`. From a TV that holds playback it first returns it here with Play here, and only
 * once that succeeded asks the new TV; the phone plays until that TV reports it plays.
 */
export async function playOn(tv: Tv): Promise<boolean> {
  const now = player.cast.state.get();

  if (onTv(now)) {
    const back = await player.cast.playHere().catch(() => false);

    if (!back) return false;
  } else if (now.kind === "refused" || now.kind === "stopped") await settle();

  return player.cast.select(tv);
}

/** Clears a refusal or a stop the phone played through. */
function settle() {
  return player.cast.cancel().catch(() => {
    /* The owner keeps an unconfirmed drain retryable; its state says what still holds. */
  });
}

/** Returns playback to this phone from the TV. */
function playHere() {
  void player.cast.playHere().catch(() => {
    /* An uncertain drain leaves the TV state showing, so Play here can be tried again. */
  });
}

/**
 * The top bar's Cast button: the chooser with nothing on a TV, the TV sheet with one playing.
 * Absent from a build without the Cast module.
 */
export function CastButton({ onOpen }: { onOpen: (sheet: TvSheet) => void }) {
  useLocale();
  const output = useOutput();

  if (!tvAvailable()) return null;

  return (
    <IconButton
      icon={output.kind === "remote" ? "cast-connected" : "cast"}
      label={output.kind === "remote" ? t("On {tv}", { tv: output.tv.name }) : t("Play on TV")}
      onPress={() => onOpen("tv")}
    />
  );
}

/** The line under Watch's title: where it plays, or why the TV stopped. */
export function tvLine(output: OutputState): string | null {
  if (output.kind === "remote") return t("On {tv}", { tv: output.tv.name });

  if (output.kind !== "stopped" || !output.detached) return null;
  const tv = output.tv.name;

  switch (output.reason) {
    case "lost":
      return t("Lost {tv}.", { tv });
    case "failed":
      return t("{tv} couldn't play it.", { tv });
    case "restore":
      return t("Couldn't return playback to this phone. Try Play here again.");
    case "returning":
      return t("Returning playback to this phone.");
    case "taken":
      return t("Something else plays on {tv}.", { tv });
    case "stopped":
    case "ended":
      return t("{tv} stopped playing it.", { tv });
    case "foreground":
      return t("Stopped on the TV when you left the app.");
  }
}

/** The picture's place while the TV plays: its name, and to keep the app open. */
export function OnTvPanel({ tv }: { tv: Tv }) {
  useLocale();

  return <Panel title={tv.name} line={t("Keep Mr. Streamer open while it plays.")} />;
}

/** The picture's place once the TV stopped, with why. */
export function TvStoppedPanel({ output }: { output: Extract<OutputState, { kind: "stopped" }> }) {
  useLocale();
  const tv = output.tv.name;

  const line =
    output.reason === "lost"
      ? t("Check that {tv} is on and on the same Wi-Fi as this phone.", { tv })
      : output.reason === "foreground"
        ? t("{tv} stops when you leave Mr. Streamer.", { tv })
        : t("It can still play on this phone.");

  return (
    <Panel
      title={
        output.reason === "returning" ? t("Returning playback to this phone.") : t("TV stopped")
      }
      line={line}
      live
    />
  );
}

/** Paper A: a 32dp TV, an 18sp bold title and a 14sp line, centred. */
function Panel({ title, line, live = false }: { title: string; line: string; live?: boolean }) {
  return (
    <View
      accessible
      accessibilityLiveRegion={live ? "polite" : "none"}
      style={{ alignItems: "center", gap: 4 }}
    >
      <MaterialIcons
        importantForAccessibility="no-hide-descendants"
        name="tv"
        size={32}
        color={colors.text}
      />
      <Text
        style={{
          paddingTop: 4,
          color: colors.text,
          fontSize: 18,
          lineHeight: 22,
          fontWeight: "700",
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      <Text style={{ color: DIM, fontSize: 14, lineHeight: 18, textAlign: "center" }}>{line}</Text>
    </View>
  );
}

/**
 * The row under the seek bar while the TV plays: Subtitles and explicit Next/start refusals, with Live favourites.
 * Track and speed selection remain local.
 */
export function OnTvRow({ onOpen }: { onOpen: (sheet: TvSheet) => void }) {
  useLocale();

  const now = useStore(player.state);
  const media = useStore(player.media.state);

  const refuse = () => player.media.refuseOutput();

  return (
    <View style={{ minHeight: 48, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
      {media.next || media.offline?.kind === "ready" ? (
        <TextControl
          icon="skip-next"
          label={playerT("Next episode")}
          onPress={() => player.media.playNext()}
        />
      ) : null}
      {now.kind === "playing" && now.intent.kind === "live" ? (
        <>
          <TextControl icon="replay" label={t("Play from start")} onPress={refuse} />
          <Star intent={now.intent} />
        </>
      ) : null}
      <TextControl
        icon="subtitles"
        label={playerT("Subtitles")}
        onPress={() => onOpen("tv-text")}
      />
    </View>
  );
}

/** Once the TV stopped: Play here and, unless it couldn't play it, Play on that TV again. */
export function TvStoppedRow({ output }: { output: Extract<OutputState, { kind: "stopped" }> }) {
  useLocale();

  return (
    <View style={{ minHeight: 48, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
      <TextControl icon="play-arrow" label={t("Play here")} onPress={playHere} />
      {output.reason === "failed" ? null : (
        <TextControl
          icon="cast"
          label={t("Play on {tv}", { tv: output.tv.name })}
          onPress={() => void playOn(output.tv)}
        />
      )}
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

/**
 * Watch's TV sheets. Play on TV looks for TVs only while it shows; with a TV playing it is that
 * TV's sheet. A TV chosen here keeps the sheet up, Connecting, until the TV plays it.
 */
export function TvSheets({
  open,
  now,
  onClose,
}: {
  open: TvSheet | null;
  now: Playing | null;
  onClose: () => void;
}) {
  useLocale();
  const output = useOutput();
  const visible = open !== null && now !== null;

  // Once the TV plays, the chooser has done its work; a refusal or a stop shows its own words.
  // Only a change closes it, so the chooser opened from a stopped TV stays to reconnect.
  const kind = output.kind;
  const previous = useRef(kind);
  useEffect(() => {
    if (previous.current === kind) return;
    previous.current = kind;

    if (open === "tv" && (kind === "remote" || kind === "refused" || kind === "stopped")) onClose();
  }, [kind, open, onClose]);

  const back = () => {
    onClose();
    playHere();
  };

  const title =
    open === "tv-text"
      ? playerT("Subtitles")
      : output.kind === "remote"
        ? output.tv.name
        : t("Play on TV");

  return (
    <Sheet visible={visible} label={title} onClose={onClose} fit>
      {visible && now ? (
        open === "tv-text" ? (
          <OnTvSubtitles now={now} onPlayHere={back} />
        ) : output.kind === "remote" ? (
          <Connected tv={output.tv} now={now} onPlayHere={back} />
        ) : (
          <Chooser connecting={output.kind === "connecting" ? output.tv : null} />
        )
      ) : null}
      <Foot />
    </Sheet>
  );
}

/** The system's navigation bar under the sheet's last row, from the sheet's own window. */
function Foot() {
  return <View style={{ height: useSafeAreaInsets().bottom }} />;
}

/** Looks for TVs while mounted; Look again starts again. */
function useBrowsing() {
  const [round, setRound] = useState(0);
  useEffect(() => browseTvs(), [round]);
  const search = useTvSearch();
  // Nothing found for a while reads as none found; one found ends the wait.
  const [quiet, setQuiet] = useState(false);
  const empty = search.kind !== "searching" || search.tvs.length === 0;
  useEffect(() => {
    setQuiet(false);

    if (!empty) return;
    const timer = setTimeout(() => setQuiet(true), QUIET_MS);

    return () => clearTimeout(timer);
  }, [empty, round]);

  return { search, quiet, again: () => setRound((count) => count + 1) };
}

/** Play on TV: the TVs found, looking, none found, or looking failed or Android denied it. */
function Chooser({ connecting }: { connecting: Tv | null }) {
  const { search, quiet, again } = useBrowsing();
  const tvs = search.kind === "searching" ? search.tvs : [];

  const choose = (tv: Tv) => {
    if (!connecting) void playOn(tv);
  };

  return (
    <>
      <SheetTitle>{t("Play on TV")}</SheetTitle>
      {search.kind === "failed" || search.kind === "denied" ? (
        <Problem
          title={t("Can't look for TVs")}
          line={
            search.kind === "denied"
              ? t("Android didn't allow Mr. Streamer to look for TVs.")
              : t("Check that the TV is on and on the same Wi-Fi as this phone.")
          }
          actions={
            <>
              <TextButton label={t("Look again")} onPress={again} />
              {search.kind === "denied" ? (
                <TextButton
                  label={t("Open Settings")}
                  onPress={() =>
                    void Linking.openSettings().catch(() => {
                      /* Settings is the system's to open; nothing here changed. */
                    })
                  }
                />
              ) : null}
            </>
          }
        />
      ) : tvs.length ? (
        <>
          {tvs.map((tv) => (
            <TvRow
              key={tv.id}
              tv={tv}
              connecting={connecting?.id === tv.id}
              onPress={() => choose(tv)}
            />
          ))}
          <Looking more />
          <ForegroundRule indented />
        </>
      ) : quiet ? (
        <Problem
          title={t("No TVs found")}
          line={t("Check that the TV is on and on the same Wi-Fi as this phone.")}
          actions={<TextButton label={t("Look again")} onPress={again} />}
        />
      ) : (
        <>
          <Looking />
          <ForegroundRule />
        </>
      )}
    </>
  );
}

/** A TV the chooser found: Paper A's 56dp row, its model or Connecting in the right lane. */
function TvRow({
  tv,
  connecting = false,
  onPress,
}: {
  tv: Tv;
  connecting?: boolean;
  onPress: () => void;
}) {
  const trailing = connecting ? t("Connecting") : tv.model;

  return (
    <Row
      icon="tv"
      label={tv.name}
      accessibilityLabel={trailing ? `${tv.name}, ${trailing}` : tv.name}
      onPress={onPress}
    >
      {trailing ? (
        <Text
          accessibilityLiveRegion={connecting ? "polite" : "none"}
          style={{
            color: connecting ? colors.text : colors.secondary,
            fontSize: 14,
            lineHeight: 18,
            fontWeight: connecting ? "500" : "400",
          }}
        >
          {trailing}
        </Text>
      ) : null}
    </Row>
  );
}

/** A sheet's 56dp action row: a 24dp icon, a 16sp label and an optional trailing lane. */
function Row({
  icon,
  label,
  accessibilityLabel,
  onPress,
  children,
}: {
  icon: IconName;
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  children?: ReactNode;
}) {
  const { focused, handlers } = useKeyboardFocus();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple }}
      style={{
        minHeight: 56,
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        paddingHorizontal: 24,
        backgroundColor: focused ? colors.focus : undefined,
      }}
    >
      <MaterialIcons
        importantForAccessibility="no-hide-descendants"
        name={icon}
        size={24}
        color={colors.text}
      />
      <Text
        style={{
          flex: 1,
          paddingVertical: 8,
          color: colors.text,
          fontSize: 16,
          lineHeight: 20,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
      {children}
    </Pressable>
  );
}

/** Looking, as text: on its own before anything is found, under the TVs once some are. */
function Looking({ more = false }: { more?: boolean }) {
  return more ? (
    <View style={{ minHeight: 48, justifyContent: "center", paddingLeft: 64, paddingRight: 24 }}>
      <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
        {t("Looking for more on this Wi-Fi")}
      </Text>
    </View>
  ) : (
    <View
      accessibilityLiveRegion="polite"
      style={{ minHeight: 56, justifyContent: "center", paddingHorizontal: 24 }}
    >
      <Text style={{ color: colors.text, fontSize: 16, lineHeight: 20 }}>
        {t("Looking for TVs on this Wi-Fi")}
      </Text>
    </View>
  );
}

/** Foreground only: the TV plays while the app stays open. */
function ForegroundRule({ indented = false }: { indented?: boolean }) {
  return (
    <View
      style={{
        gap: 2,
        paddingTop: 12,
        paddingBottom: 8,
        paddingLeft: indented ? 64 : 24,
        paddingRight: 24,
      }}
    >
      <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18 }}>
        {t("Keep Mr. Streamer open while it plays on the TV.")}
      </Text>
      <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
        {t("Leaving the app stops playback on the TV.")}
      </Text>
      <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
        {t("The TV uses its default audio when the phone can't identify the selected track.")}
      </Text>
    </View>
  );
}

/** No TVs, or no looking: what happened, why, and its actions. */
function Problem({ title, line, actions }: { title: string; line: string; actions: ReactNode }) {
  return (
    <>
      <View
        accessible
        accessibilityLiveRegion="polite"
        style={{ gap: 4, paddingTop: 8, paddingBottom: 4, paddingHorizontal: 24 }}
      >
        <Text style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "500" }}>
          {title}
        </Text>
        <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>{line}</Text>
      </View>
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 12, paddingTop: 4 }}
      >
        {actions}
      </View>
    </>
  );
}

/** The TV sheet: what it plays, its own volume once it reported one, play here, or move. */
function Connected({ tv, now, onPlayHere }: { tv: Tv; now: Playing; onPlayHere: () => void }) {
  const { search } = useBrowsing();
  const volume = useStore(player.cast.volume);
  const others = search.kind === "searching" ? search.tvs.filter((each) => each.id !== tv.id) : [];

  return (
    <>
      <View style={{ minHeight: 56, justifyContent: "center", gap: 2, paddingHorizontal: 24 }}>
        <Text
          accessibilityRole="header"
          style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}
        >
          {tv.name}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
          {t("Playing {title}", { title: now.intent.title })}
        </Text>
      </View>
      {volume ? <VolumeRow level={volume.level} muted={volume.muted} /> : null}
      <Row icon="smartphone" label={t("Disconnect and play here")} onPress={onPlayHere} />
      <View
        style={{
          minHeight: 40,
          justifyContent: "flex-end",
          paddingBottom: 6,
          paddingHorizontal: 24,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}
        >
          {t("Move to another TV")}
        </Text>
      </View>
      {others.map((other) => (
        <TvRow key={other.id} tv={other} onPress={() => void playOn(other)} />
      ))}
      <Looking more />
    </>
  );
}

/**
 * The TV's own volume, as it last reported it. A finger moves the thumb while down and sends the
 * level when it lifts; TalkBack steps it by a tenth. The thumb then follows the TV's report.
 */
function VolumeRow({ level, muted }: { level: number; muted: boolean }) {
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const origin = useRef(0);
  const { handlers } = useKeyboardFocus();
  const shown = Math.min(1, Math.max(0, dragging ?? level));

  const at = (event: GestureResponderEvent) =>
    width > 0 ? Math.min(1, Math.max(0, (event.nativeEvent.pageX - origin.current) / width)) : 0;

  return (
    <View
      style={{
        minHeight: 56,
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        paddingHorizontal: 24,
      }}
    >
      <MaterialIcons
        importantForAccessibility="no-hide-descendants"
        name={muted ? "volume-off" : "volume-up"}
        size={24}
        color={colors.text}
      />
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t("TV volume")}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(shown * 100) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) =>
          player.cast.setVolume(level + (nativeEvent.actionName === "increment" ? 0.1 : -0.1))
        }
        {...handlers}
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(event) => {
          origin.current = event.nativeEvent.pageX - event.nativeEvent.locationX;
          setDragging(at(event));
        }}
        onResponderMove={(event) => setDragging(at(event))}
        onResponderRelease={(event) => {
          setDragging(null);
          player.cast.setVolume(at(event));
        }}
        onResponderTerminate={() => setDragging(null)}
        style={{ flex: 1, height: 48, justifyContent: "center" }}
      >
        <View
          pointerEvents="none"
          style={{ height: 4, borderRadius: 2, backgroundColor: "rgba(255, 255, 255, 0.24)" }}
        >
          <View
            style={{
              width: `${shown * 100}%`,
              height: 4,
              borderRadius: 2,
              backgroundColor: colors.text,
            }}
          />
          <View
            style={{
              position: "absolute",
              top: -6,
              left: `${shown * 100}%`,
              marginLeft: -8,
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: colors.text,
            }}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Subtitles while the TV plays. This route sends no subtitle track: a downloaded subtitle says
 * so and that it shows again here; any other says the TV offers no choice, without claiming the
 * TV can't show subtitles at all.
 */
function OnTvSubtitles({ now, onPlayHere }: { now: Playing; onPlayHere: () => void }) {
  const sidecar = now.tracks.find((track) => track.id === SIDECAR_TRACK);
  const name = sidecar ? (languageName(sidecar.language) ?? sidecar.label?.trim() ?? null) : null;

  return (
    <>
      <SheetTitle>{playerT("Subtitles")}</SheetTitle>
      <View style={{ gap: 4, paddingVertical: 8, paddingHorizontal: 24 }}>
        <Text style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "500" }}>
          {sidecar
            ? t("Downloaded subtitles don't play on the TV.")
            : t("Subtitle choices aren't available on the TV.")}
        </Text>
        {sidecar?.selected && name ? (
          <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
            {t("{track} shows again when it plays here.", { track: name })}
          </Text>
        ) : null}
      </View>
      <Row icon="smartphone" label={t("Disconnect and play here")} onPress={onPlayHere} />
    </>
  );
}

/** A refusal's reason, said before anything reached the TV; null when it couldn't connect. */
function refusal(reason: Extract<OutputState, { kind: "refused" }>["reason"]): string | null {
  switch (reason) {
    case "audio":
      return t("Mr. Streamer can't preserve the selected audio on this TV route.");
    case "playback":
      return t("The TV connected but didn't report playback.");
    case "format":
      return t("Mr. Streamer can't send this file type to a TV yet.");
    case "protected":
      return t("Mr. Streamer can't send this protected stream through this TV route.");
    case "codec":
      return t("Mr. Streamer can't send this picture or sound through this TV route yet.");
    case "stream":
      return t("Mr. Streamer can't send this channel to a TV yet.");
    case "network":
      return t("Connect this phone to Wi-Fi to play on a TV.");
    case "unreadable":
      return coreT("The connection to the provider failed.");
    case "budget":
      return t("Mr. Streamer can't confirm room for another provider stream.");
    case "unavailable":
      return null;
  }
}

/**
 * Paper A's dialog with OK where the TV never took over: a refusal, a failed connection, or a TV
 * that stopped before it played. The phone played on throughout; OK clears the state. A TV
 * connecting when the app left needs no words: the phone kept playing.
 */
export function TvDialog() {
  useLocale();
  const output = useOutput();
  const quiet = output.kind === "stopped" && !output.detached && output.reason === "foreground";
  useEffect(() => {
    if (quiet) void settle();
  }, [quiet]);

  const refused = output.kind === "refused" ? refusal(output.reason) : null;

  const shown =
    output.kind === "refused"
      ? refused
        ? {
            title: t("Can't play on {tv}", { tv: output.tv.name }),
            body: `${refused} ${t("It still plays on this phone.")}`,
          }
        : connectFailed(output.tv)
      : output.kind === "stopped" && !output.detached && !quiet
        ? output.reason === "lost"
          ? connectFailed(output.tv)
          : {
              title: t("Can't play on {tv}", { tv: output.tv.name }),
              body: `${t("{tv} couldn't play it.", { tv: output.tv.name })} ${t("It still plays on this phone.")}`,
            }
        : null;

  if (!shown) return null;
  const dismiss = () => void settle();

  return (
    <PlayerDialog
      title={shown.title}
      body={shown.body}
      closeLabel={playerT("OK")}
      onClose={dismiss}
      actions={<TextButton label={playerT("OK")} strong onPress={dismiss} />}
    />
  );
}

function connectFailed(tv: Tv) {
  return {
    title: t("Couldn't connect to {tv}", { tv: tv.name }),
    body: `${t("Check that {tv} is on and on the same Wi-Fi as this phone.", { tv: tv.name })} ${t("It still plays on this phone.")}`,
  };
}
