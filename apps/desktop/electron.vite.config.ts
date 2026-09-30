import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { thirdPartyNotices } from "./scripts/licences.ts";

// Notes the modules in each bundle; after the last, writes out/licences/third-party.json.
const notices = thirdPartyNotices(fileURLToPath(new URL(".", import.meta.url)), [
  "main",
  "preload",
  "renderer",
]);

export default defineConfig({
  main: {
    plugins: [notices("main")],
  },
  preload: {
    plugins: [notices("preload")],
    // Sandboxed preload scripts must be CommonJS.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    plugins: [react(), tailwindcss(), notices("renderer")],
  },
});
