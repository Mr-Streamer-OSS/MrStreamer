// @vitest-environment happy-dom
// The system's media controls for a channel take play, pause and stop, never next or previous, so
// a headphone's double tap can't change channel. A view closing after the next one opened, as a
// movie does when a channel is picked over it, leaves the next one's controls in place.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";

/** Stands in for Chromium's session, keeping what the page set. */
const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
const session = {
  metadata: null as { title: string; artist: string } | null,
  playbackState: "none" as MediaSessionPlaybackState,
  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
    if (handler) handlers.set(action, handler);
    else handlers.delete(action);
  },
  setPositionState() {},
};
Object.defineProperty(navigator, "mediaSession", { value: session, configurable: true });
Object.assign(globalThis, {
  MediaMetadata: class {
    constructor(init: { title: string; artist: string }) {
      return init;
    }
  },
});
const { useLiveSession } = await import("../../src/renderer/src/player/media-session.ts");

const channel = (title: string): LiveChannel => ({
  id: title,
  name: `NL | ${title}`,
  title,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  variants: [],
});

function Watch({ channel }: { channel: LiveChannel }) {
  useLiveSession(channel);
  return null;
}

describe("the system's media controls", () => {
  it("offer a channel play, pause and stop, and outlive a view closing after it", async () => {
    ipc.reset();
    const root = createRoot(document.createElement("div"));
    const client = new QueryClient();
    const render = (...channels: LiveChannel[]) =>
      act(() =>
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            channels.map((each) => createElement(Watch, { key: each.id, channel: each })),
          ),
        ),
      );

    await render(channel("Arena 1"));
    expect([...handlers.keys()].sort()).toEqual(["pause", "play", "stop"]);

    // The second view opens before the first closes.
    await render(channel("Arena 1"), channel("Arena 2"));
    await render(channel("Arena 2"));
    expect(session.metadata?.title).toBe("Arena 2");
    expect([...handlers.keys()].sort()).toEqual(["pause", "play", "stop"]);
    await act(() => root.unmount());
    expect(session.metadata).toBeNull();
  });
});
