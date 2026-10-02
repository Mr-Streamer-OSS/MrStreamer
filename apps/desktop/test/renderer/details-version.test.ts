// @vitest-environment happy-dom
// A film's details play the version they were opened on when the opener named one, as the 4K tab
// names a film's 4K version, unless the viewer picked a version for the film.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";

/** A film in two versions: HD, shown first, and 4K, added earlier. */
const film: Title = {
  kind: "movie",
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
    { id: "hd", tags: ["EN", "1080p"] },
    { id: "4k", tags: ["EN", "4K"] },
  ],
};

let unmount = () => {};
afterEach(() => unmount());

/** Opens the details on version `id`, and says which version's details they ask for. */
async function opened(id: string, preferences = defaultPreferences): Promise<string | undefined> {
  ipc.reset();
  const listed = ipc.hold("ondemand.titles");
  const progress = ipc.hold("viewing.progress");
  const client = new QueryClient();
  client.setQueryData(["preferences"], preferences);
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DetailsView, { target: { kind: "movie", id } }),
      ),
    ),
  );
  unmount = () => act(() => root.unmount());
  await act(async () => listed.resolve([film]));
  await act(async () => progress.resolve([]));
  // The details are asked for once React Query has passed both answers on.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  const asked = ipc.argsOf("ondemand.details").at(-1);
  return (asked as { id: string } | undefined)?.id;
}

describe("a film's details", () => {
  it("play the 4K version when opened from the 4K tab", async () => {
    expect(await opened("4k")).toBe("4k");
  });

  it("play the version that suits best when opened on it", async () => {
    expect(await opened("hd")).toBe("hd");
  });

  it("play the version the viewer picked for the film, wherever they were opened", async () => {
    const picked = { ...defaultPreferences, titleVersions: { "movie:603": "hd" } };
    expect(await opened("4k", picked)).toBe("hd");
  });
});
