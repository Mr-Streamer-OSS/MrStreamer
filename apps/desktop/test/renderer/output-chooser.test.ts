// @vitest-environment happy-dom
// Where the system's list of receivers is asked to open: at the output button as the view shows
// it at that moment. From the mini player, which has no such button, the window goes back first
// and the list is asked for once it has, full screen again where it was. An O the viewer overtook
// asks for none. Where no view shows the button, the list opens in the middle of the window,
// never where it opened before.
import { fullScreen, ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Output, OutputStatus, Receiver } from "@mrstreamer/contracts/output";

const airplay: Receiver = { id: "airplay", kind: "airplay", name: null };

/** A Mac's outputs: the system's list is the only chooser. */
const status = (output: Output): OutputStatus => ({
  offers: ["airplay"],
  airplayRoutes: true,
  scanning: false,
  receivers: [],
  output,
});

const channel: LiveChannel = {
  id: "a",
  name: "NL | a",
  title: "a",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  variants: [{ id: "a", name: "NL | a", tags: [], quality: null }],
};

/** Where the output button is in the full window. happy-dom lays nothing out, so this says. */
const BUTTON = { x: 1100, y: 720, width: 44, height: 44 };
/** Where it is once the page fills the screen. */
const FULL_BUTTON = { x: 1740, y: 1000, width: 44, height: 44 };

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The app's modules, loaded once the main process can say that windows stay on top. */
async function loaded() {
  const available = ipc.hold("window.miniPlayerAvailable");
  const { miniPlayer } = await import("../../src/renderer/src/app/mini-player.ts");
  const { closeWatch, openWatch } = await import("../../src/renderer/src/app/ui-store.ts");
  const { WatchScreen } = await import("../../src/renderer/src/features/watch/WatchScreen.tsx");
  const { outputs } = await import("../../src/renderer/src/player/output.ts");
  const { player } = await import("../../src/renderer/src/player/player.ts");
  available.resolve(true);
  await settle();
  return { miniPlayer, closeWatch, openWatch, WatchScreen, outputs, player };
}

let app: Awaited<ReturnType<typeof loaded>>;
let container: HTMLDivElement;
let unmount = () => {};

/** The places the system's list was asked to open at so far. */
const asked = () => ipc.argsOf("output.pick");

/** Watch on channel `a`, which plays here, as the window shows it. */
async function watching(): Promise<void> {
  const root = createRoot(container);
  unmount = () => act(() => root.unmount());
  await act(async () => {
    app.openWatch();
    app.player.play(channel);
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(app.WatchScreen),
      ),
    );
    await settle();
  });
}

const key = (name: string) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    await settle();
  });

/** What `event` leads to, once the page has taken it in. */
const after = (event: () => void) =>
  act(async () => {
    event();
    await settle();
  });

/** The main process says the window fills the screen, or no longer does. */
const windowFills = (fills: boolean) => after(() => ipc.emit("window.fullScreen", fills));

/** The mini player, shrunk from a window that filled the screen where `from` says so. */
async function shrunk(from?: "full screen"): Promise<void> {
  if (from) {
    fullScreen.on = true;
    await windowFills(true);
  }
  ipc.hold("window.setMiniPlayer").resolve(null);
  await act(() => app.miniPlayer.enter());
  // The main process takes the window out of full screen before it shrinks it.
  await windowFills(false);
  // The mini player has no output button for the list to open at.
  expect(container.querySelector("[data-output]")).toBeNull();
}

beforeEach(async () => {
  app ??= await loaded();
  ipc.reset();
  fullScreen.reset();
  container = document.createElement("div");
  document.body.append(container);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const button = fullScreen.on ? FULL_BUTTON : BUTTON;
    const at = this.hasAttribute("data-output") ? button : { x: 0, y: 0, width: 0, height: 0 };
    return new DOMRect(at.x, at.y, at.width, at.height);
  });
  await act(async () => ipc.emit("output.changed", status({ kind: "local" })));
});

afterEach(async () => {
  await unmount();
  unmount = () => {};
  await act(async () => {
    app.closeWatch();
    app.player.reset();
    await settle();
  });
  container.remove();
  vi.restoreAllMocks();
  await windowFills(false);
});

