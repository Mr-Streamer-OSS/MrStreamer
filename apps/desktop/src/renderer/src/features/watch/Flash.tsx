// What a key just changed, when nothing else on screen shows it: "Speed 1.25×", "Subtitles 0.3 s
// later". It shows for a moment where a typed channel number does. A standing note shows in the
// same place for as long as it holds, such as "Subtitles loading": what a key changed shows over
// it for its moment, and then the note is back.
import { useEffect } from "react";
import { create } from "zustand";

const SHOWN_MS = 1500;

const useFlash = create<{ text: string | null; at: number; note: string | null }>(() => ({
  text: null,
  at: 0,
  note: null,
}));

/** Shows `text` for a moment, in place of anything shown before. */
export function flash(text: string): void {
  useFlash.setState({ text, at: Date.now() });
}

/** Shows `note` until another takes its place; null takes it away. */
export function flashNote(note: string | null): void {
  useFlash.setState({ note });
}

export function Flash() {
  const text = useFlash((state) => state.text);
  const at = useFlash((state) => state.at);
  const note = useFlash((state) => state.note);
  useEffect(() => {
    if (!text) return;
    const timer = setTimeout(() => useFlash.setState({ text: null }), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [text, at]);
  // A note from one view doesn't show up in the next.
  useEffect(() => () => useFlash.setState({ text: null }), []);
  const shown = text ?? note;
  if (!shown) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed top-12 right-12 z-40 rounded-3xl bg-black/80 px-6 py-4 text-2xl font-semibold tracking-tight tabular-nums ring-1 ring-white/10"
    >
      {shown}
    </div>
  );
}
