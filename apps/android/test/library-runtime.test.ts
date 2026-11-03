import { expect, it, vi } from "vitest";
import { store } from "../src/platform/store.ts";
import type { Sources } from "../src/connect/sources.ts";
import { fixture } from "./library-fixture.ts";

const bootstrap = vi.hoisted(() => ({ sources: {} }));

vi.mock("../src/bootstrap/sources.ts", () => bootstrap);

it("reports lost Xtream logins, excludes M3U and refreshes only for changed logins or ids", async () => {
  const { source } = fixture();
  const catalogue = vi.fn(source.catalogue);

  let reader = {
    onDemandCatalogue: catalogue,
    movieDetails: (id: string) => source.details("movie", id),
    seriesDetails: (id: string) => source.details("series", id),
  };

  const state = store<Sources>({
    kind: "ready",
    sources: [
      { id: "lost", label: "Lost login", kind: "xtream", channels: { kind: "loading" } },
      { id: "playlist", label: "Playlist", kind: "m3u", channels: { kind: "loading" } },
      { id: "working", label: "Working", kind: "xtream", channels: { kind: "loading" } },
    ],
  });

  Object.assign(bootstrap.sources, {
    state,
    onDemand: (id: string) => (id === "working" ? reader : null),
  });
  const { library, setLibraryMetadata } = await import("../src/library/runtime.ts");
  const model = library();

  try {
    await vi.waitFor(() => expect(model.state.get().loading).toBe(false));
    expect(catalogue).toHaveBeenCalledTimes(1);
    const current = state.get();

    if (current.kind !== "ready") throw new Error("Not ready");
    state.set({
      ...current,
      sources: current.sources.map((s) => ({ ...s, channels: { kind: "ready", rows: [] } })),
    });
    await Promise.resolve();
    expect(catalogue).toHaveBeenCalledTimes(1);
    expect(model.state.get().failures).toEqual(["Lost login"]);
    reader = { ...reader };
    state.set({ ...current });
    await vi.waitFor(() => expect(catalogue).toHaveBeenCalledTimes(2));
    await model.refresh();
    expect(catalogue).toHaveBeenCalledTimes(3);
  } finally {
    setLibraryMetadata(undefined);
  }
});
