// The mini player: the app's own window shrinks to a small picture in a corner of the screen and
// stays on top of other windows, then goes back where and as it was. The picture, its subtitles
// and its keys are the window's own, so nothing about playback changes; only the window moves.
//
// Documented BrowserWindow calls only. Platforms differ: macOS needs the window on every space,
// full-screen ones included, and hides it and the Dock icon for a moment each time that changes;
// Windows needs only always on top; Wayland keeps no window on top, so the app doesn't offer it.
import { app, screen, type BrowserWindow, type Rectangle } from "electron";
import { WINDOW_BAR } from "../shared/window-bar.ts";

const isMac = process.platform === "darwin";

/** The window's smallest size in the mini player, and how far it sits from the screen's edges. */
const MINI = { minWidth: 320, minHeight: 180, margin: 24 } as const;
/** Pictures are 16:9 far more often than not; the window keeps that shape while resized. */
const ASPECT = 16 / 9;
/** The height of the Windows and Linux window buttons over the mini player's corner. */
const MINI_BAR_HEIGHT = 32;
/** How long to wait for the window to leave full screen before shrinking it anyway. */
const LEAVE_FULL_SCREEN_MS = 2000;

/** Whether this platform keeps a window on top of others. Wayland doesn't let Electron. */
export function miniPlayerAvailable(): boolean {
  if (process.platform !== "linux") return true;
  const ozone = app.commandLine.getSwitchValue("ozone-platform");
  if (ozone) return ozone !== "wayland";
  return process.env["XDG_SESSION_TYPE"] !== "wayland" && !process.env["WAYLAND_DISPLAY"];
}

/**
 * The mini player of one window. `set(true)` remembers the window's place and state and shrinks
 * it into the bottom right corner of its screen, or where the viewer left the mini player before;
 * `set(false)` puts it back. Calls take turns, so a quick second one waits for the window to leave
 * full screen before it undoes the first.
 */
export function miniPlayer(window: BrowserWindow, normal: { minWidth: number; minHeight: number }) {
  let before: { readonly bounds: Rectangle; readonly maximized: boolean } | null = null;
  /** Where the viewer moved and sized the mini player last, for the next time. */
  let last: Rectangle | null = null;
  let turn = Promise.resolve();

  /** Leaves full screen first, which on macOS takes an animation, so the size sticks. */
  const leaveFullScreen = () =>
    new Promise<void>((resolve) => {
      if (!window.isFullScreen()) return resolve();
      const timer = setTimeout(resolve, LEAVE_FULL_SCREEN_MS);
      window.once("leave-full-screen", () => {
        clearTimeout(timer);
        resolve();
      });
      window.setFullScreen(false);
    });

  /** The bottom right corner of the screen the window is on, a quarter of its width. */
  const corner = (): Rectangle => {
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const width = Math.round(Math.min(640, Math.max(400, area.width / 4)));
    const height = Math.round(width / ASPECT);
    return {
      x: area.x + area.width - width - MINI.margin,
      y: area.y + area.height - height - MINI.margin,
      width,
      height,
    };
  };

  async function apply(on: boolean): Promise<void> {
    if (window.isDestroyed() || on === (before !== null)) return;
    if (on) {
      await leaveFullScreen();
      before = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
      if (before.maximized) window.unmaximize();
      window.setMinimumSize(MINI.minWidth, MINI.minHeight);
      window.setAspectRatio(ASPECT);
      window.setBounds(last ?? corner());
      window.setMaximizable(false);
      window.setAlwaysOnTop(true, "floating");
      if (isMac) {
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.setWindowButtonVisibility(false);
      } else {
        window.setTitleBarOverlay({ height: MINI_BAR_HEIGHT });
      }
      return;
    }
    const { bounds, maximized } = before ?? { bounds: window.getBounds(), maximized: false };
    before = null;
    last = window.getBounds();
    window.setAlwaysOnTop(false);
    if (isMac) {
      window.setVisibleOnAllWorkspaces(false);
      window.setWindowButtonVisibility(true);
    } else {
      window.setTitleBarOverlay({ height: WINDOW_BAR.height });
    }
    window.setMaximizable(true);
    window.setAspectRatio(0);
    window.setMinimumSize(normal.minWidth, normal.minHeight);
    window.setBounds(bounds);
    if (maximized) window.maximize();
  }

  return {
    set(on: boolean): Promise<void> {
      const next = turn.then(() => apply(on));
      // A turn that failed, as when the window closed meanwhile, doesn't stop the next one.
      turn = next.catch(() => {});
      return next;
    },
  };
}