describe("the system's list of receivers", () => {
  it("opens at the output button, from the button and from O", async () => {
    await watching();

    const button = container.querySelector<HTMLElement>('[aria-label="AirPlay"]');
    await act(async () => button?.click());
    expect(asked()).toEqual([{ anchor: BUTTON }]);

    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }, { anchor: BUTTON }]);
  });

  it.each([
    { how: "O", keys: ["o"] },
    { how: "O twice", keys: ["o", "o"] },
    { how: "Escape, then O", keys: ["Escape", "o"] },
  ])(
    "opens from the mini player only once the window is back, at the button it then shows: $how",
    async ({ keys }) => {
      await watching();
      await shrunk();

      const back = ipc.hold("window.setMiniPlayer");
      for (const each of keys) await key(each);
      // The window goes back once, whichever key asked first.
      expect(ipc.argsOf("window.setMiniPlayer")).toEqual([{ on: true }, { on: false }]);
      // It is still on its way back: nothing is measured or asked for yet.
      expect(asked()).toEqual([]);

      await after(() => back.resolve(null));
      // Each O asks, as it does in the full window.
      expect(asked()).toEqual(keys.filter((each) => each === "o").map(() => ({ anchor: BUTTON })));
    },
  );

  it.each([
    { how: "O", keys: ["o"] },
    { how: "O twice", keys: ["o", "o"] },
  ])(
    "opens from a mini player that was full screen only once the window fills the screen again: $how",
    async ({ keys }) => {
      await watching();
      await shrunk("full screen");

      const back = ipc.hold("window.setMiniPlayer");
      const granted = fullScreen.hold("request");
      for (const each of keys) await key(each);
      await after(() => back.resolve(null));
      // The window is back at its size, and asked to fill the screen once.
      expect(fullScreen.requests).toBe(1);
      expect(asked()).toEqual([]);

      await after(granted.grant);
      // The page has full screen at once. The window takes its time, changing size on the way.
      expect(fullScreen.on).toBe(true);
      expect(asked()).toEqual([]);

      await windowFills(true);
      expect(asked()).toEqual(keys.map(() => ({ anchor: FULL_BUTTON })));
    },
  );

  it("opens for an O pressed while P still left full screen once the window fills it again, unshrunk", async () => {
    await watching();
    fullScreen.on = true;
    await windowFills(true);

    const left = fullScreen.hold("exit");
    await key("p");
    await key("o");
    await after(left.grant);
    // The page left full screen at once. The window is still on its way out, and it can't be
    // asked back before it is.
    expect(fullScreen.requests).toBe(0);
    expect(asked()).toEqual([]);

    await windowFills(false);
    expect(fullScreen.requests).toBe(1);
    expect(asked()).toEqual([]);

    await windowFills(true);
    expect(asked()).toEqual([{ anchor: FULL_BUTTON }]);
    // O stopped the way in before the window shrank.
    expect(ipc.argsOf("window.setMiniPlayer")).toEqual([]);
  });

  it.each([
    { how: "P shrank the window again", keys: ["p"] },
    { how: "P shrank it and put it back again", keys: ["p", "p"] },
  ])("opens nothing for an O the viewer overtook: $how", async ({ keys }) => {
    await watching();
    await shrunk();

    // O, then P before the main process has put the window back.
    const moves = [ipc.hold("window.setMiniPlayer")];
    await key("o");
    for (const each of keys) {
      moves.push(ipc.hold("window.setMiniPlayer"));
      await key(each);
    }
    // The window's moves end in turn, first the way back O waited for.
    for (const move of moves) {
      await after(() => move.resolve(null));
      expect(asked()).toEqual([]);
    }

    // The next O is its own, and opens the list once the window is back.
    ipc.hold("window.setMiniPlayer").resolve(null);
    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }]);
  });

  it("opens nothing once the view that asked has closed", async () => {
    await watching();
    await shrunk();

    const back = ipc.hold("window.setMiniPlayer");
    await key("o");
    await act(async () => app.closeWatch());
    await after(() => back.resolve(null));
    expect(asked()).toEqual([]);
  });

  it("opens all the same when the main process could not put the window back, and for the next O", async () => {
    await watching();
    await shrunk();

    const back = ipc.hold("window.setMiniPlayer");
    await key("o");
    await after(() => back.reject({ kind: "unexpected", detail: "The window closed." }));
    expect(asked()).toEqual([{ anchor: BUTTON }]);

    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }, { anchor: BUTTON }]);
  });

  it("opens where the window was put back when full screen is refused, and for the next O", async () => {
    await watching();
    await shrunk("full screen");

    ipc.hold("window.setMiniPlayer").resolve(null);
    const request = fullScreen.hold("request");
    await key("o");
    expect(asked()).toEqual([]);
    // The window stays as it was put back, with nothing more to wait for.
    await after(request.refuse);
    expect(asked()).toEqual([{ anchor: BUTTON }]);

    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }, { anchor: BUTTON }]);
  });

  it("opens in the middle of the window where no view shows the button, not where it was", async () => {
    await watching();
    await key("o");
    expect(asked()).toEqual([{ anchor: BUTTON }]);

    // The receiver's connection broke, and no view with the button is on screen any more.
    await unmount();
    unmount = () => {};
    await act(async () =>
      ipc.emit(
        "output.changed",
        status({ kind: "lost", receiver: airplay, failure: { kind: "unreachable" } }),
      ),
    );
    app.outputs.reconnect();

    expect(asked()[1]).toEqual({
      anchor: { x: window.innerWidth / 2, y: window.innerHeight / 2, width: 0, height: 0 },
    });
  });
});
