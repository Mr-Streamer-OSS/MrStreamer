// Checks a built Windows setup against the plug-ins the notices describe: "installer" in
// licences.config.json lists the files NSIS puts in the setup and in the uninstaller it leaves in
// the app's folder, with their SHA-256.
//
//   node scripts/installer-plugins.ts dist/Mr-Streamer-0.2.0-win-x64-setup.exe
//
// An electron-builder option or an NSIS script can add a plug-in without any version changing, and
// then the setup would carry a file About has no notice for. The release workflow runs this on
// every Windows build, dry runs included. Needs 7-Zip's `7z`, which reads NSIS installers.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { readConfig } from "./licences.ts";
import { sha256 } from "./release-sources.ts";

const run = promisify(execFile);

/**
 * How the plug-ins `found` in the setup or the uninstaller, `where`, differ from the `expected`
 * ones, both as file names with their SHA-256.
 */
export function pluginProblems(
  where: string,
  found: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const [name, hash] of Object.entries(found)) {
    if (!Object.hasOwn(expected, name)) {
      problems.push(`The ${where} carries ${name}, which has no notice.`);
    } else if (expected[name] !== hash) {
      problems.push(`${name} in the ${where} has SHA-256 ${hash}, not the reviewed one.`);
    }
  }
  for (const name of Object.keys(expected)) {
    if (!Object.hasOwn(found, name)) problems.push(`The ${where} no longer carries ${name}.`);
  }
  return problems;
}

/**
 * Unpacks an NSIS program, leaving the app's archive packed: its plug-ins by name with their
 * SHA-256, and the paths of the programs inside it.
 */
async function unpack(program: string, folder: string) {
  await run("7z", ["x", "-y", `-o${folder}`, program, "-xr!*.7z"]);
  const plugins: Record<string, string> = {};
  const programs: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = entry.name.toLowerCase();
    if (name.endsWith(".dll")) plugins[entry.name] = await sha256(path);
    else if (name.endsWith(".exe")) programs.push(path);
  }
  return { plugins, programs };
}

if (import.meta.main) {
  const setup = process.argv[2];
  if (!setup?.endsWith(".exe")) {
    throw new Error("Usage: node scripts/installer-plugins.ts <setup>.exe");
  }
  const { installer } = await readConfig(join(import.meta.dirname, ".."));
  const folder = await mkdtemp(join(tmpdir(), "mrstreamer-setup-"));
  try {
    // The one program the setup holds is the uninstaller.
    const outer = await unpack(setup, join(folder, "setup"));
    const [uninstaller, ...unknown] = outer.programs;
    const problems = pluginProblems("setup", outer.plugins, installer.setup);
    if (!uninstaller || unknown.length > 0) {
      problems.push(
        `The setup should hold one program, its uninstaller, not ${outer.programs.map((path) => basename(path)).join(", ") || "none"}.`,
      );
    } else {
      const inner = await unpack(uninstaller, join(folder, "uninstaller"));
      problems.push(...pluginProblems("uninstaller", inner.plugins, installer.uninstaller));
    }
    if (problems.length > 0) {
      throw new Error(
        `${basename(setup)} and "installer" in licences.config.json differ:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nSee docs/maintainers/licences.md#windows-setup-program.`,
      );
    }
    console.log(
      `${basename(setup)} carries the ${Object.keys(outer.plugins).length} reviewed plug-ins, and its uninstaller the ${Object.keys(installer.uninstaller).length} it should.`,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
