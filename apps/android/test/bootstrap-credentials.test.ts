import { describe, expect, it, vi } from "vitest";
import { nativeCredentials } from "../src/platform/credentials.ts";

// The JS side of the Keystore-sealed credentials (modules/credentials), over a stand-in for the
// native module: what the app reads back, and how a refusal reaches it.

vi.mock("expo", () => ({
  requireNativeModule: () => {
    throw new Error("tests pass their own native module");
  },
}));

function native() {
  const sealed = new Map<string, string>();
  let refuse = false;
  const guard = () => {
    if (refuse) throw new Error("KeyStoreException");
  };
  return {
    sealed,
    refuse: () => void (refuse = true),
    module: {
      read: async (id: string) => (guard(), sealed.get(id) ?? null),
      write: async (id: string, secret: string) => void (guard(), sealed.set(id, secret)),
      remove: async (id: string) => void (guard(), sealed.delete(id)),
      retain: async (ids: readonly string[]) => {
        guard();
        for (const id of sealed.keys()) if (!ids.includes(id)) sealed.delete(id);
      },
    },
  };
}

describe("Android credentials", () => {
  it("reads back each source's authority as written, in the JSON native workers read", async () => {
    const phone = native();
    const credentials = nativeCredentials(phone.module);
    const authority = {
      kind: "xtream",
      server: "http://tv.example",
      username: "u",
      password: "p",
    } as const;

    await credentials.write("xtream:1", authority);

    expect(JSON.parse(phone.sealed.get("xtream:1") ?? "")).toEqual(authority);
    expect(await credentials.read("xtream:1")).toEqual(authority);
    await credentials.remove("xtream:1");
    expect(await credentials.read("xtream:1")).toBeNull();
  });

  it("reports every native refusal as keychain-refused", async () => {
    const phone = native();
    const credentials = nativeCredentials(phone.module);
    phone.refuse();

    for (const attempt of [
      credentials.read("a"),
      credentials.write("a", { kind: "m3u", link: "http://x.example/list.m3u" }),
      credentials.remove("a"),
      credentials.retain(["a"]),
    ])
      await expect(attempt).rejects.toMatchObject({ error: { kind: "keychain-refused" } });
  });
});
