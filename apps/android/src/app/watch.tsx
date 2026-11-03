import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { AppError } from "@mrstreamer/contracts/errors";
import { t } from "@mrstreamer/core/i18n";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Pressable,
  StatusBar,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { describeFailure } from "../connect/failure.ts";
import { useStore } from "../platform/store.ts";
import { player } from "../player/instance.ts";
import { intentKey, linkedIntent } from "../player/intent.ts";
import { LIVE_RED, playPause } from "../player/mini-player.tsx";
import type { NativeFailure } from "../player/native.ts";
import type { PlaybackFailure, Playing } from "../player/player.ts";
import { PlayerSurface } from "../player/surface.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import { IconButton, type IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";

// Watch: what plays, full screen, as Paper A's Watch frame has it. It plays the intent in its
// `play` param unless that already plays, so a Watch opened again from the mini player, a link or
// a rotation carries on. Back, Android's or its own, leaves it with playback going on in the mini
// player. Controls show on a tap and hide after a few seconds of playing; they stay while
// something else is shown, and always while TalkBack runs.

/** Paper A's secondary text over the picture, a step brighter than over black. */
const DIM = "#D0D0D0";
/** Behind the round controls over the picture. */
const CONTROL = "rgba(0, 0, 0, 0.5)";
const HIDE_AFTER_MS = 4000;
const JUMP_MS = 10_000;

export default function Watch() {
  const { play } = useLocalSearchParams<{ play?: string }>();
  const intent = useMemo(() => linkedIntent(play), [play]);
  useEffect(() => {
    const now = player.state.get();
    if (intent) {
      if (now.kind === "idle" || intentKey(now.intent) !== intentKey(intent)) player.play(intent);
    } else if (now.kind === "idle") leave();
  }, [intent]);

  const state = useStore(player.state);
  // Stopped from elsewhere (the mini player's Close, a notification): nothing is left to watch.
  const played = useRef(false);
  useEffect(() => {
    if (state.kind === "playing") played.current = true;
    else if (played.current) leave();
  }, [state.kind]);
  const insets = useSafeAreaInsets();
  const reader = useScreenReader();
  const [shown, setShown] = useState(true);
  // Each touch of a control starts the wait to hide them again.
  const [touched, setTouched] = useState(0);
  const touch = () => setTouched((count) => count + 1);
  const phase = state.kind === "playing" ? state.phase : null;
  useEffect(() => {
    if (!shown || phase !== "playing") return;
    const timer = setTimeout(() => setShown(false), HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [shown, phase, touched]);
  // A finger on the seek bar keeps the controls up until it lifts.
  const [held, setHeld] = useState(false);
  const controls = shown || reader || held || phase !== "playing";
  // Rebuffering keeps play, pause and the jumps; only a start with nothing yet shows Loading.
  const loading = phase === "resolving" || phase === "preparing";

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar hidden />
      <PlayerSurface style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        onPress={() => setShown((now) => !now)}
        style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
      />
      {state.kind === "playing" && state.failure ? (
        <Failed
          failure={state.failure}
          playlist={state.intent.kind !== "file" && state.intent.sourceId.startsWith("m3u:")}
          onRetry={() => void player.retry()}
        />
      ) : loading ? (
        <Centre>
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: "500" }}
          >
            {t("Loading…")}
          </Text>
        </Centre>
      ) : null}
      {controls ? (
        <>
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              minHeight: 88 + insets.top,
              flexDirection: "row",
              alignItems: "flex-start",
              paddingTop: 8 + insets.top,
              paddingLeft: 24 + insets.left,
              paddingRight: 24 + insets.right,
              backgroundImage: "linear-gradient(180deg, rgba(0, 0, 0, 0.85), rgba(0, 0, 0, 0))",
            }}
          >
            <IconButton icon="arrow-back" label={t("Back")} onPress={leave} />
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              style={{
                flex: 1,
                minHeight: 48,
                paddingLeft: 8,
                paddingVertical: 13,
                color: colors.text,
                fontSize: 18,
                lineHeight: 22,
                fontWeight: "700",
              }}
            >
              {state.kind === "playing" ? state.intent.title : ""}
            </Text>
          </View>
          {state.kind === "playing" && !loading && !state.failure ? (
            <Centre>
              <Transport now={state} onTouch={touch} />
            </Centre>
          ) : null}
          {state.kind === "playing" && (state.live || state.seekable) ? (
            <View
              pointerEvents="box-none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                paddingTop: 24,
                paddingBottom: 12 + insets.bottom,
                paddingLeft: 24 + insets.left,
                paddingRight: 24 + insets.right,
                backgroundImage: "linear-gradient(0deg, rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0))",
              }}
            >
              <Progress now={state} onTouch={touch} onHold={setHeld} />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** Leaves Watch for the screen under it, or Live when a link opened the app here. */
function leave() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

/** Whether TalkBack or another screen reader runs, as it turns on and off. */
function useScreenReader() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setEnabled);
    const change = AccessibilityInfo.addEventListener("screenReaderChanged", setEnabled);
    return () => change.remove();
  }, []);
  return enabled;
}

