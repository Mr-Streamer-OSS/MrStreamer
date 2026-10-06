// @vitest-environment happy-dom
// A film's details play the version they were opened on when the opener named one, as the 4K tab
// names a film's 4K version, even when it is the version the film shows first and another has
// progress, unless the viewer picked a version for the film.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { defaultSubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { queries } from "../../src/renderer/src/lib/queries.ts";

/** A film in two versions: HD, shown first, and 4K, added earlier. */
const film: Title = {
  kind: "movie",
  subscriptionId: SUBSCRIPTION,
  id: "hd",
  name: "Night Harbour 1080p (EN)",
  title: "Night Harbour",
  originalTitle: null,
  originalLanguage: "en",
  tags: ["EN", "1080p"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "603",
  genres: [],
  versions: [
    { subscriptionId: SUBSCRIPTION, id: "hd", tags: ["EN", "1080p"] },
    { subscriptionId: SUBSCRIPTION, id: "4k", tags: ["EN", "4K"] },
  ],
};

let unmount = () => {};
afterEach(() => unmount());

/**
 * Opens the details on version `id`, with `picks` as what the viewer left its subscription at,
 * and says which version's details they ask for.
 */
async function opened(
  id: string,
  picks = defaultSubscriptionPreferences,
  { title = film, asked = false, played = [] as readonly TitleProgress[] } = {},
): Promise<string | undefined> {
  ipc.reset();
  const listed = ipc.hold("ondemand.titles");
  const progress = ipc.hold("viewing.progress");
  const client = new QueryClient();
  client.setQueryData(queries.subscriptionPreferences(SUBSCRIPTION).queryKey, picks);
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DetailsView, {
          target: { kind: "movie", subscriptionId: SUBSCRIPTION, id, asked },
        }),
      ),
    ),
  );
  unmount = () => act(() => root.unmount());
  await act(async () => listed.resolve([title]));
  await act(async () => progress.resolve(played));
  // The details are asked for once React Query has passed both answers on.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const requested = ipc.argsOf("ondemand.details").at(-1);
  // Asked of the subscription that lists the film, and of no other.
  expect(requested?.version.subscriptionId ?? SUBSCRIPTION).toBe(SUBSCRIPTION);
  return requested?.version.id;
}

describe("a film's details", () => {
  it("play the 4K version when opened from the 4K tab", async () => {
    expect(await opened("4k")).toBe("4k");
  });

  it("play the version that suits best when opened on it", async () => {
    expect(await opened("hd")).toBe("hd");
  });

  it("play the 4K version from the 4K tab when it is the one shown first, though HD has progress", async () => {
    const fourKFirst: Title = { ...film, id: "4k", versions: film.versions.toReversed() };
    const halfway: TitleProgress = {
      title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "hd" },
      position: 3000,
      duration: 6000,
      finished: false,
      at: 1,
    };

    expect(
      await opened("4k", defaultSubscriptionPreferences, {
        title: fourKFirst,
        asked: true,
        played: [halfway],
      }),
    ).toBe("4k");
    // Opened anywhere else, it carries on where the viewer stopped.
    expect(
      await opened("4k", defaultSubscriptionPreferences, { title: fourKFirst, played: [halfway] }),
    ).toBe("hd");
  });

  it("play the version the viewer picked for the film, wherever they were opened", async () => {
    const picked = { ...defaultSubscriptionPreferences, titleVersions: { "movie:603": "hd" } };
    expect(await opened("4k", picked)).toBe("hd");
  });
});
