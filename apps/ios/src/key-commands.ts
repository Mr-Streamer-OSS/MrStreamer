import { useEffect, useRef } from "react";

// Hardware keyboard shortcuts, for an iPad, a Duo or an iPhone with a keyboard attached: system
// key commands (modules/key-commands), which iOS lists while ⌘ is held. The tabs offer theirs
// while Watch is closed, and Watch its own while it shows (`useShortcuts`); together they make
// the one set the native side holds. Moving between buttons is the system's own keyboard focus,
// which every button has, so no shortcut here moves focus.

/** No shortcuts, for a caller that offers none for now. */
export const NO_SHORTCUTS: readonly Shortcut<never>[] = [];

/** A key, with ⌘ when `command`, and the title iOS lists it by. */
export interface Shortcut<Id extends string> {
  readonly id: Id;
  /** A character, or a key the native side names: "leftArrow", "rightArrow" or "escape". */
  readonly input: string;
  readonly command: boolean;
  readonly title: string;
}

interface Native {
  set(shortcuts: readonly Shortcut<string>[]): void;
  addListener(
    event: "command",
    listener: (event: { readonly id: string }) => void,
  ): {
    remove(): void;
  };
}

let found: Native | null | undefined;
/**
 * The native module, found where Expo installs every module before the app's JavaScript runs;
 * null in a build without it, and in the tests, which run in Node without Expo.
 */
function native(): Native | null {
  const host: { expo?: { modules?: { KeyCommands?: Native } } } = globalThis;
  found ??= host.expo?.modules?.KeyCommands ?? null;
  return found;
}

/** Each mounted caller's shortcuts, with what runs them. */
const sets = new Map<
  symbol,
  { readonly shortcuts: readonly Shortcut<string>[]; run(id: string): void }
>();
let listening: { remove(): void } | null = null;

/** Gives the native side every mounted caller's shortcuts, as one set. */
function install() {
  const module = native();
  if (!module) return;
  module.set([...sets.values()].flatMap((each) => each.shortcuts));
  if (sets.size === 0) {
    listening?.remove();
    listening = null;
  } else {
    listening ??= module.addListener("command", ({ id }) => {
      for (const each of sets.values()) each.run(id);
    });
  }
}

/**
 * The keyboard's `shortcuts` run `run` with their id while the caller is mounted; none while
 * `shortcuts` is empty. Ids are unique across callers. Pass the same array while it stays the
 * same, as a constant, since a new one installs the set again.
 */
export function useShortcuts<Id extends string>(
  shortcuts: readonly Shortcut<Id>[],
  run: (id: Id) => void,
) {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (shortcuts.length === 0) return;
    const mine = Symbol("shortcuts");
    sets.set(mine, {
      shortcuts,
      run: (id) => {
        const shortcut = shortcuts.find((each) => each.id === id);
        if (shortcut) latest.current(shortcut.id);
      },
    });
    install();
    return () => {
      sets.delete(mine);
      install();
    };
  }, [shortcuts]);
}
