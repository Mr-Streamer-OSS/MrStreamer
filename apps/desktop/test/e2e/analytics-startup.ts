import { type } from "arktype";
import type { Page } from "./app.ts";

/** Observe owned startup I/O before the entrypoint runs. No record bytes or paths leave main. */
export async function startupProbe(
  main: Page,
  profile: string,
  delayMs: number,
  expectedPid: number | undefined,
) {
  const paused = Promise.withResolvers<void>();
  const removePauseListener = main.on("Debugger.paused", () => paused.resolve());
  await main.send("Debugger.enable");
  const started = await main.send("Runtime.runIfWaitingForDebugger");

  if (started.error) throw new Error("Could not start owned debugger.");
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      paused.promise,
      new Promise<never>((_resolve, reject) => {
        pauseTimer = setTimeout(() => reject(new Error("Owned startup did not pause.")), 2000);
      }),
    ]);
  } finally {
    if (pauseTimer) clearTimeout(pauseTimer);
    removePauseListener();
  }

  // Awaiting a promise while paused prevents Node's inspector from answering. Installation is
  // synchronous, and must complete before resuming the entrypoint.
  const reply = await main.send(
    "Runtime.evaluate",
    {
      expression: `(${install.toString()})(${JSON.stringify(profile)},${delayMs})`,
      awaitPromise: false,
      returnByValue: true,
    },
    2000,
  );

  const result = reply.result as
    { result?: { value?: { pid?: unknown } }; exceptionDetails?: unknown } | undefined;

  const pid = result?.result?.value?.pid;

  if (reply.error || result?.exceptionDetails || !type("number | number.NaN").allows(pid))
    throw new Error("Could not install owned startup probe.");

  if (pid !== expectedPid) throw new Error("Wrong main inspector process.");
  const resumed = await main.send("Debugger.resume");

  if (resumed.error) throw new Error("Could not resume owned startup.");
  await main.send("Debugger.disable");

  return {
    pid,
    read: () =>
      main.evaluate<ReturnType<typeof install>["operations"]>(
        "globalThis.__analyticsStartupIO.operations",
        2000,
      ),
    preferences: () =>
      main.evaluate<Pick<ReturnType<typeof install>, "preferenceReads" | "preferenceUpdates">>(
        "({preferenceReads:globalThis.__analyticsStartupIO.preferenceReads,preferenceUpdates:globalThis.__analyticsStartupIO.preferenceUpdates})",
        2000,
      ),
  };
}

