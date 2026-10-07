// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { LiveMore, type LiveMenu } from "../../src/renderer/src/features/watch/LiveMore.tsx";

import { closeWatch, openWatch, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { WatchScreen } from "../../src/renderer/src/features/watch/WatchScreen.tsx";

let unmount = () => {};
afterEach(() => {
  unmount();
  act(() => {
    closeWatch();
    player.reset();
  });
  vi.restoreAllMocks();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const channel: LiveChannel = {
  subscriptionId: SUBSCRIPTION,
  id: "one",
  name: "One",
  title: "One",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  variants: [{ id: "one", name: "One", tags: [], quality: null }],
};

it("keeps mouse actions, page focus and discovery tied to More as tracks and outputs change", async () => {
  ipc.reset();
  const calls: (number | string)[] = [];
  let removeSound = () => {};
  function Controls() {
    const [menu, setMenu] = useState<LiveMenu>(null);
    const [soundAvailable, setSoundAvailable] = useState(true);
    removeSound = () => setSoundAvailable(false);
    const sound: ComponentProps<typeof LiveMore>["sound"] = soundAvailable
      ? {
          audio: [
            { id: 1, label: "English", language: "en", default: true },
            { id: 2, label: "Dutch", language: "nl", default: false },
          ],
          audioId: 2,
          onAudio: (id) => calls.push(id),
          onDone: () => setMenu(null),
        }
      : null;
    return createElement(LiveMore, {
      menu,
      onMenu: setMenu,
      previous: channel,
      onSwitch: (direction) => calls.push(direction),
      onPrevious: () => calls.push("previous"),
      sound,
      quality: null,
      playback: {
        subtitles: [
          {
            id: 1,
            page: null,
            format: "text",
            language: "en",
            label: "English",
            forced: false,
            default: false,
          },
        ],
        subtitle: null,
        onOpenChange: (open) => setMenu(open ? "playback" : null),
      },
    });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  await act(async () => {
    root.render(createElement(Controls));
    await settle();
  });
  function button(name: string) {
    const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (each) => each.getAttribute("aria-label") === name || each.textContent === name,
    );
    if (!found) throw new Error(`Missing ${name}`);
    return found;
  }
  async function click(name: string) {
    await act(async () => {
      button(name).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      await settle();
    });
  }
  async function key(name: string) {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
      );
      await settle();
    });
  }
  await click("More");
  expect(button("Channel up").hasAttribute("aria-pressed")).toBe(false);
  expect(button("Channel up").textContent).toContain("Up");
  expect(button("Back to One").hasAttribute("aria-pressed")).toBe(false);
  expect(document.querySelector('[role="separator"]')).not.toBeNull();
  expect(button("Sound").getAttribute("aria-description")).toBe("Dutch");
  expect(button("Playback").textContent).toContain("timing, look");
  await click("Channel up");
  expect(calls).toEqual([-1]);
  expect(button("More").getAttribute("aria-expanded")).toBe("false");
  await click("More");
  await click("Back to One");
  expect(calls).toEqual([-1, "previous"]);
  await click("More");
  await click("Sound");
  await click("English");
  expect(calls).toEqual([-1, "previous", 1]);
  expect(button("More").getAttribute("aria-expanded")).toBe("false");

  await click("More");
  button("Sound").focus();
  await key("ArrowRight");
  expect(document.activeElement?.textContent).toBe("Dutch");
  await key("Backspace");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Sound");
  await key("Enter");
  expect(document.activeElement?.textContent).toBe("Dutch");
  await act(async () => {
    removeSound();
    await settle();
  });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Channel up");
  expect(document.body.textContent).not.toContain("Dutch");
  await key("Escape");
  expect(button("More").getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(button("More"));

  await click("More");
  await click("Playback");
  await click("Subtitle lookMedium, box");
  await key("Backspace");
  expect(document.activeElement?.textContent).toBe("Subtitle lookMedium, box");
  await key("ArrowLeft");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Playback");
  await key("Escape");

  const local = {
    offers: ["cast" as const],
    airplayRoutes: false,
    receivers: [],
    scanning: false,
    output: { kind: "local" as const },
  };
  await act(async () => {
    ipc.emit("output.changed", local);
    await settle();
  });
  await click("More");
  await click("Play on");
  expect(ipc.argsOf("output.scan")).toEqual([{ on: true }]);
  // A receiver refresh does not restart discovery or close the page.
  await act(async () => {
    ipc.emit("output.changed", { ...local, offers: ["cast"], scanning: true });
    await settle();
  });
  expect(ipc.argsOf("output.scan")).toEqual([{ on: true }]);
  await click("Back to More");
  expect(ipc.argsOf("output.scan")).toEqual([{ on: true }, { on: false }]);
  await click("Play on");
  await act(async () => {
    ipc.emit("output.changed", { ...local, offers: [] });
    await settle();
  });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Channel up");
  expect(ipc.argsOf("output.scan").at(-1)).toEqual({ on: false });
});

const qualityChannel: LiveChannel = {
  ...channel,
  variants: [
    { id: "one", name: "One FHD", tags: ["FHD"], quality: "fhd" },
    { id: "one-hd", name: "One HD", tags: ["HD"], quality: "hd" },
  ],
};
const nextChannel: LiveChannel = {
  ...channel,
  id: "two",
  name: "Two",
  title: "Two",
  variants: [{ ...channel.variants[0]!, id: "two" }],
};
const cast = {
  offers: ["cast" as const],
  airplayRoutes: false,
  receivers: [],
  scanning: false,
  output: { kind: "local" as const },
};

async function watch() {
  ipc.reset();
  ipc.always("library.channels", [qualityChannel, nextChannel]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  await act(async () => {
    ipc.emit("output.changed", cast);
    openWatch();
    player.play(qualityChannel);
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(WatchScreen),
      ),
    );
    await settle();
  });
  return container;
}

