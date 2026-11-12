import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Spot } from "../app/ui-store.ts";

/** Where a list stood when it was drawn last, and where to keep where it stands as it goes. */
export interface KeptSpot {
  readonly from: Spot | null;
  readonly keep: (spot: Spot) => void;
}

/** The viewer moving the list first: their place wins over the one kept. */
const TAKEN = ["wheel", "pointerdown", "keydown", "touchstart"] as const;

/**
 * Scrolls `ref`'s element back to `kept.from.top` and hands `kept.keep` where it stands, with
 * the selection `at` names, as it unmounts. Content that is drawn late, as rows that load or a
 * grid that measures its width first, is waited for: the scroll is set again as the element and
 * its content change until it reaches the place, or the viewer scrolls, clicks or types in it.
 */
export function useKeptScroll(
  ref: RefObject<HTMLElement | null>,
  kept: KeptSpot | undefined,
  at: () => Pick<Spot, "key" | "index"> = () => ({ key: null, index: 0 }),
): void {
  const top = useRef(kept?.from?.top ?? 0);
  const latest = useRef({ kept, at });
  latest.current = { kept, at };

  useLayoutEffect(() => {
    const element = ref.current;
    const target = latest.current.kept?.from?.top ?? 0;

    if (!element || target <= 0) return;
    const resized = new ResizeObserver(() => apply());
    const changed = new MutationObserver(() => apply());

    function finish() {
      resized.disconnect();
      changed.disconnect();
      for (const type of TAKEN) element!.removeEventListener(type, finish);
    }

    function apply() {
      element!.scrollTop = target;
      top.current = element!.scrollTop;

      if (Math.abs(element!.scrollTop - target) < 1) finish();
    }

    for (const type of TAKEN) element.addEventListener(type, finish, { passive: true });
    resized.observe(element);
    changed.observe(element, { childList: true, subtree: true, attributes: true });
    apply();

    return finish;
  }, [ref]);

  useEffect(() => {
    const element = ref.current;

    if (!element) return;
    const onScroll = () => {
      top.current = element.scrollTop;
    };
    element.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      element.removeEventListener("scroll", onScroll);
      latest.current.kept?.keep({ ...latest.current.at(), top: top.current });
    };
  }, [ref]);
}
