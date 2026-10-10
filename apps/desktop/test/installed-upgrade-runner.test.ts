// What the Windows installed upgrade check does on its runner: which processes it stops, what a
// failed run leaves behind, and how it tells the bundled tools reached the network. Windows'
// process list and taskkill are stand-ins on PATH that only record; nothing real is stopped.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanUp } from "./e2e/installed-upgrade.ts";
import {
  ownedTree,
  toolProbe,
  type Runner,
  type WinProcess,
} from "./e2e/installed-upgrade-windows.ts";

const INSTALL = "C:\\Users\\runner\\AppData\\Local\\Programs\\mrstreamer";
const RUNNER: Runner = {
  id: "test",
  temp: "C:\\a\\_temp",
  installRoot: INSTALL,
  executable: `${INSTALL}\\Mr. Streamer.exe`,
  tools: [],
};
const at = (second: number) => `2026-10-10T06:00:${String(second).padStart(2, "0")}.0000000Z`;

describe.skipIf(process.platform === "win32")(
  "the processes an installed upgrade check stops",
  () => {
    let folder = "";
    let path = "";
    let app: ChildProcess;
    const shown = (list: WinProcess[]) =>
      writeFile(join(folder, "processes.json"), JSON.stringify(list));
    const kills = () =>
      readFileSync(join(folder, "kills.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    const ours = (pid: number, parent: number, second: number): WinProcess => ({
      pid,
      parent,
      name: "Mr. Streamer.exe",
      path: RUNNER.executable,
      created: at(second),
    });
    const foreign = (pid: number, parent: number, second: number): WinProcess => ({
      pid,
      parent,
      name: "other.exe",
      path: "C:\\other\\other.exe",
      created: at(second),
    });
    const exit = (child: ChildProcess) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : once(child, "exit");

    beforeEach(async () => {
      folder = await mkdtemp(join(tmpdir(), "installed-upgrade-windows-"));
      const state = JSON.stringify(join(folder, "processes.json"));
      const log = JSON.stringify(join(folder, "kills.jsonl"));
      const command = async (name: string, body: string) => {
        await writeFile(join(folder, `${name}.cjs`), `const fs = require("node:fs");\n${body}`);
        await writeFile(
          join(folder, name),
          `#!/bin/sh\nexec "${process.execPath}" "${join(folder, `${name}.cjs`)}" "$@"\n`,
          { mode: 0o755 },
        );
      };
      await command("powershell.exe", `process.stdout.write(fs.readFileSync(${state}, "utf8"));`);
      await command(
        "taskkill",
        `const args = process.argv.slice(2);
      fs.appendFileSync(${log}, JSON.stringify(args) + "\\n");
      const pid = Number(args[args.indexOf("/PID") + 1]);
      const list = JSON.parse(fs.readFileSync(${state}, "utf8"));
      fs.writeFileSync(${state}, JSON.stringify(list.filter((each) => each.pid !== pid)));`,
      );
      await writeFile(join(folder, "kills.jsonl"), "");
      path = process.env["PATH"] ?? "";
      process.env["PATH"] = `${folder}${delimiter}${path}`;
      app = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    });

    afterEach(async () => {
      process.env["PATH"] = path;
      app.kill("SIGKILL");
      await exit(app);
    });

    it("leaves alone a child of another program that got the app's id", async () => {
      await shown([ours(app.pid!, 1, 0)]);
      const tree = ownedTree(RUNNER, app);
      app.kill();
      await exit(app);
      await shown([foreign(app.pid!, 1, 10), foreign(77, app.pid!, 11)]);

      const report = await tree.stop(() => Promise.resolve());

      expect(kills()).toEqual([]);
      expect(report.owned.map((each) => each.pid)).toEqual([app.pid]);
    });

    // A child gets ten seconds to end by itself after the app before it is stopped.
    it("stops a child the app left behind, by its id alone", { timeout: 30_000 }, async () => {
      await shown([ours(app.pid!, 1, 0)]);
      const tree = ownedTree(RUNNER, app);
      await shown([ours(app.pid!, 1, 0), ours(77, app.pid!, 1)]);
      tree.sample();

      const report = await tree.stop(async () => {
        app.kill();
        await exit(app);
        // The app is gone; its id now belongs to another program, which starts one of its own.
        await shown([ours(77, app.pid!, 1), foreign(app.pid!, 1, 10), foreign(78, app.pid!, 11)]);
      });

      expect(kills()).toEqual([["/PID", "77", "/F"]]);
      expect(report.graceful).toBe(false);
    });

    it("refuses an app it can't show to be the installed one, and kills it through its handle", async () => {
      await shown([{ ...ours(app.pid!, 1, 0), path: "C:\\other\\Mr. Streamer.exe" }]);

      expect(() => ownedTree(RUNNER, app)).toThrow(/can't be shown to be the installed app/);
      await exit(app);
      expect(app.signalCode).toBe("SIGKILL");
      expect(kills()).toEqual([]);
    });
  },
);

describe("what an installed upgrade run leaves behind", () => {
  async function leftovers() {
    const root = await mkdtemp(join(tmpdir(), "installed-upgrade-cleanup-"));
    const profile = join(root, "profile");
    await mkdir(join(profile, "Default"), { recursive: true });
    await writeFile(join(profile, "Default", "Preferences"), "{}");
    const lock = join(root, "profile.lock");
    await writeFile(lock, "{}");
    return { root, profile, lock, installRoot: join(root, "install") };
  }

  it("keeps the profile and its lock when uninstalling fails", async () => {
    const paths = await leftovers();
    const restored: string[] = [];

    const left = await cleanUp(undefined, {
      ...paths,
      network: () => restored.push("network"),
      services: () => restored.push("services"),
      uninstall: () => Promise.reject(new Error("Uninstalling left the app installed.")),
    });

    expect(left.failed).toEqual(new Error("Uninstalling left the app installed."));
    expect(existsSync(join(paths.profile, "Default", "Preferences"))).toBe(true);
    expect(existsSync(paths.lock)).toBe(true);
    expect(left.kept).toEqual(["profile", "profile.lock"]);
    expect(restored).toEqual(["network", "services"]);
  });

  it("names only what is still there when a later step fails", async () => {
    const paths = await leftovers();
    // A lock that can't be removed as a file.
    await mkdir(join(paths.root, "locked", "profile.lock"), { recursive: true });
    await writeFile(join(paths.root, "locked", "profile.lock", "held"), "");
    const lock = join(paths.root, "locked", "profile.lock");

    const left = await cleanUp(undefined, {
      ...paths,
      lock,
      network: null,
      services: () => undefined,
      uninstall: () => undefined,
    });

    expect(left.failed).toBeTruthy();
    expect(existsSync(paths.profile)).toBe(false);
    expect(left.kept).toEqual(["profile.lock"]);
  });

  it("changes nothing more after the run failed, but gives back the network", async () => {
    const paths = await leftovers();
    await mkdir(paths.installRoot);
    const failure = new Error("Upgrading to B changed the copy 1.");
    const done: string[] = [];

    const left = await cleanUp(failure, {
      ...paths,
      network: () => done.push("network"),
      services: () => done.push("services"),
      uninstall: () => done.push("uninstall"),
    });

    expect(left.failed).toBe(failure);
    expect(done).toEqual(["network", "services"]);
    expect(left.kept).toEqual(["installation", "profile", "profile.lock"]);
  });
});

// CI points this at the bundled build; locally the ffmpeg on PATH will do.
const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
const hasTools = [FFMPEG, FFPROBE].every((tool) => spawnSync(tool, ["-version"]).status === 0);

describe.skipIf(!hasTools)("a bundled tool's network probe", () => {
  it.each([FFMPEG, FFPROBE])("tells %s connected from refused", async (tool) => {
    const server = createServer((_request, response) => response.end("not a video"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    const reached = await toolProbe(tool, url);
    await new Promise((resolve) => server.close(resolve));
    const refused = await toolProbe(tool, url);

    expect(reached).toMatchObject({ attempted: true, connected: true });
    expect(refused).toMatchObject({ attempted: true, connected: false });
  });
});
