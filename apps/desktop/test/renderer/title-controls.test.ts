// @vitest-environment happy-dom
// A title's controls: Left and Right and the skip buttons move it by the seek step saved in
// Settings, and the buttons say how far (ten seconds while none is saved); the time before the
// scrubber takes a time to go to; the sleep timer menu sets, shows and turns off a timer.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { runs } from "./title-engine-stand-in.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, expect, it, vi } from "vitest";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { clockTime } from "../../src/renderer/src/lib/format.ts";
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

/** Shows a ten-minute movie playing from 5:00, with `saved` as the preferences main has saved. */
async function watching(saved: Partial<Preferences> = {}): Promise<HTMLElement> {
  ipc.reset();
  runs.length = 0;
  ipc.prefer(saved);
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
  await watching({ seekStepSeconds: 30 });

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
  const container = await watching();

  await key("ArrowRight");
  expect(await landed()).toBe(310);
  expect(container.querySelector('button[aria-label="Back 10 seconds"]')).not.toBeNull();
});

/** The button labelled `label`, in the view or a menu open over it. */
function button(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  if (!found) throw new Error(`No ${label} button`);

  return found;
}

/** Types `text` into the field the time before the scrubber opens, and presses `end`. */
async function goTo(text: string, end = "Enter"): Promise<HTMLInputElement> {
  await act(async () => button("Go to time").click());
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Go to time"]')!;
  expect(document.activeElement).toBe(field);

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: end, bubbles: true }));
  });

  return field;
}

it("goes to a typed time, and keeps one it can't read in the field with an example", async () => {
  await watching();

  await goTo("2:30");
  expect(await landed()).toBe(150);
  expect(document.querySelector('input[aria-label="Go to time"]')).toBeNull();
  const started = runs.length;

  const field = await goTo("62:75");
  expect(field.isConnected).toBe(true);
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Type a time like 1:02:13");

  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(document.querySelector('input[aria-label="Go to time"]')).toBeNull();
  expect(runs.length).toBe(started);
  expect(titlePlayer.state().phase.kind).toBe("playing");
});

it("sets a sleep timer from its menu, names when it pauses, and pauses there", async () => {
  await watching();

  await act(async () => button("Sleep timer").click());
  const rows = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")];
  expect(rows.map((row) => row.textContent)).toEqual([
    "Off",
    "1 min",
    "15 min",
    "30 min",
    "45 min",
    "60 min",
    "90 min",
    "End of this title",
  ]);

  await act(async () => rows[1]!.click());
  const timer = button("Sleep timer");
  expect(timer.getAttribute("aria-pressed")).toBe("true");
  expect(timer.textContent).toBe(clockTime(Date.now() + 60_000, Date.now()));

  await act(async () => vi.advanceTimersByTime(60_000));
  expect(titlePlayer.state().phase.kind).toBe("paused");
  expect(button("Sleep timer").getAttribute("aria-pressed")).toBe("false");
});

it("turns a sleep timer for the end off from its menu", async () => {
  await watching();

  await act(async () => button("Sleep timer").click());
  await act(async () => document.querySelectorAll<HTMLButtonElement>("[data-item]")[7]!.click());
  expect(button("Sleep timer").textContent).toBe("End");
  expect(titlePlayer.state().sleep).toEqual({ kind: "end" });

  await act(async () => button("Sleep timer").click());
  await act(async () => document.querySelectorAll<HTMLButtonElement>("[data-item]")[0]!.click());
  expect(titlePlayer.state().sleep).toBeNull();
  expect(button("Sleep timer").getAttribute("aria-pressed")).toBe("false");
});