function install(profile: string, delayMs: number) {
  if (
    !process.argv.includes(`--user-data-dir=${profile}`) ||
    !process.argv.includes("--enable-automation")
  )
    throw new Error("Startup probe requires the owned automated profile");
  const native = process.getBuiltinModule("fs");
  const fs = native.promises;
  const path = process.getBuiltinModule("path");
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const owned = normalize(native.realpathSync(profile));

  const matches = (value: string, directory: boolean): boolean => {
    if (!directory && path.basename(value) !== "analytics.json") return false;

    try {
      return normalize(native.realpathSync(directory ? value : path.dirname(value))) === owned;
    } catch {
      return false;
    }
  };

  const operations: {
    operation: "read" | "directory" | "replace";
    startedMs: number;
    endedMs: number | null;
    code: string | null;
    format: 1 | 2 | null;
  }[] = [];

  const started = performance.now();
  const preferenceReads: { startedMs: number; enabled: boolean | null }[] = [];

  /** Recognizes callable capabilities across realms without executing the candidate. */
  function isCallable(value: unknown): value is Function {
    try {
      Function.prototype.toString.call(value);

      return true;
    } catch {
      return false;
    }
  }

  const preferenceUpdates: {
    startedMs: number;
    endedMs: number | null;
    requested: boolean | null;
    ok: boolean | null;
    error: string | null;
  }[] = [];

  const { ipcMain } = process.getBuiltinModule("module").createRequire(process.execPath)(
    "electron",
  ) as typeof import("electron");

  ipcMain.handle = new Proxy(ipcMain.handle, {
    apply(target, receiver, [channel, listener]: Parameters<typeof ipcMain.handle>) {
      if (channel !== "preferences.get" && channel !== "preferences.update")
        return target.call(receiver, channel, listener);

      return target.call(
        receiver,
        channel,
        new Proxy(listener, {
          async apply(handler, context, args: Parameters<typeof listener>) {
            const sample = {
              startedMs: performance.now() - started,
              enabled: null as boolean | null,
            };

            const patch: unknown = args[1];
            const patchFields: { analyticsEnabled?: unknown } = Object(patch);

            const update = {
              startedMs: sample.startedMs,
              endedMs: null as number | null,
              requested:
                patch === Object(patch) &&
                !isCallable(patch) &&
                (patchFields.analyticsEnabled === true || patchFields.analyticsEnabled === false)
                  ? patchFields.analyticsEnabled
                  : null,
              ok: null as boolean | null,
              error: null as string | null,
            };

            if (channel === "preferences.get" && preferenceReads.length < 32)
              preferenceReads.push(sample);

            if (channel === "preferences.update" && preferenceUpdates.length < 32)
              preferenceUpdates.push(update);
            const reply: unknown = await handler.apply(context, args);
            update.endedMs = performance.now() - started;

            const fields: { ok?: unknown; error?: unknown; value?: unknown } = Object(reply);

            if (reply === Object(reply) && !isCallable(reply)) {
              if (fields.ok === true || fields.ok === false) update.ok = fields.ok;
              const failure: { detail?: unknown } = Object(fields.error);

              if (
                fields.error === Object(fields.error) &&
                !isCallable(fields.error) &&
                failure.detail === "Analytics preference could not be saved."
              )
                update.error = failure.detail;
              const result: { preferences?: unknown } = Object(fields.value);
              const preferences: { analyticsEnabled?: unknown } = Object(result.preferences);

              if (
                fields.value === Object(fields.value) &&
                !isCallable(fields.value) &&
                result.preferences === Object(result.preferences) &&
                !isCallable(result.preferences) &&
                (preferences.analyticsEnabled === true || preferences.analyticsEnabled === false)
              )
                sample.enabled = preferences.analyticsEnabled;
            }

            return reply;
          },
        }),
      );
    },
  });
  let delayed = false;

  const observe = async (
    operation: "read" | "directory" | "replace",
    run: () => ReturnType<typeof fs.readFile | typeof fs.readdir | typeof fs.rename>,
  ) => {
    const sample = {
      operation,
      startedMs: performance.now() - started,
      endedMs: null as number | null,
      code: null as string | null,
      format: null as 1 | 2 | null,
    };

    if (operations.length < 32) operations.push(sample);

    try {
      if (operation === "read" && delayMs && !delayed) {
        delayed = true;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }

      const value = await run();

      let bytes: string | Buffer | null = Buffer.isBuffer(value) ? value : null;

      if (operation === "read" && bytes === null) {
        try {
          const text = String.prototype.valueOf.call(value);

          if (text === value) bytes = text;
        } catch {
          // Other filesystem results are not record bytes.
        }
      }

      if (operation === "read" && bytes !== null && Buffer.byteLength(bytes) <= 128 * 1024) {
        try {
          const parsed: unknown = JSON.parse(bytes.toString());
          const fields: { format?: unknown } = Object(parsed);

          if (
            parsed === Object(parsed) &&
            !isCallable(parsed) &&
            (fields.format === 1 || fields.format === 2)
          )
            sample.format = fields.format;
        } catch {
          /* Invalid records stay unknown; never retain parse errors or values. */
        }
      }

      return value;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      sample.code =
        ["ENOENT", "EPERM", "EACCES", "EBUSY", "EIO", "ENOSPC"].find((known) => known === code) ??
        "other";
      throw error;
    } finally {
      sample.endedMs = performance.now() - started;
    }
  };

  const wrap = <
    T extends (
      ...args: never[]
    ) => ReturnType<typeof fs.readFile | typeof fs.readdir | typeof fs.rename>,
  >(
    method: T,
    operation: "read" | "directory" | "replace",
    argument: number,
  ): T =>
    new Proxy(method, {
      apply(target, receiver, args: unknown[]) {
        const run = () => target.apply(receiver, args as Parameters<T>);

        const value = args[argument];

        try {
          const file = String.prototype.valueOf.call(value);

          if (file === value && matches(file, operation === "directory"))
            return observe(operation, run);
        } catch {
          // Buffer/URL paths and other arguments remain native calls, outside this probe.
        }

        return run();
      },
    });

  fs.readFile = wrap(fs.readFile, "read", 0);
  fs.readdir = wrap(fs.readdir, "directory", 0);
  fs.rename = wrap(fs.rename, "replace", 1);
  process.getBuiltinModule("module").syncBuiltinESMExports();
  const probe = { operations, preferenceReads, preferenceUpdates, pid: process.pid };
  Object.assign(globalThis, { __analyticsStartupIO: probe });

  return probe;
}
