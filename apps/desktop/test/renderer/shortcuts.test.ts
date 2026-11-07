// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { runs } from "./title-engine-stand-in.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { queryView } from "./mount.ts";
import { Preferences } from "@mrstreamer/contracts/preferences";
import {
  shortcutBinding,
  resolveShortcut,
  validateShortcut,
} from "../../src/renderer/src/app/shortcuts.ts";
import {
  acceptPreferences,
  readPreferences,
  syncPreferences,
  updatePreferences,
  currentPreferences,
} from "../../src/renderer/src/lib/preferences.ts";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";
import { selectProfileOwner } from "../../src/renderer/src/lib/ipc.ts";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { findSettings } from "../../src/renderer/src/features/settings/catalogue.ts";
import { SettingsPage } from "../../src/renderer/src/features/settings/SettingsPage.tsx";

vi.mock(
  "../../src/renderer/src/player/title-engine.ts",
  () => import("./title-engine-stand-in.ts"),
);

const key = (key: string, options: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });

let cleanup = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};

  act(() => titlePlayer.close());
  useUi.setState({ playingTitle: false });
  ipc.reset();
});

it("validates conflicts across actual playback surfaces and reserves navigation and native accelerators", () => {
  expect(validateShortcut("pause", "m")).toEqual({ kind: "conflict", command: "mute" });
  expect(validateShortcut("pause", "ArrowUp")).toEqual({ kind: "reserved" });

  for (const binding of ["Escape", "Enter", "Tab", "Backspace", "7", "Ctrl+k", "Meta+q", "F11"])
    expect(validateShortcut("pause", binding)).toEqual({ kind: "reserved" });
  expect(validateShortcut("pause", "z")).toBeNull();
  expect(validateShortcut("pause", "Shift+z")).toBeNull();
  expect(shortcutBinding(key("Z", { shiftKey: true }))).toBe("Shift+z");
  expect(shortcutBinding(key("<", { shiftKey: true }))).toBe("<");
  expect(shortcutBinding(key(" ", { shiftKey: true }))).toBe("Shift+Space");
  expect(validateShortcut("pause", "Shift+ArrowUp")).toEqual({ kind: "reserved" });
  expect(shortcutBinding(key("q", { metaKey: true }))).toBeNull();
});

it("dispatches remapped commands on both players, retires defaults, resets and rejects invalid saved bindings", () => {
  for (const surface of ["live", "title"] as const) {
    expect(resolveShortcut(key("z"), surface, { pause: ["z"] })).toBe("pause");
    expect(resolveShortcut(key(" "), surface, { pause: ["z"] })).toBeNull();
    expect(resolveShortcut(key(" "), surface, {})).toBe("pause");
    expect(resolveShortcut(key("m"), surface, { pause: ["m"] })).toBe("mute");
    expect(resolveShortcut(key("z", { repeat: true }), surface, { pause: ["z"] })).toBeNull();
    expect(resolveShortcut(key("g", { repeat: true }), surface)).toBe("subtitlesEarlier");
    // Shift keeps the larger subtitle step on a remapped key, but stays off for Mute.
    expect(
      resolveShortcut(key("Z", { shiftKey: true }), surface, { subtitlesEarlier: ["z"] }),
    ).toBe("subtitlesEarlier");
    expect(resolveShortcut(key("Z", { shiftKey: true }), surface, { mute: ["z"] })).toBeNull();
  }

  expect(validateShortcut("mute", "Shift+z", { subtitlesEarlier: ["z"] })).toEqual({
    kind: "conflict",
    command: "subtitlesEarlier",
  });
});

it("leaves nested editable content, menus, sliders, activation keys and composition with their controls", () => {
  for (const html of [
    "<input>",
    "<textarea></textarea>",
    "<select></select>",
    '<div contenteditable="true"><span></span></div>',
    '<div role="textbox"><span></span></div>',
    '<div role="menu"><span></span></div>',
    '<div role="slider"><span></span></div>',
    '<div role="dialog"><span></span></div>',
  ]) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    const target = wrapper.querySelector("span") ?? wrapper.firstElementChild!;
    const event = key("k");
    target.dispatchEvent(event);
    expect(resolveShortcut(event, "title")).toBeNull();
  }

  const button = document.createElement("button");
  const space = key(" ");
  button.dispatchEvent(space);
  expect(resolveShortcut(space, "title")).toBeNull();
  expect(resolveShortcut(key("k", { isComposing: true }), "title")).toBeNull();
  expect(resolveShortcut(key("k", { altKey: true }), "title")).toBeNull();
});

