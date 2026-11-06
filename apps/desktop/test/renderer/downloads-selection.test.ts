// @vitest-environment happy-dom
// The Downloads page's household folder and selected downloads: Change folder through main's
// picker, the round boxes that select rows and series, the bar's actions sent only for the
// downloads they fit, Delete's second press, per-download answers with Try again, a move one copy
// at a time that stops at its first failure, Cancel move, and where the keyboard goes.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { DownloadsPage } from "../../src/renderer/src/features/downloads/DownloadsPage.tsx";
import { syncDownloads } from "../../src/renderer/src/lib/downloads.ts";

/** A finished movie copy, as main lists it; `over` changes it. */
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
    posterUrl: null,
    wideUrl: null,
    size: 2_300_000_000,
    status: { kind: "complete" },
    progress: null,
    series: null,
    ...over,
  };
}

const FOLDER = "/media/household/Media";

const list = (items: readonly Download[], moving: readonly string[] = []): DownloadList => ({
  storage: { path: FOLDER, moving },
  items,
  series: {},
  bytes: 13_000_000_000,
  free: 212_000_000_000,
  ended: 0,
});

const running = download({
  id: "running",
  name: "Dune: Part Two",
  status: { kind: "transferring", received: 1, size: 4, rate: 1, restarted: false },
});

const stopped = download({
  id: "stopped",
  name: "Shōgun",
  status: { kind: "failed", failure: { kind: "disk-full", needed: null } },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !ready(); tries++) await act(settle);

  if (!ready()) throw new Error("The window never showed what the test waited for.");
}

let unmount = () => {};
let stopSync = () => {};

afterEach(() => {
  unmount();
  stopSync();
});

beforeEach(() => {
  ipc.reset();
  useUi.setState(useUi.getInitialState(), true);
});

async function show(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stopSync = syncDownloads(client);
  const view = queryView(client);
  await view.render(createElement(DownloadsPage));
  unmount = view.unmount;
  await until(() => view.container.querySelector("[data-download]") !== null);

  return view.container;
}

const button = (within: Element, text: string) =>
  [...within.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);

