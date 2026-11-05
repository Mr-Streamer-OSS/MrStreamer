import { expect, it } from "vitest";
import { sourceStreams } from "../src/player/resolve.ts";
import type { Credentials } from "../src/platform/credentials.ts";

it("requires fresh spare provider capacity and refuses unknown, exhausted and failed accounting", async () => {
  let active: string | null = "1";
  let failed = false;
  let reads = 0;

  const credentials: Credentials = {
    read: async () => ({
      kind: "xtream",
      server: "http://provider.invalid",
      username: "fixture",
      password: "fixture",
    }),
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
  };

  const resolve = sourceStreams({
    credentials,
    userAgent: "test",
    now: Date.now,
    fetch: async () => {
      reads++;

      if (failed) throw new Error("offline");

      return Response.json({
        user_info: { auth: 1, status: "Active", max_connections: "2", active_cons: active },
      });
    },
  });

  const signal = new AbortController().signal;
  expect(await resolve.canOverlap?.("source", signal)).toBe(true);
  active = "2";
  expect(await resolve.canOverlap?.("source", signal)).toBe(false);
  active = null;
  expect(await resolve.canOverlap?.("source", signal)).toBe(false);
  failed = true;
  await expect(resolve.canOverlap?.("source", signal)).rejects.toBeDefined();
  expect(reads).toBe(4);
});
