// The diagnostics log in the data folder: one JSON line per entry, with the time. diagnostics.log
// grows to 512 KB, then becomes diagnostics.1.log, replacing the one before. Lines that arrive
// while a write runs go out together in the next. Writing never holds up or fails the work it
// describes; closing the layer waits for lines still being written.
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { Diagnostics, type Diagnostic } from "@mrstreamer/core/diagnostics";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const MAX_BYTES = 512 * 1024;

/** The log in `dataDir` as the app's diagnostics, until the runtime closes. */
export function diagnosticsLogLayer(dataDir: string) {
  return Layer.effect(
    Diagnostics,
    Effect.acquireRelease(
      Effect.sync(() => diagnosticsLog(dataDir)),
      (log) => Effect.promise(() => log.settled()),
    ),
  );
}

/** Diagnostics written to `dataDir`, in the order they happen. */
export function diagnosticsLog(dataDir: string) {
  const path = join(dataDir, "diagnostics.log");
  let size: number | null = null;
  let pending: string[] = [];
  /** The write in progress, if any. */
  let writing: Promise<void> | null = null;

  /** Writes what is pending, starting a new file whenever the next line would pass the limit. */
  async function drain(): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    size ??= await stat(path).then(
      (file) => file.size,
      () => 0,
    );
    while (pending.length > 0) {
      let chunk = "";
      let bytes = 0;
      let taken = 0;
      for (const line of pending) {
        const length = Buffer.byteLength(line);
        if (size + bytes + length > MAX_BYTES && size + bytes > 0) break;
        chunk += line;
        bytes += length;
        taken++;
      }
      if (taken === 0) {
        await rename(path, join(dataDir, "diagnostics.1.log"));
        size = 0;
        continue;
      }
      pending = pending.slice(taken);
      await appendFile(path, chunk);
      size += bytes;
    }
  }

  function flush(): void {
    if (writing) return;
    writing = drain()
      .catch(() => {
        // Lost lines are better than a broken app; the next entry tries again.
        pending = [];
        size = null;
      })
      .finally(() => {
        writing = null;
        if (pending.length > 0) flush();
      });
  }

  return {
    record(entry: Diagnostic) {
      pending.push(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
      flush();
    },
    /** Resolves once every line recorded so far is written, or given up on. */
    async settled(): Promise<void> {
      while (writing) await writing;
    },
  } satisfies (typeof Diagnostics)["Service"] & { settled(): Promise<void> };
}
