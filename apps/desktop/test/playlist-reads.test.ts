import { describe, expect, it, vi } from "vitest";
import { playlistProvider } from "../src/main/providers/m3u.ts";

const link = "https://example.test/list";
const encoder = new TextEncoder();

function entries(names: readonly string[]): string {
  return names
    .map((name) => `#EXTINF:-1 tvg-id="${name}",${name}\nhttps://example.test/${name}\n`)
    .join("");
}

/**
 * A playlist host whose answers the test writes as it goes, as a slow server sends them. Each
 * request gets a body the test pushes text into and ends; like `fetch`, aborting the request's
 * signal fails its body.
 */
function slowHost() {
  const requests: { signal: AbortSignal; send(text: string): void; end(): void }[] = [];

  const fetch: typeof globalThis.fetch = async (_url, init = {}) => {
    const signal = init.signal ?? new AbortController().signal;
    let body!: ReadableStreamDefaultController<Uint8Array>;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => void (body = controller),
    });

    signal.addEventListener("abort", () => body.error(signal.reason), { once: true });

    requests.push({
      signal,
      send: (text) => body.enqueue(encoder.encode(text)),
      end: () => body.close(),
    });

    return new Response(stream);
  };

  return { requests, provider: playlistProvider({ link }, { userAgent: "test", fetch }) };
}

describe("shared playlist reads", () => {
  it("stops a read every caller gave up on, and reads afresh for the next caller", async () => {
    const { requests, provider } = slowHost();
    const leaving = new AbortController();
    const abandoned = provider.liveCatalogue(leaving.signal);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0]!.send("#EXTM3U\n" + entries(["early"]));

    leaving.abort();
    // Arrives while the stopped read is still unwinding.
    const next = provider.liveCatalogue();
    await expect(abandoned).rejects.toBe(leaving.signal.reason);
    await vi.waitFor(() => expect(requests[0]!.signal.aborted).toBe(true));

    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.send("#EXTM3U\n" + entries(["early", "late"]));
    // Once the stopped read has ended, a later caller still shares the fresh one.
    const joining = provider.onDemandCatalogue();
    requests[1]!.end();
    expect((await next).channels.map((channel) => channel.name)).toEqual(["early", "late"]);
    expect(requests).toHaveLength(2);
    await joining;
    expect(provider.currentLiveStream!("late")).toMatchObject({ url: "https://example.test/late" });
  });

  it("keeps a read going for the caller still waiting when another gives up", async () => {
    const { requests, provider } = slowHost();
    const leaving = new AbortController();
    const abandoned = provider.liveCatalogue(leaving.signal);
    const staying = provider.onDemandCatalogue(new AbortController().signal);
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    leaving.abort();
    await expect(abandoned).rejects.toBe(leaving.signal.reason);
    expect(requests[0]!.signal.aborted).toBe(false);
    requests[0]!.send("#EXTM3U\n" + entries(["only"]));
    requests[0]!.end();
    await staying;

    expect(requests).toHaveLength(1);
    expect(provider.currentLiveStream!("only")).toMatchObject({ url: "https://example.test/only" });
  });
});
