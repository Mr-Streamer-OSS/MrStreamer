// Explicit test-only overlay generator; never imported by the app or its production build.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const [source, output] = process.argv.slice(2);
if (!source || !/^[a-f0-9]{40}$/.test(source) || !output) {
  throw new Error(
    "Usage: node apps/ios/scripts/measurement-overlay.ts <exact-source-sha> <new-output-directory>",
  );
}
const destination = resolve(output);
await mkdir(destination); // Refuse reuse: identity and bytes must never be silently mixed.
const hashes: Record<string, { sha256: string; bytes: number; provenance: string }> = {};
async function emit(path: string, text: string, provenance: string) {
  await writeFile(resolve(destination, path), text);
  hashes[path] = {
    sha256: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
    provenance,
  };
}
function replace(text: string, anchor: string, replacement: string) {
  if (text.split(anchor).length !== 2) throw new Error(`Unsupported source seam: ${anchor}`);
  return text.replace(anchor, replacement);
}
for (const name of ["playback.ts", "loading.tsx"]) {
  const path = `apps/ios/src/${name}`;
  let text = execFileSync("git", ["show", `${source}:${path}`], { cwd: root, encoding: "utf8" });
  text = 'import { recordMeasurement } from "./measurement-runtime.ts";\n' + text;
  if (name === "playback.ts") {
    const context =
      "{ generation: current?.epoch.id ?? null, phase: state.get().phase.kind, watch: state.get().watch, aside: state.get().aside }";
    text = replace(
      text,
      "function observe(event: PlaybackObservation) {",
      `function observe(event: PlaybackObservation) {\n  recordMeasurement({ kind: "native", event, context: ${context} });`,
    );
    for (const [anchor, action] of [
      [
        "export function togglePause() {",
        '(state.get().phase.kind === "playing" || state.get().phase.kind === "loading") ? "pause" : state.get().phase.kind === "paused" ? "play" : "toggle-idle"',
      ],
      ["export function closeWatch(): Promise<Saved> {", '"close"'],
      ["export function setAside() {", '"set-aside"'],
      ["export function openWatch() {", '"open-watch"'],
    ]) {
      if (!anchor || !action) throw new Error("Invalid seam");
      text = replace(
        text,
        anchor,
        `${anchor}\n  recordMeasurement({ kind: "intent", action: ${action}, context: ${context} });`,
      );
    }
    // Do not retain route strings, which can contain private names/keys.
    text = replace(
      text,
      "export function onScreen(path: string) {",
      'export function onScreen(path: string) {\n  recordMeasurement({ kind: "screen", watch: path === "/watch" });',
    );
  } else {
    text = replace(
      text,
      'foreground.set(AppState.currentState === "active");',
      'recordMeasurement({ kind: "foreground", active: AppState.currentState === "active" });\n    foreground.set(AppState.currentState === "active");',
    );
    text = replace(
      text,
      'AppState.addEventListener("change", (state) => foreground.set(state === "active"));',
      'AppState.addEventListener("change", (state) => {\n      recordMeasurement({ kind: "foreground", active: state === "active" });\n      foreground.set(state === "active");\n    });',
    );
  }
  await emit(
    name,
    text,
    `generated full-source overlay of ${source}:${path}; not pristine released source`,
  );
}
for (const name of ["measurement-records.ts", "measurement-runtime.ts"]) {
  await emit(
    name,
    await readFile(new URL(name, import.meta.url), "utf8"),
    "dedicated authored support; exact copy",
  );
}
await writeFile(
  resolve(destination, "identity.json"),
  JSON.stringify(
    {
      source,
      fixtureOnly: true,
      apply:
        "Copy the four generated TS/TSX files into apps/ios/src in a disposable exact-source build checkout. Never apply to a daily-driver checkout. Hash the new bundle/Hermes separately.",
      export:
        "Retrieve Documents/fixture-playback-observations.json from the task-owned app container. No telemetry or user-facing export.",
      limits:
        "No native callback timestamp, physical first paint/audio or owned-buffer bytes. End is null until the event/elapsed boundary; killed/idle sessions remain incomplete. Existing foreground callback starts lazily. Screen is onScreen navigation, not OS focus.",
      files: hashes,
    },
    null,
    2,
  ),
);
