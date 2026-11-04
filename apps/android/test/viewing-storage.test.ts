import { expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ files: new Map<string, string>(), interrupted: false }));

vi.mock("expo-file-system", () => ({
  Paths: { document: "test-viewing" },
  File: class {
    readonly name: string;
    constructor(_folder: string, name: string) {
      this.name = name;
    }
    get exists() {
      return disk.files.has(this.name);
    }
    textSync() {
      const text = disk.files.get(this.name);

      if (text === undefined) throw new Error("read");

      return text;
    }
    create() {
      disk.files.set(this.name, "");
    }
    writeSync(text: string) {
      disk.files.set(this.name, text);
    }
    moveSync(target: { name: string }) {
      if (disk.interrupted) throw new Error("interrupted");
      disk.files.set(target.name, this.textSync());
      disk.files.delete(this.name);
    }
  },
}));

import { writeJson } from "../src/platform/storage.ts";
import { readViewing } from "../src/home/storage.ts";

it("restores only committed viewing files after interrupted replacements, including the first write", () => {
  try {
    writeJson("viewing.json", { saved: 1 });
    disk.interrupted = true;
    expect(() => writeJson("viewing.json", { saved: 2 })).toThrow("interrupted");
    expect(readViewing("viewing.json")).toEqual({ saved: 1 });
    disk.files.delete("viewing.json");
    expect(readViewing("viewing.json")).toBe(null);
    disk.files.set("viewing.json", "damaged");
    expect(() => readViewing("viewing.json")).toThrow();
    disk.interrupted = false;
    writeJson("viewing.json", { saved: 3 });
    expect(readViewing("viewing.json")).toEqual({ saved: 3 });
  } finally {
    disk.files.clear();
    disk.interrupted = false;
  }
});
