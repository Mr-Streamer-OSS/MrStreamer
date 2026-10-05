// The mini player, as the views see it: whether the window is the small picture on top of others,
// and the way in and out. The main process moves the window (src/main/mini-player.ts); Watch and a
// playing title only lay themselves out smaller, with the same element, subtitles and keys, so
// the stream, its position, tracks and volume carry on untouched.
//
// It goes with the view it shrank: leaving Watch or the title, or opening search or Settings,
// which have no room in it, puts the window back.
import { create } from "zustand";
import { call } from "../lib/ipc.ts";
import { windowFullScreen } from "./platform.ts";
import { useUi } from "./ui-store.ts";

interface MiniPlayerState {
  /** The window is the mini player now. */
  readonly on: boolean;
  /** This platform keeps a window on top of others; null until the main process said. */
  readonly available: boolean | null;
}

const useMini = create<MiniPlayerState>(() => ({ on: false, available: null }));

/** Reads the mini player's state in a component. */
export function useMiniPlayer<T>(selector: (state: MiniPlayerState) => T): T {
  return useMini(selector);
}

/** The window was full screen before it shrank, and goes back to it. */
let fromFullScreen = false;
/**
 * Counts each time the viewer turned the window around: every way in, and every way back that
 * began. What waited for the window compares it, to learn that something else was asked of the
 * window meanwhile.
 */
let turns = 0;
/** A way in has yet to shrink the window: it lets it arrive in full screen, then leaves that. */
let entering = false;
/** The window's last way back, under way or done, which `leave` waits for when it starts none. */
let back: Promise<void> = Promise.resolve();
/** A way back's return to full screen, while it is under way; null otherwise. */
let filling: Promise<void> | null = null;

/** Whether a view the mini player shrinks is on screen. */
const shrinkable = (ui = useUi.getState()) => ui.watching || ui.playingTitle;

/** Shrinks the window into the mini player, leaving full screen first. */
async function enter(): Promise<void> {
  const { on, available } = useMini.getState();
  if (on || entering || !available) return;
  const turn = ++turns;
  // A way back that still fills the screen counts, also before the page hears of its request.
  const arriving = filling;
  const full = Boolean(document.fullscreenElement) || arriving !== null;
  // A way back this one overtakes had yet to ask for full screen, which stays owed.
  fromFullScreen ||= full;
  if (full) {
    entering = true;
    // The window gets there first. The main process can't tell a window on its way into full
    // screen from one that is not, and would shrink it under way.
    await arriving;
    if (turn === turns) await document.exitFullscreen().catch(() => {});
    // A way back was asked for meanwhile, and sees to the window: it never shrank.
    if (turn !== turns) return;
    entering = false;
  }
  useMini.setState({ on: true });
  await call("window.setMiniPlayer", { on: true }).catch(() => useMini.setState({ on: false }));
}

/**
 * Asks for full screen again and resolves once the window is there, by the main process's word
 * or when the wait for it ran out. A request that is refused, or that the page has left again by
 * the time it is granted, ends the wait at once.
 */
function fullScreenAgain(): Promise<void> {
  return new Promise((resolve) => {
    void windowFullScreen(true).then(resolve);
    document.documentElement.requestFullscreen().then(
      () => {
        if (!document.fullscreenElement) resolve();
      },
      () => resolve(),
    );
  });
}

/**
 * Puts the window back where it was, full screen again if it was; `fullScreen` says otherwise, as
 * F asks for full screen and a view closing for none.
 *
 * Resolves once the window is back, full screen included, and says whether it is still the full
 * window the caller asked for: false when the viewer asked for the mini player again meanwhile,
 * or the view closed. A call while the window is on its way back starts nothing and waits for
 * that same end, so what needs the full window, as the output chooser does, never gets ahead of
 * it. A way in that still leaves full screen stops there, and its window goes back the same.
 */
function leave(fullScreen = fromFullScreen): Promise<boolean> {
  const stopped = entering;
  if (useMini.getState().on || stopped) {
    const turn = ++turns;
    entering = false;
    fromFullScreen = fullScreen;
    useMini.setState({ on: false });
    back = (
      stopped
        ? // The window never shrank. It may still leave full screen, and can't be asked back before.
          windowFullScreen(false)
        : call("window.setMiniPlayer", { on: false }).catch(() => {})
    ).then(async () => {
      // Shrunk again meanwhile: the way back after that one sees to full screen.
      if (turn !== turns) return;
      fromFullScreen = false;
      if (!fullScreen) return;
      const arrival = fullScreenAgain();
      filling = arrival;
      await arrival;
      if (filling === arrival) filling = null;
    });
  }
  const asked = turns;
  return back.then(() => asked === turns && shrinkable());
}

export const miniPlayer = {
  enter,
  leave,
  /** P: into the mini player, or back out. */
  toggle: () => (useMini.getState().on ? leave() : enter()),
  /** Whether the window is the mini player now, for key handlers that read it once. */
  on: () => useMini.getState().on,
};

void call("window.miniPlayerAvailable")
  .then((available) => useMini.setState({ available }))
  .catch(() => useMini.setState({ available: false }));

useUi.subscribe((ui) => {
  if (useMini.getState().on && (!shrinkable(ui) || ui.searchOpen || ui.settings !== null)) {
    void leave(false);
  }
});
