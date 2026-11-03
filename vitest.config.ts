import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { DurationSequencer } from "./test/sequencer.ts";
import { exclude, include } from "./test/suites.ts";

// Node keeps the code it compiles, with TypeScript's types stripped, on disk and loads it from
// there next time. The catalogue worker every app start runs, and the scripts tests run as
// commands, skip most of their start that way. The test processes inherit the setting.
process.env["NODE_COMPILE_CACHE"] ??= join(
  import.meta.dirname,
  "node_modules/.cache/node-compile-cache",
);

// The iOS and Android apps keep their own installs, which CI doesn't make (pnpm-workspace.yaml
// leaves them out). Their tests run the app's own TypeScript with the native modules mocked, so
// the shared packages, React, ArkType, Effect and fflate they import resolve from the desktop
// app's install instead: one copy of each, as each app's Metro resolves the shared packages'
// imports from the app (apps/ios/metro.config.cjs). ArkType, Effect and fflate stay aligned
// between installs; React Native pins each app's React separately.
// Vite names modules by path with forward slashes, on Windows too (its normalizePath).
const mobile = ["apps/ios", "apps/android"].map(
  (app) => `${join(import.meta.dirname, app).replaceAll("\\", "/")}/`,
);
const desktop = join(import.meta.dirname, "apps/desktop/package.json").replaceAll("\\", "/");
const fromDesktop =
  /^(?:@mrstreamer\/(?:contracts|core)\/|(?:react(?:-dom)?|arktype|effect|fflate)(?:\/|$))/;

export default defineConfig({
  plugins: [
    {
      name: "mobile-tests-from-desktop-install",
      enforce: "pre",
      resolveId(source, importer, options) {
        if (!mobile.some((app) => importer?.startsWith(app)) || !fromDesktop.test(source))
          return null;
        return this.resolve(source, desktop, { ...options, skipSelf: true });
      },
    },
  ],
  test: {
    include,
    exclude,
    environment: "node",
    globalSetup: ["apps/desktop/test/catalogue-worker-bundle.ts"],
    // CI's shards split by recorded file durations, and every run starts its longest files first.
    sequence: { sequencer: DurationSequencer },
  },
});
