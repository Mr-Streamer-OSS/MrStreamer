// @vitest-environment happy-dom
// The mini player goes with the view it shrank: leaving Watch, or opening Settings, which has no
// room in it, puts the window back, and only where the platform keeps a window on top.
import { ipc } from "./support.ts";
import { describe, expect, it } from "vitest";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The app's modules with the main process answering whether windows can stay on top. */
async function loaded(available: boolean) {
  ipc.reset();
  const answer = ipc.hold("window.miniPlayerAvailable");
  const { miniPlayer } = await import("../../src/renderer/src/app/mini-player.ts");
  const { closeWatch, openWatch, useUi } = await import("../../src/renderer/src/app/ui-store.ts");
  answer.resolve(available);
  await settle();
  return { miniPlayer, closeWatch, openWatch, useUi };
}

/** The window positions asked of the main process so far. */
const asked = () => ipc.argsOf("window.setMiniPlayer");

describe("the mini player", () => {
  it("puts the window back when Watch closes or Settings opens", async () => {
    const { miniPlayer, closeWatch, openWatch, useUi } = await loaded(true);
    openWatch();
    ipc.hold("window.setMiniPlayer").resolve(null);
    await miniPlayer.enter();
    closeWatch();
    await settle();
    expect(asked()).toEqual([{ on: true }, { on: false }]);

    openWatch();
    ipc.hold("window.setMiniPlayer").resolve(null);
    await miniPlayer.enter();
    useUi.setState({ settings: "general" });
    await settle();
    expect(asked()).toEqual([{ on: true }, { on: false }, { on: true }, { on: false }]);
  });
});
