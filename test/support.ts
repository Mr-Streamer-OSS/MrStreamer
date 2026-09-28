// Shared test helpers: a mock provider per test and throwaway data folders.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { Secrets } from "../src/main/platform/secrets.ts";
import {
  startMockProvider,
  type MockProvider,
  type MockProviderOptions,
} from "../tools/mock-provider/app.ts";
import { nullPacketSource } from "../tools/mock-provider/streams.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export async function mockProvider(
  options: Partial<MockProviderOptions> = {},
): Promise<MockProvider> {
  const provider = await startMockProvider({
    streams: nullPacketSource(),
    channels: 300,
    ...options,
  });
  cleanups.push(() => provider.close());
  return provider;
}

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mr-streamer-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Reversible stand-in for the Keychain. Sealed values never contain the plain text. */
export const testSecrets: Secrets = {
  seal: (plain) => Buffer.from(plain, "utf8").toString("base64").split("").reverse().join(""),
  open: (sealed) => Buffer.from(sealed.split("").reverse().join(""), "base64").toString("utf8"),
};

export const userAgent = "MrStreamer/test";
