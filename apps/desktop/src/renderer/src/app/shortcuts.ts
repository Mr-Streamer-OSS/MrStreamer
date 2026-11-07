import type { Preferences } from "@mrstreamer/contracts/preferences";
import { isTyping } from "./platform.ts";

export type ShortcutOverrides = NonNullable<Preferences["keyboardShortcuts"]>;

export type ShortcutSurface = "live" | "title";

// Commands share identity across both players; navigation retains its own fixed keys.
export const shortcutCommands = [
  {
    id: "pause",
    label: "Play or pause",
    live: ["Space", "Shift+Space", "k", "Shift+k"],
    title: ["Space", "Shift+Space", "k", "Shift+k"],
    repeat: false,
  },
  {
    id: "seekBack",
    label: "Skip backward",
    live: ["j", "Shift+j"],
    title: ["ArrowLeft"],
    repeat: true,
  },
  {
    id: "seekForward",
    label: "Skip forward",
    live: ["l", "Shift+l"],
    title: ["ArrowRight"],
    repeat: true,
  },
  { id: "fullscreen", label: "Full screen", live: ["f"], title: ["f"], repeat: false },
  {
    id: "miniPlayer",
    label: "Mini player",
    live: ["p", "Shift+p"],
    title: ["p", "Shift+p"],
    repeat: false,
  },
  {
    id: "output",
    label: "Play on",
    live: ["o", "Shift+o"],
    title: ["o", "Shift+o"],
    repeat: false,
  },
  { id: "mute", label: "Mute", live: ["m"], title: ["m"], repeat: false },
  { id: "subtitles", label: "Subtitles", live: ["c"], title: ["c"], repeat: false },
  {
    id: "subtitlesEarlier",
    label: "Subtitles earlier",
    live: ["g", "Shift+g"],
    title: ["g", "Shift+g"],
    repeat: true,
  },
  {
    id: "subtitlesLater",
    label: "Subtitles later",
    live: ["h", "Shift+h"],
    title: ["h", "Shift+h"],
    repeat: true,
  },
  { id: "info", label: "Show controls", live: ["i"], title: [], repeat: false },
  { id: "favourite", label: "Favourite channel", live: ["s", "Shift+s"], title: [], repeat: false },
  { id: "quality", label: "Choose quality", live: ["q"], title: [], repeat: false },
  { id: "retry", label: "Retry channel", live: ["r", "Shift+r"], title: [], repeat: false },
  { id: "volumeUp", label: "Volume up", live: [], title: ["ArrowUp"], repeat: true },
  { id: "volumeDown", label: "Volume down", live: [], title: ["ArrowDown"], repeat: true },
  { id: "nextEpisode", label: "Next episode", live: [], title: ["n"], repeat: false },
  { id: "slower", label: "Play slower", live: [], title: ["<"], repeat: true },
  { id: "faster", label: "Play faster", live: [], title: [">"], repeat: true },
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

export function shortcutBindings(
  command: ShortcutCommand,
  surface: ShortcutSurface,
  overrides: ShortcutOverrides = {},
): readonly string[] {
  const definition = shortcutCommands.find((entry) => entry.id === command)!;

  if (!definition[surface].length) return [];

  return overrides[command] ?? definition[surface];
}

/** Returns a reason the editor can announce; replacement frees all of a command's old keys. */
export function validateShortcut(
  command: ShortcutCommand,
  binding: string,
  overrides: ShortcutOverrides = {},
): { kind: "reserved" } | { kind: "conflict"; command: ShortcutCommand } | null {
  const definition = shortcutCommands.find((entry) => entry.id === command)!;

  const liveNavigation = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ];

  if (
    !/^(?:(?:Shift\+)?(?:[a-z]|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)|[0-9]|[^\w\s])$/.test(
      binding,
    ) ||
    /^[0-9]$/.test(binding) ||
    (definition.live.length > 0 && liveNavigation.includes(binding.replace(/^Shift\+/, "")))
  )
    return { kind: "reserved" };

  for (const other of shortcutCommands) {
    if (other.id === command) continue;

    for (const surface of ["live", "title"] as const) {
      if (
        definition[surface].length &&
        shortcutBindings(other.id, surface, overrides).includes(binding)
      )
        return { kind: "conflict", command: other.id };
    }
  }

  return null;
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

  const valid = shortcutCommands.every(
    (entry) =>
      !overrides[entry.id] ||
      overrides[entry.id]!.every((key) => !validateShortcut(entry.id, key, overrides)),
  );

  for (const command of shortcutCommands) {
    if (event.repeat && !command.repeat) continue;

    if (shortcutBindings(command.id, surface, valid ? overrides : {}).includes(binding))
      return command.id;
  }

  return null;
}