it("keeps the committed binding after a failed save and applies a saved remap to actual title playback", async () => {
  ipc.reset();
  runs.length = 0;
  const client = new QueryClient();
  const stop = syncPreferences(client, () => {});
  await readPreferences(client);
  ipc.answer("preferences.update", (patch) => ipc.snapshot({ volume: 1, muted: false, ...patch }));
  const saved = await updatePreferences({ keyboardShortcuts: { pause: ["z"] } }, client);
  expect(Preferences().allows(saved)).toBe(true);
  // A fresh cache accepts the same persisted contract, without an in-memory shortcut owner.
  const fresh = new QueryClient();
  acceptPreferences(fresh, ipc.snapshot(saved));
  expect(await readPreferences(fresh)).toEqual(saved);
  const failure = ipc.hold("preferences.update");
  const rejected = updatePreferences({ keyboardShortcuts: {} }, client);
  failure.reject({ kind: "unexpected", detail: "Disk unavailable" });
  await expect(rejected).rejects.toBeDefined();
  const mounted = queryView(client);
  cleanup = () => {
    mounted.unmount();
    mounted.container.remove();
    stop();
  };

  const opening = ipc.hold("playback.openTitle");
  await act(async () => {
    void titlePlayer.open(
      {
        kind: "provider",
        title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "shortcuts" },
        name: "Shortcuts",
        detail: null,
        artworkUrl: null,
        originalLanguage: null,
      },
      0,
    );
  });
  await act(async () => {
    opening.resolve({
      sessionId: "shortcuts",
      title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "shortcuts" },
      url: "http://127.0.0.1/shortcuts.mp4",
      duration: 600,
      audio: [],
      subtitles: [],
    });
  });
  await act(async () => {
    runs.at(-1)!.start();
  });
  useUi.setState({ playingTitle: true });
  await mounted.render(createElement(TitleWatch));
  await act(async () => {
    document.body.dispatchEvent(key(" "));
  });
  expect(mounted.container.querySelector('button[aria-label="Pause"]')).not.toBeNull();
  await act(async () => {
    document.body.dispatchEvent(key("z"));
  });
  expect(mounted.container.querySelector('button[aria-label="Play"]')).not.toBeNull();
  await act(async () => {
    document.body.dispatchEvent(key("z", { repeat: true }));
  });
  expect(mounted.container.querySelector('button[aria-label="Play"]')).not.toBeNull();
  await act(async () => {
    await updatePreferences({ keyboardShortcuts: {} }, client);
  });
  await act(async () => {
    document.body.dispatchEvent(key(" "));
  });
  expect(mounted.container.querySelector('button[aria-label="Pause"]')).not.toBeNull();
});

it("refuses an old profile's shortcut save when the viewer changes before it completes", async () => {
  ipc.reset();
  const client = new QueryClient();
  const stop = syncPreferences(client, () => {});

  try {
    selectProfileOwner({ id: "default", revision: 1 });
    await readPreferences(client);
    const held = ipc.hold("preferences.update");
    const saving = updatePreferences({ keyboardShortcuts: { pause: ["z"] } }, client);
    selectProfileOwner({ id: "other", revision: 2 });
    client.clear();
    ipc.prefer({ keyboardShortcuts: { pause: ["x"] } });
    await readPreferences(client);
    expect(resolveShortcut(key("x"), "title", currentPreferences()?.keyboardShortcuts)).toBe(
      "pause",
    );
    held.resolve(ipc.snapshot({ volume: 1, muted: false, keyboardShortcuts: { pause: ["z"] } }));
    await expect(saving).rejects.toBeDefined();
    expect(client.getQueryData(["preferences"])).toMatchObject({
      preferences: { keyboardShortcuts: { pause: ["x"] } },
    });
  } finally {
    stop();
    selectProfileOwner(null);
  }
});