const box = (within: Element, name: string) =>
  within.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="Select ${name}"]`)!;

const row = (page: Element, id: string) => page.querySelector(`[data-download="${id}"]`)!;
const bar = (page: Element) => page.querySelector<HTMLElement>("[data-selection]");

const click = (element: HTMLElement | null | undefined) =>
  act(async () => {
    element?.click();
    await settle();
  });

async function key(name: string, target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

describe("the Downloads page's folder", () => {
  it("says where new downloads go and changes it through main's picker only when one is chosen", async () => {
    ipc.always("downloads.list", list([download()]));
    ipc.always("downloads.chooseFolder", null);
    const page = await show();
    expect(page.textContent).toContain(`New downloads go to ${FOLDER}`);

    // Closing the picker changes nothing and says nothing.
    await click(button(page, "Change folder"));
    expect(ipc.argsOf("downloads.chooseFolder")).toHaveLength(1);
    expect(page.querySelector('[role="alert"]')).toBeNull();

    ipc.refuse("downloads.chooseFolder", {
      kind: "unexpected",
      detail: "Choose a folder outside managed copies",
    });
    await click(button(page, "Change folder"));
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "Choose a folder outside managed copies",
    );

    // Main's word on the new folder is what the page shows.
    await act(async () =>
      ipc.emit("downloads.changed", {
        ...list([download()]),
        storage: { path: "/mnt/usb/Films", moving: [] },
      }),
    );
    await until(() => page.textContent!.includes("New downloads go to /mnt/usb/Films"));
  });
});

describe("selected downloads", () => {
  it("sends each action only for the selected downloads it fits", async () => {
    ipc.always("downloads.list", list([running, stopped, download()]));
    ipc.answer("downloads.bulk", ({ ids }) => ({ succeeded: ids, failed: [] }));
    ipc.always("downloads.moveCopies", null);
    const page = await show();
    expect(bar(page)).toBeNull();

    await click(box(page, "Dune: Part Two"));
    await click(box(page, "Shōgun"));
    await click(box(page, "Past Lives"));
    expect(bar(page)?.textContent).toContain("3 selected");

    await click(button(bar(page)!, "Pause"));
    await click(button(bar(page)!, "Retry"));
    await click(button(bar(page)!, "Move to Media"));
    expect(ipc.argsOf("downloads.bulk")).toEqual([
      { ids: ["running"], action: "pause" },
      { ids: ["stopped"], action: "retry" },
    ]);
    expect(ipc.argsOf("downloads.moveCopies")).toEqual([{ ids: ["d1"] }]);
    // Nothing paused here, so there is nothing to resume.
    expect(button(bar(page)!, "Resume")).toBeUndefined();
    expect(page.querySelector('[role="status"]')?.textContent).toBe("1 of 1 done");
  });

  it("deletes only on a second press that names how many, and asks again once the keyboard leaves", async () => {
    ipc.always("downloads.list", list([running, download()]));
    ipc.answer("downloads.bulk", ({ ids }) => ({ succeeded: ids, failed: [] }));
    const page = await show();
    await click(box(page, "Dune: Part Two"));
    await click(box(page, "Past Lives"));

    await click(button(bar(page)!, "Delete"));
    expect(ipc.argsOf("downloads.bulk")).toEqual([]);
    const confirm = button(bar(page)!, "Delete 2 downloads")!;
    confirm.focus();
    await key("Escape", confirm);
    expect(button(bar(page)!, "Delete 2 downloads")).toBeUndefined();

    await click(button(bar(page)!, "Delete"));
    await act(async () => button(bar(page)!, "Delete 2 downloads")!.blur());
    expect(button(bar(page)!, "Delete")).toBeDefined();

    await click(button(bar(page)!, "Delete"));
    await click(button(bar(page)!, "Delete 2 downloads"));
    expect(ipc.argsOf("downloads.bulk")).toEqual([{ ids: ["running", "d1"], action: "remove" }]);
  });

  it("says why each failed one failed, keeps the rest done, and tries only those again", async () => {
    const other = download({ id: "d2", name: "Oppenheimer" });
    ipc.always("downloads.list", list([download(), other]));
    const denied = { kind: "unexpected", detail: "Permission denied" } as const;
    ipc.always("downloads.bulk", { succeeded: ["d1"], failed: [{ id: "d2", error: denied }] });
    const page = await show();
    await click(box(page, "Past Lives"));
    await click(box(page, "Oppenheimer"));
    await click(button(bar(page)!, "Delete"));
    await click(button(bar(page)!, "Delete 2 downloads"));

    const status = page.querySelector('[role="status"]')!;
    expect(status.textContent).toContain("1 of 2 done");
    expect(row(page, "d2").textContent).toContain("Permission denied");
    expect(row(page, "d1").textContent).not.toContain("Permission denied");

    ipc.always("downloads.bulk", { succeeded: ["d2"], failed: [] });
    await click(button(status, "Try again"));
    expect(ipc.argsOf("downloads.bulk").at(-1)).toEqual({ ids: ["d2"], action: "remove" });
    expect(page.querySelector('[role="status"]')?.textContent).toBe("1 of 1 done");
    expect(row(page, "d2").textContent).not.toContain("Permission denied");
  });

  it("moves copies one at a time, stops at the first failure and tries it and the rest again", async () => {
    const copies = ["a", "b", "c"].map((id) => download({ id, name: `Copy ${id}` }));
    ipc.always("downloads.list", list(copies));
    const full = { kind: "unexpected", detail: "Destination disk is full" } as const;
    ipc.always("downloads.moveCopies", null);
    const second = ipc.hold("downloads.moveCopies", ({ ids }) => ids[0] === "b");
    const page = await show();

    for (const id of ["a", "b", "c"]) await click(box(page, `Copy ${id}`));

    await click(button(bar(page)!, "Move to Media"));
    // Main says which copy is moving: its row says so, with Cancel move instead of Delete.
    await act(async () => ipc.emit("downloads.changed", list(copies, ["b"])));
    await until(() => row(page, "b").textContent!.includes("Moving to Media"));
    expect(button(row(page, "b"), "Cancel move")).toBeDefined();
    expect(button(row(page, "b"), "Delete")).toBeUndefined();

    await act(async () => second.reject(full));
    await act(async () => ipc.emit("downloads.changed", list(copies)));
    await until(() => !row(page, "b").textContent!.includes("Moving to Media"));
    expect(ipc.argsOf("downloads.moveCopies")).toEqual([{ ids: ["a"] }, { ids: ["b"] }]);
    expect(page.querySelector('[role="status"]')?.textContent).toContain("1 of 3 done");
    expect(row(page, "b").textContent).toContain("Destination disk is full");

    await click(button(page.querySelector('[role="status"]')!, "Try again"));
    expect(ipc.argsOf("downloads.moveCopies").slice(2)).toEqual([{ ids: ["b"] }, { ids: ["c"] }]);
    expect(page.querySelector('[role="status"]')?.textContent).toBe("2 of 2 done");
  });

  it("cancels a copy's move from its row", async () => {
    ipc.always("downloads.list", list([download()], ["d1"]));
    ipc.always("downloads.cancelMove", null);
    const page = await show();
    await click(button(row(page, "d1"), "Cancel move"));
    expect(ipc.argsOf("downloads.cancelMove")).toEqual([{ id: "d1" }]);
  });

  it("selects every copy of a series with its box, saying when only some are", async () => {
    const episode = (id: string, number: number) =>
      download({
        id,
        name: "Severance",
        title: { kind: "episode", id, seriesId: "s", season: 1, episode: number },
        episodeName: `Episode ${number}`,
        series: "severance",
      });

    ipc.always("downloads.list", {
      ...list([episode("e1", 1), episode("e2", 2)]),
      series: { severance: { seasons: [{ number: 1, episodes: [1, 2] }], sourceOrder: false } },
    });
    ipc.answer("downloads.bulk", ({ ids }) => ({ succeeded: ids, failed: [] }));
    const page = await show();
    const series = box(page, "Severance");
    await click(box(page, "Severance · Episode 1"));
    expect(series.indeterminate).toBe(true);
    expect(series.checked).toBe(false);

    await click(series);
    expect(series.indeterminate).toBe(false);
    expect(bar(page)?.textContent).toContain("2 selected");
    await click(series);
    expect(bar(page)).toBeNull();
  });

  it("gives the keyboard to the heading when the bar goes with it", async () => {
    ipc.always("downloads.list", list([download()]));
    const page = await show();
    await click(box(page, "Past Lives"));
    const done = button(bar(page)!, "Done")!;
    done.focus();
    await click(done);
    expect(bar(page)).toBeNull();
    expect(document.activeElement).toBe(page.querySelector("h1"));
    expect(box(page, "Past Lives").checked).toBe(false);
  });
});
