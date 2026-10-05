// @vitest-environment happy-dom
// Where the system's list of receivers is asked to open: at the output button as the view shows
// it at that moment. From the mini player, which has no such button, the window goes back first
// and the list is asked for once it has. Where no view shows the button, the list opens in the
// middle of the window, never where it opened before.
import { ipc } from "./support.ts";
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

beforeEach(async () => {
  app ??= await loaded();
  ipc.reset();
  container = document.createElement("div");
  document.body.append(container);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const at = this.hasAttribute("data-output") ? BUTTON : { x: 0, y: 0, width: 0, height: 0 };
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

  it("opens from the mini player only once the window is back, at the button it then shows", async () => {
    await watching();
    ipc.hold("window.setMiniPlayer").resolve(null);
    await act(() => app.miniPlayer.enter());
    // The mini player has no output button for the list to open at.
    expect(container.querySelector("[data-output]")).toBeNull();

    const back = ipc.hold("window.setMiniPlayer");
    await key("o");
    expect(ipc.argsOf("window.setMiniPlayer")).toEqual([{ on: true }, { on: false }]);
    // The window is still on its way back: nothing is measured or asked for yet.
    expect(asked()).toEqual([]);

    await act(async () => {
      back.resolve(null);
      await settle();
    });
    expect(asked()).toEqual([{ anchor: BUTTON }]);
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
