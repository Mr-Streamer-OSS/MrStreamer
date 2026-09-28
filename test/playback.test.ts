import { describe, expect, it } from "vitest";
import { createPlayback } from "../src/main/services/playback.ts";
import { createSubscriptions } from "../src/main/services/subscription.ts";
import { mockProvider, tempDir, testSecrets, userAgent } from "./support.ts";

async function connectedPlayback(slotReleaseMs = 300) {
  const provider = await mockProvider({ maxConnections: 1, slotReleaseMs });
  const subscriptions = createSubscriptions({
    dataDir: await tempDir(),
    secrets: testSecrets,
    providerOptions: { userAgent },
  });
  await subscriptions.connect({ server: provider.url, username: "demo", password: "demo" });
  const playback = createPlayback({ source: subscriptions.source, userAgent });
  return { provider, playback };
}

/** Reads the first bytes of a stream, then leaves the response open like a player would. */
async function firstBytes(
  url: string,
): Promise<{ status: number; bytes: number; stop: () => void }> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body)
    return { status: response.status, bytes: 0, stop: () => controller.abort() };
  const { value } = await response.body.getReader().read();
  return { status: response.status, bytes: value?.length ?? 0, stop: () => controller.abort() };
}

describe("playback", () => {
  it("streams a channel through a local URL without the login in it", async () => {
    const { playback } = await connectedPlayback();

    const session = await playback.open("2010");
    const stream = await firstBytes(session.url);

    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/stream\//);
    expect(session.url).not.toContain("demo");
    expect(stream).toMatchObject({ status: 200 });
    expect(stream.bytes).toBeGreaterThan(0);
    stream.stop();
    await playback.dispose();
  });

  it("releases the previous stream when switching on a one-connection subscription", async () => {
    const { provider, playback } = await connectedPlayback(300);

    const first = await playback.open("2010");
    const firstStream = await firstBytes(first.url);
    expect(provider.activeStreams()).toBe(1);

    const second = await playback.open("2011");
    const secondStream = await firstBytes(second.url);

    expect(secondStream.status).toBe(200);
    expect(provider.activeStreams()).toBe(1);
    expect((await fetch(first.url)).status).toBe(410);
    firstStream.stop();
    secondStream.stop();
    await playback.dispose();
  });

  it("explains a channel that is off air", async () => {
    const { playback } = await connectedPlayback();

    const session = await playback.open("1005");
    const stream = await firstBytes(session.url);

    expect(stream.status).toBe(404);
    expect(playback.failure(session.sessionId)).toEqual({ kind: "unavailable", status: 404 });
    await playback.dispose();
  });

  it("reports a refusal when the connection limit stays in use", async () => {
    const { provider, playback } = await connectedPlayback();
    // Someone else is watching on the only connection.
    const elsewhere = new AbortController();
    const other = await fetch(`${provider.url}/live/demo/demo/2012.ts`, {
      signal: elsewhere.signal,
    });
    expect(other.status).toBe(200);

    const session = await playback.open("2010");
    const stream = await firstBytes(session.url);

    expect(stream.status).toBe(403);
    expect(playback.failure(session.sessionId)).toEqual({ kind: "refused", status: 403 });
    elsewhere.abort();
    await playback.dispose();
  });
});
