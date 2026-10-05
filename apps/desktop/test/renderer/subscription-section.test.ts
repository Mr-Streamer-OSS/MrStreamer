// @vitest-environment happy-dom
// Settings > Subscription for a playlist: the Guide row tells a playlist that names no guide,
// which is no failure, from a guide that couldn't be had, and its refresh button asks again
// either way. The status says which secret the keychain lost.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { GuideStatus } from "@mrstreamer/contracts/guide";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { SubscriptionSection } from "../../src/renderer/src/features/settings/SubscriptionSection.tsx";

let unmount = () => {};
afterEach(() => unmount());

const playlist: SubscriptionSummary = {
  kind: "m3u",
  id: "m3u:0123456789abcdef",
  server: "https://iptv.example.com",
  username: "",
  account: { state: "active", expiresAt: null, maxConnections: null, activeConnections: null },
  needsSecret: false,
};

const NONE: GuideStatus = { channels: 0, fetchedAt: null, availability: "none" };

/** Lets the screen take in what was just answered. */
const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

/** The section for `subscription`, with the guide as the main process last described it. */
async function section(subscription: SubscriptionSummary, guide: GuideStatus) {
  ipc.reset();
  const client = new QueryClient();
  client.setQueryData(["subscription"], subscription);
  client.setQueryData(["guide", "status"], guide);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(SubscriptionSection))),
  );
  unmount = () => act(() => root.unmount());
  /** The Guide row: its words, and the line under it when a refresh failed. */
  const guideRow = () => {
    const refresh = container.querySelector('[aria-label="Refresh guide"]');
    const row = refresh?.parentElement?.parentElement;
    const under = row?.nextElementSibling;
    return {
      refresh,
      text: row?.textContent ?? "",
      failure: under?.tagName === "P" ? under.textContent : null,
    };
  };
  return { container, guideRow };
}

describe("the Guide row of a playlist", () => {
  it("says a playlist names none, and stays that way when a refresh finds none again", async () => {
    const { guideRow } = await section(playlist, NONE);
    expect(guideRow().text).toBe("Guide · none in this playlist");

    const answer = ipc.hold("guide.refresh");
    await act(async () => (guideRow().refresh as HTMLElement).click());
    answer.resolve(NONE);
    await settled();

    expect(ipc.argsOf("guide.refresh")).toHaveLength(1);
    expect(guideRow()).toMatchObject({ text: "Guide · none in this playlist", failure: null });
  });

  it("shows the guide a refresh found", async () => {
    const { guideRow } = await section(playlist, NONE);

    const answer = ipc.hold("guide.refresh");
    await act(async () => (guideRow().refresh as HTMLElement).click());
    answer.resolve({ channels: 8310, fetchedAt: Date.now(), availability: "available" });
    await settled();

    expect(guideRow()).toMatchObject({
      text: `Guide · ${(8310).toLocaleString()} channelsjust now`,
      failure: null,
    });
  });

  it("says why under the row when the playlist can't be read, and keeps what it said", async () => {
    const { guideRow } = await section(playlist, NONE);

    const answer = ipc.hold("guide.refresh");
    await act(async () => (guideRow().refresh as HTMLElement).click());
    answer.reject({
      kind: "unreachable",
      server: "https://iptv.example.com",
      detail: "The server did not answer.",
    });
    await settled();

    expect(guideRow()).toEqual({
      refresh: expect.anything(),
      text: "Guide · none in this playlist",
      failure: "Can't reach iptv.example.com. The server did not answer.",
    });
  });

  it("says a guide isn't loaded yet while nothing says the playlist has none", async () => {
    const { guideRow } = await section(playlist, {
      channels: 0,
      fetchedAt: null,
      availability: "unknown",
    });

    expect(guideRow().text).toBe("Guide · not loaded yet");
  });
});

describe("the status of a subscription whose keychain lost its secret", () => {
  it.each([
    { kind: "m3u", note: "needs your playlist link again" },
    { kind: "xtream", note: "needs your password again" },
  ] as const)("says a $kind subscription $note", async ({ kind, note }) => {
    const { container } = await section({ ...playlist, kind, needsSecret: true }, NONE);

    expect(container.textContent).toContain(`Status · ${note}`);
  });
});
