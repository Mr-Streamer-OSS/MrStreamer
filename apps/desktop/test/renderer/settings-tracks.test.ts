// @vitest-environment happy-dom
// Settings > General shows the languages as last saved, though a player saved them since the UI
// last read the preferences, as picking a sound or subtitle track does.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { GeneralSection } from "../../src/renderer/src/features/settings/GeneralSection.tsx";

let unmount = () => {};
afterEach(() => unmount());

describe("Settings > General", () => {
  it("shows the languages saved since the UI last read them", async () => {
    ipc.reset();
    const client = new QueryClient();
    // What the UI read before: Español. The main process now holds the defaults, as after a pick.
    client.setQueryData(["preferences"], { ...defaultPreferences, audioLanguage: "es" });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(GeneralSection))),
    );
    unmount = () => act(() => root.unmount());
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    const audio = container.querySelector<HTMLSelectElement>('select[aria-label="Audio in"]');
    expect(audio?.value).toBe("en");
  });
});