it("remaps from Settings, refuses taken and reserved keys, keeps committed keys after a failed save and resets", async () => {
  ipc.reset();
  vi.stubGlobal("__BUILD_COMMIT__", "abcdef");
  ipc.always("language.get", {
    choice: "system",
    locale: "en-US",
    system: "en-US",
    formats: "en-US",
  });
  // A command this version doesn't know survives editing another one.
  ipc.prefer({ keyboardShortcuts: { future: ["x"] } });
  useUi.setState({ settings: "general", settingsTarget: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = syncPreferences(client, () => {});
  const mounted = queryView(client);
  cleanup = () => {
    mounted.unmount();
    stop();
    useUi.setState({ settings: null });
    vi.unstubAllGlobals();
  };

  await mounted.render(createElement(SettingsPage));
  const view = mounted.container;
  const search = view.querySelector<HTMLInputElement>('[aria-label="Find a setting"]')!;
  await act(async () => {
    search.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      search,
      "Keyboard shortcuts",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    search.dispatchEvent(key("Enter"));
  });
  await vi.waitFor(() => {
    expect(useUi.getState().settings).toBe("playback");
    expect(document.activeElement?.closest('[data-setting="keyboard-shortcuts"]')).not.toBeNull();
  });

  const mute = await vi.waitFor(() => {
    const button = view.querySelector<HTMLButtonElement>('[data-shortcut="mute"]');
    expect(button).not.toBeNull();

    return button!;
  });

  const press = (name: string, options: KeyboardEventInit = {}) =>
    act(async () => {
      mute.dispatchEvent(key(name, options));
    });

  const choose = () =>
    act(async () => {
      mute.focus();
      mute.click();
    });

  const alert = () => view.querySelector('[data-setting="keyboard-shortcuts"] [role="alert"]');
  expect(mute.getAttribute("aria-label")).toBe("Mute: M");
  await choose();
  expect(mute.textContent).toBe("Press a key");
  await press("c");
  expect(alert()?.textContent).toBe("C is used by Subtitles. Press another key.");
  const chord = key("f", { ctrlKey: true });
  await act(async () => {
    mute.dispatchEvent(chord);
  });
  expect(chord.defaultPrevented).toBe(true);
  expect(alert()?.textContent).toBe("That key is reserved. Press another key.");
  expect(mute.textContent).toBe("Press a key");
  await press("7");
  expect(alert()?.textContent).toBe("That key is reserved. Press another key.");
  await press("Escape");
  // Escape cancels the capture without closing Settings, and nothing was saved.
  expect(useUi.getState().settings).toBe("playback");
  expect(mute.getAttribute("aria-label")).toBe("Mute: M");
  expect(ipc.argsOf("preferences.update")).toEqual([]);

  const failure = ipc.hold("preferences.update");
  await choose();
  await press("u");
  failure.reject({ kind: "unexpected", detail: "Disk unavailable" });
  await vi.waitFor(() => expect(alert()?.textContent).toContain("Try again"));
  expect(mute.getAttribute("aria-label")).toBe("Mute: M");
  expect(ipc.argsOf("preferences.update")).toEqual([
    { keyboardShortcuts: { future: ["x"], mute: ["u"] } },
  ]);

  ipc.answer("preferences.update", (patch) =>
    ipc.snapshot({ ...currentPreferences(client)!, ...patch }),
  );
  await act(async () =>
    [...view.querySelectorAll("button")]
      .find((button) => button.textContent === "Try again")!
      .click(),
  );
  await vi.waitFor(() => expect(mute.getAttribute("aria-label")).toBe("Mute: U"));
  expect(resolveShortcut(key("u"), "live", currentPreferences(client)?.keyboardShortcuts)).toBe(
    "mute",
  );
  expect(
    resolveShortcut(key("m"), "title", currentPreferences(client)?.keyboardShortcuts),
  ).toBeNull();

  await act(async () =>
    view.querySelector<HTMLButtonElement>('button[aria-label="Reset Mute"]')!.click(),
  );
  await vi.waitFor(() => expect(mute.getAttribute("aria-label")).toBe("Mute: M"));
  expect(document.activeElement).toBe(mute);
  expect(ipc.argsOf("preferences.update").at(-1)).toEqual({ keyboardShortcuts: { future: ["x"] } });
});

it("finds the keyboard reference in Settings search", () => {
  expect(findSettings("Keyboard shortcuts")).toContainEqual(
    expect.objectContaining({
      id: "keyboard-shortcuts",
      section: "playback",
      label: "Keyboard shortcuts",
    }),
  );
});
