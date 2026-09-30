import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ArkErrors } from "arktype";

/**
 * Reads and validates a JSON file against an ArkType schema. Returns null when the file is
 * missing, unreadable or no longer matches, so callers treat stale formats like a first run.
 */
export async function readJsonFile<T>(
  path: string,
  schema: (data: unknown) => T | ArkErrors,
): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`[storage] ignoring unreadable ${path}`);
    return null;
  }
  const parsed = schema(data);
  if (parsed instanceof ArkErrors) {
    console.warn(`[storage] ignoring ${path}: ${parsed.summary}`);
    return null;
  }
  return parsed;
}

/** Writes JSON atomically: a crash mid-write leaves the previous file intact. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), "utf8");
  await rename(temp, path);
}

/** Deletes what writes interrupted by a crash or power loss left behind in `dir`. */
export async function removeUnfinishedWrites(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => []);
  const unfinished = names.filter((name) => /\.(json|xml)\.[0-9a-f-]{36}\.tmp$/.test(name));
  await Promise.all(unfinished.map((name) => rm(join(dir, name), { force: true })));
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
