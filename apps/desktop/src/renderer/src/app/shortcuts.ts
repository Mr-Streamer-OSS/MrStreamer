import type { Preferences } from "@mrstreamer/contracts/preferences";
import { isTyping } from "./platform.ts";

export type ShortcutOverrides = NonNullable<Preferences["keyboardShortcuts"]>;

export type ShortcutSurface = "live" | "title";

// Commands share identity across both players; navigation retains its own fixed keys.
// A `shift` command also runs with Shift held on a letter, Space or arrow it is bound to, remapped or
// not; title subtitle timing reads that Shift as its larger step.
export const shortcutCommands = [
  {
    id: "pause",
    label: "Play or pause",
    live: ["Space", "k"],
    title: ["Space", "k"],
    shift: true,
    repeat: false,
  },
  {
    id: "seekBack",
    label: "Skip backward",
    live: ["j"],
    title: ["ArrowLeft"],
    shift: true,
    repeat: true,
  },
  {
    id: "seekForward",
    label: "Skip forward",
    live: ["l"],
    title: ["ArrowRight"],
    shift: true,
    repeat: true,
  },
  {
    id: "fullscreen",
    label: "Full screen",
    live: ["f"],
    title: ["f"],
    shift: false,
    repeat: false,
  },
  { id: "miniPlayer", label: "Mini player", live: ["p"], title: ["p"], shift: true, repeat: false },
  { id: "output", label: "Play on", live: ["o"], title: ["o"], shift: true, repeat: false },
  { id: "mute", label: "Mute", live: ["m"], title: ["m"], shift: false, repeat: false },
  { id: "subtitles", label: "Subtitles", live: ["c"], title: ["c"], shift: false, repeat: false },
  {
    id: "subtitlesEarlier",
    label: "Subtitles earlier",
    live: ["g"],
    title: ["g"],
    shift: true,
    repeat: true,
  },
  {
    id: "subtitlesLater",
    label: "Subtitles later",
    live: ["h"],
    title: ["h"],
    shift: true,
    repeat: true,
  },
  { id: "info", label: "Show controls", live: ["i"], title: [], shift: false, repeat: false },
  {
    id: "favourite",
    label: "Favourite channel",
    live: ["s"],
    title: [],
    shift: true,
    repeat: false,
  },
  { id: "quality", label: "Choose quality", live: ["q"], title: [], shift: false, repeat: false },
  { id: "retry", label: "Retry channel", live: ["r"], title: [], shift: true, repeat: false },
  { id: "volumeUp", label: "Volume up", live: [], title: ["ArrowUp"], shift: true, repeat: true },
  {
    id: "volumeDown",
    label: "Volume down",
    live: [],
    title: ["ArrowDown"],
    shift: true,
    repeat: true,
  },
  { id: "nextEpisode", label: "Next episode", live: [], title: ["n"], shift: false, repeat: false },
  { id: "slower", label: "Play slower", live: [], title: ["<"], shift: false, repeat: true },
  { id: "faster", label: "Play faster", live: [], title: [">"], shift: false, repeat: true },
] as const;

export type ShortcutCommand = (typeof shortcutCommands)[number]["id"];

/** Canonical key names use event.key, so letters follow the viewer's keyboard layout. */
export function shortcutBinding(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">,
): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const key =
    event.key === " " ? "Space" : event.key.length === 1 ? event.key.toLowerCase() : event.key;

  if (["Shift", "Control", "Alt", "Meta", "Dead", "Unidentified", "Process"].includes(key))
    return null;

  // Shift is already expressed by punctuation such as < and >.
  return event.shiftKey && (key.length > 1 || /^[a-z]$/.test(key)) ? `Shift+${key}` : key;
}

const definitionOf = (command: ShortcutCommand) =>
  shortcutCommands.find((entry) => entry.id === command)!;

/** A `shift` command's letters, Space and arrows also run with Shift held. */
function withShift(command: ShortcutCommand, bindings: readonly string[]): readonly string[] {
  if (!definitionOf(command).shift) return bindings;

  return bindings.flatMap((binding) =>
    /^(?:[a-z]|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(binding)
      ? [binding, `Shift+${binding}`]
      : [binding],
  );
}

function rawShortcutBindings(
  command: ShortcutCommand,
  surface: ShortcutSurface,
  overrides: ShortcutOverrides = {},
): readonly string[] {
  const defaults = definitionOf(command)[surface];

  if (!defaults.length) return [];

  return withShift(command, overrides[command] ?? defaults);
}

// Live TV keeps these for channel-list navigation, with or without Shift.
const LIVE_NAVIGATION = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

/** Returns a reason the editor can announce; replacement frees all of a command's old keys. */
export function validateShortcut(
  command: ShortcutCommand,
  binding: string,
  overrides: ShortcutOverrides = {},
): { kind: "reserved" } | { kind: "conflict"; command: ShortcutCommand } | null {
  const definition = definitionOf(command);

  // Digits pick Live channels; \w excludes them from the punctuation branch.
  if (
    !/^(?:(?:Shift\+)?(?:[a-z]|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)|[^\w\s])$/.test(
      binding,
    ) ||
    (definition.live.length > 0 && LIVE_NAVIGATION.includes(binding.replace(/^Shift\+/, "")))
  )
    return { kind: "reserved" };
  const candidates = withShift(command, [binding]);

  for (const other of shortcutCommands) {
    if (other.id === command) continue;

    for (const surface of ["live", "title"] as const) {
      if (
        definition[surface].length &&
        rawShortcutBindings(other.id, surface, overrides).some((taken) =>
          candidates.includes(taken),
        )
      )
        return { kind: "conflict", command: other.id };
    }
  }

  return null;
}

/** Validate the complete resulting configuration, including defaults restored by a reset. */
export function shortcutProblem(overrides: ShortcutOverrides) {
  for (const command of shortcutCommands) {
    const bindings = overrides[command.id] ?? [...command.live, ...command.title];

    for (const binding of bindings) {
      const problem = validateShortcut(command.id, binding, overrides);

      // Title seek defaults use arrows that Live commands cannot accept as remaps.
      if (problem && (overrides[command.id] || problem.kind === "conflict"))
        return { binding, problem };
    }
  }

  return null;
}

/** Reference and dispatch share effective keys; stored overrides stay available for repair. */
export function shortcutBindings(
  command: ShortcutCommand,
  surface: ShortcutSurface,
  overrides: ShortcutOverrides = {},
): readonly string[] {
  return rawShortcutBindings(command, surface, shortcutProblem(overrides) ? {} : overrides);
}

/** Shared input guard also protects fixed player navigation and native control activation. */
export function blocksPlayerShortcut(event: KeyboardEvent): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    isTyping(event)
  )
    return true;
  const target = event.target;

  if (!(target instanceof Element)) return false;

  if (
    target.closest(
      '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [role="slider"]',
    )
  )
    return true;

  return [" ", "Enter"].includes(event.key) && !!target.closest('button, a[href], [role="button"]');
}

/** Invalid stored overrides fail closed to the defaults, never stealing a reserved key. */
export function resolveShortcut(
  event: KeyboardEvent,
  surface: ShortcutSurface,
  overrides: ShortcutOverrides = {},
): ShortcutCommand | null {
  if (blocksPlayerShortcut(event)) return null;
  const binding = shortcutBinding(event);

  if (!binding) return null;

  const effective = shortcutProblem(overrides) ? {} : overrides;

  for (const command of shortcutCommands) {
    if (event.repeat && !command.repeat) continue;

    if (rawShortcutBindings(command.id, surface, effective).includes(binding)) return command.id;
  }

  return null;
}
