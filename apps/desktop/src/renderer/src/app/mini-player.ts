// The mini player, as the views see it: whether the window is the small picture on top of others,
// and the way in and out. The main process moves the window (src/main/mini-player.ts); Watch and a
// playing title only lay themselves out smaller, with the same element, subtitles and keys, so
// the stream, its position, tracks and volume carry on untouched.
//
// It goes with the view it shrank: leaving Watch or the title, or opening search or Settings,
// which have no room in it, puts the window back.
import { create } from "zustand";
import { call } from "../lib/ipc.ts";
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

/** Shrinks the window into the mini player, leaving full screen first. */
async function enter(): Promise<void> {
  const { on, available } = useMini.getState();
  if (on || !available) return;
  fromFullScreen = Boolean(document.fullscreenElement);
  if (fromFullScreen) await document.exitFullscreen().catch(() => {});
  useMini.setState({ on: true });
  await call("window.setMiniPlayer", { on: true }).catch(() => useMini.setState({ on: false }));
}

/**
 * Puts the window back where it was, full screen again if it was; `fullScreen` says otherwise, as
 * F asks for full screen and a view closing for none.
 */
async function leave(fullScreen = fromFullScreen): Promise<void> {
  if (!useMini.getState().on) return;
  useMini.setState({ on: false });
  fromFullScreen = false;
  await call("window.setMiniPlayer", { on: false }).catch(() => {});
  if (fullScreen) void document.documentElement.requestFullscreen().catch(() => {});
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
  const shrunk = ui.watching || ui.playingTitle;
  if (useMini.getState().on && (!shrunk || ui.searchOpen || ui.settings !== null)) {
    void leave(false);
  }
});
