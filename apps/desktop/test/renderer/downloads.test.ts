// @vitest-environment happy-dom
// Downloads in the window: the page's queue and copies, Connect's way to them with no
// subscription saved, a movie's Download in its details, and a copy playing offline in the same
// player, which asks no provider, record, receiver or subtitle service.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import type { OutputStatus } from "@mrstreamer/contracts/output";
import { App } from "../../src/renderer/src/app/App.tsx";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { MovieDownload } from "../../src/renderer/src/features/downloads/DownloadControls.tsx";
import { DownloadsPage } from "../../src/renderer/src/features/downloads/DownloadsPage.tsx";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { syncDownloads, watchOffline } from "../../src/renderer/src/lib/downloads.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

/** A download of a movie of the test subscription, as main lists it; `over` changes it. */
function download(over: Partial<Download> = {}): Download {
  return {
    id: "d1",
    title: { kind: "movie", id: "m1" },
    subscription: { id: SUBSCRIPTION, name: "Home IPTV" },
    name: "Past Lives",
    episodeName: null,
    year: 2023,
    duration: 6360,
    originalLanguage: "ko",
    posterUrl: "mrstreamer://download/d1/poster",
    wideUrl: null,
    size: 2_300_000_000,
    status: { kind: "complete" },
    progress: null,
    ...over,
  };
}

const list = (items: readonly Download[], ended = 0): DownloadList => ({
  items,
  bytes: 13_000_000_000,
  free: 212_000_000_000,
  ended,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Waits, a little at a time, until the window shows what `ready` looks for. */
async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !ready(); tries++) {
    await act(settle);
  }
}

let unmount = () => {};
let stopSync = () => {};
afterEach(() => {
  unmount();
  stopSync();
  titlePlayer.close();
});

beforeEach(() => {
  ipc.reset();
  useUi.setState(useUi.getInitialState(), true);
});

/** Renders `element` in the page with a fresh query client that hears `downloads.changed`. */
async function show(element: ReactElement, ready: string): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stopSync = syncDownloads(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
    await settle();
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  await until(() => container.querySelector(ready) !== null);
  return container;
}

const button = (within: HTMLElement, text: string) =>
  [...within.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);
const labelled = (within: HTMLElement, label: string) =>
  within.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
/** Main says the list changed; waits until the window shows what `ready` looks for. */
async function changed(next: DownloadList, ready: () => boolean): Promise<void> {
  await act(async () => ipc.emit("downloads.changed", next));
  await until(ready);
}

const click = (element: HTMLElement | null | undefined) =>
  act(async () => {
    element?.click();
    await settle();
  });

describe("the Downloads page", () => {
  it("says how each download stands and does what its row offers", async () => {
    ipc.always(
      "downloads.list",
      list([
        download({
          id: "running",
          name: "Dune: Part Two",
          status: {
            kind: "transferring",
            received: 2_500_000_000,
            size: 4_100_000_000,
            rate: 2_000_000,
            restarted: false,
          },
        }),
        download({
          id: "waiting",
          name: "Severance",
          title: { kind: "episode", id: "e3", seriesId: "s", season: 2, episode: 3 },
          episodeName: "Who Is Alive?",
          status: { kind: "waiting" },
        }),
        download({
          id: "full",
          name: "Shōgun",
          status: { kind: "failed", failure: { kind: "disk-full", needed: 1_200_000_000 } },
        }),
        download({ id: "copy", progress: { position: 3900, duration: 6360 } }),
        download({ id: "kept", name: "Oppenheimer", subscription: null }),
      ]),
    );
    const page = await show(createElement(DownloadsPage), "[data-download]");
    const text = page.textContent ?? "";
    expect(text).toContain("13 GB on this computer · 212 GB free");
    expect(text).toContain("60% · 2.5 GB of 4.1 GB · 13 min left");
    expect(text).toContain("Severance · S2 E3 · Who Is Alive?");
    expect(text).toContain("Waiting while Home IPTV plays");
    expect(text).toContain("Disk full. Free 1.2 GB, then retry.");
    expect(text).toContain("41 min left");
    expect(text).toContain("Subscription removed, copy kept");
    // The queue comes before the copies.
    expect(text.indexOf("Queue")).toBeLessThan(text.indexOf("On this computer"));

    const row = (id: string) => page.querySelector<HTMLElement>(`[data-download="${id}"]`)!;
    await click(button(row("running"), "Cancel"));
    await click(button(row("full"), "Retry"));
    expect(ipc.argsOf("downloads.remove")).toEqual([{ id: "running" }]);
    expect(ipc.argsOf("downloads.retry")).toEqual([{ id: "full" }]);
    // A copy goes only once the viewer says so twice.
    await click(button(row("kept"), "Delete"));
    expect(ipc.argsOf("downloads.remove")).toEqual([{ id: "running" }]);
    await click(button(row("kept"), "Delete copy"));
    expect(ipc.argsOf("downloads.remove")).toEqual([{ id: "running" }, { id: "kept" }]);
  });

  it("follows main's word on the list as it changes", async () => {
    ipc.always("downloads.list", list([download({ status: { kind: "queued" } })]));
    const page = await show(createElement(DownloadsPage), "[data-download]");
    expect(page.textContent).toContain("Queued");
    await changed(list([download()], 2), () => button(page, "Watch offline") !== undefined);
    expect(button(page, "Watch offline")).toBeDefined();
    expect(page.textContent).toContain("Unfinished downloads ended with their subscription.");
  });
});

