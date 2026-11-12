import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Spot } from "../app/ui-store.ts";

/** Where a surface stood last, and where to keep it as it goes. */
export interface Kept<Place> {
  readonly from: Place | null;
  readonly keep: (place: Place) => void;
}

export type KeptSpot = Kept<Spot>;

const TAKEN = ["wheel", "pointerdown", "touchstart"] as const;

/** Restores an offset once the caller has its content and measured geometry. Viewer input wins, including global navigation keys.
 * Until restoration finishes, leaving preserves the requested offset rather than an empty list's zero.
 * The caller keeps the element mounted for the hook's lifetime, including query errors.
 * A privacy reset clears both the current and remembered offset while keeping focus ownership mounted.
 */
export function useKeptScroll(
  ref: RefObject<HTMLElement | null>,
  kept: Kept<number> | undefined,
  ready: boolean,
  reset = false,
): void {
  const top = useRef(kept?.from ?? 0);
  const latest = useRef(kept);
  latest.current = kept;
  const restoring = useRef(false);
  const complete = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    const target = top.current;

    if (reset) {
      top.current = 0;

      if (element) element.scrollTop = 0;

      return;
    }

    if (!element || target <= 0) return;
    restoring.current = true;
    const applied = element.scrollTop;

    function finish() {
      restoring.current = false;
      top.current = element!.scrollTop;
      complete.current = null;

      for (const type of TAKEN) element!.removeEventListener(type, finish);
      window.removeEventListener("keydown", finish, true);
      element!.removeEventListener("scroll", moved);
    }

    function moved() {
      if (Math.abs(element!.scrollTop - applied) >= 1) finish();
    }

    function apply() {
      element!.scrollTop = target;

      finish();
    }

    for (const type of TAKEN) element.addEventListener(type, finish, { passive: true });
    window.addEventListener("keydown", finish, true);
    element.addEventListener("scroll", moved, { passive: true });
    complete.current = apply;

    return () => {
      const pending = restoring.current;
      finish();

      if (pending) top.current = target;
    };
  }, [ref, reset]);

  // The caller owns content and layout readiness; overflow can be only a partial result.
  useLayoutEffect(() => {
    if (ready) complete.current?.();
  }, [ready, reset]);

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
