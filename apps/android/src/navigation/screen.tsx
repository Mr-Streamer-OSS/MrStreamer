import { router, useIsFocused } from "expo-router";
import { useEffect, useRef, type ReactNode } from "react";
import { BackHandler, useWindowDimensions, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../ui/theme.ts";
import { TopAppBar } from "../ui/top-app-bar.tsx";
import { layoutFor } from "./destinations.ts";

/** A detail pane over a screen's list: a programme, a schedule, a title. */
export interface Detail {
  /** What the bar says while the pane takes the list's place. */
  readonly title: string;
  readonly content: ReactNode;
  /** Closes the pane: the caller forgets its selection, and returns focus to its row. */
  readonly onClose: () => void;
}

/** From 840dp wide (Material's expanded window class) a detail pane shows beside its list. */
const DETAIL_BESIDE = 840;
/** The pane's width beside its list, as Paper A's tablet Guide has it. */
const DETAIL_WIDTH = 360;

/**
 * The frame of every screen on a destination's stack: its top app bar over `children`, and the
 * `detail` pane while one is selected. From 840dp the pane shows beside `children`; below, it
 * takes their place as a pushed screen would, under its own title, with TalkBack moved to that
 * title. The list stays mounted with its state, hidden from TalkBack and the keyboard; a list
 * that must keep its scroll offset restores it itself. While a pane is open, the bar's Back and
 * Android's Back close it before anything under it, whatever the width, so a selection kept in
 * the route's params survives rotation into either form. Back reaches only the screen showing.
 *
 * A feature renders its screen as `children` and pads only the insets left to it: the top app bar
 * takes the top, the navigation bar the bottom below 600dp, the rail the left from 600dp, and the
 * frame the sides, so a list padding `useSafeAreaInsets().bottom` still clears the system's
 * navigation bar beside the rail and a landscape phone's cutout never covers a row.
 */
export function Screen({
  title,
  pushed = false,
  detail,
  children,
}: {
  title: string;
  /** Opened over a destination's root, so the bar offers Back. */
  pushed?: boolean;
  detail?: Detail | undefined;
  children?: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const layout = layoutFor(width);
  const insets = useSafeAreaInsets();
  const framed = { ...insets, ...(layout === "bar" ? { bottom: 0 } : { left: 0 }) };
  const open = detail !== undefined;
  const focused = useIsFocused();
  // The latest `onClose`, so an inline one doesn't register Back again on every render.
  const close = useRef(detail?.onClose);
  useEffect(() => {
    close.current = detail?.onClose;
  });
  useEffect(() => {
    // Screens under a pushed one, and on other destinations, stay mounted: only the one showing
    // takes Back. Its listener is newer than the stacks' own, so it runs first.
    if (!open || !focused) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      close.current?.();
      return true;
    });
    return () => back.remove();
  }, [open, focused]);
  const beside = width >= DETAIL_BESIDE;
  const folded = open && !beside;
  const onBack = detail ? detail.onClose : pushed ? () => router.back() : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <TopAppBar
        title={folded ? detail.title : title}
        layout={layout}
        insets={framed}
        onBack={onBack}
        focusTitle={folded && focused}
      />
      <SafeAreaInsetsContext.Provider value={{ ...framed, top: 0, left: 0, right: 0 }}>
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            paddingLeft: framed.left,
            paddingRight: framed.right,
          }}
        >
          <View style={{ flex: 1, display: folded ? "none" : "flex" }}>{children}</View>
          {detail ? (
            <View
              style={
                beside
                  ? { width: DETAIL_WIDTH, borderLeftWidth: 1, borderColor: colors.hairline }
                  : { flex: 1 }
              }
            >
              {detail.content}
            </View>
          ) : null}
        </View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}
