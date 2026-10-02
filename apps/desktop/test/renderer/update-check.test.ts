// @vitest-environment happy-dom
// Settings > General's Updates: a newer release can come out after the one on offer, so Check now
// stays beside Download. While an update downloads or waits for its restart, there is nothing to
// check.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdatePhase, UpdateStatus } from "@mrstreamer/contracts/updates";
import { UpdatesSection } from "../../src/renderer/src/features/updates/UpdatesSection.tsx";

let unmount = () => {};
afterEach(() => unmount());

/** Settings' update rows for `update`, and the names of their buttons. */
async function buttonsFor(update: UpdatePhase): Promise<HTMLElement> {
  ipc.reset();
  const status: UpdateStatus = {
    version: "0.0.3-nightly.20261001.46",
    channel: "nightly",
    update,
    offer: { version: "0.0.3-nightly.20261002.47", notes: null, page: null },
    checked: { at: Date.now(), failure: null },
    nextCheckAt: null,
    dismissed: null,
  };
  const client = new QueryClient();
  client.setQueryData(["updates"], status);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(UpdatesSection))),
  );
  unmount = () => act(() => root.unmount());
  return container;
}

const named = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === text);

describe("checking for updates in Settings", () => {
  it("stays at hand while a release is on offer", async () => {
    const rows = await buttonsFor({ kind: "available", version: "0.0.3-nightly.20261002.47" });

    expect(named(rows, "Download")).toBeDefined();
    await act(async () => named(rows, "Check now")?.click());
    expect(ipc.argsOf("updates.check")).toHaveLength(1);
  });

  it.each([
    { kind: "downloading", version: "0.0.3-nightly.20261002.47", percent: 40 } as const,
    { kind: "ready", version: "0.0.3-nightly.20261002.47" } as const,
  ])("isn't offered while an update is $kind", async (update) => {
    expect(named(await buttonsFor(update), "Check now")).toBeUndefined();
  });
});
