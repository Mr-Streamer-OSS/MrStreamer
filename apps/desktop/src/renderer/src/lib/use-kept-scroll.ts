import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Spot } from "../app/ui-store.ts";

/** Where a surface stood last, and where to keep it as it goes. */
export interface Kept<Place> {
  readonly from: Place | null;
  readonly keep: (place: Place) => void;
}

export type KeptSpot = Kept<Spot>;

const TAKEN = ["wheel", "pointerdown", "touchstart"] as const;

/** Restores an offset as content arrives. Viewer input wins, including global navigation keys.
 * Until restoration finishes, leaving preserves the requested offset rather than an empty list's zero.
 */
export function useKeptScroll(
  ref: RefObject<HTMLElement | null>,
  kept: Kept<number> | undefined,
): void {
  const top = useRef(kept?.from ?? 0);
  const latest = useRef(kept);
  latest.current = kept;
  const restoring = useRef(false);

  useLayoutEffect(() => {
    const element = ref.current;
    const target = latest.current?.from ?? 0;

    if (!element || target <= 0) return;
    restoring.current = true;
    let applied = element.scrollTop;
    const resized = new ResizeObserver(() => apply());
    const changed = new MutationObserver(() => apply());

    function finish() {
      restoring.current = false;
      top.current = element!.scrollTop;
      resized.disconnect();
      changed.disconnect();

      for (const type of TAKEN) element!.removeEventListener(type, finish);
      window.removeEventListener("keydown", finish, true);
      element!.removeEventListener("scroll", moved);
    }

    function moved() {
      if (Math.abs(element!.scrollTop - applied) >= 1) finish();
    }

    function apply() {
      element!.scrollTop = target;
      applied = element!.scrollTop;

      // A measured overflowing list has its extent even if the saved offset is now beyond it.
      if (Math.abs(applied - target) < 1 || element!.scrollHeight > element!.clientHeight) finish();
    }

    for (const type of TAKEN) element.addEventListener(type, finish, { passive: true });
    window.addEventListener("keydown", finish, true);
    element.addEventListener("scroll", moved, { passive: true });
    resized.observe(element);
    changed.observe(element, { childList: true, subtree: true, attributes: true });
    apply();

    return () => {
      const pending = restoring.current;
      finish();

      if (pending) top.current = target;
    };
  }, [ref]);

  useEffect(() => {
    const element = ref.current;

    if (!element) return;

    const onScroll = () => {
      if (!restoring.current) top.current = element.scrollTop;
    };

    element.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      element.removeEventListener("scroll", onScroll);
      latest.current?.keep(top.current);
    };
  }, [ref]);
}
