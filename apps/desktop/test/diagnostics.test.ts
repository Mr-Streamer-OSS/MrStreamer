import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "@mrstreamer/core/diagnostics";
import { Guide } from "@mrstreamer/core/guide/service";
import { describe, expect, it, vi } from "vitest";
import { diagnosticsLog } from "../src/main/platform/diagnostics-log.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeGuide } from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

/** The entries in the diagnostics log of `dataDir`, oldest first. */
async function entries(dataDir: string): Promise<Diagnostic[]> {
  const text = await readFile(join(dataDir, "diagnostics.log"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Diagnostic);
}

describe("diagnostics", () => {
  it("records what the app did, and how it ended, without addresses, logins or channels", async () => {
    const provider = await fakeProvider({ password: "s3cret-pass" });
    provider.serveGuide(fakeGuide(provider.catalogue, Date.now()));
    const dataDir = await tempDir();
    const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    const subscriptions = await promised(runtime, Subscriptions);
    const library = await promised(runtime, Library);
    const guide = await promised(runtime, Guide);
    const playback = await promised(runtime, Playback);
    const channel = (name: string) =>
      String(provider.catalogue.channels.find((entry) => entry.name === name)?.streamId);

    const login = { server: provider.url, username: "demo", password: "wrong" };
    await expect(subscriptions.connect(login)).rejects.toThrow();
    await subscriptions.connect({ ...login, password: "s3cret-pass" });
    await library.refresh();
    await guide.refresh();
    const direct = await playback.open(channel("TEST | H.264 + AAC"), ["h264", "aac"]);
    await (await fetch(direct.url)).arrayBuffer();
    // No ffmpeg in this app, so a stream that needs converting has nowhere to go.
    const unsupported = await playback.open(channel("TEST | H.264 + MP2"), ["h264", "aac"]);
    await (await fetch(unsupported.url)).arrayBuffer();

    await vi.waitFor(async () => expect(await entries(dataDir)).toHaveLength(6));
    expect(await entries(dataDir)).toMatchObject([
      { op: "connect", outcome: "invalid-login", ms: expect.any(Number) },
      { op: "connect", outcome: "ok" },
      { op: "catalogue", outcome: "ok" },
      { op: "guide", outcome: "ok" },
      { op: "stream", delivery: "direct", outcome: "ok" },
      { op: "stream", delivery: "none", outcome: "unsupported" },
    ]);
    const log = await readFile(join(dataDir, "diagnostics.log"), "utf8");
    for (const secret of [new URL(provider.url).host, "s3cret-pass", "demo", "H.264 + AAC"]) {
      expect(log).not.toContain(secret);
    }
  });

  it("keeps the log and the one before it, each at most 512 KB", async () => {
    const dataDir = await tempDir();
    const log = diagnosticsLog(dataDir);

    for (let index = 0; index < 12_000; index++) {
      log.record({ op: "catalogue", ms: index, outcome: "ok" });
    }

    await vi.waitFor(async () =>
      expect((await entries(dataDir)).at(-1)).toMatchObject({ ms: 11_999 }),
    );
    const sizes = await Promise.all(
      ["diagnostics.log", "diagnostics.1.log"].map(
        async (name) => (await stat(join(dataDir, name))).size,
      ),
    );
    expect(sizes.every((size) => size > 0 && size <= 512 * 1024)).toBe(true);
  });
});
