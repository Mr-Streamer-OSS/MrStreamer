import { t } from "@mrstreamer/core/i18n";
import { router, usePathname } from "expo-router";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { useEffect } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { layoutFor } from "../navigation/destinations.ts";
import { footOverlay } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { useKeyboardFocus } from "../ui/focus.ts";
import { IconButton, type IconName } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { player } from "./instance.ts";
import { watchHref } from "./intent.ts";
import type { Playing } from "./player.ts";
import { PlayerSurface } from "./surface.ts";

/** Paper A's live marker, on Watch and here. */
export const LIVE_RED = "#FF5A4E";

/** Paper A's mini player sits one step above the true black behind it. */
const RAISED = "#0A0A0A";

/** Paper A: the mini player is 64dp tall, its hairline included. */
const HEIGHT = 64;

/**
 * The phone navigation bar's height over the system's own (src/ui/navigation-bar.tsx: 79dp items
 * and their hairline), which the mini player sits on. Android's largest text still fits in 79dp.
 */
const NAVIGATION_BAR = 80;

/**
 * What the play button does for what plays: pause it, play it on (a finished title from its start),
 * or try a failed attempt again where it was. Watch and the mini player share it.
 */
export function playPause(now: Playing): { icon: IconName; label: string; run: () => void } {
  switch (now.phase) {
    case "paused":
      return { icon: "play-arrow", label: t("Play"), run: () => void player.resume() };
    case "ended":
      return { icon: "replay", label: t("Play again"), run: () => void player.resume() };
    case "failed":
      return { icon: "refresh", label: t("Try again"), run: () => player.retry() };
    default:
      return { icon: "pause", label: t("Pause"), run: () => void player.pause() };
  }
}

/**
 * What plays, kept going between screens while Watch isn't showing: its picture, title, play or
 * pause and Close, which stops it. Tapping it opens Watch again. Paper A: over the navigation bar
 * on phones, and at the foot of the content beside the rail from 600dp. The root layout mounts it
 * over the destinations; it sets `footOverlay` to its height while it shows, so the screens under
 * it scroll behind it and their last row still clears it.
 */
export function MiniPlayer() {
  const state = useStore(player.state);
  const onWatch = usePathname() === "/watch";
  const insets = useSafeAreaInsets();
  const rail = layoutFor(useWindowDimensions().width) === "rail";
  const { focused, handlers } = useKeyboardFocus();

  const showing = state.kind !== "idle" && !onWatch;
  // Hidden or gone, it no longer covers the screens' foot.
  useEffect(() => {
    if (showing) return () => footOverlay.set(0);
  }, [showing]);

  if (!showing) return null;
  const control = playPause(state);

  const status =
    state.phase === "failed"
      ? t("Didn't start")
      : state.phase === "resolving" || state.phase === "preparing"
        ? t("Loading")
        : state.live
          ? "Live"
          : null;

  return (
    <View
      onLayout={({ nativeEvent }) => footOverlay.set(nativeEvent.layout.height)}
      style={{
        position: "absolute",
        // The rail is 88dp wide past the left inset (src/ui/navigation-bar.tsx).
        left: rail ? 88 + insets.left : 0,
        right: 0,
        bottom: rail ? insets.bottom : NAVIGATION_BAR + insets.bottom,
        minHeight: HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: rail ? 16 : 12 + insets.left,
        paddingRight: (rail ? 8 : 4) + insets.right,
        borderTopWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: RAISED,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[state.intent.title, status].filter(Boolean).join(", ")}
        accessibilityHint="Opens the player"
        onPress={() => router.push(watchHref(state.intent))}
        {...handlers}
        android_ripple={{ color: colors.ripple }}
        style={{
          flex: 1,
          minHeight: 48,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          backgroundColor: focused ? colors.focus : undefined,
        }}
      >
        <View
          importantForAccessibility="no-hide-descendants"
          style={{
            width: 72,
            height: 40,
            borderRadius: 4,
            overflow: "hidden",
            backgroundColor: colors.background,
          }}
        >
          <PlayerSurface style={{ flex: 1 }} />
        </View>
        <View importantForAccessibility="no-hide-descendants" style={{ flex: 1, gap: 2 }}>
          <Text
            numberOfLines={1}
            style={{ color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "500" }}
          >
            {state.intent.title}
          </Text>
          {status ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {state.live && state.phase !== "failed" ? (
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: LIVE_RED }} />
              ) : null}
              <Text
                numberOfLines={1}
                style={{ color: colors.secondary, fontSize: 12, lineHeight: 16 }}
              >
                {status}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
      <View style={{ width: 12 }} />
      <IconButton icon={control.icon} label={control.label} onPress={control.run} />
      <IconButton
        icon="close"
        label={t("Close")}
        onPress={() => void player.stop()}
        color={colors.secondary}
      />
    </View>
  );
}
