// @vitest-environment happy-dom
// Remove subscription in Settings keeps the account's favourites, history and progress, unless
// the viewer ticks the box to delete them too.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { SubscriptionSection } from "../../src/renderer/src/features/settings/SubscriptionSection.tsx";

let unmount = () => {};
afterEach(() => unmount());

const subscription: SubscriptionSummary = {
  kind: "xtream",
  id: "https://line.example.tv|demo",
  server: "https://line.example.tv",
  username: "demo",
  account: { state: "active", expiresAt: null, maxConnections: 1, activeConnections: 0 },
  needsPassword: false,
};

async function section(): Promise<HTMLElement> {
  ipc.reset();
  const client = new QueryClient();
  client.setQueryData(["subscription"], subscription);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(SubscriptionSection))),
  );
  unmount = () => act(() => root.unmount());
  return container;
}

async function click(element: Element | undefined): Promise<void> {
  await act(async () => (element as HTMLElement | undefined)?.click());
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === text);

describe("removing the subscription", () => {
  it.each([
    { ticked: false, eraseViewing: false },
    { ticked: true, eraseViewing: true },
  ])(
    "asks to delete the viewing record only when ticked: $ticked",
    async ({ ticked, eraseViewing }) => {
      const settings = await section();
      await click(button(settings, "Remove subscription"));
      const box = settings.querySelector('[role="checkbox"]') ?? undefined;
      expect(box?.getAttribute("aria-checked")).toBe("false");
      // The label, as the viewer clicks its text or the box inside it.
      if (ticked) await click(box?.closest("label") ?? undefined);

      await click(button(settings, "Remove"));

      expect(ipc.argsOf("subscription.remove")).toEqual([{ eraseViewing }]);
    },
  );
});
