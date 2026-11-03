import { beforeEach, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-file-system", () => ({
  Paths: { document: "private" },
  File: class {
    readonly name: string;

    constructor(_root: string, name: string) {
      this.name = name;
    }
    get exists() {
      return disk.has(this.name);
    }
    textSync() {
      return disk.get(this.name)!;
    }
    create() {
      disk.set(this.name, "");
    }
    writeSync(value: string) {
      disk.set(this.name, value);
    }
    moveSync(target: { name: string }) {
      disk.set(target.name, disk.get(this.name)!);
      disk.delete(this.name);
    }
  },
}));

vi.mock("../src/bootstrap/sources.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return { sources: { state: store({ kind: "ready", sources: [] }) } };
});

const { lists } = await import("../src/live/runtime.ts");

beforeEach(() => disk.clear());

it.each(["", "{unfinished"])(
  "recovers an interrupted first write (%j) through the runtime",
  (pending) => {
    disk.set("live-lists.json.next", pending);
    lists.read();
    expect(lists.state.get().kind).toBe("ready");
    const id = lists.create("Recovered");
    lists.read();
    expect(lists.state.get().lists.find((list) => list.id === id)?.name).toBe("Recovered");
  },
);
