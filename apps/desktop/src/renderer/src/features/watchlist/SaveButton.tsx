// Save, beside Play in a title's details: a toggle that reads Saved once the title is on the
// watchlist, and takes it out when pressed again. It keeps its place and its focus either way.
import { Bookmark, Check } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import type { SaveToggle } from "../../lib/watchlist.ts";

export function SaveButton({ state }: { state: SaveToggle }) {
  return (
    <Button
      variant="secondary"
      size="lg"
      aria-pressed={state.saved}
      aria-busy={state.busy || undefined}
      disabled={!state.ready}
      onClick={state.toggle}
    >
      {state.saved ? <Check /> : <Bookmark />}
      {state.saved ? "Saved" : "Save"}
    </Button>
  );
}

/** Why the button still says what it said: the change wasn't stored. Pressing it again retries. */
export function SaveError({ state }: { state: SaveToggle }) {
  if (!state.failed) return null;
  return (
    <p className="mt-3 text-sm text-destructive">
      {state.failed === "save" ? "Couldn't save. Try again." : "Couldn't remove. Try again."}
    </p>
  );
}
