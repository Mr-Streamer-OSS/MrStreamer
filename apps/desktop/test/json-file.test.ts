import { type as arkType } from "arktype";
// Controlled Windows error semantics on real temporary files/timers, not native Windows proof.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@mrstreamer/contracts/json";
import {
  readJson,
  readJsonResult,
  writeJsonResult,
  writeJsonFile,
} from "../src/main/platform/json-file.ts";
import {
  readReminders,
  writeReminders,
  type RemindersFile,
} from "../src/main/platform/reminders-file.ts";
import { tempDir } from "./support.ts";

const disk = vi.hoisted(() => ({
  failures: 0,
  code: "EPERM",
  attempts: [] as { from: string; to: string; previous: string; bytes: Buffer }[],
}));

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();

  const rename: typeof actual.rename = async (from, to) => {
    if (!arkType.keywords.string.root.allows(from) || !arkType.keywords.string.root.allows(to))
      throw new Error("This probe requires ordinary file paths");
    disk.attempts.push({
      from,
      to,
      previous: await actual.readFile(to, "utf8"),
      bytes: await actual.readFile(from),
    });

    if (disk.failures > 0) {
      disk.failures--;
      throw Object.assign(new Error("Controlled rename rejection"), { code: disk.code });
    }

    await actual.rename(from, to);
  };

  return { ...actual, rename };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  disk.attempts = [];
  disk.failures = 0;
});

async function destination() {
  const path = join(await tempDir(), "record.json");
  const previous = '{"revision":"old"}\n';
  await writeFile(path, previous);

  return { path, previous };
}

describe("atomic JSON replacement", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])(
    "recovers Windows %s twice using the same completed temporary bytes",
    async (code) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const { path, previous } = await destination();
      disk.failures = 2;
      disk.code = code;
      let serializations = 0;
      const next = { revision: "new", count: 1 };
      await writeJsonFile(path, {
        toJSON() {
          serializations++;

          return next;
        },
      });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(next);
      expect(serializations).toBe(1);
      expect(disk.attempts).toHaveLength(3);
      expect(new Set(disk.attempts.map((attempt) => attempt.from)).size).toBe(1);

      for (const attempt of disk.attempts) {
        expect(attempt.to).toBe(path);
        expect(attempt.previous).toBe(previous);
        expect(attempt.bytes.toString()).toBe(JSON.stringify(next));
      }

      expect(await readdir(dirname(path))).toEqual([basename(path)]);
    },
  );

  it("bounds permanent Windows denial and retains both the old destination and one new temp", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { path, previous } = await destination();
    disk.failures = Infinity;
    disk.code = "EBUSY";
    await expect(writeJsonFile(path, { revision: "new" })).rejects.toMatchObject({ code: "EBUSY" });
    expect(disk.attempts).toHaveLength(4);
    expect(await readFile(path, "utf8")).toBe(previous);
    const temporary = disk.attempts[0]!.from;
    expect(
      disk.attempts.every((attempt) => attempt.from === temporary && attempt.previous === previous),
    ).toBe(true);
    expect(JSON.parse(await readFile(temporary, "utf8"))).toEqual({ revision: "new" });
    expect((await readdir(dirname(path))).sort()).toEqual(
      [basename(path), basename(temporary)].sort(),
    );
  });

  it.each([
    ["win32", "ENOENT"],
    ["linux", "EPERM"],
  ])("propagates %s %s on the first attempt", async (os, code) => {
    Object.defineProperty(process, "platform", { value: os });
    const { path, previous } = await destination();
    disk.failures = Infinity;
    disk.code = code;
    await expect(writeJsonFile(path, { revision: "new" })).rejects.toMatchObject({ code });
    expect(disk.attempts).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(previous);
  });
});

describe("explicit persisted JSON outcomes", () => {
  const error = { kind: "unexpected", detail: "Keep this detail", advice: "retry" } as const;
  const decode = (value: Json) => ({ kind: "read", value }) as const;

  it("separates missing, literal null and malformed JSON without changing legacy reads", async () => {
    const path = join(await tempDir(), "value.json");
    expect(await readJsonResult(path, decode, () => error)).toEqual({ kind: "missing" });
    await writeFile(path, "null");
    expect(await readJsonResult(path, decode, () => error)).toEqual({ kind: "read", value: null });
    expect(await readJson(path)).toBeNull();
    await writeFile(path, "{ broken");
    expect(await readJsonResult(path, decode, () => error)).toEqual({ kind: "unreadable", error });
    expect(await readJson(path)).toBeNull();
  });

  it("retains decoder refusal and complete advice, including newer", async () => {
    const { path } = await destination();

    for (const kind of ["unreadable", "newer"] as const) {
      expect(
        await readJsonResult(
          path,
          () => ({ kind, error }),
          () => error,
        ),
      ).toEqual({ kind, error });
    }
  });

  it("classifies corrupt gzip and read I/O as unreadable while legacy I/O still rejects", async () => {
    const dir = await tempDir();
    const path = join(dir, "value.json.gz");
    await writeFile(path, "not gzip");
    expect(await readJsonResult(path, decode, () => error)).toEqual({ kind: "unreadable", error });
    expect(await readJsonResult(dir, decode, () => error)).toEqual({ kind: "unreadable", error });
    await expect(readJson(dir)).rejects.toBeDefined();
    expect(await writeJsonResult(path, { packed: true }, () => error)).toEqual({ kind: "written" });
    expect(await readJsonResult(path, decode, () => error)).toEqual({
      kind: "read",
      value: { packed: true },
    });
  });

  it("reports refused serialization and replacement, preserving previous destination and typed detail", async () => {
    const { path, previous } = await destination();
    expect(
      await writeJsonResult(
        path,
        {
          toJSON() {
            throw new Error("private");
          },
        },
        () => error,
      ),
    ).toEqual({ kind: "refused", error });
    expect(await readFile(path, "utf8")).toBe(previous);
    disk.failures = Infinity;
    disk.code = "EIO";
    expect(await writeJsonResult(path, { revision: "new" }, () => error)).toEqual({
      kind: "refused",
      error,
    });
    expect(await readFile(path, "utf8")).toBe(previous);
    disk.failures = 0;
    expect(await writeJsonResult(path, { revision: "new" }, () => error)).toEqual({
      kind: "written",
    });
    expect(await readJsonResult(path, decode, () => error)).toEqual({
      kind: "read",
      value: { revision: "new" },
    });
  });
});

describe("legacy reminder file compatibility", () => {
  it("keeps the missing-file read shape and distinguishes unreadable and newer files", async () => {
    const path = join(await tempDir(), "reminders.json");
    expect(await readReminders(path)).toEqual({
      kind: "read",
      file: { reminders: [], unread: new Map() },
    });
    await writeFile(path, "{ broken");
    expect(await readReminders(path)).toEqual({ kind: "refused", reason: "unreadable" });
    await writeFile(path, JSON.stringify({ version: 2 }));
    expect(await readReminders(path)).toEqual({ kind: "refused", reason: "newer" });
  });

  it("rejects a refused write, retains the previous file and round-trips opaque entries on retry", async () => {
    const { path, previous } = await destination();

    const file: RemindersFile = {
      reminders: [],
      unread: new Map([["source", [{ future: "retained" }]]]),
    };

    disk.failures = 1;
    disk.code = "EIO";

    await expect(writeReminders(path, file)).rejects.toMatchObject({ code: "EIO" });
    expect(await readFile(path, "utf8")).toBe(previous);
    await writeReminders(path, file);
    expect(await readReminders(path)).toEqual({ kind: "read", file });
  });
});