function named(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.getAttribute("aria-label") === name || each.textContent === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
async function pressKey(key: string) {
  await act(async () => {
    const target = document.activeElement ?? window;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    // happy-dom does not perform a button's native Enter activation.
    if (key === "Enter" && !event.defaultPrevented && target instanceof HTMLButtonElement)
      target.click();
    await settle();
  });
}

it("Q and O open on usable choices, support immediate Back keys and dismiss on a channel change", async () => {
  await watch();
  await pressKey("q");
  expect(document.activeElement?.textContent).toContain("Automatic");
  expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
  await pressKey("Backspace");
  expect(document.activeElement).toBe(named("Quality"));
  expect(named("Quality").textContent).toContain("Q");
  expect(ipc.argsOf("subscription.updatePreferences")).toEqual([]);
  await pressKey("Escape");
  expect(document.activeElement).toBe(named("More"));
  await pressKey("q");
  await pressKey("ArrowDown");
  expect(document.activeElement?.textContent).toBe("Full HD");
  await pressKey("Enter");
  expect(ipc.argsOf("subscription.updatePreferences")).toEqual([
    { subscriptionId: SUBSCRIPTION, patch: { channelVariants: { one: "one" } } },
  ]);
  expect(named("More").getAttribute("aria-expanded")).toBe("false");

  await pressKey("o");
  expect(document.activeElement?.textContent).toBe("This computer");
  await pressKey("ArrowLeft");
  expect(document.activeElement).toBe(named("Play on"));
  expect(named("Play on").textContent).toContain("This computer");
  expect(named("Play on").textContent).toContain("O");
  await pressKey("Escape");
  await pressKey("o");
  await pressKey("Backspace");
  expect(document.activeElement).toBe(named("Play on"));
  await pressKey("Escape");
  expect(ipc.argsOf("output.scan")).toEqual([
    { on: true },
    { on: false },
    { on: true },
    { on: false },
  ]);

  await act(async () => {
    named("More").click();
    await settle();
  });
  expect(named("More").getAttribute("aria-expanded")).toBe("true");
  await act(async () => {
    player.play(nextChannel);
    await settle();
  });
  expect(named("More").getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("More keeps the active receiver visible and labels its Play on destination", async () => {
  await watch();
  const receiver = { id: "tv", kind: "cast" as const, name: "Living Room TV" };
  await act(async () => {
    ipc.emit("output.changed", {
      ...cast,
      receivers: [receiver],
      output: { kind: "receiver", receiver, volume: null, media: null, failure: null },
    });
    await settle();
  });
  expect(named("More").getAttribute("aria-pressed")).toBe("true");
  expect(named("More").getAttribute("aria-description")).toBe("Playing on Living Room TV");
  await act(async () => {
    named("More").click();
    await settle();
  });
  expect(named("Play on").textContent).toContain("Living Room TV");
  expect(named("Play on").getAttribute("aria-description")).toBe("Living Room TV");
  expect(named("Play on").hasAttribute("aria-pressed")).toBe(false);
});

it("wheel over the Live picture zaps once per gesture and leaves menu, list, dialog and typing input alone", async () => {
  const container = await watch();
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const picture = () => container.querySelector("video")?.parentElement;
  const roll = async (deltaY: number, target = picture(), deltaX = 0) => {
    await act(async () => {
      target?.dispatchEvent(
        new WheelEvent("wheel", { deltaY, deltaX, bubbles: true, cancelable: true }),
      );
      await settle();
    });
  };
  const initial = ipc.argsOf("playback.open").length;
  await roll(10);
  expect(ipc.argsOf("playback.open")).toHaveLength(initial);
  await roll(70);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  expect(ipc.argsOf("playback.open").at(-1)?.channel.id).toBe("two");
  const once = ipc.argsOf("playback.open").length;
  for (let i = 0; i < 8; i++) {
    now += 100;
    await roll(120);
  }
  expect(ipc.argsOf("playback.open")).toHaveLength(once);
  now += 800;
  await roll(-120);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  expect(ipc.argsOf("playback.open").at(-1)?.channel.id).toBe("one");
  const twice = ipc.argsOf("playback.open").length;
  await act(async () => {
    named("More").click();
    await settle();
  });
  now += 800;
  await roll(120);
  expect(ipc.argsOf("playback.open")).toHaveLength(twice);
  await pressKey("Escape");
  await pressKey("Enter");
  now += 800;
  await roll(120);
  expect(useUi.getState().channelsOpen).toBe(true);
  expect(ipc.argsOf("playback.open")).toHaveLength(twice);
  await pressKey("Escape");
  await act(() => useUi.setState({ settings: "subscriptions" }));
  now += 800;
  await roll(120);
  expect(ipc.argsOf("playback.open")).toHaveLength(twice);
  await act(() => useUi.setState({ settings: null }));
  const input = document.createElement("input");
  container.append(input);
  input.focus();
  now += 800;
  await roll(120);
  expect(ipc.argsOf("playback.open")).toHaveLength(twice);
  input.remove();
  now += 800;
  await roll(120, named("More"));
  await roll(120, picture(), 200);
  expect(ipc.argsOf("playback.open")).toHaveLength(twice);
});

it("a pointer Quality open on a failed channel starts Down on the chosen quality and supports Back", async () => {
  await watch();
  await act(async () => {
    ipc.always("playback.open", {
      sessionId: "pointer-quality",
      channel: { subscriptionId: SUBSCRIPTION, id: "one" },
      url: "http://127.0.0.1/stream/one",
      format: "hls",
    });
    ipc.always("playback.failure", { kind: "unsupported", detail: "Unsupported fixture" });
    ipc.always("playback.playing", null);
    player.retry();
    await settle();
    player.element.dispatchEvent(new Event("error"));
    await settle();
  });
  await act(async () => {
    named("Quality").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await settle();
  });
  expect(document.activeElement?.getAttribute("role")).toBe("dialog");
  expect(document.activeElement?.getAttribute("aria-pressed")).toBeNull();
  await pressKey("ArrowDown");
  expect(document.activeElement?.textContent).toContain("Automatic");
  expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
  await pressKey("ArrowDown");
  expect(document.activeElement?.textContent).toBe("Full HD");
  await pressKey("Backspace");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Quality");
  expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
});
