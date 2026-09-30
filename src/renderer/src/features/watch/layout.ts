import { useCallback, useEffect, useRef, useState } from "react";

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
