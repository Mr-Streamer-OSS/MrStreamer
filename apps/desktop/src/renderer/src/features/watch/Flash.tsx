// What a key just changed, when nothing else on screen shows it: "Speed 1.25×", "Subtitles 0.3 s
// later". It shows for a moment where a typed channel number does. A standing note shows in the
// same place for as long as it holds, such as "Subtitles loading": what a key changed shows over
// it for its moment, and then the note is back. A note that says something failed, such as
// "Subtitles unavailable", closes with its cross (CloseMessage.tsx).
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { cn } from "../../lib/utils.ts";
import { usePlayer } from "../../player/player.ts";
import { CloseMessage, useClosed } from "./CloseMessage.tsx";

const SHOWN_MS = 1500;

/** A standing note. Each one shown is its own, so closing one leaves the next to show. */
interface Note {
  readonly text: string;
  /** It says something failed, and the viewer can close it. */
  readonly failed: boolean;
}

const useFlash = create<{ text: string | null; at: number; note: Note | null }>(() => ({
  text: null,
  at: 0,
  note: null,
}));

/** Shows `text` for a moment, in place of anything shown before. */
export function flash(text: string): void {
  useFlash.setState({ text, at: Date.now() });
}

/**
 * Shows `note` until another takes its place; null takes it away. One that says something
 * `failed` has a cross that closes it.
 */
export function flashNote(note: string | null, failed = false): void {
  useFlash.setState({ note: note === null ? null : { text: note, failed } });
}

export function Flash() {
  const text = useFlash((state) => state.text);
  const at = useFlash((state) => state.at);
  const note = useFlash((state) => state.note);
  const closed = useClosed(note);
  useEffect(() => {
    if (!text) return;
    const timer = setTimeout(() => useFlash.setState({ text: null }), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [text, at]);
  // A note from one view doesn't show up in the next.
  useEffect(() => () => useFlash.setState({ text: null }), []);
  const standing = note && !closed ? note : null;
  const shown = text ?? standing?.text;
  if (!shown) return null;
  const closable = !text && standing?.failed;
  return (
    <div
      className={cn(
        "pointer-events-none fixed top-12 right-12 z-40 rounded-3xl bg-black/80 px-6 py-4 text-2xl font-semibold tracking-tight tabular-nums ring-1 ring-white/10",
        closable && "pr-14",
      )}
    >
      <div role="status">{shown}</div>
      {closable && <CloseMessage failure={standing} className="top-3 right-3" />}
    </div>
  );
}

/** Watch owns the late hint. Proof observed before this view mounted stays silent. */
export function LiveSubtitleHint() {
  const available = usePlayer((state) => state.subtitleAvailability);
  const seen = useRef(available);
  useEffect(() => {
    const previous = seen.current;
    seen.current = available;
    if (available === previous) return;
    if (!available) {
      if (useFlash.getState().text === "Subtitles available · C") useFlash.setState({ text: null });
    } else if (!available.selected && available.played > 10_000) {
      flash("Subtitles available · C");
    }
  }, [available]);
  return null;
}
