import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {
    // Sandboxed preload scripts must be CommonJS.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
