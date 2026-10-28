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
const context =
  "{ generation: current?.epoch.id ?? null, phase: state.get().phase.kind, pip: state.get().pip, external: state.get().external, watch: state.get().watch, aside: state.get().aside }";
const intent = (action: string) => `{ kind: "intent", action: ${action}, context: ${context} }`;
/** Each instrumented source file and its anchored edits. */
const overlays: Record<string, (text: string) => string> = {
  "playback.ts": (text) => {
    for (const [anchor, record] of [
      [
        "function observe(event: PlaybackObservation) {",
        `{ kind: "native", event, context: ${context} }`,
      ],
      [
        "export function togglePause() {",
        intent(
          '(state.get().phase.kind === "playing" || state.get().phase.kind === "loading") ? "pause" : state.get().phase.kind === "paused" ? "play" : "toggle-idle"',
        ),
      ],
      ["export function closeWatch(): Promise<Saved> {", intent('"close"')],
      ["export function setAside() {", intent('"set-aside"')],
      ["export function openWatch() {", intent('"open-watch"')],
    ] as const) {
      text = replace(text, anchor, `${anchor}\n  recordMeasurement(${record});`);
    }
    return text;
  },
  "loading.tsx": (text) =>
    replace(
      replace(
        text,
        'foreground.set(AppState.currentState === "active");',
        'recordMeasurement({ kind: "foreground", active: AppState.currentState === "active" });\n    foreground.set(AppState.currentState === "active");',
      ),
      'AppState.addEventListener("change", (state) => foreground.set(state === "active"));',
      'AppState.addEventListener("change", (state) => {\n      recordMeasurement({ kind: "foreground", active: state === "active" });\n      foreground.set(state === "active");\n    });',
    ),
};
for (const [name, overlay] of Object.entries(overlays)) {
  const path = `apps/ios/src/${name}`;
  const text = execFileSync("git", ["show", `${source}:${path}`], { cwd: root, encoding: "utf8" });
  await emit(
    name,
    overlay('import { recordMeasurement } from "./measurement-runtime.ts";\n' + text),
    `generated full-source overlay of ${source}:${path}; not pristine released source`,
  );
}
const generatorCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const generatorDirty =
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
  }).trim().length > 0;
const generatorBytes = await readFile(fileURLToPath(import.meta.url));
let overlayIdentity = "";
for (const name of ["measurement-records.ts", "measurement-runtime.ts"]) {
  let content = await readFile(new URL(name, import.meta.url), "utf8");
  if (name === "measurement-runtime.ts") {
    overlayIdentity = createHash("sha256")
      .update(JSON.stringify({ source, hashes }))
      .update(generatorBytes)
      .update(content)
      .digest("hex");
    content = replace(
      content,
      '{ source: "UNGENERATED", overlay: "UNGENERATED" }',
      JSON.stringify({ source, overlay: overlayIdentity }),
    );
  }
  await emit(name, content, "dedicated authored support; exact copy");
}
await writeFile(
  resolve(destination, "identity.json"),
  JSON.stringify(
    {
      source,
      fixtureOnly: true,
      generator: {
        commit: generatorCommit,
        dirty: generatorDirty,
        sha256: createHash("sha256").update(generatorBytes).digest("hex"),
      },
      overlay: overlayIdentity,
      apply:
        "Copy the four generated TS/TSX files into apps/ios/src in a disposable exact-source build checkout. Never apply to a daily-driver checkout. Hash the new bundle/Hermes separately.",
      export:
        "Retrieve Documents/fixture-playback-observations.json from the task-owned app container. No telemetry or user-facing export.",
      limits:
        "No native callback timestamp, physical first paint/audio or owned-buffer bytes. End is null until the event, byte, or elapsed boundary; killed/idle sessions remain incomplete. Window begins at module initialization including launch/navigation. Existing foreground callback starts lazily. No OS focus or continuous media sampling. Stop/play-item/retry/PiP control requests are not separately instrumented; pause/play toggle intents are captured. Context includes PiP/external.",
      files: hashes,
    },
    null,
    2,
  ),
);
