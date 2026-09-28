import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Side bars at least this wide (in rem) keep the guide and channel details beside the picture. */
const PINNED_MIN_REM = 20;

export interface StageLayout {
  /** Width of each bar beside the 16:9 picture, in px. */
  readonly side: number;
  readonly videoWidth: number;
  /**
   * True on wide windows (a 21:9 ultrawide), where the guide and the channel details live in the
   * bars beside the picture. Otherwise they slide over it.
   */
  readonly pinned: boolean;
  /** Pixels per rem at the current window size. */
  readonly rem: number;
}

export function useStageLayout(target: RefObject<HTMLElement | null>): StageLayout {
  const [layout, setLayout] = useState<StageLayout>({
    side: 0,
    videoWidth: 0,
    pinned: false,
    rem: 16,
  });
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const update = () => {
      const { width, height } = element.getBoundingClientRect();
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const videoWidth = Math.min(width, (height * 16) / 9);
      const side = (width - videoWidth) / 2;
      setLayout({ side, videoWidth, pinned: side >= PINNED_MIN_REM * rem, rem });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);
  return layout;
}

/** True while the viewer is active; turns false after `idleMs` without mouse or keyboard input. */
export function useWake(idleMs: number): [awake: boolean, wake: () => void] {
  const [awake, setAwake] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = useCallback(() => {
    setAwake(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAwake(false), idleMs);
  }, [idleMs]);
  useEffect(() => {
    wake();
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("keydown", wake);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [wake]);
  return [awake, wake];
}

/** Whole-window full screen. */
export function useFullscreen(): [fullscreen: boolean, toggle: () => void] {
  const [fullscreen, setFullscreen] = useState(document.fullscreenElement !== null);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }, []);
  return [fullscreen, toggle];
}