describe("with no subscription saved", () => {
  it("opens the copies from Connect, and Add subscription goes back to the form", async () => {
    ipc.always("subscription.list", []);
    ipc.always("downloads.list", list([download({ subscription: null })]));
    const app = await show(createElement(App), "form");
    expect(app.querySelector("form")).not.toBeNull();
    await click(button(app, "Downloads"));
    expect(app.querySelector("form")).toBeNull();
    expect(app.textContent).toContain("Past Lives");
    expect(app.textContent).toContain("Subscription removed, copy kept");
    // Only Downloads is a page here.
    expect(
      [...app.querySelectorAll("header button")].map((each) => each.textContent?.trim()),
    ).toEqual(["Downloads", "Add subscription"]);
    await click(button(app, "Add subscription"));
    expect(app.querySelector("form")).not.toBeNull();
  });

  it("offers no Downloads on Connect while nothing is on this computer", async () => {
    ipc.always("subscription.list", []);
    ipc.always("downloads.list", list([]));
    const app = await show(createElement(App), "form");
    expect(app.querySelector("form")).not.toBeNull();
    expect(button(app, "Downloads")).toBeUndefined();
  });
});

describe("a copy playing offline", () => {
  const offers: OutputStatus = {
    offers: ["airplay"],
    airplayRoutes: true,
    scanning: false,
    receivers: [],
    output: { kind: "local" },
  };

  it("plays from this computer with its own progress, and asks nobody online", async () => {
    ipc.emit("output.changed", offers);
    const opened = ipc.hold("playback.openCopy");
    const watch = await show(createElement(TitleWatch), "body");
    await act(async () => {
      useUi.setState({ playingTitle: true });
      watchOffline(download({ progress: { position: 1200, duration: 6360 } }));
      opened.resolve({
        sessionId: "c1",
        copy: "d1",
        url: "http://127.0.0.1/title/c1.mp4",
        duration: 6360,
        audio: [],
        subtitles: [],
      });
      await settle();
    });
    expect(ipc.argsOf("playback.openCopy")).toEqual([{ copy: "d1", decoders: expect.any(Array) }]);
    expect(watch.textContent).toContain("Past Lives");
    expect(watch.textContent).toContain("2023 · Offline");
    // A copy plays here only: the receivers' button isn't offered.
    expect(labelled(watch, "AirPlay")).toBeNull();
    await click(labelled(watch, "Subtitles"));
    expect(document.body.textContent).not.toContain("Find online");
    await act(async () => {
      titlePlayer.close();
      await settle();
    });
    // Resumed a few seconds back, and kept with the copy as it closes.
    expect(ipc.argsOf("downloads.recordProgress")).toEqual([
      { id: "d1", position: 1195, duration: 6360 },
    ]);
    const methods = ipc.methods();
    for (const online of [
      "playback.openTitle",
      "viewing.recordProgress",
      "viewing.episodes",
      "output.openTitle",
      "subtitles.search",
      "ondemand.details",
    ] as const) {
      expect(methods).not.toContain(online);
    }
  });
});

describe("a movie's Download in its details", () => {
  const ref = { kind: "movie", subscriptionId: SUBSCRIPTION, id: "m1" } as const;

  it("queues the exact version and follows it to Watch offline", async () => {
    ipc.always("downloads.list", list([]));
    ipc.always("downloads.add", download({ status: { kind: "queued" } }));
    const details = await show(createElement(MovieDownload, { title: ref }), "button");
    await click(button(details, "Download"));
    expect(ipc.argsOf("downloads.add")).toEqual([{ title: ref }]);
    const running = download({
      status: { kind: "transferring", received: 62, size: 100, rate: null, restarted: false },
    });
    await changed(
      list([running]),
      () => labelled(details, "Downloading 62%, cancel download") !== null,
    );
    expect(labelled(details, "Downloading 62%, cancel download")).not.toBeNull();
    const full = download({
      status: { kind: "failed", failure: { kind: "disk-full", needed: null } },
    });
    const retry = () =>
      [...details.querySelectorAll("button")].find((each) => each.textContent?.includes("Retry"));
    await changed(list([full]), () => retry() !== undefined);
    expect(retry()?.textContent).toContain("Disk full");
    await click(retry());
    expect(ipc.argsOf("downloads.retry")).toEqual([{ id: "d1" }]);
    await changed(list([download()]), () => button(details, "Watch offline") !== undefined);
    expect(button(details, "Watch offline")).toBeDefined();
  });

  it("is another version's own: a download of one version isn't shown for another", async () => {
    ipc.always("downloads.list", list([download({ title: { kind: "movie", id: "other" } })]));
    const details = await show(createElement(MovieDownload, { title: ref }), "button");
    expect(button(details, "Download")).toBeDefined();
  });
});
