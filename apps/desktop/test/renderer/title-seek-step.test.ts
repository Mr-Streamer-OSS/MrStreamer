// @vitest-environment happy-dom
// Left and Right and the skip buttons move a title by the seek step saved in Settings, and the
// buttons say how far. Ten seconds while none is saved.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { runs } from "./title-engine-stand-in.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, expect, it, vi } from "vitest";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { readPreferences, syncPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

vi.mock(
  "../../src/renderer/src/player/title-engine.ts",
  () => import("./title-engine-stand-in.ts"),
);

const cleanups: (() => void)[] = [];

afterEach(() => {
  titlePlayer.close();

  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

const title = { kind: "movie", subscriptionId: SUBSCRIPTION, id: "night" } as const;

/** Shows a ten-minute movie playing from 5:00, with the preferences main has saved. */
async function watching(): Promise<HTMLElement> {
  vi.useFakeTimers();
  const client = new QueryClient();
  cleanups.push(
    syncPreferences(client, () => {}),
    () => client.clear(),
  );
  await readPreferences(client);
  ipc.always("playback.openTitle", {
    sessionId: "night",
    title,
    url: "http://127.0.0.1/title/night.mp4",
    duration: 600,
    audio: [],
    subtitles: [],
  });

  const now = {
    kind: "provider",
    title,
    name: "Night Harbour",
    detail: null,
    artworkUrl: null,
    originalLanguage: null,
  } as const;

  await act(async () => {
    void titlePlayer.open(now, 300);
  });
  await act(() => vi.advanceTimersByTimeAsync(20));
  await act(async () => runs.at(-1)?.start());
  useUi.setState({ playingTitle: true });
  const mounted = queryView(client);
  cleanups.push(mounted.unmount);
  await mounted.render(createElement(TitleWatch));

  return mounted.container;
}

/** Where the run started by the last skip starts, after letting it start. */
async function landed(): Promise<number> {
  const run = runs.at(-1)!;
  await act(async () => run.start());

  return run.run.start;
}

const key = (name: string) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });

it("skips by the saved step from Left and Right and from the buttons, which name it", async () => {
  ipc.reset();
  runs.length = 0;
  ipc.prefer({ seekStepSeconds: 30 });
  const container = await watching();

  const button = (label: string) => {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

    if (!found) throw new Error(`No ${label} button`);

    return found;
  };

  await key("ArrowRight");
  expect(await landed()).toBe(330);
  await key("ArrowLeft");
  expect(await landed()).toBe(300);

  await act(async () => button("Back 30 seconds").click());
  expect(await landed()).toBe(270);
  await act(async () => button("Forward 30 seconds").click());
  expect(await landed()).toBe(300);
});

it("skips ten seconds while no step is saved", async () => {
  ipc.reset();
  runs.length = 0;
  const container = await watching();

  await key("ArrowRight");
  expect(await landed()).toBe(310);
  expect(container.querySelector('button[aria-label="Back 10 seconds"]')).not.toBeNull();
});
