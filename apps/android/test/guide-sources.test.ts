import { expect, it, vi } from "vitest";

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));

vi.mock("expo-file-system", () => ({ File: class {}, Paths: {} }));

import { createGuides } from "../src/guide/guide-sources.ts";
import type { SecretStore } from "../src/guide/secrets.ts";

function setup() {
  const secrets = new Map<string, string>();
  let disk: unknown = null;
  let refused = false;

  const sealed: SecretStore = {
    read: async (id) => secrets.get(id) ?? null,
    write: async (id, value) => {
      secrets.set(id, value);
    },
    remove: async (id) => {
      secrets.delete(id);
    },
  };

  const owner = {
    configure: vi.fn(),
    attach: vi.fn(async () => {}),
    forget: vi.fn(async () => true),
    refresh: vi.fn(async () => {}),
  };

  const guides = createGuides(
    sealed,
    owner,
    () => disk,
    (value) => {
      if (refused) throw new Error("disk");
      disk = value;
    },
    () => 1,
  );

  guides.load();

  return {
    guides,
    secrets,
    owner,
    file: () => disk,
    refuse: () => {
      refused = true;
    },
  };
}

it("keeps custom guides in order and links only in sealed storage", async () => {
  const { guides, secrets, file } = setup();
  expect(await guides.add("https://guide.test/first?token=canary", "First")).toBeNull();
  expect(await guides.add("https://guide.test/second?token=other", "Second")).toBeNull();
  expect(guides.links().map((g) => g.name)).toEqual(["First", "Second"]);
  expect([...secrets.values()][0]).toContain("canary");
  expect(JSON.stringify(file())).not.toContain("canary");
  expect(await guides.add("https://guide.test/first?token=canary")).toBe("duplicate");
  const first = guides.links()[0]!.id;
  expect(await guides.replace(first, "https://guide.test/new?token=replaced")).toBeNull();
  expect(guides.links().map((g) => g.name)).toEqual(["First", "Second"]);
  expect(secrets.has(first)).toBe(false);
});

it("keeps mapping changes retryable when the file refuses a write", async () => {
  const { guides, refuse } = setup();
  expect(await guides.map("xtream:source:channel", "news.tv")).toBeNull();
  expect(guides.mappings().get("xtream:source:channel")).toBe("news.tv");
  refuse();
  expect(await guides.map("xtream:source:channel", null)).toBe("saving");
  expect(guides.mappings().get("xtream:source:channel")).toBe("news.tv");
});

it("clears overrides to automatic and refuses damaged registry replacement", async () => {
  const { guides } = setup();
  await guides.map("xtream:source:channel", "news.tv");
  expect(await guides.map("xtream:source:channel", null)).toBeNull();
  expect(guides.mappings().size).toBe(0);
  const write = vi.fn();

  const damaged = createGuides(
    { read: vi.fn(), write: vi.fn(), remove: vi.fn() },
    { configure: vi.fn(), attach: vi.fn(), forget: vi.fn(), refresh: vi.fn() },
    () => {
      throw new Error("unreadable");
    },
    write,
  );

  expect(damaged.load()).toEqual({ ids: [], kept: ["xmltv-"] });
  expect(await damaged.add("https://guide.test/xml")).toBe("saving");
  expect(write).not.toHaveBeenCalled();
});

it("refuses oversized names and links before writing sealed storage", async () => {
  const { guides, secrets } = setup();
  expect(await guides.add("https://fixture.test/guide", "n".repeat(201))).toBe("name");
  expect(await guides.add(`https://fixture.test/${"x".repeat(8192)}`)).toBe("address");
  expect(secrets.size).toBe(0);
});