/** Centres its children over the picture, leaving touches outside them to the picture. */
function Centre({ children }: { children: ReactNode }) {
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 24,
      }}
    >
      {children}
    </View>
  );
}

/** Play or pause between the 10 s jumps, which show only where the media seeks. */
function Transport({ now, onTouch }: { now: Playing; onTouch: () => void }) {
  const control = playPause(now);
  // Each press starts the wait to hide the controls again.
  const press = (run: () => void) => () => {
    onTouch();
    run();
  };
  const jump = (by: number) => {
    const to = Math.max(0, now.positionMs + by);
    void player.seek(now.durationMs === null ? to : Math.min(to, now.durationMs));
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 48 }}>
      {now.seekable ? (
        <Round
          icon="replay-10"
          label={t("Back 10 seconds")}
          size={56}
          onPress={press(() => jump(-JUMP_MS))}
        />
      ) : null}
      <Round icon={control.icon} label={control.label} size={72} onPress={press(control.run)} />
      {now.seekable ? (
        <Round
          icon="forward-10"
          label={t("Forward 10 seconds")}
          size={56}
          onPress={press(() => jump(JUMP_MS))}
        />
      ) : null}
    </View>
  );
}

/** Paper A's round control over the picture: 72dp with a 40dp icon for play and pause. */
function Round({
  icon,
  label,
  size,
  onPress,
}: {
  icon: IconName;
  label: string;
  size: number;
  onPress: () => void;
}) {
  const { focused, handlers } = useKeyboardFocus();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...handlers}
      android_ripple={{ color: colors.ripple, borderless: true, radius: size / 2 }}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: focused ? colors.focus : CONTROL,
      }}
    >
      <MaterialIcons
        importantForAccessibility="no-hide-descendants"
        name={icon}
        size={size === 72 ? 40 : 32}
        color={colors.text}
      />
    </Pressable>
  );
}

/** The Live marker, and for media that seeks its position, seek bar and duration. */
function Progress({
  now,
  onTouch,
  onHold,
}: {
  now: Playing;
  onTouch: () => void;
  onHold: (held: boolean) => void;
}) {
  const duration = now.seekable && now.durationMs ? now.durationMs : null;
  return (
    <View
      style={{
        minHeight: 48,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 12,
      }}
    >
      {now.live ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: LIVE_RED }} />
          <Text
            accessibilityLabel="Live"
            style={{
              color: colors.text,
              fontSize: 14,
              lineHeight: 18,
              fontWeight: "700",
              letterSpacing: 0.56,
            }}
          >
            LIVE
          </Text>
        </View>
      ) : null}
      {duration === null ? null : (
        <SeekBar now={now} durationMs={duration} onTouch={onTouch} onHold={onHold} />
      )}
    </View>
  );
}

/**
 * Position, a bar to drag or tap to a position, and duration. TalkBack adjusts it by 10 s.
 * While a finger is down the bar and position follow it; the seek is sent when it lifts.
 */
function SeekBar({
  now,
  durationMs,
  onTouch,
  onHold,
}: {
  now: Playing;
  durationMs: number;
  onTouch: () => void;
  onHold: (held: boolean) => void;
}) {
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  // The bar's left edge on screen, from where the finger first touched it.
  const origin = useRef(0);
  const at = (event: GestureResponderEvent) =>
    width > 0
      ? Math.min(1, Math.max(0, (event.nativeEvent.pageX - origin.current) / width)) * durationMs
      : 0;
  const position = dragging ?? Math.min(now.positionMs, durationMs);
  const seek = (to: number) => {
    onTouch();
    void player.seek(Math.min(durationMs, Math.max(0, to)));
  };
  const time = { color: DIM, fontSize: 14, lineHeight: 18, fontVariant: ["tabular-nums"] } as const;
  return (
    <>
      <Text importantForAccessibility="no" style={time}>
        {clock(position)}
      </Text>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t("Position")}
        accessibilityValue={{ text: `${clock(position)} / ${clock(durationMs)}` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={({ nativeEvent }) =>
          seek(position + (nativeEvent.actionName === "increment" ? JUMP_MS : -JUMP_MS))
        }
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(event) => {
          origin.current = event.nativeEvent.pageX - event.nativeEvent.locationX;
          onTouch();
          onHold(true);
          setDragging(at(event));
        }}
        onResponderMove={(event) => setDragging(at(event))}
        onResponderRelease={(event) => {
          setDragging(null);
          onHold(false);
          seek(at(event));
        }}
        onResponderTerminate={() => {
          setDragging(null);
          onHold(false);
        }}
        style={{ flex: 1, height: 48, justifyContent: "center" }}
      >
        <View
          pointerEvents="none"
          style={{ height: 4, borderRadius: 2, backgroundColor: "rgba(255, 255, 255, 0.24)" }}
        >
          <View
            style={{
              width: `${(position / durationMs) * 100}%`,
              height: 4,
              borderRadius: 2,
              backgroundColor: colors.text,
            }}
          />
        </View>
      </View>
      <Text importantForAccessibility="no" style={time}>
        {clock(durationMs)}
      </Text>
    </>
  );
}

