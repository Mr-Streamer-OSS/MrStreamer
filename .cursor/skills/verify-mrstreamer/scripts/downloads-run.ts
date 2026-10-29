// The owned run the downloads scenarios of `pnpm verify:desktop` share: one profile, the fake
// provider, TMDB and a picture server, starts of the built app checked to be this run's, window
// driving, the failure screenshot, cleanup in order and `proof.json`. Each scenario keeps its own
// steps, observations and limits.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, type Page } from "../../../../apps/desktop/test/e2e/app.ts";
import {
  startFakeProvider,
  type FakeProvider,
} from "../../../../apps/desktop/test/fake-provider.ts";
import { startFakeTmdb, type FakeTmdb } from "../../../../apps/desktop/test/fake-tmdb.ts";
import { SOURCE_LOCALE, type Locale } from "../../../../packages/contracts/src/language.ts";
import { evidenceDirectory, freePort, record, stop } from "./session.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const desktop = join(root, "apps/desktop");
const hook = fileURLToPath(new URL("./network-hook.cjs", import.meta.url));

/** One connection a main process made, as network-hook.cjs wrote it. */
export interface Connection {
  readonly at: number;
  readonly kind: "tcp" | "udp" | "ipc" | "artwork";
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
}

/** Which build a start runs: this checkout's, or an earlier one's packaged executable. */
export type Build =
  { readonly kind: "candidate" } | { readonly kind: "previous"; readonly executable: string };

/** What a start was, as checked; each scenario writes it into `observed.starts` its own way. */
export interface Started {
  readonly label: string;
  readonly which: Build;
  readonly executable: string;
  readonly pid: number | undefined;
  readonly port: number;
  readonly profile: string;
  readonly url: string;
}

export function now(): string {
  return new Date().toISOString();
}