/** "4:05", "1:02:09". */
function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Why it doesn't play, and Try again. */
function Failed({
  failure,
  playlist,
  onRetry,
}: {
  failure: PlaybackFailure;
  playlist: boolean;
  onRetry: () => void;
}) {
  const { headline, detail } = describePlayback(failure, playlist);
  const { focused, handlers } = useKeyboardFocus();
  return (
    <Centre>
      <View style={{ maxWidth: 480, alignItems: "center", gap: 8 }}>
        <Text
          accessibilityLiveRegion="assertive"
          style={{
            color: colors.text,
            fontSize: 18,
            lineHeight: 22,
            fontWeight: "700",
            textAlign: "center",
          }}
        >
          {headline}
        </Text>
        {detail ? (
          <Text style={{ color: DIM, fontSize: 14, lineHeight: 20, textAlign: "center" }}>
            {detail}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          {...handlers}
          android_ripple={{ color: colors.ripple }}
          style={{
            minHeight: 48,
            marginTop: 8,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 16,
            backgroundColor: focused ? colors.focus : undefined,
          }}
        >
          <MaterialIcons
            importantForAccessibility="no-hide-descendants"
            name="refresh"
            size={24}
            color={colors.text}
          />
          <Text style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" }}>
            {t("Try again")}
          </Text>
        </Pressable>
      </View>
    </Centre>
  );
}

interface Described {
  readonly headline: string;
  readonly detail: string | null;
}

/**
 * A failure in the desktop's and iOS app's words, which share their translations. `playlist`: the
 * source is a playlist link, whose refusals are more often a country's than another device's.
 */
function describePlayback(failure: PlaybackFailure, playlist: boolean): Described {
  return failure.kind === "resolve"
    ? { headline: t("Didn't start"), detail: describeResolve(failure.error) }
    : describeNative(failure.failure, playlist);
}

/** Why the address couldn't be worked out. */
function describeResolve(error: AppError): string {
  switch (error.kind) {
    case "channel-not-found":
      return t("This channel is no longer in the provider's list.");
    case "catch-up":
      return error.reason === "none"
        ? t("This channel has no catch-up.")
        : t("Catch-up on this channel goes back {count} days.", { count: error.days });
    case "title-not-found":
      return t("The provider no longer lists this title.");
    default:
      return describeFailure(error);
  }
}

/** What the native player met. Media3's own code names stay out of the screen. */
function describeNative(failure: NativeFailure, playlist: boolean): Described {
  switch (failure.kind) {
    case "network":
      return {
        headline: t("Connection lost"),
        detail: t("The connection to the provider failed."),
      };
    case "http": {
      const status = failure.status ?? 0;
      if (status === 429)
        return {
          headline: t("Provider is limiting requests"),
          detail: t(
            "The provider answered that it gets too many requests. Wait a moment before trying again.",
          ),
        };
      // As the desktop words it (features/watch/problems.ts): a check only for 401 and 403.
      if ([401, 403, 458, 509].includes(status))
        return {
          headline: t("Refused by the provider"),
          detail:
            status !== 401 && status !== 403
              ? null
              : playlist
                ? t("Some playlist channels only play in certain countries.")
                : t("If another device is watching on this subscription, stop it there first."),
        };
      if (status === 404 || status === 410)
        return { headline: t("No stream right now"), detail: null };
      return {
        headline: t("Provider error"),
        detail: t("The provider answered with HTTP {status}.", { status: String(status) }),
      };
    }
    case "file-missing":
      return { headline: t("Not available"), detail: null };
    case "format":
    case "decoder":
    case "unsupported":
    case "cleartext":
      return { headline: t("Can't play this stream"), detail: null };
    case "unexpected":
      return { headline: t("Didn't start"), detail: null };
  }
}