/** The window driving every downloads scenario uses, with real pointer and key input. */
function baseDriver(
  page: Page,
  style: Style,
  abort: AbortController,
  evidence: string,
  action: (label: string) => void,
) {
  const wait = async (check: () => Promise<boolean>, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      abort.signal.throwIfAborted();
      if (await check().catch(() => false)) return;
      await delay(150, undefined, { signal: abort.signal });
    }
    throw new Error(`Timed out waiting for ${check.toString()}`);
  };
  const exists = (expression: string) => page.evaluate<boolean>(`!!(${expression})`);
  const capture = async (name: string) => {
    if (style !== "single")
      await page.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    if (!record(shot.result) || typeof shot.result["data"] !== "string")
      throw new Error("No screenshot returned.");
    await writeFile(join(evidence, `${name}.png`), Buffer.from(shot.result["data"], "base64"));
    const tree = await page.send("Accessibility.getFullAXTree");
    await writeFile(join(evidence, `${name}.ax.json`), JSON.stringify(tree.result, null, 2));
  };
  const click = async (label: string, element: string) => {
    await wait(() => exists(element));
    if (style === "single") action(label);
    await page.evaluate(`${element}.scrollIntoView({ block: "nearest" })`);
    // Pressed only where the pointer reaches it: a closing dialog or search can still cover it.
    // "single" lets outer targets dismiss a dialog through its backdrop.
    await wait(() =>
      page.evaluate<boolean>(`(() => {
        const target = ${element};
        if (!target || target.matches(":disabled")) return false;
        ${style === "single" ? `if (!target.closest('[role="dialog"]')) return true;` : ""}
        const box = target.getBoundingClientRect();
        return box.width > 0 && box.height > 0 &&
          target.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })()`),
    );
    if (style !== "single") action(label);
    const point = await page.evaluate<{ x: number; y: number }>(`(() => {
      const box = ${element}.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await page.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
  };
  const key = async (name: string, code: number, modifiers = 0) => {
    action(`Press ${name}`);
    for (const type of ["rawKeyDown", "keyUp"])
      await page.send("Input.dispatchKeyEvent", {
        type,
        key: name,
        code: style === "series" && name.length === 1 ? `Key${name.toUpperCase()}` : name,
        windowsVirtualKeyCode: code,
        ...(style === "series" ? { modifiers } : {}),
      });
  };
  /** Enter or Space as a keyboard sends it, with its character, which presses a focused button. */
  const press = async (name: "Enter" | " ") => {
    action(`Press ${name === " " ? "Space" : name}`);
    const which =
      name === " "
        ? { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " }
        : { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...which });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...which });
  };
  /** Tab, as the viewer presses it, until `element` has the keyboard. */
  const tabTo = async (label: string, element: string) => {
    for (let tabs = 0; tabs < 150; tabs++) {
      if (await exists(`(${element}) === document.activeElement`)) {
        action(`${label} (${tabs} Tab presses)`);
        return;
      }
      await page.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
    }
    throw new Error(`Tab never reached ${element}`);
  };
  const text = (selector = "body") =>
    page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
  return { page, wait, exists, capture, click, key, press, tabTo, text };
}
export type BaseDriver = ReturnType<typeof baseDriver>;

/**
 * Keeps each scenario's start and input exactly as before: "single" is the downloads scenario's;
 * "builds" can start an earlier build too, and "series" does that with letter keys and modifiers.
 */
type Style = "single" | "builds" | "series";

/** What a scenario's steps are handed: the run's fixtures, profile, records and starts. */
export interface Run<D> {
  readonly profile: string;
  readonly abort: AbortController;
  readonly actions: { action: string; at: string }[];
  readonly observed: Record<string, unknown>;
  readonly networkLog: string;
  readonly windowRequests: { at: number; url: string }[];
  readonly provider: FakeProvider;
  readonly tmdb: FakeTmdb;
  readonly pictures: Server;
  action(label: string): void;
  /** Starts `which` on the run's profile and checks the window is that build's, on that profile. */
  start(label: string, which?: Build): Promise<D>;
  quit(label: string): Promise<void>;
}

/**
 * Runs `steps` as one owned verification run and writes its proof, failing it on any step or
 * cleanup error. Used by `runDownloads`, `runDownloadsQueue` and `runDownloadsSeries`.
 */
export async function ownedRun<D>(
  options: {
    readonly build: Record<string, unknown> & { executable: string };
    readonly style: Style;
    /** Records the window's requests over CDP into `windowRequests`. */
    readonly watchWindow: boolean;
    readonly prefix: string;
    readonly locale?: Locale;
    readonly observed: Record<string, unknown>;
    readonly pictures: () => Promise<Server>;
    readonly driver: (page: Page, base: BaseDriver) => D;
    readonly describe: (started: Started) => Record<string, unknown>;
    /** Runs first, inside the run, before any fixture starts. */
    readonly prepare?: (observed: Record<string, unknown>) => Promise<void>;
    /** Runs first in cleanup, before the app is stopped. */
    readonly release?: (
      clean: (operation: () => Promise<unknown>) => Promise<void>,
    ) => Promise<void>;
    readonly proof: Record<string, unknown>;
    readonly limits: readonly string[];
    readonly done: string;
  },
  steps: (run: Run<D>) => Promise<void>,
) {
  const { build, style, observed } = options;
  const system = (options.locale ?? SOURCE_LOCALE).replace("-", "_");
  const evidence = await evidenceDirectory(join(root, ".local/verification"), options.prefix);
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Verification interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const actions: { action: string; at: string }[] = [];
  const action = (label: string) => actions.push({ action: label, at: now() });
  const log: string[] = [];
  const networkLog = join(evidence, "main-network.jsonl");
  const windowRequests: { at: number; url: string }[] = [];
  let profile: string | undefined;
  let provider: FakeProvider | undefined;
  let tmdb: FakeTmdb | undefined;
  let pictures: Server | undefined;
  /** The started app, owned from spawn on; its page only once CDP answers. */
  let running: { app: ChildProcess; page?: Page } | undefined;
  let failed: unknown;
  const cleanupErrors: string[] = [];
  try {
    await options.prepare?.(observed);
    profile = await mkdtemp(join(tmpdir(), "mrstreamer-verify-"));
    provider = await startFakeProvider({ channels: 20, titles: 10, live: true });
    tmdb = await startFakeTmdb();
    pictures = await options.pictures();
    const picturesUrl = `http://127.0.0.1:${(pictures.address() as AddressInfo).port}`;
    const fixturePorts = [provider.url, tmdb.url, picturesUrl].map((url) =>
      Number(new URL(url).port),
    );
    observed["fixturePorts"] = fixturePorts;
    /** Each start's own process, debugging port, profile and renderer, as checked. */
    const starts: Record<string, unknown>[] = [];
    observed["starts"] = starts;
    const owned = { profile, tmdb };

    const start = async (label: string, which: Build = { kind: "candidate" }) => {
      const port = await freePort();
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !name.startsWith("MR_STREAMER_") &&
            name !== "ELECTRON_RUN_AS_NODE" &&
            name !== "NODE_OPTIONS" &&
            !/^(LANGUAGE|LANG|LC_ALL|LC_MESSAGES)$/.test(name),
        ),
      );
      const executable = which.kind === "candidate" ? build.executable : which.executable;
      const app = spawn(
        executable,
        [
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${owned.profile}`,
          "--enable-automation",
          "--use-mock-keychain",
          // The window reaches loopback only: no artwork host, whichever build draws it.
          ...(style !== "single"
            ? ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]
            : []),
          ...(process.platform === "linux" ? ["--no-sandbox"] : []),
          ...(which.kind === "candidate" ? [desktop] : []),
        ],
        {
          cwd: root,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...env,
            ...(which.kind === "candidate" && process.env["MR_STREAMER_FFMPEG"]
              ? { MR_STREAMER_FFMPEG: process.env["MR_STREAMER_FFMPEG"] }
              : {}),
            // The system's language, as Linux reads it: System default shows the app in `locale`.
            LANGUAGE: system,
            LANG: `${system}.UTF-8`,
            MR_STREAMER_UPDATE_CHECKS: "off",
            MR_STREAMER_TMDB_API: owned.tmdb.url,
            MR_STREAMER_TMDB_KEY: "test-key",
            // A packaged build takes no --require: its main's requests are only the fixtures'.
            ...(which.kind === "candidate"
              ? {
                  NODE_OPTIONS: `--require ${JSON.stringify(hook).slice(1, -1)}`,
                  VERIFY_NETWORK_LOG: networkLog,
                  VERIFY_IMAGES: picturesUrl,
                }
              : {}),
          },
        },
      );
      running = { app };
      for (const stream of [app.stdout, app.stderr])
        stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
      // A spawn error or an interrupt ends the wait for the window as the run's failure.
      const page = await Promise.race([
        style !== "single" ? connect(port, "page", { app }) : connect(port),
        new Promise<never>((_, reject) => {
          app.on("error", reject);
          abort.signal.addEventListener("abort", () => reject(abort.signal.reason), {
            once: true,
          });
        }),
      ]);
      running = { app, page };
      const command = await page.send("Browser.getBrowserCommandLine");
      const args = record(command.result) ? command.result["arguments"] : null;
      if (
        !Array.isArray(args) ||
        !args.includes(`--user-data-dir=${owned.profile}`) ||
        (style !== "single" && !args.includes(`--remote-debugging-port=${port}`)) ||
        (which.kind === "candidate" && !args.includes(desktop))
      )
        throw new Error("CDP belongs to a different app instance.");
      const renderer =
        which.kind === "candidate"
          ? pathToFileURL(join(desktop, "out/renderer/")).href
          : pathToFileURL(join(dirname(which.executable), "resources/app.asar/")).href;
      const deadline = Date.now() + 30_000;
      let url = "";
      while (Date.now() < deadline && !url.startsWith(renderer)) {
        url = await page.evaluate<string>("location.href").catch(() => "");
        if (!url.startsWith(renderer)) await delay(150, undefined, { signal: abort.signal });
      }
      if (!url.startsWith(renderer)) throw new Error(`Wrong renderer: ${url}`);
      starts.push(
        options.describe({
          label,
          which,
          executable,
          pid: app.pid,
          port,
          profile: owned.profile,
          url,
        }),
      );
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      if (options.watchWindow) {
        await page.send("Network.enable");
        page.on("Network.requestWillBeSent", (params) => {
          if (record(params) && record(params["request"]))
            windowRequests.push({ at: Date.now(), url: String(params["request"]["url"]) });
        });
      }
      action(
        style === "single"
          ? `Start the app (${label}) on the run's profile`
          : `Start ${which.kind === "candidate" ? "this build" : "the earlier build"} (${label}) on the run's profile`,
      );
      return options.driver(page, baseDriver(page, style, abort, evidence, action));
    };
    const quit = async (label: string) => {
      if (!running) return;
      action(`Quit the app (${label})`);
      await stop(running.app, running.page);
      running.page?.close();
      running = undefined;
    };

    await steps({
      ...{ profile, abort, actions, observed, networkLog, windowRequests },
      ...{ provider, tmdb, pictures, action, start, quit },
    });
  } catch (error) {
    failed = error;
    if (running?.page) {
      const shot = await running.page
        .send("Page.captureScreenshot", { format: "png" })
        .catch(() => undefined);
      if (record(shot?.result) && typeof shot.result["data"] === "string")
        await writeFile(join(evidence, "failure.png"), Buffer.from(shot.result["data"], "base64"));
    }
  } finally {
    const clean = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    };
    await clean(async () => options.release?.(clean));
    if (running) {
      const owned = running;
      await clean(() => stop(owned.app, owned.page));
      owned.page?.close();
    }
    if (provider) {
      if (style !== "single") observed["streamsAfterExit"] = provider.activeStreams();
      await clean(() => provider!.close());
    }
    if (tmdb) await clean(() => tmdb!.close());
    if (pictures?.listening)
      await clean(() => new Promise<void>((resolve) => pictures!.close(() => resolve())));
    observed["mainNetwork"] = summarise(readLines(networkLog), observed["fixturePorts"]);
    if (profile && (!running || running.app.exitCode !== null || running.app.signalCode !== null))
      await clean(() => rm(profile!, { recursive: true, force: true, maxRetries: 5 }));
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (cleanupErrors.length) failed ??= new Error(cleanupErrors.join("\n"));
    await writeFile(join(evidence, "electron.log"), log.join(""));
    await writeFile(
      join(evidence, "proof.json"),
      JSON.stringify(
        {
          ...options.proof,
          status: failed ? "failed" : "passed",
          actions,
          observed,
          error: failed ? String(failed) : null,
          cleanup: {
            fixturesClosed: cleanupErrors.length === 0,
            appExited: !running || running.app.exitCode !== null || running.app.signalCode !== null,
            profileRemoved: profile
              ? await access(profile).then(
                  () => false,
                  () => true,
                )
              : true,
            errors: cleanupErrors,
          },
          limits: [
            "Fake provider/TMDB and a loopback picture server; no real subscription acceptance",
            "Development build on this platform; no installer or native-platform proof",
            ...options.limits,
          ],
        },
        null,
        2,
      ),
    );
    console.log(`${failed ? "FAIL" : "PASS"} ${options.done}: ${evidence}`);
  }
  if (failed) throw failed;
}

/** Every connection network-hook.cjs wrote down, or none before it wrote any. */
export function readLines(path: string): Connection[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Connection);
  } catch {
    return [];
  }
}

/** Main's connections by where they went, with the fixtures named. */
function summarise(lines: readonly Connection[], fixtures: unknown) {
  const ports = new Set(Array.isArray(fixtures) ? fixtures : []);
  const by = new Map<string, number>();
  for (const line of lines) {
    if (line.kind === "ipc") continue;
    const where =
      line.kind === "artwork"
        ? `artwork ${line.host}`
        : `${line.kind} ${line.host}:${line.port}${ports.has(line.port) ? " (fixture)" : ""}`;
    by.set(where, (by.get(where) ?? 0) + 1);
  }
  return Object.fromEntries(by);
}
